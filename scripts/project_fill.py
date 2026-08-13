#!/usr/bin/env python3
"""Label a log set's `project` column by forward-filling from seeds + distance flags.

Premise (verified on logs.csv): you label the FIRST line of every project block.
Within-block consecutive distances (~0.52) overlap boundary distances (~0.61), so
embedding distance is a poor *segmenter* but a useful *checker*. So:

  1. Forward-fill: every blank `project` row inherits the nearest preceding seed's
     project. This is exact if you seeded every block-start.
  2. Flag (don't auto-cut) two suspicious cases using bge-m3 embeddings:
       - missed_seed : a big content jump (consecutive dist > --flag-dist) lands on
                       a row you did NOT seed -> maybe a forgotten block-start.
       - outlier     : a filled row sits far from its block's seed
                       (dist-to-seed > --seed-dist) -> maybe mislabeled / new block.

Input  : CSV with date, content, project (project filled only on seed rows; blank
         elsewhere). Other columns are preserved.
Output : same rows with project forward-filled + two extra columns: `seed` (1 if the
         row was a user seed) and `flag` (missed_seed / outlier / blank).

Usage:
  python project_fill.py INPUT.csv [OUTPUT.csv] [--flag-dist 0.60] [--seed-dist 0.60]
  (no OUTPUT.csv -> writes INPUT.with_projects.csv; never overwrites INPUT)
"""
import csv, json, math, argparse, os, urllib.request

OLLAMA = "http://localhost:11434/api/embeddings"
MODEL = "bge-m3"


def embed(text):
    req = urllib.request.Request(
        OLLAMA, data=json.dumps({"model": MODEL, "prompt": text}).encode(),
        headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=120).read())["embedding"]


def cos(a, b):
    return sum(x * y for x, y in zip(a, b)) / (
        math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output", nargs="?")
    ap.add_argument("--flag-dist", type=float, default=0.60,
                    help="consecutive-distance spike that flags a possible missed seed")
    ap.add_argument("--seed-dist", type=float, default=0.60,
                    help="distance from a row to its block seed that flags an outlier")
    args = ap.parse_args()
    out = args.output or (os.path.splitext(args.input)[0] + ".with_projects.csv")
    if os.path.abspath(out) == os.path.abspath(args.input):
        raise SystemExit("refusing to overwrite the input file")

    rows = list(csv.DictReader(open(args.input, newline="", encoding="utf-8-sig")))
    if not rows:
        raise SystemExit("empty input")
    base = list(rows[0].keys())
    if "project" not in base:
        raise SystemExit("input needs a `project` column (seed it on block-starts)")
    vecs = [embed(r["content"]) for r in rows]
    n = len(rows)

    seed = [bool((r.get("project") or "").strip()) for r in rows]      # user-labeled?
    filled = [(r.get("project") or "").strip() for r in rows]
    seed_vec = [None] * n                                              # vec of the block's seed
    last_label, last_seed_idx = "", None
    for i in range(n):
        if seed[i]:
            last_label = filled[i]
            last_seed_idx = i
        else:
            filled[i] = last_label                                    # forward-fill
        seed_vec[i] = vecs[last_seed_idx] if last_seed_idx is not None else None

    flag = [""] * n
    for i in range(n):
        if i > 0 and not seed[i]:
            if 1 - cos(vecs[i - 1], vecs[i]) > args.flag_dist:        # big jump onto a non-seed row
                flag[i] = "missed_seed"
        if not seed[i] and seed_vec[i] is not None and not flag[i]:
            if 1 - cos(vecs[i], seed_vec[i]) > args.seed_dist:        # far from its block's seed
                flag[i] = "outlier"
        if last_seed_idx is None or (seed_vec[i] is None):
            if not filled[i]:
                flag[i] = "before_first_seed"

    fieldnames = base + [c for c in ("seed", "flag") if c not in base]
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for i, r in enumerate(rows):
            row = dict(r)
            row["project"] = filled[i]
            row["seed"] = 1 if seed[i] else 0
            row["flag"] = flag[i]
            w.writerow(row)

    nseed = sum(seed)
    flags = [(i, flag[i]) for i in range(n) if flag[i]]
    print(f"{out}: {n} rows, {nseed} seeds -> filled {n - nseed} rows")
    print(f"flags: {sum(1 for _, fl in flags if fl=='missed_seed')} missed_seed, "
          f"{sum(1 for _, fl in flags if fl=='outlier')} outlier, "
          f"{sum(1 for _, fl in flags if fl=='before_first_seed')} before_first_seed")
    for i, fl in flags:
        print(f"  row {i:>3} [{fl:16}] (project={filled[i]!r})  {rows[i]['content'][:55]}")


if __name__ == "__main__":
    main()

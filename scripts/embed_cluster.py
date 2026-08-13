#!/usr/bin/env python3
"""Embed each entry with bge-m3 (Ollama) and cluster per day, writing g1/g2/... or
'individual' into the group_pred column.

Pipeline (the operating point we settled on):
  - embedder: bge-m3 via Ollama (multilingual; handles Thai)
  - text fed to embedder: "[project] content", EXCEPT project '' or 'other' -> content only
  - clustering: per day (days are independent), single-linkage connected components,
    link two same-day entries when cosine distance <= T (default 0.45)
  - groups (>=2 members) -> g1, g2, ... ; singletons -> 'individual'

Usage:
  python embed_cluster.py INPUT.csv [OUTPUT.csv] [--t 0.45] [--model bge-m3]
  (no OUTPUT.csv -> rewrite INPUT.csv in place)
"""
import csv, json, math, collections, argparse, urllib.request

OLLAMA = "http://localhost:11434/api/embeddings"


def embed(text, model):
    req = urllib.request.Request(
        OLLAMA,
        data=json.dumps({"model": model, "prompt": text}).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=120).read())["embedding"]


def cos(a, b):
    return sum(x * y for x, y in zip(a, b)) / (
        math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    )


def embed_text(row):
    """[project] content, except project '' or 'other' -> content only.
    Also drops any '‖FLAG: ...' tail a normalizer may have appended."""
    content = row["content"].split("‖FLAG")[0].strip()
    proj = (row.get("project") or "").strip()
    return content if proj in ("", "other") else f"[{proj}] {content}"


def cluster(rows, vecs, T):
    n = len(rows)
    by_date = collections.defaultdict(list)
    for i, r in enumerate(rows):
        by_date[r["date"]].append(i)
    label = [None] * n
    gid = 0
    for date in sorted(by_date):
        idxs = by_date[date]
        parent = {i: i for i in idxs}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for a in range(len(idxs)):
            for b in range(a + 1, len(idxs)):
                i, j = idxs[a], idxs[b]
                if 1 - cos(vecs[i], vecs[j]) <= T:
                    parent[find(i)] = find(j)
        comps = collections.defaultdict(list)
        for i in idxs:
            comps[find(i)].append(i)
        for root in sorted(comps, key=lambda r: min(comps[r])):
            members = comps[root]
            if len(members) >= 2:
                gid += 1
                for i in members:
                    label[i] = f"g{gid}"
            else:
                label[members[0]] = "individual"
    return label, gid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output", nargs="?")
    ap.add_argument("--t", type=float, default=0.45)
    ap.add_argument("--model", default="bge-m3")
    args = ap.parse_args()
    out = args.output or args.input

    rows = list(csv.DictReader(open(args.input, newline="", encoding="utf-8-sig")))
    fieldnames = list(rows[0].keys())
    if "group_pred" not in fieldnames:
        fieldnames.append("group_pred")

    vecs = [embed(embed_text(r), args.model) for r in rows]
    label, ngroups = cluster(rows, vecs, args.t)

    for i, r in enumerate(rows):
        r["group_pred"] = label[i]
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)

    nind = sum(1 for x in label if x == "individual")
    print(f"{out}: {len(rows)} rows -> {ngroups} groups, {nind} individual "
          f"(model={args.model}, T={args.t})")


if __name__ == "__main__":
    main()

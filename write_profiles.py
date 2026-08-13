#!/usr/bin/env python3
"""Route 'remember' entries that mention a person into per-person profile files.

Final pipeline step. Input is the merged, fully-labeled record (one row per entry)
carrying at least:  content, category, people  (+ optional date).
  - category  : from the category classifier (task/event/note/remember)
  - people    : from the project classifier's `people` field
                (JSON list like ["sofia"], or "sofia;cindy", or "sofia")

For every row where category == 'remember' AND people is non-empty, append the
entry to datasets/profiles/<name>.md (one file per person, deduped).

Usage: python write_profiles.py LABELED.csv [--profiles-dir datasets/profiles]

Shares its file format (incl. the `aliases:` header line) with `noter/profiles.py`,
which is what the live pipeline (`route.py`) calls per-row.
"""
import csv, json, os, re, argparse
from pathlib import Path

from noter.profiles import slug, append_fact


def parse_people(cell):
    cell = (cell or "").strip()
    if not cell:
        return []
    try:
        v = json.loads(cell)                       # JSON list form
        if isinstance(v, list):
            return [str(x).strip() for x in v if str(x).strip()]
    except (json.JSONDecodeError, ValueError):
        pass
    return [p.strip() for p in re.split(r"[;,|]", cell) if p.strip()]  # delimited form


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--profiles-dir", default=os.path.join("datasets", "profiles"))
    args = ap.parse_args()
    os.makedirs(args.profiles_dir, exist_ok=True)

    rows = list(csv.DictReader(open(args.input, newline="", encoding="utf-8-sig")))
    written = 0
    for r in rows:
        if (r.get("category") or "").strip().lower() != "remember":
            continue
        people = parse_people(r.get("people"))
        if not people:
            continue
        for name in people:
            path = Path(args.profiles_dir) / (slug(name) + ".md")
            if append_fact(path, name, (r.get("date") or "").strip(), r["content"]):
                written += 1
                print(f"  -> {path}: {r['content'][:60]}")
    print(f"\nwrote {written} fact(s) into {args.profiles_dir}/")


if __name__ == "__main__":
    main()

"""Commit the review rows the user approved, and close the feedback loop.

RETIRED (Notion review path): superseded by the local `review_cli.py`, which files each
approved row and records gold/corrections in one interactive pass. Kept for the legacy
Notion round-trip only (the `com.noter.commit` cron is now unused).

Reads Approved && !Committed rows from the Noter Review DB, routes each to its final
destination, marks it Committed, and records the outcome:
  - every committed row -> gold.csv (final labels),
  - rows whose labels you changed vs. the staged proposal -> corrections.csv.

Run:  python -m noter.commit  [--dry-run]
"""
from __future__ import annotations

import argparse
import csv

from . import config, feedback, route
from .notion import Notion, label_for_page


def _proposed_index() -> dict[tuple[str, str], dict]:
    """(date, normalized content) -> proposed row, from the combined datasets/all.csv
    (falls back to the legacy per-day CSVs if the combined file isn't there yet)."""
    idx: dict[tuple[str, str], dict] = {}
    if config.ALL_CSV.exists():
        paths = [config.ALL_CSV]
    else:
        paths = sorted(config.DATASETS.glob("[0-9]" * 4 + "-[0-9][0-9]-[0-9][0-9].csv"))
    for path in paths:
        with open(path, newline="", encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                key = (r.get("date") or path.stem, feedback._norm(r.get("content", "")))
                idx[key] = r
    return idx


def commit(dry_run: bool = False) -> None:
    notion = Notion()
    proposed = _proposed_index()
    rows = notion.approved_review_rows()
    if not rows:
        print("Nothing approved to commit.")
        return

    committed = corrected = 0
    for rev in rows:
        final = {
            "date": rev.get("date", ""),
            "datetime": "",
            "content": rev["content"],
            "project": label_for_page(rev.get("project_page_id")),
            "people": rev.get("people", []),
            "category": rev.get("category", "note"),
            "group": rev.get("group", ""),
            "due_date": rev.get("due_date", ""),
        }
        prop = proposed.get((final["date"], feedback._norm(final["content"])), {})
        if prop:
            final["datetime"] = prop.get("datetime", "")

        action = route.route_row(notion, final, dry_run=dry_run)
        print(f"  {action}")
        if dry_run:
            continue

        notion.mark_committed(rev["_page_id"])
        feedback.append_gold(final)
        committed += 1

        # diff proposed vs your edits -> correction
        changed = {
            f"proposed_{k}": prop.get(k, "") for k in ("project", "category", "group")
        }
        diffs = any(prop.get(k, "") != final.get(k, "") for k in ("project", "category", "group"))
        if prop and diffs:
            feedback.append_correction({
                "date": final["date"], "content": final["content"],
                "people": final["people"],
                "final_project": final["project"], "final_category": final["category"],
                "final_group": final["group"], **changed,
            })
            corrected += 1

    if not dry_run:
        print(f"\nCommitted {committed} row(s); recorded {corrected} correction(s).")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    commit(dry_run=ap.parse_args().dry_run)


if __name__ == "__main__":
    main()

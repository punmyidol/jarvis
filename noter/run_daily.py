"""Daily entrypoint: fetch -> classify -> overrides -> confidence split.

HIGH-confidence rows (and all tasks) auto-file to their destinations now. LOW rows stay
in `datasets/all.csv` as the pending-review queue; review them locally, edit, and file
with `python -m noter.review_cli` (which also records gold/corrections).

    python -m noter.run_daily --date today
    python -m noter.run_daily --date 2026-06-28 --dry-run
    python -m noter.run_daily --date 2026-06-28 --from-csv datasets/2026-06-28-nobge.csv --dry-run
"""
from __future__ import annotations

import argparse

from . import classify, config, feedback, route
from .fetch import fetch_day, resolve_date

INCONSISTENCIES = """# Noter — flagged inconsistencies

Auto-generated. Spec (CLAUDE.md) vs. what's on disk / in Notion.

1. **CSV schema drift** — CLAUDE.md §3 mandates 11 columns incl. `due_date` and no
   `session_id`. On disk `datasets/2026-06-28.csv` still has `session_id` / no
   `due_date`; `2026-06-28-nobge.csv` also lacks `due_date`. This pipeline emits the
   current 11-column schema.
2. **`normalize_prompt.txt` missing** — listed in CLAUDE.md's Components table but no
   such file exists.
3. **Wrong paths in CLAUDE.md** — `embed_cluster.py` / `project_classify.py` /
   `project_fill.py` live in `scripts/`, not `datasets/from-22-jun/`.
4. **Dangling references** — `datasets/preds-qwen.gen.py` and `sort.ipynb` read
   `datasets/preds-qwen.csv` and `datasets/since22jun.csv`; neither exists.
5. **`profiles.csv` (3 people) vs `profiles/` (8 files)** — 5 unregistered (expected
   for non-project people, but noted).
6. **Classifier projects with no Notion project** — `mom's herbal tea` and `garden`
   are in the closed classifier set (and exist as vault folders) but have no page in
   the Notion Projects DB, so their tasks/events get an **empty project relation**
   (never auto-created).
"""


def write_inconsistencies() -> None:
    config.INCONSISTENCIES_MD.parent.mkdir(parents=True, exist_ok=True)
    config.INCONSISTENCIES_MD.write_text(INCONSISTENCIES, encoding="utf-8")


def run(date: str, dry_run: bool = False, from_csv: str | None = None,
        classifier: str = "api") -> None:
    # 1. rows: either classify live, or load a pre-classified CSV (offline)
    if from_csv:
        rows = classify.load_rows_from_csv(from_csv, note_date=date)
        print(f"Loaded {len(rows)} pre-classified rows from {from_csv}")
    else:
        entries = fetch_day(date)
        if not entries:
            print(f"No note found for {date} (looked in {config.NOTER_DAILIES}).")
            return
        print(f"Classifying {len(entries)} entries for {date} (backend={classifier}) ...")
        rows = classify.classify_day(entries, date, backend=classifier)

    # 2. apply learned overrides, then snapshot the proposal for commit's diff
    feedback.Overrides.build().apply(rows)
    classify.upsert_csv(rows, date, config.ALL_CSV)
    print(f"Wrote {len(rows)} rows for {date} -> {config.ALL_CSV}")

    # 3. fold "task + its supporting notes" groups: when a (date, group) holds exactly
    #    one task and >=1 note, those notes are the task's context — they ride onto the
    #    task's Notion page (as page bullets) instead of routing on their own.
    supporting, folded = route.fold_task_groups(rows)

    # 4. routing split. `task` rows ALWAYS auto-file to their destination (the
    #    Tasks DB), regardless of confidence — a to-do should never get stuck in
    #    review. Other categories auto-file only when HIGH confidence; LOW rows are
    #    left in all.csv for local review (`python -m noter.review_cli`). Folded
    #    supporting notes are excluded from both lists (they ride the task's page).
    precedent = feedback._gold_precedent()
    conf = {id(r): feedback.score_confidence(r, precedent) for r in rows}
    high = [r for r in rows if (r.get("category") == "task" or conf[id(r)] == "high")
            and id(r) not in folded]
    low = [r for r in rows if r.get("category") != "task" and conf[id(r)] == "low"
           and id(r) not in folded]

    notion = None
    if not dry_run:
        from .notion import Notion
        notion = Notion()

    # 5. auto-file HIGH (+ every task, each carrying its folded supporting notes).
    #    Only genuinely HIGH-confidence rows feed gold.csv — a force-filed low-
    #    confidence task bypassed review, so it is not treated as a confirmed precedent.
    print(f"\nAuto-file ({len(high)}):")
    for r in high:
        print(f"  {route.route_row(notion, r, dry_run=dry_run, supporting=supporting.get(id(r)))}")
        if not dry_run and conf[id(r)] == "high":
            feedback.append_gold(r)

    # 6. LOW (non-task) rows stay in all.csv as the pending-review queue
    if low:
        print(f"\nLOW confidence — {len(low)} row(s) pending local review:")
        for r in low:
            print(f"  [{r.get('category')}/{r.get('project')}] {r.get('content','')[:60]}")
        print("  Run 'python -m noter.review_cli' to edit + file them.")

    # 7. best-effort: push open Shopping List items into Reminders.app (local
    #    only; the location-trigger itself is set up by hand in Shortcuts).
    if not dry_run and notion is not None:
        try:
            from . import sync_reminders
            result = sync_reminders.sync(notion)
            if result["added"] or result["completed"]:
                print(f"\nReminders sync: +{len(result['added'])} added, "
                      f"{len(result['completed'])} completed")
        except Exception as e:
            print(f"\nReminders sync skipped ({e})")

    # 8. flags + summary
    overridden = [r for r in rows if r.get("override")]
    unmapped = [r for r in rows
                if r.get("category") in ("task", "event")
                and not config.PROJECT_NOTION_PAGE.get(r.get("project"))]
    write_inconsistencies()
    print(f"\nSummary: {len(rows)} rows | {len(high)} auto-filed | {len(low)} to review "
          f"| {len(overridden)} overridden | {len(unmapped)} task/event with no project relation")
    if overridden:
        for r in overridden:
            print(f"  override: {r['content'][:50]} -> {r['override']}")
    if dry_run:
        print("\n(dry run — nothing written to Notion or the vault)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default="today")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--from-csv", default=None, help="skip classify; load a pre-labeled CSV")
    ap.add_argument("--classifier", default="api", choices=["api", "agent"],
                    help="'agent' reads a subagent's response file instead of the API")
    args = ap.parse_args()
    run(resolve_date(args.date), dry_run=args.dry_run, from_csv=args.from_csv,
        classifier=args.classifier)


if __name__ == "__main__":
    main()

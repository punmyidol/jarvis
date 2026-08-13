"""Interactive local review of low-confidence rows — the feedback loop as a script.

Supersedes the Notion "Noter Review" round-trip (`review.py` + `commit.py`). The pending
queue is a *computed view* of `datasets/all.csv`: every low-confidence, non-task row that
hasn't been reviewed yet (i.e. isn't already in `gold.csv`). Tasks always auto-file in
`run_daily`, so they're never pending here.

Walks the pending rows in batches, lets you edit any column inline to correct it, and on
approval (a) files the row to its real destination via `route.route_row` and (b) records it
to `gold.csv` — plus a `corrections.csv` row when you changed a label — so the next run's
few-shot examples and deterministic overrides learn from it.

    python -m noter.review_cli                 # review all pending, 10 at a time
    python -m noter.review_cli --date 2026-07-22
    python -m noter.review_cli --dry-run       # preview; writes nothing
"""
from __future__ import annotations

import argparse

from . import classify, config, feedback, route

# Columns you may edit during review. `people` is parsed from a comma/JSON list.
EDITABLE = ["content", "project", "people", "category",
            "group", "due_date", "due_time", "clean_content"]
CATEGORIES = {"task", "event", "note", "remember"}
# Fields whose change counts as a "correction" (mirrors corrections.csv / commit.py).
LABEL_FIELDS = ("project", "category", "group")


def _pending(rows: list[dict]) -> list[dict]:
    """The review queue: low-confidence, non-task rows not yet in gold.csv."""
    feedback.Overrides.build().apply(rows)  # parity with run_daily's scoring
    _, folded = route.fold_task_groups(rows)  # notes that ride a task's Notion page
    reviewed = {
        (r.get("date", ""), feedback._norm(r.get("content", "")))
        for r in feedback._read_csv(config.GOLD_CSV)
    }
    precedent = feedback._gold_precedent()
    out = []
    for r in rows:
        if r.get("category") == "task":
            continue
        if id(r) in folded:  # already filed with its task in run_daily; not reviewable here
            continue
        if (r.get("date", ""), feedback._norm(r.get("content", ""))) in reviewed:
            continue
        if feedback.score_confidence(r, precedent) == "low":
            out.append(r)
    return out


def _show(row: dict, position: str) -> None:
    print(f"\n\033[1m{position}\033[0m  {row.get('date','')}  "
          f"\"{row.get('content','')}\"")
    for col in EDITABLE:
        val = row.get(col, "")
        if col == "people":
            val = ", ".join(val or [])
        if val not in ("", None):
            print(f"    {col:<14}= {val}")


def _apply_edit(row: dict, col: str, value: str) -> None:
    if col == "people":
        row["people"] = feedback._people_list(value)
    else:
        row[col] = value
    if col == "project" and value and value not in config.PROJECTS:
        print(f"    (note: '{value}' is a new/off-list project — allowed, "
              f"treated as a [[tag]] project)")
    if col == "category" and value and value not in CATEGORIES:
        print(f"    (warning: '{value}' is not one of {sorted(CATEGORIES)})")


def _edit_loop(row: dict) -> str:
    """Prompt to edit columns until accepted. Returns 'approve' | 'skip' | 'quit'."""
    while True:
        try:
            choice = input("  edit column (blank=accept, 'skip', 'quit'): ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return "quit"
        if choice == "":
            return "approve"
        if choice in ("skip", "quit"):
            return choice
        if choice not in EDITABLE:
            print(f"  ? unknown column. editable: {', '.join(EDITABLE)}")
            continue
        try:
            value = input(f"    new value for {choice}: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return "quit"
        _apply_edit(row, choice, value)
        print(f"    {choice} -> {value or '(cleared)'}")


def _correction(before: dict, row: dict) -> dict | None:
    """Build a corrections.csv row if any label changed, else None."""
    if all(before.get(f, "") == row.get(f, "") for f in LABEL_FIELDS):
        return None
    corr = {
        "date": row.get("date", ""),
        "content": row.get("content", ""),
        "people": row.get("people", []),
    }
    for f in LABEL_FIELDS:
        corr[f"proposed_{f}"] = before.get(f, "")
        corr[f"final_{f}"] = row.get(f, "")
    return corr


def run(date: str | None = None, batch: int = 10, dry_run: bool = False) -> None:
    if not config.ALL_CSV.exists():
        print(f"No classified rows yet ({config.ALL_CSV} not found).")
        return
    rows = classify.load_rows_from_csv(config.ALL_CSV)
    if date:
        rows = [r for r in rows if r.get("date") == date]
    pending = _pending(rows)
    if not pending:
        print("Nothing to review." + (f" (date={date})" if date else ""))
        return

    print(f"{len(pending)} row(s) pending review"
          + (" — DRY RUN, nothing will be written." if dry_run else "") + "\n")

    notion = None  # lazily created only when a row targets Notion

    def _notion():
        nonlocal notion
        if notion is None:
            from .notion import Notion
            notion = Notion()
        return notion

    reviewed = edited = skipped = 0
    quit_now = False
    total = len(pending)

    for start in range(0, total, batch):
        chunk = pending[start:start + batch]
        print(f"\n===== batch {start // batch + 1} "
              f"(rows {start + 1}-{start + len(chunk)} of {total}) =====")
        for i, row in enumerate(chunk):
            _show(row, f"[{start + i + 1}/{total}]")
            before = {f: row.get(f, "") for f in LABEL_FIELDS}
            outcome = _edit_loop(row)
            if outcome == "quit":
                quit_now = True
                break
            if outcome == "skip":
                skipped += 1
                print("    skipped (stays pending).")
                continue

            # approve: route + record
            needs_notion = (
                row.get("category") in ("task", "event")
                or (row.get("category") == "remember" and (row.get("people") or []))
            )
            action = route.route_row(
                _notion() if (needs_notion and not dry_run) else None,
                row, dry_run=dry_run,
            )
            print(f"    -> {action}")
            corr = _correction(before, row)
            if not dry_run:
                feedback.append_gold(row)
                if corr:
                    feedback.append_correction(corr)
            reviewed += 1
            if corr:
                edited += 1
                print("    (recorded as a correction)")

        if quit_now:
            print("\nStopped — remaining rows stay pending.")
            break
        if start + batch < total:
            try:
                ans = input("\ncontinue to next batch? [Y/n]: ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                ans = "n"
                print()
            if ans in ("n", "no", "q", "quit"):
                print("Stopped — remaining rows stay pending.")
                break

    print(f"\nSummary: {reviewed} approved ({edited} edited), {skipped} skipped."
          + (" (dry run — nothing written)" if dry_run else ""))


def main() -> None:
    ap = argparse.ArgumentParser(description="Interactive review of low-confidence rows.")
    ap.add_argument("--date", default=None, help="only review this YYYY-MM-DD")
    ap.add_argument("--batch", type=int, default=10, help="rows per batch (default 10)")
    ap.add_argument("--dry-run", action="store_true", help="preview; write nothing")
    args = ap.parse_args()
    run(date=args.date, batch=args.batch, dry_run=args.dry_run)


if __name__ == "__main__":
    main()

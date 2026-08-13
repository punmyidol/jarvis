#!/usr/bin/env python3
"""Interactively add a `category` label to each row in datasets/logs.csv.

Run:  python label.py
- Shows each row's content and prompts for a category (pick by number).
- Writes after every entry, so it's safe to stop (Ctrl-C) and resume later;
  already-labeled rows are skipped.
- Press Enter to reuse the previous label.
"""

import csv
import os
import sys

CSV_PATH = os.path.join(os.path.dirname(__file__), "datasets", "since22jun.csv")
LABEL_COLUMN = "group"
CATEGORIES = ['group', 'individual']


def main():
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)

    if LABEL_COLUMN not in fieldnames:
        fieldnames.append(LABEL_COLUMN)

    total = len(rows)
    last_label = ""

    menu = "  " + "   ".join(f"{n}={c}" for n, c in enumerate(CATEGORIES, 1))

    for i, row in enumerate(rows):
        existing = (row.get(LABEL_COLUMN) or "").strip()
        if existing in CATEGORIES:
            last_label = existing
            continue  # already labeled, skip

        print(f"\n[{i + 1}/{total}]  {row.get('date', '')}")
        print(f"  {row.get('content', '')}")
        print(menu)
        default = last_label or "unsorted"
        prompt = f"  pick 1-{len(CATEGORIES)} [{default}]: "

        label = None
        while label is None:
            try:
                answer = input(prompt).strip()
            except (EOFError, KeyboardInterrupt):
                print("\nStopped. Progress saved.")
                save(CSV_PATH, fieldnames, rows)
                return
            if not answer:
                label = default
            elif answer.isdigit() and 1 <= int(answer) <= len(CATEGORIES):
                label = CATEGORIES[int(answer) - 1]
            elif answer in CATEGORIES:
                label = answer
            else:
                print(f"  ! enter a number 1-{len(CATEGORIES)} or a valid category name")

        row[LABEL_COLUMN] = label
        last_label = label

        # Save after each entry so progress is never lost.
        save(CSV_PATH, fieldnames, rows)
    else:
        print(f"\nDone. All {total} rows labeled.")

    save(CSV_PATH, fieldnames, rows)


def save(path, fieldnames, rows):
    tmp = path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            row.setdefault(LABEL_COLUMN, "")
            writer.writerow(row)
    os.replace(tmp, path)


if __name__ == "__main__":
    sys.exit(main())

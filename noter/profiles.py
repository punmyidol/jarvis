"""Local per-person profile files: `datasets/profiles.csv` (registry) +
`datasets/profiles/<name>.md` (facts).

Shared by the live loop (`route.py`, called from `run_daily.py` / `review_cli.py`)
and the standalone batch script (`write_profiles.py`), so both always agree on the
file format — including the `aliases:` header line, which lets the same person be
recognized under different raw name spellings (e.g. `tap` vs `แท็ป`). Alias values
are filled in by hand; nothing here auto-detects or merges them.
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

from . import config


def slug(name: str) -> str:
    s = name.strip().lower().replace(" ", "_")
    s = re.sub(r'[\\/:*?"<>|]', "", s)              # filesystem-unsafe chars (keeps Thai/unicode)
    return s or "unknown"


def _ensure_header(path: Path, name: str) -> str:
    """Return the file's current text, guaranteeing a `# name` title and an
    `aliases:` line. Inserts the aliases line for older files that predate it,
    right after the title (and `project:` line, if present), before the blank
    line + fact bullets. Idempotent."""
    if not path.exists():
        text = f"# {name}\naliases: \n\n"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return text

    text = path.read_text(encoding="utf-8")
    lines = text.split("\n")
    if any(line.startswith("aliases:") for line in lines[:3]):
        return text

    # header = title line, optional project: line; insert aliases: right after.
    insert_at = 1 if lines and lines[0].startswith("# ") else 0
    if insert_at < len(lines) and lines[insert_at].startswith("project:"):
        insert_at += 1
    lines.insert(insert_at, "aliases: ")
    new_text = "\n".join(lines)
    path.write_text(new_text, encoding="utf-8")
    return new_text


def append_fact(path: Path, name: str, date: str, content: str) -> bool:
    """Append a deduped fact bullet to `path`, creating/migrating its header first."""
    existing = _ensure_header(path, name)
    if content in existing:                          # dedupe by content
        return False
    line = f"- {date + ': ' if date else ''}{content}"
    with open(path, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    return True


def update_registry(name: str, project: str, profile_filename: str) -> None:
    """Upsert a row in `datasets/profiles.csv` for a project-associated person."""
    config.PROFILES_CSV.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    if config.PROFILES_CSV.exists():
        rows = list(csv.DictReader(open(config.PROFILES_CSV, newline="", encoding="utf-8-sig")))

    for row in rows:
        if row.get("name") == name:
            projects = json.loads(row.get("project") or "[]")
            if project not in projects:
                projects.append(project)
                row["project"] = json.dumps(projects, ensure_ascii=False)
            break
    else:
        rows.append({"name": name, "project": json.dumps([project], ensure_ascii=False),
                     "profile": profile_filename})

    with open(config.PROFILES_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["name", "project", "profile"])
        writer.writeheader()
        writer.writerows(rows)


def file_person(name: str, project: str, date: str, content: str) -> bool:
    """File one fact for `name`: append to their .md, and register them in
    profiles.csv when `project` is a real (non-`other`) project. Returns wrote-any?"""
    filename = slug(name) + ".md"
    path = config.PROFILES_DIR / filename
    config.PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    wrote = append_fact(path, name, date, content)
    if project and project != "other":
        update_registry(name, project, filename)
    return wrote

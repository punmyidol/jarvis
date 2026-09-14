"""Dispatch a single classified row to its destination.

    task, buy/pick up/purchase/... -> Notion Shopping List DB (upsert by title)
    task, otherwise           -> Notion Tasks DB (upsert by title+due)
    event                     -> Notion Events DB
    remember + person         -> local profiles.csv + profiles/<name>.md (per person)
    remember, no one          -> vault Remember.md
    note + project            -> vault <project folder>/Notes.md
    note + other              -> vault ideas.md

`dry_run` returns the intended action string without writing anything.
"""
from __future__ import annotations

import re
import time
from pathlib import Path

from . import config, profiles

# A task whose title opens with an unambiguous buy-verb is a grocery/errand
# item -> Shopping List instead of Tasks. "get" is deliberately excluded —
# too generic ("get to work early", "get back to Sarah" aren't shopping).
# Thai "ซื้อ" ("buy") included since real usage already has Thai-language
# lines; Thai has no spaces between words, so \b never matches after it (it'd
# run straight into the object) — matched separately, with no boundary
# requirement.
_SHOPPING_RE = re.compile(r"^(buy|pick up|purchase)\b|^ซื้อ", re.IGNORECASE)


def _is_shopping_item(title: str) -> bool:
    return bool(_SHOPPING_RE.match((title or "").strip()))


def _write_retry(path: Path, text: str, tries: int = 5, delay: float = 0.3) -> None:
    for attempt in range(tries):
        try:
            path.write_text(text, encoding="utf-8")
            return
        except OSError:
            if attempt == tries - 1:
                raise
            time.sleep(delay)


def _append_dedup(path: Path, line: str) -> bool:
    """Append `line` unless its content already appears in the file. Wrote?"""
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    if line.strip() and line.strip() in existing:
        return False
    _write_retry(path, (existing + ("" if existing.endswith("\n") or not existing else "\n") + line + "\n"))
    return True


def fold_task_groups(rows: list[dict]) -> tuple[dict[int, list[dict]], set[int]]:
    """A (date, group) holding exactly one task and >=1 note means those notes support
    the task: they ride the task's Notion page (as bullets) instead of routing on their
    own. Single source of truth for both `run_daily` and `review_cli`.

    Returns (supporting: {id(task_row): [note_rows]}, folded: {id(note_row), ...})."""
    from collections import defaultdict

    gmap: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in rows:
        g = r.get("group", "")
        if g and g != "individual":
            gmap[(r.get("date", ""), g)].append(r)
    supporting: dict[int, list[dict]] = {}
    folded: set[int] = set()
    for members in gmap.values():
        tasks = [m for m in members if m.get("category") == "task"]
        notes = [m for m in members if m.get("category") == "note"]
        if len(tasks) == 1 and notes:
            supporting[id(tasks[0])] = notes
            folded.update(id(n) for n in notes)
    return supporting, folded


def _note_line(row: dict) -> str:
    return f"- {row.get('date','')} {row.get('datetime','')} {row['content']}".rstrip()


def _vault_target(row: dict) -> Path:
    project = row.get("project", "other")
    if project == "other" or not project:
        return config.IDEAS_FILE
    if project in config.PROJECT_VAULT_FOLDER:
        return config.VAULT / config.PROJECT_VAULT_FOLDER[project] / "Notes.md"
    # a new [[tag]] project with no folder yet -> its own folder
    return config.VAULT / project / "Notes.md"


def route_row(notion, row: dict, dry_run: bool = False, supporting: list[dict] | None = None) -> str:
    """Route one row; return a short human description of the action taken.

    `supporting` are the task's same-group note rows (Part 1); their content is
    folded onto the task's Notion page as bullets, chronologically."""
    cat = row.get("category", "note")
    content = row.get("content", "")[:60]

    if cat == "task":
        title = row.get("clean_content") or row.get("content", "")
        if _is_shopping_item(title):
            if dry_run:
                return f"[task] -> Notion Shopping List (item={title[:40]!r})"
            created = notion.upsert_shopping_item(row)
            return f"[task] -> Notion Shopping List ({'created' if created else 'dup, skipped'})"
        dest = "Notion Tasks"
        notes = sorted(supporting or [], key=lambda s: s.get("datetime", ""))
        bullets = [f"{s.get('datetime','')} {s.get('content','')}".strip() for s in notes]
        if dry_run:
            body = ([row.get("task_context")] if row.get("task_context") else []) + bullets
            extra = f", +{len(body)} ctx" if body else ""
            return f"[task] -> {dest} (proj={row.get('project')}, due={row.get('due_date') or '-'}{extra})"
        created, added = notion.upsert_task(row, bullets)
        if created:
            tail = f"created (+{added} ctx)" if added else "created"
        else:
            tail = f"dup, +{added} ctx" if added else "dup, skipped"
        return f"[task] -> {dest} ({tail})"

    if cat == "event":
        if dry_run:
            return f"[event] -> Notion Events (proj={row.get('project')})"
        return f"[event] -> Notion Events ({'created' if notion.upsert_event(row) else 'dup, skipped'})"

    if cat == "remember":
        people = row.get("people", []) or []
        if not people:
            path = config.VAULT / "Remember.md"
            if dry_run:
                return f"[remember/no-person] -> vault Remember.md"
            wrote = _append_dedup(path, _note_line(row))
            return f"[remember] -> Remember.md ({'appended' if wrote else 'dup'})"
        if dry_run:
            return f"[remember] -> profiles.csv/md {people}"
        wrote = [p for p in people
                 if profiles.file_person(p, row.get("project", "other"),
                                         row.get("date", ""), content)]
        return f"[remember] -> profiles {people} ({len(wrote)} updated)"

    # note (default)
    target = _vault_target(row)
    rel = target.relative_to(config.VAULT)
    if dry_run:
        return f"[note] -> vault {rel}"
    wrote = _append_dedup(target, _note_line(row))
    return f"[note] -> vault {rel} ({'appended' if wrote else 'dup'})"

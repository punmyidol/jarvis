"""The two-stage classifier (the only Claude calls in the pipeline).

1. project  — project_prompt.txt over the day's `HH:MM:SS  content` lines.
2. category — category_prompt.txt over `HH:MM:SS | gap=<min> | project=<p> | content`,
              with `{now}` set to the note's date so relative due-dates resolve.

Both prompts get the learned few-shot block injected before their OUTPUT section
(the prompt files on disk are never modified). Output is the 11-column row schema.
"""
from __future__ import annotations

import csv
import json
import os
import re

from . import config, feedback
from .fetch import Entry

COLUMNS = [
    "date", "datetime", "content", "gap_before_min", "inferred_activity",
    "project", "people", "flags", "reason", "category", "group", "due_date",
    "due_time", "clean_content", "task_context",
]


# --------------------------------------------------------------------------- #
#  Anthropic call                                                             #
# --------------------------------------------------------------------------- #
def _client():
    import anthropic

    return anthropic.Anthropic()  # reads ANTHROPIC_API_KEY / ant profile


def _inject_fewshot(prompt: str, kind: str) -> str:
    block = feedback.fewshot_block(kind)
    if not block:
        return prompt
    marker = "\nOUTPUT\n"
    idx = prompt.find(marker)
    if idx == -1:
        return prompt + "\n" + block
    return prompt[:idx] + "\n" + block + prompt[idx:]


def _call(system: str, user: str, max_tokens: int = 16000) -> str:
    resp = _client().messages.create(
        model=config.MODEL,
        max_tokens=max_tokens,
        thinking={"type": "adaptive"},
        output_config={"effort": config.EFFORT},
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return next((b.text for b in resp.content if b.type == "text"), "")


def _parse_array(text: str) -> list[dict]:
    text = text.strip()
    if text.startswith("```"):                    # strip a ``` / ```json fence
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    data = json.loads(text)
    if not isinstance(data, list):
        raise ValueError(f"expected a JSON array, got {type(data).__name__}")
    return data


# --------------------------------------------------------------------------- #
#  Stage 1 — project                                                          #
# --------------------------------------------------------------------------- #
def classify_project(entries: list[Entry]) -> list[dict]:
    system = _inject_fewshot(config.PROJECT_PROMPT.read_text(encoding="utf-8"), "project")
    user = "\n".join(f"{e.datetime}  {e.content}" for e in entries)
    return _parse_array(_call(system, user))


# --------------------------------------------------------------------------- #
#  Stage 2 — category + group + due_date                                      #
# --------------------------------------------------------------------------- #
def classify_category(entries: list[Entry], projects: list[str], now_iso: str) -> list[dict]:
    prompt = config.CATEGORY_PROMPT.read_text(encoding="utf-8").replace("{now}", now_iso)
    system = _inject_fewshot(prompt, "category")
    user = "\n".join(
        f"{e.datetime} | gap={e.gap_before_min} | project={p} | {e.content}"
        for e, p in zip(entries, projects)
    )
    return _parse_array(_call(system, user))


# --------------------------------------------------------------------------- #
#  Merge                                                                       #
# --------------------------------------------------------------------------- #
def _as_list(v) -> list:
    if isinstance(v, list):
        return v
    if v in (None, ""):
        return []
    return [v]


def agent_request_path(date: str):
    return config.DATASETS / f"{date}.agent-request.json"


def agent_response_path(date: str):
    return config.DATASETS / f"{date}.agent.json"


def write_agent_request(entries: list[Entry], note_date: str, now_iso: str) -> None:
    """Dump the exact prompts + inputs so a Claude Code subagent can classify
    without the paid API. The agent writes agent_response_path with
    {"project": [...], "category": [...]}."""
    req = {
        "note_date": note_date,
        "now": now_iso,
        "project_prompt": _inject_fewshot(config.PROJECT_PROMPT.read_text(encoding="utf-8"), "project"),
        "category_prompt": _inject_fewshot(
            config.CATEGORY_PROMPT.read_text(encoding="utf-8").replace("{now}", now_iso), "category"),
        "project_input": "\n".join(f"{e.datetime}  {e.content}" for e in entries),
        "entries": [{"datetime": e.datetime, "gap_before_min": e.gap_before_min,
                     "content": e.content} for e in entries],
    }
    agent_request_path(note_date).write_text(json.dumps(req, ensure_ascii=False, indent=2))


def classify_day(entries: list[Entry], note_date: str, now_iso: str | None = None,
                 backend: str = "api") -> list[dict]:
    """Run both stages and merge into 11-column rows (+ note `date`).

    backend='api'   -> call the Anthropic API (default).
    backend='agent' -> read a Claude Code subagent's response file (no API credits);
                       if absent, write the request file and raise.
    """
    if not entries:
        return []
    now_iso = now_iso or f"{note_date}T23:59:00"

    if backend == "agent":
        resp = agent_response_path(note_date)
        if not resp.exists():
            write_agent_request(entries, note_date, now_iso)
            raise RuntimeError(
                f"agent backend: no response yet. Wrote {agent_request_path(note_date)}; "
                f"a subagent must write {resp} as {{'project':[...], 'category':[...]}}.")
        data = json.loads(resp.read_text(encoding="utf-8"))
        proj, cat = data["project"], data["category"]
    else:
        proj = classify_project(entries)
        projects = [p.get("project", "other") for p in proj]
        cat = classify_category(entries, projects, now_iso)

    return _merge(entries, proj, cat, note_date)


def _merge(entries: list[Entry], proj: list[dict], cat: list[dict], note_date: str) -> list[dict]:
    rows: list[dict] = []
    for i, e in enumerate(entries):
        p = proj[i] if i < len(proj) else {}
        c = cat[i] if i < len(cat) else {}
        rows.append({
            "date": note_date,
            "datetime": e.datetime,
            "content": e.content,
            "gap_before_min": e.gap_before_min,          # deterministic (from fetch)
            "inferred_activity": p.get("inferred_activity", ""),
            "project": p.get("project", "other"),
            "people": _as_list(p.get("people")),
            "flags": _as_list(p.get("flags")),
            "reason": p.get("reason", ""),
            "category": c.get("category", "note"),
            "group": c.get("group", "individual"),
            "due_date": c.get("due_date", ""),
            "due_time": c.get("due_time", ""),
            "clean_content": c.get("clean_content", ""),
            "task_context": c.get("task_context", ""),
        })
    return rows


# --------------------------------------------------------------------------- #
#  CSV I/O                                                                     #
# --------------------------------------------------------------------------- #
def _encode_row(r: dict) -> dict:
    """One CSV row as strings. `people`/`flags` may be lists or pre-serialized
    JSON strings (e.g. rows read back from disk) — serialize only lists."""
    def _json(v):
        return v if isinstance(v, str) else json.dumps(v or [], ensure_ascii=False)
    return {
        **{k: r.get(k, "") for k in COLUMNS},
        "people": _json(r.get("people", [])),
        "flags": _json(r.get("flags", [])),
    }


def write_csv(rows: list[dict], path) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        for r in rows:
            w.writerow(_encode_row(r))


def upsert_csv(rows: list[dict], date: str, path) -> None:
    """Merge one day's `rows` into the single combined CSV at `path`, replacing
    any existing rows for `date` (idempotent re-runs). Days are kept grouped and
    ordered; within a day, original row order is preserved."""
    existing = load_rows_from_csv(path) if os.path.exists(path) else []
    kept = [r for r in existing if (r.get("date") or "") != date]
    merged = kept + [{**r, "date": date} for r in rows]
    merged.sort(key=lambda r: r.get("date") or "")   # stable: preserves within-day order
    write_csv(merged, path)


def migrate_per_day_to_all(path=None) -> int:
    """One-time seed: fold every `datasets/YYYY-MM-DD.csv` into the combined CSV,
    stamping each row's `date` from its filename. Idempotent (upserts per day)."""
    path = path or config.ALL_CSV
    days = sorted(config.DATASETS.glob("[0-9]" * 4 + "-[0-9][0-9]-[0-9][0-9].csv"))
    for p in days:
        upsert_csv(load_rows_from_csv(p, note_date=p.stem), p.stem, path)
    return len(days)


def load_rows_from_csv(path, note_date: str | None = None) -> list[dict]:
    """Load pre-classified rows (for offline re-runs / verification).

    Tolerates older sample CSVs missing `due_date`/`inferred_activity`; parses
    JSON-encoded `people`/`flags`, or falls back to a plain string.
    """
    rows: list[dict] = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            rows.append({
                "date": r.get("date") or note_date or "",
                "datetime": r.get("datetime", ""),
                "content": r.get("content", ""),
                "gap_before_min": int(r.get("gap_before_min") or 0),
                "inferred_activity": r.get("inferred_activity", ""),
                "project": r.get("project", "other"),
                "people": _people(r.get("people")),
                "flags": _people(r.get("flags")),
                "reason": r.get("reason", ""),
                "category": r.get("category", "note"),
                "group": r.get("group", "individual"),
                "due_date": r.get("due_date", ""),
                "due_time": r.get("due_time", ""),
                "clean_content": r.get("clean_content", ""),
                "task_context": r.get("task_context", ""),
            })
    return rows


def _people(cell) -> list:
    cell = (cell or "").strip()
    if not cell:
        return []
    try:
        v = json.loads(cell)
        return v if isinstance(v, list) else [str(v)]
    except Exception:
        return [p.strip() for p in re.split(r"[;,|]", cell) if p.strip()]

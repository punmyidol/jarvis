"""Stage LOW-confidence rows into the Notion "Noter Review" database.

RETIRED (Notion review path): superseded by the local `review_cli.py`, which reviews the
LOW rows straight out of `datasets/all.csv`. `run_daily` no longer calls `stage()`; kept
here for the legacy Notion-staging flow only.
"""
from __future__ import annotations


def stage(notion, rows: list[dict], dry_run: bool = False) -> list[str]:
    """Stage each row into Noter Review. Returns action lines."""
    actions = []
    for row in rows:
        head = row.get("content", "")[:60]
        if dry_run:
            actions.append(f"[review] stage: {head}  (cat={row.get('category')}, proj={row.get('project')})")
            continue
        created = notion.stage_review(row)
        actions.append(f"[review] {'staged' if created else 'already staged'}: {head}")
    return actions

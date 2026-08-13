"""Read the text-editor's daily note into ordered, gap-annotated entries.

The brain-dump editor saves `Noter/dailies/<date>.md` as one line per entry:
    HH:MM:SS<TAB>content
Multi-line entries (pasted code/tables) keep the timestamp on the first line and
leave the timestamp blank (or indent) on continuation lines. We also tolerate the
`- HH:MM:SS content` Log-bullet format in case a daily note is used directly.

`gap_before_min` is computed here deterministically from the timestamps — the LLM
is never trusted for it.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from datetime import date as date_cls
from datetime import datetime
from pathlib import Path

from . import config

_TS = r"(\d{2}:\d{2}:\d{2})"
_TAB_LINE = re.compile(rf"^{_TS}\t(.*)$")
_BULLET_LINE = re.compile(rf"^\s*[-*]\s+{_TS}\s+(.*)$")
_CONT_LINE = re.compile(r"^(?:\t|\s{2,})(.*)$")  # continuation of the prior entry


@dataclass
class Entry:
    datetime: str          # "HH:MM:SS"
    content: str
    gap_before_min: int = 0
    extra: dict = field(default_factory=dict)


def read_text_retry(path: Path, tries: int = 5, delay: float = 0.3) -> str:
    """Read a file, retrying transient iCloud 'deadlock'/busy errors."""
    for attempt in range(tries):
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            if attempt == tries - 1:
                raise
            time.sleep(delay)
    return ""


def daily_path(day: str) -> Path:
    """Resolve a YYYY-MM-DD string to its Noter/dailies file."""
    return config.NOTER_DAILIES / f"{day}.md"


def _parse_lines(text: str) -> list[Entry]:
    entries: list[Entry] = []
    for raw in text.splitlines():
        m = _TAB_LINE.match(raw) or _BULLET_LINE.match(raw)
        if m:
            ts, content = m.group(1), m.group(2).rstrip()
            entries.append(Entry(datetime=ts, content=content))
            continue
        c = _CONT_LINE.match(raw)
        if c and entries:                       # continuation of the last entry
            entries[-1].content += "\n" + c.group(1).rstrip()
            continue
        # blank lines / frontmatter / headers between entries are ignored
    return entries


def _minutes(a: str, b: str) -> int:
    """Whole minutes from timestamp a to b (same day, HH:MM:SS)."""
    fmt = "%H:%M:%S"
    delta = datetime.strptime(b, fmt) - datetime.strptime(a, fmt)
    return max(0, round(delta.total_seconds() / 60))


def _annotate_gaps(entries: list[Entry]) -> list[Entry]:
    prev = None
    for e in entries:
        e.gap_before_min = 0 if prev is None else _minutes(prev, e.datetime)
        prev = e.datetime
    return entries


def fetch_day(day: str) -> list[Entry]:
    """Return the day's entries (chronological, gap-annotated). Empty if no file."""
    path = daily_path(day)
    if not path.exists():
        return []
    entries = [e for e in _parse_lines(read_text_retry(path)) if e.content.strip()]
    return _annotate_gaps(entries)


def available_days() -> list[str]:
    """All YYYY-MM-DD notes present in Noter/dailies, sorted."""
    if not config.NOTER_DAILIES.exists():
        return []
    pat = "[0-9]" * 4 + "-[0-9][0-9]-[0-9][0-9].md"
    return sorted(p.stem for p in config.NOTER_DAILIES.glob(pat))


def resolve_date(arg: str | None) -> str:
    """`--date` value -> YYYY-MM-DD. 'today'/None -> today; passthrough otherwise."""
    if arg in (None, "today"):
        return date_cls.today().isoformat()
    return arg


if __name__ == "__main__":  # quick manual check: python -m noter.fetch [DATE]
    import sys

    d = resolve_date(sys.argv[1] if len(sys.argv) > 1 else None)
    rows = fetch_day(d)
    print(f"{d}: {len(rows)} entries")
    for e in rows:
        print(f"  {e.datetime}  gap={e.gap_before_min:>3}m  {e.content[:70]}")

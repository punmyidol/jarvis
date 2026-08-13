"""Prepare the agent-classifier handoff for a date.

Writes `datasets/<date>.agent-request.json` (the exact prompts + inputs) so a
headless Claude Code run can classify without the paid API, then continue via
`python -m noter.run_daily --date <date> --classifier agent`.

    python -m noter.agent_prep --date today
Prints `NO_NOTE` if the day has no entries, else the request-file path.
"""
from __future__ import annotations

import argparse

from . import classify
from .fetch import fetch_day, resolve_date


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default="today")
    date = resolve_date(ap.parse_args().date)

    entries = fetch_day(date)
    if not entries:
        print("NO_NOTE")
        return
    if classify.agent_response_path(date).exists():
        print(f"HAVE_RESPONSE {classify.agent_response_path(date)}")
        return
    classify.write_agent_request(entries, date, f"{date}T23:59:00")
    print(f"REQUEST {classify.agent_request_path(date)}  ({len(entries)} entries)")


if __name__ == "__main__":
    main()

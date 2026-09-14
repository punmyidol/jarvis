"""Push the Notion Shopping List into a macOS Reminders.app list, one-way.

Creates the "Shopping List" Reminders list if missing, adds any unchecked
Notion item not already present as a reminder, and marks-complete any
reminder whose matching Notion row is now checked. Local-only (needs
Reminders.app + Automation access); called from `run_daily` as a best-effort
final step so the list stays fresh for a location-based Reminders/Shortcuts
trigger set up by hand (AppleScript cannot set a location trigger itself).
"""
from __future__ import annotations

import subprocess

LIST_NAME = "Shopping List"


def _osascript(script: str) -> str:
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"osascript failed: {result.stderr.strip()}")
    return result.stdout.strip()


def _existing_reminder_names() -> set[str]:
    out = _osascript(f'''
    tell application "Reminders"
        if not (exists list "{LIST_NAME}") then
            make new list with properties {{name:"{LIST_NAME}"}}
        end if
        set out to ""
        repeat with r in (reminders of list "{LIST_NAME}" whose completed is false)
            set out to out & (name of r) & (ASCII character 10)
        end repeat
        return out
    end tell
    ''')
    return {line.strip() for line in out.splitlines() if line.strip()}


def _add_reminder(name: str) -> None:
    escaped = name.replace("\\", "\\\\").replace('"', '\\"')
    _osascript(f'''
    tell application "Reminders"
        make new reminder at end of list "{LIST_NAME}" with properties {{name:"{escaped}"}}
    end tell
    ''')


def _complete_reminder(name: str) -> None:
    escaped = name.replace("\\", "\\\\").replace('"', '\\"')
    _osascript(f'''
    tell application "Reminders"
        repeat with r in (reminders of list "{LIST_NAME}" whose name is "{escaped}" and completed is false)
            set completed of r to true
        end repeat
    end tell
    ''')


def sync(notion) -> dict:
    """One-way push: Notion Shopping List -> Reminders.app "Shopping List" list.

    Returns {"added": [names], "completed": [names]}.
    """
    items = notion.shopping_items()
    existing = _existing_reminder_names()

    added, completed = [], []
    for item in items:
        name = item["name"]
        if not name:
            continue
        if not item["checked"] and name not in existing:
            _add_reminder(name)
            added.append(name)
        elif item["checked"] and name in existing:
            _complete_reminder(name)
            completed.append(name)
    return {"added": added, "completed": completed}

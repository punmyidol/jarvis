---
name: daily-plan
description: Use when the user asks for their plan/agenda/schedule/weather for today (e.g. "what's my plan for today", "what do I have today", "what's on my plate today", "what's the weather like today"). Merges Notion Tasks, Tasks V1 (Scout), Events, Shopping List, new Canvas (umich.instructure.com) assignments, local Apple Calendar, and Open-Meteo weather into one time-sorted table plus a shopping checklist and weather summary for the current day, writes new Canvas assignments to the Notion Tasks DB, and writes the result to the Notion "Today" page.
---

Answer "what's my plan for today" by merging seven sources into one
time-sorted table plus a shopping checklist and weather summary. This is
mostly a read-only query task, separate from the noter classify/route
pipeline — no other repo context is needed to run it. The one exception is
the Canvas step (5), which writes new Notion Task rows when it finds
assignments not yet tracked.

Target date = today, local time, **Ann Arbor / Eastern Time (`America/Detroit`)**.
Eastern Time's UTC offset changes with Daylight Saving (UTC-4 during EDT,
roughly mid-March to early November; UTC-5 during EST the rest of the year)
— never hardcode a fixed offset. Get the current Ann Arbor date first with:

```bash
TZ="America/Detroit" date +%Y-%m-%d
```

Use that value everywhere `{today}` appears below — it is Ann Arbor's
calendar date, not the assistant's own system/UTC date, and the two can
differ near midnight. For converting any stored-UTC timestamp (Notion dates,
Canvas due dates) to Ann Arbor local for display, use a timezone-aware
conversion rather than arithmetic, e.g.:

```bash
python3 -c "
from datetime import datetime
from zoneinfo import ZoneInfo
dt = datetime.fromisoformat('2026-09-06T13:00:00+00:00')  # swap in the UTC value
print(dt.astimezone(ZoneInfo('America/Detroit')))
"
```

## 1. Notion — Tasks (main DB)

- Database id: `37326f5d5d608038b826c84e148a15a7`
- Data source: `collection://37326f5d-5d60-80ad-a398-000b425007cb`
- Columns: `Task` (title), `Done` (checkbox), `Due Date` (date, sometimes has
  a time), `relation` (project relation)
- Query (undone, due today or earlier):
  ```sql
  SELECT "Task", "date:Due Date:start", "date:Due Date:is_datetime", "Done"
  FROM "collection://37326f5d-5d60-80ad-a398-000b425007cb"
  WHERE "Done" = '__NO__'
    AND "date:Due Date:start" IS NOT NULL
    AND date("date:Due Date:start") <= date('{today}')
  ORDER BY "date:Due Date:start" ASC
  ```
- `date:Due Date:start` is stored in UTC. When `is_datetime = 1`, convert to
  Ann Arbor local time (see the timezone-aware conversion above) before
  presenting — do not add a fixed number of hours.

## 2. Notion — Tasks V1 (Scout project, separate page tree)

- Database id: `38e26f5d5d6080afa108c585d62969a2` (lives under the "Scout"
  page — not in `noter/notion_ids.json`; find it via `notion-search` for
  "Tasks V1" if the id ever changes)
- Data source: `collection://38e26f5d-5d60-80a8-802f-000b61c0cb3d`
- Columns: `Task` (title), `Done`, `Due Date`, `Select` (`think`/`post`),
  `Assigned to`, `Created When`. `Select` and `Done` are reserved-ish
  words — always double-quote every column name in the query or Notion's SQL
  parser rejects it.
- Query (undone, due today or earlier):
  ```sql
  SELECT "Task", "date:Due Date:start", "date:Due Date:is_datetime", "Select", "Done"
  FROM "collection://38e26f5d-5d60-80a8-802f-000b61c0cb3d"
  WHERE "Done" = '__NO__'
    AND "date:Due Date:start" IS NOT NULL
    AND date("date:Due Date:start") <= date('{today}')
  ORDER BY "date:Due Date:start" ASC
  ```

## 3. Notion — Events DB

- Database id: `d98a6a4bc8f4498aa26088c4ccc8190d`
- Data source: `collection://16699802-8daa-4810-9832-dadb906a257b`
- Columns: `Name` (title), `Date`, `Project` (relation)
- Query (today only):
  ```sql
  SELECT "Name", "date:Date:start", "date:Date:is_datetime"
  FROM "collection://16699802-8daa-4810-9832-dadb906a257b"
  WHERE "date:Date:start" IS NOT NULL
    AND date("date:Date:start") = date('{today}')
  ORDER BY "date:Date:start" ASC
  ```

## 4. Notion — Shopping List

- Database id: `3bd26f5d5d6080d3aeebda5ea71bcdd4`
- Data source: `collection://3bd26f5d-5d60-80e9-9bd4-000bbe2bd7cb`
- Columns: `Name` (title), `Checkbox` (bought/not)
- Query (open items):
  ```sql
  SELECT "Name"
  FROM "collection://3bd26f5d-5d60-80e9-9bd4-000bbe2bd7cb"
  WHERE "Checkbox" = '__NO__'
  ```

Query all four Notion sources via the `notion-query-data-sources` MCP tool
in `sql` mode (one data source per call — cross-source queries need
Enterprise). Fetch each database once first (`notion-fetch` on the database
id) to reconfirm schema/collection URLs before querying, in case anything
changed.

## 5. Canvas — umich.instructure.com (read + write new assignments)

No MCP tool or API token for this — read it via `claude-in-chrome`, reusing
the user's already logged-in Chrome session. Load the tools first if
deferred: `ToolSearch` with `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__read_page`.

- Navigate to `https://umich.instructure.com/`. If the dashboard is in Card
  View, switch to **List View** via the view-toggle icon top-right — it
  shows a single flat, date-sorted list of upcoming assignments across all
  courses, which is far easier to extract than opening each course.
- Use `get_page_text`/`read_page` to extract each assignment's title, due
  date/time, and course name.
- **Dedupe:** compare each Canvas assignment's title against the Tasks DB
  rows already fetched in section 1 above (case-insensitive match, ignoring
  a course-code prefix). Only assignments with no existing match are "new."
- **Write new ones** via the `notion-create-pages` MCP tool, one page per
  assignment, in data source `collection://37326f5d-5d60-80ad-a398-000b425007cb`
  (the same Tasks DB as section 1), with:
  - `Task` (title) = `"[<course code>] <assignment name>"` — keep the
    course-code prefix short and consistent so future runs can dedupe
    against it reliably.
  - `Due Date` = the date/time Canvas shows. Canvas displays in Ann Arbor/
    Eastern time by default (confirm via the account settings if it looks
    off), which now matches this skill's target timezone — convert it to UTC
    before writing (the property is stored in UTC) using the same
    timezone-aware conversion, in reverse (`ZoneInfo('America/Detroit')` →
    UTC), not a fixed offset.
  - `relation` = the umich Projects-DB page, id
    `38726f5d5d608017a182ce8a9984d1f5` (the same id `noter`'s pipeline
    already writes for `project == "umich"`, so both pipelines' umich tasks
    land under one relation).
  - `Done` = unchecked.
- Skip assignments that already look submitted/graded — Canvas's list/to-do
  view normally excludes these already, so no extra filtering logic is
  needed.
- Add each newly-created assignment into the in-memory task list carried
  over from section 1 (not just Notion) so that, if due today, it appears in
  *this run's* merged table without a second query round-trip.

## 6. Apple Calendar (local, via AppleScript)

No MCP tool for this — read it with `osascript` in Bash. Requires macOS to
have granted Automation/Calendar access to the calling process (Terminal /
Claude Code); if the script errors with a permissions prompt, that's a
one-time System Settings grant, not a code problem.

AppleScript's `current date` reflects the Mac's own system timezone, which
may not be `America/Detroit`. Before running the script, compare the Mac's
own date/offset against Ann Arbor's:

```bash
date +%Y-%m-%d\ %z
TZ="America/Detroit" date +%Y-%m-%d\ %z
```

If they match, run the script as-is. If they differ, the script's
`todayStart`/`todayEnd` window (and the printed event times) are in the
Mac's local time, not Ann Arbor's — shift the window by the difference
between the two offsets above before filtering, and convert each printed
event time to Ann Arbor local (timezone-aware, as above) before adding it to
the merged table.

```applescript
set todayStart to current date
set time of todayStart to 0
set todayEnd to todayStart + (1 * days)

set output to ""
tell application "Calendar"
    repeat with c in calendars
        set evts to (every event of c whose start date ≥ todayStart and start date < todayEnd)
        repeat with e in evts
            set output to output & (summary of e) & " | " & (start date of e as string) & " | " & (end date of e as string) & " | " & (name of c) & "\n"
        end repeat
    end repeat
end tell
return output
```

Run via `osascript <<'EOF' ... EOF`. Iterates every calendar the Mac has
(includes iCloud "Family" etc.), so no calendar name needs to be hardcoded.

## 7. Weather (Open-Meteo, Ann Arbor)

No MCP tool for this either — a plain JSON API, no key required. Fetch it
with `curl` in Bash and parse the JSON directly; don't use `WebFetch` for
this one — it summarizes fetched content through its own model pass, which
risks rounding/hallucinating the exact numbers this section needs.

```bash
curl -s "https://api.open-meteo.com/v1/forecast?latitude=42.2808&longitude=-83.7430&current=temperature_2m,weather_code,precipitation&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=America%2FDetroit"
```

Read from the response:
- `current.temperature_2m` — right-now temperature (°C)
- `current.weather_code` — right-now condition (map via the table below)
- `daily.temperature_2m_max[0]` / `daily.temperature_2m_min[0]` — today's
  high/low
- `daily.precipitation_probability_max[0]` — today's max rain chance (%)
- `daily.weather_code[0]` — today's overall condition

WMO `weather_code` → condition:
| Code | Condition |
|---|---|
| 0 | Clear sky |
| 1, 2, 3 | Mainly clear, partly cloudy, overcast |
| 45, 48 | Fog, depositing rime fog |
| 51, 53, 55 | Drizzle: light, moderate, dense |
| 56, 57 | Freezing drizzle: light, dense |
| 61, 63, 65 | Rain: slight, moderate, heavy |
| 66, 67 | Freezing rain: light, heavy |
| 71, 73, 75 | Snow fall: slight, moderate, heavy |
| 77 | Snow grains |
| 80, 81, 82 | Rain showers: slight, moderate, violent |
| 85, 86 | Snow showers: slight, heavy |
| 95 | Thunderstorm |
| 96, 99 | Thunderstorm with hail |

## Output shape

Start with a single **Weather** line (from source 7), before anything else,
e.g. `Weather: 32°C/25°C, 20% rain chance, partly cloudy` (today's
high/low, max rain chance, and current condition). It's day-level context,
not a timed item, so it never goes in the table below.

Then merge tasks/events/calendar into **one single table**, sorted by time,
columns: `Time | Item | Source | Status`.

Every row needs a timeslot — don't split timed/untimed into separate lists.
For a task/event with no explicit time, find one in this order before
falling back to a guess:

1. **Notion's own time.** If `is_datetime = 1` on `Due Date`/`Date`, use it
   (converted to Ann Arbor local time, timezone-aware — not a fixed offset).
   This is the only case with a real time — prefer it over everything below.
2. **Time written in the content.** If `is_datetime = 0` (date-only), read
   the task/event title itself for a clock time before assuming there is
   none — e.g. "7pm", "14:00", "บ่าย 2 โมง", "ตอนเช้า". Notion's date field
   sometimes drops the time even when the person clearly meant one.
3. **Inferred slot.** Only if neither above gives a time: infer a plausible
   slot from what the task is (calls/errands → business hours, personal/
   errand-y evening tasks → evening, etc.) and place it in an open gap
   between the fixed (calendar + real-time) items for that day. Mark these
   rows clearly as inferred (e.g. `~14:00 (inferred)`) so they're never
   mistaken for a real commitment.

Overdue-but-undone tasks (due before today) go in the same table, marked
`overdue` in Status, placed either at the top or in their own trailing
section — not interleaved into today's inferred slots.

Flag any overlapping/conflicting time ranges between calendar events and
timed tasks in the Status column — don't silently merge them even if the
titles look related.

After the table, add a **"Shopping List (open items)"** section — a plain
bullet list of the unchecked item names from source 4. It has no date/time,
so it doesn't belong in the merged table itself; don't invent a timeslot for
it.

## 8. Write to the Notion "Today" page

Every time this plan is generated (whatever the target date), also write it
to the Notion page **"🗓️ Today"** — page id `3bb26f5d5d60816daff8c2c481face0b`
(url `https://app.notion.com/p/3bb26f5d5d60816daff8c2c481face0b`), which lives
under Dashboard. Use `notion-update-page` with `command: "replace_content"`
and `new_str` set to the full generated output (weather line, the `## TO DO
TODAY` merged table, and the Shopping List section) in Notion-flavored
markdown — this replaces whatever the page held before. Do this in addition
to, not instead of, showing the plan in chat.

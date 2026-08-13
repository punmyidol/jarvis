# noter pipeline

Reads the text-editor's timestamped daily note, classifies each line with Claude
(project + category/group/due_date), then routes each entry to its destination.
Confident rows auto-file; uncertain rows wait in a Notion review DB whose edits feed
a learning loop.

```
brain-dump editor (localhost:3000, unchanged)
   └─ Noter/dailies/<date>.md
        └─ run_daily: fetch → classify (2 Claude calls) → overrides → confidence split
             ├─ HIGH → auto-file:  task→Tasks DB · event→Events DB · remember+person→Profiles DB
             │                     note→vault <project>/Notes.md · idea→vault ideas.md
             └─ LOW  → Notion "Noter Review" DB → you edit/approve → commit → same routes
                                                                          └─ gold.csv + corrections.csv (learning)
```

## One-time setup

1. **Deps** (already installed in `venv/`): `venv/bin/pip install -r requirements.txt`
2. **Secrets**: `cp .env.example .env` and fill in:
   - `ANTHROPIC_API_KEY` (or `ant auth login`).
   - `NOTION_TOKEN` — create an internal integration at
     <https://www.notion.so/my-integrations>, then open the **Dashboard** page in Notion →
     `•••` → **Connections** → add your integration. Its children (Tasks, Projects, Events,
     Profiles, Noter Review) inherit access.
3. **Notion databases**: already created under the Dashboard (Events, Profiles, Noter Review);
   their ids are cached in `noter/notion_ids.json`.

## Daily use

- **Capture**: keep using the brain-dump editor on `localhost:3000` (unchanged). This
  pipeline only reads `Noter/dailies/<date>.md`.
- **Evening** (auto): `python -m noter.run_daily --date today` — classifies, auto-files
  confident rows, stages the uncertain ones into **Noter Review**.
- **Review**: open Noter Review in Notion, fix any wrong Category/Project, tick **Approved**.
- **Morning** (auto): `python -m noter.commit` — files the approved rows and records your
  edits into `datasets/gold.csv` / `datasets/corrections.csv` (the learning loop).

### Manual / testing
```
python -m noter.fetch 2026-06-28                          # inspect parsed entries
python -m noter.run_daily --date 2026-06-28 --dry-run     # classify + show routing, write nothing
python -m noter.run_daily --date 2026-06-28 --from-csv datasets/2026-06-28-nobge.csv --dry-run
python -m noter.commit --dry-run                          # show what would commit
```
`--from-csv` skips the Claude calls and loads a pre-labeled CSV (offline).
Tune the gate with `NOTER_STRICT_CONFIDENCE=0` to auto-file more as it learns.

## Scheduling (macOS launchd)

Pick ONE nightly job (A or B); both use the same morning commit. Jobs run locally (to
reach the iCloud vault); the Mac must be awake at the scheduled time.

**Morning commit (both paths)** — plain Python, files the review rows you approved:
```
cp deploy/com.noter.commit.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.noter.commit.plist
```

**A — nightly via the API** (needs Anthropic credits; deterministic):
```
cp deploy/com.noter.stage.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.noter.stage.plist
launchctl kickstart -k gui/$(id -u)/com.noter.stage
```

**B — nightly via headless Claude Code** (no API credits; uses Claude Code quota).
⚠️ Runs an unattended agent with `--permission-mode bypassPermissions` (Bash/Write, no
approval gate). Opt in deliberately. Do NOT also load `com.noter.stage` (they'd both classify).
```
chmod +x deploy/run_night_agent.sh
cp deploy/com.noter.nightly-agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.noter.nightly-agent.plist
bash deploy/run_night_agent.sh          # test once
```

Logs: `deploy/stage.log`, `deploy/nightly-agent.log`, `deploy/commit.log`.
Both nightly paths require the Notion integration connected to the Dashboard (for the
Notion writes) — the vault writes work without it.

## Scope
Forward-only — classifies each new day (2 Claude calls/day). No historical backfill.
See `datasets/INCONSISTENCIES.md` for spec-vs-disk issues flagged during the build.

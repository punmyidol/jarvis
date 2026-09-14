# noter

A personal-logging pipeline: a timestamped daily note (`YYYY-MM-DD.md`) is classified
per line into a **project**, a **category**, and a **group** (a thinking-chain of notes,
or a task plus the notes that support it), then emitted as one CSV per day for a
dashboard. People named in entries get profiles.

## Design Choices
- False positives are better than false negatives for the `task` category (lean task when unsure — better to surface a non-task than miss a real one).
- New projects can only be created with a `[[project]]` tag — the classifier uses a closed set otherwise.
- `remember` is a personal fact/preference about the *user* (tastes, likes, personal details); `note` is a fact/idea/status about a *project, tool, or the world*.
- **Grouping is done by the category prompt, not by embeddings.** A `group` is either a thinking-chain of notes, or a task together with the notes that help complete it (those supporting notes take the same group id as the task). The category step assigns it because grouping turns on the note/task distinction it already reasons about. The bge-m3 k-dist clustering is retired (distance was a weak segmenter — real chains landed just over the cutoff). No embedder is in the pipeline now.
- **A note grouped with a task is filed to Notion *with* that task** — folded onto the task's page as a bullet, never routed on its own to the vault. Enforced from one helper (`route.fold_task_groups`) so it holds on **both** the auto-file path (`run_daily`) and the local review path (`review_cli`, which excludes folded notes from the pending queue). Trade-off: once folded, a mis-grouped note can't be re-labelled via `review_cli` — fix it by re-classifying the day or a manual correction.

## Pipeline

```
entry+timestamp
  -> project            (classifier prompt) # project_prompt.txt  (LLM); project + people
  -> category + group   (classifier prompt) # category_prompt.txt  (LLM); assigns BOTH
                                           #   group = note thinking-chain, OR task + the notes
                                           #   that support it (sharing the task's group id);
                                           #   g1, g2, … ; a standalone line -> individual
  -> output dashboard CSV                  # datasets/YYYY-MM-DD.csv
  -> profiles  (remember + person)         # write_profiles.py -> datasets/profiles/
```

### 1. Project — `project_prompt.txt` (LLM)
Assigns each line a project from the closed set, plus the people named on it. Uses the
**time gaps** to reason about what the author was doing (short gap = one activity; long
gap before a line = the author was *doing* the thing, so the line is its output/next-
step) and propagates a project across neighbouring lines: a tagged line sets the project
for its untagged neighbours. A `[[tag]]`/verbatim name wins when present; a tag *inside
a quoted sample* is not a tag for that line. Names are a project signal (a person tied
to one project is evidence for it) but never override a tag. **This step no longer emits
a session id** — grouping happens in the category step.
- **Closed set:** helmet detection, elvis, mom's herbal tea, garden, land deed tracker, umich, noter, other.
- **Output columns:** `datetime, content, gap_before_min, inferred_activity, project, people, flags, reason`.

### 2. Category + Group — `category_prompt.txt` (LLM)
Sees the day's lines in order (with `project` and the time gaps) and assigns each line
BOTH a category and a group.
- **Category:** one of `task | event | note | remember`. Key rules: a date does NOT force
  `event` — date + an action the user performs → `task`; date + a pure occurrence (nothing
  to do) → `event`. Brainstorm-chain (cohesive note group) members lean `note` even when
  phrased imperatively; isolated one-offs lean `task`.
- **Group:** `g1, g2, …`, a standalone line → `individual`. A group is one of two things:
  (a) a **thinking-chain of notes** — consecutive notes on one train of thought; or
  (b) a **task plus the notes that support completing it** — those supporting notes take
  the **same group id as the task**. So a group holds at most one task (the thing to do)
  alongside the notes that feed it; pure note-chains carry no task.
- **Due date:** for `task` rows (its due date) AND `event` rows (the date the event
  occurs), the prompt emits a `due_date` (strict `YYYY-MM-DD`); notes/remembers and
  dateless tasks/events get `""`. Relative dates ("tmr", a weekday) are resolved against a
  `{now}` placeholder injected into the prompt at call time (currently the note's own date
  at `T23:59:00`, not wall-clock `datetime.now()`); an absolute future year in an event
  ("april 13th 2029") is used verbatim, not clamped to now's year. An event with no
  extractable date falls back (in `upsert_event`) to the note's logging date.
- **Due time:** the call also emits `due_time` (`HH:MM`, 24h) for a dated `task` OR `event`
  whose content names a clock time ("7.30 am" → `07:30`, "1 pm" → `13:00`); `upsert_task` /
  `upsert_event` splice it onto `due_date` as the Notion date's datetime start (a time
  attaches only to a real extracted date, never to the logging-date fallback). Empty without
  both a date and a time. Dedup keys on the date part only, so adding a time never duplicates.
- **Clean content (short task title):** the same call emits `clean_content` — a SHORT
  imperative action name for the task (core action, a few words; the date, URLs, and verbose
  filler removed). Emitted for EVERY `task` row (dated or not); every non-task row emits `""`
  (the pipeline then keeps `content`). It is the Notion Tasks title in place of `content`.
- **Task context (page detail):** the call also emits `task_context` — the genuine reference
  detail `clean_content` dropped (a URL, id, or specific reference), `task` rows only, `""`
  when the line is self-contained (most tasks). It is written into the Notion task's page
  body (as a bullet), together with the task's folded supporting notes (see Routing). The raw
  `content` is still what the LLM reasons over and what the CSV/gold keep. Events are never
  cleaned (their content is kept verbatim as the Notion Name), but they DO get a
  `due_date`/`due_time` (the occurrence date/time), routed to the Events DB Date property.
- No embedding/clustering step — grouping is the category LLM's job (see Design Choices
  for why `embed_cluster.py` was retired).

### 3. Output — `datasets/YYYY-MM-DD.csv`
One row per line. Columns: `datetime, content, gap_before_min, inferred_activity,
project, people, flags, reason, category, group, due_date, due_time, clean_content,
task_context`.
(`people`/`flags` are JSON-encoded lists; `due_date` is `YYYY-MM-DD` for a dated task (its
due date) or event (its occurrence date), else empty; `due_time` is `HH:MM` (24h) for a
dated task/event that also names a clock time, else empty — combined with `due_date` it
becomes the Notion date's datetime start `YYYY-MM-DDTHH:MM:00`; `clean_content` is the short
task title — non-empty for EVERY task, used as the Notion Tasks title in place of `content`;
`task_context` is the task's page detail (a URL/id/reference) — non-empty only when the task
line carries one, written into the Notion task page body. Events are never cleaned (`content`
is kept verbatim as the Name), but they DO carry `due_date`/`due_time` (the occurrence
date/time) routed to the Events DB Date property.)

### 4. Profiles — `noter/profiles.py` (live loop) / `write_profiles.py` (batch backfill)
For every `category == remember` row whose `people` is non-empty, append the entry to
`datasets/profiles/<name>.md` (one file per person, deduped). Project-associated people
are registered in `datasets/profiles.csv` (`name`, `project` as a JSON list, `profile`
filename); people unrelated to any project stay as `.md` files only, not in the CSV.
Each `.md` file also carries an `aliases:` header line (below the `# name` title, after
any `project:` line) so the same person can be recognized under different raw name
spellings across entries (e.g. `tap` vs `แท็ป`) — populated by hand, no auto-merge.

## Implementation (built — the `noter/` package)

The pipeline above is now **implemented and running**, and extended: the per-day CSV no
longer just feeds "a dashboard" — each row is **routed to a destination** (Notion databases,
the Obsidian vault, or local person profiles), gated by a confidence check with a learning loop.

### Package layout (`noter/`)
| Module | Role |
|---|---|
| `config.py` | vault path, project→folder + project→Notion-relation maps, model, secrets, confidence knob, Notion ids |
| `fetch.py` | read `Noter/dailies/<date>.md` → entries; compute `gap_before_min` deterministically |
| `classify.py` | the 2 Claude calls (project → category); merge to the CSV schema (incl. `due_time`, `clean_content`, `task_context`); `backend='agent'` + offline CSV loader |
| `feedback.py` | few-shot injection + person→project / content→label overrides + confidence scoring + gold/corrections IO |
| `route.py` | dispatch one row to its destination (Notion/vault/local profiles) by category |
| `profiles.py` | local per-person profiles: `datasets/profiles.csv` registry + `datasets/profiles/<name>.md` facts (aliases header, dedup); shared by `route.py` and the standalone `write_profiles.py` |
| `review_cli.py` | **interactive local review**: walk LOW rows (from `all.csv`) in batches of 10, edit any column inline, then file + append gold/corrections |
| `review.py` / `commit.py` | **retired (Notion review path)** — legacy Notion "Noter Review" staging + morning commit; superseded by `review_cli.py`, no longer wired into `run_daily` |
| `notion.py` | Notion REST (token) client: relation map, create/query DBs, upsert, append bullets |
| `sync_reminders.py` | best-effort, local-only: push open Notion Shopping List items into a macOS Reminders.app list (one-way; AppleScript can't set the location trigger itself, see Status/outstanding) |
| `run_daily.py` | orchestrator: fetch → classify → overrides → confidence split → auto-file HIGH+tasks / leave LOW in `all.csv` for review |
| `agent_prep.py` | write the agent-classifier handoff file (for API-free runs) |

Run: `python -m noter.run_daily --date today` (flags: `--dry-run`, `--from-csv <path>`,
`--classifier {api,agent}`); review LOW rows with `python -m noter.review_cli`
(flags: `--date <YYYY-MM-DD>`, `--batch N`, `--dry-run`).

### Routing (per category)
| category | destination |
|---|---|
| `task`, buy/pick up/purchase/ซื้อ… | **Notion Shopping List DB** (existing, manually created): `Name`←`clean_content` or content, `Checkbox`=off; upsert by title only. A leading unambiguous buy-verb (`route._is_shopping_item`; "get" excluded — too generic) reroutes the row here **instead of** Tasks — exclusive, not both |
| `task`, otherwise | **Notion Tasks DB** (existing): `Task`←`clean_content` (short title) or content, `Due Date`←`due_date`(+`due_time`), `relation`←project (**`other`→the `/todo` page**), `Done`=off; upsert by title+due(date part). **Page body** = `task_context` (its URL/ref) + the task's same-group **supporting notes**, folded in as bullets (those notes are not routed separately); on a dup only missing bullets are appended |
| `event` | **Notion Events DB** (new): `Name`←content, `Date`←`due_date`(+`due_time`) i.e. the occurrence date (falls back to the note's logging date only if no date was extractable), `Project`←relation; upsert by name+date(date part) |
| `remember` + person | **local**: `datasets/profiles/<name>.md` (facts as `YYYY-MM-DD: …` bullets, `aliases:` header) + `datasets/profiles.csv` registry when the row's project isn't `other` |
| `remember`, no person | vault `Remember.md` |
| `note` + project | vault `<project>/Notes.md` (a new `[[tag]]` project → its own folder) |
| `note` + `other`/none | vault `ideas.md` |

`project` in Notion is a **relation to the existing Projects DB — never auto-created**.
Labels with no Notion project (`mom's herbal tea`, `garden`, `other`, new tags) get an
**empty relation**. Vault writes use an iCloud-safe retry writer and dedupe by content.

### Confidence gate + feedback loop
After classify+overrides each row is scored: **HIGH → auto-files** now; **LOW → stays in
`datasets/all.csv` as the pending-review queue**. **Exception: `task` rows always auto-file**
to the Tasks DB regardless of confidence — a to-do should never get stuck in review (but a
force-filed low-confidence task is *not* appended to `gold.csv`, since it bypassed review).
HIGH requires no flags, a non-`other` project backed by a tag / override / gold precedent,
and not the ideas bucket (`NOTER_STRICT_CONFIDENCE` knob; loosen as it learns).

Review the LOW rows locally with **`python -m noter.review_cli`**: it recomputes the pending
set (low-confidence, non-`task` rows in `all.csv` not yet in `gold.csv`, and not folded into a
task's group — those ride the task's Notion page), shows them 10 at a
time, and per row lets you edit any column inline (`blank`=accept, `skip`=defer, `quit`=stop).
On approve it routes the row to its real destination (`route.route_row`, same as the old
`commit.py`), appends it to **`datasets/gold.csv`**, and — when you changed a label — appends
the proposed-vs-final diff to **`datasets/corrections.csv`**. (The Notion "Noter Review" DB +
`commit.py` round-trip is retired.) Next run, `feedback.py` turns those into
(a) **few-shot examples** appended to the prompts at call time, and (b) **deterministic
overrides** (person→project, content→label) applied before scoring — so corrected patterns
auto-file next time. Prompt files on disk are never edited.

### Agent-classifier mode (no API credits)
`--classifier agent` reads a Claude Code subagent's classification from
`datasets/<date>.agent.json` instead of calling the paid API (write the handoff with
`agent_prep`). Used to run days on Claude Code quota when the API is out of credits.
Not usable by the unattended cron (plain Python can't spawn a subagent).

### Notion databases (created under the Dashboard `37226f5d5d608018b9eaf0a4dad1f358`)
Events `d98a6a4bc8f4498aa26088c4ccc8190d`,
Noter Review `4a2938d187af4ab18097926fbb23d41c` (ids cached in `noter/notion_ids.json`).
Existing: Tasks `37326f5d5d608038b826c84e148a15a7`, Projects `37326f5d5d6080b09688e91833d099d8`,
Shopping List `3bd26f5d5d6080d3aeebda5ea71bcdd4` (user-created, minimal schema: `Name` title +
`Checkbox` bought/not; grocery/errand `task` rows route here instead of Tasks, see Routing).
(A Notion Profiles DB `caba30c76c364b6487d8138a58846045` was created earlier but is no
longer written by the pipeline — `remember`+person now routes to the local
`datasets/profiles.csv`/`profiles/*.md` files instead, see Routing.)

### Scheduling (`deploy/`)
Two macOS launchd paths (both local, to reach the iCloud vault):
- **A** — API path: `com.noter.stage` (nightly classify+stage). Needs Anthropic credits.
- **B** — no-credits path: `com.noter.nightly-agent` (headless `claude -p` classifies via agent). ⚠️ runs with `--permission-mode bypassPermissions`; uses Claude Code quota; opt in deliberately. Don't load both nightly jobs.

The morning **`com.noter.commit`** job is now **unused**: review is the interactive
`review_cli.py` (needs a human, so it isn't scheduled). Run it whenever you want to clear the
pending queue. (Both nightly jobs currently fail under launchd with `Operation not permitted`
until `/bin/bash` is granted Full Disk Access — the project lives in the TCC-protected
`~/Documents`.)

### Config / secrets
`.env` (git-ignored) holds `ANTHROPIC_API_KEY` + `NOTION_TOKEN` + optionally `NOTER_VAULT`. The
brain-dump editor (`editor/server.js` + `editor/editor.html`, launchd job `com.noter.editor`) on
`localhost:3000` lives in this repo but still saves to the vault — it reads `NOTER_VAULT` from
`.env` (same var/default as `noter/config.py`) and writes `<vault>/Noter/dailies/<date>.md`,
which the pipeline only reads. Scope is **forward-only** (no backfill).

### Status / outstanding
- **Run so far:** 2026-06-28 (agent-classified; 14 rows in Noter Review + 2 notes in vault);
  2026-07-17 (`[[scout]]` note → new `scout/Notes.md`). `gold.csv` seeded (3 rows).
- **Notion API: connected & verified (2026-07-22).** The `noter` integration authenticates
  as a bot and can see + query all 5 DBs (Tasks 123 rows, Projects 8 rows, Events, Profiles,
  Noter Review). REST writes are live; the earlier "shared with nothing" blocker is resolved.
- **Needs the user:** add Anthropic credits (for the API path — the agent path needs none);
  rotate both secrets (pasted in chat).
- Spec-vs-disk inconsistencies are recorded in `datasets/INCONSISTENCIES.md` (incl. this
  file's stale script paths and the missing `normalize_prompt.txt`).
- **Needs the user (one-time, manual):** for a location-based "you're leaving home, here's
  what's on the Shopping List" reminder, AppleScript can't set a location trigger — only
  the Shortcuts app's GUI action picker can. `sync_reminders.py` keeps a macOS Reminders.app
  "Shopping List" list in sync with Notion every `run_daily`; the user still needs to add,
  once, a Personal Automation in Shortcuts (most reliably on the iPhone, since that's the
  device with GPS — Reminders/iCloud syncs the list to it automatically) — trigger "Leave:
  Home", action "Show/Speak the contents of the Reminders list 'Shopping List'" (or just
  enable native Reminders location alerts on that list's items).

## Components
| File | Role |
|---|---|
| `project_prompt.txt` | LLM project classifier (gap-aware project propagation + people) |
| `category_prompt.txt` | LLM category **and group** classifier (task/event/note/remember; group = note-chain or task+its supporting notes) |
| `normalize_prompt.txt` | LLM restricted-vocab rewriter — *listed historically but absent on disk; not used* |
| `scripts/embed_cluster.py` | **retired** — old bge-m3 k-dist grouping; grouping now done by the category prompt |
| `scripts/project_classify.py` | embedding project classifier (nearest-centroid / k-NN baseline) |
| `scripts/project_fill.py` | forward-fill projects from seeds + distance flags |
| `write_profiles.py` | standalone batch backfill: route a CSV's `remember`+person entries into per-person profiles (shares logic with `noter/profiles.py`, which the live loop calls) |
| `datasets/profiles/` | per-person `<name>.md` profiles |
| `datasets/profiles.csv` | registry of project-associated people (`name, project[list], profile`) |

## Notes / open issues
- Projects come in blocky runs (~81% adjacency) — a line's project usually matches a neighbour's; useful as a smoothing prior.
- The `ideas` bucket (`category=='note' & project=='other'`) is a known over-stuffed catch-all that needs finer sorting.

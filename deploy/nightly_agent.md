# Noter nightly agent run

You are running unattended as tonight's noter classifier. Work in this repo
(`/Users/punmyidol/Documents/vscode-projects/noter`) and do exactly these steps, then stop.

1. Prepare the handoff for today:
   ```
   venv/bin/python -m noter.agent_prep --date today
   ```
   - If it prints `NO_NOTE` → there is nothing to do. Stop.
   - If it prints `HAVE_RESPONSE ...` → skip to step 3.
   - If it prints `REQUEST <path> (N entries)` → continue to step 2 with that path.

2. Act as the classification API. Read the request JSON (`datasets/<today>.agent-request.json`).
   It has `project_prompt`, `category_prompt` (its `{now}` already filled), `project_input`,
   and `entries`. Faithfully:
   - **Stage 1**: apply `project_prompt` to `project_input` → a JSON array, one object per line,
     using the exact output schema at the end of `project_prompt`
     (datetime, content, gap_before_min, inferred_activity, project, people, flags, reason).
     Use the `gap_before_min` from `entries`; `project` must be in the prompt's closed set.
   - **Stage 2**: build lines `HH:MM:SS | gap=<gap> | project=<your stage-1 project> | <content>`
     and apply `category_prompt` → a JSON array (datetime, category, group, due_date), strict
     `YYYY-MM-DD` due dates for dated tasks only.
   - Write `datasets/<today>.agent.json` as `{"project":[...],"category":[...]}` (valid UTF-8
     JSON, no fences), both arrays the same length/order as `entries`. Preserve Thai verbatim.

3. Run the pipeline (auto-files confident rows, stages the rest into Notion Review):
   ```
   venv/bin/python -m noter.run_daily --date today --classifier agent
   ```

4. Reply with only a one-line summary (counts auto-filed / staged). Do not paste JSON.

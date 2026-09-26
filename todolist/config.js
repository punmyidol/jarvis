// Zero-dependency config: reads secrets/paths from the repo's ../.env,
// same pattern as editor/server.js's readVaultFromEnv().

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, '..', '.env');

function readEnvVar(name, fallback) {
  if (process.env[name]) return process.env[name];
  try {
    const text = fs.readFileSync(ENV_PATH, 'utf8');
    const re = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'm');
    const m = text.match(re);
    if (m) return m[1];
  } catch {}
  return fallback;
}

const NOTION_TOKEN = readEnvVar('NOTION_TOKEN', '');
const TODOLIST_TOKEN = readEnvVar('TODOLIST_TOKEN', '');
const VAULT = readEnvVar(
  'NOTER_VAULT',
  '/Users/punmyidol/Library/Mobile Documents/iCloud~md~obsidian/Documents/elvis'
);

const PORT = process.env.PORT || 3300;

// Model for spawned `claude -p` runs. Defaults to sonnet - these runs are
// mostly a mechanical --chrome browser-automation tool loop (dozens of
// iterations per task), not reasoning-heavy work, so they don't need
// opus-tier capability but were silently paying opus-tier price (no
// --model flag meant the CLI default was inherited). Overridable per-run
// from the UI (see /api/config), but this is the fallback/default.
const MODEL_DEFAULT = readEnvVar('TODOLIST_MODEL', 'claude-sonnet-5');
const MODEL_OPTIONS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];

// Notion ids/property names, copied from noter/config.py (kept in sync by hand
// since this is a separate small app, not a shared module across languages).
const NOTION_VERSION = '2022-06-28';
const TASKS_DATABASE_ID = '37326f5d5d608038b826c84e148a15a7';
const TASK_TITLE_PROP = 'Task';
const TASK_DUE_PROP = 'Due Date';
const TASK_RELATION_PROP = 'relation';
const TASK_DONE_PROP = 'Done';

// Day-view additions (Events + Shopping List), same "copied from noter/config.py /
// notion_ids.json, kept in sync by hand" reasoning as the Tasks constants above.
const EVENTS_DATABASE_ID = 'd98a6a4bc8f4498aa26088c4ccc8190d';
const EVENT_TITLE_PROP = 'Name';
const EVENT_DATE_PROP = 'Date';
const EVENT_RELATION_PROP = 'Project';

const SHOPPING_DATABASE_ID = '3bd26f5d5d6080d3aeebda5ea71bcdd4';
const SHOPPING_TITLE_PROP = 'Name';
const SHOPPING_CHECK_PROP = 'Checkbox';

// Not a database - a regular Notion page with hand-edited "WEEKLY CLASSES" /
// "ONE-OFF CLASS EVENTS" tables + "TERM RULES" text, parsed by
// notion.getClassesForDate(). Times on that page are Ann Arbor local
// (America/Detroit) with no UTC offset written down.
const CLASS_SCHEDULE_PAGE_ID = '3bd26f5d5d60814a9b99ecd540794f9f';
const CLASS_SCHEDULE_TZ = 'America/Detroit';

// Notion Projects-DB page id -> classifier project label, copied from
// noter/config.py's PROJECT_NOTION_PAGE (inverted), for display only.
const PROJECT_LABEL_BY_PAGE = {
  '37326f5d5d6080d5852ccc104e5c543b': 'helmet detection',
  '37826f5d5d6080f7b6bae1df3972c3b3': 'elvis',
  '37326f5d5d6080569016f3bef9a683ad': 'land deed tracker',
  '38726f5d5d608017a182ce8a9984d1f5': 'umich',
  '38d26f5d5d608075ad98c42ad06ffd30': 'noter',
  '37526f5d5d608085a006e7af18a92f68': 'other (/todo)',
};

module.exports = {
  ROOT,
  NOTION_TOKEN,
  TODOLIST_TOKEN,
  VAULT,
  PORT,
  MODEL_DEFAULT,
  MODEL_OPTIONS,
  NOTION_VERSION,
  TASKS_DATABASE_ID,
  TASK_TITLE_PROP,
  TASK_DUE_PROP,
  TASK_RELATION_PROP,
  TASK_DONE_PROP,
  EVENTS_DATABASE_ID,
  EVENT_TITLE_PROP,
  EVENT_DATE_PROP,
  EVENT_RELATION_PROP,
  SHOPPING_DATABASE_ID,
  SHOPPING_TITLE_PROP,
  SHOPPING_CHECK_PROP,
  CLASS_SCHEDULE_PAGE_ID,
  CLASS_SCHEDULE_TZ,
  PROJECT_LABEL_BY_PAGE,
};

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
const VAULT = readEnvVar(
  'NOTER_VAULT',
  '/Users/punmyidol/Library/Mobile Documents/iCloud~md~obsidian/Documents/elvis'
);

const PORT = process.env.PORT || 3300;

// Notion ids/property names, copied from noter/config.py (kept in sync by hand
// since this is a separate small app, not a shared module across languages).
const NOTION_VERSION = '2022-06-28';
const TASKS_DATABASE_ID = '37326f5d5d608038b826c84e148a15a7';
const TASK_TITLE_PROP = 'Task';
const TASK_DUE_PROP = 'Due Date';
const TASK_RELATION_PROP = 'relation';
const TASK_DONE_PROP = 'Done';

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
  VAULT,
  PORT,
  NOTION_VERSION,
  TASKS_DATABASE_ID,
  TASK_TITLE_PROP,
  TASK_DUE_PROP,
  TASK_RELATION_PROP,
  TASK_DONE_PROP,
  PROJECT_LABEL_BY_PAGE,
};

// Tiny Notion REST helper - just the calls this app needs: list open tasks,
// pull a task page's body notes, and mark a task done. Mirrors the request
// shapes already proven in noter/notion.py (query/paginate, mark-checkbox
// PATCH), but reimplemented here in zero-dependency JS using global fetch.

const config = require('./config');

const API = 'https://api.notion.com/v1';

function headers() {
  return {
    Authorization: `Bearer ${config.NOTION_TOKEN}`,
    'Notion-Version': config.NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

function dashify(pageId) {
  const s = pageId.replace(/-/g, '');
  if (s.length !== 32) return pageId;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

async function req(method, path, body, attempt = 0) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  console.log(`[notion] ${method} ${path} -> ${r.status}`);
  if (r.status === 429 && attempt < 3) {
    const retryAfter = Number(r.headers.get('Retry-After')) || 1;
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    return req(method, path, body, attempt + 1);
  }
  if (!r.ok) {
    const err = new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 400)}`);
    if (r.status === 429) err.rateLimited = true;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

function plainText(richTextArr) {
  return (richTextArr || []).map(t => t.plain_text).join('');
}

// Generic paginated `/databases/{id}/query` — factored out so the day-view
// queries below (Tasks/Events/Shopping, each with their own filter) don't
// each reimplement the has_more/next_cursor loop.
async function queryDatabase(databaseId, filter) {
  const results = [];
  let cursor;
  do {
    const body = { filter };
    if (cursor) body.start_cursor = cursor;
    const data = await req('POST', `/databases/${dashify(databaseId)}/query`, body);
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

async function queryOpenTasks() {
  const results = await queryDatabase(config.TASKS_DATABASE_ID, {
    property: config.TASK_DONE_PROP,
    checkbox: { equals: false },
  });
  // Belt-and-suspenders: Notion's server-side filter has been observed to
  // return pages whose own embedded Done property is actually true (a stale
  // index on their end, not a filter we built wrong). We already have each
  // page's real property value in hand, so re-check it here rather than
  // trusting the filter alone.
  return results.filter(page => page.properties[config.TASK_DONE_PROP]?.checkbox !== true);
}

// --- Day view (top-left "Day" column): Tasks/Events due on a given date,
// plus the always-open Shopping List. ---

// Computes the UTC instant for local-midnight -> next-local-midnight of
// `dateStr`, in whichever timezone the caller is actually in (`tzOffsetMin`,
// following JS's own `Date.prototype.getTimezoneOffset()` convention:
// UTC = local + tzOffsetMin). This is what makes "today"/"tomorrow" correct
// for whoever's viewing the page, rather than hardcoding one timezone.
function dayBoundsUTC(dateStr, tzOffsetMin) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const startMs = Date.UTC(y, m - 1, d, 0, 0, 0) + tzOffsetMin * 60000;
  return {
    startISO: new Date(startMs).toISOString(),
    endISO: new Date(startMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}

// `on_or_after`/`before` (not `equals`) so a datetime-valued property (not
// just a bare date) is correctly bucketed onto the one calendar day it falls
// on in the viewer's timezone - Notion's `equals` filter does not do this
// for datetime values.
function dayRangeFilter(prop, dateStr, tzOffsetMin) {
  const { startISO, endISO } = dayBoundsUTC(dateStr, tzOffsetMin);
  return {
    and: [
      { property: prop, date: { on_or_after: startISO } },
      { property: prop, date: { before: endISO } },
    ],
  };
}

async function queryTasksForDate(dateStr, tzOffsetMin) {
  const filter = {
    and: [
      { property: config.TASK_DONE_PROP, checkbox: { equals: false } },
      ...dayRangeFilter(config.TASK_DUE_PROP, dateStr, tzOffsetMin).and,
    ],
  };
  return queryDatabase(config.TASKS_DATABASE_ID, filter);
}

async function queryEventsForDate(dateStr, tzOffsetMin) {
  const filter = dayRangeFilter(config.EVENT_DATE_PROP, dateStr, tzOffsetMin);
  return queryDatabase(config.EVENTS_DATABASE_ID, filter);
}

async function queryOpenShoppingItems() {
  return queryDatabase(config.SHOPPING_DATABASE_ID, {
    property: config.SHOPPING_CHECK_PROP,
    checkbox: { equals: false },
  });
}

const DEFAULT_TASK_BLOCK_MIN = 30;
const DEFAULT_EVENT_BLOCK_MIN = 60;

// Flattens a Tasks/Events page into the shape the day-view UI renders.
// `hasTime` reflects whether the date value carries a time-of-day (Notion
// dates with no time look like "2026-09-23", ones with a time carry a "T").
function toDayEntry(page, { titleProp, dateProp, relationProp, kind, defaultMin }) {
  const title = plainText(page.properties[titleProp]?.title) || '(untitled)';
  const dateVal = page.properties[dateProp]?.date;
  const start = dateVal?.start || null;
  const hasTime = Boolean(start && start.includes('T'));
  let end = dateVal?.end || null;
  if (!end && start && hasTime) {
    end = new Date(new Date(start).getTime() + defaultMin * 60000).toISOString();
  }
  return {
    id: page.id,
    kind,
    title,
    start,
    end,
    hasTime,
    project: relationProp ? projectLabelFor(page, relationProp) : '',
    url: page.url,
  };
}

// --- Classes, parsed from the "Fall 2026 Class Schedule" page (not a
// database) - see config.CLASS_SCHEDULE_PAGE_ID. That page's WEEKLY CLASSES
// / ONE-OFF CLASS EVENTS tables and TERM RULES text are hand-edited, so
// parsing is defensive: any row/date that doesn't match the expected shape
// is just skipped rather than throwing, and getDayView (below) never lets a
// parse failure here break the rest of the day view.

async function listBlockChildren(blockId) {
  const results = [];
  let cursor;
  do {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const data = await req('GET', `/blocks/${dashify(blockId)}/children${qs}`);
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

function headingText(block) {
  if (!block.type.startsWith('heading_')) return null;
  return plainText(block[block.type]?.rich_text).trim();
}

function blockPlainText(block) {
  const rich = block[block.type] && block[block.type].rich_text;
  return rich ? plainText(rich) : '';
}

async function tableRowsAsGrid(tableBlockId) {
  const rows = await listBlockChildren(tableBlockId);
  return rows
    .filter(r => r.type === 'table_row')
    .map(r => (r.table_row.cells || []).map(cell => plainText(cell)));
}

// "9:00 AM" / "3:30 PM" -> "09:00" / "15:30". Returns null on anything that
// doesn't match, so a malformed row is skipped rather than crashing parsing.
function parseClockTo24h(s) {
  const m = (s || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let [, h, mi, ap] = m;
  h = Number(h);
  if (/pm/i.test(ap) && h !== 12) h += 12;
  if (/am/i.test(ap) && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${mi}`;
}

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DATE_RE = /\d{4}-\d{2}-\d{2}/g;

let classScheduleCache = null; // { data, fetchedAt }
const CLASS_SCHEDULE_TTL_MS = 30 * 60 * 1000; // page is hand-edited, rarely - no need to refetch every request

async function fetchClassSchedule() {
  const now = Date.now();
  if (classScheduleCache && now - classScheduleCache.fetchedAt < CLASS_SCHEDULE_TTL_MS) {
    return classScheduleCache.data;
  }

  const blocks = await listBlockChildren(config.CLASS_SCHEDULE_PAGE_ID);

  let section = ''; // '' (not null) so .startsWith below is always safe, even before the first heading
  const termRuleLines = [];
  const tableIdBySection = {};
  for (const block of blocks) {
    const h = headingText(block);
    if (h) {
      section = h;
      continue;
    }
    // Substring match, not exact equality - a heading can carry a trailing
    // parenthetical ("ONE-OFF CLASS EVENTS (specific dates)") that a strict
    // `===` would miss.
    if (section.startsWith('TERM RULES')) {
      const t = blockPlainText(block);
      if (t) termRuleLines.push(t);
    } else if (section.startsWith('WEEKLY CLASSES') && block.type === 'table' && !tableIdBySection.weekly) {
      tableIdBySection.weekly = block.id;
    } else if (section.startsWith('ONE-OFF CLASS EVENTS') && block.type === 'table' && !tableIdBySection.oneOff) {
      tableIdBySection.oneOff = block.id;
    }
  }

  const termLine = termRuleLines.find(l => /term/i.test(l) && /classes run/i.test(l)) || '';
  const termDates = termLine.match(DATE_RE) || [];
  const termStart = termDates[0] || null;
  const termEnd = termDates[1] || null;
  const noClassLine = termRuleLines.find(l => /no-class days/i.test(l)) || '';
  const noClassDays = new Set(noClassLine.match(DATE_RE) || []);

  const weekly = [];
  if (tableIdBySection.weekly) {
    const grid = await tableRowsAsGrid(tableIdBySection.weekly);
    for (const row of grid.slice(1)) { // row 0 is the header
      const [day, start, end, title, where] = row;
      const startHM = parseClockTo24h(start);
      const endHM = parseClockTo24h(end);
      if (!day || !startHM || !endHM || !title) continue;
      weekly.push({ day: day.trim(), start: startHM, end: endHM, title: title.trim(), where: (where || '').trim() });
    }
  }

  const oneOff = [];
  if (tableIdBySection.oneOff) {
    const grid = await tableRowsAsGrid(tableIdBySection.oneOff);
    for (const row of grid.slice(1)) {
      const [date, start, end, title] = row;
      const startHM = parseClockTo24h(start);
      const endHM = parseClockTo24h(end);
      if (!date || !startHM || !endHM || !title) continue;
      oneOff.push({ date: date.trim(), start: startHM, end: endHM, title: title.trim() });
    }
  }

  const data = { weekly, oneOff, termStart, termEnd, noClassDays };
  classScheduleCache = { data, fetchedAt: now };
  return data;
}

// Converts an Ann Arbor (America/Detroit) wall-clock time on `dateStr` into
// the real UTC instant it corresponds to, DST-aware - so the browser's own
// `new Date(iso)` then shows the CORRECT converted local time for whoever's
// actually viewing the page, wherever they are, exactly like the Tasks/
// Events blocks (which carry real timestamps) already behave.
function annArborWallTimeToUTCISO(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mi] = hhmm.split(':').map(Number);
  const guessUTC = Date.UTC(y, m - 1, d, hh, mi, 0);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: config.CLASS_SCHEDULE_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guessUTC)).map(p => [p.type, p.value]));
  const asIfUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(guessUTC + (guessUTC - asIfUTC)).toISOString();
}

async function getClassesForDate(dateStr) {
  const { weekly, oneOff, termStart, termEnd, noClassDays } = await fetchClassSchedule();
  const entries = [];

  const inTerm = (!termStart || dateStr >= termStart) && (!termEnd || dateStr <= termEnd);
  if (inTerm && !noClassDays.has(dateStr)) {
    const dow = DAY_ABBR[new Date(`${dateStr}T00:00:00`).getDay()];
    for (const cls of weekly) {
      if (cls.day !== dow) continue;
      entries.push({
        id: `class-${dateStr}-${cls.day}-${cls.start}-${cls.title}`,
        kind: 'class',
        title: cls.title,
        start: annArborWallTimeToUTCISO(dateStr, cls.start),
        end: annArborWallTimeToUTCISO(dateStr, cls.end),
        hasTime: true,
        sub: cls.where,
      });
    }
  }
  for (const oo of oneOff) {
    if (oo.date !== dateStr) continue;
    entries.push({
      id: `class-oneoff-${dateStr}-${oo.start}-${oo.title}`,
      kind: 'class',
      title: oo.title,
      start: annArborWallTimeToUTCISO(dateStr, oo.start),
      end: annArborWallTimeToUTCISO(dateStr, oo.end),
      hasTime: true,
      sub: '',
    });
  }
  return entries;
}

async function getDayView(dateStr, tzOffsetMin) {
  const [taskPages, eventPages, shoppingPages, classes] = await Promise.all([
    queryTasksForDate(dateStr, tzOffsetMin),
    queryEventsForDate(dateStr, tzOffsetMin),
    queryOpenShoppingItems(),
    // A page-parsing failure (page reshaped, table moved, etc.) must never
    // break the rest of the day view - fall back to no classes and log it.
    getClassesForDate(dateStr).catch(err => {
      console.error('[class-schedule] parse failed:', err.message);
      return [];
    }),
  ]);
  const tasks = taskPages.map(p => toDayEntry(p, {
    titleProp: config.TASK_TITLE_PROP,
    dateProp: config.TASK_DUE_PROP,
    relationProp: config.TASK_RELATION_PROP,
    kind: 'task',
    defaultMin: DEFAULT_TASK_BLOCK_MIN,
  }));
  const events = eventPages.map(p => toDayEntry(p, {
    titleProp: config.EVENT_TITLE_PROP,
    dateProp: config.EVENT_DATE_PROP,
    relationProp: config.EVENT_RELATION_PROP,
    kind: 'event',
    defaultMin: DEFAULT_EVENT_BLOCK_MIN,
  }));
  const shopping = shoppingPages.map(p => ({
    id: p.id,
    kind: 'shopping',
    title: plainText(p.properties[config.SHOPPING_TITLE_PROP]?.title) || '(untitled)',
    url: p.url,
  }));
  return { tasks, events, shopping, classes };
}

async function getPageBlocks(pageId) {
  const notes = [];
  let cursor;
  do {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const data = await req('GET', `/blocks/${dashify(pageId)}/children${qs}`);
    for (const block of data.results) {
      const kind = block.type;
      const rich = block[kind] && block[kind].rich_text;
      if (rich) {
        const text = plainText(rich);
        if (text.trim()) notes.push(text);
      }
    }
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return notes;
}

async function markDone(pageId) {
  await req('PATCH', `/pages/${dashify(pageId)}`, {
    properties: { [config.TASK_DONE_PROP]: { checkbox: true } },
  });
}

async function appendBlocks(blockId, children) {
  for (let i = 0; i < children.length; i += 100) { // Notion caps at 100 children/call
    await req('PATCH', `/blocks/${dashify(blockId)}/children`, {
      children: children.slice(i, i + 100),
    });
  }
}

const RICH_TEXT_LIMIT = 1900; // Notion's hard cap is 2000; leave headroom

async function appendProgressNote(pageId, bullets) {
  const children = bullets
    .filter(b => b && b.trim())
    .map(b => ({
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: [{ type: 'text', text: { content: b.trim().slice(0, RICH_TEXT_LIMIT) } }],
      },
    }));
  if (!children.length) return;
  await appendBlocks(pageId, children);
}

// `prop` defaults to Tasks' own relation prop so every existing call site
// (relationIds(page), projectLabel(page)) keeps working unchanged; the day
// view passes Events' `Project` prop instead via the *For variants below.
function relationIds(page, prop = config.TASK_RELATION_PROP) {
  const rel = page.properties[prop];
  return (rel && rel.relation || []).map(r => r.id);
}

function projectLabel(page, prop = config.TASK_RELATION_PROP) {
  const relPage = relationIds(page, prop)[0];
  if (!relPage) return '';
  return config.PROJECT_LABEL_BY_PAGE[relPage.replace(/-/g, '')] || relPage;
}

// Aliases used by toDayEntry above (Tasks' `relation` and Events' `Project`
// share this one lookup, keyed off whatever prop name is passed in).
const relationIdsFor = relationIds;
const projectLabelFor = projectLabel;

function toTaskSummary(page) {
  const titleProp = page.properties[config.TASK_TITLE_PROP];
  const dueProp = page.properties[config.TASK_DUE_PROP];
  return {
    id: page.id,
    title: plainText(titleProp && titleProp.title) || '(untitled)',
    due_date: (dueProp && dueProp.date && dueProp.date.start) || null,
    project: projectLabel(page),
    relationIds: relationIds(page),
    url: page.url,
  };
}

// Used only for a subagent-initiated task (see server.js's `create-task`
// fenced-block convention) - `relationIds` is always the PARENT task's own
// relation, snapshotted server-side at session start, never something the
// model supplies itself. Title-only creation is fine; relation empty is fine
// too (mirrors whatever the parent task itself had, even if that's nothing).
async function createTask({ title, relationIds, dueDate }) {
  const properties = {
    [config.TASK_TITLE_PROP]: { title: [{ text: { content: title } }] },
    [config.TASK_RELATION_PROP]: { relation: (relationIds || []).map(id => ({ id })) },
  };
  if (dueDate) properties[config.TASK_DUE_PROP] = { date: { start: dueDate } };
  const page = await req('POST', '/pages', {
    parent: { database_id: dashify(config.TASKS_DATABASE_ID) },
    properties,
  });
  return toTaskSummary(page);
}

module.exports = {
  dashify,
  queryOpenTasks,
  getPageBlocks,
  markDone,
  appendBlocks,
  appendProgressNote,
  createTask,
  toTaskSummary,
  getDayView,
};

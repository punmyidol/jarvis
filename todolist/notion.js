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

async function queryOpenTasks() {
  const results = [];
  let cursor;
  do {
    const body = {
      filter: { property: config.TASK_DONE_PROP, checkbox: { equals: false } },
    };
    if (cursor) body.start_cursor = cursor;
    const data = await req('POST', `/databases/${dashify(config.TASKS_DATABASE_ID)}/query`, body);
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  // Belt-and-suspenders: Notion's server-side filter has been observed to
  // return pages whose own embedded Done property is actually true (a stale
  // index on their end, not a filter we built wrong). We already have each
  // page's real property value in hand, so re-check it here rather than
  // trusting the filter alone.
  return results.filter(page => page.properties[config.TASK_DONE_PROP]?.checkbox !== true);
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

function projectLabel(page) {
  const rel = page.properties[config.TASK_RELATION_PROP];
  const relPage = rel && rel.relation && rel.relation[0];
  if (!relPage) return '';
  return config.PROJECT_LABEL_BY_PAGE[relPage.id.replace(/-/g, '')] || relPage.id;
}

function toTaskSummary(page) {
  const titleProp = page.properties[config.TASK_TITLE_PROP];
  const dueProp = page.properties[config.TASK_DUE_PROP];
  return {
    id: page.id,
    title: plainText(titleProp && titleProp.title) || '(untitled)',
    due_date: (dueProp && dueProp.date && dueProp.date.start) || null,
    project: projectLabel(page),
    url: page.url,
  };
}

module.exports = {
  dashify,
  queryOpenTasks,
  getPageBlocks,
  markDone,
  appendBlocks,
  appendProgressNote,
  toTaskSummary,
};

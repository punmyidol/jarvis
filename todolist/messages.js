// iMessage / SMS for todolist task agents. Reads ~/Library/Messages/chat.db
// read-only (sqlite.js); never sends anything itself - `send` only QUEUES a
// request on the todolist server, which shows it to the user and performs the
// send only after they click Send (see server.js text-request/text-approve).
//
// CLI:
//   node todolist/messages.js recent [--days 2] [--limit 50]
//   node todolist/messages.js chat <who> [--limit 40]
//   node todolist/messages.js search <text> [--days 30] [--limit 30]
//   node todolist/messages.js send <who> [--file <path>]... [text...]
// <who> is a name/nickname/relation (people.js) or a raw phone/email.
// Needs Full Disk Access for whatever app launched the todolist server.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const sqlite = require('./sqlite');
const people = require('./people');

// TODOLIST_CHAT_DB: point at a fixture copy for testing.
const CHAT_DB = process.env.TODOLIST_CHAT_DB || path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const APPLE_EPOCH_S = 978307200; // 2001-01-01T00:00:00Z
const FDA_HINT = 'Messages database not readable: give Full Disk Access (System Settings > Privacy & Security) ' +
  'to the app that launches the todolist server (Terminal / iTerm / VS Code), then restart it.';

// message.date is nanoseconds since 2001 on modern macOS, seconds on old rows.
function toDate(d) {
  const n = Number(d);
  return new Date(((n > 1e12 ? n / 1e9 : n) + APPLE_EPOCH_S) * 1000);
}

function appleNsAgo(days) {
  const s = Math.floor(Date.now() / 1000) - APPLE_EPOCH_S - days * 86400;
  return (BigInt(s) * 1000000000n).toString();
}

function fmt(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Recent macOS leaves message.text NULL and keeps the body only in
// attributedBody, an NSArchiver "typedstream". The string sits right after the
// NSString class marker: 5 header bytes, then a length (one byte, or 0x81 + 2
// bytes LE, or 0x82 + 4 bytes LE), then UTF-8.
function decodeAttributedBody(hex) {
  if (!hex) return '';
  const buf = Buffer.from(hex, 'hex');
  const at = buf.indexOf('NSString');
  if (at < 0) return '';
  let i = at + 'NSString'.length + 5;
  let len = buf[i];
  if (len === 0x81) { len = buf.readUInt16LE(i + 1); i += 3; }
  else if (len === 0x82) { len = buf.readUInt32LE(i + 1); i += 5; }
  else i += 1;
  return buf.slice(i, i + len).toString('utf8');
}

const MESSAGE_COLS = `
  m.ROWID AS id, m.date AS date, m.is_from_me AS fromMe, m.text AS text,
  hex(m.attributedBody) AS body, m.service AS service, m.cache_has_attachments AS att,
  h.id AS handle, c.display_name AS chatName, c.chat_identifier AS chatId`;
const MESSAGE_FROM = `
  FROM message m
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN chat c ON c.ROWID = cmj.chat_id`;
// associated_message_type != 0 are tapbacks/reactions, not messages.
const REAL_MESSAGE = 'm.associated_message_type = 0';

async function run(sql) {
  try {
    return await sqlite.query(CHAT_DB, sql);
  } catch (e) {
    if (e instanceof sqlite.AccessDenied) { const err = new Error(FDA_HINT); err.fda = true; throw err; }
    throw e;
  }
}

async function printRows(rows) {
  const names = await people.contactIndex();
  const label = h => {
    if (!h) return '?';
    const n = names.get(people.handleKey(h));
    return n ? `${n} (${h})` : h;
  };
  // Oldest first reads like a conversation.
  for (const r of rows.slice().reverse()) {
    const who = r.fromMe ? 'me' : label(r.handle);
    const chat = r.chatName ? `  [${r.chatName}]` : '';
    const text = (r.text || decodeAttributedBody(r.body) || '').replace(/\s+/g, ' ').trim();
    const att = r.att ? '  [+attachment]' : '';
    console.log(`${fmt(toDate(r.date))}  ${who}${chat}  ${text || '(no text)'}${att}`);
  }
  if (!rows.length) console.log('(no messages)');
}

// <who> -> [{id, service, rowid, last}] rows of chat.db's handle table, most
// recently used first. Raw phone/email input is used as-is; a name goes
// through people.resolve and must land on exactly one person.
async function resolveWho(who) {
  const raw = who.includes('@') || /^\+?[\d\s().-]{7,}$/.test(who.trim());
  let wanted;
  let person = null;
  if (raw) {
    wanted = [who.trim()];
  } else {
    const { people: found, contactsError } = await people.resolve(who);
    if (found.length === 0) throw new Error(`No one matches "${who}" in the family notes or Contacts.${contactsError ? ` (${contactsError})` : ''}`);
    if (found.length > 1) {
      throw new Error(`"${who}" matches more than one person - ask the user which one:\n` +
        found.map(p => `  ${p.name}${p.relation ? ` (${p.relation})` : ''}: ${p.handles.join(', ') || 'no handle'}`).join('\n'));
    }
    person = found[0];
    if (!person.handles.length) {
      throw new Error(`Found ${person.name}${person.relation ? ` (${person.relation})` : ''} in ${person.source}, but no phone/email for them. ` +
        `Ask the user for the number${contactsError ? ` (${contactsError})` : ''}.`);
    }
    wanted = person.handles;
  }
  const keys = new Set(wanted.map(people.handleKey).filter(Boolean));
  const all = await run('SELECT h.ROWID AS rowid, h.id AS id, h.service AS service, (SELECT max(date) FROM message WHERE handle_id = h.ROWID) AS last FROM handle h');
  const matches = all.filter(h => keys.has(people.handleKey(h.id))).sort((a, b) => Number(b.last || 0) - Number(a.last || 0));
  return { person, wanted, matches };
}

async function cmdRecent(opts) {
  const rows = await run(`SELECT ${MESSAGE_COLS} ${MESSAGE_FROM}
    WHERE ${REAL_MESSAGE} AND m.date > ${appleNsAgo(opts.days || 2)}
    ORDER BY m.date DESC LIMIT ${Number(opts.limit) || 50}`);
  await printRows(rows);
}

async function cmdChat(who, opts) {
  const { matches, person } = await resolveWho(who);
  if (!matches.length) {
    console.log(`No message history with ${person ? person.name : who}.`);
    return;
  }
  const ids = matches.map(h => sqlite.q(h.id)).join(',');
  // 1:1 chats are keyed by the other person's handle.
  const rows = await run(`SELECT ${MESSAGE_COLS} ${MESSAGE_FROM}
    WHERE ${REAL_MESSAGE} AND c.chat_identifier IN (${ids})
    ORDER BY m.date DESC LIMIT ${Number(opts.limit) || 40}`);
  await printRows(rows);
}

async function cmdSearch(text, opts) {
  const like = sqlite.q(`%${text.replace(/[%_]/g, '')}%`);
  const rows = await run(`SELECT ${MESSAGE_COLS} ${MESSAGE_FROM}
    WHERE ${REAL_MESSAGE} AND m.date > ${appleNsAgo(opts.days || 30)}
      AND (m.text LIKE ${like} OR instr(m.attributedBody, CAST(${sqlite.q(text)} AS BLOB)) > 0)
    ORDER BY m.date DESC LIMIT ${Number(opts.limit) || 30}`);
  await printRows(rows);
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function postJson(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: 'localhost',
      port: process.env.TODOLIST_PORT,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(process.env.TODOLIST_TOKEN ? { 'x-todolist-token': process.env.TODOLIST_TOKEN } : {}),
      },
    }, res => {
      let out = '';
      res.on('data', c => (out += c));
      res.on('end', () => {
        try { resolve({ code: res.statusCode, body: JSON.parse(out) }); } catch { resolve({ code: res.statusCode, body: { error: out } }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

async function cmdSend(who, files, text) {
  const taskId = process.env.TODOLIST_TASK_ID;
  if (!taskId || !process.env.TODOLIST_PORT) {
    throw new Error('send only works inside a todolist session (it queues the message for the user to approve there).');
  }
  if (!text && !files.length) throw new Error('nothing to send - give text and/or --file <path>');

  const fileInfo = files.map(f => {
    const p = path.resolve(f.replace(/^~(?=\/)/, os.homedir()));
    const st = fs.statSync(p);
    if (!st.isFile()) throw new Error(`not a file: ${p}`);
    return { path: p, size: st.size, sha256: sha256File(p) };
  });

  let handle;
  let service = 'iMessage';
  let displayName = who;
  try {
    const { person, wanted, matches } = await resolveWho(who);
    if (person) displayName = person.nickname && person.relation ? `${person.nickname} (${person.relation})` : person.name;
    if (matches.length) {
      // Files go over iMessage when there's an iMessage handle for them at all.
      const pick = (fileInfo.length && matches.find(h => h.service === 'iMessage')) || matches[0];
      handle = pick.id;
      service = /^(SMS|RCS)$/.test(pick.service) ? 'SMS' : 'iMessage';
    } else if (wanted.length === 1) {
      handle = wanted[0].replace(/[\s().-]/g, '');
    } else {
      throw new Error(`${displayName} has several numbers and no message history with any of them - ask the user which one:\n` +
        wanted.map(h => `  ${h}`).join('\n'));
    }
  } catch (e) {
    // No Full Disk Access: a raw handle still works, a name can't be checked against history.
    if (!e.fda) throw e;
    const r = await people.resolve(who).catch(() => ({ people: [] }));
    const only = r.people.length === 1 && r.people[0].handles.length === 1 ? r.people[0].handles[0] : null;
    if (/^\+?[\d\s().-]{7,}$/.test(who.trim()) || who.includes('@')) handle = who.trim().replace(/[\s().-]/g, '');
    else if (only) { handle = only.replace(/[\s().-]/g, ''); displayName = r.people[0].name; }
    else throw e;
  }

  const r = await postJson(`/api/tasks/${encodeURIComponent(taskId)}/text-request`, {
    handle, service, displayName, text: text || '', files: fileInfo,
  });
  if (r.code !== 200 || !r.body.ok) throw new Error(`todolist server refused the request (HTTP ${r.code}): ${r.body.error || ''}`);
  console.log(`Queued for approval in the todolist UI: to ${displayName} <${handle}> via ${service}` +
    `${text ? `, text "${text}"` : ''}${fileInfo.length ? `, ${fileInfo.length} file(s)` : ''}.\n` +
    'Nothing has been sent yet. Tell the user it is waiting for their Send click, and end your turn - ' +
    'you will be told in this conversation whether it was sent or rejected.');
}

function parseArgs(argv) {
  const opts = {};
  const files = [];
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') files.push(argv[++i]);
    else if (a === '--days' || a === '--limit') opts[a.slice(2)] = Number(argv[++i]);
    else pos.push(a);
  }
  return { opts, files, pos };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { opts, files, pos } = parseArgs(rest);
  if (cmd === 'recent') return cmdRecent(opts);
  if (cmd === 'chat' && pos.length) return cmdChat(pos.join(' '), opts);
  if (cmd === 'search' && pos.length) return cmdSearch(pos.join(' '), opts);
  if (cmd === 'send' && pos.length) return cmdSend(pos[0], files, pos.slice(1).join(' '));
  console.error('usage:\n  messages.js recent [--days 2] [--limit 50]\n  messages.js chat <who> [--limit 40]\n' +
    '  messages.js search <text> [--days 30] [--limit 30]\n  messages.js send <who> [--file <path>]... [text...]');
  process.exit(2);
}

module.exports = { CHAT_DB, decodeAttributedBody, toDate };

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

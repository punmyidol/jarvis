// Gmail for todolist task agents, one OAuth account per mailbox (see
// scripts/gmail-auth.js and config.GMAIL_ACCOUNTS). Drafts and reads through
// the Gmail API - one call instead of driving webmail in Chrome. There is NO
// send command on purpose: sending is the user's, from the draft
// (hooks/messages-gate.js also blocks raw calls to the send endpoints).
//
// CLI:
//   node todolist/gmail.js accounts
//   node todolist/gmail.js draft --from <label|address> [--to <addr>]... [--cc <addr>]...
//        [--bcc <addr>]... [--subject <s>] (--body <text> | --body-file <path>)
//        [--thread <threadId>] [--attach <path>]...
//   node todolist/gmail.js search <gmail query> --from <acct> [--limit 10]
//   node todolist/gmail.js read <threadId> --from <acct>
// --thread makes the draft a reply in that thread (In-Reply-To/References set;
// To and Subject default to the thread's last message). --from may be omitted
// when only one account is configured.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD_API = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Above this the raw message goes through the media-upload endpoint instead
// of a JSON body (Gmail caps the JSON request well below its 35 MB limit).
const INLINE_RAW_MAX = 4 * 1024 * 1024;
const READ_BODY_CAP = 8000;

const MIME_TYPES = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.heic': 'image/heic', '.webp': 'image/webp', '.txt': 'text/plain',
  '.md': 'text/markdown', '.csv': 'text/csv', '.html': 'text/html', '.json': 'application/json',
  '.zip': 'application/zip', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function accountsHint() {
  const accounts = Object.entries(config.GMAIL_ACCOUNTS);
  return accounts.length
    ? 'Configured: ' + accounts.map(([label, a]) => `${label} (${a.address})`).join(', ')
    : 'No Gmail accounts configured - the user runs `node todolist/scripts/gmail-auth.js <label>` once per account.';
}

function resolveAccount(from) {
  const accounts = config.GMAIL_ACCOUNTS;
  const entries = Object.entries(accounts);
  if (!from) {
    if (entries.length === 1) return { label: entries[0][0], ...entries[0][1] };
    throw new Error(`--from <account> is required. ${accountsHint()}`);
  }
  const want = from.toLowerCase();
  const hit = entries.find(([label, a]) => label === want || a.address.toLowerCase() === want);
  if (!hit) throw new Error(`Unknown account "${from}". ${accountsHint()}`);
  return { label: hit[0], ...hit[1] };
}

async function accessToken(account) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GCAL_CLIENT_ID,
      client_secret: config.GCAL_CLIENT_SECRET,
      refresh_token: account.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    // Only the error code/description - never echo the request (it holds the secret).
    const hint = data.error === 'invalid_grant'
      ? ` - the sign-in for ${account.address} expired or was revoked; the user re-runs ` +
        `\`node todolist/scripts/gmail-auth.js ${account.label}\``
      : '';
    throw new Error(`token refresh -> ${r.status}: ${data.error || ''} ${data.error_description || ''}${hint}`.trim());
  }
  return data.access_token;
}

async function api(token, method, url, { params, json, body, contentType } = {}) {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  const headers = { Authorization: `Bearer ${token}` };
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (contentType) {
    headers['Content-Type'] = contentType;
  }
  const r = await fetch(`${url}${qs}`, { method, headers, body });
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 400);
    try { msg = JSON.parse(text).error.message || msg; } catch {}
    throw new Error(`${method} ${url.replace(API, '').replace(UPLOAD_API, '')} -> ${r.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

// ---- message building -------------------------------------------------

function encodeHeaderValue(s) {
  // RFC 2047 for anything outside printable ASCII (Thai names, emoji, ...).
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function base64Lines(buf) {
  return buf.toString('base64').replace(/.{1,76}/g, '$&\r\n');
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildMessage({ from, to, cc, bcc, subject, body, inReplyTo, references, attachments }) {
  const headers = [
    `From: ${from}`,
    to.length && `To: ${to.join(', ')}`,
    cc.length && `Cc: ${cc.join(', ')}`,
    bcc.length && `Bcc: ${bcc.join(', ')}`,
    `Subject: ${encodeHeaderValue(subject || '')}`,
    inReplyTo && `In-Reply-To: ${inReplyTo}`,
    references && `References: ${references}`,
    'MIME-Version: 1.0',
  ].filter(Boolean);
  const textPart = [
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(body, 'utf8')),
  ].join('\r\n');

  if (!attachments.length) {
    return Buffer.from([...headers, textPart].join('\r\n'), 'utf8');
  }
  const boundary = `todolist-${crypto.randomBytes(12).toString('hex')}`;
  const parts = [`--${boundary}\r\n${textPart}`];
  for (const file of attachments) {
    const name = path.basename(file);
    const type = MIME_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
    // RFC 2047 in the quoted filename: what Gmail itself writes for non-ASCII names.
    const quoted = encodeHeaderValue(name.replace(/"/g, "'"));
    parts.push([
      `--${boundary}`,
      `Content-Type: ${type}; name="${quoted}"`,
      `Content-Disposition: attachment; filename="${quoted}"`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(fs.readFileSync(file)),
    ].join('\r\n'));
  }
  return Buffer.from(
    [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts, `--${boundary}--`, ''].join('\r\n'),
    'utf8'
  );
}

function header(msg, name) {
  const h = ((msg.payload && msg.payload.headers) || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// The last real (non-draft) message of a thread, for reply headers/defaults.
async function threadReplyContext(token, account, threadId) {
  const thread = await api(token, 'GET', `${API}/threads/${encodeURIComponent(threadId)}`, {
    params: new URLSearchParams([
      ['format', 'metadata'],
      ...['Message-ID', 'References', 'Subject', 'From', 'Reply-To', 'To'].map(h => ['metadataHeaders', h]),
    ]),
  });
  const messages = (thread.messages || []).filter(m => !(m.labelIds || []).includes('DRAFT'));
  const last = messages[messages.length - 1];
  if (!last) throw new Error(`Thread ${threadId} has no messages in ${account.address}.`);
  const messageId = header(last, 'Message-ID');
  const subject = header(last, 'Subject');
  const fromSelf = header(last, 'From').toLowerCase().includes(account.address.toLowerCase());
  return {
    inReplyTo: messageId,
    references: [header(last, 'References'), messageId].filter(Boolean).join(' '),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    // Replying to your own last message goes to whoever it was sent to.
    to: fromSelf ? header(last, 'To') : header(last, 'Reply-To') || header(last, 'From'),
  };
}

// ---- commands ---------------------------------------------------------

async function draft(opts) {
  const account = resolveAccount(opts.from);
  let body = opts.body;
  if (opts.bodyFile) body = fs.readFileSync(opts.bodyFile, 'utf8');
  if (body == null) throw new Error('--body <text> or --body-file <path> is required.');
  for (const file of opts.attach) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Attachment not found: ${file}`);
  }

  const token = await accessToken(account);
  let reply = {};
  if (opts.thread) reply = await threadReplyContext(token, account, opts.thread);
  const to = opts.to.length ? opts.to : reply.to ? [reply.to] : [];
  if (!to.length) throw new Error('--to <address> is required (or --thread to reply in a thread).');

  const raw = buildMessage({
    from: account.address,
    to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: opts.subject != null ? opts.subject : reply.subject || '',
    body,
    inReplyTo: reply.inReplyTo,
    references: reply.references,
    attachments: opts.attach,
  });

  let created;
  if (raw.length <= INLINE_RAW_MAX) {
    created = await api(token, 'POST', `${API}/drafts`, {
      json: { message: { raw: base64url(raw), ...(opts.thread ? { threadId: opts.thread } : {}) } },
    });
  } else {
    const boundary = `todolist-${crypto.randomBytes(12).toString('hex')}`;
    const meta = JSON.stringify({ message: opts.thread ? { threadId: opts.thread } : {} });
    const upload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`),
      raw,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    created = await api(token, 'POST', `${UPLOAD_API}/drafts`, {
      params: { uploadType: 'multipart' },
      body: upload,
      contentType: `multipart/related; boundary=${boundary}`,
    });
  }
  const msg = created.message || {};
  console.log(`Draft saved in ${account.address} (not sent).`);
  console.log(`  draft id: ${created.id}  thread: ${msg.threadId || '-'}`);
  console.log(`  to: ${to.join(', ')}${opts.attach.length ? `  attachments: ${opts.attach.map(f => path.basename(f)).join(', ')}` : ''}`);
  console.log(`  open: https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account.address)}#drafts`);
}

async function search(query, opts) {
  const account = resolveAccount(opts.from);
  const token = await accessToken(account);
  const list = await api(token, 'GET', `${API}/threads`, {
    params: { q: query, maxResults: String(opts.limit || 10) },
  });
  const threads = list.threads || [];
  if (!threads.length) return console.log(`No threads in ${account.address} match: ${query}`);
  for (const t of threads) {
    const thread = await api(token, 'GET', `${API}/threads/${t.id}`, {
      params: new URLSearchParams([
        ['format', 'metadata'],
        ...['Subject', 'From', 'Date'].map(h => ['metadataHeaders', h]),
      ]),
    });
    const msgs = thread.messages || [];
    const first = msgs[0] || {};
    const last = msgs[msgs.length - 1] || {};
    console.log(`${t.id}  [${msgs.length} msg]  ${header(last, 'Date')}`);
    console.log(`  ${header(first, 'Subject') || '(no subject)'}  -  last from ${header(last, 'From')}`);
    console.log(`  ${(last.snippet || t.snippet || '').replace(/\s+/g, ' ').slice(0, 200)}`);
  }
}

function decodePart(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// Plain-text body (falls back to tag-stripped HTML) + attachment names.
function extractBody(payload) {
  let plain = '', html = '';
  const files = [];
  (function walk(p) {
    if (!p) return;
    if (p.filename) files.push(p.filename);
    else if (p.mimeType === 'text/plain' && p.body && p.body.data && !plain) plain = decodePart(p.body.data);
    else if (p.mimeType === 'text/html' && p.body && p.body.data && !html) html = decodePart(p.body.data);
    (p.parts || []).forEach(walk);
  })(payload);
  const text = plain || html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n');
  return { text: text.trim(), files };
}

async function read(threadId, opts) {
  const account = resolveAccount(opts.from);
  const token = await accessToken(account);
  const thread = await api(token, 'GET', `${API}/threads/${encodeURIComponent(threadId)}`, { params: { format: 'full' } });
  for (const m of thread.messages || []) {
    const { text, files } = extractBody(m.payload);
    console.log(`--- ${header(m, 'Date')}${(m.labelIds || []).includes('DRAFT') ? '  [DRAFT]' : ''}`);
    console.log(`From: ${header(m, 'From')}`);
    console.log(`To: ${header(m, 'To')}${header(m, 'Cc') ? `\nCc: ${header(m, 'Cc')}` : ''}`);
    console.log(`Subject: ${header(m, 'Subject')}`);
    if (files.length) console.log(`Attachments: ${files.join(', ')}`);
    console.log('');
    console.log(text.length > READ_BODY_CAP ? `${text.slice(0, READ_BODY_CAP)}\n[... truncated]` : text);
    console.log('');
  }
}

function parseArgs(argv) {
  const opts = { to: [], cc: [], bcc: [], attach: [], positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to' || a === '--cc' || a === '--bcc' || a === '--attach') opts[a.slice(2)].push(argv[++i]);
    else if (a === '--from' || a === '--subject' || a === '--body' || a === '--thread') opts[a.slice(2)] = argv[++i];
    else if (a === '--body-file') opts.bodyFile = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else opts.positional.push(a);
  }
  return opts;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (cmd === 'accounts') return console.log(accountsHint());
  if (cmd === 'draft') return draft(opts);
  if (cmd === 'search' && opts.positional.length) return search(opts.positional.join(' '), opts);
  if (cmd === 'read' && opts.positional.length === 1) return read(opts.positional[0], opts);
  console.error('usage: node gmail.js accounts | draft --from <acct> --to <addr> --subject <s> --body <text> ' +
    '[--thread <id>] [--attach <path>]... | search <query> --from <acct> | read <threadId> --from <acct>');
  process.exit(2);
}

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { buildMessage, extractBody, accountsHint };

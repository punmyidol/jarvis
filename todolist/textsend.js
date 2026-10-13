// The only code path that actually sends an iMessage/SMS - called by the
// server's text-approve route, i.e. only after the user clicked Send on that
// exact request (see server.js). Agents can only queue requests
// (messages.js send); they never reach this module.
//
// Sends through Messages.app via AppleScript. Handle/text/path go in as argv,
// never spliced into the script source, so message content can't change what
// the script does. Afterwards it looks for the sent row in chat.db to confirm.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const sqlite = require('./sqlite');
const { CHAT_DB } = require('./messages');

// Messages' sandbox can silently fail to send a scripted file from arbitrary
// paths; ~/Pictures is one it reliably reads.
const OUTBOX = path.join(os.homedir(), 'Pictures', 'todolist-outbox');
const OUTBOX_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const APPLE_EPOCH_S = 978307200;

const SEND_SCRIPT = `
on run argv
  set theHandle to item 1 of argv
  set theService to item 2 of argv
  set theKind to item 3 of argv
  set thePayload to item 4 of argv
  set theChat to item 5 of argv
  if theKind is "file" then set thePayload to POSIX file thePayload
  tell application "Messages"
    if theChat is not "" then
      send thePayload to chat id theChat
    else
      if theService is "SMS" then
        set svc to 1st account whose service type = SMS
      else
        set svc to 1st account whose service type = iMessage
      end if
      send thePayload to participant theHandle of svc
    end if
  end tell
end run`;

function osascript(args) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', SEND_SCRIPT, ...args], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
  });
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function appleNs(ms) {
  return (BigInt(Math.floor(ms / 1000) - APPLE_EPOCH_S) * 1000000000n).toString();
}

function cleanOutbox() {
  try {
    for (const f of fs.readdirSync(OUTBOX)) {
      const p = path.join(OUTBOX, f);
      if (Date.now() - fs.statSync(p).mtimeMs > OUTBOX_KEEP_MS) fs.rmSync(p, { force: true });
    }
  } catch {}
}

// Existing 1:1 chat for this handle, preferring the same service - the
// fallback target when `participant` can't be resolved (seen on recent macOS
// for handles Messages hasn't cached).
async function chatGuid(handle, service) {
  try {
    const rows = await sqlite.query(CHAT_DB, `SELECT guid, service_name AS svc FROM chat WHERE chat_identifier = ${sqlite.q(handle)}`);
    const same = rows.find(r => (r.svc === 'SMS') === (service === 'SMS'));
    return (same || rows[0] || {}).guid || '';
  } catch {
    return '';
  }
}

async function sendOne(handle, service, kind, payload) {
  try {
    await osascript([handle, service, kind, payload, '']);
  } catch (first) {
    const guid = await chatGuid(handle, service);
    if (!guid) throw first;
    await osascript([handle, service, kind, payload, guid]);
  }
}

// Looks for our sent rows in chat.db. Returns 'sent', 'failed: …', or
// 'unconfirmed' (no row yet, or chat.db not readable).
async function confirm(handle, sinceMs, text, fileCount) {
  const deadline = Date.now() + 20000;
  let rows = [];
  while (Date.now() < deadline) {
    try {
      rows = await sqlite.query(CHAT_DB, `
        SELECT m.text AS text, m.error AS error, m.cache_has_attachments AS att
          FROM message m
          JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
          JOIN chat c ON c.ROWID = cmj.chat_id
         WHERE m.is_from_me = 1 AND c.chat_identifier = ${sqlite.q(handle)} AND m.date >= ${appleNs(sinceMs - 5000)}`);
    } catch {
      return 'unconfirmed (chat.db not readable)';
    }
    const errored = rows.find(r => r.error);
    if (errored) return `failed: Messages reported error ${errored.error}`;
    const textOk = !text || rows.some(r => !r.att);
    const filesOk = rows.filter(r => r.att).length >= fileCount;
    if (textOk && filesOk) return 'sent';
    await new Promise(r => setTimeout(r, 2000));
  }
  return 'unconfirmed (no matching sent message in chat.db after 20s - check Messages)';
}

// req: {handle, service, text, files:[{staged, sha256, name}]}. Resolves to
// the outcome string; throws only when nothing could be sent at all.
async function send(req) {
  for (const f of req.files) {
    if (sha256File(f.staged) !== f.sha256) throw new Error(`${f.name} changed after it was queued - not sending`);
  }
  cleanOutbox();
  fs.mkdirSync(OUTBOX, { recursive: true });
  const started = Date.now();
  if (req.text) await sendOne(req.handle, req.service, 'text', req.text);
  for (const [n, f] of req.files.entries()) {
    const out = path.join(OUTBOX, `${req.id}-${n}-${f.name}`);
    fs.copyFileSync(f.staged, out);
    await sendOne(req.handle, req.service, 'file', out);
  }
  return confirm(req.handle, started, req.text, req.files.length);
}

module.exports = { send, sha256File };

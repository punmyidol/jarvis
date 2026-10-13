// One-time Google Calendar sign-in for the Day column (see gcal.js).
//
// Runs Google's OAuth "loopback" flow for a Desktop-app client: starts a
// throwaway server on 127.0.0.1, opens the consent page, catches the redirect,
// swaps the code for a refresh token, and writes GCAL_REFRESH_TOKEN into
// noter/.env (replacing any old line). The token is never printed.
//
// Needs GCAL_CLIENT_ID + GCAL_CLIENT_SECRET already in noter/.env.
// Run: node todolist/scripts/gcal-auth.js   (then restart the todolist server)

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const config = require('../config');

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

if (!config.GCAL_CLIENT_ID || !config.GCAL_CLIENT_SECRET) {
  console.error('GCAL_CLIENT_ID / GCAL_CLIENT_SECRET missing from noter/.env - add them first.');
  process.exit(1);
}

function saveRefreshToken(token) {
  let text = '';
  try { text = fs.readFileSync(config.ENV_PATH, 'utf8'); } catch {}
  const line = `GCAL_REFRESH_TOKEN=${token}`;
  if (/^\s*GCAL_REFRESH_TOKEN\s*=.*$/m.test(text)) {
    text = text.replace(/^\s*GCAL_REFRESH_TOKEN\s*=.*$/m, line);
  } else {
    text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  }
  fs.writeFileSync(config.ENV_PATH, text);
}

const state = crypto.randomBytes(16).toString('hex');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/') { res.writeHead(404); return res.end(); }
  const finish = (status, msg, code = 0) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(msg);
    console.log(msg);
    server.close();
    process.exitCode = code;
  };
  if (url.searchParams.get('state') !== state) return finish(400, 'State mismatch - run the script again.', 1);
  if (url.searchParams.get('error')) return finish(400, `Google returned: ${url.searchParams.get('error')}`, 1);

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') || '',
      client_id: config.GCAL_CLIENT_ID,
      client_secret: config.GCAL_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return finish(500, `Token exchange failed (${r.status}): ${data.error || ''} ${data.error_description || ''}`, 1);
  if (!data.refresh_token) {
    return finish(500, 'Google sent no refresh token. Remove the app at myaccount.google.com/permissions and run again.', 1);
  }
  saveRefreshToken(data.refresh_token);
  finish(200, 'Saved GCAL_REFRESH_TOKEN to noter/.env. Restart the todolist server to see Google Calendar in the Day column.');
});

let redirectUri;
server.listen(0, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${server.address().port}`;
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: config.GCAL_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline', // -> refresh token
    prompt: 'consent',      // -> always re-issue one, even on a repeat sign-in
    state,
  });
  console.log('Opening Google sign-in in your browser. If it does not open, visit:\n\n' + authUrl + '\n');
  execFile('open', [authUrl], () => {});
});

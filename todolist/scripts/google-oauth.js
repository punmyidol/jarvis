// Google OAuth "loopback" flow for a Desktop-app client, shared by
// gcal-auth.js and gmail-auth.js: starts a throwaway server on 127.0.0.1,
// opens the consent page, catches the redirect and swaps the code for tokens.
// Also the replace-or-append writer for noter/.env. Tokens are never printed.

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const config = require('../config');

function saveEnvVar(name, value) {
  let text = '';
  try { text = fs.readFileSync(config.ENV_PATH, 'utf8'); } catch {}
  const line = `${name}=${value}`;
  const re = new RegExp(`^\\s*${name}\\s*=.*$`, 'm');
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  }
  fs.writeFileSync(config.ENV_PATH, text);
}

// Resolves to Google's token response ({access_token, refresh_token, ...}).
// `loginHint` pre-selects the account on the consent page.
function runConsentFlow({ scope, loginHint }) {
  if (!config.GCAL_CLIENT_ID || !config.GCAL_CLIENT_SECRET) {
    return Promise.reject(new Error('GCAL_CLIENT_ID / GCAL_CLIENT_SECRET missing from noter/.env - add them first.'));
  }
  const state = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    let redirectUri;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') { res.writeHead(404); return res.end(); }
      const finish = (status, msg, err, tokens) => {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(msg);
        server.close();
        if (err) reject(err); else resolve(tokens);
      };
      if (url.searchParams.get('state') !== state) {
        return finish(400, 'State mismatch - run the script again.', new Error('State mismatch - run the script again.'));
      }
      if (url.searchParams.get('error')) {
        const msg = `Google returned: ${url.searchParams.get('error')}`;
        return finish(400, msg, new Error(msg));
      }
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
      if (!r.ok) {
        const msg = `Token exchange failed (${r.status}): ${data.error || ''} ${data.error_description || ''}`;
        return finish(500, msg, new Error(msg));
      }
      if (!data.refresh_token) {
        const msg = 'Google sent no refresh token. Remove the app at myaccount.google.com/permissions and run again.';
        return finish(500, msg, new Error(msg));
      }
      finish(200, 'Signed in - you can close this tab and go back to the terminal.', null, data);
    });

    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: config.GCAL_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope,
        access_type: 'offline', // -> refresh token
        prompt: 'consent',      // -> always re-issue one, even on a repeat sign-in
        state,
        ...(loginHint ? { login_hint: loginHint } : {}),
      });
      console.log('Opening Google sign-in in your browser. If it does not open, visit:\n\n' + authUrl + '\n');
      execFile('open', [authUrl], () => {});
    });
  });
}

module.exports = { saveEnvVar, runConsentFlow };

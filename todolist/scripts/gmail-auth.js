// One-time Gmail sign-in for one of the user's mail accounts (see gmail.js).
//
// Runs the shared loopback consent flow (google-oauth.js) with compose +
// read-only scopes, looks up which address was signed in, and writes
//   GMAIL_<LABEL>_ADDRESS=<address>
//   GMAIL_<LABEL>_REFRESH_TOKEN=<token>
// into noter/.env (replacing old lines). The token is never printed.
//
// Needs GCAL_CLIENT_ID + GCAL_CLIENT_SECRET already in noter/.env (the same
// Desktop-app client as Calendar), with the Gmail API enabled on its project.
// Run: node todolist/scripts/gmail-auth.js <label> [address-hint]
//   e.g. node todolist/scripts/gmail-auth.js umich pchalerm@umich.edu
// then restart the todolist server so new agent sessions see the account.

const { saveEnvVar, runConsentFlow } = require('./google-oauth');

// compose: create drafts. readonly: thread headers for in-thread replies, and
// search/read so the agent never opens webmail in the browser.
const SCOPE = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

async function main() {
  const [label, loginHint] = process.argv.slice(2);
  if (!label || !/^[a-z0-9]+$/i.test(label)) {
    console.error('usage: node todolist/scripts/gmail-auth.js <label> [address-hint]   (label: letters/digits, e.g. umich)');
    process.exit(2);
  }
  const key = label.toUpperCase();
  const tokens = await runConsentFlow({ scope: SCOPE, loginHint });
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await r.json().catch(() => ({}));
  if (!r.ok || !profile.emailAddress) {
    throw new Error(`Gmail profile lookup failed (${r.status}): ${(profile.error && profile.error.message) || ''} - ` +
      'is the Gmail API enabled on this Google Cloud project?');
  }
  saveEnvVar(`GMAIL_${key}_ADDRESS`, profile.emailAddress);
  saveEnvVar(`GMAIL_${key}_REFRESH_TOKEN`, tokens.refresh_token);
  console.log(`Saved Gmail account "${label.toLowerCase()}" (${profile.emailAddress}) to noter/.env. ` +
    'Restart the todolist server so new agent sessions see it.');
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});

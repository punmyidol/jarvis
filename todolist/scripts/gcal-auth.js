// One-time Google Calendar sign-in for the Day column (see gcal.js).
//
// Runs the shared loopback consent flow (google-oauth.js) and writes
// GCAL_REFRESH_TOKEN into noter/.env (replacing any old line). The token is
// never printed.
//
// Needs GCAL_CLIENT_ID + GCAL_CLIENT_SECRET already in noter/.env.
// Run: node todolist/scripts/gcal-auth.js   (then restart the todolist server)

const { saveEnvVar, runConsentFlow } = require('./google-oauth');

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

runConsentFlow({ scope: SCOPE })
  .then(tokens => {
    saveEnvVar('GCAL_REFRESH_TOKEN', tokens.refresh_token);
    console.log('Saved GCAL_REFRESH_TOKEN to noter/.env. Restart the todolist server to see Google Calendar in the Day column.');
  })
  .catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  });

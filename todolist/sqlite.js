// Read-only SQLite access via the system /usr/bin/sqlite3 - zero-dependency,
// same as the rest of this app. Shared by people.js (Contacts), messages.js
// (Messages chat.db) and the server's send-confirmation check. Every query
// opens the file with -readonly, so nothing here can write to those DBs.

const { execFile } = require('child_process');

const SQLITE = '/usr/bin/sqlite3';

// macOS TCC (Full Disk Access) refusal, as sqlite3 reports it for chat.db /
// the AddressBook DBs. Callers turn this into a one-line "grant FDA" message.
class AccessDenied extends Error {}

// String literal for interpolation into SQL. sqlite3's CLI has no bound
// parameters, so every caller-supplied string goes through this.
function q(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function query(dbPath, sql) {
  return new Promise((resolve, reject) => {
    execFile(SQLITE, ['-readonly', '-json', dbPath, sql], { maxBuffer: 64 * 1024 * 1024, timeout: 20000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = `${stderr || ''} ${err.message}`;
        if (/authorization denied|operation not permitted|unable to open database/i.test(msg)) {
          return reject(new AccessDenied(dbPath));
        }
        return reject(new Error(`sqlite3 ${dbPath}: ${(stderr || err.message).trim()}`));
      }
      // -json prints nothing at all (not "[]") for an empty result set.
      try { resolve(stdout.trim() ? JSON.parse(stdout) : []); } catch (e) { reject(e); }
    });
  });
}

module.exports = { query, q, AccessDenied };

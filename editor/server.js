// Zero-dependency editor server + daily-save scheduler.
// Run: node server.js   (then open http://localhost:3000)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const SAVE_INTERVAL_MS = 60 * 1000; // scheduler: flush every 60s

// NOTER_VAULT: read from the repo's .env (same var the Python pipeline reads
// via os.environ, see noter/config.py) so notes keep landing in the
// iCloud-synced vault the pipeline reads from, even though the editor code
// itself now lives in the repo. Falls back to the pipeline's own default.
function readVaultFromEnv() {
  if (process.env.NOTER_VAULT) return process.env.NOTER_VAULT;
  try {
    const text = fs.readFileSync(path.join(ROOT, '..', '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*NOTER_VAULT\s*=\s*(.+?)\s*$/);
      if (m) return m[1];
    }
  } catch {}
  return '/Users/punmyidol/Library/Mobile Documents/iCloud~md~obsidian/Documents/elvis';
}
const VAULT = readVaultFromEnv();
const DAILIES = path.join(VAULT, 'Noter', 'dailies');

fs.mkdirSync(DAILIES, { recursive: true });

// latest content received from the browser, kept in memory
let latest = '';
let lastWritten = null;

function todayName(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dailyPath(day = todayName()) {
  return path.join(DAILIES, day + '.md'); // e.g. dailies/2026-05-01.md
}

function save(day = todayName()) {
  if (latest === lastWritten) return;
  if (latest.trim() === '') return; // don't create empty daily files
  try {
    fs.writeFileSync(dailyPath(day), latest, 'utf8');
    lastWritten = latest;
    console.log(`[${new Date().toISOString()}] saved ${day} (${latest.length} chars)`);
  } catch (e) {
    console.error('save failed:', e.message);
  }
}

// At midnight: finalize the day that just ended, then blank the new day.
function scheduleMidnight() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0); // upcoming local midnight
  setTimeout(() => {
    const endedDay = todayName(new Date(Date.now() - 60000)); // a minute ago = the day that ended
    save(endedDay);            // final flush into yesterday's file
    latest = '';               // new day starts blank
    lastWritten = null;
    console.log(`[${new Date().toISOString()}] rolled over -> ${todayName()} (blank)`);
    scheduleMidnight();        // re-arm for the following midnight
  }, next - now);
}

function loadToday() {
  try {
    return fs.readFileSync(dailyPath(), 'utf8');
  } catch {
    return '';
  }
}

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  // --- API ---
  if (req.url === '/api/content' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content: loadToday(), date: todayName() }));
    return;
  }

  if (req.url === '/api/content' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      try {
        latest = JSON.parse(body).content || '';
        save(); // write immediately on each push
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, date: todayName() }));
      } catch {
        res.writeHead(400); res.end('bad request');
      }
    });
    return;
  }

  // --- static files ---
  const file = req.url === '/' ? 'editor.html' : decodeURIComponent(req.url.split('?')[0]);
  const full = path.join(ROOT, path.normalize(file));
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'text/plain' });
    res.end(data);
  });
});

// scheduler: periodic safety flush even if browser is idle/closed
setInterval(() => save(), SAVE_INTERVAL_MS);
scheduleMidnight(); // finalize + blank at every local midnight
process.on('SIGINT', () => { save(); process.exit(0); });

server.listen(PORT, () => {
  console.log(`Editor running at http://localhost:${PORT}`);
  console.log(`Saving to ${DAILIES}/<date>  (every ${SAVE_INTERVAL_MS / 1000}s + on each edit)`);
});

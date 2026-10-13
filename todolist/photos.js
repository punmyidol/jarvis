// Find photos in the user's Photos library and export copies the agent can
// look at (Read tool) and hand to `messages.js send --file`. Uses Photos.app's
// own AppleScript `search for`, i.e. the same search as the app's search
// field. Read-only on the library - it only ever exports copies, as rendered
// JPEGs (not originals), which also works for iCloud-only photos.
//
// CLI:
//   node todolist/photos.js search <text> [--limit 12]
//   node todolist/photos.js recent [--limit 12] [--since YYYY-MM-DD]
// First use asks macOS for permission to control Photos.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const EXPORT_ROOT = path.join(__dirname, 'uploads', 'photos');
// How many hits get their dates fetched (one Apple Event each) before sorting
// newest-first and exporting the top --limit.
const SCAN_CAP = 200;

function osascript(script, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, ...args], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message).trim();
        if (/-1743|not allowed|not authorized/i.test(msg)) {
          return reject(new Error('Not allowed to control Photos - approve the macOS prompt, or enable it in System Settings > Privacy & Security > Automation.'));
        }
        return reject(new Error(`Photos: ${msg}`));
      }
      resolve(stdout);
    });
  });
}

// id <TAB> ISO date <TAB> filename, one line per media item.
const LIST_TAIL = `
  set out to ""
  repeat with m in picked
    set out to out & (id of m) & tab & ((date of m) as «class isot» as string) & tab & (filename of m) & linefeed
  end repeat
  return out`;

const SEARCH_SCRIPT = `
on run argv
  tell application "Photos"
    set found to search for (item 1 of argv)
    set cap to (item 2 of argv) as integer
    if (count of found) > cap then set found to items 1 thru cap of found
    set picked to found
    ${LIST_TAIL}
  end tell
end run`;

// Library order is import order, so the tail is the most recently added.
const RECENT_SCRIPT = `
on run argv
  tell application "Photos"
    set cap to (item 1 of argv) as integer
    set allItems to every media item
    set n to count of allItems
    if n = 0 then return ""
    set firstIdx to n - cap + 1
    if firstIdx < 1 then set firstIdx to 1
    set picked to items firstIdx thru n of allItems
    ${LIST_TAIL}
  end tell
end run`;

const EXPORT_SCRIPT = `
on run argv
  set outDir to POSIX file (item 1 of argv)
  tell application "Photos"
    set picked to {}
    repeat with i from 2 to count of argv
      set end of picked to media item id (item i of argv)
    end repeat
    export picked to outDir without using originals
  end tell
end run`;

function parseList(stdout) {
  return stdout.split('\n').filter(Boolean).map(l => {
    const [id, date, filename] = l.split('\t');
    return { id, date, filename };
  });
}

async function exportItems(items) {
  const dir = path.join(EXPORT_ROOT, `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  await osascript(EXPORT_SCRIPT, [dir, ...items.map(i => i.id)], 300000);
  const exported = fs.readdirSync(dir);
  // Rendered exports keep the base name but may change the extension
  // (IMG_1234.HEIC -> IMG_1234.jpeg); duplicate names get a suffix.
  const used = new Set();
  for (const it of items) {
    const base = path.parse(it.filename || '').name.toLowerCase();
    const f = exported.find(e => !used.has(e) && path.parse(e).name.toLowerCase() === base) ||
      exported.find(e => !used.has(e) && e.toLowerCase().startsWith(base));
    if (f) { used.add(f); it.path = path.join(dir, f); }
  }
  return { dir, items };
}

function print({ dir, items }, what) {
  if (!items.length) { console.log(`No photos for ${what}.`); return; }
  console.log(`${items.length} photo(s) for ${what}, newest first, exported to ${dir}:`);
  for (const it of items) {
    console.log(`${(it.date || '').replace('T', ' ').slice(0, 16)}  ${it.filename}  ${it.path || '(export missing)'}`);
  }
  console.log('View them with the Read tool before choosing one; send with messages.js send <who> --file <path>.');
}

const newestFirst = (a, b) => (b.date || '').localeCompare(a.date || '');

async function cmdSearch(text, limit) {
  const hits = parseList(await osascript(SEARCH_SCRIPT, [text, String(SCAN_CAP)])).sort(newestFirst).slice(0, limit);
  print(hits.length ? await exportItems(hits) : { items: [] }, `"${text}"`);
}

async function cmdRecent(limit, since) {
  let items = parseList(await osascript(RECENT_SCRIPT, [String(since ? SCAN_CAP : limit)])).sort(newestFirst);
  if (since) items = items.filter(i => (i.date || '') >= since);
  items = items.slice(0, limit);
  print(items.length ? await exportItems(items) : { items: [] }, since ? `since ${since}` : 'most recent');
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = name => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const limit = Math.min(Number(opt('--limit')) || 12, 50);
  const since = opt('--since');
  const [cmd, ...rest] = argv;
  if (cmd === 'search' && rest.length) return cmdSearch(rest.join(' '), limit);
  if (cmd === 'recent') return cmdRecent(limit, since);
  console.error('usage:\n  photos.js search <text> [--limit 12]\n  photos.js recent [--limit 12] [--since YYYY-MM-DD]');
  process.exit(2);
}

main().catch(e => { console.error(e.message); process.exit(1); });

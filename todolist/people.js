// Who is "mom"? Resolves a name/nickname/relation to people + their phone /
// email handles, for messages.js. Two sources, in order:
//   1. the vault's Home/Family/ notes - any markdown table with a name column
//      (Nickname / Full Name) and optionally Relation and a Phone/iMessage/
//      Email column. A handle written in that table wins.
//   2. macOS Contacts (AddressBook-v22.abcddb, read-only) - for the handle of
//      a family member whose table row has none, and for anyone not in the
//      family notes at all.
// Never writes to the vault or Contacts. Ambiguity is the caller's problem to
// surface (more than one match -> ask the user), never resolved by guessing.
//
// CLI: node todolist/people.js <who>

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const sqlite = require('./sqlite');

const FAMILY_DIR = path.join(config.VAULT, 'Home', 'Family');
const AB_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook');

// Words people actually type for a relation -> the word used in the
// Relation column. Anything not listed is matched as typed.
const RELATION_SYNONYMS = {
  mother: 'mom', mum: 'mom', mommy: 'mom', 'แม่': 'mom',
  father: 'dad', daddy: 'dad', 'พ่อ': 'dad',
  sis: 'sister', grandmother: 'grandma', grandfather: 'grandpa',
};

// Phones are stored every which way ("081-234-5678", "+66 81 234 5678",
// "+66812345678") - the last 9 digits are what reliably line up.
function phoneKey(s) {
  const digits = String(s).replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-9) : '';
}

function handleKey(h) {
  return h.includes('@') ? h.trim().toLowerCase() : phoneKey(h);
}

function walkMd(dir) {
  let out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkMd(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const cell = s => s.replace(/\*+/g, '').trim();

// Markdown tables -> rows keyed by role (nickname/fullName/relation/handles),
// keeping only tables that have a name column.
function parseTables(text, file) {
  const rows = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|') || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) continue;
    const header = lines[i].split('|').slice(1, -1).map(h => cell(h).toLowerCase());
    const col = re => header.findIndex(h => re.test(h));
    const idx = {
      nickname: col(/nick/),
      fullName: col(/full name|^name$/),
      relation: col(/relation/),
      handles: header.map((h, n) => (/phone|mobile|tel|imessage|e-?mail|handle/.test(h) ? n : -1)).filter(n => n >= 0),
    };
    if (idx.nickname < 0 && idx.fullName < 0) continue;
    for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
      const cells = lines[i].split('|').slice(1, -1).map(cell);
      const handles = idx.handles.flatMap(n => (cells[n] || '').split(/[,;/]/)).map(h => h.trim()).filter(h => handleKey(h));
      rows.push({
        nickname: idx.nickname >= 0 ? cells[idx.nickname] || '' : '',
        fullName: idx.fullName >= 0 ? cells[idx.fullName] || '' : '',
        relation: idx.relation >= 0 ? cells[idx.relation] || '' : '',
        handles,
        source: path.relative(config.VAULT, file),
      });
    }
  }
  return rows;
}

function familyRows() {
  return walkMd(FAMILY_DIR).flatMap(f => {
    try { return parseTables(fs.readFileSync(f, 'utf8'), f); } catch { return []; }
  });
}

// "Grandma (dad's side) — deceased" -> "grandma"
function relationBase(rel) {
  return rel.toLowerCase().replace(/\(.*?\)/g, '').split(/[—–-]/)[0].trim();
}

function normalizeQuery(q) {
  const n = q.trim().toLowerCase().replace(/^(my|to)\s+/, '');
  return RELATION_SYNONYMS[n] || n;
}

function abDatabases() {
  const dbs = [];
  const root = path.join(AB_ROOT, 'AddressBook-v22.abcddb');
  if (fs.existsSync(root)) dbs.push(root);
  let sources;
  try {
    sources = fs.readdirSync(path.join(AB_ROOT, 'Sources'));
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') throw new sqlite.AccessDenied(AB_ROOT);
    sources = [];
  }
  for (const s of sources) {
    const p = path.join(AB_ROOT, 'Sources', s, 'AddressBook-v22.abcddb');
    if (fs.existsSync(p)) dbs.push(p);
  }
  return dbs;
}

// Every contact's handles: [{name, first, last, nick, handle}].
async function contactHandles() {
  const sql = `
    SELECT r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, r.ZNICKNAME AS nick, p.ZFULLNUMBER AS handle
      FROM ZABCDRECORD r JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK WHERE p.ZFULLNUMBER IS NOT NULL
    UNION ALL
    SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZNICKNAME, e.ZADDRESS
      FROM ZABCDRECORD r JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK WHERE e.ZADDRESS IS NOT NULL`;
  const out = [];
  for (const db of abDatabases()) {
    for (const r of await sqlite.query(db, sql)) {
      const name = [r.first, r.last].filter(Boolean).join(' ') || r.nick || '';
      if (name) out.push({ name, first: r.first || '', last: r.last || '', nick: r.nick || '', handle: r.handle });
    }
  }
  return out;
}

// handleKey -> contact name, for labelling message senders. Empty map when
// Contacts can't be read - callers then just show raw handles.
async function contactIndex() {
  const map = new Map();
  try {
    for (const c of await contactHandles()) {
      const k = handleKey(c.handle);
      if (k && !map.has(k)) map.set(k, c.name);
    }
  } catch {}
  return map;
}

function contactMatches(contacts, names) {
  const wanted = names.map(n => n.toLowerCase()).filter(Boolean);
  return contacts.filter(c =>
    wanted.includes(c.name.toLowerCase()) ||
    wanted.includes(c.nick.toLowerCase()) ||
    wanted.includes(c.first.toLowerCase())
  );
}

// -> { people: [{name, nickname, relation, handles[], source}], contactsError }
// More than one person = ambiguous; zero handles = known person, no number.
async function resolve(query) {
  const n = normalizeQuery(query);
  let contacts = null;
  let contactsError = null;
  const getContacts = async () => {
    if (contacts) return contacts;
    try {
      contacts = await contactHandles();
    } catch (e) {
      contacts = [];
      contactsError = e instanceof sqlite.AccessDenied
        ? 'Contacts not readable (Full Disk Access not granted)'
        : e.message;
    }
    return contacts;
  };

  const family = familyRows().filter(r => {
    if (/deceased/i.test(r.relation)) return false;
    const full = r.fullName.toLowerCase();
    return r.nickname.toLowerCase() === n || full === n || full.split(/\s+/)[0] === n || (r.relation && relationBase(r.relation) === n);
  });

  const people = [];
  for (const r of family) {
    let handles = r.handles;
    if (!handles.length) {
      handles = contactMatches(await getContacts(), [r.fullName, r.nickname]).map(c => c.handle);
    }
    people.push({ name: r.fullName || r.nickname, nickname: r.nickname, relation: r.relation, handles: dedupe(handles), source: r.source });
  }

  if (!people.length) {
    const byName = new Map();
    for (const c of contactMatches(await getContacts(), [query.trim()])) {
      if (!byName.has(c.name)) byName.set(c.name, []);
      byName.get(c.name).push(c.handle);
    }
    for (const [name, handles] of byName) {
      people.push({ name, nickname: '', relation: '', handles: dedupe(handles), source: 'Contacts' });
    }
  }
  return { people, contactsError };
}

function dedupe(handles) {
  const seen = new Set();
  return handles.filter(h => {
    const k = handleKey(h);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = { resolve, contactIndex, phoneKey, handleKey };

if (require.main === module) {
  const who = process.argv.slice(2).join(' ');
  if (!who) {
    console.error('usage: node people.js <name | nickname | relation>');
    process.exit(2);
  }
  resolve(who).then(({ people, contactsError }) => {
    if (contactsError) console.error(`note: ${contactsError}`);
    if (!people.length) {
      console.log(`No one matches "${who}" in ${path.relative(config.VAULT, FAMILY_DIR)}/ or Contacts.`);
      process.exit(1);
    }
    for (const p of people) {
      const label = [p.name, p.nickname && p.nickname !== p.name ? `"${p.nickname}"` : '', p.relation && `(${p.relation})`].filter(Boolean).join(' ');
      console.log(`${label}  [${p.source}]`);
      console.log(p.handles.length ? p.handles.map(h => `  ${h}`).join('\n') : '  (no phone/email - add a Phone column to the family table, or save them in Contacts)');
    }
  }).catch(e => { console.error(e.message); process.exit(1); });
}

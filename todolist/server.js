// Zero-dependency todolist server: reads open Notion tasks (only on refresh),
// spawns headless `claude` runs for whichever task you pick, tracks them
// in-memory (polled separately, no extra Notion calls), and marks a task done
// in Notion when the model itself says it's done (see DONE_MARKER below) -
// never just because its process happened to exit. A manual mark-done route
// exists as a fallback for when the model doesn't say so.
//
// Multi-turn design: `claude -p` is one-shot - it always exits after producing
// one reply, no matter the input/output format or whether stdin is left open.
// So each turn is its own short-lived process, chained to the previous one via
// `claude -p <text> --resume <session_id>` (the session id comes back on every
// stream-json `result` event). `entry.status` stays 'running' for the whole
// conversation, across every one of those processes - it only becomes
// 'finished'/'failed' once the conversation is actually over. See runTurn().
// Run: node server.js   (then open http://localhost:3300)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('./config');
const notion = require('./notion');

const ROOT = __dirname;
const PORT = config.PORT;
const LOGS_DIR = path.join(ROOT, 'logs');
const STATE_PATH = path.join(ROOT, 'state.json');
const TAIL_BYTES = 2000;

fs.mkdirSync(LOGS_DIR, { recursive: true });

// id -> task summary from the last /api/tasks fetch, so /start doesn't
// need to re-query Notion.
const taskCache = new Map();

// id -> {status, startedAt, exitCode, tail, logFile, turns, awaitingInput,
//        markedDone, sessionId, cwd, userFinished}
const tracker = new Map();

// id -> live process/session bookkeeping for whichever turn's process is
// CURRENTLY running. NEVER persisted (holds a ChildProcess handle) - a server
// restart can't recover these, hence the 'interrupted' status handling in
// loadState() below. Absent between turns (that's expected, not an error -
// see runTurn's exit handler).
const liveProcesses = new Map();

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    let changed = false;
    for (const [id, entry] of Object.entries(raw)) {
      if (entry.status === 'running') {
        // Its child process died with the old server process; there's no
        // way to reattach, so stop pretending it's still going.
        entry.status = 'interrupted';
        entry.awaitingInput = false;
        changed = true;
      }
      tracker.set(id, entry);
    }
    if (changed) saveState();
  } catch {}
}
function saveState() {
  const obj = Object.fromEntries(tracker.entries());
  fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2));
}
loadState();

const DONE_MARKER = '<!--TASK_COMPLETE-->';
// The prompt asks for the marker alone on its own final line; match exactly
// that, so a reply that merely quotes or discusses the marker mid-sentence
// ("I won't emit <!--TASK_COMPLETE--> yet") can't complete the task.
const DONE_MARKER_RE = /^[ \t]*<!--TASK_COMPLETE-->[ \t]*$/m;

// The prompt is the ONLY steering this loop has - there's no --system-prompt
// and no --allowedTools on the spawn, so every behavioural rule lives here.
// It is deliberately act-first: an earlier version framed the browser as a
// fallback ("use it for anything behind a login"), and runs reliably answered
// by web-searching and writing an Obsidian note instead of doing the task.
function buildPrompt(task, notes, instructions, hasExplicitWorkdir) {
  const lines = [
    `Task: ${task.title}`,
    `Project: ${task.project || 'none'}`,
    `Due: ${task.due_date || 'none'}`,
    'Notes:',
    ...(notes.length ? notes.map(n => `- ${n}`) : ['- (none)']),
    '',
    'Additional instructions:',
    instructions && instructions.trim() ? instructions.trim() : 'none',
    '',
    'Your job is to CARRY THIS TASK OUT, not to research it. Researching a ' +
      'task, summarising it, comparing the options, or writing up what someone ' +
      'would have to do is NOT doing it, and does not complete it. If the task ' +
      'is "sign up for X", the deliverable is an account that exists - not a ' +
      'guide to signing up for X. Default to acting; look things up only as ' +
      'much as you need to take the next real step.',
    '',
    'Browser: you are driving the user\'s own Chrome, already logged in to ' +
      'their accounts, through the mcp__claude-in-chrome__* tools. That is your ' +
      'primary way of working, not a fallback. Open the actual site and work ' +
      'the actual flow. Do not decide a site is out of reach, and do not ' +
      'substitute WebSearch/WebFetch reading-about-it for going there. If a ' +
      'browser tool is refused for a site, say so plainly and name the site - ' +
      'the user can grant it in the Chrome extension.',
  ];
  if (!hasExplicitWorkdir) {
    lines.push(
      '',
      'You were started in the Obsidian vault root, not a specific project ' +
        'folder - look around it for context on this task before you start. ' +
        'Context only: unless the task itself asks for a note, writing files ' +
        'into the vault is at most an incidental byproduct and never the ' +
        'deliverable. A new note is not a completed task.'
    );
  }
  lines.push(
    '',
    'This is a multi-turn chat session - respond in Markdown, since your ' +
      'replies are rendered as Markdown in a chat UI. The user is sitting in ' +
      'front of that UI, able to act on their machine right now.',
    '',
    'Handing back: ending a reply hands control to the user, and their answer ' +
      'resumes this same session. That is cheap and expected - use it. When a ' +
      'step genuinely needs them in person (signing in, a password, a 2FA or ' +
      'email code, a payment, an identity or eligibility decision), do all the ' +
      'setup first - open the page, get to the exact screen where they act - ' +
      'then end your turn with a short, specific ask: which tab is open, what ' +
      'they should do in it, and to reply when done. Then stop and wait. Do ' +
      'not batch several such asks to the end, do not guess past them, and do ' +
      'not abandon the task because one exists.',
    '',
    'Completion: this task is only marked done in Notion when you say so, so ' +
      'the bar is high. Emit the completion marker ONLY when every part of ' +
      'the task has actually been carried out by you.',
    `Do NOT emit it if any of these is true: a step is left for the user to do; ` +
      `you were blocked, or lacked access or credentials; the task asked you to ` +
      `DO something and you only researched, summarised or planned it; or you ` +
      `cannot verify the result.`,
    'Immediately before the marker, write a short "Done:" list - one line per ' +
      'thing you actually changed, created or sent, each with its concrete ' +
      'evidence (file path, URL, Notion page, command output). If you cannot ' +
      'fill that list, you are not done.',
    'For anything done in the browser, the evidence is the end state you ' +
      'actually reached and saw - the resulting account, dashboard or ' +
      'confirmation page - never a note or summary describing one.',
    'If you finished only part of it, say plainly what is left and stop, with ' +
      'no marker. Leaving a task open is much better than marking one done ' +
      'that is not.',
    `When and only when all of that holds, end your final reply with a line ` +
      `containing exactly ${DONE_MARKER} and nothing else on that line. Never ` +
      `include it in an intermediate reply or while asking a question.`
  );
  return lines.join('\n');
}

const TURN_TEXT_CAP = 50000;

// Parses one turn's stdout as newline-delimited stream-json events, kept
// entirely separate from the raw tail/log plumbing below (which still gets
// every raw byte, unchanged). Defensive by design: an unrecognized `type` or
// a non-JSON line is just ignored, never fatal - the CLI's exact event shapes
// can shift between versions and this must not crash the run.
function parseStreamJson(id, entry, chunk) {
  const live = liveProcesses.get(id);
  if (!live) return;
  live.stdoutBuffer += chunk.toString();
  const lines = live.stdoutBuffer.split('\n');
  live.stdoutBuffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === 'stream_event' && obj.event && obj.event.type === 'content_block_delta' && obj.event.delta && obj.event.delta.type === 'text_delta') {
      live.currentAssistantText += obj.event.delta.text;
    } else if (obj.type === 'result') {
      // Needed to chain the next turn onto this same conversation via
      // `--resume` (see runTurn) - the process that produced this event is
      // about to exit either way, one-shot by design.
      if (obj.session_id) entry.sessionId = obj.session_id;
      const rawText = typeof obj.result === 'string' ? obj.result : live.currentAssistantText;
      const isDone = DONE_MARKER_RE.test(rawText);
      // Strip only the marker line itself (the whole line, including its
      // newline) rather than every occurrence of the string anywhere.
      const text = isDone
        ? rawText.replace(/^[ \t]*<!--TASK_COMPLETE-->[ \t]*\n?/gm, '').trimEnd()
        : rawText;
      entry.turns.push({ role: 'assistant', text: text.slice(0, TURN_TEXT_CAP), ts: Date.now() });
      live.currentAssistantText = '';
      entry.awaitingInput = true;
      // The model - not the process exiting - decides "done". Only act on the
      // marker while this is still the entry actually tracked for `id`, so an
      // orphaned duplicate run (see the already-running guard in /start) can't
      // mark a task done out from under the real one.
      // `markedDone` means Notion really says Done, so it is set in the
      // .then() - never up front. `markDonePending` is the separate in-flight
      // guard that stops a second marker from firing a duplicate PATCH.
      if (isDone) entry.doneMarkerSeen = true;
      if (isDone && !entry.markedDone && !entry.markDonePending && tracker.get(id) === entry) {
        entry.markDonePending = true;
        notion
          .markDone(id)
          .then(() => {
            entry.markDonePending = false;
            entry.markedDone = true;
            entry.markDoneError = null;
            saveState();
          })
          .catch(err => {
            entry.markDonePending = false;
            entry.markDoneError = err.message;
            entry.tail = (entry.tail + `\n[mark-done failed] ${err.message}`).slice(-TAIL_BYTES);
            saveState();
          });
      }
      saveState();
    }
    // system/rate_limit_event/assistant/user/other stream_event subtypes:
    // ignored for the turn transcript (raw tail still has everything).
  }
}

// Spawns ONE turn as its own `claude -p` process (see the multi-turn design
// note at the top of this file) and wires it into `entry`/`liveProcesses`.
// `extraArgs` is `[]` for the very first turn and `['--resume', sessionId]`
// for every follow-up - same wiring either way, only the CLI args differ.
// `--permission-mode` has to be repeated on every resumed invocation too:
// it's not remembered from the previous turn's process.
function runTurn(id, entry, text, extraArgs) {
  entry.turns.push({ role: 'user', text, ts: Date.now() });
  entry.status = 'running';
  entry.awaitingInput = false;
  saveState();

  const logStream = fs.createWriteStream(entry.logFile, { flags: 'a' });

  const child = spawn(
    'claude',
    [
      '-p', text,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      // Claude in Chrome. Verified to attach to a headless `claude -p` child
      // (the init event lists mcp__claude-in-chrome__*, server 'connected'),
      // so this is NOT interactive-only - don't drop it again. Without it the
      // agent has literally zero browser tools: the only MCP server on this
      // machine is project-scoped to the repo, and these runs use the vault as
      // cwd, so they inherit nothing. Needs Chrome running with the extension.
      '--chrome',
      ...extraArgs,
    ],
    { cwd: entry.cwd, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  liveProcesses.set(id, { child, stdoutBuffer: '', currentAssistantText: '' });

  // Raw tail/log mechanism: every raw byte of stdout+stderr, as stream-json
  // NDJSON lines rather than plain prose - an expected side effect of using
  // --output-format stream-json, not a regression in how it streams.
  const onChunk = chunk => {
    logStream.write(chunk);
    entry.tail = (entry.tail + chunk.toString()).slice(-TAIL_BYTES);
  };
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  // Additive: parses the same stdout for the turn transcript, independent
  // of the raw tail listener above.
  child.stdout.on('data', chunk => parseStreamJson(id, entry, chunk));

  child.on('error', err => {
    entry.status = 'failed';
    entry.exitCode = null;
    entry.awaitingInput = false;
    entry.tail = (entry.tail + `\n[spawn error] ${err.message}`).slice(-TAIL_BYTES);
    logStream.end();
    liveProcesses.delete(id);
    saveState();
  });

  child.on('exit', code => {
    entry.exitCode = code;
    if (code !== 0) {
      entry.status = 'failed';
      entry.awaitingInput = false;
    } else if (entry.doneMarkerSeen || entry.userFinished) {
      // The model said it's done, or the user clicked "Finish" - either way
      // the conversation is genuinely over, not just between turns. Keyed on
      // the marker, not on `markedDone`: that one waits for Notion's PATCH to
      // resolve, which usually lands after this process has already exited.
      entry.status = 'finished';
      entry.awaitingInput = false;
    }
    // Otherwise: this was just an ordinary turn finishing. Leave `status`
    // as 'running' (parseStreamJson already set awaitingInput = true) -
    // the next /reply resumes the conversation with a brand new process
    // (see /reply below). The process itself is gone either way, hence:
    logStream.end();
    liveProcesses.delete(id);
    saveState();
  });
}

async function startTask(id, instructions, workdir) {
  const task = taskCache.get(id);
  if (!task) throw new Error('unknown task id (refresh the task list first)');
  if (liveProcesses.has(id)) throw new Error('task already running');

  const notes = await notion.getPageBlocks(id);
  const cwd = (workdir || '').trim() || config.VAULT;
  const prompt = buildPrompt(task, notes, instructions, Boolean((workdir || '').trim()));

  const entry = {
    status: 'running',
    startedAt: Date.now(),
    exitCode: null,
    tail: '',
    logFile: path.join(LOGS_DIR, `${id}-${Date.now()}.log`),
    turns: [],
    awaitingInput: false,
    markedDone: false,
    doneMarkerSeen: false,
    markDonePending: false,
    markDoneError: null,
    sessionId: null,
    cwd,
    userFinished: false,
  };
  tracker.set(id, entry);
  saveState();

  runTurn(id, entry, prompt, []);
}

function dueSortKey(t) {
  return t.due_date || '9999-99-99';
}

// Notes are deliberately NOT fetched here. With a large open-tasks backlog,
// eagerly pulling every task's page body (one Notion round-trip each) is what
// made a refresh take seconds - it scales with total open tasks, not with
// anything the user is actually about to do. Notes are fetched lazily instead:
// once when a task's send-box is opened (GET /api/tasks/:id/notes) and again
// fresh right before a run actually starts (see startTask), so a refresh is
// just the one (paginated) database query.
async function getTasks() {
  const pages = await notion.queryOpenTasks();
  const tasks = pages.map(notion.toTaskSummary);
  for (const t of tasks) taskCache.set(t.id, t);
  tasks.sort((a, b) => dueSortKey(a).localeCompare(dueSortKey(b)));
  return tasks;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  try {
    if (url === '/api/tasks' && req.method === 'GET') {
      const tasks = await getTasks();
      return sendJson(res, 200, tasks);
    }

    if (url === '/api/status' && req.method === 'GET') {
      const obj = {};
      for (const [id, entry] of tracker.entries()) {
        const live = liveProcesses.get(id);
        obj[id] = {
          status: entry.status,
          startedAt: entry.startedAt,
          exitCode: entry.exitCode,
          tail: entry.tail,
          turns: entry.turns || [],
          awaitingInput: Boolean(entry.awaitingInput),
          markedDone: Boolean(entry.markedDone),
          markDoneError: entry.markDoneError || null,
          // Lets the UI say *why* a session ended (you closed it vs Claude
          // reported the work done) instead of one ambiguous "finished".
          userFinished: Boolean(entry.userFinished),
          // Ephemeral in-progress text - never written to state.json, just
          // the live accumulator for the "Claude is typing" preview.
          streamingText: live ? live.currentAssistantText : '',
        };
      }
      return sendJson(res, 200, obj);
    }

    let m = url.match(/^\/api\/tasks\/([^/]+)\/start$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const { instructions, workdir } = await readBody(req);
      try {
        await startTask(id, instructions, workdir);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }

    m = url.match(/^\/api\/tasks\/([^/]+)\/reply$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const entry = tracker.get(id);
      if (!entry || entry.status !== 'running' || !entry.awaitingInput) {
        return sendJson(res, 400, { ok: false, error: 'not awaiting your input right now' });
      }
      const { message } = await readBody(req);
      if (!message || !message.trim()) {
        return sendJson(res, 400, { ok: false, error: 'message is empty' });
      }
      if (!entry.sessionId) {
        return sendJson(res, 400, { ok: false, error: 'no session to resume yet (first turn never completed)' });
      }
      // Every turn - including this one - is its own process (see runTurn):
      // `claude -p` always exits after one reply, so "replying" means
      // resuming the same conversation in a fresh process, not writing to a
      // still-open stdin.
      runTurn(id, entry, message.trim(), ['--resume', entry.sessionId]);
      return sendJson(res, 200, { ok: true });
    }

    m = url.match(/^\/api\/tasks\/([^/]+)\/finish$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const entry = tracker.get(id);
      if (!entry) {
        return sendJson(res, 200, { ok: true });
      }
      entry.userFinished = true;
      if (!liveProcesses.has(id)) {
        // No turn in flight right now - finalize immediately. If a turn IS
        // in flight, its own exit handler finalizes once it completes (see
        // runTurn), so the current reply isn't cut off mid-turn.
        entry.status = 'finished';
        entry.awaitingInput = false;
      }
      saveState();
      return sendJson(res, 200, { ok: true });
    }

    m = url.match(/^\/api\/tasks\/([^/]+)\/mark-done$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      // Manual fallback for when the model never emits its completion marker
      // (errored out, ran out of turns, task was actually finished by hand,
      // etc.) - works even for a task that was never run through this app.
      try {
        await notion.markDone(id);
      } catch (e) {
        const failed = tracker.get(id);
        if (failed) {
          failed.markDoneError = e.message;
          saveState();
        }
        return sendJson(res, 500, { ok: false, error: e.message });
      }
      const entry = tracker.get(id);
      if (entry) {
        // Only reached if the PATCH above resolved.
        entry.markedDone = true;
        entry.markDoneError = null;
        saveState();
      }
      return sendJson(res, 200, { ok: true });
    }

    m = url.match(/^\/api\/tasks\/([^/]+)\/notes$/);
    if (m && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const notes = await notion.getPageBlocks(id);
      return sendJson(res, 200, { notes });
    }

    m = url.match(/^\/api\/tasks\/([^/]+)\/log$/);
    if (m && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const entry = tracker.get(id);
      if (!entry || !fs.existsSync(entry.logFile)) {
        res.writeHead(404);
        return res.end('no log');
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(fs.readFileSync(entry.logFile, 'utf8'));
    }

    // --- static files ---
    const file = url === '/' ? 'index.html' : decodeURIComponent(url);
    const full = path.join(ROOT, path.normalize(file));
    if (!full.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'text/plain' });
      res.end(data);
    });
  } catch (e) {
    if (e.rateLimited) {
      return sendJson(res, 429, { error: 'Notion rate limit hit — wait a bit and refresh.', rateLimited: true });
    }
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Todolist running at http://localhost:${PORT}`);
  console.log(`Default working directory (no explicit folder given): ${config.VAULT}`);
});

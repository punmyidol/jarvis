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
//        markedDone, sessionId, cwd}
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
const ACTION_ITEMS_FENCE_OPEN = '```action-items';
const ACTION_ITEMS_FENCE_CLOSE = '```';
const ACTION_ITEMS_RE = /```action-items\s*\n([\s\S]*?)```/;
const OPTIONS_FENCE_OPEN = '```options';
const OPTIONS_FENCE_CLOSE = '```';
const OPTIONS_RE = /```options\s*\n([\s\S]*?)```/;
const PROGRESS_FENCE_OPEN = '```progress';
const PROGRESS_FENCE_CLOSE = '```';
const PROGRESS_RE = /```progress\s*\n([\s\S]*?)```/;
// Model-independent backstops against a verbose or looping agent turning the
// Notion task page into noise - the prompt asks for restraint, but these caps
// hold regardless of whether it listens.
const MAX_PROGRESS_BULLETS_PER_TURN = 3;
const MAX_PROGRESS_BULLETS_PER_TASK = 25;
const MIN_PROGRESS_BULLET_LEN = 8;

const ENDSTATE_FENCE_OPEN = '```endstate';
const ENDSTATE_FENCE_CLOSE = '```';
const ENDSTATE_RE = /```endstate\s*\n([\s\S]*?)```/;
// Deliberately not the bare word "done" - the prompt's own prose already says
// "Done:" casually elsewhere, and this needs to be unambiguous to parse.
const DONE_EVIDENCE_FENCE_OPEN = '```done-evidence';
const DONE_EVIDENCE_FENCE_CLOSE = '```';
const DONE_EVIDENCE_RE = /```done-evidence\s*\n([\s\S]*?)```/;
// A mismatch auto-continues the same session (see runTurn's exit handler)
// asking the model to reconcile, same mechanism as a real /reply - but bounded,
// so a model that keeps getting the count wrong eventually surfaces to a human
// instead of looping forever.
const MAX_EVIDENCE_RECONCILE_ATTEMPTS = 2;

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
        'folder - look around it for context on this task before you start, ' +
        'that is always fine. Writing is different: do NOT create or edit any ' +
        'file in the vault unless this task\'s own notes/instructions above ' +
        'explicitly ask for a note to be saved, or the user explicitly asks ' +
        'for one in this chat session. That is the default for every task - ' +
        'a new note is never an incidental byproduct, and it is never a ' +
        'completed task on its own.'
    );
  }
  lines.push(
    '',
    'Where things live: your personal information is kept in the Obsidian vault at ' +
      `${config.VAULT} - check there if a task needs it (reading is always fine; see ` +
      'above for when writing there is). Tasks and deadlines are tracked in Notion; the ' +
      'notes above are already pulled from there for this task. You do not have a direct ' +
      'Notion tool, and do not need one - ending a reply with a progress block (below) is ' +
      'how what you did gets written onto this task\'s Notion page for you.',
    '',
    'This is a multi-turn chat session - respond in Markdown, since your ' +
      'replies are rendered as Markdown in a chat UI. The user is sitting in ' +
      'front of that UI, able to act on their machine right now.',
    '',
    'Handing back: ending a reply hands control to the user, and their answer ' +
      'resumes this same session. That is cheap and expected - use it. When a ' +
      'step genuinely needs them in person (signing in, a password, a 2FA or ' +
      'email code, a payment, a signed or otherwise binding commitment ' +
      '(including anything with a cancellation fee), an identity or ' +
      'eligibility decision, or submitting a form or message that sends the ' +
      'user\'s real personal info to a person or organization they don\'t ' +
      'already have an account or relationship with), do all the setup first ' +
      '- open the page, get to the exact screen where they act - then end ' +
      'your turn with a short, specific ask: which tab is open, what they ' +
      'should do in it, and to reply when done. Then stop and wait. Do not ' +
      'batch several such asks to the end, do not guess past them, and do ' +
      'not abandon the task because one exists.',
    '',
    'Submitting to a real third party: filling a form out - including with the ' +
      'user\'s real name, email, address, or other personal info pulled from ' +
      'the vault - is normal setup and fine to do unprompted. But before you ' +
      'actually submit one of the things listed above (a payment, a signed or ' +
      'binding commitment, or a form/message that sends real personal info to ' +
      'an org or person the user has no existing account or relationship ' +
      'with), stop at the final submit/send step and tell the user exactly ' +
      'what it is and what it is about to send, then end that reply with an ' +
      'options block (see below) offering the real choices - normally ' +
      '"Yes, submit it" and "No, don\'t" - and wait for their answer. A ' +
      'stated preference ("I like X") is not ' +
      'itself authorization to submit anything on the user\'s behalf; only a ' +
      'direct answer to that specific ask is. Do not wave this through because ' +
      'it "is just a newsletter" or "is free" or "only asks for an email" - a ' +
      'newsletter, waitlist, "get updates", or early-access signup on a site ' +
      'the user has no prior account or relationship with is still handing a ' +
      'stranger their real contact info, and needs the exact same stop as ' +
      'anything else here; it is not an example of something to skip the stop ' +
      'for. The test is narrow and mechanical, and always ask it explicitly ' +
      'before any submit: does this specific org already have the user\'s ' +
      'info on file from something set up before this task? If not, stop and ' +
      'ask first, no matter how small the form looks. The only submissions ' +
      'that skip this stop are ones carrying no personal info at all (a ' +
      'search, filter, or availability form) or ones going to a place the ' +
      'user already has an account with (their own inbox, an existing ' +
      'subscription, a site they are already logged into).',
    '',
    'Endstate: before taking any other action, end your very FIRST reply in this ' +
      'conversation with a fenced block exactly like this, containing ONLY short, ' +
      'concrete, checkable bullets describing what must be true when this task is ' +
      `actually finished - nothing else inside the fence:\n\n${ENDSTATE_FENCE_OPEN}\n` +
      `- <checkable condition 1>\n- <checkable condition 2>\n${ENDSTATE_FENCE_CLOSE}\n\n` +
      'Usually 1-4 bullets - one per genuinely distinct, checkable outcome, each ' +
      'concrete enough that you could later point at the exact evidence that satisfies ' +
      'it. This is not a plan or a list of steps, and it does not replace acting in ' +
      'later turns - it is the target end state you are committing to, checked against ' +
      'your own done-evidence later. If the task has one single deliverable you cannot ' +
      'usefully split up, use one bullet for it. Never omit this block on your first reply.',
    '',
    'Action items: whenever this reply needs something from the user before you can ' +
      'continue (missing information, or something open-ended you need from them, with ' +
      'no fixed set of answers to offer) - not for a routine status update - end the ' +
      'reply with a fenced block exactly like this, containing ONLY short imperative ' +
      'bullets (a few words each), nothing else inside ' +
      `the fence:\n\n${ACTION_ITEMS_FENCE_OPEN}\n- <brief action 1>\n- <brief action 2>\n` +
      `${ACTION_ITEMS_FENCE_CLOSE}\n\nOmit this block entirely when you are not blocked ` +
      'on the user.',
    '',
    'Options: whenever the reply is instead waiting on the user to pick from a small, ' +
      'concrete set of choices - including a plain yes/no, like the submit-permission ' +
      'stop above - end the reply with a fenced block exactly like this instead of ' +
      'action-items, one short option per line (your own wording, a few words each), ' +
      'the option you\'d actually pick first if you had to choose one, nothing else ' +
      `inside the fence:\n\n${OPTIONS_FENCE_OPEN}\n<default/recommended option>\n` +
      `<other option>\n${OPTIONS_FENCE_CLOSE}\n\n2-4 options. The user can still reply ` +
      'with free text instead of one of these, so the options are a shortcut, not a ' +
      'restriction - phrase them as the real answers, not generic placeholders.',
    '',
    'Progress: by default, a meaningful step forward gets written onto this ' +
      'task\'s own Notion page, not just left in this chat. Whenever a reply ' +
      'reports real, concrete progress - something you actually created, ' +
      'submitted, or found, or a real blocker you hit - end it with a fenced ' +
      `block exactly like this:\n\n${PROGRESS_FENCE_OPEN}\n- <bullet 1>\n` +
      `- <bullet 2>\n${PROGRESS_FENCE_CLOSE}\n\nRules for what belongs in it:`,
    '- Relevance test (the one that matters most): a bullet is only valid if ' +
      'it would plausibly belong in this exact task\'s own final Done: list - ' +
      'i.e. it IS part of, or a direct step toward, completing the Task named ' +
      'above. A true, specific, well-written fact that is not about this ' +
      'task\'s own deliverable still does not belong here, no matter how ' +
      'interesting - being concrete is not enough, it has to be on-topic too.',
    '- Each bullet names a concrete result, artifact, or blocker (a thing you ' +
      'created, a fact with its source, a specific obstacle) - never a ' +
      'status-of-effort line.',
    '- Never write bullets like "continuing to investigate", "making ' +
      'progress", "still working on this", or "looked into X" with no result ' +
      '- if there is nothing concrete yet, omit the block entirely.',
    '- At most 3 bullets, each one short sentence - cut it down, don\'t pad ' +
      'it out.',
    '- Most turns should have none at all. Only a genuine milestone earns ' +
      'one - this is not a routine status update, and it is not the ' +
      'action-items/options block above.',
    '',
    'Completion: this task is only marked done in Notion when you say so, so ' +
      'the bar is high. Emit the completion marker ONLY when every part of ' +
      'the task has actually been carried out by you.',
    `Do NOT emit it if any of these is true: a step is left for the user to do; ` +
      `you were blocked, or lacked access or credentials; the task asked you to ` +
      `DO something and you only researched, summarised or planned it; or you ` +
      `cannot verify the result.`,
    'Immediately before the marker, write your evidence as a fenced block exactly like ' +
      `this:\n\n${DONE_EVIDENCE_FENCE_OPEN}\n- <evidence for endstate item 1>\n` +
      `- <evidence for endstate item 2>\n${DONE_EVIDENCE_FENCE_CLOSE}\n\nIt must have ` +
      'exactly one line per bullet in the endstate checklist from your first reply, in ' +
      'the same order - each line naming the concrete evidence for that specific item ' +
      '(file path, URL, Notion page, command output), or saying plainly that the item ' +
      'no longer applies and why. If you cannot fill in every line, you are not done.',
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

// Mechanical, not a second LLM call: names exactly which checklist items look
// uncovered (done-evidence is required to map 1:1 onto endstate, in order) and
// asks the SAME session to reconcile before it's allowed to finish again.
function buildReconcileMessage(entry) {
  const endstate = entry.endstate || [];
  const got = (entry.lastDoneEvidence || []).length;
  const missing = endstate.slice(got);
  return [
    `Your last reply included ${DONE_MARKER}, but its ${DONE_EVIDENCE_FENCE_OPEN} block ` +
      `had ${got} line(s) while the ${ENDSTATE_FENCE_OPEN} checklist you set at the start ` +
      `of this task has ${endstate.length} item(s):`,
    ...endstate.map((e, i) => `${i + 1}. ${e}`),
    '',
    missing.length
      ? `Still missing evidence for: ${missing.map(e => `"${e}"`).join(', ')}.`
      : 'The count is off even though nothing is obviously missing above - double check the mapping is 1:1 and in order.',
    '',
    'Before emitting the marker again: either finish whatever is still outstanding, then ' +
      `re-emit a ${DONE_EVIDENCE_FENCE_OPEN} block with exactly one line per checklist ` +
      'item above, in the same order - or, for any item that genuinely no longer applies, ' +
      'say so explicitly on that item\'s line instead of omitting it. Do not emit the ' +
      `marker until ${DONE_EVIDENCE_FENCE_OPEN} has exactly ${endstate.length} line(s).`,
  ].join('\n');
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
      let text = isDone
        ? rawText.replace(/^[ \t]*<!--TASK_COMPLETE-->[ \t]*\n?/gm, '').trimEnd()
        : rawText;
      // Endstate is only ever read from the FIRST assistant turn - checked
      // here, before this turn is pushed below, so entry.turns still only
      // holds turns from strictly before this one.
      const isFirstAssistantTurn = !entry.turns.some(t => t.role === 'assistant');
      let endstateMatch, endstateItems;
      if (isFirstAssistantTurn) {
        endstateMatch = text.match(ENDSTATE_RE);
        if (endstateMatch) {
          endstateItems = endstateMatch[1]
            .split('\n')
            .map(l => l.trim().replace(/^[-*]\s*/, ''))
            .filter(Boolean);
        }
      }
      const doneEvidenceMatch = text.match(DONE_EVIDENCE_RE);
      let doneEvidence;
      if (doneEvidenceMatch) {
        doneEvidence = doneEvidenceMatch[1]
          .split('\n')
          .map(l => l.trim().replace(/^[-*]\s*/, ''))
          .filter(Boolean);
      }
      const actionItemsMatch = text.match(ACTION_ITEMS_RE);
      const optionsMatch = text.match(OPTIONS_RE);
      let actionItems;
      if (actionItemsMatch) {
        actionItems = actionItemsMatch[1]
          .split('\n')
          .map(l => l.trim().replace(/^[-*]\s*/, ''))
          .filter(Boolean);
      }
      let options;
      if (optionsMatch) {
        options = optionsMatch[1]
          .split('\n')
          .map(l => l.trim().replace(/^[-*]\s*/, ''))
          .filter(Boolean);
      }
      // Left inline in `text` (not cut, unlike action-items/options below) so
      // the chat transcript still shows it as-is - it renders as a plain
      // fenced code block, which is fine for a first pass with no dedicated
      // UI treatment yet.
      const progressMatch = text.match(PROGRESS_RE);
      let progress;
      if (progressMatch) {
        progress = progressMatch[1]
          .split('\n')
          .map(l => l.trim().replace(/^[-*]\s*/, ''))
          .filter(l => l.length >= MIN_PROGRESS_BULLET_LEN)
          .slice(0, MAX_PROGRESS_BULLETS_PER_TURN);
      }
      // Either/any of these blocks may be present - cut at whichever starts
      // first so trailing prose after a block never leaks back into `text`.
      const cutIndex = [actionItemsMatch, optionsMatch, endstateMatch, doneEvidenceMatch]
        .filter(Boolean)
        .reduce((min, m) => Math.min(min, m.index), Infinity);
      if (cutIndex !== Infinity) text = text.slice(0, cutIndex).trimEnd();
      const turn = { role: 'assistant', text: text.slice(0, TURN_TEXT_CAP), ts: Date.now() };
      if (actionItems && actionItems.length) turn.actionItems = actionItems;
      if (options && options.length) turn.options = options;
      if (progress && progress.length) turn.progress = progress;
      if (endstateItems && endstateItems.length) turn.endstate = endstateItems;
      if (doneEvidence && doneEvidence.length) turn.doneEvidence = doneEvidence;
      entry.turns.push(turn);
      live.currentAssistantText = '';
      entry.awaitingInput = true;
      if (isFirstAssistantTurn) {
        if (endstateItems && endstateItems.length) {
          entry.endstate = endstateItems;
          entry.endstateMissing = false;
        } else {
          entry.endstate = [];
          entry.endstateMissing = true;
        }
      }
      // The model - not the process exiting - decides "done". Only act on the
      // marker while this is still the entry actually tracked for `id`, so an
      // orphaned duplicate run (see the already-running guard in /start) can't
      // mark a task done out from under the real one.
      // `markedDone` means Notion really says Done, so it is set in the
      // .then() - never up front. `markDonePending` is the separate in-flight
      // guard that stops a second marker from firing a duplicate PATCH.
      if (isDone) {
        const endstateCount = (entry.endstate || []).length;
        // No endstate was ever captured (e.g. an older in-flight task, or the
        // model skipped it) - nothing to check coverage against, so fall back
        // to marker-only behavior rather than blocking on a gate with no
        // ground truth.
        const evidenceOk = endstateCount === 0 || (doneEvidence && doneEvidence.length === endstateCount);
        if (evidenceOk) {
          entry.doneMarkerSeen = true;
          if (!entry.markedDone && !entry.markDonePending && tracker.get(id) === entry) {
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
        } else {
          // Evidence-coverage gate failed: the model claimed done but its
          // done-evidence fence doesn't map 1:1 onto the endstate checklist it
          // committed to on turn 1. Do NOT mark done, do NOT set
          // doneMarkerSeen - runTurn's exit handler notices `pendingReconcile`
          // once this process has actually exited, and auto-continues the SAME
          // session asking it to reconcile, same as a real /reply. No human
          // needed unless it happens repeatedly (see MAX_EVIDENCE_RECONCILE_ATTEMPTS).
          entry.pendingReconcile = true;
          entry.lastDoneEvidence = doneEvidence || [];
        }
      }
      // Independent of markDone above - must never block or delay it, since
      // the Done checkbox is the more load-bearing of the two. Dedupes
      // against everything already filed for this task and enforces a hard
      // per-task ceiling, so a verbose or looping agent can't turn the
      // Notion page into noise even if it ignores the prompt's own restraint.
      if (turn.progress && turn.progress.length && tracker.get(id) === entry) {
        entry.filedProgress = entry.filedProgress || [];
        const seen = new Set(entry.filedProgress.map(s => s.toLowerCase()));
        const fresh = turn.progress.filter(b => !seen.has(b.toLowerCase()));
        const budget = MAX_PROGRESS_BULLETS_PER_TASK - entry.filedProgress.length;
        const toFile = fresh.slice(0, Math.max(0, budget));
        if (toFile.length) {
          entry.filedProgress.push(...toFile);
          notion.appendProgressNote(id, toFile).catch(err => {
            entry.progressNoteError = err.message;
            entry.tail = (entry.tail + `\n[progress-note failed] ${err.message}`).slice(-TAIL_BYTES);
            saveState();
          });
        }
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

  child.on('exit', (code, signal) => {
    entry.exitCode = code;
    if (entry.userFinished) {
      // Manually ended via /finish - possibly by killing this very process
      // (see that route) - so a non-zero/null exit code here must never read
      // as 'failed'.
      entry.status = 'finished';
      entry.awaitingInput = false;
    } else if (code !== 0) {
      entry.status = 'failed';
      entry.awaitingInput = false;
    } else if (entry.doneMarkerSeen) {
      // The model emitted the completion marker - the conversation is
      // genuinely over, not just between turns. Keyed on the marker, not on
      // `markedDone`: that one waits for Notion's PATCH to resolve, which
      // usually lands after this process has already exited.
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

    // Evidence-coverage gate follow-up: this turn claimed done but
    // parseStreamJson rejected it (see there). Auto-continue the same
    // conversation instead of leaving a human to notice - deferred to here
    // (after liveProcesses.delete(id) above) so the new turn's own
    // liveProcesses.set() below can't race with this process's own cleanup.
    // Bounded so a model that keeps getting it wrong eventually surfaces to a
    // person instead of looping forever.
    if (!entry.userFinished && code === 0 && entry.pendingReconcile) {
      entry.pendingReconcile = false;
      entry.evidenceMismatchCount = (entry.evidenceMismatchCount || 0) + 1;
      if (entry.evidenceMismatchCount <= MAX_EVIDENCE_RECONCILE_ATTEMPTS && entry.sessionId) {
        runTurn(id, entry, buildReconcileMessage(entry), ['--resume', entry.sessionId]);
      } else {
        entry.evidenceGateFailed = true;
        saveState();
      }
    }
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
    filedProgress: [],
    progressNoteError: null,
    userFinished: false,
    sessionId: null,
    cwd,
    endstate: null,
    endstateMissing: false,
    pendingReconcile: false,
    lastDoneEvidence: [],
    evidenceMismatchCount: 0,
    evidenceGateFailed: false,
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
          progressNoteError: entry.progressNoteError || null,
          userFinished: Boolean(entry.userFinished),
          endstate: entry.endstate || null,
          endstateMissing: Boolean(entry.endstateMissing),
          lastDoneEvidence: entry.lastDoneEvidence || [],
          evidenceGateFailed: Boolean(entry.evidenceGateFailed),
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

    m = url.match(/^\/api\/tasks\/([^/]+)\/mark-done$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      // Manual fallback for when the model never emits its completion marker
      // (errored out, ran out of turns, task was actually finished by hand,
      // etc.) - works even for a task that was never run through this app.
      // Also doubles as "I'm done with this conversation": if no turn is in
      // flight, finalize status immediately; if one IS in flight, its own
      // exit handler finalizes once it completes (see runTurn), so the
      // current reply isn't cut off mid-turn.
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
        if (!liveProcesses.has(id)) {
          entry.status = 'finished';
          entry.awaitingInput = false;
        }
        saveState();
      }
      return sendJson(res, 200, { ok: true });
    }

    m = url.match(/^\/api\/tasks\/([^/]+)\/finish$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const entry = tracker.get(id);
      if (!entry || entry.status !== 'running') {
        return sendJson(res, 400, { ok: false, error: 'not running' });
      }
      // Manual kill-switch, independent of Notion: ends the chat session
      // right now without touching the task's Done state (that's mark-done's
      // job). If a turn is in flight, kill it - the exit handler above checks
      // userFinished first, so the kill is never reported as 'failed'.
      entry.userFinished = true;
      const live = liveProcesses.get(id);
      if (live) {
        live.child.kill('SIGTERM');
      } else {
        entry.status = 'finished';
        entry.awaitingInput = false;
      }
      saveState();
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

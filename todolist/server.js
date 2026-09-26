// Zero-dependency todolist server: reads open Notion tasks (only on refresh),
// spawns headless `claude` runs for whichever task you pick, tracks them
// in-memory (polled separately, no extra Notion calls). The model can only
// FLAG a task as done (see DONE_MARKER below), which ends the chat session -
// it has no ability to mark a task done in Notion itself. Only the user can
// do that, via the mark-done route/checkbox (see /api/tasks/:id/mark-done).
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
const crypto = require('crypto');
const os = require('os');
const { spawn, execFile } = require('child_process');

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
//        markedDone, doneMarkerSeen, sessionId, cwd, kind}
// `kind` is 'notion' (id = Notion page id, the original/only kind), 'adhoc'
// (id = `adhoc:<uuid>`, a free-standing session started from the UI with no
// Notion task behind it) or 'external' (id = `ext:<sessionId>`, a session
// discovered already running elsewhere on the machine and adopted into this
// UI - see /api/external-sessions below). Only 'notion' entries ever touch
// Notion (mark-done, progress notes) - see the `entry.kind === 'notion'`
// guards in parseStreamJson/runTurn.
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
      // Every entry persisted before the `kind` field existed is a Notion
      // task (the only kind there was) - normalize here, once, so every
      // `entry.kind === 'notion'` check elsewhere (the /api/sessions listing,
      // the progress/waiting Notion-write guards) doesn't have to special-
      // case "missing" as well as "notion".
      if (!entry.kind) {
        entry.kind = 'notion';
        changed = true;
      }
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
const WAITING_FENCE_OPEN = '```waiting';
const WAITING_FENCE_CLOSE = '```';
const WAITING_RE = /```waiting\s*\n([\s\S]*?)```/;
// Model-independent backstops against a verbose or looping agent turning the
// Notion task page into noise - the prompt asks for restraint, but these caps
// hold regardless of whether it listens.
const MAX_PROGRESS_BULLETS_PER_TURN = 8;
const MAX_PROGRESS_BULLETS_PER_TASK = 25;
const MIN_PROGRESS_BULLET_LEN = 8;

const CREATE_TASK_FENCE_OPEN = '```create-task';
const CREATE_TASK_FENCE_CLOSE = '```';
const CREATE_TASK_RE = /```create-task\s*\n([\s\S]*?)```/;
// Same reasoning as MAX_PROGRESS_BULLETS_PER_TASK above - a backstop against
// a looping/verbose agent spawning many tasks, independent of whether it
// honors the prompt's own "only when the user explicitly asks" instruction.
const MAX_CREATED_TASKS_PER_TASK = 5;
const DUE_DATE_LINE_RE = /^due:\s*(\d{4}-\d{2}-\d{2})\s*$/im;

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

// Payment approval hard-gate: enforced by a real PreToolUse hook (see
// ensurePaymentGateHook/hooks/payment-gate.js), not by asking the model to
// stop - this is a backstop for when it doesn't. Detection runs over every
// browser tool RESULT the agent sees (page text, form contents, etc.) as it
// streams past in parseStreamJson, independent of anything the model itself
// says. A match arms the gate for whatever this specific detection was; a
// LATER independent match re-arms it (and clears any earlier approval) - one
// approval only ever covers the episode it was granted for. Starter list,
// deliberately tuned toward over-triggering (a false positive just costs one
// extra click) rather than missing a real payment.
const PAYMENT_SIGNAL_RE = /\b(place order|complete purchase|complete your purchase|pay now|proceed to checkout|checkout|card number|cvv|cvc|expiration date|billing address|confirm and pay|buy now)\b/i;
// Only the tools that can actually submit/commit something - not the
// read-only ones (read_page, get_page_text, find, navigate, tabs_*), which
// can't pay for anything by themselves.
const PAYMENT_GATE_TOOLS = [
  'mcp__claude-in-chrome__computer',
  'mcp__claude-in-chrome__form_input',
  'mcp__claude-in-chrome__javascript_tool',
  'mcp__claude-in-chrome__file_upload',
];
const PAYMENT_GATE_HOOK_PATH = path.join(ROOT, 'hooks', 'payment-gate.js');

// The prompt is the ONLY steering this loop has - there's no --system-prompt
// and no --allowedTools on the spawn, so every behavioural rule lives here.
// It is deliberately act-first: an earlier version framed the browser as a
// fallback ("use it for anything behind a login"), and runs reliably answered
// by web-searching and writing an Obsidian note instead of doing the task.
//
// Shared by every headless session, Notion-task or not (see buildPrompt /
// buildAdhocPrompt below) - hand-back, options, waiting, endstate/done-
// evidence, completion marker. `allowProgressNotes` gates only the bits that
// write onto a Notion task page - a free-standing session has no such page.
// It also gates the create-task convention below, for the same reason: both
// need a real parent task page to write onto / relate a new task to.
function buildSessionConventions({ allowProgressNotes, hasExplicitWorkdir }) {
  const lines = [
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
      'above for when writing there is).' +
      (allowProgressNotes
        ? ' Tasks and deadlines are tracked in Notion; the ' +
          'notes above are already pulled from there for this task. You do not have a direct ' +
          'Notion tool, and do not need one - ending a reply with a progress block (below) is ' +
          'how what you did gets written onto this task\'s Notion page for you.'
        : ''),
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
      'usefully split up, use one bullet for it. Never omit this block on your first reply. ' +
      'If the deliverable is content the user is meant to keep and follow later (a plan, ' +
      'routine, checklist, itinerary, draft), phrase the bullet as that content existing ' +
      'somewhere the user will actually find it afterward - not as it having been said once ' +
      'in this chat, which is not the same thing.',
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
    'Waiting: sometimes a task genuinely cannot move forward today - not because you ' +
      'need something from the user right now, but because it is blocked on something ' +
      'external: a reply you are expecting, a delivery, a scheduled event, a cooldown, ' +
      'or a fixed amount of time that simply has to pass. Checking back sooner has no ' +
      'value here. This is different from "Handing back" above (needing the user to act ' +
      'right now) and from "Options" (a small concrete choice) - use Waiting only when ' +
      'the honest answer to "what happens next" is "nothing, yet". End the reply with a ' +
      `fenced block exactly like this:\n\n${WAITING_FENCE_OPEN}\n<what you are waiting ` +
      `for, and roughly when it makes sense to check back, if there is a natural time>\n` +
      `${WAITING_FENCE_CLOSE}\n\nFree text, a sentence or two, not a list. Omit this block ` +
      'entirely unless the task is genuinely stalled on something outside anyone\'s ' +
      'control right now.',
  );
  if (allowProgressNotes) {
    lines.push(
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
      '- If this task\'s whole job IS to produce something the user is meant to ' +
        'keep and follow later - a plan, routine, checklist, shopping list, ' +
        'itinerary, or draft text, as opposed to a task where you take actions and ' +
        'report what happened - then that content is the deliverable, and the ' +
        'progress block must carry the actual content itself, not just a mention ' +
        'that you wrote it. Leaving it only in this chat reply does not complete a ' +
        'task like that - the chat is not where the user will look for it afterward, ' +
        'the Notion page is. This is the one case where the block is mandatory, not ' +
        'optional. Only a handful of bullets actually get filed, so pack the content ' +
        'into a few dense bullets (e.g. one per major section - "immediate steps: ...", ' +
        '"daily routine: ...", "when to escalate: ...") rather than one bullet per ' +
        'small step - a bullet that\'s a full sentence or two of real substance is ' +
        'correct here, not a fragment.',
      '- Each bullet names a concrete result, artifact, or blocker (a thing you ' +
        'created, a fact with its source, a specific obstacle) - never a ' +
        'status-of-effort line. The content-deliverable case above is the one ' +
        'exception to "no status-of-effort": it is the deliverable itself, not a ' +
        'status update, so it belongs even though it is the only bullet that turn.',
      '- Never write bullets like "continuing to investigate", "making ' +
        'progress", "still working on this", or "looked into X" with no result ' +
        '- if there is nothing concrete yet, omit the block entirely.',
      '- At most 3 bullets, each one short sentence - cut it down, don\'t pad ' +
        'it out.',
      '- Most turns should have none at all. Only a genuine milestone earns ' +
        'one - this is not a routine status update, and it is not the ' +
        'action-items/options block above.'
    );
    lines.push(
      '',
      'Creating a new task: you may put a brand-new task onto the Tasks list, ' +
        'but ONLY when the user has explicitly asked, in this conversation, for ' +
        'something to be written down or tracked as a task - never on your own ' +
        'judgment that something *should* become a task. If they mention ' +
        'something in passing without asking you to track it, do not create ' +
        'one. The new task is automatically linked to this same task\'s own ' +
        'project - you never choose, name, or specify a project yourself, only ' +
        `a title. End the reply with a fenced block exactly like this:\n\n` +
        `${CREATE_TASK_FENCE_OPEN}\n<short task title>\ndue: <YYYY-MM-DD, ` +
        `only if a due date was actually mentioned>\n${CREATE_TASK_FENCE_CLOSE}` +
        `\n\nThe due line is optional - omit it entirely when no due date was ` +
        'given. Only one task per block; if the user asked for more than one, ' +
        'create the most important one now and mention the rest in your reply.'
    );
  }
  lines.push(
    '',
    allowProgressNotes
      ? 'Completion: emitting the completion marker below ends this chat session, ' +
        'so the bar is high - but it does not mark this task done in Notion, and ' +
        'never will. Only the user can do that themselves, once they\'re satisfied ' +
        '- that power is theirs alone. Emit the marker ONLY when every part of the ' +
        'task has actually been carried out by you.'
      : 'Completion: emitting the completion marker below ends this chat session, ' +
        'so the bar is high. Emit the marker ONLY when every part of the task has ' +
        'actually been carried out by you.',
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
  return lines;
}

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
  ];
  return lines
    .concat(buildSessionConventions({ allowProgressNotes: true, hasExplicitWorkdir }))
    .join('\n');
}

// Free-standing session, not tied to any Notion task - same conventions,
// minus anything that writes onto a Notion page (there isn't one).
function buildAdhocPrompt(name, instructions, hasExplicitWorkdir) {
  const lines = [
    `Session: ${name || '(untitled)'}`,
    '',
    'Instructions:',
    instructions && instructions.trim() ? instructions.trim() : 'none',
    '',
  ];
  return lines
    .concat(buildSessionConventions({ allowProgressNotes: false, hasExplicitWorkdir }))
    .join('\n');
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

// A tool_result's `content` can be a bare string or an array of blocks (text,
// image, etc.) - only the text blocks are relevant to the payment classifier.
function extractToolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c && c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text)
      .join('\n');
  }
  return '';
}

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
      // Same "left inline, no dedicated UI" treatment as progress above.
      const createTaskMatch = text.match(CREATE_TASK_RE);
      let createTask;
      if (createTaskMatch) {
        const dueMatch = createTaskMatch[1].match(DUE_DATE_LINE_RE);
        const title = createTaskMatch[1]
          .split('\n')
          .map(l => l.trim())
          .find(l => l && !DUE_DATE_LINE_RE.test(l));
        if (title) createTask = { title: title.slice(0, 200), dueDate: dueMatch ? dueMatch[1] : undefined };
      }
      // A task already ending (done marker) can't also be "waiting" - avoid
      // the two states colliding on the same turn.
      const waitingMatch = !isDone ? text.match(WAITING_RE) : null;
      const waitingReason = waitingMatch ? waitingMatch[1].trim() : undefined;
      // Either/any of these blocks may be present - cut at whichever starts
      // first so trailing prose after a block never leaks back into `text`.
      const cutIndex = [actionItemsMatch, optionsMatch, endstateMatch, doneEvidenceMatch, waitingMatch]
        .filter(Boolean)
        .reduce((min, m) => Math.min(min, m.index), Infinity);
      if (cutIndex !== Infinity) text = text.slice(0, cutIndex).trimEnd();
      const turn = { role: 'assistant', text: text.slice(0, TURN_TEXT_CAP), ts: Date.now() };
      if (actionItems && actionItems.length) turn.actionItems = actionItems;
      if (options && options.length) turn.options = options;
      if (progress && progress.length) turn.progress = progress;
      if (createTask) turn.createTask = createTask;
      if (endstateItems && endstateItems.length) turn.endstate = endstateItems;
      if (doneEvidence && doneEvidence.length) turn.doneEvidence = doneEvidence;
      if (waitingReason) turn.waiting = waitingReason;
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
      // The model - not the process exiting - decides the CONVERSATION is
      // done, via `doneMarkerSeen` (ends the chat session, see runTurn's exit
      // handler). It never touches Notion itself - the Done checkbox only
      // ever flips via the human-driven /mark-done route below. Only act on
      // the marker while this is still the entry actually tracked for `id`,
      // so an orphaned duplicate run (see the already-running guard in
      // /start) can't flag a task out from under the real one.
      if (isDone) {
        const endstateCount = (entry.endstate || []).length;
        // No endstate was ever captured (e.g. an older in-flight task, or the
        // model skipped it) - nothing to check coverage against, so fall back
        // to marker-only behavior rather than blocking on a gate with no
        // ground truth.
        const evidenceOk = endstateCount === 0 || (doneEvidence && doneEvidence.length === endstateCount);
        if (evidenceOk) {
          entry.doneMarkerSeen = true;
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
      // Staged for runTurn's exit handler (same pattern as pendingReconcile
      // above) - the Notion write and the status transition to 'waiting'
      // happen once this process has actually exited, not while it's still
      // live, same reasoning as the progress-note filing just below.
      if (waitingReason && tracker.get(id) === entry) {
        entry.pendingWaiting = true;
        entry.waitingReason = waitingReason;
      }
      // Independent of doneMarkerSeen above - must never block or delay it.
      // Dedupes against everything already filed for this task and enforces
      // a hard per-task ceiling, so a verbose or looping agent can't turn the
      // Notion page into noise even if it ignores the prompt's own restraint.
      // Notion-only: adhoc/external sessions have no page to file onto (see
      // buildAdhocPrompt, which never even asks for a progress block).
      if (entry.kind === 'notion' && turn.progress && turn.progress.length && tracker.get(id) === entry) {
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
      // Same shape as the progress-note filing above: independent of
      // doneMarkerSeen, deduped, hard-capped against a looping agent.
      // `entry.parentRelation` (snapshotted in startTask from the PARENT
      // task's own page, never from anything the model outputs) is the only
      // source of the new task's project relation - the model supplies a
      // title and optional due date, nothing else.
      if (entry.kind === 'notion' && turn.createTask && tracker.get(id) === entry) {
        entry.createdTaskTitles = entry.createdTaskTitles || [];
        const alreadyCreated = entry.createdTaskTitles.some(
          t => t.toLowerCase() === turn.createTask.title.toLowerCase()
        );
        if (!alreadyCreated && entry.createdTaskTitles.length < MAX_CREATED_TASKS_PER_TASK) {
          entry.createdTaskTitles.push(turn.createTask.title);
          notion.createTask({
            title: turn.createTask.title,
            relationIds: entry.parentRelation || [],
            dueDate: turn.createTask.dueDate,
          }).then(created => {
            entry.createdTasks = entry.createdTasks || [];
            entry.createdTasks.push(created.id);
            saveState();
          }).catch(err => {
            entry.createTaskError = err.message;
            entry.tail = (entry.tail + `\n[create-task failed] ${err.message}`).slice(-TAIL_BYTES);
            saveState();
          });
        }
      }
      saveState();
    } else if (obj.type === 'assistant') {
      // Payment-gate detection, part 1: remember which tool name each
      // tool_use id belongs to, so when its RESULT arrives (below) the
      // classifier can report which tool produced the flagged content.
      const content = obj.message && obj.message.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && c.type === 'tool_use' && c.id) {
            live.toolNameByUseId = live.toolNameByUseId || {};
            live.toolNameByUseId[c.id] = c.name;
          }
        }
      }
    } else if (obj.type === 'user') {
      // Payment-gate detection, part 2: scan every browser tool RESULT (page
      // text, form contents, etc.) for payment-page signals, independent of
      // anything the model itself says or does - see PAYMENT_SIGNAL_RE and
      // the PreToolUse hook (hooks/payment-gate.js) that actually enforces
      // this. A later, independent detection re-arms the gate and clears any
      // earlier approval - one approval only covers the episode it was for.
      const content = obj.message && obj.message.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && c.type === 'tool_result') {
            const toolName = (live.toolNameByUseId || {})[c.tool_use_id] || 'unknown-tool';
            const resultText = extractToolResultText(c.content);
            const signal = resultText && resultText.match(PAYMENT_SIGNAL_RE);
            if (signal) {
              entry.paymentGateArmed = true;
              entry.paymentApproved = false;
              entry.paymentGateReason = `via ${toolName}: "...${signal[0]}..."`;
              saveState();
            }
          }
        }
      }
    }
    // system/rate_limit_event/other stream_event subtypes: ignored for the
    // turn transcript (raw tail still has everything).
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
      // Repeated on every resumed invocation too, same reason as
      // --permission-mode above: nothing about a prior turn's process
      // carries forward, and entry.model is fixed for the whole
      // conversation (set once in startTask). Falls back for any entry
      // persisted before this field existed.
      '--model', entry.model || config.MODEL_DEFAULT,
      // Claude in Chrome. Verified to attach to a headless `claude -p` child
      // (the init event lists mcp__claude-in-chrome__*, server 'connected'),
      // so this is NOT interactive-only - don't drop it again. Without it the
      // agent has literally zero browser tools: the only MCP server on this
      // machine is project-scoped to the repo, and these runs use the vault as
      // cwd, so they inherit nothing. Needs Chrome running with the extension.
      '--chrome',
      ...extraArgs,
    ],
    {
      cwd: entry.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Lets the payment-gate PreToolUse hook (a subprocess of this `claude`
      // process, so it inherits this env) identify which task/server to call
      // back into - see ensurePaymentGateHook / hooks/payment-gate.js.
      env: { ...process.env, TODOLIST_TASK_ID: id, TODOLIST_PORT: String(config.PORT) },
    }
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
    // Must read before liveProcesses.delete() below - only source of any
    // partial assistant text this killed turn produced (see interrupt below).
    const live = liveProcesses.get(id);
    const wasInterrupted = entry.interruptRequested;

    if (entry.sessionEndedByUser) {
      // Manually ended - either by /mark-done killing a still-running task,
      // or (formerly) /finish - so a non-zero/null exit code here must never
      // read as 'failed'.
      entry.status = 'finished';
      entry.awaitingInput = false;
    } else if (wasInterrupted) {
      // User hit Interrupt: stop THIS turn, not the conversation - unlike
      // sessionEndedByUser above, this always comes back to 'running' so a
      // fresh reply (or a flushed queued message, see below) can resume it.
      // No `result` event ever fired for this killed turn, so there's no
      // parsed assistant turn for it yet - synthesize one from whatever text
      // had streamed in, so the transcript doesn't just silently skip it.
      entry.interruptRequested = false;
      const partial = (live && live.currentAssistantText) || '';
      entry.turns.push({
        role: 'assistant',
        text: (partial.trim() || '_(interrupted before producing any output)_').slice(0, TURN_TEXT_CAP),
        ts: Date.now(),
        interrupted: true,
      });
      entry.status = 'running';
      entry.awaitingInput = true;
    } else if (code !== 0) {
      entry.status = 'failed';
      entry.awaitingInput = false;
    } else if (entry.doneMarkerSeen) {
      // The model emitted the completion marker - the conversation is
      // genuinely over, not just between turns. Keyed on the marker, not on
      // `markedDone`: the model's marker never touches Notion itself (see
      // parseStreamJson) - only the user's own mark-done click does that,
      // independently of whether this chat session has ended.
      entry.status = 'finished';
      entry.awaitingInput = false;
    } else if (entry.pendingWaiting) {
      // Model ended this reply with a `waiting` block: this task is blocked
      // on something external for now, not on the user - see parseStreamJson.
      // awaitingInput is already true (set there for every normal turn end),
      // so a direct reply still works too, in addition to the Resume button.
      entry.pendingWaiting = false;
      entry.status = 'waiting';
      // Notion-only, same reason as the progress-filing guard above.
      if (entry.kind === 'notion') {
        notion.appendProgressNote(id, ['⏳ Waiting: ' + entry.waitingReason]).catch(err => {
          entry.progressNoteError = err.message;
          entry.tail = (entry.tail + `\n[progress-note failed] ${err.message}`).slice(-TAIL_BYTES);
          saveState();
        });
      }
    }
    // Otherwise: this was just an ordinary turn finishing. Leave `status`
    // as 'running' (parseStreamJson already set awaitingInput = true) -
    // the next /reply resumes the conversation with a brand new process
    // (see /reply below). The process itself is gone either way, hence:
    logStream.end();
    liveProcesses.delete(id);
    saveState();

    const conversationStillOpen = entry.status === 'running' || entry.status === 'waiting';

    // Evidence-coverage gate follow-up: this turn claimed done but
    // parseStreamJson rejected it (see there). Auto-continue the same
    // conversation instead of leaving a human to notice - deferred to here
    // (after liveProcesses.delete(id) above) so the new turn's own
    // liveProcesses.set() below can't race with this process's own cleanup.
    // Bounded so a model that keeps getting it wrong eventually surfaces to a
    // person instead of looping forever. Takes priority over a queued-message
    // flush below (returns early) - a reconcile reply isn't the user's turn.
    if (!entry.sessionEndedByUser && !wasInterrupted && code === 0 && entry.pendingReconcile) {
      entry.pendingReconcile = false;
      entry.evidenceMismatchCount = (entry.evidenceMismatchCount || 0) + 1;
      if (entry.evidenceMismatchCount <= MAX_EVIDENCE_RECONCILE_ATTEMPTS && entry.sessionId) {
        runTurn(id, entry, buildReconcileMessage(entry), ['--resume', entry.sessionId]);
        return;
      } else {
        entry.evidenceGateFailed = true;
        saveState();
      }
    }

    // Queued-message flush: fires whether this was an ordinary turn ending,
    // an interrupted turn (immediately resuming), or a waiting turn - any
    // case where it's genuinely the user's turn to talk and they'd already
    // typed something in while busy (see /reply's `busy` branch).
    if (conversationStillOpen && entry.awaitingInput && entry.queuedMessages && entry.queuedMessages.length && entry.sessionId) {
      const merged = entry.queuedMessages.join('\n\n');
      entry.queuedMessages = [];
      runTurn(id, entry, merged, ['--resume', entry.sessionId]);
    }
  });
}

// Registers the payment-gate PreToolUse hook (see hooks/payment-gate.js) for
// this task's working directory, by read-modify-writing its .claude/settings.json
// - never overwriting it wholesale, since `cwd` is often the user's own
// Obsidian vault root (or a custom workdir) that may already carry its own
// settings/hooks there. Idempotent: a no-op once every gated tool already has
// a matching entry, so this can safely run on every task start.
//
// NOTE: the exact hooks.PreToolUse schema and this project's hook script's
// deny-JSON contract are UNVERIFIED against the installed Claude Code CLI
// version - see the plan's payment-gate section. Do not trust this gate for
// anything real until it has been smoke-tested end-to-end (a staged fake
// checkout page, confirming an actual denial in the raw log) - a
// misconfigured hook fails OPEN and silent, which is worse than no gate.
function ensurePaymentGateHook(cwd) {
  const settingsDir = path.join(cwd, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {}
  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
  const command = `node ${JSON.stringify(PAYMENT_GATE_HOOK_PATH)}`;
  const missing = PAYMENT_GATE_TOOLS.filter(toolName =>
    !settings.hooks.PreToolUse.some(
      e => e.matcher === toolName && (e.hooks || []).some(h => h.command === command)
    )
  );
  if (!missing.length) return;
  for (const toolName of missing) {
    settings.hooks.PreToolUse.push({ matcher: toolName, hooks: [{ type: 'command', command }] });
  }
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error(`[payment-gate] failed to write ${settingsPath}: ${err.message}`);
  }
}

async function startTask(id, instructions, workdir, model) {
  const task = taskCache.get(id);
  if (!task) throw new Error('unknown task id (refresh the task list first)');
  if (liveProcesses.has(id)) throw new Error('task already running');

  const notes = await notion.getPageBlocks(id);
  const cwd = (workdir || '').trim() || config.VAULT;
  const prompt = buildPrompt(task, notes, instructions, Boolean((workdir || '').trim()));
  // Never trust the client value straight into spawn args - fall back to
  // the configured default for anything outside the known set.
  const resolvedModel = config.MODEL_OPTIONS.includes(model) ? model : config.MODEL_DEFAULT;

  const entry = {
    kind: 'notion',
    status: 'running',
    startedAt: Date.now(),
    exitCode: null,
    tail: '',
    logFile: path.join(LOGS_DIR, `${id}-${Date.now()}.log`),
    turns: [],
    model: resolvedModel,
    awaitingInput: false,
    markedDone: false,
    doneMarkerSeen: false,
    markDoneError: null,
    filedProgress: [],
    progressNoteError: null,
    // Snapshotted once here from the PARENT task's own page - the only
    // source of truth the create-task convention ever uses for the new
    // task's relation (see parseStreamJson). Never re-read from taskCache
    // later, since this session can outlive whatever taskCache holds.
    parentRelation: task.relationIds || [],
    createdTasks: [],
    createdTaskTitles: [],
    createTaskError: null,
    sessionEndedByUser: false,
    sessionId: null,
    cwd,
    endstate: null,
    endstateMissing: false,
    pendingReconcile: false,
    lastDoneEvidence: [],
    evidenceMismatchCount: 0,
    evidenceGateFailed: false,
    interruptRequested: false,
    queuedMessages: [],
    pendingWaiting: false,
    waitingReason: null,
    paymentGateArmed: false,
    paymentGateReason: null,
    paymentApproved: false,
  };
  tracker.set(id, entry);
  saveState();

  ensurePaymentGateHook(cwd);
  runTurn(id, entry, prompt, []);
}

// Free-standing session, not tied to a Notion task - see buildAdhocPrompt.
// Id is prefixed so it can never collide with a Notion page id or an
// `ext:<sessionId>` adopted id (see adoptExternalSession).
function startAdhocSession(name, instructions, workdir, model) {
  const id = `adhoc:${crypto.randomUUID()}`;
  const hasExplicitWorkdir = Boolean((workdir || '').trim());
  const cwd = (workdir || '').trim() || config.VAULT;
  const prompt = buildAdhocPrompt(name, instructions, hasExplicitWorkdir);
  const resolvedModel = config.MODEL_OPTIONS.includes(model) ? model : config.MODEL_DEFAULT;

  const entry = {
    kind: 'adhoc',
    name: (name || '').trim() || null,
    status: 'running',
    startedAt: Date.now(),
    exitCode: null,
    tail: '',
    logFile: path.join(LOGS_DIR, `${id.replace(':', '-')}-${Date.now()}.log`),
    turns: [],
    model: resolvedModel,
    awaitingInput: false,
    sessionEndedByUser: false,
    sessionId: null,
    cwd,
    endstate: null,
    endstateMissing: false,
    pendingReconcile: false,
    lastDoneEvidence: [],
    evidenceMismatchCount: 0,
    evidenceGateFailed: false,
    interruptRequested: false,
    queuedMessages: [],
    pendingWaiting: false,
    waitingReason: null,
    paymentGateArmed: false,
    paymentGateReason: null,
    paymentApproved: false,
  };
  tracker.set(id, entry);
  saveState();

  ensurePaymentGateHook(cwd);
  runTurn(id, entry, prompt, []);
  return id;
}

// Runs `claude agents --json` (no shell) and returns the parsed array, or []
// on any failure - discovery is best-effort and must never crash a poll.
function listAgentsJson() {
  return new Promise(resolve => {
    execFile('claude', ['agents', '--json'], { timeout: 5000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ agents: [], error: err.message });
      try {
        const agents = JSON.parse(stdout);
        resolve({ agents: Array.isArray(agents) ? agents : [], error: null });
      } catch (e) {
        resolve({ agents: [], error: 'could not parse `claude agents --json` output' });
      }
    });
  });
}

// Every sessionId already tracked here, whatever its kind - an external
// session already adopted (or, in principle, one that happens to be a task/
// adhoc session this server itself spawned) is never re-offered for adoption.
function trackedSessionIds() {
  const ids = new Set();
  for (const entry of tracker.values()) {
    if (entry.sessionId) ids.add(entry.sessionId);
  }
  return ids;
}

// `claude agents --json` only reports when a session STARTED, never when it
// last did anything - so a terminal idle for 10 minutes and one idle for 2
// weeks report identically. The session's own transcript file (the CLI's
// real record of activity, one per session under
// ~/.claude/projects/<cwd with every non-alnum/dash char turned into '-'>/
// <sessionId>.jsonl - encoding scheme confirmed against this machine's real
// project directories) has a last-modified time that's the only reliable
// "last active" signal available. Best-effort: a missing/unreadable file
// (moved cwd, unusual permissions, etc.) just means "unknown", not an error.
function sessionLastActivity(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  try {
    const projectDir = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
    const file = path.join(os.homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

// Discovery only - see adoptExternalSession for the actual handoff. Shaped
// for the UI: only 'background' agents are adoptable (a `claude stop <id>`
// exists for them); 'interactive' ones (someone's live terminal) are
// read-only, see the plan's scope-boundary note.
async function getExternalSessions() {
  const { agents, error } = await listAgentsJson();
  const tracked = trackedSessionIds();
  const sessions = agents
    .filter(a => a.sessionId && !tracked.has(a.sessionId))
    .map(a => ({
      agentId: a.id || null,
      sessionId: a.sessionId,
      name: a.name || null,
      cwd: a.cwd || null,
      kind: a.kind || 'unknown',
      status: a.status || a.state || null,
      waitingFor: a.waitingFor || null,
      startedAt: a.startedAt || null,
      lastActivityAt: sessionLastActivity(a.cwd, a.sessionId),
      adoptable: a.kind === 'background' && Boolean(a.id),
    }));
  return { sessions, error };
}

// Short-id shape `claude --bg`/`claude agents` prints (see `claude --help`) -
// validated before it's ever passed to execFile, even though execFile itself
// (no shell) already rules out injection - defense in depth against a
// malformed/hostile id reaching the CLI at all.
const AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/;

// Adopts a background session discovered via getExternalSessions: stops its
// daemon-managed live process (conversation is kept - `claude stop` says so
// itself, see `claude stop --help`) and creates a tracker entry that
// `/reply` can `--resume` exactly like any task/adhoc session. Always
// re-fetches the agent list rather than trusting client-supplied data, since
// the client's copy could be stale by the time this runs.
async function adoptExternalSession(agentId) {
  if (!AGENT_ID_RE.test(agentId)) throw new Error('invalid session id');
  const { agents } = await listAgentsJson();
  const agent = agents.find(a => a.id === agentId);
  if (!agent) throw new Error('session not found (it may have already exited)');
  if (agent.kind !== 'background') throw new Error('only background sessions can be adopted');
  if (!agent.sessionId) throw new Error('session has no resumable session id yet');

  const id = `ext:${agent.sessionId}`;
  if (tracker.has(id)) throw new Error('already adopted');

  // Best-effort: if the session already exited on its own (or `stop` fails
  // for some other reason) the resume below still works via `--resume` once
  // no live process holds it - so a stop failure here is logged, not fatal.
  const stopError = await new Promise(resolve => {
    execFile('claude', ['stop', agentId], { timeout: 10000 }, (err, stdout, stderr) => {
      resolve(err ? (stderr || err.message).trim() : null);
    });
  });

  const entry = {
    kind: 'external',
    name: agent.name || null,
    status: 'running',
    startedAt: Date.now(),
    exitCode: null,
    tail: '',
    logFile: path.join(LOGS_DIR, `${id.replace(/[:/]/g, '-')}-${Date.now()}.log`),
    turns: [],
    // No locally-known model for a session this server never started - left
    // unset so runTurn falls back to config.MODEL_DEFAULT on the next reply.
    // See the plan's open question: this can silently change the model an
    // in-progress conversation was using.
    model: null,
    awaitingInput: true,
    sessionEndedByUser: false,
    sessionId: agent.sessionId,
    cwd: agent.cwd || config.VAULT,
    endstate: null,
    endstateMissing: false,
    pendingReconcile: false,
    lastDoneEvidence: [],
    evidenceMismatchCount: 0,
    evidenceGateFailed: false,
    interruptRequested: false,
    queuedMessages: [],
    pendingWaiting: false,
    waitingReason: null,
    paymentGateArmed: false,
    paymentGateReason: null,
    paymentApproved: false,
    adoptedNote: 'Adopted from an existing Claude Code session - earlier turns are not shown here, only what happens from now on.',
    adoptStopError: stopError,
  };
  tracker.set(id, entry);
  saveState();
  return id;
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

// Gates every /api/* route from one chokepoint (see the check in the request
// handler below), so the server is safe to expose to the whole tailnet, not
// just localhost. If TODOLIST_TOKEN isn't set yet, auth is a no-op - don't
// lock out localhost usage before the env var has been configured.
function isAuthed(req) {
  if (!config.TODOLIST_TOKEN) return true;
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const headerToken = req.headers['x-todolist-token'];
  const queryToken = new URL(req.url, 'http://x').searchParams.get('token');
  return (bearer || headerToken || queryToken) === config.TODOLIST_TOKEN;
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

const TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Anything servable with no token, so the page itself can load and prompt for
// one (see isAuthed above). Deliberately an allowlist, not "everything under
// ROOT that isn't ../.env" - state.json (task transcripts) and logs/*.log
// live under ROOT too and must never be directly fetchable.
const STATIC_ALLOW = /^\/(index\.html|manifest\.json|vendor\/[^/]+|icons\/[^/]+)$/;

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (url.startsWith('/api/') && !isAuthed(req)) {
    return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  }

  try {
    if (url === '/api/tasks' && req.method === 'GET') {
      const tasks = await getTasks();
      return sendJson(res, 200, tasks);
    }

    if (url === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, { defaultModel: config.MODEL_DEFAULT, models: config.MODEL_OPTIONS });
    }

    // Top-left "Day" column: Tasks/Events due on `date` (viewer-local, via
    // `tz` = that date's UTC-offset in minutes, JS getTimezoneOffset()
    // convention) plus the always-open Shopping List. See notion.getDayView.
    if (url === '/api/day' && req.method === 'GET') {
      const params = new URL(req.url, 'http://x').searchParams;
      const date = params.get('date');
      const tz = Number(params.get('tz'));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(tz)) {
        return sendJson(res, 400, { ok: false, error: 'bad date/tz' });
      }
      try {
        const day = await notion.getDayView(date, tz);
        return sendJson(res, 200, day);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    if (url === '/api/status' && req.method === 'GET') {
      const obj = {};
      for (const [id, entry] of tracker.entries()) {
        const live = liveProcesses.get(id);
        obj[id] = {
          kind: entry.kind || 'notion',
          name: entry.name || null,
          cwd: entry.cwd || null,
          adoptedNote: entry.adoptedNote || null,
          status: entry.status,
          startedAt: entry.startedAt,
          exitCode: entry.exitCode,
          tail: entry.tail,
          turns: entry.turns || [],
          awaitingInput: Boolean(entry.awaitingInput),
          markedDone: Boolean(entry.markedDone),
          markDoneError: entry.markDoneError || null,
          progressNoteError: entry.progressNoteError || null,
          sessionEndedByUser: Boolean(entry.sessionEndedByUser),
          endstate: entry.endstate || null,
          endstateMissing: Boolean(entry.endstateMissing),
          lastDoneEvidence: entry.lastDoneEvidence || [],
          evidenceGateFailed: Boolean(entry.evidenceGateFailed),
          hasSession: Boolean(entry.sessionId),
          queuedMessages: entry.queuedMessages || [],
          waitingReason: entry.waitingReason || null,
          paymentGateArmed: Boolean(entry.paymentGateArmed),
          paymentGateReason: entry.paymentGateReason || null,
          paymentApproved: Boolean(entry.paymentApproved),
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
      const { instructions, workdir, model } = await readBody(req);
      try {
        await startTask(id, instructions, workdir, model);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }

    // Shared by every session kind (Notion task, adhoc, adopted external) -
    // matched under both /api/tasks/ (the original, Notion-flavoured prefix)
    // and /api/sessions/ (used by the new kinds, but works for any id).
    m = url.match(/^\/api\/(?:tasks|sessions)\/([^/]+)\/reply$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const entry = tracker.get(id);
      const { message } = await readBody(req);
      if (!message || !message.trim()) {
        return sendJson(res, 400, { ok: false, error: 'message is empty' });
      }
      if (!entry) {
        return sendJson(res, 400, { ok: false, error: 'unknown session id' });
      }
      const idle = entry.status === 'running' && entry.awaitingInput;
      const busy = entry.status === 'running' && !entry.awaitingInput;
      // A paused-but-alive task (waiting on something external, interrupted
      // by a server restart, or crashed) is just as replyable as an idle one,
      // as long as there's a session to resume onto - same runTurn call below
      // either way. Deliberately excludes 'finished': doneMarkerSeen or a
      // mark-done kill both genuinely end the conversation.
      const resumable = ['waiting', 'interrupted', 'failed'].includes(entry.status) && Boolean(entry.sessionId);
      if (busy) {
        // Claude is mid-turn: don't reject this like the old code did - queue
        // it, and the exit handler flushes every queued message (concatenated)
        // as one message the moment this turn hands back (see runTurn).
        entry.queuedMessages = entry.queuedMessages || [];
        entry.queuedMessages.push(message.trim());
        saveState();
        return sendJson(res, 200, { ok: true, queued: true });
      }
      if (!idle && !resumable) {
        return sendJson(res, 400, { ok: false, error: 'not awaiting your input right now' });
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

    m = url.match(/^\/api\/(?:tasks|sessions)\/([^/]+)\/interrupt$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const entry = tracker.get(id);
      const live = liveProcesses.get(id);
      if (!entry || entry.status !== 'running' || !live) {
        return sendJson(res, 400, { ok: false, error: 'no turn in flight to interrupt' });
      }
      // Stops just THIS turn, not the conversation - see runTurn's exit
      // handler for how interruptRequested resolves back to 'running'.
      entry.interruptRequested = true;
      saveState();
      live.child.kill('SIGTERM');
      return sendJson(res, 200, { ok: true });
    }

    // Notion-agnostic session end: kills the live turn if any and marks the
    // conversation closed, with no Notion call. Adhoc/external cards have no
    // Notion Done checkbox to drive this (unlike Notion task cards, which end
    // their session via /mark-done - see below), so this is their Finish
    // button's endpoint.
    m = url.match(/^\/api\/(?:tasks|sessions)\/([^/]+)\/finish$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const entry = tracker.get(id);
      if (!entry) return sendJson(res, 400, { ok: false, error: 'unknown session id' });
      entry.sessionEndedByUser = true;
      const live = liveProcesses.get(id);
      if (live) {
        // Exit handler (see runTurn) checks sessionEndedByUser first, so this
        // always resolves to 'finished' regardless of the SIGTERM's exit code.
        live.child.kill('SIGTERM');
      } else {
        entry.status = 'finished';
        entry.awaitingInput = false;
      }
      saveState();
      return sendJson(res, 200, { ok: true });
    }

    m = url.match(/^\/api\/tasks\/([^/]+)\/mark-done$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      // The ONLY path that ever flips Notion's Done checkbox - the model has
      // no code path that can call notion.markDone itself (see
      // parseStreamJson's isDone branch, which only sets doneMarkerSeen).
      // Works regardless of whether the model ever emitted its own
      // completion marker, or even ran through this app at all. Also doubles
      // as "I'm done with this conversation": if no turn is in flight,
      // finalize status immediately; if one IS in flight, its own exit
      // handler finalizes once it completes (see runTurn), so the current
      // reply isn't cut off mid-turn.
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
        const live = liveProcesses.get(id);
        if (live) {
          // The task is done - no reason to keep its agent running. Set
          // BEFORE killing so the exit handler's sessionEndedByUser check
          // (checked first, see runTurn) forces status='finished' regardless
          // of what exit code the SIGTERM produces.
          entry.sessionEndedByUser = true;
          live.child.kill('SIGTERM');
        } else {
          entry.status = 'finished';
          entry.awaitingInput = false;
        }
        saveState();
      }
      return sendJson(res, 200, { ok: true });
    }

    m = url.match(/^\/api\/tasks\/([^/]+)\/payment-gate-status$/);
    if (m && req.method === 'GET') {
      const entry = tracker.get(decodeURIComponent(m[1]));
      if (!entry) return sendJson(res, 404, { armed: false, approved: false });
      return sendJson(res, 200, {
        armed: Boolean(entry.paymentGateArmed),
        approved: Boolean(entry.paymentApproved),
        reason: entry.paymentGateReason || null,
      });
    }

    m = url.match(/^\/api\/tasks\/([^/]+)\/payment-approve$/);
    if (m && req.method === 'POST') {
      const entry = tracker.get(decodeURIComponent(m[1]));
      if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown task id' });
      entry.paymentApproved = true;
      saveState();
      return sendJson(res, 200, { ok: true });
    }

    m = url.match(/^\/api\/tasks\/([^/]+)\/notes$/);
    if (m && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const notes = await notion.getPageBlocks(id);
      return sendJson(res, 200, { notes });
    }

    m = url.match(/^\/api\/(?:tasks|sessions)\/([^/]+)\/log$/);
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

    // Free-standing session, not tied to any Notion task - see
    // startAdhocSession/buildAdhocPrompt.
    if (url === '/api/sessions/start' && req.method === 'POST') {
      const { name, instructions, workdir, model } = await readBody(req);
      const id = startAdhocSession(name, instructions, workdir, model);
      return sendJson(res, 200, { ok: true, id });
    }

    // Lists the non-Notion tracker entries (adhoc + adopted external) so the
    // client can render them as cards the same way it renders /api/tasks -
    // Notion tasks are still listed there, this is everything else.
    if (url === '/api/sessions' && req.method === 'GET') {
      const list = [];
      for (const [id, entry] of tracker.entries()) {
        if (entry.kind === 'notion') continue;
        list.push({
          id,
          kind: entry.kind,
          title: entry.name || (entry.kind === 'external' ? `adopted session (${entry.cwd})` : id),
          cwd: entry.cwd,
        });
      }
      return sendJson(res, 200, list);
    }

    // Discovery: every Claude Code session (interactive or background)
    // currently running on this machine, minus whatever this server already
    // tracks - see getExternalSessions. Read-only; does not touch anything.
    if (url === '/api/external-sessions' && req.method === 'GET') {
      const { sessions, error } = await getExternalSessions();
      return sendJson(res, 200, { sessions, error });
    }

    m = url.match(/^\/api\/external-sessions\/([^/]+)\/adopt$/);
    if (m && req.method === 'POST') {
      const agentId = decodeURIComponent(m[1]);
      try {
        const id = await adoptExternalSession(agentId);
        return sendJson(res, 200, { ok: true, id });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }

    // --- static files (allowlisted only, see STATIC_ALLOW above) ---
    if (url !== '/' && !STATIC_ALLOW.test(url)) {
      res.writeHead(404);
      return res.end('not found');
    }
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

function logReachableUrls() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const net of ifaces || []) {
      if (net.family === 'IPv4' && !net.internal) {
        const tag = net.address.startsWith('100.') ? '  (tailscale)' : '';
        console.log(`  http://${net.address}:${PORT}${tag}`);
      }
    }
  }
}

server.listen(PORT, () => {
  console.log(`Todolist running at http://localhost:${PORT}`);
  console.log(`Default working directory (no explicit folder given): ${config.VAULT}`);
  logReachableUrls();
});

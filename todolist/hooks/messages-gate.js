#!/usr/bin/env node
// Claude Code PreToolUse hook on Bash: keeps todolist agents from sending
// iMessage/SMS any way other than `messages.js send` (which only queues a
// request the user must approve - see server.js text-request), and from
// calling the approve routes themselves. A regex backstop, not airtight: the
// real control is that only the server's text-approve route ever sends.
//
// Registered per-task by server.js ensureGateHooks, alongside payment-gate.js.
// Only acts inside a todolist-spawned session (TODOLIST_TASK_ID set) - the
// settings file lives in the vault, so interactive sessions there load it too.
// Fails open on unparseable input, same as payment-gate.js.

const BLOCKED = [
  [/tell\s+application\s+"?Messages\b|com\.apple\.(iChat|MobileSMS)|\b(imessage|sms):\/?\/?|\bshortcuts\s+run\b/i,
    'Sending texts directly is blocked. Use `node <todolist>/messages.js send <who> [--file <path>] [text]`, ' +
      'which queues it for the user to approve in the todolist UI.'],
  [/\/(text-approve|text-reject|payment-approve)\b/,
    'Approving or rejecting a send/payment is the user\'s action in the todolist UI, never yours.'],
];

function allow() {
  process.stdout.write('{}');
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
    systemMessage: reason,
  }));
  process.exit(0);
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try { input = JSON.parse(raw); } catch { return allow(); }
  if (!process.env.TODOLIST_TASK_ID || !input || input.tool_name !== 'Bash') return allow();
  const command = String((input.tool_input && input.tool_input.command) || '');
  for (const [re, reason] of BLOCKED) {
    if (re.test(command)) return deny(reason);
  }
  return allow();
}

main().catch(() => allow());

#!/usr/bin/env node
// Claude Code PreToolUse hook: the actual enforcement half of the payment
// approval gate (server.js does the detection half - see PAYMENT_SIGNAL_RE
// and ensurePaymentGateHook there). Registered per-task in that task's
// .claude/settings.json, matched against the specific "can submit/commit
// something" browser tools (see PAYMENT_GATE_TOOLS in server.js) - denies
// the call whenever this task's server-side state says a payment-shaped page
// was detected and not yet approved by the human.
//
// UNVERIFIED against the installed Claude Code CLI: (1) the exact stdin JSON
// shape Claude Code hands a PreToolUse hook (assumed here: {tool_name,
// tool_input, ...}), and (2) the deny-JSON contract (this uses exit 0 +
// stdout {hookSpecificOutput:{permissionDecision:"deny", ...}}, taken from a
// real shipped plugin's source - a documented alternate form is exit 2 +
// stderr {decision:"deny", reason}). Smoke-test both before trusting this.
//
// Deliberately fails OPEN (allows the tool call) on any error here - stdin
// that doesn't parse, an unset env var, the callback HTTP request failing -
// since a hook that crashes must not be able to wedge every tool call in the
// task forever. That also means a broken hook is silent, not loud: this is
// exactly why the plan calls for an explicit end-to-end smoke test (a staged
// fake checkout page, confirming an actual denial in the raw log) rather than
// trusting this file's presence alone.

const http = require('http');

const GATED_TOOLS = new Set([
  'mcp__claude-in-chrome__computer',
  'mcp__claude-in-chrome__form_input',
  'mcp__claude-in-chrome__javascript_tool',
  'mcp__claude-in-chrome__file_upload',
]);

function allow() {
  process.stdout.write('{}');
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
      systemMessage: reason,
    })
  );
  process.exit(0);
}

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return allow();
  }

  if (!input || !GATED_TOOLS.has(input.tool_name)) return allow();

  const taskId = process.env.TODOLIST_TASK_ID;
  const port = process.env.TODOLIST_PORT;
  if (!taskId || !port) return allow();

  let status;
  try {
    status = await new Promise((resolve, reject) => {
      const req = http.get(
        `http://localhost:${port}/api/tasks/${encodeURIComponent(taskId)}/payment-gate-status`,
        res => {
          let body = '';
          res.on('data', c => (body += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    });
  } catch {
    return allow();
  }

  if (status && status.armed && !status.approved) {
    return deny(
      `Payment/checkout page detected (${status.reason || 'unspecified'}). ` +
        'Paused for human approval - tell the user what this was about to submit, ' +
        'and that you are waiting for them to click "Approve payment" in the todolist UI.'
    );
  }
  return allow();
}

main().catch(() => allow());

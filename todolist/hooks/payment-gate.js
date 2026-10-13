#!/usr/bin/env node
// Claude Code PreToolUse hook: the actual enforcement half of the payment
// approval gate (server.js does the detection half - see PAYMENT_SIGNAL_RE
// and ensurePaymentGateHook there). Registered per-task in that task's
// .claude/settings.json, matched against the specific "can submit/commit
// something" browser tools (see PAYMENT_GATE_TOOLS in server.js) - denies
// the call whenever this task's server-side state says a payment-shaped page
// was detected and not yet approved by the human.
//
// Deny contract: exit 0 + stdout {hookSpecificOutput:{permissionDecision:
// "deny", ...}}.
//
// Fail mode: fails OPEN (allows) when the gate genuinely can't be consulted -
// stdin that doesn't parse, unset env vars, or the server unreachable/timing
// out - so a dead server can't wedge every tool call. But when the server
// DOES answer and the answer isn't a valid gate status (401, 500, junk body),
// it fails CLOSED with a loud "misconfigured" reason: that is how this gate
// silently stopped working for weeks (the server started requiring
// TODOLIST_TOKEN and every check came back 401, read as "allow").

const http = require('http');

const GATED_TOOLS = new Set([
  'mcp__claude-in-chrome__computer',
  'mcp__claude-in-chrome__form_input',
  'mcp__claude-in-chrome__javascript_tool',
  'mcp__claude-in-chrome__file_upload',
  'mcp__claude-in-chrome__browser_batch',
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

  const token = process.env.TODOLIST_TOKEN;
  let response;
  try {
    response = await new Promise((resolve, reject) => {
      const req = http.get(
        `http://localhost:${port}/api/tasks/${encodeURIComponent(taskId)}/payment-gate-status`,
        { headers: token ? { 'x-todolist-token': token } : {} },
        res => {
          let body = '';
          res.on('data', c => (body += c));
          res.on('end', () => resolve({ code: res.statusCode, body }));
        }
      );
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    });
  } catch {
    // Server unreachable / timed out - see the fail-mode note at the top.
    return allow();
  }

  let status;
  try {
    status = JSON.parse(response.body);
  } catch {}
  // 404 + {armed:false} is the server's normal answer for an id it doesn't
  // track - only an unparseable/unauthorized answer counts as misconfigured.
  const validCode = response.code === 200 || response.code === 404;
  if (!validCode || !status || typeof status.armed !== 'boolean') {
    return deny(
      `Payment gate misconfigured (HTTP ${response.code} from the todolist server) - ` +
        'cannot confirm whether a payment is approved, so this action is blocked. ' +
        'Tell the user the todolist payment gate needs fixing.'
    );
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

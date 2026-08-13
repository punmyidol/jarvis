#!/bin/bash
# Nightly agent run: Claude Code (headless) classifies today's note without the
# paid API, then files/stages it. Uses your Claude Code quota, not API credits.
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env ] && . ./.env; set +a

CLAUDE="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
PROMPT="Follow deploy/nightly_agent.md exactly, then stop."

exec "$CLAUDE" -p "$PROMPT" \
  --permission-mode bypassPermissions \
  --allowedTools "Bash,Read,Write"

#!/bin/bash
# Evening job: classify today's note, auto-file confident rows, stage the rest.
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env ] && . ./.env; set +a
exec venv/bin/python -m noter.run_daily --date today

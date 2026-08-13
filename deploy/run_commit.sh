#!/bin/bash
# Morning job: file the review rows you approved overnight + record corrections.
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env ] && . ./.env; set +a
exec venv/bin/python -m noter.commit

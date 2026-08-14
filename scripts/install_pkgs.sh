#!/bin/bash
# SessionStart hook (.claude/settings.json) — installs dependencies in cloud
# sessions only, so routines and cloud sessions (e.g. "Pawsome3D Runtime Log
# Watch" writing a test reproduction with `tsx --test`) always have
# node_modules ready. Never runs locally: CLAUDE_CODE_REMOTE is only "true"
# on the cloud VM, so this exits immediately on your own machine, where you
# manage `npm install` yourself.

if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

if [ -d node_modules ]; then
  exit 0
fi

npm install
exit 0

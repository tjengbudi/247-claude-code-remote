#!/bin/bash

cd "$CLAUDE_PROJECT_DIR" || exit 0

# Verify we're in the right project
if [[ ! -f "claude-remote-control/package.json" ]]; then
  exit 0
fi

cd claude-remote-control || exit 0

echo "Checking for dead code..."
pnpm deadcode 2>&1

DEADCODE_EXIT=$?

if [ $DEADCODE_EXIT -eq 0 ]; then
  echo "No dead code found"
  exit 0
else
  echo "Dead code detected. Please remove unused code before completing." >&2
  exit 2
fi

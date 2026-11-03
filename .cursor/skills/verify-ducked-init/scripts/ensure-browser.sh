#!/usr/bin/env bash
# Install playwright-core into this skill's gitignored .tools directory.
# Does not download a browser. browser.mjs launches the system Chrome/Chromium.
set -euo pipefail
SKILL=$(cd "$(dirname "$0")/.." && pwd)
TOOLS=$SKILL/.tools
if [[ -d $TOOLS/node_modules/playwright-core ]]; then
  exit 0
fi
mkdir -p "$TOOLS"
npm install --prefix "$TOOLS" --no-fund --no-audit playwright-core@1.64.1
echo "playwright-core installed in $TOOLS"

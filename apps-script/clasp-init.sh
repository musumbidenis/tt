#!/bin/bash
# Points clasp at the Drive bridge Apps Script project, once per computer.
#
#   bash apps-script/clasp-init.sh <script id or the editor address>
#
# The address looks like https://script.google.com/home/projects/1aBc.../edit or
# https://script.google.com/.../projects/1aBc.../edit — either the whole thing or just the id works.
# It writes .clasp.json (not committed: it names one Google project). Afterwards:
#   npx clasp login          once per computer, in a browser
#   npx clasp status         what would be sent — expect appsscript.json and DriveBridge.gs, nothing else
#   npx clasp push -f        send it
set -eu
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ $# -lt 1 ]; then
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

# Pull the id out of whatever was pasted: Apps Script ids are long and made of letters, digits, - and _.
ID=$(printf '%s' "$1" | grep -oE '[A-Za-z0-9_-]{30,}' | head -1 || true)
if [ -z "$ID" ]; then
  echo "That does not look like a script id or an Apps Script address: $1" >&2
  exit 1
fi

printf '{\n  "scriptId": "%s",\n  "rootDir": "apps-script"\n}\n' "$ID" > .clasp.json
echo "Wrote .clasp.json for script $ID"
echo
echo "Next:"
echo "  1. Switch the Apps Script API on, once per Google account:"
echo "     https://script.google.com/home/usersettings  ->  Google Apps Script API: On"
echo "  2. npx clasp login          (opens a browser; use the school Workspace account)"
echo "  3. npx clasp status         (must list only appsscript.json and DriveBridge.gs)"
echo "  4. npx clasp push -f        (replaces the project's files with these)"

#!/bin/bash
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
nohup npx electron . >/dev/null 2>&1 &
disown
exit 0

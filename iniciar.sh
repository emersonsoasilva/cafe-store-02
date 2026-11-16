#!/bin/sh
cd "$(dirname "$0")" || exit 1
[ -d node_modules ] || npm install --no-audit --no-fund || exit 1
npm run build && npm start

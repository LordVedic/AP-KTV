#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install the LTS version from https://nodejs.cn or https://nodejs.org, then run this again."
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi
node server.js

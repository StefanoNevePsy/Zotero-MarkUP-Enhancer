#!/usr/bin/env bash
# Packages the plugin into build/zotero-semantic.xpi
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p build
rm -f build/zotero-semantic.xpi

zip -r -FS build/zotero-semantic.xpi \
  manifest.json \
  bootstrap.js \
  update.json \
  src \
  graph \
  prefs \
  locale \
  icons \
  -x '*.DS_Store'

echo "Built build/zotero-semantic.xpi"

#!/usr/bin/env bash
# Packages the plugin into build/markup-enhancer.xpi
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p build
rm -f build/markup-enhancer.xpi

zip -r -FS build/markup-enhancer.xpi \
  manifest.json \
  bootstrap.js \
  update.json \
  src \
  prefs \
  locale \
  icons \
  -x '*.DS_Store'

echo "Built build/markup-enhancer.xpi"

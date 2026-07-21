#!/usr/bin/env bash
# Aurora's verification gate. Nothing ships on red.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── typecheck ──"
./node_modules/.bin/tsc --noEmit

echo "── lint ──"
./node_modules/.bin/eslint src

echo "── test ──"
bun test/cov.ts --quiet

echo "✅ gate green"

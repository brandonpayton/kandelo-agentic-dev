#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

exec node --experimental-wasm-exnref --expose-gc --max-old-space-size=16384 --import tsx/esm \
  "$REPO_ROOT/scripts/run-spidermonkey-unit-tests.ts" "$@"

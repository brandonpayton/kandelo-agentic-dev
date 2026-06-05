#!/usr/bin/env bash
set -euo pipefail

# Executable JS-shell shim for Mozilla's official SpiderMonkey harnesses.
#
# The upstream Python harnesses expect a native `js` shell binary. This wrapper
# gives them an executable path while actually running Kandelo's js.wasm under
# NodeKernelHost via examples/run-example.ts.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JS_WASM="${SPIDERMONKEY_WASM:-$REPO_ROOT/packages/registry/spidermonkey/bin/js.wasm}"

if [ ! -f "$JS_WASM" ]; then
  echo "ERROR: SpiderMonkey js.wasm not found at $JS_WASM" >&2
  echo "Run: bash packages/registry/spidermonkey/build-spidermonkey.sh" >&2
  exit 127
fi

export TIMEOUT="${SPIDERMONKEY_WRAPPER_TIMEOUT_MS:-600000}"

exec node --experimental-wasm-exnref --import tsx/esm \
  "$REPO_ROOT/examples/run-example.ts" \
  "$JS_WASM" \
  "$@"

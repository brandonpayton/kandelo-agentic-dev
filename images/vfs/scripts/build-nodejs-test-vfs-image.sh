#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"
npx tsx "$SCRIPT_DIR/build-nodejs-test-vfs-image.ts"
ls -lh apps/browser-demos/public/nodejs-test.vfs.zst

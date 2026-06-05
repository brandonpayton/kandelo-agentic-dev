#!/usr/bin/env bash
set -euo pipefail

# Run Mozilla's official SpiderMonkey JS shell test harnesses on Kandelo.
#
# This is intentionally separate from run-spidermonkey-unit-tests.sh, which is
# a small Kandelo shell smoke suite.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SM_SOURCE="${SPIDERMONKEY_SOURCE_DIR:-$REPO_ROOT/packages/registry/spidermonkey/source/firefox-140.11.0}"
NODE_WRAPPER="$REPO_ROOT/scripts/kandelo-js-shell-wrapper.sh"
BROWSER_WRAPPER="$REPO_ROOT/scripts/kandelo-browser-js-shell-wrapper.sh"

HOST="node"
SUITE="both"
JOBS="${SPIDERMONKEY_OFFICIAL_JOBS:-1}"
TIMEOUT="${SPIDERMONKEY_OFFICIAL_TIMEOUT:-60}"
XUL_INFO="${SPIDERMONKEY_XUL_INFO:-wasm32:Linux:false}"
WPT_MODE="${SPIDERMONKEY_OFFICIAL_WPT:-disabled}"
FORMAT="${SPIDERMONKEY_OFFICIAL_FORMAT:-automation}"
EXTRA_ARGS=()
JS_SHELL_WRAPPER="$NODE_WRAPPER"
BROWSER_SERVER_PID=""

usage() {
  cat <<EOF
Usage: $0 [OPTIONS] [-- suite-specific-selector...]

Options:
  --host node|browser|both       Host to run on (default: node)
  --suite jstests|jit-tests|both Official SpiderMonkey harness (default: both)
  --jobs N                       Upstream harness worker count (default: 1)
  --timeout SECONDS              Upstream per-test timeout (default: 60)
  --smoke                        Run one small test from each selected suite
  --format FORMAT                Upstream output format (default: automation)
  --help                         Show this help

Examples:
  $0 --suite jstests --smoke
  $0 --suite jit-tests -- --read-tests /tmp/jit-list.txt
  $0 --suite jstests -- non262/Array/array-001.js

The browser host uses a persistent Playwright/Vite shell bridge so the Mozilla
harness still invokes an executable `js` shell path.
EOF
}

SMOKE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      HOST="${2:-}"
      if [ "$HOST" != "node" ] && [ "$HOST" != "browser" ] && [ "$HOST" != "both" ]; then
        echo "ERROR: --host must be node, browser, or both" >&2
        exit 1
      fi
      shift 2
      ;;
    --suite)
      SUITE="${2:-}"
      if [ "$SUITE" != "jstests" ] && [ "$SUITE" != "jit-tests" ] && [ "$SUITE" != "both" ]; then
        echo "ERROR: --suite must be jstests, jit-tests, or both" >&2
        exit 1
      fi
      shift 2
      ;;
    --jobs)
      JOBS="${2:-}"
      shift 2
      ;;
    --timeout)
      TIMEOUT="${2:-}"
      shift 2
      ;;
    --smoke)
      SMOKE=true
      shift
      ;;
    --format)
      FORMAT="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      EXTRA_ARGS=("$@")
      break
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

if [ ! -d "$SM_SOURCE/js/src/tests" ] || [ ! -d "$SM_SOURCE/js/src/jit-test" ]; then
  echo "ERROR: SpiderMonkey source tree not found at $SM_SOURCE" >&2
  echo "Run: bash packages/registry/spidermonkey/build-spidermonkey.sh" >&2
  exit 1
fi

chmod +x "$NODE_WRAPPER" "$BROWSER_WRAPPER"

start_browser_shell_bridge() {
  local port="${SPIDERMONKEY_BROWSER_JS_SHELL_PORT:-5312}"
  export SPIDERMONKEY_BROWSER_JS_SHELL_PORT="$port"
  export SPIDERMONKEY_BROWSER_JS_SHELL_URL="http://127.0.0.1:$port/run"
  export SPIDERMONKEY_OFFICIAL_REBUILD_VFS="${SPIDERMONKEY_OFFICIAL_REBUILD_VFS:-1}"

  node --import tsx/esm "$REPO_ROOT/scripts/kandelo-browser-js-shell-server.ts" &
  BROWSER_SERVER_PID=$!

  for _ in $(seq 1 120); do
    if node -e "fetch('http://127.0.0.1:${port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$BROWSER_SERVER_PID" 2>/dev/null; then
      echo "ERROR: browser js shell bridge exited early" >&2
      return 1
    fi
    sleep 1
  done
  echo "ERROR: browser js shell bridge did not become ready" >&2
  return 1
}

stop_browser_shell_bridge() {
  if [ -n "$BROWSER_SERVER_PID" ]; then
    kill "$BROWSER_SERVER_PID" 2>/dev/null || true
    wait "$BROWSER_SERVER_PID" 2>/dev/null || true
    BROWSER_SERVER_PID=""
  fi
}

run_jstests() {
  local args=()
  if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
    args=("${EXTRA_ARGS[@]}")
  fi
  if $SMOKE && [ ${#args[@]} -eq 0 ]; then
    args=(non262/Array/array-001.js)
  fi

  echo "===== Official SpiderMonkey jstests on Kandelo $CURRENT_HOST host ====="
  export SPIDERMONKEY_WRAPPER_TIMEOUT_MS="${SPIDERMONKEY_WRAPPER_TIMEOUT_MS:-$((TIMEOUT * 1000 + 30000))}"
  python3 "$SM_SOURCE/js/src/tests/jstests.py" \
    --no-progress \
    --no-xdr \
    --xul-info "$XUL_INFO" \
    --wpt "$WPT_MODE" \
    --format "$FORMAT" \
    --worker-count "$JOBS" \
    --timeout "$TIMEOUT" \
    "$JS_SHELL_WRAPPER" \
    ${args[@]+"${args[@]}"}
}

run_jit_tests() {
  local args=()
  if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
    args=("${EXTRA_ARGS[@]}")
  fi
  local smoke_list=""
  if $SMOKE && [ ${#args[@]} -eq 0 ]; then
    smoke_list="$(mktemp)"
    printf '%s\n' "$SM_SOURCE/js/src/jit-test/tests/basic/bug908915.js" > "$smoke_list"
    args=(--read-tests "$smoke_list")
  fi

  echo "===== Official SpiderMonkey jit-tests on Kandelo $CURRENT_HOST host ====="
  export SPIDERMONKEY_WRAPPER_TIMEOUT_MS="${SPIDERMONKEY_WRAPPER_TIMEOUT_MS:-$((TIMEOUT * 1000 + 30000))}"
  set +e
  python3 "$SM_SOURCE/js/src/jit-test/jit_test.py" \
    --no-progress \
    --no-xdr \
    --worker-count "$JOBS" \
    --timeout "$TIMEOUT" \
    --format "$FORMAT" \
    ${args[@]+"${args[@]}"} \
    "$JS_SHELL_WRAPPER"
  local status=$?
  set -e

  if [ -n "$smoke_list" ]; then
    rm -f "$smoke_list"
  fi
  return "$status"
}

run_selected_suites() {
  case "$SUITE" in
    jstests)
      run_jstests
      ;;
    jit-tests)
      run_jit_tests
      ;;
    both)
      local status=0
      run_jstests || status=1
      run_jit_tests || status=1
      return "$status"
      ;;
  esac
}

FAIL=0
HOSTS=()
if [ "$HOST" = "both" ]; then
  HOSTS=(node browser)
else
  HOSTS=("$HOST")
fi

for CURRENT_HOST in "${HOSTS[@]}"; do
  case "$CURRENT_HOST" in
    node)
      JS_SHELL_WRAPPER="$NODE_WRAPPER"
      ;;
    browser)
      JS_SHELL_WRAPPER="$BROWSER_WRAPPER"
      start_browser_shell_bridge || exit 1
      trap stop_browser_shell_bridge EXIT
      ;;
  esac

  run_selected_suites || FAIL=1

  if [ "$CURRENT_HOST" = "browser" ]; then
    stop_browser_shell_bridge
    trap - EXIT
  fi
done

exit "$FAIL"

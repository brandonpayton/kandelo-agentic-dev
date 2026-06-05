#!/usr/bin/env bash
set -euo pipefail

# Run SQLite's upstream Tcl testfixture suite in headless Chromium.
#
# Usage:
#   scripts/run-browser-sqlite-upstream-tests.sh --all
#   scripts/run-browser-sqlite-upstream-tests.sh select1.test func.test
#
# Default: --all.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SQLITE_FULL="$REPO_ROOT/packages/registry/sqlite/sqlite-full-src"
VFS_IMAGE="$REPO_ROOT/apps/browser-demos/public/sqlite-test.vfs.zst"
RUNNER="$REPO_ROOT/scripts/browser-sqlite-upstream-test-runner.ts"

SQLITE_XFAILS="$(
  awk '
    /^XFAIL=\(/ { inside=1; next }
    inside && /^\)/ { inside=0; next }
    inside {
      sub(/#.*/, "")
      gsub(/["()]/, "")
      for (i = 1; i <= NF; i++) if ($i ~ /\.test$/) print $i
    }
  ' "$REPO_ROOT/scripts/run-sqlite-upstream-tests.sh" | tr '\n' ' '
)"

is_xfail_test() {
  case " $SQLITE_XFAILS " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

MODE="all"
TEST_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --all) MODE="all"; shift ;;
    --quick) MODE="quick"; shift ;;
    --help|-h)
      echo "Usage: $0 [--all|--quick] [test1.test test2.test ...]"
      echo ""
      echo "Default is --all. --quick runs a small smoke set."
      echo "Environment:"
      echo "  SQLITE_TEST_TIMEOUT  Per-test timeout in seconds (default: 180)"
      exit 0
      ;;
    *) TEST_ARGS+=("$1"); shift ;;
  esac
done

if [ ! -d "$SQLITE_FULL/test" ]; then
  echo "ERROR: SQLite full source not found at $SQLITE_FULL" >&2
  echo "Run: bash packages/registry/sqlite/build-testfixture.sh" >&2
  exit 1
fi

if [ ! -f "$VFS_IMAGE" ]; then
  echo "Building SQLite test VFS image..."
  bash "$REPO_ROOT/images/vfs/scripts/build-sqlite-test-vfs-image.sh"
fi

if [ ${#TEST_ARGS[@]} -eq 0 ]; then
  if [ "$MODE" = "quick" ]; then
    TEST_ARGS=(select1.test select2.test func.test expr.test misc1.test)
  else
    while IFS= read -r test_name; do
      TEST_ARGS+=("$test_name")
    done < <(find "$SQLITE_FULL/test" -maxdepth 1 -type f -name '*.test' \
      | sed 's#.*/##' \
      | sort)
  fi
fi

echo "===== SQLite upstream tests (browser) ====="
echo "Mode: $MODE"
echo "Tests: ${#TEST_ARGS[@]}"
echo ""

RESULTS_FILE="$(mktemp)"
STDERR_FILE="$(mktemp)"
trap 'rm -f "$RESULTS_FILE" "$STDERR_FILE"' EXIT

TIMEOUT_MS=$(( ${SQLITE_TEST_TIMEOUT:-180} * 1000 ))

set +e
npx tsx "$RUNNER" --json --timeout "$TIMEOUT_MS" "${TEST_ARGS[@]}" >"$RESULTS_FILE" 2>"$STDERR_FILE"
RUNNER_EXIT=$?
set -e

cat "$STDERR_FILE" >&2

PASS=0
FAIL=0
SKIP=0
TIME=0
XFAIL=0
XPASS=0
TOTAL=0
CASE_TOTAL=0
CASE_ERRORS=0
FAIL_LIST=()

while IFS= read -r line; do
  [[ "$line" == "{"* ]] || continue
  parsed=$(echo "$line" | python3 -c "
import json, sys
d=json.load(sys.stdin)
print(d.get('test',''))
print(d.get('status','fail'))
print(d.get('case_total',0) or 0)
print(d.get('case_errors',0) or 0)
" 2>/dev/null) || continue
  test_name=$(echo "$parsed" | sed -n '1p')
  status=$(echo "$parsed" | sed -n '2p')
  case_total=$(echo "$parsed" | sed -n '3p')
  case_errors=$(echo "$parsed" | sed -n '4p')
  [ -n "$test_name" ] || continue
  TOTAL=$((TOTAL + 1))
  if [[ "$case_total" =~ ^[0-9]+$ ]]; then
    CASE_TOTAL=$((CASE_TOTAL + case_total))
  fi
  if [[ "$case_errors" =~ ^[0-9]+$ ]]; then
    CASE_ERRORS=$((CASE_ERRORS + case_errors))
  fi
  is_xfail=false
  if is_xfail_test "$test_name"; then
    is_xfail=true
  fi
  case "$status" in
    pass)
      if $is_xfail; then
        XPASS=$((XPASS + 1))
        FAIL_LIST+=("XPASS $test_name")
      else
        PASS=$((PASS + 1))
      fi
      ;;
    skip) SKIP=$((SKIP + 1)) ;;
    time)
      if $is_xfail; then
        XFAIL=$((XFAIL + 1))
      else
        TIME=$((TIME + 1))
        FAIL_LIST+=("TIME $test_name")
      fi
      ;;
    *)
      if $is_xfail; then
        XFAIL=$((XFAIL + 1))
      else
        FAIL=$((FAIL + 1))
        FAIL_LIST+=("FAIL $test_name")
      fi
      ;;
  esac
done < "$RESULTS_FILE"

echo ""
echo "===== Results ====="
echo "PASS:  $PASS"
echo "FAIL:  $FAIL"
echo "SKIP:  $SKIP"
echo "TIME:  $TIME"
echo "XFAIL: $XFAIL"
echo "XPASS: $XPASS"
echo "TOTAL: $TOTAL"
echo "CASES: $CASE_TOTAL"
echo "CASE ERRORS: $CASE_ERRORS"

if [ ${#FAIL_LIST[@]} -gt 0 ]; then
  echo ""
  echo "Unexpected failures/timeouts:"
  for item in "${FAIL_LIST[@]}"; do
    echo "  $item"
  done
fi

if [ "$RUNNER_EXIT" -ne 0 ] || [ "$FAIL" -gt 0 ] || [ "$TIME" -gt 0 ] || [ "$XPASS" -gt 0 ]; then
  exit 1
fi

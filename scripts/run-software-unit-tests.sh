#!/usr/bin/env bash
set -euo pipefail

# Run full upstream/core-software unit suites on Kandelo.
#
# Usage:
#   scripts/run-software-unit-tests.sh
#   scripts/run-software-unit-tests.sh --host node sqlite php spidermonkey-official nodejs
#   scripts/run-software-unit-tests.sh --host browser mariadb

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="both"
SUITES=()

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
    --help|-h)
      echo "Usage: $0 [--host node|browser|both] [mariadb|mysql|sqlite|php|spidermonkey-smoke|spidermonkey-official|nodejs ...]"
      echo ""
      echo "Default: run mariadb, sqlite, php, spidermonkey-smoke, and nodejs on both hosts."
      echo "sqlite runs SQLite's official testrunner.tcl permutation: \${SQLITE_OFFICIAL_PERMUTATION:-full}."
      echo "spidermonkey-official currently supports the Node host only."
      exit 0
      ;;
    *)
      SUITES+=("$1")
      shift
      ;;
  esac
done

if [ ${#SUITES[@]} -eq 0 ]; then
  SUITES=(mariadb sqlite php spidermonkey-smoke nodejs)
fi

run_one() {
  local suite="$1"
  local host="$2"
  case "$suite:$host" in
    mariadb:node|mysql:node)
      "$REPO_ROOT/scripts/run-mariadb-tests.sh" --all
      ;;
    mariadb:browser|mysql:browser)
      "$REPO_ROOT/scripts/run-browser-mariadb-tests.sh" --all
      ;;
    sqlite:node)
      "$REPO_ROOT/scripts/run-sqlite-official-tests.sh" --host node --permutation "${SQLITE_OFFICIAL_PERMUTATION:-full}"
      ;;
    sqlite:browser)
      "$REPO_ROOT/scripts/run-sqlite-official-tests.sh" --host browser --permutation "${SQLITE_OFFICIAL_PERMUTATION:-full}"
      ;;
    php:node)
      "$REPO_ROOT/scripts/run-php-upstream-tests.sh" --host node --all
      ;;
    php:browser)
      "$REPO_ROOT/scripts/run-php-upstream-tests.sh" --host browser --all
      ;;
    spidermonkey-smoke:node)
      "$REPO_ROOT/scripts/run-spidermonkey-unit-tests.sh" --host node
      ;;
    spidermonkey-smoke:browser)
      "$REPO_ROOT/scripts/run-spidermonkey-unit-tests.sh" --host browser
      ;;
    spidermonkey-official:node|spidermonkey:node)
      "$REPO_ROOT/scripts/run-spidermonkey-official-tests.sh" --host node
      ;;
    spidermonkey-official:browser|spidermonkey:browser)
      "$REPO_ROOT/scripts/run-spidermonkey-official-tests.sh" --host browser
      ;;
    nodejs:node|node:node)
      "$REPO_ROOT/scripts/run-nodejs-library-tests.sh" --host node --all
      ;;
    nodejs:browser|node:browser)
      "$REPO_ROOT/scripts/run-nodejs-library-tests.sh" --host browser --all
      ;;
    *)
      echo "ERROR: unknown suite/host: $suite on $host" >&2
      return 1
      ;;
  esac
}

FAIL=0
for suite in "${SUITES[@]}"; do
  case "$suite" in
    mysql) suite="mariadb" ;;
    node) suite="nodejs" ;;
    spidermonkey) suite="spidermonkey-official" ;;
    mariadb|sqlite|php|spidermonkey-smoke|spidermonkey-official|nodejs) ;;
    *)
      echo "ERROR: unknown suite: $suite" >&2
      exit 1
      ;;
  esac

  HOSTS=()
  if [ "$HOST" = "both" ]; then
    HOSTS=(node browser)
  else
    HOSTS=("$HOST")
  fi

  for h in "${HOSTS[@]}"; do
    echo ""
    echo "===== Running $suite tests on $h host ====="
    if ! run_one "$suite" "$h"; then
      echo "FAILED: $suite on $h" >&2
      FAIL=1
    fi
  done
done

exit "$FAIL"

# MariaDB project test harness

This harness runs MariaDB's upstream `mysql-test/main/*.test` suite against
Kandelo on the supported Node and browser hosts and writes PR-friendly logs and
counts.

## Commands

Run the full MariaDB project suite on both hosts:

```bash
scripts/run-mariadb-project-tests.sh --host both --all --chunk-size 25 --timeout-ms 300000
```

Useful variants:

```bash
# Node host only, full suite, reset the Node process every 25 tests.
scripts/run-mariadb-project-tests.sh --host node --all --chunk-size 25 --timeout-ms 300000

# Browser host only, full suite. Builds the all-test browser VFS when chunking.
scripts/run-mariadb-project-tests.sh --host browser --all --chunk-size 10 --timeout-ms 60000

# Single/smoke tests on either host.
scripts/run-mariadb-project-tests.sh --host node 1st
scripts/run-mariadb-project-tests.sh --host browser 1st
```

Logs and machine-readable counts are written under
`test-runs/mariadb-project/<UTC timestamp>/` by default, or to `--results-dir`.
Each run emits:

- `<host>.log` — complete underlying harness output.
- `<host>.exit` — host harness exit code.
- `summary.md` — markdown table for PR descriptions.
- `summary.json` — same counts for scripts.

## Prerequisites

Either fetch release binaries for the active ABI or build them locally:

```bash
bash build.sh
bash packages/registry/mariadb/build-mariadb.sh
bash images/vfs/scripts/build-mariadb-test-vfs-image.sh --all   # browser/full
npx playwright install chromium
```

On minimal Linux runners, Playwright also needs system browser libraries
(e.g. `libatk-1.0.so.0`). Install them with the platform package manager or
`npx playwright install-deps chromium` before running browser tests.

## Current local status (2026-06-05)

- Node smoke: `scripts/run-mariadb-project-tests.sh --host node 1st` passes
  1/1.
- Node full unchunked: reached 59/1183 results before the Node process was
  killed by the runner (exit 137): 21 PASS, 1 FAIL, 13 XFAIL, 6 XPASS, 18 SKIP.
- Node full chunked: chunk 1/48 completed with 25 results: 13 PASS, 0 FAIL,
  6 XFAIL, 4 XPASS, 2 SKIP. The chunked mode is the recommended reusable path
  for completing the full suite under memory pressure.
- Browser host on this runner did not reach MariaDB because Chromium could not
  launch: missing `libatk-1.0.so.0`. Harness/Vite startup is now diagnosed in
  the browser log.

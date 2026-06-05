# Core Software Test Suites on Kandelo

This project proves Kandelo by running real upstream/project test suites for
large guest software on both Node.js and browser hosts where possible.

Status date: 2026-06-05.

## Current Status

| Project | What is wired today | Node host status | Browser host status |
|---------|---------------------|------------------|---------------------|
| MariaDB | `mysql-test/main/*.test` through `mysqltest` against `mariadbd` | Started full run, stopped after 710 results due Node heap OOM | Browser run reached the harness but failed VFS/init fetch and recorded 1149 failures |
| SQLite direct | Direct execution of each upstream Tcl `test/*.test` script once through `testfixture` | Completed 1159 scripts: 912 PASS, 36 FAIL, 15 XFAIL, 196 XPASS | Completed 1159 scripts: 876 PASS, 62 FAIL, 38 XFAIL, 173 XPASS, 10 TIME |
| SQLite official | Upstream `test/testrunner.tcl` permutations `full` and `all` | Completed corrected Node `full --jobs 2`: 1416/1416 official Tcl jobs finalized, 1416 passed, 0 failed, 1,703,255 SQLite internal cases, 0 case errors. The prior `busy2.test` failure was fixed by rebuilding the SQLite artifacts with `SQLITE_ENABLE_SETLK_TIMEOUT=2`, matching SQLite's own official lock-timeout test configuration; see `docs/sqlite-official-test-report.md` | Same inventory: 1416 `full` jobs and 10523 `all` jobs. Current browser iteration is past the earlier `writecrash.test` blocker and reached a timeout/stall checkpoint at 40/1416 jobs, 12,206 cases, 0 case errors, with `test/sort4.test` still running. Node isolated `sort4.test` passes 11/11 in 54s; browser isolated `sort4.test` was still at 0/1 after about 3 minutes before maintenance stop. See `docs/sqlite-official-test-report.md`. |
| PHP | PHPT runtime tests from the PHP source tree | Harness wired for php-src discovery and Node execution. Current PR iteration has smoke/shard results documented in the PR; full run is still memory/time constrained in shared AO workers. | Harness wired for browser execution via the `php-test` Vite page and VFS image. Current PR iteration has smoke/shard results documented in the PR; full run is still memory/time constrained in shared AO workers. |
| SpiderMonkey smoke | Kandelo-authored shell coverage tests, not Mozilla's official suite | Completed 17/17 PASS | Completed 17/17 PASS |
| SpiderMonkey official | Mozilla `jstests.py` and `jit_test.py` harnesses using `js.wasm` through a Kandelo shell wrapper | Paused until the process-memory architecture bug is fixed, so Node/browser results stay comparable | Paused until the browser process-memory architecture bug is fixed |
| Node.js library | Upstream Node.js `test/parallel/test-*.js` and `test/sequential/test-*.js` through the SpiderMonkey-backed Node-compatible runtime | Completed 3925 tests: 336 PASS, 3264 FAIL, 325 TIME | Completed 3925 tests: 339 PASS, 3564 FAIL, 22 TIME |

Logs from the 2026-05-28 full runs are under `test-runs/software-unit-tests/`.

## 2026-06-05 PHP PHPT Harness Notes

The PHP PHPT harness is `scripts/run-php-upstream-tests.sh`. It runs the
upstream `php-src` `.phpt` inventory against Kandelo without calling native
`run-tests.php` directly: each `--EXTENSIONS--`, `--SKIPIF--`, `--FILE--`,
and `--CLEAN--` section is executed as a PHP process inside Kandelo, then the
harness applies the PHPT expectation match.

Current defaults use the PHP package source metadata, which now matches the
PHP binary built by `packages/registry/php/build-php.sh` (PHP 8.3.15). The
node host mounts the source tree at `/php-src`, mounts the PHP binary
directory at `/kandelo-bin`, and runs tests from `/php-src` to match upstream
`run-tests.php` working-directory semantics. The browser host uses the
`php-test` Vite page and `apps/browser-demos/public/php-test.vfs.zst`; rebuild
that image after changing the PHP source, PHP binary, kernel, shell, or
utility binary inputs.

Recommended commands while iterating:

```bash
# Expanded ext/standard PHPT tranche that currently passes cleanly on both
# supported hosts: 537 total, 466 pass, 70 skip, 1 unsupported.
SKIP_SLOW_TESTS=1 SKIP_ONLINE_TESTS=1 scripts/run-php-upstream-tests.sh \
  --host node \
  ext/standard/tests/time ext/standard/tests/versioning \
  ext/standard/tests/directory ext/standard/tests/crypt \
  ext/standard/tests/ini_info ext/standard/tests/hrtime \
  ext/standard/tests/password ext/standard/tests/misc \
  ext/standard/tests/assert ext/standard/tests/url \
  ext/standard/tests/filters ext/standard/tests/class_object \
  ext/standard/tests/image ext/standard/tests/math \
  ext/standard/tests/serialize \
  --timeout 60000 --json

LD_LIBRARY_PATH=/tmp/pw-deps/root/usr/lib/x86_64-linux-gnu \
SKIP_SLOW_TESTS=1 SKIP_ONLINE_TESTS=1 scripts/run-php-upstream-tests.sh \
  --host browser \
  ext/standard/tests/time ext/standard/tests/versioning \
  ext/standard/tests/directory ext/standard/tests/crypt \
  ext/standard/tests/ini_info ext/standard/tests/hrtime \
  ext/standard/tests/password ext/standard/tests/misc \
  ext/standard/tests/assert ext/standard/tests/url \
  ext/standard/tests/filters ext/standard/tests/class_object \
  ext/standard/tests/image ext/standard/tests/math \
  ext/standard/tests/serialize \
  --timeout 60000 --json

# Full ext/standard strings directory, now clean on both supported hosts:
# 716 total, 663 pass, 53 skip.
SKIP_SLOW_TESTS=1 SKIP_ONLINE_TESTS=1 scripts/run-php-upstream-tests.sh \
  --host node ext/standard/tests/strings --timeout 60000 --json

LD_LIBRARY_PATH=/tmp/pw-deps/root/usr/lib/x86_64-linux-gnu \
SKIP_SLOW_TESTS=1 SKIP_ONLINE_TESTS=1 scripts/run-php-upstream-tests.sh \
  --host browser ext/standard/tests/strings --timeout 60000 --json

# Node host. Shard full runs; SKIP_* vars are upstream PHPT control env.
SKIP_SLOW_TESTS=1 SKIP_ONLINE_TESTS=1 scripts/run-php-upstream-tests.sh \
  --host node --all --shard 1/16 --timeout 180000 --json

# Browser host. Requires Playwright's shared library deps on this AO runner.
LD_LIBRARY_PATH=/tmp/pw-deps/root/usr/lib/x86_64-linux-gnu \
SKIP_SLOW_TESTS=1 SKIP_ONLINE_TESTS=1 scripts/run-php-upstream-tests.sh \
  --host browser --all --shard 1/16 --timeout 180000 --json

# Rebuild the browser PHPT VFS image. The image includes /bin/sh and
# standard utilities so PHP shell-backed APIs such as system()/exec() work.
LD_LIBRARY_PATH=/tmp/pw-deps/root/usr/lib/x86_64-linux-gnu \
scripts/run-php-upstream-tests.sh \
  --host browser --rebuild-vfs --limit 3 --timeout 90000 --json
```

The browser VFS builder resolves `php.wasm`, `dash.wasm`, and
`coreutils.wasm`, and `sed.wasm` via the normal binary resolver. If a local
binary cache is stale, set `PHP_WASM`, `DASH_WASM`, `COREUTILS_WASM`, or
`SED_WASM` explicitly.

Kernel/POSIX fixes found by PHPT so far in the current PR:

- Pathname resolution must be component-wise. Kandelo no longer collapses
  `missing/..` lexically before the backend can report `ENOENT`.
- A trailing slash is significant: it requires the preceding component to
  resolve as a directory, while `mkdir("newdir/")` still uses the parent of
  `newdir`.
- `..` at a VFS mount root resolves to the parent mount instead of being
  treated as an escape from the host-backed mount.
- Empty pathnames now fail with `ENOENT` instead of resolving to the current
  directory.
- `getcwd(2)` validates that the current working directory still exists and
  returns `ENOENT` after it is removed.
- `chdir(2)` stores a canonical current working directory after successful
  component-wise resolution, so later `getcwd(2)` does not expose literal `.`
  or `..` path components.
- Host-backed absolute symlinks that point inside their guest mount are
  followed for `stat`/`open` while `readlink` still returns the original guest
  target text.
- BSD `flock(2)` locks are open-file-description locks. `LOCK_SH` is allowed
  on write-only descriptors, separate opens in the same process conflict, and
  `LOCK_NB` returns `EAGAIN` instead of being retried as a blocking syscall.
- PHPT section semantics now match upstream more closely: test `--INI--` is
  applied to `--FILE--` only, stable generated names are used for `--FILE--`
  and `--CLEAN--`, `--INI--` assignment whitespace is normalized, `{PWD}` in
  `--INI--`/`--ENV--` expands to the guest test directory, PHP-style trim
  removes edge NUL bytes for EXPECT matching, PHPT source/output bytes are
  preserved instead of UTF-8 decoded, EXPECTF `%r...%r` regex spans and
  percent placeholders follow upstream substitution ordering, flaky PHPTs retry
  once, and selected upstream control env vars such as `SKIP_SLOW_TESTS` pass
  through to guest PHP.
- Stream/socket behavior now covers the standard cases exercised by PHP's
  stream suite: abstract AF_UNIX addresses are not filesystem-backed, UDP
  `INADDR_ANY` destinations route to loopback, AF_INET6 loopback sockaddrs are
  round-tripped, accepted sockets preserve Kandelo's nonblocking status
  contract, and malformed numeric IPv4 names fail resolution instead of being
  treated as browser synthetic DNS names.
- Additional network PHPT coverage now passes for AF_UNIX datagram loopback,
  AF_INET6 UDP loopback, and browser-side rejection of syntactically invalid
  DNS names instead of assigning synthetic addresses to them.

## 2026-06-02 SQLite Allocator Status

After rebasing onto `origin/main` at `2e6293a50ccf996b1a434aa701057b862a46c587`,
the next official SQLite Node-host run reached 77/1416 jobs and 22419 SQLite
cases with 0 case errors before repeated wasm `unreachable` traps appeared in
path-heavy `stat`/`lstat` calls.

The trap mapped to the wasm kernel allocator path, not to SQLite itself:
`crates/kernel/src/lib.rs` used a global bump allocator whose `dealloc` was a
no-op. Temporary Rust allocations such as `Vec` allocations in path
normalization were leaked for the lifetime of the centralized kernel. Long
official SQLite runs therefore exhausted the kernel heap.

The wasm kernel now uses a lock-protected `dlmalloc::Dlmalloc` global allocator
with real `dealloc`, `alloc_zeroed`, and `realloc`. Validation so far:

- Wasm kernel release build passed.
- Host build passed.
- Host typecheck passed.
- Focused official SQLite Node run of `savepoint6.test`,
  `fts5origintext5.test`, `fts5ah.test`, and `sort4.test` completed 3/4 jobs
  before a 10 minute outer timeout: 10189 SQLite cases, 0 case errors.
- The incomplete focused job was `test/sort4.test`, which is marked
  `TESTRUNNER: superslow`; it was still running, not failed.

This fixes the immediate kernel heap leak/allocator exhaustion class. It does
not yet provide a complete SQLite `full` pass/fail matrix.

## 2026-06-03 SQLite Retry Status

Current focus remains official SQLite `full`, not SpiderMonkey. The Node-host
run was restarted after three root-cause fixes:

- Stale file-backed `MAP_SHARED` tracking after page-rounded `munmap` could
  corrupt anonymous mappings reused at the same address. This reproduced in
  `test/wal.test`; direct rerun now passes 581/581 cases.
- Rapid pthread create/join loops could exhaust the 16 reserved thread slots
  because slots were freed only after a later JS worker message. Slots are now
  reclaimed when the kernel confirms thread `SYS_EXIT`. Direct `sort4.test`
  now passes 11/11 without slot-exhaustion output, and the new
  `thread-slot-reuse` regression creates/joins 64 threads successfully.
- The next full `--jobs 4` run reached 74/1416 jobs before the official
  runner's own `testrunner.db` became genuinely malformed. The corrupt DB had
  zero-filled low pages, including the jobs table root page and the overflow
  page for the `CREATE TABLE jobs` schema record. The root cause was that
  centralized direct handlers for large `write`/`pwrite` and `writev`/`pwritev`
  bypassed the normal post-syscall shared-backing update path. A stale
  file-backed mapping cache could then flush or expose zero pages after the
  real file had been written. Those direct handlers now update and refresh
  shared backings before unblocking the guest. Regression:
  `examples/mmap_shared_large_pwrite.c`.

Focused validation now passing on Node:

- `host/test/mmap-shared.test.ts`: 3 passed, 1 skipped.
- `host/test/pthread.test.ts`: 3 passed.
- Direct official SQLite jobs: `wal.test` 581/581, `writecrash.test` 995/995,
  `rtree4.test` 112471/112471, `sort4.test` 11/11, and
  `fts5optimize2.test` 4/4.

Live official run:
`test-runs/sqlite-full-node-j4-after-large-write-sync-20260603-151517`.
Latest recorded stdout progress is at least 364/1416 jobs (25.71%), past the
previous 74-job malformed-DB blocker, with no visible SQLite case errors or
Kandelo runtime failures. Live DB reads are intentionally avoided while the
guest runner owns the WAL-mode control database; case counts are taken from
`testrunner.log` snapshots until the run finishes.

## 2026-06-02 SQLite Official Status

Detailed report: `docs/sqlite-official-test-report.md`.

The answer to "do we know exactly what parts of the full SQLite suite pass and
fail on Kandelo?" is currently no. We know the official inventory and we have
targeted official job results, but neither the Node nor browser host can yet
finish `full --jobs 1` and produce a trustworthy complete runner database.

The most important blocker is file-backed `MAP_SHARED` coherency. Kandelo
currently populates file-backed mappings by copying file bytes into each guest
process memory and writes mapped bytes back on `msync`/`munmap`. SQLite WAL
uses a file-backed `test.db-shm` mapping as live shared memory and does not
depend on `msync` for WAL-index coherence. That makes the observed
`busy2.test`, `wal3.test`, and `walsetlk.test` failures kernel/filesystem
correctness failures to fix before treating full SQLite numbers as meaningful.

Other known blockers are the browser `SharedFS` 64-FD cap reducing
`manydb.test`, a SQLite testfixture build mismatch around
`SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, and a browser artifact bug where the
timeboxed full run exported a valid 1024-byte SQLite DB with no `jobs` table.

## 2026-06-01 SQLite Rebase Status

The branch was rebased onto `origin/main` at
`95e31d2588e8fa7653796e0245c023f26fc59556` ("Reduce initial process memory
allocation"). The old branch was preserved as
`backup/prove-by-guest-software-tests-pre-main-rebase-20260601`.

The rebase plus current work fixed the immediate SQLite kernel trap found after
the main memory-layout changes:

- The first post-rebase full SQLite run failed in the kernel on `munmap`.
  The root issue was `MemoryManager::munmap` rebuilding the entire mapping
  table into a fresh `Vec` on every unmap; in the wasm kernel, allocation
  failure/panic becomes `unreachable`.
- `MemoryManager::munmap` now updates mappings in place, preserves existing
  mapping-table storage for non-splitting unmaps, and propagates `ENOMEM` only
  if a middle split cannot reserve one extra slot.
- Validation: native kernel unit tests passed 866/866; focused host lifecycle
  regressions passed 14/14; the targeted SQLite repro set
  (`capi2.test`, `avtrans.test`, `temptable2.test`, `backup_malloc.test`)
  passed 4/4 jobs and 2572/2572 cases with 0 errors in
  `test-runs/main-rebase-full/20260601-155813-sqlite-targeted/`.

The next full Node-host official SQLite run was stopped, not completed:

- Run root:
  `test-runs/main-rebase-full/20260601-160004-sqlite-full-node/`.
- At stop time the database had 1394 total jobs, 45 done, 91 failed,
  4 running, 1254 ready, 8183 reported cases, and 4554 case errors.
- The run log had no `handleSyscall kernel threw` or wasm out-of-bounds lines.
  It did include one guest `testfixture.wasm` `unreachable` from pid 499; the
  parent testrunner continued afterward, so this is not currently classified as
  the same kernel-fatal class as the earlier `munmap` trap.
- The dominant remaining failure pattern is SQLite-level `database is locked`
  output. A serial subset rerun with `--jobs 1` reduced five previously noisy
  failures to 5 jobs, 267 cases, and 3 case errors:
  `test-runs/main-rebase-full/20260601-160321-sqlite-failed-subset-j1/`.
  In that subset, `tkt3731.test`, `func4.test`, and `vacuum5.test` passed;
  `writecrash.test` still failed with `database is locked`, and `upfrom4.test`
  still failed two SQL-result cases.

Official SQLite suite inventory after the `getdents64` fix:

- The large SQLite test suite is defined by upstream
  `packages/registry/sqlite/sqlite-full-src/test/testrunner.tcl`, with Tcl
  file sets from `test/permutations.test` and the `all` config list from
  `test/testrunner_data.tcl`.
- `full` means the full Tcl file set. Current explain plans queue 1416 Tcl
  jobs on both Node and browser hosts:
  `test-runs/main-rebase-full/20260601-212612-sqlite-full-explain-node-getdents-fix/`
  and
  `test-runs/main-rebase-full/20260601-212612-sqlite-full-explain-browser-getdents-fix/`.
- `all` means `full` plus SQLite's official config permutations. Current
  explain plans queue 10523 Tcl jobs on both Node and browser hosts:
  `test-runs/main-rebase-full/20260601-212633-sqlite-all-explain-node-getdents-fix/`
  and
  `test-runs/main-rebase-full/20260601-212657-sqlite-all-explain-browser-getdents-fix/`.
  The largest config groups are `full` 1416, `memsubsys1` 1329,
  `memsubsys2` 1330, `no_mutex_try` 1331, `inmemory_journal` 1256,
  `journaltest` 1164, `prepare` 1221, and `mmap` 1224.
- SQLite's "around 300,000 tests" figure refers to the internal case counts
  each Tcl job reports as `N errors out of M tests`. Those counts are not known
  from `--explain`; they are aggregated into `testrunner.db` as jobs execute.
  Earlier stopped official `full` runs had already reported 586267, 836413,
  and 839152 cases before completion, so the official path is the path that
  reaches the hundreds-of-thousands case count.
- `scripts/run-software-unit-tests.sh` now runs SQLite through the official
  testrunner by default. Set `SQLITE_OFFICIAL_PERMUTATION=all` to run the
  wider permutation set.

The earlier 1394/1393 `full` explain counts were wrong. The VFS image
contained the missing files, but the kernel consumed a host directory entry
before checking whether the guest `getdents64` buffer had room for it. If the
entry did not fit, the syscall returned without preserving that entry, so the
next `getdents64` call skipped it. `OpenFileDesc` now carries one pending
directory entry across calls, `lseek(SEEK_SET)` clears that pending entry, and
`sys_getdents64` advances the directory offset only after successfully writing
an entry to guest memory. The regressions
`test_getdents64_keeps_entry_that_does_not_fit` and
`test_getdents64_resumes_synthetic_entries_after_full_buffer` cover these
boundary cases.

The next official Node `full --jobs 1` run was intentionally stopped before
completion:

- Run root:
  `test-runs/main-rebase-full/20260601-220000-sqlite-full-node-j1-getdents-synth-fix/`.
- At stop time it had 1416 jobs queued, 17 done, 1 failed, 1 running,
  1397 ready, 102908 reported SQLite cases, and 10 case errors.
- The failed job was `test/busy2.test`. Its first two failures showed
  `PRAGMA journal_mode = wal` returning `delete`. That was an invalid Kandelo
  artifact, not an upstream-suite issue: `packages/registry/sqlite/build-sqlite.sh`
  and `packages/registry/sqlite/build-testfixture.sh` both used
  `-DSQLITE_OMIT_WAL`.
- The no-WAL flag has been removed from both builds. `sqlite3.wasm`,
  `testfixture.wasm`, and `apps/browser-demos/public/sqlite-test.vfs.zst`
  were rebuilt with WAL enabled.
- Targeted validation through the official runner:
  `test-runs/sqlite-official-node-full/20260601-213948/` ran
  `busy2.test` and reduced the failure to 4 errors out of 29 cases. WAL mode
  now works; the remaining failures are checkpoint/accounting differences:
  expected `wal_checkpoint` results such as `{0 4 3}` are observed as
  `{0 4 0}` or `{0 3 3}`.

The remaining `busy2.test` failures expose a real platform bug, not a harness
problem. SQLite WAL uses byte-range locks plus a file-backed `MAP_SHARED`
mapping of `test.db-shm` as live shared memory. Kandelo currently populates a
file-backed mapping by copying file bytes into each process memory and writes
MAP_SHARED data back only on `msync` or `munmap`. That is not coherent shared
memory between separately allocated guest process memories. SQLite does not
use `msync` for its WAL index, so separate processes can observe stale
wal-index state even though fcntl byte locks are visible. The root fix is to
implement sound file-backed `MAP_SHARED` coherency across processes, then rerun
`busy2.test` and restart the full official SQLite run.

SpiderMonkey official tests remain paused until the SQLite/kernel reliability
work is stable. The previous SpiderMonkey official Node path did not include
browser-host official execution, so it is not counted as proof for the
platform.

## 2026-05-29 SQLite/SpiderMonkey Status

SpiderMonkey official tests are intentionally paused. The browser host still
allocates a full 1 GiB shared WebAssembly memory per guest process because the
syscall channel is placed near max memory. That must be fixed in the memory
layout, not worked around in the harness, before official SpiderMonkey browser
numbers are meaningful.

SQLite official `full` on the Node host is the active focus:

- `test-runs/sqlite-official-node-full-thread-ceiling/20260529-142042/`
  was stopped after the old Node crash path wedged parent `waitpid`. The DB
  had 1394 jobs, 560 done, 21 failed, 4 running, 809 ready, 586267 reported
  test cases, and 451 case errors.
- `test-runs/sqlite-official-node-full-crash-reap-fix/20260529-155403/`
  progressed further, then was stopped on a kernel wasm `memory access out of
  bounds` while `waitpid` reaped a child through `kernel_remove_process`. After
  the process was stopped, the DB passed `pragma integrity_check` and reported
  1394 jobs, 873 done, 41 failed, 4 running, 476 ready, 836413 reported test
  cases, and 617 case errors.
- The kernel allocator now records allocation metadata and coalesces free-list
  overlaps defensively instead of deriving the free interval from the caller's
  layout. The Node worker crash path now ignores duplicate error notifications
  after the process has already been removed from the host process map.
- Validation after those fixes: kernel memory-manager unit tests passed 20/20,
  `host/test/wasm-trap.test.ts` passed 3/3, and a targeted official SQLite run
  of `fallocate.test` and `select7.test` failed cleanly with 2 reported case
  errors instead of hanging.
- `test-runs/sqlite-official-node-full-allocator-fix/20260529-173059/`
  reached 1394 jobs total, 875 done, 39 failed, 4 running, 476 ready,
  839152 reported test cases, and 612 case errors before it was stopped. The
  first kernel failure was again `RuntimeError: memory access out of bounds`
  during `kernel_remove_process` from `consumeExitedChild()` while handling
  `waitpid`; active jobs were `pagerfault2.test`, `analyzeE.test`,
  `fts3fault.test`, and `backup_ioerr.test`.
- The new OOB mapped to a `memory.copy` inside Rust's BTreeMap removal of a
  large `Process` value. The most plausible root cause found so far was a
  wasm-only allocator bug: allocations carved from a free block could leave the
  suffix `FreeNode` at an unaligned `user + requested` address. That alignment
  bug is now patched, and deallocation rejects unaligned allocation metadata.
  This is under validation, not yet proven by a complete SQLite `full` run.
- Validation after the alignment patch: full native kernel tests passed
  850/850, `host/test/wasm-trap.test.ts` passed 3/3, and a targeted official
  SQLite run for `pagerfault2.test`, `analyzeE.test`, `fts3fault.test`, and
  `backup_ioerr.test` is running under
  `test-runs/sqlite-official-node-reap-oob-regression/20260529-193249/`.

SQLite's upstream testrunner repeatedly prints
`WARNING: Multi-threaded tests skipped: Linked against a non-threadsafe Tcl build`.
Those skipped Tcl-threaded cases are a caveat on all current SQLite official
numbers.

## Important Corrections

The previous status overstated two areas:

- The `scripts/run-spidermonkey-unit-tests.sh` runner is not the official
  Mozilla SpiderMonkey suite. It is a Kandelo smoke suite that exercises shell
  builtins, Intl, workers, Atomics, file APIs, GC pressure, promises, and error
  handling. Mozilla's official shell suites are `js/src/tests/jstests.py` and
  `js/src/jit-test/jit_test.py`.
- The SQLite results counted Tcl test scripts, not individual SQLite test
  cases. SQLite's own documentation distinguishes `veryquick`, `full`, `all`,
  and `release`: `full` is all Tcl scripts, `all` is `full` plus permutations,
  and `release` runs many build configurations plus fuzz/thread/mptest-style
  work. The completed Kandelo runs executed the 1159 Tcl scripts once; they did
  not run SQLite's official `all` or `release` permutations.

`scripts/run-sqlite-upstream-tests.sh` and the browser SQLite runner now parse
and aggregate the internal `N errors out of M tests` counts for future runs.
The 2026-05-28 logs do not contain the per-script stdout needed to reconstruct
the exact SQLite case count after the fact.

## Entry Points

```bash
# Default pragmatic suite set on both hosts. SpiderMonkey here is the smoke
# suite because official browser-host SpiderMonkey is not wired yet.
scripts/run-software-unit-tests.sh

# Run one host.
scripts/run-software-unit-tests.sh --host node
scripts/run-software-unit-tests.sh --host browser

# Run selected suites. `mysql` is accepted as an alias for MariaDB.
scripts/run-software-unit-tests.sh --host browser sqlite php nodejs
scripts/run-software-unit-tests.sh --host node mariadb spidermonkey-official
```

| Suite | Node.js host | Browser host |
|-------|--------------|--------------|
| MariaDB / mysql-test | `scripts/run-mariadb-tests.sh --all` | `scripts/run-browser-mariadb-tests.sh --all` |
| SQLite direct Tcl scripts | `scripts/run-sqlite-upstream-tests.sh --all` | `scripts/run-browser-sqlite-upstream-tests.sh --all` |
| SQLite official testrunner | `scripts/run-sqlite-official-tests.sh --host node --permutation full` | `scripts/run-sqlite-official-tests.sh --host browser --permutation full` |
| PHP PHPT runtime tests | `scripts/run-php-upstream-tests.sh --host node --all` | `scripts/run-php-upstream-tests.sh --host browser --all` |

PHP PHPT harness notes:

```bash
# Full php-src PHPT run (all discovered .phpt files).
scripts/run-php-upstream-tests.sh --host node --all
scripts/run-php-upstream-tests.sh --host browser --all

# Smoke/debug a prefix or selector and emit machine-readable results.
scripts/run-php-upstream-tests.sh --host node --limit 25 --json
scripts/run-php-upstream-tests.sh --host browser Zend/tests/001.phpt --json

# Split a full sorted discovery set for lower-memory CI or AO shards.
scripts/run-php-upstream-tests.sh --host node --all --shard 1/16 --json
scripts/run-php-upstream-tests.sh --host browser --all --offset 500 --limit 100 --json

# Write docs/php-upstream-test-report.md for the selected host/run.
scripts/run-php-upstream-tests.sh --host node --all --report
```

The PHPT harness writes the generated `--FILE--` section as the upstream
`<test-name>.php` beside each `.phpt` file, then restores any pre-existing file.
This matches php-src's `run-tests.php` behavior for tests that assert `__FILE__`
or exception source locations. Browser runs use the same generated path inside
the `/php-src` VFS image and start a temporary Vite server; set
`PHP_TEST_VITE_PORT` if port `5201` is occupied.

The runner also mirrors `run-tests.php` comparison and working-directory
semantics: CRLF is normalized and both actual and expected output are trimmed
before comparison, `EXPECTF` placeholders include php-src's `%r...%r` regex and
`%0` NUL forms, and each PHP process runs with `TEST_PHP_SRCDIR` as its current
directory so source-root-relative paths such as `./ext/standard/tests/file`
behave like upstream.

| SpiderMonkey smoke | `scripts/run-spidermonkey-unit-tests.sh --host node` | `scripts/run-spidermonkey-unit-tests.sh --host browser` |
| SpiderMonkey official | `scripts/run-spidermonkey-official-tests.sh --host node --suite both` | Not implemented |
| Node.js library tests | `scripts/run-nodejs-library-tests.sh --host node --all` | `scripts/run-nodejs-library-tests.sh --host browser --all` |

## Official SpiderMonkey

The official Node-host path uses Mozilla's Python harnesses with an executable
shim at `scripts/kandelo-js-shell-wrapper.sh`. The shim is passed to the
official harness as the `js` shell, but it runs `packages/registry/spidermonkey/bin/js.wasm`
inside Kandelo via `examples/run-example.ts`.

`jstests.py` is run with shell WPT disabled by default
(`SPIDERMONKEY_OFFICIAL_WPT=disabled`) because the local Firefox source tree is
missing some Python import path setup needed by the WPT manifest updater. Set
`SPIDERMONKEY_OFFICIAL_WPT=enabled` after that dependency path is fixed.

```bash
# One small official smoke from each Mozilla harness.
scripts/run-spidermonkey-official-tests.sh --suite both --smoke

# Full official JS shell tests.
scripts/run-spidermonkey-official-tests.sh --suite jstests
scripts/run-spidermonkey-official-tests.sh --suite jit-tests
scripts/run-spidermonkey-official-tests.sh --suite both

# Pass jstests path selectors after --.
scripts/run-spidermonkey-official-tests.sh --suite jstests -- non262/Array/array-001.js
```

Browser-host official SpiderMonkey remains open work. The browser would need a
persistent Playwright/Vite bridge or a browser-native implementation of the
Mozilla harness command scheduling, plus a VFS image containing the official
`js/src/tests` and `js/src/jit-test` trees.

## SQLite Scope

There are now two SQLite paths:

- Direct script runner: runs each `test/*.test` file once through `testfixture`.
  This is the runner used for the completed Node and browser results above.
- Official testrunner: invokes SQLite's upstream `test/testrunner.tcl` for
  `veryquick`, `full`, or `all` on the Node or browser host. A `full main.test`
  smoke run completed with `0 errors out of 95 tests`.

```bash
# Direct runner, one pass over test/*.test.
scripts/run-sqlite-upstream-tests.sh --all
scripts/run-browser-sqlite-upstream-tests.sh --all

# Official upstream testrunner permutations.
scripts/run-sqlite-official-tests.sh --host node --permutation veryquick
scripts/run-sqlite-official-tests.sh --host node --permutation full
scripts/run-sqlite-official-tests.sh --host node --permutation all
scripts/run-sqlite-official-tests.sh --host browser --permutation full

# Explain planned official work without running it.
scripts/run-sqlite-official-tests.sh --host node --permutation all --explain
```

SQLite `release`, `mdevtest`, and `sdevtest` are not wired as Kandelo guest
runs yet because they require rebuilding multiple host configurations and
running additional fuzz/thread/mptest binaries.

## Prerequisites

Build or fetch `kernel.wasm` before running any browser or Node suite:

```bash
bash build.sh
# or
scripts/fetch-binaries.sh
```

MariaDB needs `mariadbd`, `mysqltest.wasm`, and the `mysql-test/` tree:

```bash
bash packages/registry/mariadb/build-mariadb.sh
```

SQLite needs Tcl, SQLite, and the testfixture binary:

```bash
bash packages/registry/tcl/build-tcl.sh
bash packages/registry/sqlite/build-sqlite.sh
bash packages/registry/sqlite/build-testfixture.sh
```

PHP needs the CLI wasm binary. The PHPT source tree is taken from
`PHP_SOURCE_DIR`, a local `packages/registry/php/php-src`, or the package
source tarball:

```bash
bash packages/registry/php/build-php.sh
```

SpiderMonkey needs the standalone JS shell wasm binary:

```bash
bash packages/registry/spidermonkey/build-spidermonkey.sh
```

Node.js library tests use the SpiderMonkey-backed `node.wasm` package and the
upstream Node.js source tree. By default the runner downloads the source bundle
matching the host `node` version and verifies it with Node.js `SHASUMS256.txt`;
override with `NODEJS_TEST_VERSION` or `NODEJS_SOURCE_DIR`:

```bash
bash packages/registry/spidermonkey-node/build-spidermonkey-node.sh
scripts/run-nodejs-library-tests.sh --host node --list
```

Browser runs build suite-specific VFS images under
`apps/browser-demos/public/` when missing:

```bash
bash images/vfs/scripts/build-sqlite-test-vfs-image.sh
bash images/vfs/scripts/build-php-test-vfs-image.sh
bash images/vfs/scripts/build-spidermonkey-test-vfs-image.sh
bash images/vfs/scripts/build-nodejs-test-vfs-image.sh
```

# SQLite Official Test Suite Status on Kandelo

Status date: 2026-06-04.

## 2026-06-04 Maintenance Resume Checkpoint

This section records the exact stopping point before system maintenance.

### Current Browser Host State

The browser host is no longer blocked at `writecrash.test`. The current
iteration moved the browser official `full` run through the previous fork/exec
memory failures and reached a new blocker around `test/sort4.test`.

Latest useful browser full checkpoint:

```text
test-runs/sqlite-full-browser-pool8-j2-20260604
```

Command shape:

```bash
bash scripts/run-sqlite-official-tests.sh --host browser --permutation full --jobs 2 --timeout-ms 300000 --results-dir test-runs/sqlite-full-browser-pool8-j2-20260604
```

Result before the outer timeout:

| Total jobs | Done | Failed | Running | Ready | SQLite cases | Case errors | Running job |
|------------|------|--------|---------|-------|--------------|-------------|-------------|
| 1416 | 40 | 0 | 1 | 1375 | 12,206 | 0 | `test/sort4.test` |

Interpretation: this was a timeout/stall checkpoint, not a SQLite failure. No
browser shared-memory allocation failure occurred through the previous OOM
points. The run timed out with `test/sort4.test` still marked running and no
case errors recorded.

Isolated comparison:

| Host | Run | Result |
|------|-----|--------|
| Node | `test-runs/sqlite-node-sort4-20260604` | Completed in 54s, 1/1 job passed, 11 cases, 0 errors |
| Browser | `test-runs/sqlite-browser-sort4-pool8-20260604` | Still at `0/1` after ~3 minutes; killed for system maintenance |

Next step after maintenance: resume by diagnosing browser-only `sort4.test`.
Start with a focused browser run and instrument the blocked syscall/retry path:

```bash
rm -rf test-runs/sqlite-browser-sort4-resume-20260604
bash scripts/run-sqlite-official-tests.sh \
  --host browser \
  --permutation full \
  --jobs 1 \
  --timeout-ms 900000 \
  --results-dir test-runs/sqlite-browser-sort4-resume-20260604 \
  sort4.test
```

If it again sits at `tcl(0/1) r1` while Node completes, inspect browser
kernel-worker blocked channels, pending retries, pthread lifecycle, and PTY
output around `sort4.test`. Do not treat this as a harness skip or xfail.

### Current Fixes In Progress

The current worktree contains browser host lifecycle fixes that are not yet
committed. Important touched files:

- `host/src/browser-kernel-worker-entry.ts`
- `host/src/kernel-worker.ts`
- `libc/glue/channel_syscall.c`
- `apps/browser-demos/pages/sqlite-test/main.ts`
- `apps/browser-demos/vite.config.ts`
- `scripts/browser-sqlite-official-runner.ts`
- rebuilt `packages/registry/sqlite/bin/testfixture.wasm`
- rebuilt `packages/registry/sqlite/sqlite-glue-objs/channel_syscall.o`
- rebuilt `apps/browser-demos/public/sqlite-test.vfs.zst`

Key changes made during this iteration:

- Added a `__wasm_posix_channel_error_traps` glue export and made `CH_ERROR`
  trap after a fatal channel wake, so browser workers can prove quiescence
  before their `SharedArrayBuffer` memory is recycled.
- Browser process memory recycling now waits for worker-main quiescence instead
  of recycling immediately after process exit or termination.
- Exec no longer directly reuses the old process memory. Modern exec paths
  retire old workers through the fatal-wake/quiescence path.
- Browser process memory pool is layout-aware. Reuse requires matching
  ptr-width, max pages, current pages, channel/control layout, and thread-slot
  layout.
- Browser process memory pool is globally capped at 8 idle memories and clears
  the idle pool under `WebAssembly.Memory` allocation pressure before retrying.
- Browser SQLite page no longer enables syscall-log pointer width unless the
  env var explicitly requests it.
- Browser SQLite Vite runs disable HMR and ignore generated run artifacts.
- Added failure-only fork diagnostics in `host/src/kernel-worker.ts` and
  browser allocation diagnostics in `host/src/browser-kernel-worker-entry.ts`.

Validation already run after these edits:

| Check | Result |
|-------|--------|
| `npm --prefix host run typecheck` | Passed after the latest predicate/pool changes |
| Browser `writecrash.test` targeted run before later pool work | 995 cases, 0 errors |
| Browser full run before exec fatal-wake fix | Failed at ~31/1416 with `WebAssembly.Memory(): could not allocate memory` |
| Browser full run after exec fatal-wake/layout-aware pool work | Reached 49/1416 with no OOM, then later exposed pool fragmentation |
| Browser full run with global pool cap 8 | Timed out at 40/1416, 12,206 cases, 0 case errors, running `sort4.test` |
| Node isolated `sort4.test` | Passed 11/11 cases in 54s |

Known remaining cleanup before considering this PR ready:

- Expected `unreachable` traps from intentionally killed crash-test children
  still appear as browser process-worker errors in logs. They are not currently
  causing SQLite case failures, but the quiescence/retired-worker path should
  consume them instead of forwarding them to guest stderr.
- Browser `sort4.test` needs root-cause diagnosis. It is browser-specific based
  on the Node comparison above.
- Preserve unrelated dirty worktree changes. This worktree contains many
  pre-existing modified files outside the SQLite/browser lifecycle work.

## Bottom Line

The Node-host official SQLite `full` suite now completes end to end on Kandelo.
The latest full run queued and finalized all 1416 official Tcl jobs, executing
1,703,255 SQLite internal cases. Result: 1416 jobs passed, 0 jobs failed,
0 jobs were left running or omitted, and there were 0 SQLite case errors.

Browser-host official `full` still needs the same end-to-end run with the
rebuilt artifacts. The current browser checkpoint is recorded above: the run is
past the earlier `writecrash.test` blocker and currently needs browser-only
`test/sort4.test` diagnosis.

## 2026-06-04 Earlier Browser Host Blocker

This section is preserved as historical context. It was superseded by the
maintenance checkpoint above after browser process-memory lifecycle fixes moved
the full run past `writecrash.test`.

Earlier browser evidence:

| Check | Result |
|-------|--------|
| `test/walfault.test` | 1/1 job passed, 6374 cases, 0 errors |
| `test/sysfault.test` | 1/1 job passed, 1372 cases, 0 errors |
| `test/func7.test` + `ext/rtree/rtree5.test` | 2/2 jobs passed, 90 cases, 0 errors |
| `test/writecrash.test` | Fails; latest diagnostic run reached 11 cases with 1 error |

The stopped browser full run reached only `2/1416` jobs (`0.14%`) before the
renderer stayed CPU-bound without further official progress. Isolating the next
early jobs showed `writecrash.test` is the first known browser-host blocker.

Diagnostic run:
`test-runs/sqlite-browser-writecrash-syslog2-20260604`.

The failing path is not a SQLite data-corruption assertion yet. It is the Tcl
process-launch path used by `crash_on_write`: Tcl creates an exec-error pipe,
forks, and the child is supposed to exec `/usr/bin/testfixture`. The syscall
trace shows the failing child after `pipe()`/`fork()`:

```text
[102] pipe(...) = 0
[102] fcntl(6, F_SETFD, FD_CLOEXEC) = 0
[102] fcntl(7, F_SETFD, FD_CLOEXEC) = 0
[102] fork()
[102] close(7) = 0
[102] read(6, 223) = -1 (EAGAIN, will retry)
[106] write(6, 23) = -1 (EBADF)
```

Fd `6` is the read end of the exec-error pipe; the child should write startup
errors to the write end (`7`). The browser-host root cause is therefore in
fork/vfork process state, fd/pipe endpoint inheritance, or fork continuation
state around Tcl's exec pipe setup. This is a Kandelo process/pipe correctness
bug to fix before restarting the browser full run.

## 2026-06-04 Corrected Full Node Host Result

Run:
`test-runs/sqlite-full-node-j2-setlk2-20260604-002908`.

Command shape:

```bash
bash scripts/run-sqlite-official-tests.sh --host node --permutation full --jobs 2 --timeout-ms 21600000
```

Final official runner database summary:

| Jobs | Passed jobs | Failed jobs | Omitted | Running | Ready | SQLite cases | Case errors | Elapsed |
|------|-------------|-------------|---------|---------|-------|--------------|-------------|---------|
| 1416 | 1416 | 0 | 0 | 0 | 0 | 1,703,255 | 0 | 01:37:59 |

This run used rebuilt SQLite artifacts with
`-DSQLITE_ENABLE_SETLK_TIMEOUT=2` in both `build-sqlite.sh` and
`build-testfixture.sh`. No out-of-memory failure, runner database corruption,
stuck jobs, pthread slot exhaustion, kernel trap, or SQLite case failure was
observed.

Targeted validation before the full rerun:

| Check | Result |
|-------|--------|
| `busy2.test` standalone | 1/1 job passed, 29 cases, 0 errors |
| `busy2.test` + `fuzz3.test`, `--jobs 2` | 2/2 jobs passed, 45,032 cases, 0 errors |
| Lock-focused set: `busy2.test`, `walsetlk.test`, `lock4.test`, `savepoint2.test`, `swarmvtab.test`, `rtree2.test`, `--jobs 4` | 6/6 jobs passed, 4,347 cases, 0 errors |

## 2026-06-04 Pre-Correction Full Node Host Result

Run:
`test-runs/sqlite-full-node-j2-pselect-deadline-20260603-223207`.

Command shape:

```bash
bash scripts/run-sqlite-official-tests.sh --host node --permutation full --jobs 2 --timeout-ms 21600000
```

Final official runner database summary:

| Jobs | Passed jobs | Failed jobs | Omitted | Running | Ready | SQLite cases | Case errors | Elapsed |
|------|-------------|-------------|---------|---------|-------|--------------|-------------|---------|
| 1416 | 1415 | 1 | 0 | 0 | 0 | 1,703,215 | 1 | 01:37:57 |

The only failed job was `test/busy2.test`: 29 cases, 1 case error, 8194 ms.
No out-of-memory failure, runner database corruption, stuck jobs, pthread slot
exhaustion, or kernel trap was observed in this completed run.

Current diagnosis of `busy2.test`:

| Check | Result | Interpretation |
|-------|--------|----------------|
| Standalone `busy2` timing helper | 0 errors out of 11 tests; measured waits 1.325770s and 1.009379s | The test passes in isolation within SQLite's expected 0.95s-1.5s window. |
| Instrumented official `busy2.test` with concurrent `fuzz3.test`, `--jobs 2` | Reproduced failure; measured waits 1.842011s and 1.013869s | The failing case is a concurrent execution/timing problem. |
| Sleep trace for the same repro | 2076 sleep completions; average overshoot 0.393 ms, max overshoot 2.558 ms | There is no single lost timer; many 1 ms lock-timeout sleeps accumulate enough overhead to exceed the test window. |

The artifact builders compiled SQLite with `-DSQLITE_ENABLE_SETLK_TIMEOUT=1`
in this failed run. SQLite's own official testrunner data for the Apple-style
lock-timeout build uses `-DSQLITE_ENABLE_SETLK_TIMEOUT=2`. In `src/os_unix.c`,
`=1` stores the requested timeout as a millisecond retry count, causing the
failed path to perform roughly 1000 separate 1 ms lock polls. The `=2` branch
stores only a boolean and avoids converting one timeout into that polling loop.
Rebuilding the Kandelo SQLite artifacts with `=2` produced the corrected
zero-error full result above.

## 2026-06-03 Live Retry Status

After rebasing onto current `origin/main`, three Node-host blockers were
reproduced, diagnosed, and fixed while driving the official full run forward.

1. `test/wal.test` crashed deterministically at `wal-18.2.7.2.4` in
   musl malloc after an anonymous `mmap` reused an address that previously held
   a file-backed `MAP_SHARED` mapping. The root cause was host-side shared mmap
   bookkeeping that removed entries using the guest's unrounded `munmap` length
   while the kernel unmaps whole 64 KiB Wasm pages. The host could then keep a
   stale file-backed mapping entry for memory the kernel had already freed.
   `host/src/kernel-worker.ts` now treats shared mappings like VMAs on
   `munmap`: page-rounds the range and removes, trims, or splits overlapping
   entries. Regression: `examples/mmap_shared_munmap_reuse.c`.

2. `test/sort4.test` emitted repeated `process reserved pthread slots
   exhausted (reserved=16, active=16)` messages even though its SQLite cases
   reported 0 errors. The root cause was slot reclamation lag: the kernel had
   processed each thread's `SYS_EXIT`, but the host waited for a later JS
   worker `thread_exit` message before freeing the reserved pthread slot.
   Rapid create/join loops could therefore exhaust slots without true
   concurrency. Node host, browser host, and the main-thread Vitest helper now
   reclaim the slot at the kernel-confirmed thread-exit point and terminate the
   finished worker. Regression: `examples/thread-slot-reuse.c`.

3. The next full Node `--jobs 4` run reached 74/1416 jobs (5.23%) before the
   official runner's own `testrunner.db` became malformed while marking jobs
   finished. Text-log parsing showed 77 completed job log entries, 150222
   internal SQLite cases, and 0 SQLite case errors before the runner control
   DB failed. The final DB was genuinely corrupt: page 2, the jobs table root,
   and page 3, the overflow page containing the rest of the `CREATE TABLE jobs`
   schema record, were zero-filled. The root cause was in Kandelo's centralized
   direct large-write/writev paths. Those handlers bypassed the normal
   post-file-syscall shared-backing update path, so a stale file-backed mapping
   cache could keep or flush zero pages after the real file had been written.
   Direct large `write`/`pwrite` and `writev`/`pwritev` handlers now update and
   refresh shared backings before unblocking the guest. Regression:
   `examples/mmap_shared_large_pwrite.c`.

Validation after these fixes:

| Check | Result |
|-------|--------|
| `host/test/mmap-shared.test.ts` | 3 passed, 1 skipped |
| `host/test/pthread.test.ts` | 3 passed |
| Direct `test/wal.test` | 0 errors out of 581 cases |
| Direct `test/writecrash.test` | 0 errors out of 995 cases |
| Direct `ext/rtree/rtree4.test` | 0 errors out of 112471 cases |
| Direct `test/sort4.test` after thread reclaim fix | 0 errors out of 11 cases, no slot-exhaustion output |
| Direct `ext/fts5/test/fts5optimize2.test` | 0 errors out of 4 cases |

The current live Node official run is:

```text
test-runs/sqlite-full-node-j4-after-large-write-sync-20260603-151517
```

Command shape:

```bash
bash scripts/run-sqlite-official-tests.sh --host node --permutation full --jobs 4
```

As of the latest recorded checkpoint, runner stdout had reached at least
364/1416 jobs (25.71%), past the previous 74-job malformed-DB blocker, with no
visible SQLite case errors, `RuntimeError`, `onClone failed`, or pthread-slot
exhaustion output. Live host-side `sqlite3` reads are intentionally avoided
while the guest owns the WAL-mode runner DB; interim case totals are taken from
`testrunner.log` snapshots until the run finishes.

## What Counts As The Full Suite

The authoritative entry point is SQLite's upstream
`packages/registry/sqlite/sqlite-full-src/test/testrunner.tcl`.

Current `--explain` inventory through Kandelo:

| Host | Permutation | Official testrunner jobs |
|------|-------------|--------------------------|
| Node | `full` | 1416 |
| Browser | `full` | 1416 |
| Node | `all` | 10523 |
| Browser | `all` | 10523 |

`full` is the full Tcl file set. `all` is `full` plus SQLite's official config
permutations. The `all` config groups include `full` 1416, `memsubsys1` 1329,
`memsubsys2` 1330, `no_mutex_try` 1331, `inmemory_journal` 1256,
`journaltest` 1164, `prepare` 1221, and `mmap` 1224.

SQLite's "around 300,000 tests" figure refers to internal Tcl case counts
printed at runtime as `N errors out of M tests`, not to the number of
testrunner jobs. One Tcl job can contain tens of thousands of internal cases.
That is why earlier stopped official `full` attempts could already report
586267, 836413, and 839152 cases before completion. They were accumulating
SQLite internal case counts, not creating extra testrunner jobs.

The current Tcl build prints this warning in the logs:

```text
WARNING: Multi-threaded tests skipped: Linked against a non-threadsafe Tcl build
```

That warning is a caveat on all current official SQLite results.

## Current Completed Targeted Evidence

These are official `testrunner.tcl` jobs run intentionally as targeted
reproductions or controls. They are real results for those jobs only; they are
not a full-suite result.

| Job set | Node result | Browser result | Interpretation |
|---------|-------------|----------------|----------------|
| `boundary2.test` | 3022/3022 cases passed | 3022/3022 cases passed | Large deterministic SQL control passes on both hosts. |
| `walhook.test` + `e_walhook.test` | 34/34 cases passed | 34/34 cases passed | Basic WAL hook behavior passes on both hosts. |
| `tkt-2ea2425d34.test` | 2/2 cases passed | 2/2 cases passed | Small regression control passes on both hosts. |
| `busy2.test` | 25/29 cases passed, 4 errors | 25/29 cases passed, 4 errors | WAL checkpoint/busy accounting is wrong in the same way on both hosts. |
| `upfrom4.test` | 10/12 cases passed, 2 errors | 10/12 cases passed, 2 errors | Build artifact mismatch: `UPDATE ... LIMIT` syntax is rejected. |
| `writecrash.test` | 7/8 cases passed, 1 error | 7/8 cases passed, 1 error | Crash/recovery child path hits `database is locked`. |
| `manydb.test` | 553/901 cases passed, 348 errors | 58/58 cases passed | Browser result is reduced scale because browser `SharedFS` caps FDs at 64. |

Aggregates for this targeted set:

| Host | Jobs | Cases | Case errors |
|------|------|-------|-------------|
| Node | 8 | 4006 | 355 |
| Browser | 8 | 3163 | 7 |

The browser aggregate is not comparable for `manydb.test`: that test scales its
own size by probing available file descriptors. On Node it reaches 300
databases and 901 cases; on the browser host it reaches 19 databases and 58
cases because `host/src/vfs/sharedfs-vendor.ts` has `MAX_FDS = 64`.

## Latest Node-Host Allocator Finding

After rebasing onto `origin/main` at `2e6293a50ccf996b1a434aa701057b862a46c587`,
a no-live-DB official Node run reached 77/1416 jobs and 22419 SQLite cases with
0 case errors before repeated wasm `unreachable` traps appeared while servicing
`stat`/`lstat` syscalls.

The root cause was a kernel allocator bug. The wasm kernel used a global bump
allocator in `crates/kernel/src/lib.rs`; `dealloc` was a no-op. The centralized
kernel is expected to service many guest processes indefinitely, but temporary
Rust allocations from syscall paths, including path normalization, were leaked
for the lifetime of the kernel. Long official SQLite runs therefore exhausted
the kernel heap.

The kernel now uses a lock-protected `dlmalloc::Dlmalloc` global allocator with
real `dealloc`, `alloc_zeroed`, and `realloc`. Validation so far:

| Run | Host | Jobs completed | Cases | Case errors | Notes |
|-----|------|----------------|-------|-------------|-------|
| `test-runs/sqlite-focused-post-dlmalloc-20260602-212151` | Node | 3/4 | 10189 | 0 | Focused official run of `savepoint6.test`, `fts5origintext5.test`, `fts5ah.test`, and `sort4.test`; timed out at 10 minutes with only `test/sort4.test` still running. |

`sort4.test` is marked `TESTRUNNER: superslow` upstream and was still running,
not failed. The allocator trap did not recur in this focused run.

## Full Node Host Attempt

Run root:
`test-runs/sqlite-report-20260602/full-node-j1/`.

Command shape:

```bash
bash scripts/run-sqlite-official-tests.sh --host node --permutation full --jobs 1
```

Observed progress:

- The official runner queued 1416 `full` jobs.
- Stdout reached `13/1416`, `f2`, `r1` at about 6m53s.
- The runner then failed while updating its own `testrunner.db`:

```text
database disk image is malformed
    while executing
"trdb eval {
      UPDATE jobs
...
database disk image is malformed
    while executing
"trdb eval { BEGIN EXCLUSIVE }"
```

The guest testrunner database became unusable to the guest runner. After the
process was stopped, host `sqlite3` reported `PRAGMA integrity_check` as `ok`,
but the host-visible rows were stale and contradicted stdout/log output:

| Total jobs | Done | Failed | Running | Ready | Cases |
|------------|------|--------|---------|-------|-------|
| 1416 | 0 | 0 | 1 | 1415 | 0 |

The one running row was `ext/fts5/test/fts5optimize3.test`, even though the log
contains later job output. That means the DB artifact is not trustworthy as a
status source for this run.

Useful log evidence before the runner DB failure:

| Job | Log status | Cases/errors |
|-----|------------|--------------|
| `fts5optimize3.test` | done | 0/4 errors |
| `sort4.test` | done | 0/9 errors |
| `fts5optimize2.test` | done | 0/4 errors |
| `win32lock.test` | done | no case count printed |
| `walvfs.test` | done | 0/35 errors |
| `fts5secure7.test` | done | 0/1105 errors |
| `wal3.test` | failed | 1/490 errors, `wal3-2.multiproc.5` |
| `rbutemplimit.test` | done | 0/1 errors |
| `vacuummem.test` | done | 0/7 errors |
| `vacuum6.test` | done | 0/35 errors |
| `walsetlk.test` | failed | 1/40 errors, `walsetlk-2.1.4` |
| `memjournal2.test` | done | 0/407 errors |
| `joinD.test` | done | 0/1171 errors |

There is also a `round1.test` header and partial output in the log, but the
log does not contain its final `N errors out of M tests` line. I am not counting
it as a completed case total.

Conclusion: the Node full run did not complete. It stopped because the official
runner's own database became inconsistent from the guest's point of view.
Given the stale host-visible DB rows, this points at a Kandelo filesystem or
file-backed mapping coherency bug, not a completed SQLite result.

## Full Browser Host Attempts

Primary timeboxed run:
`test-runs/sqlite-report-20260602/full-browser-j1-timeboxed-7m/`.

Command shape:

```bash
bash scripts/run-sqlite-official-tests.sh --host browser --permutation full --jobs 1 --timeout-ms 420000
```

Observed progress:

- The official runner queued 1416 `full` jobs.
- The browser runner reached `8/1416`, `f2`, `r1` by about 1m17s.
- It then stayed at `8/1416` until the 7 minute timeout.
- Stdout additionally reported `FAILED: test/vacuummem.test (0)`, followed by:

```text
database or disk is full
    while executing
"trdb eval { COMMIT }"
...
TIMEOUT
Error: in prepare, no such table: jobs
```

Exported artifacts:

| Artifact | Status |
|----------|--------|
| `testrunner.log` | Present and useful for completed job output. |
| `testrunner.db` | 1024 bytes, `PRAGMA integrity_check` says `ok`, but has no `jobs` table. |
| `summary.txt` | Present but empty of job data because the DB has no `jobs` table. |
| `failures.tsv` | Empty because the DB has no `jobs` table. |

The exported browser log contains these completed job sections:

| Job | Log status | Cases/errors |
|-----|------------|--------------|
| `fts5optimize2.test` | done | 0/4 errors |
| `sort4.test` | failed | 2/9 errors: `disk I/O error` in `sort4-2.3` and `sort4-2.4` |
| `fts5optimize3.test` | done | 0/4 errors |
| `win32lock.test` | done | no case count printed |
| `walvfs.test` | done | 0/35 errors |
| `rbutemplimit.test` | done | 0/1 errors |
| `rburesume.test` | done | 0/1 errors |
| `wal3.test` | failed | 295/490 errors, beginning with `database disk image is malformed` and then many `no such table: t1` / invalid command errors |

The earlier long browser attempt in
`test-runs/sqlite-report-20260602/full-browser-j1-stream/` showed the same
stall pattern: progress stayed at `8/1416`, `f2`, `r1` while elapsed time and
ETA kept increasing. It was manually stopped to avoid losing the whole run to
the 24 hour timeout.

Conclusion: the browser full run did not complete. It currently has at least
three platform-level blockers: a real execution stall after the first eight
jobs, the testrunner DB hitting `database or disk is full` while committing
state, and exported DB artifacts that do not contain the runner's `jobs` table.

## Failure Classes And Current Root-Cause Read

### File-backed `MAP_SHARED` Is Not Coherent

Confirmed local implementation shape:

- `host/src/kernel-worker.ts` tracks file-backed `MAP_SHARED` mappings per
  process in `sharedMappings`.
- A file-backed `mmap` populates process memory by copying file bytes through
  `pread`.
- `msync` and `munmap` flush writable mapped bytes back to the file through
  `pwrite`.

That is not sufficient POSIX `MAP_SHARED` behavior. Separate guest processes
get separate WebAssembly memories. SQLite WAL uses byte-range locks plus a
file-backed shared mapping of `test.db-shm` as live shared memory. SQLite does
not rely on `msync` for the WAL index. If Kandelo copies the mapping into each
process and only writes back later, WAL readers and checkpointers can observe
stale or impossible WAL-index state.

This explains the shape of:

- `busy2.test`: wrong `PRAGMA wal_checkpoint` frame accounting on both hosts.
- `wal3.test`: Node fails the multiprocess case; browser degrades into severe
  malformed/no-table errors.
- `walsetlk.test`: Node misses expected lock/visibility behavior.

This is a kernel/filesystem correctness bug. The fix should be a sound
file-backed shared backing model with coherent reads/writes and correct dirty
tracking, not a SQLite-specific workaround or whole-mapping flush hack.

### Browser `SharedFS` FD Capacity Makes Some Results Non-Equivalent

`host/src/vfs/sharedfs-vendor.ts` defines `MAX_FDS = 64`. `manydb.test`
probes how many file descriptors it can open and scales its test size from
that. On Node, the targeted run reached 300 databases and 901 cases. On the
browser host, it reached 19 databases and 58 cases.

So browser `manydb.test` passing 58 cases is not proof that the same stress
passes in the browser host. Browser FD capacity needs to match the kernel's
reported/process-visible limits before this job can be compared to Node.

### `upfrom4.test` Is A Build Artifact Bug

`packages/registry/sqlite/build-testfixture.sh` currently builds with
`-DSQLITE_ENABLE_UPDATE_DELETE_LIMIT`. The SQLite amalgamation
`packages/registry/sqlite/sqlite-src/sqlite3.c` does not define
`SQLITE_UDL_CAPABLE_PARSER`, and SQLite's own `tool/mksqlite3c.tcl` only emits
that marker when the generated parser supports the update/delete limit grammar.

Observed result on both hosts:

- `upfrom4-510`: `Error: near "LIMIT": syntax error`
- `upfrom4-520`: expected `[789 123 789 123 0 0]`, got `[0 0 0 0 0 0]`

This is not a kernel failure. The testfixture build must either use a parser
generated with the UDL-capable grammar or stop advertising the option to tests.

### Crash/Lock Lifecycle Remains Suspect

`writecrash.test` fails on both hosts at `writecrash-1.2.1`. The child
`crash.tcl` path reports `database is locked` while executing:

```sql
UPDATE t1 SET b = randomblob(899) WHERE (a%3)==0
```

This is probably in Kandelo's lock/process-crash lifecycle, but the exact
kernel root cause is not proven from the current data. It should be diagnosed
after the shared-mapping fix, because WAL/shared file coherency can contaminate
locking and recovery symptoms.

### Browser Runner/Storage Has Its Own Artifact Bug

The browser full run's `testrunner.db` export is a 1024-byte valid SQLite file
with no `jobs` table, while stdout/logs clearly show the testrunner had built
and started a 1416-job testset. That is a separate browser artifact or storage
visibility bug. Until fixed, browser full runs need both stdout/log capture and
a reliable periodic DB snapshot/export path.

## What We Know Passes

We know these targeted official jobs pass on both hosts:

- `boundary2.test`: 3022 cases.
- `walhook.test` and `e_walhook.test`: 34 cases total.
- `tkt-2ea2425d34.test`: 2 cases.

We also know selected early `full` jobs pass in partial runs, such as FTS5
optimizer jobs, `walvfs.test`, `rbutemplimit.test`, and `rburesume.test`.

That is useful signal, but it is not a full-suite pass rate.

## What We Do Not Know Yet

We do not know:

- The exact complete pass/fail list for all 1416 `full` jobs on either host.
- The exact complete internal SQLite case count for `full` on Kandelo after the
  current kernel state, because the full run does not finish.
- The pass/fail list for the 10523-job `all` permutation set.
- Whether every WAL-related failure collapses to one shared-mapping bug or
  whether additional fcntl lock/process-lifecycle bugs remain underneath it.

## Required Next Work

1. Fix file-backed `MAP_SHARED` coherency across processes and within a
   process. The model needs true shared backing or equivalent coherent views
   for file-backed shared mappings, with correct dirty/writeback semantics.
2. Re-run targeted `busy2.test`, `wal3.test`, `walsetlk.test`, and
   `writecrash.test` on Node and browser.
3. Fix browser `SharedFS` FD capacity or the kernel/browser file descriptor
   contract so `manydb.test` runs at the same scale as Node.
4. Fix the SQLite testfixture build for `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` and
   `SQLITE_UDL_CAPABLE_PARSER`.
5. Fix the browser testrunner artifact path so `testrunner.db` exports with the
   `jobs` table and current rows after timeout/stall.
6. Re-run official `full --jobs 1` on both Node and browser. Only after both
   hosts complete should `all` be treated as the next proof target.

## Artifact Index

Current report artifacts:

- `test-runs/sqlite-report-20260602/targeted-node/`
- `test-runs/sqlite-report-20260602/targeted-browser/`
- `test-runs/sqlite-report-20260602/full-node-j1/`
- `test-runs/sqlite-report-20260602/full-browser-j1-stream/`
- `test-runs/sqlite-report-20260602/full-browser-j1-timeboxed-7m/`

Inventory artifacts from `--explain`:

- `test-runs/sqlite-official-node-full/20260602-101006/`
- `test-runs/sqlite-official-browser-full/20260602-101006/`
- `test-runs/sqlite-official-node-all/20260602-101006/`
- `test-runs/sqlite-official-browser-all/20260602-101006/`

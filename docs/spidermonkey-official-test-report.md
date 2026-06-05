# SpiderMonkey Official Test Harness

This branch adds reusable Kandelo harnesses for Mozilla's official SpiderMonkey
JS-shell suites on both hosts:

```bash
# Smoke both official shell harnesses on both hosts.
scripts/run-spidermonkey-official-tests.sh --host both --suite both --smoke

# Exhaustive, chunked runner for future full runs.
scripts/run-spidermonkey-official-all.sh --host both --suite both --jobs 1 --no-slow
```

The exhaustive runner inventories every runnable upstream JS file under:

- `js/src/tests`: 52,717 runnable jstest files, including `test262`.
- `js/src/jit-test/tests`: 8,634 runnable jit-test files. The runner uses
  `--jitflags=all` by default, matching SpiderMonkey's `check-jit-test` intent.

Useful controls:

- `--start-at CHUNK` resumes at a chunk after a long run is interrupted.
- `SPIDERMONKEY_OFFICIAL_JSTEST_CHUNK_SIZE=1 --restart-bridge-per-chunk` isolates
  jstest files when triaging long-lived host/bridge timeouts.
- `--no-slow` matches upstream default slow-test filtering; omitting it also runs
  tests marked `slow`.

## Current validation snapshot

Date: 2026-06-05

| Host | Suite/selection | Passing | Known skipped | Unexpected failures | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| node | smoke (`jstests` + `jit-tests --jitflags=all`) | 7 | 0 | 0 | `non262/Array/array-001.js` plus six `jit-tests` variants of `basic/bug908915.js`. |
| browser | smoke (`jstests` + `jit-tests --jitflags=all`) | 7 | 0 | 0 | Rebuilt browser VFS with the current `js.wasm`; Chromium system libs are supplied from `/tmp/pwlibs` in this runner. |
| node | `non262/Date/` | 38 | 1 | 0 | Fixed Mozilla Linux interposer crash on wasm32 static POSIX. |
| node | `non262/TypedArray/` | 21 | 0 | 0 | Fixed pthread slot exhaustion and wasm32 64-bit atomics support. |
| node | `non262/Promise/` isolated per file | 18 | 0 | 0 | All files pass when each file gets a fresh bridge/kernel. The whole directory chunk still shows long-lived bridge timeouts under load. |
| node | jstests default serial progress | 451+ | 208+ | 0 deterministic | Chunks through `non262/Promise` have either passed as chunks or passed when isolated. Full `test262` is not complete yet. |

## Fixes made so far

- Kernel memory layout now honors the process wasm maximum above the historical
  1 GiB cap, so `brk`/`mmap` can use the actual 2 GiB process address space.
- The SDK/SpiderMonkey build now links wasm programs with a 2 GiB maximum by
  default, while allowing `WASM_POSIX_MAX_MEMORY` override.
- Node worker stdout/stderr is attributed to the current process PID instead of
  PID 0, which makes harness output reliable.
- The node/browser SpiderMonkey hosts detect the wasm module's declared memory
  maximum and pass that to the Kandelo process memory.
- SpiderMonkey's Linux mozglue interposers are disabled for wasm32 static POSIX;
  those interposers require ELF `dlsym(RTLD_NEXT, ...)` semantics and crashed
  `setenv()`/`unsetenv()` in Date tests.
- SpiderMonkey's tier-3 GCC/Clang atomics path now recognizes wasm32+atomics as
  having lock-free 64-bit atomics, fixing BigInt64Array/BigUint64Array Atomics.
- The official exhaustive runner can resume and can restart the host bridge per
  chunk for isolation.

## Current challenges

- Full exhaustive node and browser runs are still in progress. Running all
  52,717 jstests plus all 8,634 jit-test files (with six default jit flag
  variants) is a long-running job on this shared runner.
- Some small jstest directory chunks (`non262/Intl`, `non262/Promise`) showed
  timeout flakes only when many files shared one long-lived bridge under heavy
  runner load. The timed-out files passed individually; `non262/Promise` passed
  when isolated per file with bridge restart.
- Slow test `non262/GC/regress-338653.js` still reaches SpiderMonkey OOM in the
  wasm32 build even with the 2 GiB address-space fix. This remains an open
  memory/GC/allocator investigation, not an expected pass yet.
- WPT jsshell tests are not yet part of the default chunked exhaustive run;
  the current exhaustive inventory is Mozilla's `js/src/tests` filesystem plus
  `js/src/jit-test/tests`.

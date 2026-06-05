# SpiderMonkey Official Test Harness

This branch adds a reusable harness for Mozilla's official SpiderMonkey shell
tests on Kandelo:

```bash
scripts/run-spidermonkey-official-tests.sh --host both --suite both
```

Useful smoke checks:

```bash
scripts/run-spidermonkey-official-tests.sh --host node --suite both --smoke
SPIDERMONKEY_OFFICIAL_REBUILD_VFS=1 \
  scripts/run-spidermonkey-official-tests.sh --host browser --suite jstests --smoke
```

## Current validation snapshot

Date: 2026-06-05

| Host | Suite/selection | Passing | Known skipped | Unexpected failures | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| node | jstests smoke + sampled `non262/Array`, `non262/Intl/NumberFormat`, `non262/module` | 104 | 9 | 0 | Node shell bridge keeps a persistent Kandelo kernel and runs upstream `jstests.py`. |
| node | jit-tests smoke + first 20 `jit-test/tests/basic` tests | 21 | 0 | 0 | Upstream `jit_test.py` reports `PASSED ALL` for the sampled list. |
| browser | VFS/Vite harness startup | 0 | 0 | 0 | Test VFS builds and Vite serves only the SpiderMonkey test page. Local browser execution is blocked by missing Chromium system library `libatk-1.0.so.0` in this runner. |

## Current challenges

- The full upstream suites are large. Even with the persistent Node bridge,
  sampled shell invocations are about 1.5 seconds each on this runner.
- Browser execution could not be completed locally because Playwright's bundled
  Chromium cannot start without system packages that are unavailable without
  sudo in this session. The browser harness itself builds the VFS image and
  starts Vite successfully.
- No SpiderMonkey-specific kernel hacks were added. The harness exercises the
  same POSIX kernel paths used by the existing Kandelo hosts.

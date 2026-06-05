#!/usr/bin/env tsx
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { findRepoRoot, tryResolveBinary } from "../host/src/binary-resolver";
import { NodeKernelHost } from "../host/src/node-kernel-host";

const REPO_ROOT = findRepoRoot();
const BROWSER_DIR = join(REPO_ROOT, "apps/browser-demos");
const SPIDERMONKEY_TEST_VFS = join(BROWSER_DIR, "public/spidermonkey-test.vfs.zst");
const VITE_HOST = "127.0.0.1";
const VITE_PORT = Number(process.env.SPIDERMONKEY_TEST_VITE_PORT ?? 5202);

type HostKind = "node" | "browser";

interface RunRequest {
  source?: string;
  shellArgs?: string[];
  scriptPath?: string;
  scriptContent?: string;
  scriptArgs?: string[];
  timeoutMs?: number;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs: number;
}

interface TestCase {
  name: string;
  timeoutMs?: number;
  run: (runner: Pick<SpiderMonkeyRunner, "runScript">) => Promise<RunResult>;
  check: (result: RunResult) => string | null;
}

interface SpiderMonkeyRunner {
  init(): Promise<void>;
  runScript(request: RunRequest): Promise<RunResult>;
  close(): Promise<void>;
}

function usage(): never {
  console.log(`Usage: scripts/run-spidermonkey-unit-tests.ts [OPTIONS] [test-name ...]

Options:
  --host node|browser|both  Host to run on (default: node)
  --list                    List SpiderMonkey shell unit tests
  --json                    Emit JSON lines
  --timeout SECONDS         Default per-test timeout (default: 60)
  --rebuild-vfs             Rebuild browser VFS image before browser run
  --help                    Show this help`);
  process.exit(0);
}

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function resolveJsWasm(): string {
  const candidates = [
    process.env.SPIDERMONKEY_WASM,
    tryResolveBinary("programs/js.wasm"),
    tryResolveBinary("programs/spidermonkey.wasm"),
    join(REPO_ROOT, "packages/registry/spidermonkey/bin/js.wasm"),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "SpiderMonkey js.wasm not found. Run: bash packages/registry/spidermonkey/build-spidermonkey.sh",
    );
  }
  return found;
}

function lines(stdout: string): string[] {
  const trimmed = stdout.trim();
  return trimmed ? trimmed.split("\n") : [];
}

function expectExit(exitCode: number): (result: RunResult) => string | null {
  return (result) => {
    if (result.error) return result.error;
    return result.exitCode === exitCode ? null : `exit ${result.exitCode}, expected ${exitCode}`;
  };
}

function expectNonZero(stderrNeedle: string): (result: RunResult) => string | null {
  return (result) => {
    if (result.error) return result.error;
    if (result.exitCode === 0) return "exit 0, expected non-zero";
    if (!result.stderr.includes(stderrNeedle)) {
      return `stderr did not include ${JSON.stringify(stderrNeedle)}; stderr=${JSON.stringify(result.stderr.slice(-1000))}`;
    }
    return null;
  };
}

function expectStdout(expected: string[]): (result: RunResult) => string | null {
  return (result) => {
    const exitError = expectExit(0)(result);
    if (exitError) return exitError;
    const actual = lines(result.stdout);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return `stdout ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
    }
    if (result.stderr.trim()) {
      return `unexpected stderr: ${JSON.stringify(result.stderr.slice(-1000))}`;
    }
    return null;
  };
}

function sourceTest(
  name: string,
  source: string | string[],
  expected: string[],
  options: { shellArgs?: string[]; timeoutMs?: number } = {},
): TestCase {
  return {
    name,
    timeoutMs: options.timeoutMs,
    run: (runner) => runner.runScript({
      source: Array.isArray(source) ? source.join("\n") : source,
      shellArgs: options.shellArgs,
      timeoutMs: options.timeoutMs,
    }),
    check: expectStdout(expected),
  };
}

function failureSourceTest(name: string, source: string, stderrNeedle: string): TestCase {
  return {
    name,
    run: (runner) => runner.runScript({ source }),
    check: expectNonZero(stderrNeedle),
  };
}

const TESTS: TestCase[] = [
  sourceTest("simple-expression", "print(1 + 1)", ["2"]),
  sourceTest("modern-builtins", [
    "print([3, 1, 2].toSorted().join(','))",
    "print(Object.groupBy(['a', 'bb', 'c'], s => s.length)[1].join(','))",
    "print(typeof Promise.withResolvers)",
    "print((2n ** 64n).toString())",
  ], ["1,2,3", "a,c", "function", "18446744073709551616"]),
  sourceTest("intl-basic", [
    "print(typeof Intl)",
    "print(new Intl.NumberFormat('de-DE').format(1234567.89))",
    "print(new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' }).format(new Date(Date.UTC(2020, 0, 2))))",
  ], ["object", "1.234.567,89", "January"]),
  sourceTest("intl-locale-data", [
    "print(new Intl.PluralRules('en-US').select(1))",
    "print(new Intl.PluralRules('en-US').select(2))",
    "print(new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-1, 'day'))",
    "print(new Intl.Locale('ja-JP-u-ca-japanese').calendar)",
    "print(new Intl.NumberFormat('ar-EG').format(12345) !== '12345')",
    "print(typeof Intl.supportedValuesOf === 'function' && Intl.supportedValuesOf('timeZone').includes('UTC'))",
  ], ["one", "other", "yesterday", "japanese", "true", "true"]),
  sourceTest("shared-memory-worker", [
    "var sab = new SharedArrayBuffer(16)",
    "var view = new Int32Array(sab)",
    "setSharedObject(sab)",
    "evalInWorker(`var sab = getSharedObject(); var view = new Int32Array(sab); Atomics.store(view, 0, 42); Atomics.notify(view, 0);`)",
    "Atomics.wait(view, 0, 0)",
    "print(Atomics.load(view, 0))",
  ], ["42"], { shellArgs: ["--shared-memory=on"] }),
  sourceTest("atomics-wait-results", [
    "var sab = new SharedArrayBuffer(4)",
    "var view = new Int32Array(sab)",
    "print(Atomics.wait(view, 0, 0, 1))",
    "Atomics.store(view, 0, 1)",
    "print(Atomics.wait(view, 0, 0, 1))",
  ], ["timed-out", "not-equal"], { shellArgs: ["--shared-memory=on"] }),
  sourceTest("multiple-shell-workers", [
    "var sab = new SharedArrayBuffer(8)",
    "var view = new Int32Array(sab)",
    "setSharedObject(sab)",
    "for (var i = 0; i < 3; i++) evalInWorker(`var view = new Int32Array(getSharedObject()); Atomics.add(view, 0, 1); Atomics.add(view, 1, 1); Atomics.notify(view, 1);`)",
    "while (Atomics.load(view, 1) < 3) Atomics.wait(view, 1, Atomics.load(view, 1), 10000)",
    "print(Atomics.load(view, 0))",
    "print(Atomics.load(view, 1))",
  ], ["3", "3"], { shellArgs: ["--shared-memory=on"] }),
  sourceTest("worker-teardown-gc", [
    "var sab = new SharedArrayBuffer(4)",
    "var view = new Int32Array(sab)",
    "setSharedObject(sab)",
    "evalInWorker(`var view = new Int32Array(getSharedObject()); Atomics.store(view, 0, 1); Atomics.notify(view, 0);`)",
    "if (Atomics.wait(view, 0, 0, 10000) !== 'ok') throw new Error('worker wait failed')",
    "var garbage = []",
    "for (var j = 0; j < 1000; j++) garbage.push({ j, text: 'gc-pressure-' + j })",
    "if (typeof gc === 'function') gc()",
    "print('worker-teardown-ok')",
  ], ["worker-teardown-ok"], { shellArgs: ["--shared-memory=on"], timeoutMs: 90_000 }),
  sourceTest("stack-overflow-exception", [
    "function recurse() { return 1 + recurse(); }",
    "try {",
    "  recurse()",
    "} catch (e) {",
    "  print(e.name)",
    "  print(/recursion|stack/i.test(String(e)))",
    "}",
  ], ["InternalError", "true"]),
  sourceTest("shell-file-apis", [
    "function asciiBytes(s) {",
    "  var bytes = new Uint8Array(s.length)",
    "  for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)",
    "  return bytes",
    "}",
    "os.file.writeTypedArrayToFile('/tmp/spidermonkey-load.js', asciiBytes(\"var loadedValue = 37; print('loaded:' + loadedValue);\\n\"))",
    "load('/tmp/spidermonkey-load.js')",
    "print(snarf('/tmp/spidermonkey-load.js').includes('loadedValue'))",
  ], ["loaded:37", "true"]),
  {
    name: "script-file-args",
    run: (runner) => runner.runScript({
      scriptPath: "/tmp/args.js",
      scriptContent: "print('scriptArgs:' + scriptArgs.join('|'));\n",
      scriptArgs: ["alpha", "beta"],
    }),
    check: expectStdout(["scriptArgs:alpha|beta"]),
  },
  sourceTest("utf8-source-stdout", [
    "print('unicode:' + '\\u2603' + ':' + '\\u00e9' + ':' + '\\u6f22\\u5b57')",
  ], ["unicode:\u2603:\u00e9:\u6f22\u5b57"]),
  failureSourceTest("syntax-error", "function {", "SyntaxError"),
  failureSourceTest("uncaught-exception", "throw new Error('spidermonkey-boom')", "spidermonkey-boom"),
  sourceTest("typed-arrays-weakrefs-gc", [
    "var buf = new ArrayBuffer(8)",
    "var dv = new DataView(buf)",
    "dv.setUint32(0, 0x12345678, true)",
    "print(Array.from(new Uint8Array(buf).slice(0, 4)).join(','))",
    "var target = { value: 42 }",
    "var ref = new WeakRef(target)",
    "var registry = new FinalizationRegistry(() => {})",
    "registry.register(target, 'held')",
    "print(ref.deref().value)",
    "var total = 0",
    "for (var round = 0; round < 5; round++) {",
    "  var values = []",
    "  for (var i = 0; i < 10000; i++) values.push({ i, s: 'value-' + i })",
    "  total += values[9999].i",
    "  if (typeof gc === 'function') gc()",
    "}",
    "print(total)",
  ], ["120,86,52,18", "42", "49995"], { timeoutMs: 90_000 }),
  sourceTest("promise-job-queue", [
    "var order = []",
    "Promise.resolve().then(() => order.push('promise'))",
    "order.push('sync')",
    "drainJobQueue()",
    "print(order.join(','))",
  ], ["sync,promise"]),
  sourceTest("nested-webassembly-disabled", [
    "print(typeof WebAssembly)",
    "print(typeof wasmIsSupported === 'function' ? wasmIsSupported() : 'missing')",
  ], ["undefined", "false"]),
];

class NodeSpiderMonkeyRunner implements SpiderMonkeyRunner {
  private jsPath = resolveJsWasm();
  private jsBytes = loadBytes(this.jsPath);
  private jsModule: WebAssembly.Module | undefined;

  async init(): Promise<void> {
    this.jsModule = await WebAssembly.compile(this.jsBytes);
  }

  async runScript(request: RunRequest): Promise<RunResult> {
    const tempDir = mkdtempSync(join(tmpdir(), "spidermonkey-test-"));
    let stdout = "";
    let stderr = "";
    const start = performance.now();
    const host = new NodeKernelHost({
      maxWorkers: 8,
      rootfsImage: "default",
      extraMounts: [{ mountPoint: "/mnt", hostPath: tempDir, readonly: false }],
      onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
      onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
      onResolveExec: (path) => {
        const base = path.split("/").pop();
        if (base === "js" || base === "js.wasm") return this.jsBytes;
        return null;
      },
    });
    await host.init();

    let argv: string[];
    if (request.scriptPath) {
      const mountedPath = `/mnt/${request.scriptPath.split("/").pop() ?? "test.js"}`;
      if (request.scriptContent !== undefined) {
        writeFileSync(join(tempDir, mountedPath.slice("/mnt/".length)), request.scriptContent);
      }
      argv = ["js", ...(request.shellArgs ?? []), mountedPath, ...(request.scriptArgs ?? [])];
    } else {
      argv = ["js", ...(request.shellArgs ?? []), "-e", request.source ?? ""];
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const exitPromise = host.spawn(this.jsBytes, argv, {
        cwd: "/tmp",
        env: ["HOME=/tmp", "TMPDIR=/tmp", "PATH=/usr/bin:/bin"],
        programModule: this.jsModule,
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("TIMEOUT")), request.timeoutMs ?? 60_000);
      });
      const exitCode = await Promise.race([exitPromise, timeoutPromise]);
      return { exitCode, stdout, stderr, durationMs: Math.round(performance.now() - start) };
    } catch (err: any) {
      const message = err?.message || String(err);
      return {
        exitCode: -1,
        stdout,
        stderr,
        error: message.includes("TIMEOUT") ? "TIMEOUT" : message,
        durationMs: Math.round(performance.now() - start),
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      await host.destroy().catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {}
}

async function startViteServer(): Promise<ChildProcess> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      "npx",
      [
        "vite",
        "--config", join(BROWSER_DIR, "vite.config.ts"),
        "--host", VITE_HOST,
        "--port", String(VITE_PORT),
        "--strictPort",
      ],
      {
        cwd: BROWSER_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, KANDELO_BROWSER_DEMO_INPUTS: "spidermonkey-test" },
      },
    );
    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        proc.kill();
        reject(new Error("Vite server did not start within 30s"));
      }
    }, 30_000);
    proc.stdout!.on("data", (data: Buffer) => {
      if (!started && data.toString().includes("Local:")) {
        started = true;
        clearTimeout(timeout);
        setTimeout(() => resolvePromise(proc), 500);
      }
    });
    proc.stderr!.on("data", (data: Buffer) => {
      const text = data.toString();
      if (text.toLowerCase().includes("error")) process.stderr.write(`[vite] ${text}`);
    });
    proc.on("exit", (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Vite exited with code ${code}`));
      }
    });
  });
}

class BrowserSpiderMonkeyRunner implements SpiderMonkeyRunner {
  private vite: ChildProcess | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(private rebuildVfs: boolean) {}

  async init(): Promise<void> {
    if (this.rebuildVfs || !existsSync(SPIDERMONKEY_TEST_VFS)) {
      execFileSync("bash", [join(REPO_ROOT, "images/vfs/scripts/build-spidermonkey-test-vfs-image.sh")], {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: { ...process.env },
      });
    }
    this.vite = await startViteServer();
    this.browser = await chromium.launch({ args: ["--enable-features=SharedArrayBuffer"] });
    const context = await this.browser.newContext();
    this.page = await context.newPage();
    this.page.on("console", (msg) => {
      if (msg.type() === "error") console.error(`[browser] ${msg.text()}`);
    });
    await this.page.goto(`http://${VITE_HOST}:${VITE_PORT}/pages/spidermonkey-test/`);
    await this.page.waitForFunction(() => (window as any).__spiderMonkeyTestReady === true, {}, { timeout: 120_000 });
  }

  async runScript(request: RunRequest): Promise<RunResult> {
    if (!this.page) throw new Error("browser page not ready");
    return await this.page.evaluate(
      (req) => (window as any).__runSpiderMonkeyScript(req),
      request,
    );
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.page = null;
    if (this.vite) {
      this.vite.kill();
      this.vite = null;
    }
  }
}

function selectTests(selectors: string[]): TestCase[] {
  if (selectors.length === 0) return TESTS;
  const selected: TestCase[] = [];
  for (const selector of selectors) {
    const matches = TESTS.filter((test) => test.name === selector || test.name.includes(selector));
    if (matches.length === 0) throw new Error(`No SpiderMonkey test matched ${selector}`);
    selected.push(...matches);
  }
  return [...new Map(selected.map((test) => [test.name, test])).values()];
}

async function runHost(hostKind: HostKind, tests: TestCase[], json: boolean, rebuildVfs: boolean, defaultTimeoutMs: number): Promise<number> {
  const runner: SpiderMonkeyRunner = hostKind === "node"
    ? new NodeSpiderMonkeyRunner()
    : new BrowserSpiderMonkeyRunner(rebuildVfs);
  let failures = 0;
  await runner.init();
  try {
    for (const test of tests) {
      const started = performance.now();
      const result = await test.run({
        ...runner,
        runScript: (request) => runner.runScript({
          timeoutMs: test.timeoutMs ?? defaultTimeoutMs,
          ...request,
        }),
      });
      const error = test.check(result);
      const durationMs = Math.round(performance.now() - started);
      const record = {
        host: hostKind,
        test: test.name,
        status: error ? "fail" : "pass",
        time_ms: durationMs,
        exitCode: result.exitCode,
        error,
      };
      if (json) {
        console.log(JSON.stringify(record));
      } else if (error) {
        console.log(`FAIL ${test.name} (${durationMs}ms): ${error}`);
      } else {
        console.log(`PASS ${test.name} (${durationMs}ms)`);
      }
      if (error) failures++;
    }
  } finally {
    await runner.close();
  }
  return failures;
}

async function main() {
  let host: HostKind | "both" = "node";
  let json = false;
  let list = false;
  let rebuildVfs = false;
  let defaultTimeoutMs = 60_000;
  const selectors: string[] = [];

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--help" || arg === "-h") usage();
    else if (arg === "--host") {
      const value = process.argv[++i];
      if (value !== "node" && value !== "browser" && value !== "both") {
        throw new Error("--host must be node, browser, or both");
      }
      host = value;
    } else if (arg === "--json") json = true;
    else if (arg === "--list") list = true;
    else if (arg === "--rebuild-vfs") rebuildVfs = true;
    else if (arg === "--timeout") {
      const seconds = Number(process.argv[++i]);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--timeout must be a positive number of seconds");
      defaultTimeoutMs = Math.round(seconds * 1000);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      selectors.push(arg);
    }
  }

  if (list) {
    for (const test of TESTS) console.log(test.name);
    return;
  }

  const tests = selectTests(selectors);
  const hosts: HostKind[] = host === "both" ? ["node", "browser"] : [host];
  let totalFailures = 0;
  for (const h of hosts) {
    if (!json) {
      console.log(`===== SpiderMonkey shell unit tests (${h}) =====`);
    }
    totalFailures += await runHost(h, tests, json, rebuildVfs, defaultTimeoutMs);
  }
  if (!json) {
    console.log(`===== SpiderMonkey summary: ${tests.length * hosts.length - totalFailures} pass, ${totalFailures} fail, ${tests.length * hosts.length} total =====`);
  }
  process.exit(totalFailures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});

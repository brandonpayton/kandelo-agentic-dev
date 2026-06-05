#!/usr/bin/env tsx
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { findRepoRoot, tryResolveBinary } from "../host/src/binary-resolver";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import {
  collectNodejsLibraryTests,
  defaultNodejsTestVersion,
  ensureNodejsSource,
  type NodejsTestDescriptor,
} from "./nodejs-source-helper";

const REPO_ROOT = findRepoRoot();
const BROWSER_DIR = join(REPO_ROOT, "apps/browser-demos");
const NODEJS_TEST_VFS = join(BROWSER_DIR, "public/nodejs-test.vfs.zst");
const VITE_HOST = "127.0.0.1";
const VITE_PORT = Number(process.env.NODEJS_TEST_VITE_PORT ?? 5304);
const DEFAULT_TIMEOUT_MS = 30_000;

type HostKind = "node" | "browser";
type Status = "pass" | "fail" | "skip" | "time";

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs: number;
}

interface TestResult {
  test: string;
  host: HostKind;
  status: Status;
  exitCode: number;
  time_ms: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

interface Runner {
  init(): Promise<void>;
  runTest(test: NodejsTestDescriptor, timeoutMs: number): Promise<RunResult>;
  close(): Promise<void>;
}

function usage(): never {
  console.log(`Usage: scripts/run-nodejs-library-tests.ts [OPTIONS] [test-or-dir ...]

Options:
  --host node|browser|both  Host to run on (default: node)
  --all                     Run upstream test/parallel and test/sequential (default)
  --list                    List selected Node.js tests
  --json                    Emit JSON lines
  --timeout SECONDS         Per-test timeout (default: 30)
  --source-dir DIR          Use an existing Node.js source tree
  --version VERSION         Download this Node.js source version (default: host ${process.version})
  --rebuild-vfs             Rebuild nodejs-test.vfs.zst before browser runs
  --help                    Show this help

Environment:
  NODEJS_WASM               Path to node.wasm
  NODEJS_SOURCE_DIR         Path to a Node.js source tree
  NODEJS_TEST_VERSION       Node.js source version to download`);
  process.exit(0);
}

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function resolveNodeWasm(): string {
  const candidates = [
    process.env.NODEJS_WASM,
    tryResolveBinary("programs/node.wasm"),
    tryResolveBinary("programs/spidermonkey-node.wasm"),
    join(REPO_ROOT, "packages/registry/spidermonkey/bin/node.wasm"),
    join(REPO_ROOT, "packages/registry/spidermonkey-node/bin/node.wasm"),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "Node-compatible node.wasm not found. Run: bash packages/registry/spidermonkey-node/build-spidermonkey-node.sh",
    );
  }
  return found;
}

function testEnv(test: NodejsTestDescriptor): string[] {
  const env = new Map<string, string>([
    ["HOME", "/tmp"],
    ["TMPDIR", "/tmp"],
    ["PATH", "/usr/bin:/bin"],
    ["PWD", "/node-src"],
    ["TERM", "dumb"],
    ["TZ", "UTC"],
    ["LC_ALL", "C"],
    ["NODE_DISABLE_COLORS", "1"],
    ["NODE_SKIP_FLAG_CHECK", "1"],
    ["NODE_TEST_DIR", "/tmp"],
  ]);
  for (const pair of test.env) {
    const eq = pair.indexOf("=");
    if (eq > 0) env.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...env].map(([key, value]) => `${key}=${value}`);
}

function classify(host: HostKind, test: NodejsTestDescriptor, raw: RunResult): TestResult {
  let status: Status = "fail";
  const output = `${raw.stdout}\n${raw.stderr}`;
  if (raw.error === "TIMEOUT") {
    status = "time";
  } else if (raw.exitCode === 0 && /1\.\.0 # Skipped:/i.test(output)) {
    status = "skip";
  } else if (!raw.error && raw.exitCode === 0) {
    status = "pass";
  }
  return {
    test: test.name,
    host,
    status,
    exitCode: raw.exitCode,
    time_ms: raw.durationMs,
    stdout: raw.stdout.slice(-2000),
    stderr: raw.stderr.slice(-2000),
    error: raw.error,
  };
}

function nodejsTestWrapperSource(test: NodejsTestDescriptor): string {
  const testPath = `/node-src/${test.relPath}`;
  return `
const testPath = ${JSON.stringify(testPath)};
const execArgv = ${JSON.stringify(test.flags)};
process.argv = [process.argv[0] || '/usr/bin/node', testPath];
process.argv0 = process.argv[0];
process.execArgv = execArgv;

const net = require('net');
let autoSelectFamily = false;
let autoSelectFamilyAttemptTimeout = 250;
if (typeof net.getDefaultAutoSelectFamily !== 'function') {
  net.getDefaultAutoSelectFamily = () => autoSelectFamily;
}
if (typeof net.setDefaultAutoSelectFamily !== 'function') {
  net.setDefaultAutoSelectFamily = (value) => { autoSelectFamily = !!value; };
}
if (typeof net.getDefaultAutoSelectFamilyAttemptTimeout !== 'function') {
  net.getDefaultAutoSelectFamilyAttemptTimeout = () => autoSelectFamilyAttemptTimeout;
}
if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout !== 'function') {
  net.setDefaultAutoSelectFamilyAttemptTimeout = (value) => {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) autoSelectFamilyAttemptTimeout = n;
  };
}

require(testPath);
`;
}

class NodeHostRunner implements Runner {
  private nodeBytes!: ArrayBuffer;
  private nodeModule: WebAssembly.Module | undefined;

  constructor(private nodeWasm: string, private sourceRoot: string) {}

  async init(): Promise<void> {
    this.nodeBytes = loadBytes(this.nodeWasm);
    this.nodeModule = await WebAssembly.compile(this.nodeBytes);
  }

  async runTest(test: NodejsTestDescriptor, timeoutMs: number): Promise<RunResult> {
    const start = performance.now();
    let stdout = "";
    let stderr = "";
    const host = new NodeKernelHost({
      maxWorkers: 8,
      rootfsImage: "default",
      extraMounts: [
        { mountPoint: "/node-src", hostPath: this.sourceRoot, readonly: true },
      ],
      execPrograms: {
        "/usr/bin/node": this.nodeWasm,
        "/bin/node": this.nodeWasm,
      },
      onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
      onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
    });

    try {
      await host.init();
      const wrapper = nodejsTestWrapperSource(test);
      const exitCode = await Promise.race([
        host.spawn(this.nodeBytes, ["/usr/bin/node", "-e", wrapper], {
          cwd: "/node-src",
          env: testEnv(test),
          programModule: this.nodeModule,
        }),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs),
        ),
      ]);
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
      await host.destroy().catch(() => {});
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
        env: { ...process.env, KANDELO_BROWSER_DEMO_INPUTS: "nodejs-test" },
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
    proc.on("exit", (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Vite exited with code ${code}`));
      }
    });
  });
}

class BrowserNodejsRunner implements Runner {
  private vite: ChildProcess | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private runs = 0;

  constructor(private sourceRoot: string, private rebuildVfs: boolean) {}

  async init(): Promise<void> {
    if (this.rebuildVfs || !existsSync(NODEJS_TEST_VFS)) {
      execFileSync("bash", [join(REPO_ROOT, "images/vfs/scripts/build-nodejs-test-vfs-image.sh")], {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: { ...process.env, NODEJS_SOURCE_DIR: this.sourceRoot },
      });
    }
    this.vite = await startViteServer();
    await this.launchBrowser();
    await this.reloadPage();
  }

  private async launchBrowser(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = await chromium.launch({ args: ["--enable-features=SharedArrayBuffer"] });
  }

  private async reloadPage(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.browser || !this.browser.isConnected()) await this.launchBrowser();
      try {
        const context = await this.browser!.newContext();
        this.page = await context.newPage();
        this.page.on("console", (msg) => {
          if (msg.type() === "error") console.error(`[browser] ${msg.text()}`);
        });
        await this.page.goto(`http://${VITE_HOST}:${VITE_PORT}/pages/nodejs-test/`);
        await this.page.waitForFunction(() => (window as any).__nodejsTestReady === true, {}, { timeout: 180_000 });
        return;
      } catch (err) {
        if (attempt === 0) {
          await this.launchBrowser();
          continue;
        }
        throw err;
      }
    }
  }

  async runTest(test: NodejsTestDescriptor, timeoutMs: number): Promise<RunResult> {
    if (!this.page) throw new Error("browser page not ready");
    if (this.runs > 0 && this.runs % 10 === 0) {
      await this.page.context().close().catch(() => {});
      await this.reloadPage();
    }
    this.runs++;

    for (let attempt = 0; attempt < 2; attempt++) {
      const start = performance.now();
      try {
        return await Promise.race([
          this.page.evaluate(
            async ({ request }) => (window as any).__runNodejsLibraryTest(request),
            {
              request: {
                testPath: test.vfsPath,
                flags: test.flags,
                evalSource: nodejsTestWrapperSource(test),
                env: testEnv(test),
                timeoutMs,
              },
            },
          ),
          new Promise<RunResult>((_, reject) =>
            setTimeout(() => reject(new Error("PLAYWRIGHT_TIMEOUT")), timeoutMs + 30_000),
          ),
        ]);
      } catch (err: any) {
        const message = err?.message || String(err);
        if (message.includes("PLAYWRIGHT_TIMEOUT")) {
          await this.page?.context().close().catch(() => {});
          await this.reloadPage();
          return {
            exitCode: -1,
            stdout: "",
            stderr: "",
            error: "TIMEOUT",
            durationMs: Math.round(performance.now() - start),
          };
        }
        const recoverable = /Execution context was destroyed|Target page, context or browser has been closed|Navigation failed/i.test(message);
        if (attempt === 0 && recoverable) {
          await this.page?.context().close().catch(() => {});
          await this.reloadPage();
          continue;
        }
        return {
          exitCode: -1,
          stdout: "",
          stderr: "",
          error: message,
          durationMs: Math.round(performance.now() - start),
        };
      }
    }
    throw new Error("unreachable");
  }

  async close(): Promise<void> {
    if (this.page) await this.page.context().close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    if (this.vite) {
      this.vite.kill();
      await new Promise<void>((resolveDone) => {
        this.vite!.on("exit", () => resolveDone());
        setTimeout(resolveDone, 2000);
      });
    }
  }
}

async function runHost(
  host: HostKind,
  runner: Runner,
  tests: NodejsTestDescriptor[],
  opts: { json: boolean; timeoutMs: number },
): Promise<{ fail: number; time: number; total: number }> {
  const counts: Record<Status, number> = { pass: 0, fail: 0, skip: 0, time: 0 };
  await runner.init();
  try {
    for (let i = 0; i < tests.length; i++) {
      const raw = await runner.runTest(tests[i], opts.timeoutMs);
      const result = classify(host, tests[i], raw);
      counts[result.status]++;
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        process.stderr.write(
          `[${i + 1}/${tests.length}] ${result.status.toUpperCase().padEnd(4)} ${result.test} (${result.time_ms}ms)\n`,
        );
      }
    }
  } finally {
    await runner.close();
  }

  console.error("");
  console.error(`Node.js library tests on ${host}:`);
  console.error(`  PASS  ${counts.pass}`);
  console.error(`  FAIL  ${counts.fail}`);
  console.error(`  SKIP  ${counts.skip}`);
  console.error(`  TIME  ${counts.time}`);
  console.error(`  TOTAL ${tests.length}`);
  return { fail: counts.fail, time: counts.time, total: tests.length };
}

async function main() {
  const args = process.argv.slice(2);
  let host: HostKind | "both" = "node";
  let json = false;
  let list = false;
  let rebuildVfs = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const selectors: string[] = [];
  let sourceRootOverride: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--host") {
      const value = args[++i] as HostKind | "both" | undefined;
      if (value !== "node" && value !== "browser" && value !== "both") {
        throw new Error("--host must be node, browser, or both");
      }
      host = value;
    } else if (arg === "--all") {
      continue;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--list") {
      list = true;
    } else if (arg === "--rebuild-vfs") {
      rebuildVfs = true;
    } else if (arg === "--timeout") {
      timeoutMs = Math.round(Number(args[++i]) * 1000);
    } else if (arg === "--source-dir") {
      sourceRootOverride = resolve(args[++i]);
    } else if (arg === "--version") {
      process.env.NODEJS_TEST_VERSION = args[++i];
    } else {
      selectors.push(arg);
    }
  }

  if (sourceRootOverride) process.env.NODEJS_SOURCE_DIR = sourceRootOverride;
  const sourceRoot = ensureNodejsSource(REPO_ROOT);
  const tests = collectNodejsLibraryTests(sourceRoot, selectors);
  if (tests.length === 0) throw new Error("No Node.js tests selected");

  if (list) {
    for (const test of tests) console.log(test.name);
    return;
  }

  const nodeWasm = resolveNodeWasm();
  console.error(`node-src: ${sourceRoot}`);
  console.error(`Node.js source version: v${defaultNodejsTestVersion()}`);
  console.error(`node.wasm: ${nodeWasm}`);
  console.error(`selected tests: ${tests.length}`);

  const hosts: HostKind[] = host === "both" ? ["node", "browser"] : [host];
  let failed = false;
  for (const h of hosts) {
    const runner = h === "node"
      ? new NodeHostRunner(nodeWasm, sourceRoot)
      : new BrowserNodejsRunner(sourceRoot, rebuildVfs);
    const summary = await runHost(h, runner, tests, { json, timeoutMs });
    if (summary.fail > 0 || summary.time > 0 || summary.total === 0) failed = true;
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

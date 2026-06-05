/**
 * Run php-src PHPT runtime tests on Kandelo, through either the Node.js host
 * or the browser host.
 *
 * This is intentionally a small PHPT harness instead of a native `make test`
 * wrapper: upstream run-tests.php assumes it can spawn a native PHP binary.
 * Here each --SKIPIF-- / --FILE-- / --CLEAN-- section is executed as a PHP
 * process inside Kandelo and the harness performs the expectation match.
 */
import { chromium, type Browser, type Page } from "playwright";
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { tryResolveBinary } from "../host/src/binary-resolver";
import { ensureSourceExtract } from "../images/vfs/scripts/source-extract-helper";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const LOCAL_PHP_SRC = join(REPO_ROOT, "packages/registry/php/php-src");
const PHP_TEST_VFS = join(REPO_ROOT, "apps/browser-demos/public/php-test.vfs.zst");
const BROWSER_DIR = join(REPO_ROOT, "apps/browser-demos");
const VITE_HOST = "127.0.0.1";
const VITE_PORT = Number(process.env.PHP_TEST_VITE_PORT ?? 5201);

type HostKind = "node" | "browser";
type TestStatus = "pass" | "fail" | "skip" | "xfail" | "xpass" | "unsupported" | "time";

interface PhptTest {
  path: string;
  rel: string;
  sections: Record<string, string>;
}

interface PhpRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs: number;
}

interface TestResult {
  test: string;
  status: TestStatus;
  time_ms: number;
  reason?: string;
  detail?: string;
}

interface PhpRunner {
  runScript(opts: {
    test: PhptTest;
    kind: "skipif" | "file" | "clean";
    script: string;
    argv: string[];
    scriptArgs?: string[];
    env: string[];
    stdin?: string;
    timeoutMs: number;
  }): Promise<PhpRunResult>;
  close(): Promise<void>;
}

let tempCounter = 0;

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function resolvePhpBinary(): string {
  const candidate = process.env.PHP_WASM
    ?? tryResolveBinary("programs/php/php.wasm")
    ?? join(LOCAL_PHP_SRC, "sapi/cli/php");
  if (!candidate || !existsSync(candidate)) {
    throw new Error("PHP wasm not found. Run: bash packages/registry/php/build-php.sh");
  }
  return candidate;
}

function resolvePhpSource(): string {
  const explicit = process.env.PHP_SOURCE_DIR;
  if (explicit) return resolve(explicit);
  return ensureSourceExtract("php", REPO_ROOT, existsSync(LOCAL_PHP_SRC) ? LOCAL_PHP_SRC : undefined);
}

function parsePhpt(path: string, sourceRoot: string): PhptTest {
  const text = readFileSync(path, "utf-8");
  const marker = /^--([A-Z_]+)--[ \t]*\r?$/gm;
  const matches = [...text.matchAll(marker)];
  const sections: Record<string, string> = {};
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1];
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    sections[name] = text.slice(start, end).replace(/^\r?\n/, "");
  }
  return { path, rel: relative(sourceRoot, path), sections };
}

function walkPhpt(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".deps" || entry.name === ".libs") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkPhpt(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".phpt")) {
      out.push(full);
    }
  }
  return out;
}

function discoverTests(sourceRoot: string, selectors: string[]): PhptTest[] {
  const files: string[] = [];
  if (selectors.length === 0) {
    walkPhpt(sourceRoot, files);
  } else {
    for (const selector of selectors) {
      const resolved = isAbsolute(selector) ? selector : resolve(sourceRoot, selector);
      if (!existsSync(resolved)) throw new Error(`PHPT selector not found: ${selector}`);
      const st = statSync(resolved);
      if (st.isDirectory()) walkPhpt(resolved, files);
      else files.push(resolved);
    }
  }
  return [...new Set(files)].sort().map((path) => parsePhpt(path, sourceRoot));
}

function splitArgs(input: string | undefined): string[] {
  if (!input) return [];
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;
  for (const ch of input.trim()) {
    if (escape) {
      current += ch;
      escape = false;
    } else if (ch === "\\") {
      escape = true;
    } else if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

function iniArgs(ini: string | undefined): string[] {
  if (!ini) return [];
  const args: string[] = [];
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    args.push("-d", line);
  }
  return args;
}

function envArgs(env: string | undefined): string[] {
  if (!env) return [];
  return env.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function normalizeOutput(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectfToRegExp(expectf: string): RegExp {
  let out = "";
  for (let i = 0; i < expectf.length; i++) {
    if (expectf[i] !== "%") {
      out += escapeRegExp(expectf[i]);
      continue;
    }
    const next = expectf[++i];
    switch (next) {
      case "%": out += "%"; break;
      case "a": out += ".+"; break;
      case "A": out += "[\\s\\S]*"; break;
      case "s": out += "[^\\r\\n]*"; break;
      case "S": out += "\\S*"; break;
      case "w": out += "\\s*"; break;
      case "i": out += "[+-]?\\d+"; break;
      case "d": out += "\\d+"; break;
      case "x": out += "[0-9a-fA-F]+"; break;
      case "f": out += "[+-]?(?:(?:\\d+\\.\\d*)|(?:\\d*\\.\\d+)|(?:\\d+))(?:[Ee][+-]?\\d+)?"; break;
      case "c": out += "."; break;
      case "e": out += "[/\\\\]"; break;
      default:
        out += escapeRegExp(`%${next ?? ""}`);
    }
  }
  return new RegExp(`^${out}$`, "s");
}

function compareExpectation(test: PhptTest, actualRaw: string): { ok: boolean; detail?: string } {
  const actual = normalizeOutput(actualRaw);
  if (test.sections.EXPECT !== undefined) {
    const expected = normalizeOutput(test.sections.EXPECT);
    return {
      ok: actual === expected,
      detail: actual === expected ? undefined : `expected exact output length ${expected.length}, got ${actual.length}`,
    };
  }
  if (test.sections.EXPECTF !== undefined) {
    const expected = normalizeOutput(test.sections.EXPECTF);
    const re = expectfToRegExp(expected);
    return { ok: re.test(actual), detail: re.test(actual) ? undefined : "EXPECTF pattern did not match" };
  }
  if (test.sections.EXPECTREGEX !== undefined) {
    const expected = normalizeOutput(test.sections.EXPECTREGEX);
    const re = new RegExp(expected, "s");
    return { ok: re.test(actual), detail: re.test(actual) ? undefined : "EXPECTREGEX pattern did not match" };
  }
  return { ok: false, detail: "no supported EXPECT section" };
}

function unsupportedReason(test: PhptTest): string | null {
  if (test.sections.REDIRECTTEST !== undefined) return "REDIRECTTEST is not supported by the Kandelo PHPT harness yet";
  const sapiOnly = [
    "POST", "PUT", "GET", "COOKIE", "REQUEST", "HEADERS",
    "EXPECTHEADERS", "GZIP_POST", "DEFLATE_POST", "CGI",
  ].find((section) => test.sections[section] !== undefined);
  if (sapiOnly) return `${sapiOnly} requires web/CGI PHPT handling`;
  if (
    test.sections.FILE === undefined &&
    test.sections.FILEEOF === undefined &&
    test.sections.FILE_EXTERNAL === undefined
  ) {
    return "no FILE/FILEEOF/FILE_EXTERNAL section";
  }
  if (
    test.sections.FILE_EXTERNAL !== undefined &&
    !existsSync(join(dirname(test.path), test.sections.FILE_EXTERNAL.trim()))
  ) {
    return `FILE_EXTERNAL target not found: ${test.sections.FILE_EXTERNAL.trim()}`;
  }
  if (
    test.sections.EXPECT === undefined &&
    test.sections.EXPECTF === undefined &&
    test.sections.EXPECTREGEX === undefined
  ) {
    return "no supported EXPECT section";
  }
  return null;
}

function testScript(test: PhptTest): string {
  if (test.sections.FILE !== undefined) return test.sections.FILE;
  if (test.sections.FILEEOF !== undefined) return test.sections.FILEEOF;
  if (test.sections.FILE_EXTERNAL !== undefined) {
    return readFileSync(join(dirname(test.path), test.sections.FILE_EXTERNAL.trim()), "utf-8");
  }
  return "";
}

function nodeTempPath(test: PhptTest, kind: string): string {
  return join(dirname(test.path), `.kandelo-phpt-${process.pid}-${tempCounter++}-${kind}.php`);
}

function browserScriptPath(test: PhptTest, sourceRoot: string, kind: string): string {
  const relDir = relative(sourceRoot, dirname(test.path)).split("\\").join("/");
  const name = `.kandelo-phpt-${tempCounter++}-${kind}.php`;
  return relDir ? `/php-src/${relDir}/${name}` : `/php-src/${name}`;
}

class NodePhpRunner implements PhpRunner {
  constructor(private phpPath: string) {}

  async runScript(opts: {
    test: PhptTest;
    kind: "skipif" | "file" | "clean";
    script: string;
    argv: string[];
    scriptArgs?: string[];
    env: string[];
    stdin?: string;
    timeoutMs: number;
  }): Promise<PhpRunResult> {
    const scriptPath = nodeTempPath(opts.test, opts.kind);
    writeFileSync(scriptPath, opts.script);
    const start = performance.now();
    let stdout = "";
    let stderr = "";
    const phpBytes = loadBytes(this.phpPath);
    const host = new NodeKernelHost({
      maxWorkers: 4,
      onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
      onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
      onResolveExec: (path) => {
        const base = path.split("/").pop();
        if (base === "php" || base === "php.wasm") return loadBytes(this.phpPath);
        return null;
      },
    });
    await host.init();
    const stdin = opts.stdin == null ? undefined : new TextEncoder().encode(opts.stdin);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const exitPromise = host.spawn(phpBytes, [this.phpPath, ...opts.argv, scriptPath, ...(opts.scriptArgs ?? [])], {
        cwd: dirname(opts.test.path),
        env: [
          "HOME=/tmp",
          "TMPDIR=/tmp",
          `TEST_PHP_EXECUTABLE=${this.phpPath}`,
          ...opts.env,
        ],
        stdin,
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("TIMEOUT")), opts.timeoutMs);
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
      rmSync(scriptPath, { force: true });
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
        env: { ...process.env, KANDELO_BROWSER_DEMO_INPUTS: "php-test" },
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

class BrowserPhpRunner implements PhpRunner {
  private vite: ChildProcess | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private runs = 0;

  constructor(private sourceRoot: string, private rebuildVfs: boolean) {}

  async init(): Promise<void> {
    if (this.rebuildVfs || !existsSync(PHP_TEST_VFS)) {
      execFileSync("bash", [join(REPO_ROOT, "images/vfs/scripts/build-php-test-vfs-image.sh")], {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: { ...process.env, PHP_SOURCE_DIR: this.sourceRoot },
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
      if (!this.browser || !this.browser.isConnected()) {
        await this.launchBrowser();
      }
      try {
        const context = await this.browser!.newContext();
        this.page = await context.newPage();
        this.page.on("console", (msg) => {
          if (msg.type() === "error") console.error(`[browser] ${msg.text()}`);
        });
        await this.page.goto(`http://${VITE_HOST}:${VITE_PORT}/pages/php-test/`);
        await this.page.waitForFunction(() => (window as any).__phpTestReady === true, {}, { timeout: 120_000 });
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

  async runScript(opts: {
    test: PhptTest;
    kind: "skipif" | "file" | "clean";
    script: string;
    argv: string[];
    scriptArgs?: string[];
    env: string[];
    stdin?: string;
    timeoutMs: number;
  }): Promise<PhpRunResult> {
    if (!this.page) throw new Error("browser page not ready");
    if (this.runs > 0 && this.runs % 20 === 0) {
      await this.page.context().close();
      await this.reloadPage();
    }
    this.runs++;

    const scriptPath = browserScriptPath(opts.test, this.sourceRoot, opts.kind);
    const relDir = relative(this.sourceRoot, dirname(opts.test.path)).split("\\").join("/");
    const cwd = relDir ? `/php-src/${relDir}` : "/php-src";
    const request = {
      scriptPath,
      script: opts.script,
      argv: [...opts.argv, scriptPath, ...(opts.scriptArgs ?? [])],
      cwd,
      env: opts.env,
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs,
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const start = performance.now();
      try {
        return await this.page.evaluate(
          async ({ request }) => (window as any).__runPhpScript(request),
          { request },
        );
      } catch (err: any) {
        const message = err?.message || String(err);
        const recoverable = /Execution context was destroyed|Target page, context or browser has been closed|Navigation failed/i.test(message);
        if (attempt === 0 && recoverable) {
          await this.page?.context().close().catch(() => {});
          try {
            await this.reloadPage();
          } catch (reloadErr: any) {
            return {
              exitCode: -1,
              stdout: "",
              stderr: "",
              error: reloadErr?.message || String(reloadErr),
              durationMs: Math.round(performance.now() - start),
            };
          }
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

async function runPhpt(
  test: PhptTest,
  runner: PhpRunner,
  timeoutMs: number,
): Promise<TestResult> {
  const start = performance.now();
  const unsupported = unsupportedReason(test);
  if (unsupported) {
    return { test: test.rel, status: "unsupported", time_ms: 0, reason: unsupported };
  }

  const commonEnv = envArgs(test.sections.ENV);
  const baseArgv = iniArgs(test.sections.INI);
  const args = splitArgs(test.sections.ARGS);

  if (test.sections.SKIPIF !== undefined) {
    const skip = await runner.runScript({
      test,
      kind: "skipif",
      script: test.sections.SKIPIF,
      argv: baseArgv,
      env: commonEnv,
      timeoutMs,
    });
    const skipOutput = normalizeOutput(`${skip.stdout}${skip.stderr}`);
    if (/^skip\b/i.test(skipOutput)) {
      return { test: test.rel, status: "skip", time_ms: Math.round(performance.now() - start), reason: skipOutput };
    }
    if (skip.error === "TIMEOUT") {
      return { test: test.rel, status: "time", time_ms: skip.durationMs, reason: "SKIPIF timed out" };
    }
  }

  const main = await runner.runScript({
    test,
    kind: "file",
    script: testScript(test),
    argv: baseArgv,
    scriptArgs: args,
    env: commonEnv,
    stdin: test.sections.STDIN,
    timeoutMs,
  });

  let ok = false;
  let detail = main.error;
  if (main.error === "TIMEOUT") {
    ok = false;
  } else {
    const compared = compareExpectation(test, `${main.stdout}${main.stderr}`);
    // PHPTs often intentionally trigger fatal errors; upstream run-tests.php
    // treats matching output as the authority rather than requiring exit 0.
    ok = compared.ok;
    detail = compared.detail;
  }

  if (test.sections.CLEAN !== undefined) {
    await runner.runScript({
      test,
      kind: "clean",
      script: test.sections.CLEAN,
      argv: baseArgv,
      env: commonEnv,
      timeoutMs: Math.min(timeoutMs, 30_000),
    }).catch(() => {});
  }

  const isXfail = test.sections.XFAIL !== undefined;
  let status: TestStatus;
  if (main.error === "TIMEOUT") status = isXfail ? "xfail" : "time";
  else if (ok) status = isXfail ? "xpass" : "pass";
  else status = isXfail ? "xfail" : "fail";

  return {
    test: test.rel,
    status,
    time_ms: Math.round(performance.now() - start),
    reason: status === "xfail" ? normalizeOutput(test.sections.XFAIL ?? "expected failure") : undefined,
    detail,
  };
}

function printUsage(): void {
  console.error(`Usage: npx tsx scripts/run-php-upstream-tests.ts [options] [test-or-dir ...]

Options:
  --host node|browser   Host runtime to use (default: node)
  --all                 Run every .phpt test under php-src (default when no tests are passed)
  --timeout <ms>        Per PHPT section timeout (default: 60000)
  --limit <n>           Run only the first n discovered tests
  --json                Emit JSON lines
  --report              Write docs/php-upstream-test-report.md
  --rebuild-vfs         Rebuild php-test.vfs.zst before browser runs

Environment:
  PHP_WASM              Path to php.wasm
  PHP_SOURCE_DIR        Path to a php-src checkout/extract
`);
}

async function main() {
  const args = process.argv.slice(2);
  let host: HostKind = "node";
  let timeoutMs = 60_000;
  let limit: number | null = null;
  let json = false;
  let report = false;
  let rebuildVfs = false;
  const selectors: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      return;
    } else if (arg === "--host" && args[i + 1]) {
      const value = args[++i];
      if (value !== "node" && value !== "browser") throw new Error(`invalid host: ${value}`);
      host = value;
    } else if (arg === "--all") {
      // Default mode; accepted for clarity.
    } else if (arg === "--timeout" && args[i + 1]) {
      timeoutMs = parseInt(args[++i], 10);
    } else if (arg === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--report") {
      report = true;
    } else if (arg === "--rebuild-vfs") {
      rebuildVfs = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      selectors.push(arg);
    }
  }

  const sourceRoot = resolvePhpSource();
  const phpPath = resolvePhpBinary();
  let tests = discoverTests(sourceRoot, selectors);
  if (limit !== null) tests = tests.slice(0, limit);

  if (!json) {
    console.error("===== PHP PHPT runtime tests =====");
    console.error(`Host: ${host}`);
    console.error(`php-src: ${sourceRoot}`);
    console.error(`PHP wasm: ${phpPath}`);
    console.error(`Tests: ${tests.length}`);
    console.error("");
  }

  let runner: PhpRunner;
  if (host === "browser") {
    const browserRunner = new BrowserPhpRunner(sourceRoot, rebuildVfs);
    await browserRunner.init();
    runner = browserRunner;
  } else {
    runner = new NodePhpRunner(phpPath);
  }

  const counts: Record<TestStatus, number> = {
    pass: 0,
    fail: 0,
    skip: 0,
    xfail: 0,
    xpass: 0,
    unsupported: 0,
    time: 0,
  };
  const results: TestResult[] = [];

  try {
    for (let i = 0; i < tests.length; i++) {
      const result = await runPhpt(tests[i], runner, timeoutMs);
      counts[result.status]++;
      results.push(result);
      if (json) {
        console.log(JSON.stringify(result));
      } else {
        const label = result.status.toUpperCase().padEnd(11);
        console.error(`[${i + 1}/${tests.length}] ${label} ${result.test} (${result.time_ms}ms)`);
      }
    }
  } finally {
    await runner.close();
  }

  if (report) {
    const reportPath = join(REPO_ROOT, "docs/php-upstream-test-report.md");
    mkdirSync(dirname(reportPath), { recursive: true });
    const lines = [
      "# PHP PHPT Runtime Test Report",
      "",
      `Host: ${host}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      "| Status | Count |",
      "|--------|-------|",
      ...Object.entries(counts).map(([status, count]) => `| ${status.toUpperCase()} | ${count} |`),
      `| **TOTAL** | **${results.length}** |`,
      "",
      "## Non-Passing Results",
      "",
      ...results
        .filter((r) => !["pass", "skip", "xfail"].includes(r.status))
        .map((r) => `- ${r.status.toUpperCase()} \`${r.test}\`${r.reason ? `: ${r.reason}` : ""}${r.detail ? ` (${r.detail})` : ""}`),
      "",
    ];
    writeFileSync(reportPath, `${lines.join("\n")}\n`);
    if (!json) console.error(`Report written to: ${reportPath}`);
  }

  if (!json) {
    console.error("");
    console.error("===== Results =====");
    for (const status of ["pass", "fail", "skip", "xfail", "xpass", "unsupported", "time"] as const) {
      console.error(`${status.toUpperCase().padEnd(11)} ${counts[status]}`);
    }
    console.error(`TOTAL       ${results.length}`);
  }

  if (counts.fail > 0 || counts.xpass > 0 || counts.time > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

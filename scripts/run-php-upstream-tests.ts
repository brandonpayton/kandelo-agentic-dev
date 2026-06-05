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
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { tryResolveBinary } from "../host/src/binary-resolver";
import { ensureSourceExtract } from "../images/vfs/scripts/source-extract-helper";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const LOCAL_PHP_SRC = join(REPO_ROOT, "packages/registry/php/php-src");
const PHP_TEST_VFS = join(
  REPO_ROOT,
  "apps/browser-demos/public/php-test.vfs.zst",
);
const BROWSER_DIR = join(REPO_ROOT, "apps/browser-demos");
const VITE_HOST = "127.0.0.1";
const VITE_PORT = Number(process.env.PHP_TEST_VITE_PORT ?? 5201);

type HostKind = "node" | "browser";
type TestStatus =
  | "pass"
  | "fail"
  | "skip"
  | "xfail"
  | "xpass"
  | "unsupported"
  | "time";

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

const PASSTHROUGH_ENV_NAMES = [
  "NO_INTERACTION",
  "SKIP_IO_CAPTURE_TESTS",
  "SKIP_ONLINE_TESTS",
  "SKIP_PERF_SENSITIVE",
  "SKIP_SLOW_TESTS",
];

function forceNodeGc(): void {
  try {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    gc();
  } catch {
    // Best-effort: Node may disable exposing gc in some embeddings.
  }
}

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function resolvePhpBinary(): string {
  const candidate =
    process.env.PHP_WASM ??
    tryResolveBinary("programs/php/php.wasm") ??
    join(LOCAL_PHP_SRC, "sapi/cli/php");
  if (!candidate || !existsSync(candidate)) {
    throw new Error(
      "PHP wasm not found. Run: bash packages/registry/php/build-php.sh",
    );
  }
  return candidate;
}

function resolvePhpSource(): string {
  const explicit = process.env.PHP_SOURCE_DIR;
  if (explicit) return resolve(explicit);
  return ensureSourceExtract(
    "php",
    REPO_ROOT,
    existsSync(LOCAL_PHP_SRC) ? LOCAL_PHP_SRC : undefined,
  );
}

function parsePhpt(path: string, sourceRoot: string): PhptTest {
  // PHPT files are byte-oriented. A few upstream tests intentionally contain
  // non-UTF-8 PHP source/EXPECT bytes, so keep a one-code-point-per-byte
  // representation and write/capture generated scripts the same way.
  const text = readFileSync(path, "latin1");
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
    if (
      entry.name === ".git" ||
      entry.name === ".deps" ||
      entry.name === ".libs"
    )
      continue;
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
      const resolved = isAbsolute(selector)
        ? selector
        : resolve(sourceRoot, selector);
      if (!existsSync(resolved))
        throw new Error(`PHPT selector not found: ${selector}`);
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

function guestTestDir(test: PhptTest): string {
  const relDir = dirname(test.rel).split("\\").join("/");
  return relDir === "." ? "/php-src" : `/php-src/${relDir}`;
}

function expandSectionPlaceholders(value: string, test: PhptTest): string {
  return value.replaceAll("{PWD}", guestTestDir(test));
}

function iniArgs(ini: string | undefined, test: PhptTest): string[] {
  if (!ini) return [];
  const args: string[] = [];
  for (const raw of expandSectionPlaceholders(ini, test).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq >= 0) {
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      line = `${key}=${value}`;
    }
    args.push("-d", line);
  }
  return args;
}

function envArgs(env: string | undefined, test: PhptTest): string[] {
  if (!env) return [];
  const args: string[] = [];
  for (const raw of expandSectionPlaceholders(env, test).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    // Upstream run-tests.php feeds --ENV-- through PHP's proc_open()
    // environment array. proc_open's POSIX envp builder intentionally skips
    // entries whose value is an empty string, so mirror that rather than
    // passing NAME= directly to Kandelo.
    if (eq >= 0 && line.slice(eq + 1).length === 0) continue;
    args.push(line);
  }
  return args;
}

function passthroughEnvArgs(): string[] {
  return PASSTHROUGH_ENV_NAMES.flatMap((name) =>
    process.env[name] === undefined ? [] : [`${name}=${process.env[name]}`],
  );
}

function isFlakyTest(test: PhptTest): boolean {
  if (test.sections.FLAKY !== undefined) return true;
  const file = test.sections.FILE ?? "";
  return /\b(?:disk_free_space|hrtime|microtime|sleep|usleep)\s*\(/i.test(file);
}

function isFlakyOutput(output: string): boolean {
  return /\b(?:404: page not found|address already in use|connection refused|deadlock|mailbox already exists|timed out)\b/i.test(output);
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function extensionArgs(extensions: string | undefined): string[] {
  if (!extensions) return [];
  return extensions
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function extensionSkipScript(extensions: string[]): string {
  return `<?php
$required = ${JSON.stringify(extensions)};
$missing = [];
foreach ($required as $extension) {
    $name = strtolower($extension);
    if ($name === "zend opcache") {
        $name = "opcache";
    }
    if (!extension_loaded($extension) && !extension_loaded($name)) {
        $missing[] = $extension;
    }
}
if ($missing) {
    echo "skip required extension(s) not loaded: " . implode(", ", $missing);
}
?>`;
}

function normalizeOutput(text: string): string {
  // Upstream php-src run-tests.php normalizes CRLF and compares PHP
  // trim($out) against trim(EXPECT*). PHP trim's default charlist includes
  // NUL bytes, unlike JavaScript String#trim().
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^[\x00\t\n\v\r ]+|[\x00\t\n\v\r ]+$/g, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceExpectfPlaceholders(text: string): string {
  return text.replace(/%[easSAwidxfc0]/g, (token) => {
    switch (token) {
      case "%e":
        return "[/\\\\]";
      case "%s":
        return "[^\\r\\n]+";
      case "%S":
        return "[^\\r\\n]*";
      case "%a":
        return ".+";
      case "%A":
        return "[\\s\\S]*";
      case "%w":
        return "\\s*";
      case "%i":
        return "[+-]?\\d+";
      case "%d":
        return "\\d+";
      case "%x":
        return "[0-9a-fA-F]+";
      case "%f":
        return "[+-]?(?:(?:\\d+\\.\\d*)|(?:\\d*\\.\\d+)|(?:\\d+))(?:[Ee][+-]?\\d+)?";
      case "%c":
        return ".";
      case "%0":
        return "\\x00";
      default:
        return escapeRegExp(token);
    }
  });
}

function expectfToRegExp(expectf: string): RegExp {
  let out = "";
  for (let i = 0; i < expectf.length; i++) {
    if (expectf.startsWith("%r", i)) {
      const end = expectf.indexOf("%r", i + 2);
      if (end !== -1) {
        out += `(${expectf.slice(i + 2, end)})`;
        i = end + 1;
        continue;
      }
    }
    out += escapeRegExp(expectf[i]);
  }
  // Upstream run-tests.php first preg_quote()s non-%r sections, leaves %r
  // regex spans raw, then applies EXPECTF %-placeholder substitutions to the
  // whole pattern. Do not treat %% specially: literal percent signs remain
  // literal unless followed by a recognized placeholder character.
  return new RegExp(`^${replaceExpectfPlaceholders(out)}$`, "s");
}

function compareExpectation(
  test: PhptTest,
  actualRaw: string,
): { ok: boolean; detail?: string } {
  const actual = normalizeOutput(actualRaw);
  if (test.sections.EXPECT !== undefined) {
    const expected = normalizeOutput(test.sections.EXPECT);
    return {
      ok: actual === expected,
      detail:
        actual === expected
          ? undefined
          : `expected exact output length ${expected.length}, got ${actual.length}`,
    };
  }
  if (test.sections.EXPECTF !== undefined) {
    const expected = normalizeOutput(test.sections.EXPECTF);
    const re = expectfToRegExp(expected);
    return {
      ok: re.test(actual),
      detail: re.test(actual) ? undefined : "EXPECTF pattern did not match",
    };
  }
  if (test.sections.EXPECTREGEX !== undefined) {
    const expected = normalizeOutput(test.sections.EXPECTREGEX);
    const re = new RegExp(expected, "s");
    return {
      ok: re.test(actual),
      detail: re.test(actual) ? undefined : "EXPECTREGEX pattern did not match",
    };
  }
  return { ok: false, detail: "no supported EXPECT section" };
}

function unsupportedReason(test: PhptTest): string | null {
  if (test.sections.REDIRECTTEST !== undefined)
    return "REDIRECTTEST is not supported by the Kandelo PHPT harness yet";
  const sapiOnly = [
    "POST",
    "POST_RAW",
    "PUT",
    "GET",
    "COOKIE",
    "REQUEST",
    "HEADERS",
    "EXPECTHEADERS",
    "GZIP_POST",
    "DEFLATE_POST",
    "CGI",
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
    return readFileSync(
      join(dirname(test.path), test.sections.FILE_EXTERNAL.trim()),
      "latin1",
    );
  }
  return "";
}

function phptGeneratedScriptName(test: PhptTest, kind: string): string {
  const base = basename(test.path, ".phpt");
  if (kind === "file") {
    return `${base}.php`;
  }
  if (kind === "clean") {
    return `${base}.clean.php`;
  }
  if (kind === "skipif") {
    return `${base}.skip.php`;
  }
  return `.kandelo-phpt-${process.pid}-${tempCounter++}-${kind}.php`;
}

function nodeTempPath(test: PhptTest, scriptName: string): string {
  return join(dirname(test.path), scriptName);
}

function guestScriptPath(
  test: PhptTest,
  sourceRoot: string,
  scriptName: string,
): string {
  const relDir = relative(sourceRoot, dirname(test.path)).split("\\").join("/");
  return relDir ? `/php-src/${relDir}/${scriptName}` : `/php-src/${scriptName}`;
}

class NodePhpRunner implements PhpRunner {
  private virtualPhpPath: string;

  constructor(
    private sourceRoot: string,
    private phpPath: string,
  ) {
    this.virtualPhpPath = `/kandelo-bin/${basename(phpPath)}`;
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
    const scriptName = phptGeneratedScriptName(opts.test, opts.kind);
    const hostScriptPath = nodeTempPath(opts.test, scriptName);
    const scriptPath = guestScriptPath(opts.test, this.sourceRoot, scriptName);
    const previousScript = existsSync(hostScriptPath)
      ? readFileSync(hostScriptPath)
      : null;
    writeFileSync(hostScriptPath, opts.script, "latin1");
    const start = performance.now();
    let stdout = "";
    let stderr = "";
    const phpBytes = loadBytes(this.phpPath);
    const host = new NodeKernelHost({
      maxWorkers: 4,
      rootfsImage: "default",
      extraMounts: [
        { mountPoint: "/php-src", hostPath: this.sourceRoot },
        {
          mountPoint: "/kandelo-bin",
          hostPath: dirname(this.phpPath),
          readonly: true,
        },
      ],
      onStdout: (_pid, data) => {
        stdout += Buffer.from(data).toString("latin1");
      },
      onStderr: (_pid, data) => {
        stderr += Buffer.from(data).toString("latin1");
      },
      onResolveExec: (path) => {
        const base = path.split("/").pop();
        if (base === "php" || base === "php.wasm")
          return loadBytes(this.phpPath);
        return null;
      },
    });
    await host.init();
    const stdin =
      opts.stdin == null ? undefined : Buffer.from(opts.stdin, "latin1");
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let pid: number | null = null;
    try {
      const exitPromise = host.spawn(
        phpBytes,
        [
          this.virtualPhpPath,
          ...opts.argv,
          scriptPath,
          ...(opts.scriptArgs ?? []),
        ],
        {
          // php-src run-tests.php executes generated test files from the
          // source root. Several PHPTs intentionally use source-root-relative
          // paths such as ./ext/standard/tests/file.
          cwd: "/php-src",
          env: [
            "HOME=/tmp",
            "TMPDIR=/tmp",
            "PATH=/bin:/usr/bin:/usr/local/bin",
            `TEST_PHP_SRCDIR=/php-src`,
            `TEST_PHP_EXECUTABLE=${this.virtualPhpPath}`,
            `TEST_PHP_EXECUTABLE_ESCAPED=${shellEscape(this.virtualPhpPath)}`,
            // Kandelo's PHP build reports PHP_BINARY as an empty string.
            // php-src helpers such as ServerClientTestCase.inc build worker
            // commands as "PHP_BINARY TEST_PHP_EXTRA_ARGS ..."; supplying the
            // executable here makes those generic helpers spawn PHP workers.
            `TEST_PHP_EXTRA_ARGS=${this.virtualPhpPath}`,
            ...opts.env,
          ],
          stdin,
          onStarted: (startedPid) => {
            pid = startedPid;
          },
        },
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("TIMEOUT")),
          opts.timeoutMs,
        );
      });
      const exitCode = await Promise.race([exitPromise, timeoutPromise]);
      return {
        exitCode,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - start),
      };
    } catch (err: any) {
      const message = err?.message || String(err);
      if (message.includes("TIMEOUT") && pid !== null) {
        await host.terminateProcess(pid).catch(() => {});
      }
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
      forceNodeGc();
      if (previousScript) {
        writeFileSync(hostScriptPath, previousScript);
      } else {
        rmSync(hostScriptPath, { force: true });
      }
    }
  }

  async close(): Promise<void> {}
}

async function startViteServer(): Promise<ChildProcess> {
  return new Promise((resolvePromise, reject) => {
    const viteBin = join(BROWSER_DIR, "node_modules", ".bin", "vite");
    const useLocalVite = existsSync(viteBin);
    const proc = spawn(
      useLocalVite ? viteBin : "npx",
      [
        ...(useLocalVite ? [] : ["vite"]),
        "--config",
        join(BROWSER_DIR, "vite.config.ts"),
        "--host",
        VITE_HOST,
        "--port",
        String(VITE_PORT),
        "--strictPort",
      ],
      {
        cwd: BROWSER_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, KANDELO_BROWSER_DEMO_INPUTS: "php-test" },
      },
    );
    let started = false;
    let stderr = "";
    const timeout = setTimeout(() => {
      if (!started) {
        proc.kill();
        reject(
          new Error(
            `Vite server did not start within 30s${
              stderr
                ? `:
${stderr}`
                : ""
            }`,
          ),
        );
      }
    }, 30_000);
    proc.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
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
        reject(
          new Error(
            `Vite exited with code ${code}${
              stderr
                ? `:
${stderr}`
                : ""
            }`,
          ),
        );
      }
    });
  });
}

class BrowserPhpRunner implements PhpRunner {
  private vite: ChildProcess | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private runs = 0;

  constructor(
    private sourceRoot: string,
    private rebuildVfs: boolean,
  ) {}

  async init(): Promise<void> {
    if (this.rebuildVfs || !existsSync(PHP_TEST_VFS)) {
      execFileSync(
        "bash",
        [join(REPO_ROOT, "images/vfs/scripts/build-php-test-vfs-image.sh")],
        {
          cwd: REPO_ROOT,
          stdio: "inherit",
          env: { ...process.env, PHP_SOURCE_DIR: this.sourceRoot },
        },
      );
    }
    this.vite = await startViteServer();
    await this.launchBrowser();
    await this.reloadPage();
  }

  private async launchBrowser(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = await chromium.launch({
      args: ["--enable-features=SharedArrayBuffer"],
    });
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
        await this.page.goto(
          `http://${VITE_HOST}:${VITE_PORT}/pages/php-test/`,
        );
        await this.page.waitForFunction(
          () => (window as any).__phpTestReady === true,
          {},
          { timeout: 120_000 },
        );
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

    const scriptName = phptGeneratedScriptName(opts.test, opts.kind);
    const scriptPath = guestScriptPath(opts.test, this.sourceRoot, scriptName);
    const request = {
      scriptPath,
      script: opts.script,
      argv: [...opts.argv, scriptPath, ...(opts.scriptArgs ?? [])],
      cwd: "/php-src",
      env: [
        "PATH=/bin:/usr/bin:/usr/local/bin",
        "TEST_PHP_SRCDIR=/php-src",
        "TEST_PHP_EXECUTABLE=/usr/local/bin/php",
        "TEST_PHP_EXECUTABLE_ESCAPED='/usr/local/bin/php'",
        ...opts.env,
      ],
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
        const recoverable =
          /Execution context was destroyed|Target page, context or browser has been closed|Navigation failed/i.test(
            message,
          );
        if (attempt === 0 && recoverable) {
          await this.page
            ?.context()
            .close()
            .catch(() => {});
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
    if (this.page)
      await this.page
        .context()
        .close()
        .catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    if (this.vite) {
      const vite = this.vite;
      if (vite.exitCode === null && vite.signalCode === null) {
        vite.kill("SIGTERM");
      }
      await new Promise<void>((resolveDone) => {
        if (vite.exitCode !== null || vite.signalCode !== null) {
          resolveDone();
          return;
        }
        const killTimer = setTimeout(() => {
          if (vite.exitCode === null && vite.signalCode === null) {
            vite.kill("SIGKILL");
          }
          resolveDone();
        }, 2000);
        vite.once("exit", () => {
          clearTimeout(killTimer);
          resolveDone();
        });
      });
      this.vite = null;
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
    return {
      test: test.rel,
      status: "unsupported",
      time_ms: 0,
      reason: unsupported,
    };
  }

  const commonEnv = [...passthroughEnvArgs(), ...envArgs(test.sections.ENV, test)];
  const testArgv = iniArgs(test.sections.INI, test);
  const args = splitArgs(test.sections.ARGS);

  const requiredExtensions = extensionArgs(test.sections.EXTENSIONS);
  if (requiredExtensions.length > 0) {
    const extensionSkip = await runner.runScript({
      test,
      kind: "skipif",
      script: extensionSkipScript(requiredExtensions),
      argv: [],
      env: commonEnv,
      timeoutMs,
    });
    const extensionOutput = normalizeOutput(
      `${extensionSkip.stdout}${extensionSkip.stderr}`,
    );
    if (/^skip\b/i.test(extensionOutput)) {
      return {
        test: test.rel,
        status: "skip",
        time_ms: Math.round(performance.now() - start),
        reason: extensionOutput,
      };
    }
    if (extensionSkip.error === "TIMEOUT") {
      return {
        test: test.rel,
        status: "time",
        time_ms: extensionSkip.durationMs,
        reason: "EXTENSIONS check timed out",
      };
    }
  }

  if (test.sections.SKIPIF !== undefined) {
    const skip = await runner.runScript({
      test,
      kind: "skipif",
      script: test.sections.SKIPIF,
      // Upstream run-tests.php executes SKIPIF before applying the test's
      // --INI-- block. Keep that ordering so resource-probing SKIPIF sections
      // are not distorted by settings meant only for the main FILE body.
      argv: [],
      env: commonEnv,
      timeoutMs,
    });
    const skipOutput = normalizeOutput(`${skip.stdout}${skip.stderr}`);
    if (/^skip\b/i.test(skipOutput)) {
      return {
        test: test.rel,
        status: "skip",
        time_ms: Math.round(performance.now() - start),
        reason: skipOutput,
      };
    }
    if (/^xfail\b/i.test(skipOutput)) {
      return {
        test: test.rel,
        status: "xfail",
        time_ms: Math.round(performance.now() - start),
        reason: skipOutput,
      };
    }
    if (skip.error === "TIMEOUT") {
      return {
        test: test.rel,
        status: "time",
        time_ms: skip.durationMs,
        reason: "SKIPIF timed out",
      };
    }
  }

  const runMain = () =>
    runner.runScript({
      test,
      kind: "file",
      script: testScript(test),
      argv: testArgv,
      scriptArgs: args,
      env: commonEnv,
      stdin: test.sections.STDIN,
      timeoutMs,
    });

  let main = await runMain();

  let ok = false;
  let detail = main.error;
  let actualOutput = `${main.stdout}${main.stderr}`;
  if (main.error !== "TIMEOUT") {
    const compared = compareExpectation(test, actualOutput);
    // PHPTs often intentionally trigger fatal errors; upstream run-tests.php
    // treats matching output as the authority rather than requiring exit 0.
    ok = compared.ok;
    detail = compared.detail;
    if (!ok && detail) {
      const snippet = normalizeOutput(actualOutput)
        .slice(0, 2000)
        .replace(/\n/g, "\\n");
      const errorDetail = main.error ? `; error=${main.error}` : "";
      detail = `${detail}; exit=${main.exitCode}${errorDetail}; actual: ${snippet}`;
    }
  }

  if (
    !ok &&
    main.error !== "TIMEOUT" &&
    (isFlakyTest(test) || isFlakyOutput(actualOutput))
  ) {
    main = await runMain();
    actualOutput = `${main.stdout}${main.stderr}`;
    detail = main.error;
    if (main.error !== "TIMEOUT") {
      const compared = compareExpectation(test, actualOutput);
      ok = compared.ok;
      detail = compared.detail;
      if (!ok && detail) {
        const snippet = normalizeOutput(actualOutput)
          .slice(0, 2000)
          .replace(/\n/g, "\\n");
        const errorDetail = main.error ? `; error=${main.error}` : "";
        detail = `${detail}; exit=${main.exitCode}${errorDetail}; actual: ${snippet}`;
      }
    }
  }

  if (test.sections.CLEAN !== undefined) {
    await runner
      .runScript({
        test,
        kind: "clean",
        script: test.sections.CLEAN,
        // CLEAN runs with the same pre-test INI baseline as SKIPIF upstream.
        argv: [],
        env: commonEnv,
        timeoutMs: Math.min(timeoutMs, 30_000),
      })
      .catch(() => {});
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
    reason:
      status === "xfail"
        ? normalizeOutput(test.sections.XFAIL ?? "expected failure")
        : undefined,
    detail,
  };
}

function printUsage(): void {
  console.error(`Usage: npx tsx scripts/run-php-upstream-tests.ts [options] [test-or-dir ...]

Options:
  --host node|browser   Host runtime to use (default: node)
  --all                 Run every .phpt test under php-src (default when no tests are passed)
  --timeout <ms>        Per PHPT section timeout (default: 60000)
  --shard <i>/<n>       Run 1-based shard i of n after discovery sorting
  --offset <n>          Skip the first n selected tests
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
  let shard: { index: number; total: number } | null = null;
  let offset = 0;
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
      if (value !== "node" && value !== "browser")
        throw new Error(`invalid host: ${value}`);
      host = value;
    } else if (arg === "--all") {
      // Default mode; accepted for clarity.
    } else if (arg === "--timeout" && args[i + 1]) {
      timeoutMs = parseInt(args[++i], 10);
    } else if (arg === "--shard" && args[i + 1]) {
      const value = args[++i];
      const match = /^(\d+)\/(\d+)$/.exec(value);
      if (!match) throw new Error(`invalid shard: ${value}`);
      shard = {
        index: parseInt(match[1], 10),
        total: parseInt(match[2], 10),
      };
      if (shard.total < 1 || shard.index < 1 || shard.index > shard.total) {
        throw new Error(`invalid shard: ${value}`);
      }
    } else if (arg === "--offset" && args[i + 1]) {
      offset = parseInt(args[++i], 10);
      if (!Number.isFinite(offset) || offset < 0) {
        throw new Error(`invalid offset: ${offset}`);
      }
    } else if (arg === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i], 10);
      if (!Number.isFinite(limit) || limit < 0) {
        throw new Error(`invalid limit: ${limit}`);
      }
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
  if (shard !== null) {
    tests = tests.filter((_, idx) => idx % shard!.total === shard!.index - 1);
  }
  if (offset > 0) tests = tests.slice(offset);
  if (limit !== null) tests = tests.slice(0, limit);

  if (!json) {
    console.error("===== PHP PHPT runtime tests =====");
    console.error(`Host: ${host}`);
    console.error(`php-src: ${sourceRoot}`);
    console.error(`PHP wasm: ${phpPath}`);
    if (shard !== null) {
      console.error(`Shard: ${shard.index}/${shard.total}`);
    }
    if (offset > 0) console.error(`Offset: ${offset}`);
    console.error(`Tests: ${tests.length}`);
    console.error("");
  }

  let runner: PhpRunner;
  if (host === "browser") {
    const browserRunner = new BrowserPhpRunner(sourceRoot, rebuildVfs);
    await browserRunner.init();
    runner = browserRunner;
  } else {
    runner = new NodePhpRunner(sourceRoot, phpPath);
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
        console.error(
          `[${i + 1}/${tests.length}] ${label} ${result.test} (${result.time_ms}ms)`,
        );
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
      ...Object.entries(counts).map(
        ([status, count]) => `| ${status.toUpperCase()} | ${count} |`,
      ),
      `| **TOTAL** | **${results.length}** |`,
      "",
      "## Non-Passing Results",
      "",
      ...results
        .filter((r) => !["pass", "skip", "xfail"].includes(r.status))
        .map(
          (r) =>
            `- ${r.status.toUpperCase()} \`${r.test}\`${r.reason ? `: ${r.reason}` : ""}${r.detail ? ` (${r.detail})` : ""}`,
        ),
      "",
    ];
    writeFileSync(reportPath, `${lines.join("\n")}\n`);
    if (!json) console.error(`Report written to: ${reportPath}`);
  }

  if (!json) {
    console.error("");
    console.error("===== Results =====");
    for (const status of [
      "pass",
      "fail",
      "skip",
      "xfail",
      "xpass",
      "unsupported",
      "time",
    ] as const) {
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

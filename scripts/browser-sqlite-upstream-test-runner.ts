/**
 * Browser SQLite upstream test runner.
 *
 * Launches Vite, opens /pages/sqlite-test/, and runs each SQLite Tcl
 * testfixture file through BrowserKernel.
 */
import { chromium, type Browser, type Page } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const BROWSER_DIR = resolve(REPO_ROOT, "apps/browser-demos");
const VITE_HOST = "127.0.0.1";
const VITE_PORT = Number(process.env.SQLITE_TEST_VITE_PORT ?? 5200);
const DEFAULT_TIMEOUT = 180_000;

interface Result {
  test: string;
  status: "pass" | "fail" | "skip" | "time";
  exitCode: number;
  time_ms: number;
  case_total?: number;
  case_errors?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

async function startViteServer(): Promise<ChildProcess> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      "npx",
      [
        "vite",
        "--config", resolve(BROWSER_DIR, "vite.config.ts"),
        "--host", VITE_HOST,
        "--port", String(VITE_PORT),
        "--strictPort",
      ],
      {
        cwd: BROWSER_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, KANDELO_BROWSER_DEMO_INPUTS: "sqlite-test" },
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

async function waitForRunner(page: Page): Promise<void> {
  await page.goto(`http://${VITE_HOST}:${VITE_PORT}/pages/sqlite-test/`);
  await page.waitForFunction(() => (window as any).__sqliteTestReady === true, {}, { timeout: 120_000 });
}

async function launchBrowser(): Promise<Browser> {
  return await chromium.launch({ args: ["--enable-features=SharedArrayBuffer"] });
}

async function openRunnerPage(browserRef: { browser: Browser }, oldContext?: Awaited<ReturnType<Browser["newContext"]>>): Promise<{ context: Awaited<ReturnType<Browser["newContext"]>>; page: Page }> {
  await oldContext?.close().catch(() => {});
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!browserRef.browser.isConnected()) {
      await browserRef.browser.close().catch(() => {});
      browserRef.browser = await launchBrowser();
    }
    try {
      const context = await browserRef.browser.newContext();
      const page = await context.newPage();
      page.on("console", (msg) => {
        if (msg.type() === "error") console.error(`[browser] ${msg.text()}`);
      });
      await waitForRunner(page);
      return { context, page };
    } catch (err) {
      if (attempt === 0) {
        await browserRef.browser.close().catch(() => {});
        browserRef.browser = await launchBrowser();
        continue;
      }
      throw err;
    }
  }
  throw new Error("failed to open SQLite browser runner page");
}

function classify(raw: any): Result {
  const output = `${raw.stdout || ""}\n${raw.stderr || ""}`;
  const countMatch = output.match(/([0-9]+) errors out of ([0-9]+) tests/);
  const okCount = (output.match(/\.\.\. Ok/g) ?? []).length;
  const caseErrors = countMatch ? Number(countMatch[1]) : undefined;
  const caseTotal = countMatch ? Number(countMatch[2]) : okCount;
  let status: Result["status"] = "fail";
  if (raw.error === "TIMEOUT") {
    status = "time";
  } else if (/0 errors out of/.test(output)) {
    status = "pass";
  } else if (/Skipping tests|cannot run because|not available/i.test(output) && !/! |Expected:|wrong # args|Error in /.test(output)) {
    status = "skip";
  } else if (raw.exitCode === 0 && /\.\.\. Ok/.test(output) && !/! |Expected:|wrong # args|Error in /.test(output)) {
    status = "pass";
  }
  return {
    test: raw.test,
    status,
    exitCode: raw.exitCode,
    time_ms: raw.durationMs,
    case_total: caseTotal,
    case_errors: caseErrors,
    stdout: raw.stdout?.slice(-2000),
    stderr: raw.stderr?.slice(-2000),
    error: raw.error,
  };
}

async function runTest(page: Page, test: string, timeoutMs: number): Promise<Result> {
  const raw = await Promise.race([
    page.evaluate(
      async ({ testFile, timeout }) => (window as any).__runSqliteTest(testFile, timeout),
      { testFile: test, timeout: timeoutMs },
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("PLAYWRIGHT_TIMEOUT")), timeoutMs + 30_000),
    ),
  ]);
  return classify(raw);
}

function pageCrashResult(test: string, started: number, err: unknown): Result {
  const message = err instanceof Error ? err.message : String(err);
  const timedOut = message.includes("PLAYWRIGHT_TIMEOUT");
  return {
    test,
    status: timedOut ? "time" : "fail",
    exitCode: -1,
    time_ms: Math.round(performance.now() - started),
    error: timedOut ? "TIMEOUT" : message,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let json = false;
  let timeout = DEFAULT_TIMEOUT;
  const tests: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") {
      json = true;
    } else if (args[i] === "--timeout" && args[i + 1]) {
      timeout = parseInt(args[++i], 10);
    } else {
      tests.push(args[i]);
    }
  }

  if (tests.length === 0) {
    console.error("Usage: npx tsx scripts/browser-sqlite-upstream-test-runner.ts [--json] [--timeout <ms>] test1.test ...");
    process.exit(1);
  }

  let vite: ChildProcess | null = null;
  let browser: Browser | null = null;
  try {
    vite = await startViteServer();
    browser = await launchBrowser();
    const browserRef = { browser };
    let { context, page } = await openRunnerPage(browserRef);

    for (let i = 0; i < tests.length; i++) {
      const started = performance.now();
      let result: Result;
      try {
        result = await runTest(page, tests[i], timeout);
      } catch (err) {
        result = pageCrashResult(tests[i], started, err);
        ({ context, page } = await openRunnerPage(browserRef, context));
        browser = browserRef.browser;
      }
      if (json) {
        console.log(JSON.stringify(result));
      } else {
        process.stderr.write(`[${i + 1}/${tests.length}] ${result.status.toUpperCase()} ${result.test} (${result.time_ms}ms)\n`);
      }

      // Recreate the context periodically to release SharedArrayBuffer address space.
      if ((i + 1) % 10 === 0 && i < tests.length - 1) {
        ({ context, page } = await openRunnerPage(browserRef, context));
        browser = browserRef.browser;
      }
    }
  } finally {
    if (browser) await browser.close();
    if (vite) {
      vite.kill();
      await new Promise<void>((resolveDone) => {
        vite!.on("exit", () => resolveDone());
        setTimeout(resolveDone, 2000);
      });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env tsx
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { findRepoRoot, tryResolveBinary } from "../host/src/binary-resolver";
import { NodeKernelHost } from "../host/src/node-kernel-host";

const REPO_ROOT = findRepoRoot();
const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = Number(process.env.SPIDERMONKEY_NODE_JS_SHELL_PORT ?? 5311);
const DEFAULT_TIMEOUT_MS = Number(process.env.SPIDERMONKEY_WRAPPER_TIMEOUT_MS ?? 600_000);

interface RunRequest {
  argv: string[];
  cwd?: string;
  env?: string[];
  timeoutMs?: number;
}

interface ActiveRun {
  stdout: string;
  stderr: string;
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

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function readJsonBody(req: IncomingMessage): Promise<RunRequest> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs),
    ),
  ]);
}

async function main() {
  const jsPath = resolveJsWasm();
  const jsBytes = loadBytes(jsPath);
  const activeRuns = new Map<number, ActiveRun>();
  let currentRun: ActiveRun | null = null;

  const host = new NodeKernelHost({
    maxWorkers: 8,
    onStdout: (pid, data) => {
      const run = activeRuns.get(pid) ?? currentRun;
      if (run) run.stdout += new TextDecoder().decode(data);
    },
    onStderr: (pid, data) => {
      const run = activeRuns.get(pid) ?? currentRun;
      if (run) run.stderr += new TextDecoder().decode(data);
    },
    onResolveExec: (path) => {
      const base = basename(path);
      if (base === "js" || base === "js.wasm" || base === "spidermonkey.wasm") {
        return jsBytes;
      }
      const candidates = [
        path,
        path.endsWith(".wasm") ? path : `${path}.wasm`,
        resolve(process.cwd(), path),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) return loadBytes(candidate);
      }
      return null;
    },
  });
  await host.init();

  let queue = Promise.resolve();
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method !== "POST" || req.url !== "/run") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    queue = queue.then(async () => {
      const run: ActiveRun = { stdout: "", stderr: "" };
      currentRun = run;
      let pid: number | undefined;
      try {
        const body = await readJsonBody(req);
        const argv = ["js", ...body.argv];
        const exit = host.spawn(jsBytes, argv, {
          cwd: body.cwd || REPO_ROOT,
          env: body.env,
          onStarted: (startedPid) => {
            pid = startedPid;
            activeRuns.set(startedPid, run);
          },
        });
        const exitCode = await withTimeout(exit, body.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          exitCode,
          stdout: run.stdout,
          stderr: run.stderr,
        }));
      } catch (err: any) {
        const message = err?.message || String(err);
        if (message.includes("TIMEOUT") && pid !== undefined) {
          await host.terminateProcess(pid, -1).catch(() => {});
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          exitCode: -1,
          stdout: run.stdout,
          stderr: run.stderr,
          error: message.includes("TIMEOUT") ? "TIMEOUT" : message,
        }));
      } finally {
        if (pid !== undefined) activeRuns.delete(pid);
        currentRun = null;
      }
    });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(SERVER_PORT, SERVER_HOST, resolveListen);
  });
  console.error(`node js shell bridge listening on http://${SERVER_HOST}:${SERVER_PORT}/run`);

  const shutdown = async () => {
    server.close();
    await host.destroy().catch(() => {});
  };
  process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
  process.on("SIGINT", () => { void shutdown().finally(() => process.exit(130)); });
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});

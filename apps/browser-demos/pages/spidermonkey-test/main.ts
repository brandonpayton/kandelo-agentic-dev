/**
 * Browser runner for SpiderMonkey shell unit tests.
 *
 * Exposes window.__runSpiderMonkeyScript(...) for the Playwright driver.
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import { MemoryFileSystem } from "@host/vfs/memory-fs";
import { ensureDirRecursive, writeVfsFile } from "@host/vfs/image-helpers";
import kernelWasmUrl from "@kernel-wasm?url";

interface RunSpiderMonkeyRequest {
  source?: string;
  shellArgs?: string[];
  argv?: string[];
  scriptPath?: string;
  scriptContent?: string;
  scriptArgs?: string[];
  timeoutMs?: number;
}

interface RunSpiderMonkeyResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs: number;
  processReaped?: boolean;
}

declare global {
  interface Window {
    __spiderMonkeyTestReady: boolean;
    __runSpiderMonkeyScript: (request: RunSpiderMonkeyRequest) => Promise<RunSpiderMonkeyResult>;
  }
}

let kernelBytes: ArrayBuffer | null = null;
let vfsImageBytes: Uint8Array | null = null;
let jsBytes: ArrayBuffer | null = null;
let officialFs: MemoryFileSystem | null = null;
let officialKernel: BrowserKernel | null = null;
let officialStdout = "";
let officialStderr = "";

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const out = new Uint8Array(st.size);
    let offset = 0;
    while (offset < out.length) {
      const n = fs.read(fd, out.subarray(offset), null, out.length - offset);
      if (n <= 0) break;
      offset += n;
    }
    return out.slice(0, offset);
  } finally {
    fs.close(fd);
  }
}

function createFs(): MemoryFileSystem {
  if (!vfsImageBytes) throw new Error("SpiderMonkey test VFS image not loaded");
  return MemoryFileSystem.fromImage(vfsImageBytes, {
    maxByteLength: 1536 * 1024 * 1024,
  });
}

function ensureParent(fs: MemoryFileSystem, path: string): void {
  const slash = path.lastIndexOf("/");
  if (slash > 0) ensureDirRecursive(fs, path.slice(0, slash));
}

async function init() {
  const [kernelBuf, imageBuf] = await Promise.all([
    fetch(kernelWasmUrl).then((r) => {
      if (!r.ok) throw new Error(`kernel fetch failed: ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch("/spidermonkey-test.vfs.zst").then((r) => {
      if (!r.ok) {
        throw new Error(
          `spidermonkey-test.vfs.zst not found (${r.status}). ` +
          "Run: bash images/vfs/scripts/build-spidermonkey-test-vfs-image.sh",
        );
      }
      return r.arrayBuffer();
    }),
  ]);

  kernelBytes = kernelBuf;
  vfsImageBytes = new Uint8Array(imageBuf);
  const fs = createFs();
  const js = readVfsFile(fs, "/usr/bin/js");
  jsBytes = js.buffer.slice(js.byteOffset, js.byteOffset + js.byteLength);

  async function getOfficialKernel(): Promise<BrowserKernel> {
    if (officialKernel) return officialKernel;
    if (!officialFs) officialFs = createFs();
    officialKernel = new BrowserKernel({
      memfs: officialFs,
      maxWorkers: 8,
      onStdout: (data) => { officialStdout += new TextDecoder().decode(data); },
      onStderr: (data) => { officialStderr += new TextDecoder().decode(data); },
    });
    await officialKernel.init(kernelBytes!);
    return officialKernel;
  }

  window.__runSpiderMonkeyScript = async (request: RunSpiderMonkeyRequest) => {
    const start = performance.now();
    let argv: string[];

    if (request.argv) {
      argv = ["/usr/bin/js", ...request.argv];
    } else if (request.scriptPath) {
      if (request.scriptContent !== undefined) {
        ensureParent(fs, request.scriptPath);
        writeVfsFile(fs, request.scriptPath, request.scriptContent, 0o644);
      }
      argv = [
        "/usr/bin/js",
        ...(request.shellArgs ?? []),
        request.scriptPath,
        ...(request.scriptArgs ?? []),
      ];
    } else {
      argv = [
        "/usr/bin/js",
        ...(request.shellArgs ?? []),
        "-e",
        request.source ?? "",
      ];
    }

    if (request.argv) {
      officialStdout = "";
      officialStderr = "";
      let pid: number | undefined;
      try {
        const kernel = await getOfficialKernel();
        const spawned = await kernel.spawnFromVfs("/usr/bin/js", argv, {
          cwd: "/tmp",
          env: [
            "HOME=/tmp",
            "TMPDIR=/tmp",
            "PATH=/usr/bin:/bin",
          ],
        });
        pid = spawned.pid;
        const exitCode = await Promise.race([
          spawned.exit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error("TIMEOUT")), request.timeoutMs ?? 60_000),
          ),
        ]);
        const processReaped = pid === undefined || (await kernel.readProcMaps(pid)) === null;
        return {
          exitCode,
          stdout: officialStdout,
          stderr: officialStderr,
          durationMs: Math.round(performance.now() - start),
          processReaped,
        };
      } catch (err: any) {
        const message = err?.message || String(err);
        let processReaped: boolean | undefined;
        if (message.includes("TIMEOUT") && pid !== undefined && officialKernel) {
          await officialKernel.terminateProcess(pid, -1).catch(() => {});
          processReaped = (await officialKernel.readProcMaps(pid).catch(() => null)) === null;
        }
        return {
          exitCode: -1,
          stdout: officialStdout,
          stderr: officialStderr,
          error: message.includes("TIMEOUT") ? "TIMEOUT" : message,
          durationMs: Math.round(performance.now() - start),
          processReaped,
        };
      }
    }

    const fs = createFs();
    let stdout = "";
    let stderr = "";
    const kernel = new BrowserKernel({
      memfs: fs,
      maxWorkers: 8,
      onStdout: (data) => { stdout += new TextDecoder().decode(data); },
      onStderr: (data) => { stderr += new TextDecoder().decode(data); },
    });

    try {
      await kernel.init(kernelBytes!);
      const exitCode = await Promise.race([
        kernel.spawn(jsBytes!, argv, {
          cwd: "/tmp",
          env: [
            "HOME=/tmp",
            "TMPDIR=/tmp",
            "PATH=/usr/bin:/bin",
          ],
        }),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT")), request.timeoutMs ?? 60_000),
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
      await kernel.destroy().catch(() => {});
    }
  };

  window.__spiderMonkeyTestReady = true;
  document.getElementById("status")!.textContent = "Ready";
}

init().catch((err) => {
  console.error(err);
  document.getElementById("status")!.textContent = `Error: ${err?.message || err}`;
});

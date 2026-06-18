/**
 * Browser runner page for upstream Node.js JavaScript library tests.
 *
 * Exposes window.__runNodejsLibraryTest(...) for the Playwright driver.
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import { MemoryFileSystem } from "@host/vfs/memory-fs";
import { ensureDirRecursive } from "@host/vfs/image-helpers";
import kernelWasmUrl from "@kernel-wasm?url";

interface RunNodejsTestRequest {
  testPath: string;
  flags?: string[];
  evalSource?: string;
  env?: string[];
  timeoutMs?: number;
}

interface RunNodejsTestResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs: number;
}

declare global {
  interface Window {
    __nodejsTestReady: boolean;
    __runNodejsLibraryTest: (request: RunNodejsTestRequest) => Promise<RunNodejsTestResult>;
  }
}

let kernelBytes: ArrayBuffer | null = null;
let vfsImageBytes: Uint8Array | null = null;
let nodeBytes: ArrayBuffer | null = null;

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
  if (!vfsImageBytes) throw new Error("Node.js test VFS image not loaded");
  const fs = MemoryFileSystem.fromImage(vfsImageBytes, {
    maxByteLength: 1536 * 1024 * 1024,
  });
  ensureDirRecursive(fs, "/tmp");
  fs.chmod("/tmp", 0o777);
  return fs;
}

async function init() {
  const [kernelBuf, imageBuf] = await Promise.all([
    fetch(kernelWasmUrl).then((r) => {
      if (!r.ok) throw new Error(`kernel fetch failed: ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch("/nodejs-test.vfs.zst").then((r) => {
      if (!r.ok) {
        throw new Error(
          `nodejs-test.vfs.zst not found (${r.status}). ` +
          "Run: bash images/vfs/scripts/build-nodejs-test-vfs-image.sh",
        );
      }
      return r.arrayBuffer();
    }),
  ]);

  kernelBytes = kernelBuf;
  vfsImageBytes = new Uint8Array(imageBuf);
  const fs = createFs();
  const node = readVfsFile(fs, "/usr/bin/node");
  nodeBytes = node.buffer.slice(node.byteOffset, node.byteOffset + node.byteLength);

  window.__runNodejsLibraryTest = async (request: RunNodejsTestRequest) => {
    const start = performance.now();
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
      const argv = request.evalSource
        ? ["/usr/bin/node", "-e", request.evalSource]
        : ["/usr/bin/node", ...(request.flags ?? []), request.testPath];
      const exitCode = await Promise.race([
        kernel.spawn(nodeBytes!, argv, {
          cwd: "/node-src",
          env: request.env ?? [],
        }),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT")), request.timeoutMs ?? 30_000),
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

  window.__nodejsTestReady = true;
  document.getElementById("status")!.textContent = "Ready";
}

init().catch((err) => {
  console.error(err);
  document.getElementById("status")!.textContent = `Error: ${err?.message || err}`;
});

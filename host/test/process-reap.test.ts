import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../src/node-kernel-host";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helloWasm = join(__dirname, "../../examples/hello.wasm");

function loadWasm(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe("process reaping", () => {
  it("removes top-level host spawns from the kernel process table after exit", async () => {
    const host = new NodeKernelHost({
      maxWorkers: 4,
    });
    await host.init();

    try {
      for (let i = 0; i < 8; i++) {
        let pid: number | undefined;
        const exit = host.spawn(loadWasm(helloWasm), ["hello"], {
          onStarted: (startedPid) => { pid = startedPid; },
        });

        expect(await exit).toBe(0);
        expect(pid).toBeDefined();
        const procs = await host.enumProcs();
        expect(procs.some((proc) => proc.pid === pid)).toBe(false);
      }
    } finally {
      await host.destroy().catch(() => {});
    }
  }, 30_000);
});

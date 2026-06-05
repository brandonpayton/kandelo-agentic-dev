import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../src/node-kernel-host";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import { resolveBinary } from "../src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helloWasm = join(__dirname, "../../examples/hello.wasm");

function loadWasm(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function loadKernelWasm(): ArrayBuffer {
  return loadWasm(resolveBinary("kernel.wasm"));
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

  it("unregisterProcess removes a deactivated zombie so an explicit host pid can be reused", async () => {
    const kernel = new CentralizedKernelWorker(
      { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kernel.init(loadKernelWasm());

    const pid = 4242;
    const channelOffset = 14 * 65536;
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 16, shared: true });
    new Uint8Array(memory.buffer, channelOffset, 72 + 65536).fill(0);

    kernel.registerProcess(pid, memory, [channelOffset]);
    kernel.deactivateProcess(pid);
    kernel.unregisterProcess(pid);

    expect(() => kernel.registerProcess(pid, memory, [channelOffset])).not.toThrow();
    kernel.unregisterProcess(pid);
  }, 30_000);
});

import { describe, expect, it } from "vitest";
import { CentralizedKernelWorker } from "../src/kernel-worker";

describe("host-side pipe mutations", () => {
  it("drains kernel wakeup events after host writes to an injected pipe", () => {
    let drainCalls = 0;
    const worker = Object.create(CentralizedKernelWorker.prototype) as any;
    worker.scratchOffset = 64;
    worker.tcpScratchOffset = 0;
    worker.kernelMemory = new WebAssembly.Memory({ initial: 1 });
    worker.kernelInstance = {
      exports: {
        kernel_drain_wakeup_events: () => {
          drainCalls++;
          return 0;
        },
      },
    };
    worker.getKernelMem = () => new Uint8Array(worker.kernelMemory.buffer);

    const data = new Uint8Array([1, 2, 3, 4]);
    const written = worker.writePipeChunked(
      () => data.length,
      0,
      42,
      data,
    );

    expect(written).toBe(data.length);
    expect(drainCalls).toBe(1);
  });
});

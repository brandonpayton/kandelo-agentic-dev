import { describe, expect, it } from "vitest";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { WASM_PAGE_SIZE } from "../src/constants";

describe("legacy high-channel process layout", () => {
  it("reserves TLS/fork-save control pages below the primary channel", () => {
    const worker = Object.create(CentralizedKernelWorker.prototype) as {
      legacyHighControlFloor(offsets: number[]): number | undefined;
    };
    const channelOffset = 2046 * WASM_PAGE_SIZE;

    expect(worker.legacyHighControlFloor([channelOffset])).toBe(
      channelOffset - 2 * WASM_PAGE_SIZE,
    );
  });

  it("does not subtract control pages from low compact-layout channels", () => {
    const worker = Object.create(CentralizedKernelWorker.prototype) as {
      legacyHighControlFloor(offsets: number[]): number | undefined;
    };
    const channelOffset = 2 * WASM_PAGE_SIZE;

    expect(worker.legacyHighControlFloor([channelOffset])).toBe(channelOffset);
  });
});

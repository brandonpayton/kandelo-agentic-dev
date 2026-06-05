import { describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
} from "../src/generated/abi";
import { CentralizedKernelWorker } from "../src/kernel-worker";

const SIGCHLD = 17;
const WNOHANG = 1;

describe("Rust-owned process wait lifecycle", () => {
  it("wait4 consumes Rust-selected zombies and writes the Rust wait status", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const statusPtr = 256;
    const waitStatus = 5 << 8;
    const wait4Poll = vi.fn((_parentPid: number, _targetPid: number, statusPtr: number | bigint) => {
      new DataView(kernelMemory.buffer).setInt32(Number(statusPtr), waitStatus, true);
      return 42;
    });
    const reapExitedChild = vi.fn(() => 0);
    const worker = createWorkerHarness({
      kernel_wait4_poll: wait4Poll,
      kernel_reap_exited_child: reapExitedChild,
    });
    worker.kernelMemory = kernelMemory;
    worker.scratchOffset = 128;
    worker.completeWaitpid = vi.fn();

    worker.handleWaitpid(createChannel(7, processMemory), [-1, statusPtr, 0, 0]);

    expect(wait4Poll).toHaveBeenCalledWith(7, -1, 128);
    expect(reapExitedChild).toHaveBeenCalledWith(7, 42);
    expect(new DataView(processMemory.buffer).getInt32(statusPtr, true)).toBe(waitStatus);
    expect(worker.completeWaitpid).toHaveBeenCalledWith(
      expect.any(Object),
      [-1, statusPtr, 0, 0],
      42,
      0,
    );
  });

  it("throws if Rust rejects a wait-selected child reap", () => {
    const kernelMemory = createSharedMemory();
    const statusPtr = 256;
    const wait4Poll = vi.fn((_parentPid: number, _targetPid: number, statusPtr: bigint) => {
      new DataView(kernelMemory.buffer).setInt32(Number(statusPtr), 0, true);
      return 42;
    });
    const worker = createWorkerHarness({
      kernel_wait4_poll: wait4Poll,
      kernel_reap_exited_child: vi.fn(() => -10),
    });
    worker.kernelMemory = kernelMemory;
    worker.scratchOffset = 128;
    worker.completeWaitpid = vi.fn();

    expect(() => worker.handleWaitpid(createChannel(7, createSharedMemory()), [-1, statusPtr, 0, 0]))
      .toThrow("kernel_reap_exited_child failed parentPid=7 childPid=42 errno=10");
    expect(worker.completeWaitpid).not.toHaveBeenCalled();
  });

  it("wait4 leaves blocking waits in the host queue when Rust reports a running child", () => {
    const wait4Poll = vi.fn(() => 0);
    const worker = createWorkerHarness({ kernel_wait4_poll: wait4Poll });
    worker.kernelMemory = createSharedMemory();
    worker.waitingForChild = [];
    worker.completeWaitpid = vi.fn();

    const channel = createChannel(7, createSharedMemory());
    worker.handleWaitpid(channel, [-1, 0, 0, 0]);

    expect(worker.completeWaitpid).not.toHaveBeenCalled();
    expect(worker.waitingForChild).toEqual([
      {
        parentPid: 7,
        channel,
        origArgs: [-1, 0, 0, 0],
        pid: -1,
        options: 0,
        syscallNr: ABI_SYSCALLS.Wait4,
      },
    ]);
  });

  it("wait4 WNOHANG completes without queuing when Rust reports a running child", () => {
    const worker = createWorkerHarness({ kernel_wait4_poll: vi.fn(() => 0) });
    worker.kernelMemory = createSharedMemory();
    worker.waitingForChild = [];
    worker.completeWaitpid = vi.fn();

    worker.handleWaitpid(createChannel(7, createSharedMemory()), [-1, 0, WNOHANG, 0]);

    expect(worker.waitingForChild).toEqual([]);
    expect(worker.completeWaitpid).toHaveBeenCalledWith(
      expect.any(Object),
      [-1, 0, WNOHANG, 0],
      0,
      0,
    );
  });

  it("wait4 passes a bigint status pointer for wasm64 kernels", () => {
    const wait4Poll = vi.fn(() => 0);
    const worker = createWorkerHarness({ kernel_wait4_poll: wait4Poll }, 8);
    worker.kernelMemory = createSharedMemory();
    worker.waitingForChild = [];
    worker.completeWaitpid = vi.fn();

    worker.handleWaitpid(createChannel(7, createSharedMemory()), [-1, 0, WNOHANG, 0]);

    expect(wait4Poll).toHaveBeenCalledWith(7, -1, BigInt(128));
    expect(worker.waitingForChild).toEqual([]);
    expect(worker.completeWaitpid).toHaveBeenCalledWith(
      expect.any(Object),
      [-1, 0, WNOHANG, 0],
      0,
      0,
    );
  });

  it("host-observed crashes are marked in Rust before parent notification", () => {
    const calls: string[] = [];
    const markProcessSignaled = vi.fn(() => {
      calls.push("mark");
      return 0;
    });
    const worker = createWorkerHarness({
      kernel_mark_process_signaled: markProcessSignaled,
      kernel_get_parent_pid: vi.fn(() => 7),
      kernel_has_sa_nocldwait: vi.fn(() => 0),
    });
    worker.hostReaped = new Set();
    worker.sharedMappings = new Map([[42, new Map()]]);
    worker.sendSignalToProcess = vi.fn(() => calls.push("signal"));
    worker.wakeWaitingParent = vi.fn(() => calls.push("wake"));

    worker.notifyHostProcessCrashed(42, 11);

    expect(markProcessSignaled).toHaveBeenCalledWith(42, 11);
    expect(worker.sendSignalToProcess).toHaveBeenCalledWith(7, SIGCHLD);
    expect(worker.wakeWaitingParent).toHaveBeenCalledWith(7);
    expect(calls).toEqual(["mark", "signal", "wake"]);
    expect(worker.sharedMappings.has(42)).toBe(false);
  });

  it("SA_NOCLDWAIT auto-reaps through Rust without SIGCHLD", () => {
    const reapExitedChild = vi.fn(() => 0);
    const worker = createWorkerHarness({
      kernel_mark_process_signaled: vi.fn(() => 0),
      kernel_get_parent_pid: vi.fn(() => 7),
      kernel_has_sa_nocldwait: vi.fn(() => 1),
      kernel_reap_exited_child: reapExitedChild,
    });
    worker.hostReaped = new Set();
    worker.sharedMappings = new Map();
    worker.sendSignalToProcess = vi.fn();
    worker.wakeWaitingParent = vi.fn();

    worker.notifyHostProcessCrashed(42, 11);

    expect(reapExitedChild).toHaveBeenCalledWith(7, 42);
    expect(worker.sendSignalToProcess).not.toHaveBeenCalled();
    expect(worker.wakeWaitingParent).not.toHaveBeenCalled();
  });

  it("deactivates an exiting process before waking its channel", () => {
    const memory = createSharedMemory();
    const channel = createChannel(42, memory);
    const onExit = vi.fn();
    const worker = createWorkerHarness({
      kernel_handle_channel: vi.fn(() => { throw new Error("kernel_exit"); }),
      kernel_get_parent_pid: vi.fn(() => 0),
    });
    worker.callbacks = { onExit };
    worker.processes = new Map([
      [42, { pid: 42, memory, channels: [channel], ptrWidth: 4 }],
    ]);
    worker.activeChannels = [channel];
    worker.hostReaped = new Set();
    worker.scheduleWakeBlockedRetries = vi.fn();

    worker.handleExit(channel, ABI_SYSCALLS.Exit, [7]);

    expect(worker.processes.has(42)).toBe(false);
    expect(worker.activeChannels).toEqual([]);
    expect(worker.isChannelActive(channel)).toBe(false);
    expect(new Int32Array(memory.buffer, channel.channelOffset)[CH_STATUS / 4])
      .toBe(CHANNEL_STATUS_COMPLETE);
    expect(onExit).toHaveBeenCalledWith(42, 7);
    expect(worker.hostReaped.has(42)).toBe(true);
  });

  it("rejects unterminated C-string syscall args before entering Rust", () => {
    const memory = createSharedMemory(2);
    const channel = createChannel(42, memory);
    const handleChannel = vi.fn(() => 0);
    const worker = createWorkerHarness({ kernel_handle_channel: handleChannel });
    worker.kernelMemory = createSharedMemory(2);
    worker.processes = new Map([
      [42, { pid: 42, memory, channels: [channel], ptrWidth: 4 }],
    ]);
    worker.activeChannels = [channel];
    worker.drainAllPtyOutputs = vi.fn();
    worker.flushTcpSendPipes = vi.fn();
    worker.drainAndProcessWakeupEvents = vi.fn();
    worker.relistenChannel = vi.fn();

    const pathPtr = 128;
    new Uint8Array(memory.buffer).fill(0x61, pathPtr, pathPtr + 65_536);
    const view = new DataView(memory.buffer, channel.channelOffset);
    view.setUint32(CH_SYSCALL, ABI_SYSCALLS.Open, true);
    view.setBigInt64(CH_ARGS, BigInt(pathPtr), true);
    view.setBigInt64(CH_ARGS + CH_ARG_SIZE, 0n, true);
    view.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, 0n, true);

    worker.handleSyscall(channel);

    expect(handleChannel).not.toHaveBeenCalled();
    expect(view.getBigInt64(CH_RETURN, true)).toBe(-1n);
    expect(view.getUint32(CH_ERRNO, true)).toBe(36);
    expect(new Int32Array(memory.buffer, channel.channelOffset)[CH_STATUS / 4])
      .toBe(CHANNEL_STATUS_COMPLETE);
  });
});

function createWorkerHarness(exports: Record<string, unknown>, kernelPtrWidth: 4 | 8 = 4): any {
  return Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    kernel: {
      toKernelPtr(value: number | bigint): number | bigint {
        const numberValue = typeof value === "bigint" ? Number(value) : value;
        return kernelPtrWidth === 8 ? BigInt(numberValue) : numberValue;
      },
    },
    kernelInstance: { exports },
    kernelMemory: createSharedMemory(),
    scratchOffset: 128,
    config: {},
    callbacks: {},
    processes: new Map(),
    activeChannels: [],
    syscallRing: new Map(),
    channelTids: new Map(),
    threadForkContexts: new Map(),
    stdinFinite: new Set(),
    stdinBuffers: new Map(),
    alarmTimers: new Map(),
    posixTimers: new Map(),
    pendingSleeps: new Map(),
    pendingPollRetries: new Map(),
    pendingSelectRetries: new Map(),
    pendingPipeReaders: new Map(),
    pendingPipeWriters: new Map(),
    socketTimeoutTimers: new Map(),
    pendingCancels: new Set(),
    tcpListeners: new Map(),
    tcpListenerTargets: new Map(),
    tcpListenerRRIndex: new Map(),
    sharedMappings: new Map(),
    tcpConnections: new Map(),
    shmMappings: new Map(),
    usePolling: false,
  });
}

function createSharedMemory(pages = 1): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: pages,
    maximum: pages,
    shared: true,
  });
}

function createChannel(pid: number, memory: WebAssembly.Memory): any {
  return {
    pid,
    memory,
    channelOffset: 0,
    i32View: new Int32Array(memory.buffer, 0),
    consecutiveSyscalls: 0,
  };
}

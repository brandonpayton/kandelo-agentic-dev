import { afterEach, describe, expect, it, vi } from "vitest";
import { UdpRelayNetworkBackend } from "../src/networking/udp-relay-backend";
import type { NetworkIO, UdpDatagram } from "../src/types";

class MockNetwork implements NetworkIO {
  readonly localAddress = new Uint8Array([10, 1, 2, 3]);
  connected: Array<{ handle: number; addr: number[]; port: number }> = [];
  closed: number[] = [];

  connect(handle: number, addr: Uint8Array, port: number): void {
    this.connected.push({ handle, addr: Array.from(addr), port });
  }
  connectStatus(): number { return 0; }
  send(_handle: number, data: Uint8Array): number { return data.length; }
  recv(): Uint8Array { return new Uint8Array([1, 2]); }
  poll(_handle: number, events: number): number { return events; }
  close(handle: number): void { this.closed.push(handle); }
  getaddrinfo(): Uint8Array { return new Uint8Array([127, 0, 0, 1]); }
}

describe("UdpRelayNetworkBackend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("delegates TCP operations and exposes the base local address", () => {
    const base = new MockNetwork();
    const backend = new UdpRelayNetworkBackend(base, () => 0);

    backend.connect(7, new Uint8Array([1, 2, 3, 4]), 443);
    expect(base.connected).toEqual([{ handle: 7, addr: [1, 2, 3, 4], port: 443 }]);
    expect(backend.send(7, new Uint8Array([9, 9]), 0)).toBe(2);
    expect(Array.from(backend.recv(7, 10, 0))).toEqual([1, 2]);
    expect(backend.poll(7, 5)).toBe(5);
    backend.close(7);
    expect(base.closed).toEqual([7]);
    expect(Array.from(backend.localAddress ?? [])).toEqual([10, 1, 2, 3]);
  });

  it("routes UDP datagrams through the sender with defensive copies", () => {
    let captured: UdpDatagram | null = null;
    const backend = new UdpRelayNetworkBackend(new MockNetwork(), (datagram) => {
      captured = datagram;
      return 0;
    });
    const payload = new Uint8Array([1, 2, 3]);
    const rc = backend.sendDatagram({
      srcAddr: new Uint8Array([0, 0, 0, 0]),
      srcPort: 1111,
      dstAddr: new Uint8Array([10, 99, 0, 2]),
      dstPort: 5029,
      data: payload,
    });
    payload[0] = 0xff;

    expect(rc).toBe(0);
    expect(captured).not.toBeNull();
    expect(Array.from(captured!.srcAddr)).toEqual([0, 0, 0, 0]);
    expect(captured!.srcPort).toBe(1111);
    expect(Array.from(captured!.dstAddr)).toEqual([10, 99, 0, 2]);
    expect(captured!.dstPort).toBe(5029);
    expect(Array.from(captured!.data)).toEqual([1, 2, 3]);
  });

  it("reports sender exceptions as ENETUNREACH", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = new UdpRelayNetworkBackend(new MockNetwork(), () => {
      throw new Error("closed");
    });
    expect(backend.sendDatagram({
      srcAddr: new Uint8Array([0, 0, 0, 0]),
      srcPort: 1,
      dstAddr: new Uint8Array([10, 99, 0, 2]),
      dstPort: 2,
      data: new Uint8Array(0),
    })).toBe(101);
  });
});

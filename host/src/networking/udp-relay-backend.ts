import type {
  NetworkIO,
  TcpListenTarget,
  UdpDatagram,
  UdpReceiveTarget,
} from "../types";

/**
 * Callback used by {@link UdpRelayNetworkBackend} for host-routed UDP.
 * Return 0 for accepted/best-effort delivery, or a positive POSIX errno.
 */
export type UdpRelaySender = (datagram: UdpDatagram) => number | void;

export interface UdpRelayNetworkBackendOptions {
  /**
   * IPv4 address to report as this guest's externally-routable address.
   * When omitted, the wrapped backend's localAddress is used if present.
   */
  localAddress?: Uint8Array | [number, number, number, number];
}

function copyAddress(addr: Uint8Array | [number, number, number, number]): Uint8Array {
  const src = addr instanceof Uint8Array ? addr : new Uint8Array(addr);
  return new Uint8Array([src[0] ?? 0, src[1] ?? 0, src[2] ?? 0, src[3] ?? 0]);
}

/**
 * NetworkIO adapter that preserves an existing TCP/DNS backend while routing
 * host-delegated UDP datagrams through a caller-supplied relay.
 *
 * Browser Kandelo uses this to keep the TLS/fetch TCP backend for ordinary
 * guest networking and add a WebRTC DataChannel path for POSIX UDP. The
 * adapter is deliberately transport-agnostic: WebRTC, WebSocket, a proxy, or
 * tests can all supply the same `sender(datagram)` callback.
 */
export class UdpRelayNetworkBackend implements NetworkIO {
  readonly localAddress?: Uint8Array;

  constructor(
    private readonly base: NetworkIO,
    private readonly sender: UdpRelaySender,
    options: UdpRelayNetworkBackendOptions = {},
  ) {
    const local = options.localAddress ?? base.localAddress;
    this.localAddress = local ? copyAddress(local) : undefined;
  }

  connect(handle: number, addr: Uint8Array, port: number): void {
    return this.base.connect(handle, addr, port);
  }

  connectStatus(handle: number): number {
    return this.base.connectStatus(handle);
  }

  send(handle: number, data: Uint8Array, flags: number): number {
    return this.base.send(handle, data, flags);
  }

  recv(handle: number, maxLen: number, flags: number): Uint8Array {
    return this.base.recv(handle, maxLen, flags);
  }

  poll(handle: number, events: number): number {
    return this.base.poll ? this.base.poll(handle, events) : events;
  }

  close(handle: number): void {
    return this.base.close(handle);
  }

  getaddrinfo(hostname: string): Uint8Array {
    return this.base.getaddrinfo(hostname);
  }

  listenTcp(listenerId: string, addr: Uint8Array, port: number, target: TcpListenTarget): number {
    // If the wrapped backend has no virtual TCP listener table, report success
    // and let the browser kernel worker's existing service-worker bridge handle
    // listener bookkeeping. Returning ENETUNREACH here would only produce a
    // noisy warning; it would not affect the actual browser TCP bridge.
    return this.base.listenTcp ? this.base.listenTcp(listenerId, addr, port, target) : 0;
  }

  closeTcpListener(listenerId: string): void {
    this.base.closeTcpListener?.(listenerId);
  }

  bindUdp(endpointId: string, addr: Uint8Array, port: number, target: UdpReceiveTarget): number {
    // The WebRTC relay injects inbound datagrams directly into the kernel via
    // kernel_inject_datagram, so bind registration is optional. Delegate when
    // the wrapped backend supports it (e.g. LocalVirtualNetwork tests), but
    // otherwise report success so guest bind(2) is not blocked by the lack of
    // a host-side registration table.
    return this.base.bindUdp ? this.base.bindUdp(endpointId, addr, port, target) : 0;
  }

  unbindUdp(endpointId: string): void {
    this.base.unbindUdp?.(endpointId);
  }

  sendDatagram(datagram: UdpDatagram): number {
    try {
      const result = this.sender({
        srcAddr: copyAddress(datagram.srcAddr),
        srcPort: datagram.srcPort,
        dstAddr: copyAddress(datagram.dstAddr),
        dstPort: datagram.dstPort,
        data: new Uint8Array(datagram.data),
      });
      return typeof result === "number" ? result : 0;
    } catch (error) {
      console.warn("[udp-relay-network] sender failed:", error);
      return 101; // ENETUNREACH
    }
  }
}

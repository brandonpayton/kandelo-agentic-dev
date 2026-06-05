/**
 * WebRtcDatagramRelay — main-thread WebRTC half of host-routed POSIX UDP.
 *
 * The browser kernel worker reports outbound UDP datagrams to BrowserKernel,
 * this class frames matching datagrams onto an RTCDataChannel, and inbound
 * channel messages are injected back into the kernel with synthetic IPv4
 * endpoints. It intentionally depends only on a tiny BrowserKernel-shaped
 * surface so pages and tests can reuse it without coupling to a specific UI.
 */

export type Ipv4Tuple = [number, number, number, number];

/** EventTarget-shaped channel surface so tests can drive a mock. */
export interface WebRtcRelayDataChannel extends EventTarget {
  send(data: ArrayBuffer | ArrayBufferView | string): void;
}

export interface WebRtcRelayOutboundDatagram {
  srcIp: Ipv4Tuple;
  srcPort: number;
  dstIp: Ipv4Tuple;
  dstPort: number;
  data: Uint8Array;
}

export interface WebRtcRelayKernel {
  injectDatagram(datagram: {
    pid: number;
    dstIp: Ipv4Tuple;
    dstPort: number;
    srcIp: Ipv4Tuple;
    srcPort: number;
    data: Uint8Array;
  }): void;
  onHostSendDgram(handler: (event: WebRtcRelayOutboundDatagram) => void): () => void;
}

export const WEBRTC_RELAY_HEADER_LEN = 7;
export const WEBRTC_RELAY_TYPE_UDP_DATAGRAM = 0x01;
/**
 * Soft MTU guardrail for unreliable SCTP data channels. DOOM packets are small
 * (<100 bytes in normal play); this warning catches accidental jumbo traffic
 * without making UDP more reliable than the transport beneath it.
 */
export const WEBRTC_RELAY_SOFT_MTU = 1024;

export interface WebRtcDatagramRelayOptions {
  kernel: WebRtcRelayKernel;
  channel: WebRtcRelayDataChannel;
  /** This browser's synthetic Kandelo IPv4 address. */
  localAddr: Ipv4Tuple;
  /** The remote browser's synthetic Kandelo IPv4 address. */
  peerAddr: Ipv4Tuple;
  /** Optional label used in console diagnostics. */
  label?: string;
}

function sameIpv4(a: Ipv4Tuple, b: Ipv4Tuple): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function copyIpv4(addr: Ipv4Tuple): Ipv4Tuple {
  return [addr[0], addr[1], addr[2], addr[3]];
}

function toUint8Array(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return null;
}

export class WebRtcDatagramRelay {
  private readonly kernel: WebRtcRelayKernel;
  private readonly channel: WebRtcRelayDataChannel;
  private readonly localAddr: Ipv4Tuple;
  private readonly peerAddr: Ipv4Tuple;
  private readonly label: string;
  private readonly inboundListener: (event: Event) => void;
  private readonly unsubscribeOutbound: () => void;
  private targetPid: number | null = null;
  private closed = false;

  constructor(options: WebRtcDatagramRelayOptions) {
    this.kernel = options.kernel;
    this.channel = options.channel;
    this.localAddr = copyIpv4(options.localAddr);
    this.peerAddr = copyIpv4(options.peerAddr);
    this.label = options.label ?? "webrtc-relay";

    this.inboundListener = (event: Event) => this.handleInbound(event as MessageEvent);
    this.channel.addEventListener("message", this.inboundListener);
    this.unsubscribeOutbound = this.kernel.onHostSendDgram((event) => this.handleOutbound(event));
  }

  /** Set or update the process that should receive inbound datagrams. */
  setTargetPid(pid: number): void {
    this.targetPid = pid;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.removeEventListener("message", this.inboundListener);
    this.unsubscribeOutbound();
  }

  private handleInbound(event: MessageEvent): void {
    if (this.closed || this.targetPid === null) return;

    const frame = toUint8Array(event.data);
    if (!frame || frame.length < WEBRTC_RELAY_HEADER_LEN) return;
    if (frame[0] !== WEBRTC_RELAY_TYPE_UDP_DATAGRAM) return;

    const srcPort = (frame[1] << 8) | frame[2];
    const dstPort = (frame[5] << 8) | frame[6];
    const payload = frame.subarray(WEBRTC_RELAY_HEADER_LEN);

    this.kernel.injectDatagram({
      pid: this.targetPid,
      dstIp: copyIpv4(this.localAddr),
      dstPort,
      srcIp: copyIpv4(this.peerAddr),
      srcPort,
      data: payload,
    });
  }

  private handleOutbound(event: WebRtcRelayOutboundDatagram): void {
    if (this.closed) return;

    // This DataChannel terminates at exactly one peer. Drop datagrams for any
    // other IP so a guest cannot accidentally redirect arbitrary UDP traffic
    // (for example 8.8.8.8:53) over the private WebRTC session.
    if (!sameIpv4(event.dstIp, this.peerAddr)) return;

    const total = WEBRTC_RELAY_HEADER_LEN + event.data.length;
    if (total > WEBRTC_RELAY_SOFT_MTU) {
      console.warn(`[${this.label}] UDP frame ${total} bytes exceeds soft MTU ${WEBRTC_RELAY_SOFT_MTU}`);
    }

    const frame = new Uint8Array(total);
    frame[0] = WEBRTC_RELAY_TYPE_UDP_DATAGRAM;
    frame[1] = (event.srcPort >>> 8) & 0xff;
    frame[2] = event.srcPort & 0xff;
    frame[3] = 0;
    frame[4] = 0;
    frame[5] = (event.dstPort >>> 8) & 0xff;
    frame[6] = event.dstPort & 0xff;
    frame.set(event.data, WEBRTC_RELAY_HEADER_LEN);

    try {
      this.channel.send(frame);
    } catch (error) {
      // UDP is best-effort; a closed channel is just packet loss.
      console.warn(`[${this.label}] channel.send failed:`, error);
    }
  }
}

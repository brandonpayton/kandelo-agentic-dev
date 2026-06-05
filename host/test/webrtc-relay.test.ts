import { describe, expect, it } from "vitest";
import {
  WebRtcDatagramRelay,
  WEBRTC_RELAY_HEADER_LEN,
  WEBRTC_RELAY_TYPE_UDP_DATAGRAM,
  type Ipv4Tuple,
  type WebRtcRelayDataChannel,
  type WebRtcRelayKernel,
  type WebRtcRelayOutboundDatagram,
} from "../src/networking/webrtc-relay";

class MockChannel extends EventTarget implements WebRtcRelayDataChannel {
  sent: Uint8Array[] = [];

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (typeof data === "string") throw new Error("relay should send binary frames");
    if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data.slice(0)));
      return;
    }
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(new Uint8Array(view));
  }

  recv(data: Uint8Array | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

class MockKernel implements WebRtcRelayKernel {
  injected: Array<{
    pid: number;
    dstIp: Ipv4Tuple;
    dstPort: number;
    srcIp: Ipv4Tuple;
    srcPort: number;
    data: Uint8Array;
  }> = [];
  private listeners = new Set<(event: WebRtcRelayOutboundDatagram) => void>();

  injectDatagram(datagram: {
    pid: number;
    dstIp: Ipv4Tuple;
    dstPort: number;
    srcIp: Ipv4Tuple;
    srcPort: number;
    data: Uint8Array;
  }): void {
    this.injected.push({ ...datagram, data: new Uint8Array(datagram.data) });
  }

  onHostSendDgram(handler: (event: WebRtcRelayOutboundDatagram) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  fire(event: WebRtcRelayOutboundDatagram): void {
    for (const listener of this.listeners) listener(event);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

const LOCAL: Ipv4Tuple = [10, 99, 0, 1];
const PEER: Ipv4Tuple = [10, 99, 0, 2];
const OTHER: Ipv4Tuple = [8, 8, 8, 8];

function makeRelay() {
  const channel = new MockChannel();
  const kernel = new MockKernel();
  const relay = new WebRtcDatagramRelay({
    kernel,
    channel,
    localAddr: LOCAL,
    peerAddr: PEER,
  });
  relay.setTargetPid(123);
  return { channel, kernel, relay };
}

describe("WebRtcDatagramRelay", () => {
  it("frames outbound host UDP datagrams onto the data channel", () => {
    const { channel, kernel } = makeRelay();
    kernel.fire({
      srcIp: LOCAL,
      srcPort: 5029,
      dstIp: PEER,
      dstPort: 6000,
      data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    });

    expect(channel.sent).toHaveLength(1);
    const frame = channel.sent[0];
    expect(frame[0]).toBe(WEBRTC_RELAY_TYPE_UDP_DATAGRAM);
    expect(frame[1]).toBe(5029 >>> 8);
    expect(frame[2]).toBe(5029 & 0xff);
    expect(frame[3]).toBe(0);
    expect(frame[4]).toBe(0);
    expect(frame[5]).toBe(6000 >>> 8);
    expect(frame[6]).toBe(6000 & 0xff);
    expect(Array.from(frame.subarray(WEBRTC_RELAY_HEADER_LEN))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("drops outbound datagrams addressed to a different synthetic peer", () => {
    const { channel, kernel } = makeRelay();
    kernel.fire({
      srcIp: LOCAL,
      srcPort: 5029,
      dstIp: OTHER,
      dstPort: 53,
      data: new Uint8Array([1, 2, 3]),
    });
    expect(channel.sent).toHaveLength(0);
  });

  it("injects inbound frames with configured local and peer addresses", () => {
    const { channel, kernel } = makeRelay();
    channel.recv(new Uint8Array([
      WEBRTC_RELAY_TYPE_UDP_DATAGRAM,
      0x13, 0xa5, // src 5029
      0, 0,
      0x17, 0x70, // dst 6000
      0xaa,
    ]));

    expect(kernel.injected).toHaveLength(1);
    expect(kernel.injected[0]).toEqual({
      pid: 123,
      dstIp: LOCAL,
      dstPort: 6000,
      srcIp: PEER,
      srcPort: 5029,
      data: new Uint8Array([0xaa]),
    });
  });

  it("ignores inbound frames until a target pid is known", () => {
    const channel = new MockChannel();
    const kernel = new MockKernel();
    new WebRtcDatagramRelay({ kernel, channel, localAddr: LOCAL, peerAddr: PEER });
    channel.recv(new Uint8Array([WEBRTC_RELAY_TYPE_UDP_DATAGRAM, 0, 1, 0, 0, 0, 2]));
    expect(kernel.injected).toHaveLength(0);
  });

  it("unsubscribes and ignores traffic after close", () => {
    const { channel, kernel, relay } = makeRelay();
    expect(kernel.listenerCount()).toBe(1);
    relay.close();
    expect(kernel.listenerCount()).toBe(0);
    kernel.fire({ srcIp: LOCAL, srcPort: 1, dstIp: PEER, dstPort: 2, data: new Uint8Array([3]) });
    channel.recv(new Uint8Array([WEBRTC_RELAY_TYPE_UDP_DATAGRAM, 0, 1, 0, 0, 0, 2]));
    expect(channel.sent).toHaveLength(0);
    expect(kernel.injected).toHaveLength(0);
  });
});

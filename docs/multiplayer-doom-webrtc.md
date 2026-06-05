# Multiplayer DOOM over WebRTC

Kandelo can run two fbDOOM instances in separate browsers and relay their normal
POSIX UDP traffic over a peer-to-peer WebRTC `RTCDataChannel`. The demo page is:

```text
apps/browser-demos/pages/doom-mp/
```

## Architecture

- fbDOOM is patched to re-enable Chocolate Doom's multiplayer net stack and add
  `net_posix.c`, a BSD-sockets UDP transport.
- Inside the guest, fbDOOM still calls `socket(AF_INET, SOCK_DGRAM)`, `bind`,
  `sendto`, and `recvfrom`.
- The Kandelo kernel delegates non-loopback UDP to the browser host through
  `host_udp_send` / `NetworkIO.sendDatagram`.
- `UdpRelayNetworkBackend` preserves the browser TLS/fetch TCP backend and
  routes UDP datagrams to the kernel worker's relay shim.
- The main thread owns WebRTC. `WebRtcDatagramRelay` frames matching UDP
  datagrams onto an unordered/unreliable `RTCDataChannel`, and injects inbound
  frames back through `kernel_inject_datagram`.
- The WebRTC channel is a two-peer synthetic /24:
  - host: `10.99.0.1`
  - joiner: `10.99.0.2`
  - default DOOM UDP port: `5029`

The relay drops outbound datagrams whose destination IP is not the configured
peer address, so arbitrary guest UDP (for example DNS to `8.8.8.8`) is not
silently redirected over the private WebRTC session.

## STUN/session negotiation

The demo uses manual SDP copy/paste and Google's public STUN server:

```ts
[{ urls: "stun:stun.l.google.com:19302" }]
```

No signaling server is required. WebRTC DTLS still encrypts the data channel;
the manual SDP exchange is only session setup.

## Build/run

1. Build or fetch the normal Kandelo browser artifacts.
2. Rebuild fbDOOM after this change so the package includes the multiplayer
   `net_posix` patch:

   ```bash
   bash packages/registry/fbdoom/build-fbdoom.sh
   ```

3. Start the browser demo server:

   ```bash
   npm --prefix apps/browser-demos install
   npm --prefix apps/browser-demos run dev
   ```

4. Open `http://127.0.0.1:5401/pages/doom-mp/` in two separate browsers or two
   browser profiles.
5. In the Host browser, keep role **Host** and click **Create offer**. Copy the
   Local SDP.
6. In the Join browser, choose role **Join**, paste the offer as Remote SDP, and
   click **Accept offer**. Copy the Join browser's Local SDP answer.
7. Paste that answer into the Host browser's Remote SDP and click
   **Accept answer**.
8. When both data channels show `open`, click **Start DOOM** in both browsers.
   Click the framebuffer to focus/pointer-lock the mouse.

The page downloads the shareware `doom1.wad`, verifies its SHA-256, and stores it
in the Cache API. It is not committed to this repository.

## Browser compatibility

- Requires WebRTC DataChannels and `RTCPeerConnection`.
- Requires `SharedArrayBuffer`, so the page must be cross-origin isolated. The
  Vite dev server sets COOP/COEP headers; production builds rely on the existing
  Kandelo service worker bootstrap.
- Chrome/Edge and Firefox are the primary targets. Safari may work when it has
  WebRTC DataChannel and cross-origin-isolated `SharedArrayBuffer` support, but
  it is not the primary validation target.
- A public STUN server is enough for many LAN/NAT pairs. Symmetric NATs and some
  corporate networks require TURN; TURN is not implemented in this demo.

## Known limitations and follow-up work

- Manual SDP copy/paste only; a small signaling service would make the flow
  easier without changing the relay architecture.
- Two-player point-to-point only. A mesh or server relay would need address-aware
  routing beyond one `peerAddr`.
- No TURN configuration UI yet.
- The fbDOOM package must be rebuilt locally until a binary archive is published
  for this package revision.
- No automated end-to-end WebRTC+DOOM gameplay assertion. Unit tests cover the
  relay framing/routing and backend delegation; manual browser verification is
  still required for gameplay.

## Reference PRs

The implementation used these Automattic/kandelo PRs as concept references:

- #530 — Kernel UDP host-relay abstraction
- #531 — WebRTC DataChannel relay for browser demos
- #532 — Multiplayer DOOM over WebRTC (obvious sibling of the duplicated #531)

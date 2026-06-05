import { BrowserKernel } from "@host/browser-kernel-host";
import { attachCanvas } from "@host/framebuffer/canvas-renderer";
import {
  attachLinuxMediumRawKeyboard,
  attachPointerLockMouse,
  createPcmAudioScheduler,
  type AudioOutputHandle,
  type LinuxMediumRawKeyboardHandle,
  type PointerLockMouseHandle,
} from "@host/framebuffer/browser-controls";
import {
  WebRtcDatagramRelay,
  type Ipv4Tuple,
} from "@host/networking/webrtc-relay";
import fbdoomWasmUrl from "@binaries/programs/wasm32/fbdoom.wasm?url";
import kernelWasmUrl from "@kernel-wasm?url";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const PROBE_CHANNEL_ID = 0;
const DOOM_CHANNEL_ID = 1;
const SHAREWARE_WAD_URL = "https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad";
const SHAREWARE_WAD_SHA256 = "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771";
const WAD_CACHE_NAME = "kandelo-doom-shareware-v1";
const WAD_VFS_PATH = "/doom1.wad";
const DOOM_PORT = 5029;

type Role = "host" | "join";
type SessionState = "idle" | "awaiting-answer" | "connecting" | "connected" | "running" | "exited" | "failed";

interface GameSession {
  cleanup(): Promise<void>;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const els = {
  localSdp: $("local-sdp") as HTMLTextAreaElement,
  remoteSdp: $("remote-sdp") as HTMLTextAreaElement,
  copyLocal: $("copy-local") as HTMLButtonElement,
  createOffer: $("create-offer") as HTMLButtonElement,
  acceptOffer: $("accept-offer") as HTMLButtonElement,
  acceptAnswer: $("accept-answer") as HTMLButtonElement,
  reset: $("reset") as HTMLButtonElement,
  startDoom: $("start-doom") as HTMLButtonElement,
  status: $("status") as HTMLPreElement,
  canvas: $("fb") as HTMLCanvasElement,
  captureState: $("capture-state") as HTMLSpanElement,
};

let pc: RTCPeerConnection | null = null;
let probeChannel: RTCDataChannel | null = null;
let doomChannel: RTCDataChannel | null = null;
let relay: WebRtcDatagramRelay | null = null;
let gameSession: GameSession | null = null;
let state: SessionState = "idle";
let pingTimer: number | null = null;
let lastRttMs: number | null = null;
let candidatePair: { local: string; remote: string } | null = null;
let bootLine: string | null = null;

function currentRole(): Role {
  const checked = document.querySelector<HTMLInputElement>('input[name="role"]:checked');
  return (checked?.value as Role | undefined) ?? "host";
}

function addressForRole(role: Role): { local: Ipv4Tuple; peer: Ipv4Tuple } {
  return role === "host"
    ? { local: [10, 99, 0, 1], peer: [10, 99, 0, 2] }
    : { local: [10, 99, 0, 2], peer: [10, 99, 0, 1] };
}

function channelsOpen(): boolean {
  return probeChannel?.readyState === "open" && doomChannel?.readyState === "open";
}

function setState(next: SessionState): void {
  state = next;
  updateControls();
  renderStatus();
}

function updateControls(): void {
  els.createOffer.disabled = state !== "idle";
  els.acceptOffer.disabled = state !== "idle";
  els.acceptAnswer.disabled = state !== "awaiting-answer";
  els.reset.disabled = state === "idle";
  els.startDoom.disabled = !(state === "connected" && channelsOpen());
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="role"]')) {
    radio.disabled = state !== "idle";
  }
}

function renderStatus(): void {
  const { local, peer } = addressForRole(currentRole());
  const lines = [
    `state:                ${state}`,
    `role:                 ${currentRole()}`,
    `local Kandelo IP:     ${local.join(".")}`,
    `peer Kandelo IP:      ${peer.join(".")}`,
    `STUN servers:         ${ICE_SERVERS.map((s) => String(s.urls)).join(", ")}`,
  ];
  if (pc) {
    lines.push(`connectionState:      ${pc.connectionState}`);
    lines.push(`iceConnectionState:   ${pc.iceConnectionState}`);
    lines.push(`iceGatheringState:    ${pc.iceGatheringState}`);
  }
  if (candidatePair) {
    lines.push(`active candidate:     ${candidatePair.local} ↔ ${candidatePair.remote}`);
  }
  if (probeChannel) lines.push(`probe channel:        ${probeChannel.readyState}`);
  if (doomChannel) lines.push(`doom channel:         ${doomChannel.readyState}`);
  if (lastRttMs !== null) lines.push(`probe RTT:            ${lastRttMs} ms`);
  if (bootLine) lines.push(`boot:                 ${bootLine}`);
  els.status.textContent = lines.join("\n");
}

function setupPeerConnection(): RTCPeerConnection {
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  probeChannel = conn.createDataChannel("probe", { negotiated: true, id: PROBE_CHANNEL_ID });
  doomChannel = conn.createDataChannel("doom-udp", {
    negotiated: true,
    id: DOOM_CHANNEL_ID,
    ordered: false,
    maxRetransmits: 0,
  });
  wireProbeChannel(probeChannel);
  wireDoomChannel(doomChannel);

  conn.addEventListener("connectionstatechange", () => {
    if (conn.connectionState === "connected") {
      setState("connected");
      void refreshCandidatePair();
      startPingPong();
    } else if (conn.connectionState === "failed" || conn.connectionState === "disconnected") {
      stopPingPong();
      if (state !== "idle" && state !== "exited") setState("failed");
    } else {
      renderStatus();
    }
  });
  conn.addEventListener("iceconnectionstatechange", renderStatus);
  conn.addEventListener("icegatheringstatechange", renderStatus);
  return conn;
}

function wireProbeChannel(channel: RTCDataChannel): void {
  channel.addEventListener("open", () => {
    updateControls();
    renderStatus();
  });
  channel.addEventListener("close", () => {
    stopPingPong();
    updateControls();
    renderStatus();
  });
  channel.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    try {
      const msg = JSON.parse(event.data) as { type?: string; ts?: number };
      if (msg.type === "ping" && typeof msg.ts === "number") {
        channel.send(JSON.stringify({ type: "pong", ts: msg.ts }));
      } else if (msg.type === "pong" && typeof msg.ts === "number") {
        lastRttMs = Date.now() - msg.ts;
        renderStatus();
      }
    } catch {
      // Ignore malformed probe messages; the game channel is separate.
    }
  });
}

function wireDoomChannel(channel: RTCDataChannel): void {
  channel.binaryType = "arraybuffer";
  channel.addEventListener("open", () => {
    updateControls();
    renderStatus();
  });
  channel.addEventListener("close", () => {
    updateControls();
    renderStatus();
  });
}

function startPingPong(): void {
  stopPingPong();
  pingTimer = window.setInterval(() => {
    if (probeChannel?.readyState === "open") {
      probeChannel.send(JSON.stringify({ type: "ping", ts: Date.now() }));
    }
  }, 1000);
}

function stopPingPong(): void {
  if (pingTimer !== null) {
    window.clearInterval(pingTimer);
    pingTimer = null;
  }
}

function gatheringComplete(conn: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (conn.iceGatheringState === "complete") {
      resolve();
      return;
    }
    const timeout = window.setTimeout(done, 10000);
    function done() {
      window.clearTimeout(timeout);
      conn.removeEventListener("icegatheringstatechange", check);
      resolve();
    }
    function check() {
      if (conn.iceGatheringState === "complete") done();
    }
    conn.addEventListener("icegatheringstatechange", check);
  });
}

type CandidateStats = { candidateType?: string };

async function refreshCandidatePair(): Promise<void> {
  if (!pc) return;
  const stats = (await pc.getStats()) as unknown as Map<string, RTCStats>;
  let selected: RTCIceCandidatePairStats | null = null;
  for (const stat of stats.values()) {
    if (stat.type !== "candidate-pair") continue;
    const pair = stat as RTCIceCandidatePairStats;
    if (pair.state !== "succeeded") continue;
    if (pair.nominated) {
      selected = pair;
      break;
    }
    selected ??= pair;
  }
  if (!selected) return;
  const local = stats.get(selected.localCandidateId) as CandidateStats | undefined;
  const remote = stats.get(selected.remoteCandidateId) as CandidateStats | undefined;
  if (!local || !remote) return;
  candidatePair = { local: local.candidateType ?? "unknown", remote: remote.candidateType ?? "unknown" };
  renderStatus();
}

async function createOffer(): Promise<void> {
  resetSession();
  pc = setupPeerConnection();
  setState("awaiting-answer");
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await gatheringComplete(pc);
    els.localSdp.value = JSON.stringify(pc.localDescription);
  } catch (error) {
    console.error("createOffer failed", error);
    setState("failed");
  }
}

async function acceptOffer(): Promise<void> {
  const remote = parseRemoteDescription();
  if (!remote) return;
  resetSession();
  pc = setupPeerConnection();
  setState("connecting");
  try {
    await pc.setRemoteDescription(remote);
    await pc.setLocalDescription(await pc.createAnswer());
    await gatheringComplete(pc);
    els.localSdp.value = JSON.stringify(pc.localDescription);
  } catch (error) {
    console.error("acceptOffer failed", error);
    setState("failed");
  }
}

async function acceptAnswer(): Promise<void> {
  if (!pc) return;
  const remote = parseRemoteDescription();
  if (!remote) return;
  setState("connecting");
  try {
    await pc.setRemoteDescription(remote);
  } catch (error) {
    console.error("acceptAnswer failed", error);
    setState("failed");
  }
}

function parseRemoteDescription(): RTCSessionDescriptionInit | null {
  const text = els.remoteSdp.value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as RTCSessionDescriptionInit;
  } catch {
    bootLine = "Remote SDP is not valid JSON";
    renderStatus();
    return null;
  }
}

function resetSession(): void {
  stopPingPong();
  relay?.close();
  relay = null;
  doomChannel?.close();
  probeChannel?.close();
  pc?.close();
  pc = null;
  doomChannel = null;
  probeChannel = null;
  candidatePair = null;
  lastRttMs = null;
  bootLine = null;
  if (gameSession) {
    const session = gameSession;
    gameSession = null;
    void session.cleanup();
  }
  els.canvas.removeAttribute("data-captured");
  els.captureState.textContent = "waiting";
}

function resetAll(): void {
  resetSession();
  els.localSdp.value = "";
  els.remoteSdp.value = "";
  setState("idle");
}

async function copyLocalSdp(): Promise<void> {
  if (!els.localSdp.value) return;
  await navigator.clipboard.writeText(els.localSdp.value).catch(() => {
    els.localSdp.select();
    document.execCommand("copy");
  });
}

function arrayBufferBackedCopy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function wadFetchUrl(): string {
  if (!import.meta.env.DEV) return SHAREWARE_WAD_URL;
  const url = new URL(`${import.meta.env.BASE_URL}__kandelo_cors_proxy`, window.location.href);
  url.searchParams.set("url", SHAREWARE_WAD_URL);
  return url.href;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", arrayBufferBackedCopy(bytes));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyWad(bytes: Uint8Array): Promise<void> {
  const hex = await sha256Hex(bytes);
  if (hex !== SHAREWARE_WAD_SHA256) {
    throw new Error(`doom1.wad sha256 mismatch: expected ${SHAREWARE_WAD_SHA256}, got ${hex}`);
  }
}

async function loadSharewareWad(): Promise<Uint8Array> {
  const cache = await caches.open(WAD_CACHE_NAME);
  const cached = await cache.match(SHAREWARE_WAD_URL);
  if (cached) {
    bootLine = "Loading cached shareware IWAD";
    renderStatus();
    const bytes = new Uint8Array(await cached.arrayBuffer());
    try {
      await verifyWad(bytes);
      return bytes;
    } catch {
      await cache.delete(SHAREWARE_WAD_URL);
    }
  }

  bootLine = "Downloading shareware IWAD (~4 MiB)";
  renderStatus();
  const response = await fetch(wadFetchUrl());
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching doom1.wad`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  bootLine = "Verifying shareware IWAD";
  renderStatus();
  await verifyWad(bytes);
  await cache.put(SHAREWARE_WAD_URL, new Response(arrayBufferBackedCopy(bytes), {
    headers: { "Content-Type": "application/x-doom", "Content-Length": String(bytes.byteLength) },
  }));
  return bytes;
}

async function startDoom(): Promise<void> {
  if (state !== "connected" || !doomChannel || doomChannel.readyState !== "open") return;
  setState("running");
  els.startDoom.disabled = true;

  const role = currentRole();
  const { local, peer } = addressForRole(role);
  const kernel = new BrowserKernel({
    enableUdpRelay: true,
    onStdout: (data) => console.log("[doom-mp stdout]", new TextDecoder().decode(data)),
    onStderr: (data) => console.warn("[doom-mp stderr]", new TextDecoder().decode(data)),
  });

  let stopFramebuffer: (() => void) | null = null;
  let keyboard: LinuxMediumRawKeyboardHandle | null = null;
  let mouse: PointerLockMouseHandle | null = null;
  let audio: AudioOutputHandle | null = null;

  try {
    bootLine = "Booting Kandelo kernel";
    renderStatus();
    const kernelBytes = await fetch(kernelWasmUrl).then((r) => r.arrayBuffer());
    await kernel.init(kernelBytes);

    const wadBytes = await loadSharewareWad();
    bootLine = "Installing shareware IWAD";
    renderStatus();
    kernel.fs.createFileWithOwner(WAD_VFS_PATH, 0o444, 0, 0, wadBytes);

    bootLine = "Loading fbDOOM";
    renderStatus();
    const fbdoomBytes = await fetch(fbdoomWasmUrl).then((r) => r.arrayBuffer());

    const expectedPid = kernel.nextPid;
    relay = new WebRtcDatagramRelay({
      kernel,
      channel: doomChannel,
      localAddr: local,
      peerAddr: peer,
      label: `doom-mp-${role}`,
    });
    relay.setTargetPid(expectedPid);

    stopFramebuffer = attachCanvas(els.canvas, kernel.framebuffers, expectedPid, {
      getProcessMemory: (pid) => kernel.getProcessMemory(pid),
    });
    keyboard = attachLinuxMediumRawKeyboard(
      els.canvas,
      { sendInput: (bytes) => kernel.appendStdinData(expectedPid, bytes) },
      {
        getEnabled: () => state === "running",
        onReleaseCapture: () => els.canvas.blur(),
        releaseDelayMs: 16,
      },
    );
    mouse = attachPointerLockMouse(
      els.canvas,
      { injectMouseEvent: (dx, dy, buttons) => kernel.injectMouseEvent(dx, dy, buttons) },
      {
        getEnabled: () => state === "running",
        onCaptureChange: (captured) => {
          els.canvas.toggleAttribute("data-captured", captured);
          els.captureState.textContent = captured ? "mouse locked" : "click to capture";
        },
      },
    );
    audio = createPcmAudioScheduler(kernel);
    await audio.resume();

    const argv = role === "host"
      ? [
          "fbdoom", "-iwad", WAD_VFS_PATH,
          "-server", "-privateserver",
          "-deathmatch", "-warp", "1", "1",
        ]
      : [
          "fbdoom", "-iwad", WAD_VFS_PATH,
          "-connect", `${peer.join(".")}:${DOOM_PORT}`,
          "-deathmatch", "-warp", "1", "1",
        ];

    bootLine = `Starting ${argv.join(" ")}`;
    renderStatus();
    const exitPromise = kernel.spawn(fbdoomBytes, argv, {
      env: ["HOME=/home/user", "TERM=linux"],
      cwd: "/home/user",
    });

    gameSession = {
      cleanup: async () => {
        audio?.close();
        mouse?.close();
        keyboard?.close();
        stopFramebuffer?.();
        relay?.close();
        if (relay) relay = null;
        await kernel.destroy().catch((error) => console.warn("[doom-mp] kernel destroy failed", error));
      },
    };

    els.canvas.focus();
    exitPromise.then((exitStatus) => {
      bootLine = `fbDOOM exited with status ${exitStatus}`;
      setState("exited");
    }).catch((error) => {
      bootLine = error instanceof Error ? error.message : String(error);
      setState("failed");
    }).finally(() => {
      audio?.close();
    });
  } catch (error) {
    bootLine = error instanceof Error ? error.message : String(error);
    console.error("startDoom failed", error);
    audio?.close();
    mouse?.close();
    keyboard?.close();
    stopFramebuffer?.();
    relay?.close();
    relay = null;
    await kernel.destroy().catch(() => {});
    setState("failed");
  }
}

els.createOffer.addEventListener("click", () => void createOffer());
els.acceptOffer.addEventListener("click", () => void acceptOffer());
els.acceptAnswer.addEventListener("click", () => void acceptAnswer());
els.copyLocal.addEventListener("click", () => void copyLocalSdp());
els.reset.addEventListener("click", resetAll);
els.startDoom.addEventListener("click", () => void startDoom());
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="role"]')) {
  radio.addEventListener("change", renderStatus);
}

setState("idle");

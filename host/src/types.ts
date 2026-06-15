export interface KernelConfig {
  maxWorkers: number;
  dataBufferSize: number;
  useSharedMemory: boolean;
  /** Host default pthread slots when process wasm declares -1. */
  defaultThreadSlots?: number;
  /** Log every syscall with decoded args and return values to stderr */
  enableSyscallLog?: boolean;
  /** Log syscalls only for processes with this ptrWidth (4 or 8). Useful when
   *  one wasm64 process in a multi-process demo is misbehaving and the rest
   *  are wasm32 — enabling enableSyscallLog drowns the trace in unrelated
   *  syscalls. */
  syscallLogPtrWidth?: 4 | 8;
}

export interface StatResult {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  size: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface StatfsResult {
  type: number;
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
  files: number;
  ffree: number;
  fsid: number;
  namelen: number;
  frsize: number;
  flags: number;
}

export interface PlatformIO {
  /**
   * Optional byte-preserving POSIX path entry points.
   *
   * POSIX paths are byte strings. Most in-memory/browser backends currently
   * model paths as UTF-8 strings, but raw Node host-fs backends can preserve
   * exact bytes here and avoid host Unicode filename restrictions leaking into
   * guest semantics.
   */
  openBytes?(path: Uint8Array, flags: number, mode: number): number;
  open(path: string, flags: number, mode: number): number;
  close(handle: number): number;
  read(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number;
  write(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number;
  seek(handle: number, offset: number, whence: number): number;
  fstat(handle: number): StatResult;

  // Path-based operations
  statBytes?(path: Uint8Array): StatResult;
  stat(path: string): StatResult;
  lstatBytes?(path: Uint8Array): StatResult;
  lstat(path: string): StatResult;
  statfsBytes?(path: Uint8Array): StatfsResult;
  statfs(path: string): StatfsResult;
  mkdirBytes?(path: Uint8Array, mode: number): void;
  mkdir(path: string, mode: number): void;
  rmdirBytes?(path: Uint8Array): void;
  rmdir(path: string): void;
  unlinkBytes?(path: Uint8Array): void;
  unlink(path: string): void;
  renameBytes?(oldPath: Uint8Array, newPath: Uint8Array): void;
  rename(oldPath: string, newPath: string): void;
  linkBytes?(existingPath: Uint8Array, newPath: Uint8Array): void;
  link(existingPath: string, newPath: string): void;
  symlinkBytes?(target: Uint8Array, path: Uint8Array): void;
  symlink(target: string, path: string): void;
  readlinkBytes?(path: Uint8Array): string;
  readlink(path: string): string;
  chmodBytes?(path: Uint8Array, mode: number): void;
  chmod(path: string, mode: number): void;
  chownBytes?(path: Uint8Array, uid: number, gid: number): void;
  chown(path: string, uid: number, gid: number): void;
  accessBytes?(path: Uint8Array, mode: number): void;
  access(path: string, mode: number): void;
  utimensatBytes?(path: Uint8Array, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void;
  utimensat(path: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void;

  // Directory iteration
  opendirBytes?(path: Uint8Array): number;
  opendir(path: string): number;
  readdir(
    handle: number,
  ): { name: string; type: number; ino: number; nameBytes?: Uint8Array } | null;
  closedir(handle: number): void;

  // File operations
  ftruncate(handle: number, length: number): void;
  fsync(handle: number): void;
  fchmod(handle: number, mode: number): void;
  fchown(handle: number, uid: number, gid: number): void;

  // Time
  clockGettime(clockId: number): { sec: number; nsec: number };
  nanosleep(sec: number, nsec: number): void;

  // Process (optional — only needed when process management is available)
  waitpid?(pid: number, options: number): { pid: number; status: number };

  // Networking (optional — only needed for AF_INET support)
  network?: NetworkIO;
}

export interface NetworkAddress {
  addr: Uint8Array;
  port: number;
}

export interface TcpConnectionPeer {
  send(data: Uint8Array, flags: number): number;
  recv(maxLen: number, flags: number): Uint8Array;
  poll?(events: number): number;
  shutdown(how: number): void;
  close(): void;
  abort?(): void;
}

export interface TcpListenTarget {
  accept(peer: TcpConnectionPeer, local: NetworkAddress, remote: NetworkAddress): number;
}

export interface UdpDatagram {
  srcAddr: Uint8Array;
  srcPort: number;
  dstAddr: Uint8Array;
  dstPort: number;
  data: Uint8Array;
}

export interface UdpReceiveTarget {
  receive(datagram: UdpDatagram): number;
}

export interface NetworkIO {
  /** IPv4 address owned by this guest network stack, when known. */
  readonly localAddress?: Uint8Array;
  connect(handle: number, addr: Uint8Array, port: number): void;
  /** 0 = connected, positive errno = failed, -11 = still pending (EAGAIN). */
  connectStatus(handle: number): number;
  send(handle: number, data: Uint8Array, flags: number): number;
  recv(handle: number, maxLen: number, flags: number): Uint8Array;
  /** Return POSIX poll revents bits for this connection handle. */
  poll?(handle: number, events: number): number;
  close(handle: number): void;
  getaddrinfo(hostname: string): Uint8Array; // Returns 4-byte IPv4
  listenTcp?(listenerId: string, addr: Uint8Array, port: number, target: TcpListenTarget): number;
  closeTcpListener?(listenerId: string): void;
  bindUdp?(endpointId: string, addr: Uint8Array, port: number, target: UdpReceiveTarget): number;
  unbindUdp?(endpointId: string): void;
  sendDatagram?(datagram: UdpDatagram): number;
}

/**
 * Node.js platform I/O backend.
 *
 * Implements the PlatformIO interface using synchronous Node.js `fs`
 * operations. Synchronous methods are used because the kernel runs in
 * a Wasm import context which requires blocking, synchronous behavior.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlatformIO, StatResult, StatfsResult } from "../types";
import { nativeStatfs, translateOpenFlags } from "../vfs/host-fs";
import { NativeMetadataOverlay } from "./native-metadata";

const POSIX_BYTES_SEGMENT_PREFIX = ".kandelo-posix-bytes-";
const PATH_DISPLAY_DECODER = new TextDecoder("utf-8", { fatal: false });
const ASCII_DEV_SHM = new TextEncoder().encode("/dev/shm");
const UTIME_NOW = 0x3fffffff;
const UTIME_OMIT = 0x3ffffffe;

function pathBytesToDisplay(bytes: Uint8Array): string {
  return PATH_DISPLAY_DECODER.decode(bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function makeFsError(code: string, message: string): Error & { code: string } {
  const err = new Error(`${code}: ${message}`) as Error & { code: string };
  err.code = code;
  return err;
}

function bytesStartWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.byteLength < prefix.byteLength) return false;
  for (let i = 0; i < prefix.byteLength; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

export class NodePlatformIO implements PlatformIO {
  private dirHandles = new Map<number, fs.Dir>();
  private nextDirHandle = 1;
  private fdPositions = new Map<number, number>();
  private fdPaths = new Map<number, string>();
  // Offset from hrtime (monotonic) to epoch, computed once at startup.
  private readonly _epochOffsetNs: bigint;
  // hrtime at creation, used as process start for CPUTIME clocks.
  private readonly _startNs: bigint;
  // /dev/shm replacement directory (macOS has no /dev/shm)
  private readonly _shmDir: string;
  private readonly metadata = new NativeMetadataOverlay();

  constructor() {
    const hrt = process.hrtime.bigint();
    const wallNs = BigInt(Date.now()) * 1_000_000n;
    this._epochOffsetNs = wallNs - hrt;
    this._startNs = hrt;
    this._shmDir = path.join(os.tmpdir(), "wasm-posix-shm");
  }

  /**
   * Adapt POSIX-shaped kernel paths to whatever Node `fs.*` understands
   * on the host. Two translations live here:
   *
   *   - `/dev/shm/...` → tmpdir-backed dir (macOS has no `/dev/shm`).
   *   - On Windows: `/<letter>/...` → `<letter>:/...`. The kernel is
   *     POSIX; user programs (musl-libc nginx, php-fpm) reject paths
   *     that don't start with `/` as relative. Callers shape Windows
   *     host paths as `/C/Users/...` (matching `@php-wasm/util`'s
   *     `toPosixPath`); we reverse it here before handing the value
   *     to Node `fs.*`.
   */
  private rewritePath(p: string): string {
    if (p.startsWith("/dev/shm/") || p === "/dev/shm") {
      const rel = p.slice("/dev/shm".length); // "" or "/foo"
      const target = this._shmDir + rel;
      // Ensure the shm directory exists on first use
      fs.mkdirSync(this._shmDir, { recursive: true });
      return target;
    }
    if (process.platform === "win32") {
      const winPath = translateWindowsDrivePath(p);
      if (winPath !== null) return winPath;
    }
    return p;
  }

  private nativePathFromBytes(bytes: Uint8Array): string {
    if (bytes.byteLength === 0) return "";
    if (bytes.includes(0)) {
      throw makeFsError("EINVAL", "path contains NUL byte");
    }

    const absolute = bytes[0] === 47; // '/'
    const parts: string[] = [];
    let start = absolute ? 1 : 0;
    for (let i = start; i <= bytes.byteLength; i++) {
      if (i !== bytes.byteLength && bytes[i] !== 47) continue;
      const segment = bytes.subarray(start, i);
      if (segment.byteLength > 0) {
        parts.push(this.nativeSegmentFromBytes(segment));
      }
      start = i + 1;
    }

    let nativePath = (absolute ? "/" : "") + parts.join("/");
    if (bytes.byteLength > 1 && bytes[bytes.byteLength - 1] === 47 && nativePath !== "/") {
      nativePath += "/";
    }
    return nativePath || (absolute ? "/" : ".");
  }

  private nativeSegmentFromBytes(segment: Uint8Array): string {
    let ascii = "";
    for (const byte of segment) {
      if (byte < 0x20 || byte >= 0x7f || byte === 47) {
        return POSIX_BYTES_SEGMENT_PREFIX + bytesToHex(segment);
      }
      ascii += String.fromCharCode(byte);
    }
    if (ascii.startsWith(POSIX_BYTES_SEGMENT_PREFIX)) {
      return POSIX_BYTES_SEGMENT_PREFIX + bytesToHex(segment);
    }
    return ascii;
  }

  private rewritePathBytes(bytes: Uint8Array): string {
    if (
      bytes.byteLength === ASCII_DEV_SHM.byteLength
      && bytesStartWith(bytes, ASCII_DEV_SHM)
    ) {
      fs.mkdirSync(this._shmDir, { recursive: true });
      return this._shmDir;
    }
    if (
      bytes.byteLength > ASCII_DEV_SHM.byteLength
      && bytes[ASCII_DEV_SHM.byteLength] === 47
      && bytesStartWith(bytes, ASCII_DEV_SHM)
    ) {
      fs.mkdirSync(this._shmDir, { recursive: true });
      const rel = this.nativePathFromBytes(bytes.subarray(ASCII_DEV_SHM.byteLength));
      return this._shmDir + rel;
    }

    if (process.platform === "win32") {
      const display = pathBytesToDisplay(bytes);
      const winPath = translateWindowsDrivePath(display);
      if (winPath !== null) return winPath;
    }
    return this.nativePathFromBytes(bytes);
  }

  private decodeNativeEntryName(name: string): { name: string; nameBytes?: Uint8Array } {
    if (!name.startsWith(POSIX_BYTES_SEGMENT_PREFIX)) {
      return { name };
    }
    const bytes = hexToBytes(name.slice(POSIX_BYTES_SEGMENT_PREFIX.length));
    if (!bytes) return { name };
    return { name: pathBytesToDisplay(bytes), nameBytes: bytes };
  }

  private sqliteFsTraceEnabled(): boolean {
    return process.env.KERNEL_SQLITE_FS_TRACE === "1";
  }

  private isSqliteTracePath(p: string | undefined): boolean {
    if (!p) return false;
    return /(^|\/)(testrunner\.db(?:-(?:wal|shm))?|test\.db(?:-(?:journal|wal|shm|lock))?|test-[0-9a-f]+\.db(?:-(?:journal|wal|shm|lock))?)$/.test(p);
  }

  private bytesAllZero(bytes: Uint8Array, start: number, len: number): boolean {
    if (start < 0 || len < 0 || start + len > bytes.byteLength) return false;
    for (let i = 0; i < len; i++) {
      if (bytes[start + i] !== 0) return false;
    }
    return true;
  }

  private traceStorageIo(op: string, message: string): void {
    if (this.sqliteFsTraceEnabled()) {
      console.error(`[KERNEL_SQLITE_FS_TRACE storage] ${op} ${message}`);
    }
  }

  private traceWriteIfNeeded(
    handle: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    bytesWritten: number,
  ): void {
    const pathForFd = this.fdPaths.get(handle);
    if (!this.isSqliteTracePath(pathForFd)) return;

    const sampleLen = Math.min(buffer.byteLength, Math.max(0, Math.min(length, bytesWritten)));
    const allZero = sampleLen > 0 && this.bytesAllZero(buffer, 0, sampleLen);
    const first = Array.from(buffer.subarray(0, Math.min(16, length)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    this.traceStorageIo(
      "write",
      `fd=${handle} path=${pathForFd} offset=${offset} len=${length} wrote=${bytesWritten} first16=${first} all_zero=${allZero}`,
    );
  }

  openBytes(pathBytes: Uint8Array, flags: number, mode: number): number {
    return this.openNative(this.rewritePathBytes(pathBytes), pathBytesToDisplay(pathBytes), flags, mode);
  }

  open(path: string, flags: number, mode: number): number {
    return this.openNative(this.rewritePath(path), path, flags, mode);
  }

  private openNative(nativePath: string, displayPath: string, flags: number, mode: number): number {
    const created = (flags & 0o100) !== 0 && !fs.existsSync(nativePath);
    const fd = fs.openSync(nativePath, translateOpenFlags(flags), mode);
    if (created) this.metadata.chmod(fs.fstatSync(fd), mode);
    this.fdPositions.set(fd, 0);
    this.fdPaths.set(fd, displayPath);
    if (this.isSqliteTracePath(displayPath)) {
      this.traceStorageIo(
        "open",
        `fd=${fd} path=${displayPath} native=${nativePath} flags=0o${(flags >>> 0).toString(8)} mode=0o${(mode >>> 0).toString(8)}`,
      );
    }
    return fd;
  }

  close(handle: number): number {
    const pathForFd = this.fdPaths.get(handle);
    if (this.isSqliteTracePath(pathForFd)) {
      this.traceStorageIo("close", `fd=${handle} path=${pathForFd}`);
    }
    fs.closeSync(handle);
    this.fdPositions.delete(handle);
    this.fdPaths.delete(handle);
    return 0;
  }

  read(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number {
    const pos = offset ?? this.fdPositions.get(handle) ?? 0;
    const bytesRead = fs.readSync(handle, buffer, 0, length, pos);
    const pathForFd = this.fdPaths.get(handle);
    if (this.isSqliteTracePath(pathForFd)) {
      this.traceStorageIo("read", `fd=${handle} path=${pathForFd} offset=${pos} len=${length} read=${bytesRead}`);
    }
    if (offset === null) {
      this.fdPositions.set(handle, pos + bytesRead);
    }
    return bytesRead;
  }

  write(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number {
    const pos = offset ?? this.fdPositions.get(handle) ?? 0;
    const bytesWritten = fs.writeSync(handle, buffer, 0, length, pos);
    this.traceWriteIfNeeded(handle, buffer, pos, length, bytesWritten);
    if (offset === null) {
      this.fdPositions.set(handle, pos + bytesWritten);
    }
    return bytesWritten;
  }

  seek(
    handle: number,
    offset: number,
    whence: number,
  ): number {
    // SEEK_SET=0, SEEK_CUR=1, SEEK_END=2
    let newPos: number;
    switch (whence) {
      case 0: // SEEK_SET
        newPos = offset;
        break;
      case 1: { // SEEK_CUR
        const cur = this.fdPositions.get(handle) ?? 0;
        newPos = cur + offset;
        break;
      }
      case 2: {
        // SEEK_END — compute from file size
        const stat = fs.fstatSync(handle);
        newPos = stat.size + offset;
        break;
      }
      default:
        throw new Error(`Invalid whence value: ${whence}`);
    }
    this.fdPositions.set(handle, newPos);
    return newPos;
  }

  // Normalize uid/gid to match Process::new's default euid (0). The
  // real macOS/Linux uid of the user running the kernel is not exposed
  // to guest programs — guest sees host-mounted files as self-owned, so
  // tools that compare ownership against their own euid (git's
  // "dubious ownership" check, nginx config ownership, etc.) see a
  // match. Same policy as HostFileSystem.
  fstat(handle: number): StatResult {
    return this.metadata.toStatResult(fs.fstatSync(handle));
  }

  statBytes(path: Uint8Array): StatResult {
    return this.metadata.toStatResult(fs.statSync(this.rewritePathBytes(path)));
  }

  stat(path: string): StatResult {
    return this.metadata.toStatResult(fs.statSync(this.rewritePath(path)));
  }

  lstatBytes(path: Uint8Array): StatResult {
    return this.metadata.toStatResult(fs.lstatSync(this.rewritePathBytes(path)));
  }

  lstat(path: string): StatResult {
    return this.metadata.toStatResult(fs.lstatSync(this.rewritePath(path)));
  }

  statfsBytes(path: Uint8Array): StatfsResult {
    return nativeStatfs(this.rewritePathBytes(path));
  }

  statfs(path: string): StatfsResult {
    return nativeStatfs(this.rewritePath(path));
  }

  mkdirBytes(path: Uint8Array, mode: number): void {
    this.mkdirNative(this.rewritePathBytes(path), mode);
  }

  mkdir(path: string, mode: number): void {
    this.mkdirNative(this.rewritePath(path), mode);
  }

  private mkdirNative(nativePath: string, mode: number): void {
    fs.mkdirSync(nativePath, { mode });
    this.metadata.chmod(fs.statSync(nativePath), mode);
  }

  rmdirBytes(path: Uint8Array): void {
    this.rmdirNative(this.rewritePathBytes(path));
  }

  rmdir(path: string): void {
    this.rmdirNative(this.rewritePath(path));
  }

  private rmdirNative(nativePath: string): void {
    const stat = fs.lstatSync(nativePath);
    fs.rmdirSync(nativePath);
    this.metadata.forget(stat);
  }

  unlinkBytes(path: Uint8Array): void {
    this.unlinkNative(this.rewritePathBytes(path));
  }

  unlink(path: string): void {
    this.unlinkNative(this.rewritePath(path));
  }

  private unlinkNative(nativePath: string): void {
    const stat = fs.lstatSync(nativePath);
    fs.unlinkSync(nativePath);
    if (stat.nlink <= 1) this.metadata.forget(stat);
  }

  renameBytes(oldPath: Uint8Array, newPath: Uint8Array): void {
    this.renameNative(this.rewritePathBytes(oldPath), this.rewritePathBytes(newPath));
  }

  rename(oldPath: string, newPath: string): void {
    this.renameNative(this.rewritePath(oldPath), this.rewritePath(newPath));
  }

  private renameNative(nativeOldPath: string, nativeNewPath: string): void {
    let replaced: fs.Stats | undefined;
    try {
      replaced = fs.lstatSync(nativeNewPath);
    } catch {}
    fs.renameSync(nativeOldPath, nativeNewPath);
    if (replaced !== undefined && replaced.nlink <= 1) this.metadata.forget(replaced);
  }

  linkBytes(existingPath: Uint8Array, newPath: Uint8Array): void {
    fs.linkSync(this.rewritePathBytes(existingPath), this.rewritePathBytes(newPath));
  }

  link(existingPath: string, newPath: string): void {
    fs.linkSync(this.rewritePath(existingPath), this.rewritePath(newPath));
  }

  symlinkBytes(target: Uint8Array, path: Uint8Array): void {
    fs.symlinkSync(this.rewritePathBytes(target), this.rewritePathBytes(path));
  }

  symlink(target: string, path: string): void {
    fs.symlinkSync(target, this.rewritePath(path));
  }

  readlinkBytes(path: Uint8Array): string {
    return fs.readlinkSync(this.rewritePathBytes(path), "utf8");
  }

  readlink(path: string): string {
    return fs.readlinkSync(this.rewritePath(path), "utf8");
  }

  chmodBytes(path: Uint8Array, mode: number): void {
    this.metadata.chmod(fs.statSync(this.rewritePathBytes(path)), mode);
  }

  chmod(path: string, mode: number): void {
    this.metadata.chmod(fs.statSync(this.rewritePath(path)), mode);
  }

  chownBytes(path: Uint8Array, uid: number, gid: number): void {
    this.metadata.chown(fs.statSync(this.rewritePathBytes(path)), uid, gid);
  }

  chown(path: string, uid: number, gid: number): void {
    this.metadata.chown(fs.statSync(this.rewritePath(path)), uid, gid);
  }

  accessBytes(path: Uint8Array, mode: number): void {
    this.metadata.access(fs.statSync(this.rewritePathBytes(path)), mode);
  }

  access(path: string, mode: number): void {
    this.metadata.access(fs.statSync(this.rewritePath(path)), mode);
  }

  utimensatBytes(path: Uint8Array, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void {
    this.utimensatNative(this.rewritePathBytes(path), atimeSec, atimeNsec, mtimeSec, mtimeNsec);
  }

  utimensat(path: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void {
    this.utimensatNative(this.rewritePath(path), atimeSec, atimeNsec, mtimeSec, mtimeNsec);
  }

  private utimensatNative(nativePath: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void {
    if (atimeNsec === UTIME_OMIT && mtimeNsec === UTIME_OMIT) return;

    const stat = fs.statSync(nativePath);
    const nowMs = Date.now();
    const atimeMs = atimeNsec === UTIME_OMIT
      ? stat.atimeMs
      : atimeNsec === UTIME_NOW
        ? nowMs
        : atimeSec * 1000 + Math.floor(atimeNsec / 1_000_000);
    const mtimeMs = mtimeNsec === UTIME_OMIT
      ? stat.mtimeMs
      : mtimeNsec === UTIME_NOW
        ? nowMs
        : mtimeSec * 1000 + Math.floor(mtimeNsec / 1_000_000);
    fs.utimesSync(nativePath, atimeMs / 1000, mtimeMs / 1000);
  }

  opendirBytes(path: Uint8Array): number {
    return this.opendirNative(this.rewritePathBytes(path));
  }

  opendir(path: string): number {
    return this.opendirNative(this.rewritePath(path));
  }

  private opendirNative(nativePath: string): number {
    const dir = fs.opendirSync(nativePath);
    const handle = this.nextDirHandle++;
    this.dirHandles.set(handle, dir);
    return handle;
  }

  readdir(
    handle: number,
  ): { name: string; type: number; ino: number } | null {
    const dir = this.dirHandles.get(handle);
    if (!dir) throw new Error("Invalid dir handle");
    const entry = dir.readSync();
    if (!entry) return null;
    // Map Dirent to d_type
    let dtype = 0; // DT_UNKNOWN
    if (entry.isFile()) dtype = 8; // DT_REG
    else if (entry.isDirectory()) dtype = 4; // DT_DIR
    else if (entry.isSymbolicLink()) dtype = 10; // DT_LNK
    else if (entry.isFIFO()) dtype = 1; // DT_FIFO
    else if (entry.isSocket()) dtype = 12; // DT_SOCK
    else if (entry.isCharacterDevice()) dtype = 2; // DT_CHR
    else if (entry.isBlockDevice()) dtype = 6; // DT_BLK
    return { ...this.decodeNativeEntryName(entry.name), type: dtype, ino: 0 };
  }

  closedir(handle: number): void {
    const dir = this.dirHandles.get(handle);
    if (!dir) throw new Error("Invalid dir handle");
    dir.closeSync();
    this.dirHandles.delete(handle);
  }

  ftruncate(handle: number, length: number): void {
    const pathForFd = this.fdPaths.get(handle);
    if (this.isSqliteTracePath(pathForFd)) {
      this.traceStorageIo("ftruncate", `fd=${handle} path=${pathForFd} length=${length}`);
    }
    fs.ftruncateSync(handle, length);
  }

  fsync(handle: number): void {
    const pathForFd = this.fdPaths.get(handle);
    if (this.isSqliteTracePath(pathForFd)) {
      this.traceStorageIo("fsync", `fd=${handle} path=${pathForFd}`);
    }
    fs.fsyncSync(handle);
  }

  fchmod(handle: number, mode: number): void {
    this.metadata.chmod(fs.fstatSync(handle), mode);
  }

  fchown(handle: number, uid: number, gid: number): void {
    this.metadata.chown(fs.fstatSync(handle), uid, gid);
  }

  clockGettime(
    clockId: number,
  ): { sec: number; nsec: number } {
    const ns = process.hrtime.bigint();
    if (clockId === 2 || clockId === 3) {
      // CLOCK_PROCESS_CPUTIME_ID / CLOCK_THREAD_CPUTIME_ID
      // Return time since process start (in Wasm, CPU ≈ elapsed)
      const elapsed = ns - this._startNs;
      return { sec: Number(elapsed / 1000000000n), nsec: Number(elapsed % 1000000000n) };
    }
    if (clockId === 1) {
      // CLOCK_MONOTONIC
      return { sec: Number(ns / 1000000000n), nsec: Number(ns % 1000000000n) };
    }
    // CLOCK_REALTIME — use hrtime + epoch offset for nanosecond resolution
    const realNs = ns + this._epochOffsetNs;
    return { sec: Number(realNs / 1000000000n), nsec: Number(realNs % 1000000000n) };
  }

  nanosleep(sec: number, nsec: number): void {
    const ms = sec * 1000 + Math.floor(nsec / 1_000_000);
    if (ms > 0) {
      const sab = new SharedArrayBuffer(4);
      const arr = new Int32Array(sab);
      Atomics.wait(arr, 0, 0, ms);
    }
  }
}

/**
 * Translate a POSIX-shaped path carrying a Windows drive prefix back
 * to native Windows form: `/C/foo` → `C:/foo`, `/C` → `C:/`.
 *
 * Returns `null` if `p` does not begin with `/<letter>` followed by
 * end-of-string or `/`. Exported for unit tests; callers should
 * gate on `process.platform === "win32"` themselves.
 *
 * Mirrors `@php-wasm/util:toPosixPath` on the CLI side.
 */
export function translateWindowsDrivePath(p: string): string | null {
  const m = p.match(/^\/([A-Za-z])(\/.*)?$/);
  if (!m) return null;
  return `${m[1]}:${m[2] ?? "/"}`;
}

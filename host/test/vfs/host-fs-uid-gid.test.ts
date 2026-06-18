import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  chmodSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostFileSystem } from "../../src/vfs/host-fs";

const UTIME_NOW = 0x3fffffff;
const UTIME_OMIT = 0x3ffffffe;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("HostFileSystem uid/gid normalization", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "wasm-posix-host-fs-uid-gid-"));
    writeFileSync(join(root, "file.txt"), "hi");
    mkdirSync(join(root, "sub"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // The host's real uid/gid (e.g. macOS user 501) must not be exposed to
  // guest programs. Programs run with Process::new's default euid=0; the
  // backend reports uid=0/gid=0 so guests see host-mounted files as
  // self-owned. This satisfies tools that compare ownership against
  // their own euid (git's "dubious ownership" check, nginx config
  // ownership, etc.) without leaking the host uid.

  it("stat returns uid=0 gid=0 regardless of host's real uid", () => {
    const hfs = new HostFileSystem(root);
    const st = hfs.stat("/file.txt");
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });

  it("lstat returns uid=0 gid=0", () => {
    const hfs = new HostFileSystem(root);
    const st = hfs.lstat("/file.txt");
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });

  it("fstat returns uid=0 gid=0", () => {
    const hfs = new HostFileSystem(root);
    const fd = hfs.open("/file.txt", 0, 0);
    try {
      const st = hfs.fstat(fd);
      expect(st.uid).toBe(0);
      expect(st.gid).toBe(0);
    } finally {
      hfs.close(fd);
    }
  });

  it("stat on a directory also normalizes", () => {
    const hfs = new HostFileSystem(root);
    const st = hfs.stat("/sub");
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });

  it("chmod updates virtual mode without changing native mode", () => {
    const nativePath = join(root, "chmod.txt");
    writeFileSync(nativePath, "hi");
    chmodSync(nativePath, 0o600);
    const nativeBefore = statSync(nativePath).mode & 0o7777;

    const hfs = new HostFileSystem(root);
    hfs.chmod("/chmod.txt", 0o751);

    expect(hfs.stat("/chmod.txt").mode & 0o7777).toBe(0o751);
    expect(statSync(nativePath).mode & 0o7777).toBe(nativeBefore);
  });

  it("chown updates virtual owner without changing native owner", () => {
    const nativePath = join(root, "chown.txt");
    writeFileSync(nativePath, "hi");
    const nativeBefore = statSync(nativePath);

    const hfs = new HostFileSystem(root);
    hfs.chown("/chown.txt", 1234, 5678);

    const virtual = hfs.stat("/chown.txt");
    const nativeAfter = statSync(nativePath);
    expect(virtual.uid).toBe(1234);
    expect(virtual.gid).toBe(5678);
    expect(nativeAfter.uid).toBe(nativeBefore.uid);
    expect(nativeAfter.gid).toBe(nativeBefore.gid);
  });

  it("fchmod and fchown update virtual metadata without native changes", () => {
    const nativePath = join(root, "fd.txt");
    writeFileSync(nativePath, "hi");
    chmodSync(nativePath, 0o600);

    const hfs = new HostFileSystem(root);
    const fd = hfs.open("/fd.txt", 0, 0);
    try {
      const nativeBefore = fstatSync(fd);
      hfs.fchmod(fd, 0o700);
      hfs.fchown(fd, 2222, 3333);

      const virtual = hfs.fstat(fd);
      const nativeAfter = fstatSync(fd);
      expect(virtual.mode & 0o7777).toBe(0o700);
      expect(virtual.uid).toBe(2222);
      expect(virtual.gid).toBe(3333);
      expect(nativeAfter.mode & 0o7777).toBe(nativeBefore.mode & 0o7777);
      expect(nativeAfter.uid).toBe(nativeBefore.uid);
      expect(nativeAfter.gid).toBe(nativeBefore.gid);
    } finally {
      hfs.close(fd);
    }
  });

  it("allows mknod-style callers to overlay a FIFO file type", () => {
    const nativePath = join(root, "fifo-overlay");
    writeFileSync(nativePath, "");

    const hfs = new HostFileSystem(root);
    const fd = hfs.open("/fifo-overlay", 0, 0);
    try {
      hfs.fchmod(fd, 0o010000 | 0o755);
      expect(hfs.fstat(fd).mode & 0o170000).toBe(0o010000);
      expect(hfs.stat("/fifo-overlay").mode & 0o170000).toBe(0o010000);

      hfs.fchmod(fd, 0o600);
      const afterChmod = hfs.stat("/fifo-overlay");
      expect(afterChmod.mode & 0o170000).toBe(0o010000);
      expect(afterChmod.mode & 0o7777).toBe(0o600);
      expect(fstatSync(fd).isFile()).toBe(true);
    } finally {
      hfs.close(fd);
    }
  });

  it("reports native ctime changes after a virtual chmod overlay exists", async () => {
    const hfs = new HostFileSystem(root);
    const dir = "/ctime-dir";
    const nativeDir = join(root, "ctime-dir");
    rmSync(nativeDir, { recursive: true, force: true });
    hfs.mkdir(dir, 0o755);

    const before = hfs.stat(dir);
    await delay(25);
    hfs.utimensat(dir, 0, UTIME_OMIT, 12_345, 0);
    const after = hfs.stat(dir);

    expect(after.atimeMs).toBe(before.atimeMs);
    expect(Math.floor(after.mtimeMs / 1000)).toBe(12_345);
    expect(after.ctimeMs).toBeGreaterThan(before.ctimeMs);
  });

  it("honors UTIME_NOW while preserving virtual mode metadata", async () => {
    const nativePath = join(root, "utime-now.txt");
    writeFileSync(nativePath, "hi");
    const hfs = new HostFileSystem(root);
    hfs.chmod("/utime-now.txt", 0o751);
    const before = hfs.stat("/utime-now.txt");

    await delay(25);
    hfs.utimensat("/utime-now.txt", 0, UTIME_OMIT, 0, UTIME_NOW);
    const after = hfs.stat("/utime-now.txt");

    expect(after.mode & 0o7777).toBe(0o751);
    expect(after.atimeMs).toBe(before.atimeMs);
    expect(after.mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs);
    expect(after.ctimeMs).toBeGreaterThan(before.ctimeMs);
  });

  it("invalidates cached directory resolution when directories move", () => {
    const nativeDir = join(root, "cached-dir");
    const nativeMoved = join(root, "cached-dir-moved");
    rmSync(nativeDir, { recursive: true, force: true });
    rmSync(nativeMoved, { recursive: true, force: true });
    mkdirSync(nativeDir);
    writeFileSync(join(nativeDir, "file.txt"), "hi");

    const hfs = new HostFileSystem(root);
    expect(hfs.stat("/cached-dir/file.txt").size).toBe(2);
    hfs.rename("/cached-dir", "/cached-dir-moved");

    expect(() => hfs.stat("/cached-dir/file.txt")).toThrow();
    expect(hfs.stat("/cached-dir-moved/file.txt").size).toBe(2);
  });

  it("does not cache symlink resolution across symlink replacement", () => {
    const nativeA = join(root, "symlink-a");
    const nativeB = join(root, "symlink-b");
    const nativeLink = join(root, "symlink-current");
    rmSync(nativeA, { recursive: true, force: true });
    rmSync(nativeB, { recursive: true, force: true });
    rmSync(nativeLink, { force: true });
    mkdirSync(nativeA);
    mkdirSync(nativeB);
    writeFileSync(join(nativeA, "file.txt"), "a");
    writeFileSync(join(nativeB, "file.txt"), "bb");
    symlinkSync("symlink-a", nativeLink);

    const hfs = new HostFileSystem(root);
    expect(hfs.stat("/symlink-current/file.txt").size).toBe(1);
    hfs.unlink("/symlink-current");
    symlinkSync("symlink-b", nativeLink);

    expect(hfs.stat("/symlink-current/file.txt").size).toBe(2);
  });
});

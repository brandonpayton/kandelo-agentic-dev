import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { HostFileSystem } from "../src/vfs/host-fs";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { NodeTimeProvider } from "../src/vfs/time";
import type { FileSystemBackend, MountConfig } from "../src/vfs/types";
import type { StatResult, StatfsResult } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBackend(): FileSystemBackend & { calls: string[] } {
  const calls: string[] = [];
  const dummyStat: StatResult = {
    dev: 0,
    ino: 0,
    mode: 0,
    nlink: 0,
    uid: 0,
    gid: 0,
    size: 0,
    atimeMs: 0,
    mtimeMs: 0,
    ctimeMs: 0,
  };
  const dummyStatfs: StatfsResult = {
    type: 0,
    bsize: 4096,
    blocks: 0,
    bfree: 0,
    bavail: 0,
    files: 0,
    ffree: 0,
    fsid: 0,
    namelen: 255,
    frsize: 4096,
    flags: 0,
  };
  return {
    calls,
    open: (path, flags, mode) => {
      calls.push(`open:${path}`);
      return 1;
    },
    close: (h) => {
      calls.push(`close:${h}`);
      return 0;
    },
    read: (h, buf, off, len) => {
      calls.push(`read:${h}`);
      return 0;
    },
    write: (h, buf, off, len) => {
      calls.push(`write:${h}`);
      return 0;
    },
    seek: (h, off, w) => {
      calls.push(`seek:${h}`);
      return 0;
    },
    fstat: (h) => {
      calls.push(`fstat:${h}`);
      return { ...dummyStat };
    },
    ftruncate: (h, l) => {
      calls.push(`ftruncate:${h}`);
    },
    fsync: (h) => {
      calls.push(`fsync:${h}`);
    },
    fchmod: (h, m) => {
      calls.push(`fchmod:${h}`);
    },
    fchown: (h, u, g) => {
      calls.push(`fchown:${h}`);
    },
    stat: (p) => {
      calls.push(`stat:${p}`);
      return { ...dummyStat };
    },
    lstat: (p) => {
      calls.push(`lstat:${p}`);
      return { ...dummyStat };
    },
    statfs: (p) => {
      calls.push(`statfs:${p}`);
      return { ...dummyStatfs };
    },
    mkdir: (p, m) => {
      calls.push(`mkdir:${p}`);
    },
    rmdir: (p) => {
      calls.push(`rmdir:${p}`);
    },
    unlink: (p) => {
      calls.push(`unlink:${p}`);
    },
    rename: (o, n) => {
      calls.push(`rename:${o}:${n}`);
    },
    link: (e, n) => {
      calls.push(`link:${e}:${n}`);
    },
    symlink: (t, p) => {
      calls.push(`symlink:${t}:${p}`);
    },
    readlink: (p) => {
      calls.push(`readlink:${p}`);
      return "";
    },
    chmod: (p, m) => {
      calls.push(`chmod:${p}`);
    },
    chown: (p, u, g) => {
      calls.push(`chown:${p}`);
    },
    access: (p, m) => {
      calls.push(`access:${p}`);
    },
    utimensat: (p, aSec, aNsec, mSec, mNsec) => {
      calls.push(`utimensat:${p}`);
    },
    opendir: (p) => {
      calls.push(`opendir:${p}`);
      return 1;
    },
    readdir: (h) => {
      calls.push(`readdir:${h}`);
      return null;
    },
    closedir: (h) => {
      calls.push(`closedir:${h}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Mount resolution tests
// ---------------------------------------------------------------------------

describe("VirtualPlatformIO mount resolution", () => {
  it("routes root-level paths to the / mount", () => {
    const root = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: root }],
      new NodeTimeProvider(),
    );
    vfs.stat("/etc/hosts");
    expect(root.calls).toContain("stat:/etc/hosts");
  });

  it("routes /tmp paths to the /tmp mount", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );
    vfs.stat("/tmp/foo");
    expect(tmp.calls).toContain("stat:/foo");
    expect(root.calls).not.toContain("stat:/tmp/foo");
  });

  it("does not route /home/foo to /tmp mount", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );
    vfs.stat("/home/foo");
    expect(root.calls).toContain("stat:/home/foo");
    expect(tmp.calls.length).toBe(0);
  });

  it("longest prefix wins: /tmp/data beats /tmp", () => {
    const tmp = createMockBackend();
    const tmpData = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: createMockBackend() },
        { mountPoint: "/tmp", backend: tmp },
        { mountPoint: "/tmp/data", backend: tmpData },
      ],
      new NodeTimeProvider(),
    );
    vfs.stat("/tmp/data/file.csv");
    expect(tmpData.calls).toContain("stat:/file.csv");
    expect(tmp.calls.length).toBe(0);
  });

  it("exact mount-point path routes correctly", () => {
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: createMockBackend() },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );
    vfs.stat("/tmp");
    expect(tmp.calls).toContain("stat:/");
  });

  it("strips trailing slashes from mount points", () => {
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: createMockBackend() },
        { mountPoint: "/tmp/", backend: tmp },
      ],
      new NodeTimeProvider(),
    );
    vfs.stat("/tmp/abc");
    expect(tmp.calls).toContain("stat:/abc");
  });

  it("routes mount-root .. to the parent mount", () => {
    const root = createMockBackend();
    const phpSrc = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/php-src", backend: phpSrc },
      ],
      new NodeTimeProvider(),
    );

    vfs.stat("/php-src/..");

    expect(root.calls).toContain("stat:/");
    expect(phpSrc.calls.length).toBe(0);
  });

  it("leaves backend-internal missing/.. paths for component-wise resolution", () => {
    const phpSrc = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: createMockBackend() },
        { mountPoint: "/php-src", backend: phpSrc },
      ],
      new NodeTimeProvider(),
    );

    vfs.stat("/php-src/missing/../file.txt");

    expect(phpSrc.calls).toContain("stat:/missing/../file.txt");
  });
});

// ---------------------------------------------------------------------------
// 2. Handle mapping tests
// ---------------------------------------------------------------------------

describe("VirtualPlatformIO handle mapping", () => {
  it("returns unique global handles that map to backend-local handles", () => {
    const backend = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );

    const h1 = vfs.open("/a", 0, 0);
    const h2 = vfs.open("/b", 0, 0);

    expect(h1).not.toBe(h2);
    // Both should have delegated to backend.open
    expect(backend.calls.filter((c) => c.startsWith("open:"))).toHaveLength(2);
  });

  it("delegates read/write/seek to the correct backend via handle", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    const hRoot = vfs.open("/etc/file", 0, 0);
    const hTmp = vfs.open("/tmp/file", 0, 0);

    const buf = new Uint8Array(8);
    vfs.read(hRoot, buf, null, 8);
    vfs.write(hTmp, buf, null, 8);

    expect(root.calls).toContain("read:1");
    expect(tmp.calls).toContain("write:1");
    // The other backend should not see cross-traffic
    expect(root.calls.filter((c) => c.startsWith("write:"))).toHaveLength(0);
    expect(tmp.calls.filter((c) => c.startsWith("read:"))).toHaveLength(0);
  });

  it("close removes handle mapping; reuse errors", () => {
    const backend = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );

    const h = vfs.open("/file", 0, 0);
    vfs.close(h);

    expect(() => vfs.read(h, new Uint8Array(4), null, 4)).toThrow("EBADF");
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-mount EXDEV test
// ---------------------------------------------------------------------------

describe("VirtualPlatformIO cross-mount rename (EXDEV)", () => {
  it("throws EXDEV when renaming across mounts", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    expect(() => vfs.rename("/tmp/a", "/home/b")).toThrow("EXDEV");
  });

  it("succeeds when renaming within the same mount", () => {
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: createMockBackend() },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    vfs.rename("/tmp/a", "/tmp/b");
    expect(tmp.calls).toContain("rename:/a:/b");
  });

  it("throws EXDEV for cross-mount link", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    expect(() => vfs.link("/tmp/a", "/home/b")).toThrow("EXDEV");
  });
});

// ---------------------------------------------------------------------------
// 4. Path traversal guard (HostFileSystem)
// ---------------------------------------------------------------------------

describe("HostFileSystem path traversal", () => {
  it("rejects paths that escape rootPath", () => {
    const hfs = new HostFileSystem("/tmp/sandbox");
    expect(() => hfs.stat("/../../../etc/passwd")).toThrow("EACCES");
  });

  it("rejects paths with embedded .. sequences", () => {
    const root = mkdtempSync(join(tmpdir(), "hostfs-traversal-"));
    try {
      mkdirSync(join(root, "subdir"));
      const hfs = new HostFileSystem(root);
      expect(() => hfs.stat("/subdir/../../etc/passwd")).toThrow("EACCES");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not lexically erase missing intermediate components before ..", () => {
    const root = mkdtempSync(join(tmpdir(), "hostfs-path-"));
    try {
      mkdirSync(join(root, "existing"));
      writeFileSync(join(root, "existing", "file.txt"), "data");
      const hfs = new HostFileSystem(root);

      expect(() =>
        hfs.chmod("/existing/missing/../file.txt", 0o755),
      ).toThrow("ENOENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves trailing slash semantics for non-directory final components", () => {
    const root = mkdtempSync(join(tmpdir(), "hostfs-trailing-slash-"));
    try {
      writeFileSync(join(root, "file.txt"), "data");
      const hfs = new HostFileSystem(root);

      expect(() => hfs.stat("/file.txt/")).toThrow("ENOTDIR");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("follows absolute guest symlinks that stay inside the host mount", () => {
    const root = mkdtempSync(join(tmpdir(), "hostfs-symlink-"));
    try {
      writeFileSync(join(root, "target.txt"), "data");
      const hfs = new HostFileSystem(root, "/mnt");

      hfs.symlink("/mnt/target.txt", "/link.txt");

      expect(hfs.readlink("/link.txt")).toBe("/mnt/target.txt");
      expect(hfs.stat("/link.txt").size).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. MemoryFileSystem round-trip
// ---------------------------------------------------------------------------

describe("MemoryFileSystem", () => {
  it("creates, writes, seeks, and reads back a file", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;
    const fd = mfs.open("/test.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const data = new TextEncoder().encode("hello world");
    const written = mfs.write(fd, data, null, data.length);
    expect(written).toBe(data.length);
    mfs.seek(fd, 0, 0); // SEEK_SET
    const buf = new Uint8Array(32);
    const bytesRead = mfs.read(fd, buf, null, 32);
    expect(bytesRead).toBe(data.length);
    expect(new TextDecoder().decode(buf.subarray(0, bytesRead))).toBe(
      "hello world",
    );
    mfs.close(fd);
  });

  it("creates and lists directories", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    mfs.mkdir("/mydir", 0o755);
    // Create a file in the dir
    const O_CREAT = 0x0040,
      O_WRONLY = 0x0001;
    const fd = mfs.open("/mydir/file.txt", O_CREAT | O_WRONLY, 0o644);
    mfs.close(fd);
    // List dir
    const dh = mfs.opendir("/mydir");
    const entries: string[] = [];
    let entry;
    while ((entry = mfs.readdir(dh)) !== null) {
      entries.push(entry.name);
    }
    mfs.closedir(dh);
    expect(entries).toContain("file.txt");
  });

  it("reports raw inode numbers that remain representable after inode reuse", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;

    // SharedFS tracks an internal generation counter for reused inode slots.
    // POSIX st_ino does not need to include that generation, and exposing it
    // can overflow 32-bit guest language APIs while tools like ls(1) print the
    // full kernel value.
    for (let i = 0; i < 2_100; i++) {
      const fd = mfs.open("/reuse.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
      mfs.close(fd);
      mfs.unlink("/reuse.txt");
    }

    const fd = mfs.open("/reuse.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const stat = mfs.fstat(fd);
    expect(stat.ino).toBeGreaterThan(0);
    expect(stat.ino).toBeLessThanOrEqual(0x7fffffff);

    const dh = mfs.opendir("/");
    let entry;
    let dirIno: number | null = null;
    while ((entry = mfs.readdir(dh)) !== null) {
      if (entry.name === "reuse.txt") {
        dirIno = entry.ino;
        break;
      }
    }
    mfs.closedir(dh);
    expect(dirIno).toBe(stat.ino);
    mfs.close(fd);
  });

  it("honors O_CREAT|O_EXCL by failing when the final path already exists", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_WRONLY = 0x0001,
      O_CREAT = 0x0040,
      O_EXCL = 0x0080;

    const fd = mfs.open("/exclusive.txt", O_WRONLY | O_CREAT | O_EXCL, 0o600);
    mfs.close(fd);

    expect(() =>
      mfs.open("/exclusive.txt", O_WRONLY | O_CREAT | O_EXCL, 0o600),
    ).toThrow(/File exists/);

    // POSIX open(O_CREAT|O_EXCL) must fail with EEXIST when the final path is
    // a symbolic link, even if the symlink points at an existing regular file.
    mfs.symlink("/exclusive.txt", "/exclusive-link.txt");
    expect(() =>
      mfs.open("/exclusive-link.txt", O_WRONLY | O_CREAT | O_EXCL, 0o600),
    ).toThrow(/File exists/);
  });

  it("stat returns correct size after writing", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;
    const fd = mfs.open("/sized.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const data = new TextEncoder().encode("12345");
    mfs.write(fd, data, null, data.length);
    const st = mfs.fstat(fd);
    expect(st.size).toBe(5);
    mfs.close(fd);
  });

  it("updates mtime and ctime after file writes and truncates", () => {
    const now = vi.spyOn(Date, "now");
    try {
      const sab = new SharedArrayBuffer(4 * 1024 * 1024);
      now.mockReturnValue(1_000);
      const mfs = MemoryFileSystem.create(sab);
      const O_CREAT = 0x0040,
        O_RDWR = 0x0002,
        O_TRUNC = 0x0200;
      const fd = mfs.open("/timestamps.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
      const initial = mfs.fstat(fd);

      now.mockReturnValue(5_000);
      mfs.write(fd, new TextEncoder().encode("abc"), null, 3);
      const afterWrite = mfs.fstat(fd);
      expect(afterWrite.mtimeMs).toBe(5_000);
      expect(afterWrite.ctimeMs).toBe(5_000);
      expect(afterWrite.mtimeMs).toBeGreaterThan(initial.mtimeMs);

      now.mockReturnValue(9_000);
      mfs.ftruncate(fd, 1);
      const afterTruncate = mfs.fstat(fd);
      expect(afterTruncate.mtimeMs).toBe(9_000);
      expect(afterTruncate.ctimeMs).toBe(9_000);
      expect(afterTruncate.mtimeMs).toBeGreaterThan(afterWrite.mtimeMs);
      mfs.close(fd);
    } finally {
      now.mockRestore();
    }
  });

  it("unlink removes a file", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_WRONLY = 0x0001;
    const fd = mfs.open("/todelete.txt", O_CREAT | O_WRONLY, 0o644);
    mfs.close(fd);
    mfs.unlink("/todelete.txt");
    expect(() => mfs.stat("/todelete.txt")).toThrow();
  });

  it("rejects rename source paths that require a non-directory to be a directory", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_WRONLY = 0x0001;

    const fd = mfs.open("/file.txt", O_CREAT | O_WRONLY, 0o644);
    mfs.close(fd);

    expect(() => mfs.rename("/file.txt/", "/renamed.txt")).toThrow(
      /Not a directory/,
    );
    expect(mfs.stat("/file.txt").size).toBe(0);
    expect(() => mfs.stat("/renamed.txt")).toThrow(/No such file/);
  });

  it("preserves POSIX type checks when renaming directories onto existing paths", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_WRONLY = 0x0001;

    mfs.mkdir("/dir", 0o755);
    const fd = mfs.open("/file.txt", O_CREAT | O_WRONLY, 0o644);
    mfs.close(fd);
    mfs.symlink("/file.txt", "/link.txt");

    expect(() => mfs.rename("/dir", "/file.txt")).toThrow(/Not a directory/);
    expect(() => mfs.rename("/dir", "/link.txt")).toThrow(/Not a directory/);

    expect(mfs.stat("/dir").mode & 0xf000).toBe(0x4000);
    expect(mfs.stat("/file.txt").mode & 0xf000).toBe(0x8000);
    expect(mfs.readlink("/link.txt")).toBe("/file.txt");
  });

  it("renames directories over empty directories and updates dot-dot", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_WRONLY = 0x0001;

    mfs.mkdir("/old-parent", 0o755);
    mfs.mkdir("/new-parent", 0o755);
    mfs.mkdir("/old-parent/child", 0o755);
    const siblingFd = mfs.open(
      "/new-parent/sibling.txt",
      O_CREAT | O_WRONLY,
      0o644,
    );
    mfs.close(siblingFd);

    mfs.rename("/old-parent/child", "/new-parent/child");
    expect(mfs.stat("/new-parent/child/../sibling.txt").mode & 0xf000).toBe(
      0x8000,
    );

    mfs.mkdir("/empty-dest", 0o755);
    mfs.rename("/new-parent/child", "/empty-dest");
    expect(mfs.stat("/empty-dest").mode & 0xf000).toBe(0x4000);
    expect(() => mfs.stat("/new-parent/child")).toThrow(/No such file/);
  });

  it("keeps an unlinked open file alive until close", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;

    const oldFd = mfs.open("/open.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const oldData = new TextEncoder().encode("old");
    mfs.write(oldFd, oldData, null, oldData.length);
    mfs.unlink("/open.txt");
    expect(() => mfs.stat("/open.txt")).toThrow();

    const newFd = mfs.open("/open.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const newData = new TextEncoder().encode("newer");
    mfs.write(newFd, newData, null, newData.length);

    mfs.seek(oldFd, 0, 0);
    const oldBuf = new Uint8Array(8);
    const oldRead = mfs.read(oldFd, oldBuf, null, oldBuf.length);
    expect(new TextDecoder().decode(oldBuf.subarray(0, oldRead))).toBe("old");

    mfs.seek(newFd, 0, 0);
    const newBuf = new Uint8Array(8);
    const newRead = mfs.read(newFd, newBuf, null, newBuf.length);
    expect(new TextDecoder().decode(newBuf.subarray(0, newRead))).toBe("newer");

    mfs.close(oldFd);
    mfs.close(newFd);
  });

  it("ftruncate changes file size", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;
    const fd = mfs.open("/trunc.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const data = new TextEncoder().encode("abcdefghij");
    mfs.write(fd, data, null, data.length);
    expect(mfs.fstat(fd).size).toBe(10);
    mfs.ftruncate(fd, 5);
    expect(mfs.fstat(fd).size).toBe(5);
    mfs.close(fd);
  });

  it("ftruncate shrink then extend zero-fills the truncated tail", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;
    const fd = mfs.open("/zero-tail.bin", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const data = new TextEncoder().encode("abcdefghij");
    mfs.write(fd, data, null, data.length);
    mfs.ftruncate(fd, 3);
    mfs.ftruncate(fd, 10);
    mfs.seek(fd, 0, 0);
    const buf = new Uint8Array(10);
    expect(mfs.read(fd, buf, null, buf.length)).toBe(10);
    expect(Array.from(buf)).toEqual([97, 98, 99, 0, 0, 0, 0, 0, 0, 0]);
    mfs.close(fd);
  });

  it("statfs reports real SharedFS block usage", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const before = mfs.statfs("/");
    const fd = mfs.open("/blocks.bin", 0x0040 | 0x0002 | 0x0200, 0o644);
    const data = new Uint8Array(8192);
    mfs.write(fd, data, null, data.length);
    mfs.close(fd);
    const after = mfs.statfs("/");
    expect(after.blocks).toBe(before.blocks);
    expect(after.bfree).toBeLessThan(before.bfree);
    expect(after.bavail).toBe(after.bfree);
  });
});

// ---------------------------------------------------------------------------
// 6. Mixed mounts test (HostFileSystem + MemoryFileSystem)
// ---------------------------------------------------------------------------

describe("Mixed mounts: HostFileSystem root + MemoryFileSystem /tmp", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vfs-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes via /tmp (memory) and reads via / (host) independently", () => {
    const hostFs = new HostFileSystem(tmpDir);
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const memFs = MemoryFileSystem.create(sab);

    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: hostFs },
        { mountPoint: "/tmp", backend: memFs },
      ],
      new NodeTimeProvider(),
    );

    // Write a file to /tmp (memory-backed)
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;
    const hMem = vfs.open("/tmp/memfile.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const memData = new TextEncoder().encode("memory data");
    vfs.write(hMem, memData, null, memData.length);
    vfs.close(hMem);

    // Write a file to / (host-backed)
    writeFileSync(join(tmpDir, "hostfile.txt"), "host data");

    // Read back from host via VFS
    const hHost = vfs.open("/hostfile.txt", 0, 0);
    const buf = new Uint8Array(64);
    const n = vfs.read(hHost, buf, null, 64);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("host data");
    vfs.close(hHost);

    // Read back from memory via VFS
    const hMem2 = vfs.open("/tmp/memfile.txt", 0, 0);
    const buf2 = new Uint8Array(64);
    const n2 = vfs.read(hMem2, buf2, null, 64);
    expect(new TextDecoder().decode(buf2.subarray(0, n2))).toBe("memory data");
    vfs.close(hMem2);
  });

  it("directory listing works for host-backed mount", () => {
    writeFileSync(join(tmpDir, "a.txt"), "a");
    writeFileSync(join(tmpDir, "b.txt"), "b");

    const hostFs = new HostFileSystem(tmpDir);
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: hostFs }],
      new NodeTimeProvider(),
    );

    const dh = vfs.opendir("/");
    const names: string[] = [];
    let entry;
    while ((entry = vfs.readdir(dh)) !== null) {
      names.push(entry.name);
    }
    vfs.closedir(dh);

    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });

  it("routes statfs to the mounted backend", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    vfs.statfs("/tmp/file.txt");

    expect(root.calls).not.toContain("statfs:/tmp/file.txt");
    expect(tmp.calls).toContain("statfs:/file.txt");
  });
});

// ---------------------------------------------------------------------------
// 7. VirtualPlatformIO with no mounts throws
// ---------------------------------------------------------------------------

describe("VirtualPlatformIO constructor validation", () => {
  it("throws if no mounts provided", () => {
    expect(() => new VirtualPlatformIO([], new NodeTimeProvider())).toThrow(
      "at least one mount",
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Time provider tests
// ---------------------------------------------------------------------------

describe("NodeTimeProvider", () => {
  it("returns realtime clock", () => {
    const tp = new NodeTimeProvider();
    const { sec, nsec } = tp.clockGettime(0);
    expect(sec).toBeGreaterThan(0);
    expect(nsec).toBeGreaterThanOrEqual(0);
    expect(nsec).toBeLessThan(1_000_000_000);
  });

  it("returns monotonic clock", () => {
    const tp = new NodeTimeProvider();
    const { sec, nsec } = tp.clockGettime(1);
    expect(sec).toBeGreaterThanOrEqual(0);
    expect(nsec).toBeGreaterThanOrEqual(0);
  });

  it("monotonic clock is non-decreasing across calls", () => {
    const tp = new NodeTimeProvider();
    const t1 = tp.clockGettime(1);
    const t2 = tp.clockGettime(1);
    const ns1 = BigInt(t1.sec) * 1_000_000_000n + BigInt(t1.nsec);
    const ns2 = BigInt(t2.sec) * 1_000_000_000n + BigInt(t2.nsec);
    expect(ns2).toBeGreaterThanOrEqual(ns1);
  });
});

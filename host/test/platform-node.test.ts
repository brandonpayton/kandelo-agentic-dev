/**
 * Unit tests for the Node platform adapter — specifically the path
 * translation that bridges the kernel's POSIX namespace to Node `fs.*`.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePlatformIO, translateWindowsDrivePath } from "../src/platform/node";

const O_WRONLY = 0o1;
const O_CREAT = 0o100;
const O_EXCL = 0o200;

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe("translateWindowsDrivePath", () => {
  it("converts /C/foo → C:/foo", () => {
    expect(translateWindowsDrivePath("/C/foo")).toBe("C:/foo");
  });

  it("accepts lowercase drive letters", () => {
    expect(translateWindowsDrivePath("/d/projects/wp")).toBe("d:/projects/wp");
  });

  it("converts a bare drive prefix /C → C:/", () => {
    expect(translateWindowsDrivePath("/C")).toBe("C:/");
  });

  it("converts /C/ → C:/", () => {
    expect(translateWindowsDrivePath("/C/")).toBe("C:/");
  });

  it("preserves nested path segments", () => {
    expect(
      translateWindowsDrivePath("/C/Users/RUNNER~1/AppData/Local/Temp/foo"),
    ).toBe("C:/Users/RUNNER~1/AppData/Local/Temp/foo");
  });

  it("returns null for paths without a single-letter drive prefix", () => {
    expect(translateWindowsDrivePath("/foo/bar")).toBeNull();
    expect(translateWindowsDrivePath("/CD/foo")).toBeNull();
    expect(translateWindowsDrivePath("/wordpress")).toBeNull();
  });

  it("returns null for paths missing a leading slash", () => {
    expect(translateWindowsDrivePath("C:/foo")).toBeNull();
    expect(translateWindowsDrivePath("foo/bar")).toBeNull();
    expect(translateWindowsDrivePath("")).toBeNull();
  });

  it("returns null for the root /", () => {
    expect(translateWindowsDrivePath("/")).toBeNull();
  });
});

describe("NodePlatformIO byte paths", () => {
  it("stores non-native POSIX filename bytes behind reversible host-safe names", () => {
    const dir = mkdtempSync(join(tmpdir(), "wasm-posix-byte-path-"));
    try {
      const encoder = new TextEncoder();
      const segment = concatBytes(
        encoder.encode("etilqs_6a35aa9800000000"),
        // U+4371E is a valid UTF-8 scalar but macOS rejects it as EILSEQ
        // when creating a native file. The guest still needs POSIX byte-path
        // semantics for SQLite temp names.
        Uint8Array.from([0xf1, 0x83, 0x9c, 0x9e]),
      );
      const guestPath = concatBytes(encoder.encode(`${dir}/`), segment);
      const io = new NodePlatformIO();

      const fd = io.openBytes!(guestPath, O_WRONLY | O_CREAT | O_EXCL, 0o600);
      io.close(fd);

      expect(io.statBytes!(guestPath).mode & 0o777).toBe(0o600);
      const nativeEntries = readdirSync(dir);
      expect(nativeEntries).toHaveLength(1);
      expect(nativeEntries[0]).not.toContain("񃜞");

      const dh = io.opendir(dir);
      try {
        const entry = io.readdir(dh);
        expect(entry?.nameBytes).toEqual(segment);
      } finally {
        io.closedir(dh);
      }

      io.unlinkBytes!(guestPath);
      expect(() => io.statBytes!(guestPath)).toThrow(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

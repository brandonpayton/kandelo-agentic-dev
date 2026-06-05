/**
 * Build a VFS image for running php-src PHPT runtime tests in the browser.
 *
 * The image contains:
 *   - /bin/sh and coreutils for PHP's shell-backed exec APIs
 *   - /usr/local/bin/php
 *   - /php-src/<test directories containing .phpt files>
 *
 * The Playwright-side runner parses each .phpt file and writes transient
 * PHP scripts into the restored image before spawning /usr/local/bin/php.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  symlink,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { findRepoRoot, tryResolveBinary } from "../../../host/src/binary-resolver";
import { ensureSourceExtract } from "./source-extract-helper";
import { saveImage, walkAndWrite } from "./vfs-image-helpers";

const REPO_ROOT = findRepoRoot();
const LOCAL_PHP_SRC = join(REPO_ROOT, "packages/registry/php/php-src");
const PHP_WASM = process.env.PHP_WASM
  ?? tryResolveBinary("programs/php/php.wasm")
  ?? join(LOCAL_PHP_SRC, "sapi/cli/php");
const DASH_WASM = process.env.DASH_WASM
  ?? tryResolveBinary("programs/dash.wasm");
const COREUTILS_WASM = process.env.COREUTILS_WASM
  ?? tryResolveBinary("programs/coreutils.wasm");
const OUT_FILE = process.env.PHP_TEST_VFS_OUT
  ?? join(REPO_ROOT, "apps/browser-demos/public/php-test.vfs.zst");
const FS_INITIAL_BYTES = Number(process.env.PHP_TEST_VFS_INITIAL_BYTES ?? 256 * 1024 * 1024);
const FS_MAX_BYTES = Number(process.env.PHP_TEST_VFS_MAX_BYTES ?? 2 * 1024 * 1024 * 1024);

const COREUTILS_NAMES = [
  "arch", "b2sum", "base32", "base64", "basename", "basenc", "cat",
  "chcon", "chgrp", "chmod", "chown", "chroot", "cksum", "comm", "cp",
  "csplit", "cut", "date", "dd", "df", "dir", "dircolors", "dirname",
  "du", "echo", "env", "expand", "expr", "factor", "false", "fmt",
  "fold", "groups", "head", "hostid", "id", "install", "join", "link",
  "ln", "logname", "ls", "md5sum", "mkdir", "mkfifo", "mknod", "mktemp",
  "mv", "nice", "nl", "nohup", "nproc", "numfmt", "od", "paste",
  "pathchk", "pr", "printenv", "printf", "ptx", "pwd", "readlink",
  "realpath", "rm", "rmdir", "runcon", "seq", "sha1sum", "sha224sum",
  "sha256sum", "sha384sum", "sha512sum", "shred", "shuf", "sleep",
  "sort", "split", "stat", "stty", "sum", "sync", "tac", "tail",
  "tee", "test", "timeout", "touch", "tr", "true", "truncate", "tsort",
  "tty", "uname", "unexpand", "uniq", "unlink", "vdir", "wc", "whoami",
  "yes",
];

function resolvePhpSource(): string {
  return process.env.PHP_SOURCE_DIR
    ?? ensureSourceExtract("php", REPO_ROOT, existsSync(LOCAL_PHP_SRC) ? LOCAL_PHP_SRC : undefined);
}

function collectPhptDirs(root: string): string[] {
  const dirs = new Set<string>();
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".deps" || entry.name === ".libs") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".phpt")) {
        dirs.add(dir);
      }
    }
  }
  walk(root);
  return [...dirs].sort();
}

function shouldExclude(sourceRoot: string, relPath: string): boolean {
  const base = relPath.split("/").pop() ?? relPath;
  if (relPath.includes("/.git/") || relPath.includes("/.deps/") || relPath.includes("/.libs/")) return true;
  if (base.startsWith(".nfs")) return true;
  if (base.endsWith(".o") || base.endsWith(".lo") || base.endsWith(".la") || base.endsWith(".a")) return true;
  if (base === "php" || base === "phpdbg" || base === "php-cgi" || base === "php-fpm") {
    try {
      const st = statSync(join(sourceRoot, relPath));
      return st.size > 1024 * 1024;
    } catch {
      return true;
    }
  }
  return false;
}

async function main() {
  if (!existsSync(PHP_WASM)) {
    throw new Error(`PHP wasm not found at ${PHP_WASM}. Run: bash packages/registry/php/build-php.sh`);
  }
  if (!DASH_WASM || !existsSync(DASH_WASM)) {
    throw new Error("dash.wasm not found. Run: scripts/fetch-binaries.sh or set DASH_WASM");
  }
  if (!COREUTILS_WASM || !existsSync(COREUTILS_WASM)) {
    throw new Error("coreutils.wasm not found. Run: scripts/fetch-binaries.sh or set COREUTILS_WASM");
  }
  const phpSrc = resolvePhpSource();
  if (!existsSync(phpSrc)) {
    throw new Error(`php-src not found at ${phpSrc}`);
  }

  console.log("==> Building PHP PHPT test VFS image");
  console.log(`  php-src: ${phpSrc}`);

  const sab = new SharedArrayBuffer(FS_INITIAL_BYTES, { maxByteLength: FS_MAX_BYTES });
  const fs = MemoryFileSystem.create(sab, FS_MAX_BYTES);
  for (const dir of [
    "/tmp", "/home", "/root", "/dev", "/etc", "/bin", "/usr", "/usr/bin",
    "/usr/local", "/usr/local/bin", "/php-src",
  ]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o1777);

  writeVfsBinary(fs, "/usr/bin/dash", new Uint8Array(readFileSync(DASH_WASM)));
  symlink(fs, "/usr/bin/dash", "/bin/sh");
  symlink(fs, "/usr/bin/dash", "/bin/dash");

  writeVfsBinary(fs, "/usr/bin/coreutils", new Uint8Array(readFileSync(COREUTILS_WASM)));
  for (const name of COREUTILS_NAMES) {
    symlink(fs, "/usr/bin/coreutils", `/bin/${name}`);
    symlink(fs, "/usr/bin/coreutils", `/usr/bin/${name}`);
  }
  symlink(fs, "/usr/bin/coreutils", "/bin/[");
  symlink(fs, "/usr/bin/coreutils", "/usr/bin/[");

  writeVfsBinary(fs, "/usr/local/bin/php", new Uint8Array(readFileSync(PHP_WASM)));

  const phptDirs = collectPhptDirs(phpSrc);
  console.log(`  Writing ${phptDirs.length} PHPT directories...`);
  let fileCount = 0;
  for (const dir of phptDirs) {
    const rel = relative(phpSrc, dir);
    const dest = rel ? `/php-src/${rel}` : "/php-src";
    ensureDirRecursive(fs, dirname(dest));
    fileCount += walkAndWrite(fs, dir, dest, {
      exclude: (childRel) => shouldExclude(phpSrc, rel ? `${rel}/${childRel}` : childRel),
    });
  }
  console.log(`    ${fileCount} files`);

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

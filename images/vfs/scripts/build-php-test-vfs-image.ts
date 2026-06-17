/**
 * Build a VFS image for running php-src PHPT runtime tests in the browser.
 *
 * The image contains:
 *   - /bin/sh plus standard shell utilities for PHP's shell-backed exec APIs
 *   - /usr/local/bin/php
 *   - /php-src/<test directories containing .phpt files>
 *
 * The Playwright-side runner parses each .phpt file and writes transient
 * PHP scripts into the restored image before spawning /usr/local/bin/php.
 */
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  symlink,
  writeVfsFile,
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
const OPCACHE_SO = process.env.PHP_OPCACHE_SO
  ?? tryResolveBinary("programs/php/opcache.so");
const PHP_EXTENSION_DIR = process.env.PHP_EXTENSION_DIR
  ?? (OPCACHE_SO ? dirname(OPCACHE_SO) : undefined);
const DASH_WASM = process.env.DASH_WASM
  ?? tryResolveBinary("programs/dash.wasm");
const COREUTILS_WASM = process.env.COREUTILS_WASM
  ?? tryResolveBinary("programs/coreutils.wasm");
const SED_WASM = process.env.SED_WASM
  ?? tryResolveBinary("programs/sed.wasm");
const OUT_FILE = process.env.PHP_TEST_VFS_OUT
  ?? join(REPO_ROOT, "apps/browser-demos/public/php-test.vfs.zst");
const FS_INITIAL_BYTES = Number(process.env.PHP_TEST_VFS_INITIAL_BYTES ?? 256 * 1024 * 1024);
const FS_MAX_BYTES = Number(process.env.PHP_TEST_VFS_MAX_BYTES ?? 2 * 1024 * 1024 * 1024);

const ETC_PASSWD = [
  "root:x:0:0:root:/root:/bin/sh",
  "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
  "user:x:1000:1000:user:/home/user:/bin/sh",
  "",
].join("\n");

const ETC_GROUP = [
  "root:x:0:",
  "nogroup:x:65534:",
  "nobody:x:65534:",
  "user:x:1000:",
  "",
].join("\n");

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
  // Some PHPTs include helper fixtures from extension directories that do not
  // themselves contain .phpt files. Keep those directories in the browser VFS
  // so SKIPIF sections behave like they do against a complete php-src tree.
  for (const rel of ["ext/dl_test/tests"]) {
    const full = join(root, rel);
    if (existsSync(full)) dirs.add(full);
  }
  return [...dirs].sort();
}

function preparePhpTestFixtures(sourceRoot: string): void {
  const fixtureDir = join(REPO_ROOT, "tests/php-fixtures/openssl-sni-2036");
  const destDir = join(sourceRoot, "ext/openssl/tests");
  if (existsSync(fixtureDir) && existsSync(destDir)) {
    for (const entry of readdirSync(fixtureDir)) {
      if (!entry.startsWith("sni_server_") || !entry.endsWith(".pem")) continue;
      cpSync(join(fixtureDir, entry), join(destDir, entry));
    }
  }

  const mysqliFakeServer = join(sourceRoot, "ext/mysqli/tests/fake_server.inc");
  if (existsSync(mysqliFakeServer)) {
    const text = readFileSync(mysqliFakeServer, "utf8");
    if (!text.includes("MYSQLI_FAKE_SERVER_DRAIN_IDLE_MS")) {
      const from = `    public function read($bytes_len = 1024)
    {
        // wait 20ms to fill the buffer
        usleep(20000);
        $data = fread($this->conn, $bytes_len);
        if ($data) {
            fprintf(STDERR, "[*] Received: %s\\n", bin2hex($data));
        }
    }`;
      const to = `    public function read($bytes_len = 1024)
    {
        // wait 20ms to fill the buffer
        usleep(20000);
        $data = fread($this->conn, $bytes_len);

        if ($data && $bytes_len > 1024) {
            // Large reads in this fake MySQL server are used to drain the
            // connection tail after the client reacts to a crafted packet.
            // fread() on a POSIX stream may return as soon as any bytes are
            // available; it is not required to wait for later client writes to
            // coalesce into the same TCP segment. Native php-src runs usually
            // see the final COM_STMT_CLOSE and COM_QUIT together after the
            // fixed sleep above, but the browser host can schedule the guest
            // peer more slowly. Keep draining for a short idle window and print
            // one Received line so the fixture remains semantically identical
            // without relying on transport coalescing.
            $idleMs = getenv('MYSQLI_FAKE_SERVER_DRAIN_IDLE_MS');
            $idleMs = $idleMs !== false && is_numeric($idleMs) ? max(0, (int) $idleMs) : 250;
            $deadline = microtime(true) + ($idleMs / 1000);
            $wasBlocking = stream_get_meta_data($this->conn)['blocked'] ?? true;
            stream_set_blocking($this->conn, false);
            try {
                while (strlen($data) < $bytes_len && microtime(true) < $deadline) {
                    usleep(10000);
                    $chunk = fread($this->conn, $bytes_len - strlen($data));
                    if ($chunk !== false && $chunk !== '') {
                        $data .= $chunk;
                        $deadline = microtime(true) + ($idleMs / 1000);
                    }
                }
            } finally {
                stream_set_blocking($this->conn, $wasBlocking);
            }
        }

        if ($data) {
            fprintf(STDERR, "[*] Received: %s\\n", bin2hex($data));
        }
    }`;
      if (!text.includes(from)) {
        throw new Error(
          `Unable to patch PHP mysqli fake_server fixture: read() marker not found in ${mysqliFakeServer}`,
        );
      }
      // The source tree is a local extracted test fixture, not tracked PHP
      // package source. Patch it before packing the browser VFS so browser and
      // Node PHPT runs exercise the same transport-tolerant fixture behavior.
      writeFileSync(mysqliFakeServer, text.replace(from, to), "utf8");
    }
  }
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
  if (!SED_WASM || !existsSync(SED_WASM)) {
    throw new Error("sed.wasm not found. Run: scripts/fetch-binaries.sh or set SED_WASM");
  }
  const phpSrc = resolvePhpSource();
  if (!existsSync(phpSrc)) {
    throw new Error(`php-src not found at ${phpSrc}`);
  }
  preparePhpTestFixtures(phpSrc);

  console.log("==> Building PHP PHPT test VFS image");
  console.log(`  php-src: ${phpSrc}`);

  const sab = new SharedArrayBuffer(FS_INITIAL_BYTES, { maxByteLength: FS_MAX_BYTES });
  const fs = MemoryFileSystem.create(sab, FS_MAX_BYTES);
  for (const dir of [
    "/tmp", "/home", "/root", "/dev", "/etc", "/bin", "/usr", "/usr/bin",
    "/usr/lib", "/usr/lib/php", "/usr/lib/php/extensions",
    "/usr/local", "/usr/local/bin", "/php-src",
  ]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o1777);
  writeVfsFile(fs, "/etc/passwd", ETC_PASSWD);
  writeVfsFile(fs, "/etc/group", ETC_GROUP);

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

  writeVfsBinary(fs, "/usr/bin/sed", new Uint8Array(readFileSync(SED_WASM)));
  symlink(fs, "/usr/bin/sed", "/bin/sed");

  writeVfsBinary(fs, "/usr/local/bin/php", new Uint8Array(readFileSync(PHP_WASM)));
  if (PHP_EXTENSION_DIR && existsSync(PHP_EXTENSION_DIR)) {
    for (const entry of readdirSync(PHP_EXTENSION_DIR)) {
      if (!entry.endsWith(".so")) continue;
      const src = join(PHP_EXTENSION_DIR, entry);
      writeVfsBinary(
        fs,
        `/usr/lib/php/extensions/${entry}`,
        new Uint8Array(readFileSync(src)),
      );
    }
  }
  if (OPCACHE_SO && existsSync(OPCACHE_SO)) {
    // PHP_OPCACHE_SO is the explicit harness override for the OPcache side
    // module. Honor it even when PHP_EXTENSION_DIR also contains an
    // opcache.so; otherwise browser PHPT runs can silently package a stale
    // or non-side-module opcache under the canonical extension path while the
    // runner advertises OPcache as available.
    writeVfsBinary(
      fs,
      "/usr/lib/php/extensions/opcache.so",
      new Uint8Array(readFileSync(OPCACHE_SO)),
    );
  }

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

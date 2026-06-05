/**
 * Build a VFS image for running the upstream Node.js JavaScript library tests
 * in the browser host.
 *
 * The image contains:
 *   - /usr/bin/node
 *   - /node-src/test, /node-src/lib, and /node-src/tools from Node.js source
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  symlink,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { findRepoRoot, tryResolveBinary } from "../../../host/src/binary-resolver";
import { ensureNodejsSource, nodejsSourceSummary } from "../../../scripts/nodejs-source-helper";
import { saveImage } from "./vfs-image-helpers";

const REPO_ROOT = findRepoRoot();
const LOCAL_NODE = join(REPO_ROOT, "packages/registry/spidermonkey/bin/node.wasm");
const NODE_WASM = [
  process.env.NODEJS_WASM,
  tryResolveBinary("programs/node.wasm"),
  tryResolveBinary("programs/spidermonkey-node.wasm"),
  join(REPO_ROOT, "packages/registry/spidermonkey-node/bin/node.wasm"),
  LOCAL_NODE,
].filter((path): path is string => !!path).find((path) => existsSync(path));
const OUT_FILE = process.env.NODEJS_TEST_VFS_OUT
  ?? join(REPO_ROOT, "apps/browser-demos/public/nodejs-test.vfs.zst");
const IMAGE_INITIAL_BYTES = 256 * 1024 * 1024;
const IMAGE_MAX_BYTES = 1536 * 1024 * 1024;

async function main() {
  if (!NODE_WASM) {
    throw new Error(
      `Node-compatible wasm not found at ${NODE_WASM}. ` +
      "Run: bash packages/registry/spidermonkey-node/build-spidermonkey-node.sh",
    );
  }

  const sourceRoot = ensureNodejsSource(REPO_ROOT);
  console.log("==> Building Node.js library-test VFS image");
  console.log(`  node-src: ${sourceRoot}`);
  console.log(`  source: ${nodejsSourceSummary(sourceRoot)}`);

  const sab = new SharedArrayBuffer(IMAGE_INITIAL_BYTES, { maxByteLength: IMAGE_MAX_BYTES });
  const fs = MemoryFileSystem.create(sab, IMAGE_MAX_BYTES);

  for (const dir of ["/tmp", "/home", "/root", "/dev", "/etc", "/node-src", "/usr", "/usr/bin", "/bin"]) {
    ensureDirRecursive(fs, dir);
  }
  fs.chmod("/tmp", 0o777);

  writeVfsBinary(fs, "/usr/bin/node", new Uint8Array(readFileSync(NODE_WASM)), 0o755);
  symlink(fs, "/usr/bin/node", "/bin/node");

  let files = 0;
  for (const top of ["test", "lib", "tools"]) {
    const from = join(sourceRoot, top);
    if (!existsSync(from)) continue;
    files += copyTreePreservingSymlinks(fs, from, `/node-src/${top}`);
  }
  console.log(`  wrote ${files} source files`);

  await saveImage(fs, OUT_FILE, {
    allowedWasmArtifactPolicyFailures: {
      "/usr/bin/node": ["imports kernel.kernel_fork without complete wasm-fork-instrument exports"],
    },
  });
}

function copyTreePreservingSymlinks(
  fs: MemoryFileSystem,
  sourceRoot: string,
  mountPrefix: string,
): number {
  let count = 0;
  ensureDirRecursive(fs, mountPrefix);

  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "out" || name === ".tmp") continue;
      const full = join(dir, name);
      const rel = relative(sourceRoot, full).split("\\").join("/");
      const dest = `${mountPrefix}/${rel}`;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        ensureDirRecursive(fs, dirname(dest));
        symlink(fs, readlinkSync(full), dest);
      } else if (st.isDirectory()) {
        ensureDirRecursive(fs, dest);
        walk(full);
      } else if (st.isFile()) {
        writeVfsBinary(fs, dest, new Uint8Array(readFileSync(full)), st.mode & 0o777);
        count++;
      }
    }
  }

  walk(sourceRoot);
  return count;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

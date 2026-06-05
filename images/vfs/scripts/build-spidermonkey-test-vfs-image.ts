/**
 * Build a VFS image for running SpiderMonkey shell unit tests in the browser.
 *
 * The image contains:
 *   - /usr/bin/js
 *   - Mozilla's official js/src/tests and js/src/jit-test trees at their
 *     host absolute paths, so upstream harness argv paths work unchanged.
 *
 * The Playwright-side runner writes transient JS files as needed and spawns
 * /usr/bin/js through BrowserKernel.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  symlink,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { findRepoRoot, tryResolveBinary } from "../../../host/src/binary-resolver";
import { saveImage, walkAndWrite } from "./vfs-image-helpers";

const REPO_ROOT = findRepoRoot();
const LOCAL_JS = join(REPO_ROOT, "packages/registry/spidermonkey/bin/js.wasm");
const JS_WASM = process.env.SPIDERMONKEY_WASM
  ?? tryResolveBinary("programs/js.wasm")
  ?? tryResolveBinary("programs/spidermonkey.wasm")
  ?? LOCAL_JS;
const OUT_FILE = process.env.SPIDERMONKEY_TEST_VFS_OUT
  ?? join(REPO_ROOT, "apps/browser-demos/public/spidermonkey-test.vfs.zst");
const SPIDERMONKEY_SOURCE = process.env.SPIDERMONKEY_SOURCE_DIR
  ?? join(REPO_ROOT, "packages/registry/spidermonkey/source/firefox-140.11.0");

async function main() {
  if (!existsSync(JS_WASM)) {
    throw new Error(
      `SpiderMonkey js.wasm not found at ${JS_WASM}. ` +
      "Run: bash packages/registry/spidermonkey/build-spidermonkey.sh",
    );
  }

  console.log("==> Building SpiderMonkey shell-test VFS image");
  const imageMaxBytes = 1536 * 1024 * 1024;
  const sab = new SharedArrayBuffer(1024 * 1024 * 1024, { maxByteLength: imageMaxBytes });
  const fs = MemoryFileSystem.create(sab, imageMaxBytes);

  for (const dir of [
    "/tmp", "/home", "/root", "/dev", "/etc", "/bin", "/usr", "/usr/bin",
  ]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o777);

  writeVfsBinary(fs, "/usr/bin/js", new Uint8Array(readFileSync(JS_WASM)));
  symlink(fs, "/usr/bin/js", "/bin/js");

  const officialDirs = [
    join(SPIDERMONKEY_SOURCE, "js/src/tests"),
    join(SPIDERMONKEY_SOURCE, "js/src/jit-test"),
  ];
  for (const sourceDir of officialDirs) {
    if (!existsSync(sourceDir)) {
      throw new Error(`SpiderMonkey official test tree missing: ${sourceDir}`);
    }
    ensureDirRecursive(fs, sourceDir);
    console.log(`  Writing ${sourceDir}...`);
    const count = walkAndWrite(fs, sourceDir, sourceDir, {
      exclude: (rel) =>
        rel.startsWith("__pycache__/") ||
        rel.includes("/__pycache__/") ||
        rel.endsWith(".pyc"),
    });
    console.log(`    ${count} files`);
  }

  await saveImage(fs, OUT_FILE, {
    allowedWasmArtifactPolicyFailures: {
      "/usr/bin/js": ["imports kernel.kernel_fork without complete wasm-fork-instrument exports"],
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

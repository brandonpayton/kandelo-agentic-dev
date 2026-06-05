import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

export interface NodejsTestMetadata {
  flags: string[];
  env: string[];
}

export interface NodejsTestDescriptor extends NodejsTestMetadata {
  name: string;
  relPath: string;
  hostPath: string;
  vfsPath: string;
}

const DEFAULT_TEST_DIRS = ["parallel", "sequential"] as const;

export function defaultNodejsTestVersion(): string {
  return (process.env.NODEJS_TEST_VERSION || process.version).replace(/^v/, "");
}

export function ensureNodejsSource(repoRoot: string): string {
  const explicit = process.env.NODEJS_SOURCE_DIR;
  if (explicit) {
    const resolved = resolve(explicit);
    if (!existsSync(join(resolved, "test", "common"))) {
      throw new Error(`NODEJS_SOURCE_DIR does not look like a Node.js source tree: ${resolved}`);
    }
    return resolved;
  }

  const legacy = join(repoRoot, "packages", "registry", "node", "node-src");
  if (existsSync(join(legacy, "test", "common"))) return legacy;

  const version = defaultNodejsTestVersion();
  const cacheRoot = process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, "wasm-posix-kernel")
    : join(homedir(), ".cache", "wasm-posix-kernel");
  const extractDir = join(cacheRoot, "nodejs-test-sources", `node-v${version}`);
  if (existsSync(join(extractDir, "test", "common"))) return extractDir;

  const archiveName = `node-v${version}.tar.gz`;
  const distBase = `https://nodejs.org/dist/v${version}`;
  const shasums = execFileSync("curl", ["-fsSL", `${distBase}/SHASUMS256.txt`], {
    encoding: "utf8",
  });
  const shasumLine = shasums.split("\n").find((line) => line.endsWith(` ${archiveName}`));
  if (!shasumLine) {
    throw new Error(`Could not find ${archiveName} in Node.js v${version} SHASUMS256.txt`);
  }
  const expectedSha256 = shasumLine.split(/\s+/, 1)[0];

  const downloadDir = join(cacheRoot, "nodejs-test-sources", "_downloads");
  mkdirSync(downloadDir, { recursive: true });
  const archivePath = join(downloadDir, archiveName);
  if (!existsSync(archivePath) || sha256OfFile(archivePath) !== expectedSha256) {
    execFileSync("curl", [
      "--retry", "5",
      "--retry-delay", "2",
      "--retry-all-errors",
      "-fsSL",
      "-o", `${archivePath}.partial`,
      `${distBase}/${archiveName}`,
    ], { stdio: "inherit" });
    const got = sha256OfFile(`${archivePath}.partial`);
    if (got !== expectedSha256) {
      rmSync(`${archivePath}.partial`, { force: true });
      throw new Error(`sha256 mismatch for ${archiveName}: expected ${expectedSha256}, got ${got}`);
    }
    renameSync(`${archivePath}.partial`, archivePath);
  }

  const tmpExtract = `${extractDir}.tmp-${process.pid}`;
  rmSync(tmpExtract, { recursive: true, force: true });
  mkdirSync(tmpExtract, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "--strip-components=1", "-C", tmpExtract], {
    stdio: "inherit",
  });
  try {
    renameSync(tmpExtract, extractDir);
  } catch (err) {
    rmSync(tmpExtract, { recursive: true, force: true });
    if (!existsSync(join(extractDir, "test", "common"))) throw err;
  }
  return extractDir;
}

export function collectNodejsLibraryTests(
  sourceRoot: string,
  selectors: string[] = [],
): NodejsTestDescriptor[] {
  const files = selectors.length === 0
    ? DEFAULT_TEST_DIRS.flatMap((dir) => listJsTests(join(sourceRoot, "test", dir)))
    : selectors.flatMap((selector) => expandSelector(sourceRoot, selector));

  const unique = [...new Set(files.map((file) => resolve(file)))].sort();
  return unique.map((hostPath) => {
    const relPath = relative(sourceRoot, hostPath).split("\\").join("/");
    const name = relPath.startsWith("test/") ? relPath.slice("test/".length) : relPath;
    const metadata = parseNodejsTestMetadata(hostPath);
    return {
      name,
      relPath,
      hostPath,
      vfsPath: `/node-src/${relPath}`,
      ...metadata,
    };
  });
}

export function parseNodejsTestMetadata(path: string): NodejsTestMetadata {
  const source = readFileSync(path, "utf8").slice(0, 1500);
  return {
    flags: parseMetadataLine(source, "Flags"),
    env: parseMetadataLine(source, "Env"),
  };
}

function parseMetadataLine(source: string, label: "Flags" | "Env"): string[] {
  const match = source.match(new RegExp(`^// ${label}:\\s+(.+)$`, "m"));
  return match ? splitMetadataArgs(match[1]) : [];
}

function splitMetadataArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function expandSelector(sourceRoot: string, selector: string): string[] {
  const cleaned = normalizeSelector(selector);
  const candidates = candidatePaths(sourceRoot, cleaned);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const st = statSync(candidate);
    if (st.isDirectory()) return listJsTests(candidate);
    if (st.isFile()) return [candidate];
  }

  if (!cleaned.includes("/")) {
    const matches: string[] = [];
    const wanted = cleaned.endsWith(".js") ? cleaned : `${cleaned}.js`;
    for (const dir of DEFAULT_TEST_DIRS) {
      const candidate = join(sourceRoot, "test", dir, wanted);
      if (existsSync(candidate)) matches.push(candidate);
    }
    if (matches.length > 0) return matches;
  }

  throw new Error(`Node.js test selector did not match any file or directory: ${selector}`);
}

function normalizeSelector(selector: string): string {
  let cleaned = selector.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  cleaned = cleaned.replace(/^node-src\//, "");
  cleaned = cleaned.replace(/^test\//, "");
  return cleaned;
}

function candidatePaths(sourceRoot: string, cleaned: string): string[] {
  const maybeJs = cleaned.endsWith(".js") ? cleaned : `${cleaned}.js`;
  return [
    resolve(cleaned),
    join(sourceRoot, "test", cleaned),
    join(sourceRoot, "test", maybeJs),
    join(sourceRoot, cleaned),
    join(sourceRoot, maybeJs),
  ];
}

function listJsTests(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith("test-") && name.endsWith(".js"))
    .map((name) => join(dir, name));
}

function sha256OfFile(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

export function nodejsSourceSummary(sourceRoot: string): string {
  const testCount = DEFAULT_TEST_DIRS
    .map((dir) => listJsTests(join(sourceRoot, "test", dir)).length)
    .reduce((sum, count) => sum + count, 0);
  return `${basename(sourceRoot)} (${testCount} parallel/sequential tests)`;
}

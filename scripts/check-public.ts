import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const root = process.cwd();
const excluded = new Set([
  ".git",
  "node_modules",
  ".cache",
  ".output",
  ".wxt",
  "dist",
  "artifacts",
  "coverage",
  "test-results",
  "playwright-report",
]);
const forbiddenNames = new Set([
  "connection.json",
  "Cookies",
  "Login Data",
  "Local State",
]);
const maximumPublicIconPngBytes = 256 * 1024;
const maximumPublicMasterPngBytes = 2 * 1024 * 1024;
const publicPngAssets = new Map<
  string,
  { expectedSize: number; maximumBytes: number; sizeLimit: string }
>([
  [
    "packages/extension/assets/browser-profile-title-bridge-master.png",
    {
      expectedSize: 1254,
      maximumBytes: maximumPublicMasterPngBytes,
      sizeLimit: "2 MiB",
    },
  ],
  [
    "packages/extension/public/icons/icon-16.png",
    {
      expectedSize: 16,
      maximumBytes: maximumPublicIconPngBytes,
      sizeLimit: "256 KiB",
    },
  ],
  [
    "packages/extension/public/icons/icon-32.png",
    {
      expectedSize: 32,
      maximumBytes: maximumPublicIconPngBytes,
      sizeLimit: "256 KiB",
    },
  ],
  [
    "packages/extension/public/icons/icon-48.png",
    {
      expectedSize: 48,
      maximumBytes: maximumPublicIconPngBytes,
      sizeLimit: "256 KiB",
    },
  ],
  [
    "packages/extension/public/icons/icon-128.png",
    {
      expectedSize: 128,
      maximumBytes: maximumPublicIconPngBytes,
      sizeLimit: "256 KiB",
    },
  ],
]);
const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const secretPatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\/(?:Users|home)\/[A-Za-z][^\s/"']+\//,
];

function pngCrc32(content: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function publicPngIssues(
  path: string,
  content: Buffer,
  expectedSize: number,
  maximumBytes: number,
  sizeLimit: string,
): string[] {
  const issue = (message: string): string[] => [`${path}: ${message}`];
  if (content.byteLength > maximumBytes) {
    return issue(`public PNG exceeds ${sizeLimit}`);
  }
  if (
    content.byteLength < 33 ||
    !content.subarray(0, pngSignature.length).equals(pngSignature) ||
    content.readUInt32BE(8) !== 13 ||
    content.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return issue("invalid PNG signature or IHDR header");
  }

  const width = content.readUInt32BE(16);
  const height = content.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    return issue(`expected ${expectedSize} × ${expectedSize} PNG dimensions`);
  }
  if (
    content[24] !== 8 ||
    content[25] !== 6 ||
    content[26] !== 0 ||
    content[27] !== 0 ||
    content[28] > 1
  ) {
    return issue("public icon must use 8-bit RGBA PNG encoding");
  }
  if (content.readUInt32BE(29) !== pngCrc32(content.subarray(12, 29))) {
    return issue("invalid PNG IHDR checksum");
  }
  return [];
}

export function publicRegistryIssues(content: string): string[] {
  const issues: string[] = [];
  try {
    const lock: unknown = Bun.JSON5.parse(content);
    if (
      typeof lock !== "object" ||
      lock === null ||
      !("packages" in lock) ||
      typeof lock.packages !== "object" ||
      lock.packages === null
    ) {
      return ["bun.lock: invalid package table"];
    }
    for (const entry of Object.values(lock.packages)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") {
        issues.push("bun.lock: invalid package entry");
        continue;
      }
      if (entry.length === 1 && entry[0].includes("@workspace:")) continue;
      const tarball =
        typeof entry[1] === "string" ? new URL(entry[1]) : undefined;
      if (
        tarball?.origin !== "https://registry.npmjs.org" ||
        tarball.username ||
        tarball.password ||
        tarball.search ||
        tarball.hash
      ) {
        issues.push(
          "bun.lock: package tarballs must use the public npm registry without credentials",
        );
      }
    }
  } catch {
    issues.push("bun.lock: invalid lockfile or registry URL");
  }
  return [...new Set(issues)];
}

export async function publicSourceIssues(directory: string): Promise<string[]> {
  const issues: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const file = join(current, entry.name);
      const display = relative(directory, file);
      if (entry.isSymbolicLink()) {
        issues.push(`${display}: source symlinks are not permitted`);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(file);
        continue;
      }
      if (forbiddenNames.has(basename(file)) || entry.name.startsWith(".env")) {
        issues.push(`${display}: local state or environment file in source`);
        continue;
      }
      const info = await lstat(file);
      if (info.size > 2 * 1024 * 1024) {
        issues.push(`${display}: unexpected large source file`);
        continue;
      }
      const content = await readFile(file);
      const publicPngAsset = publicPngAssets.get(display);
      if (publicPngAsset !== undefined) {
        issues.push(
          ...publicPngIssues(
            display,
            content,
            publicPngAsset.expectedSize,
            publicPngAsset.maximumBytes,
            publicPngAsset.sizeLimit,
          ),
        );
        continue;
      }
      if (content.includes(0)) {
        issues.push(`${display}: unexpected binary source file`);
        continue;
      }
      const text = content.toString("utf8");
      if (display === "bun.lock") issues.push(...publicRegistryIssues(text));
      if (
        entry.name === ".npmrc" &&
        text.split(/\r?\n/).some((line) => {
          const value = line.trim();
          return (
            value !== "" &&
            !value.startsWith("#") &&
            value !== "registry=https://registry.npmjs.org/"
          );
        })
      )
        issues.push(
          `${display}: only the public npm registry may be configured in source`,
        );
      for (const pattern of secretPatterns) {
        if (pattern.test(text))
          issues.push(
            `${display}: possible credential or personal absolute path`,
          );
      }
    }
  }
  await visit(directory);
  return issues;
}

if (import.meta.main) {
  const issues = await publicSourceIssues(root);
  const attribution = await readFile(join(root, "ATTRIBUTION.md"), "utf8");
  if (!attribution.includes("542a47d0592a293d2eec8ba126d08bf1729dc18b")) {
    issues.push("ATTRIBUTION.md: missing pinned upstream provenance");
  }
  const license = await readFile(
    join(root, "packages", "obsidian", "LICENSE"),
    "utf8",
  );
  if (!license.includes("Copyright 2024 Matt Furden")) {
    issues.push("packages/obsidian/LICENSE: missing upstream copyright");
  }
  if (issues.length > 0) {
    for (const issue of issues) console.error(issue);
    process.exitCode = 1;
  } else {
    console.log(
      "Public source checks passed; no runtime state, obvious credentials or personal paths found.",
    );
  }
}

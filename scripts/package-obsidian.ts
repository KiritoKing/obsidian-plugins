import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginId = "browser-profile-link-title";
const inputFileNames = [
  "LICENSE",
  "README.md",
  "main.js",
  "manifest.json",
  "styles.css",
] as const;
const rawOutputNames = ["main.js", "manifest.json", "styles.css"] as const;
const maxFileBytes: Record<(typeof inputFileNames)[number], number> = {
  LICENSE: 256 * 1024,
  "README.md": 256 * 1024,
  "main.js": 8 * 1024 * 1024,
  "manifest.json": 64 * 1024,
  "styles.css": 512 * 1024,
};
const maxTotalBytes = Object.values(maxFileBytes).reduce(
  (total, size) => total + size,
  0,
);
const maxArchiveBytes = maxTotalBytes + 1024 * 1024;
const toolOutputLimit = maxArchiveBytes;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PluginManifest {
  id: string;
  version: string;
  minAppVersion: string;
}

export interface PackageObsidianOptions {
  root?: string;
  inputDir?: string;
  outputDir: string;
}

export interface PackageObsidianResult {
  archivePath: string;
  outputPaths: string[];
  sha256: Record<string, string>;
}

interface ExecFileOptions {
  cwd?: string;
  maxBuffer?: number;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value)
  );
}

function parseManifest(content: Buffer, label: string): PluginManifest {
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error(`${label}: manifest.json is not valid JSON`);
  }

  if (!isRecord(value)) {
    throw new Error(`${label}: manifest.json must contain an object`);
  }
  if (value.id !== pluginId) {
    throw new Error(`${label}: manifest id must be ${pluginId}`);
  }
  if (!isVersion(value.version)) {
    throw new Error(`${label}: manifest version must be a semantic version`);
  }
  if (!isVersion(value.minAppVersion)) {
    throw new Error(
      `${label}: manifest minAppVersion must be a semantic version`,
    );
  }

  return {
    id: value.id,
    version: value.version,
    minAppVersion: value.minAppVersion,
  };
}

async function runTool(
  command: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<Buffer> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const env = { ...process.env };
    for (const name of ["ZIP", "ZIPOPT", "UNZIP", "UNZIPOPT", "ZIPINFOOPT"]) {
      delete env[name];
    }

    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        encoding: "buffer",
        env,
        maxBuffer: options.maxBuffer ?? toolOutputLimit,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = Buffer.isBuffer(stderr)
            ? stderr.toString("utf8").trim()
            : String(stderr).trim();
          rejectPromise(
            new Error(
              `${command} failed${detail ? `: ${detail}` : `: ${error.message}`}`,
            ),
          );
          return;
        }
        resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

async function requireArchiveTools(): Promise<void> {
  for (const [command, args] of [
    ["zip", ["-v"]],
    ["unzip", ["-v"]],
  ] as const) {
    try {
      await runTool(command, [...args]);
    } catch (error) {
      throw new Error(
        `Required system tool '${command}' is unavailable or failed; install zip and unzip and ensure both are on PATH. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function readRegularFile(
  path: string,
  maximumSize: number,
  label: string,
): Promise<Buffer> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label}: symbolic links are not permitted`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${label}: expected a regular file`);
  }
  if (metadata.size < 1 || metadata.size > maximumSize) {
    throw new Error(
      `${label}: file size must be between 1 and ${maximumSize} bytes`,
    );
  }

  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(
      `${label}: could not open regular file safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const openedMetadata = await file.stat();
    if (!openedMetadata.isFile()) {
      throw new Error(`${label}: expected a regular file`);
    }
    const content = await file.readFile();
    if (content.byteLength < 1 || content.byteLength > maximumSize) {
      throw new Error(
        `${label}: file size must be between 1 and ${maximumSize} bytes`,
      );
    }
    return content;
  } finally {
    await file.close();
  }
}

async function readAllowlistedInputs(
  inputDir: string,
): Promise<Map<string, Buffer>> {
  const inputMetadata = await lstat(inputDir);
  if (inputMetadata.isSymbolicLink()) {
    throw new Error("Obsidian build input directory must not be a symlink");
  }
  if (!inputMetadata.isDirectory()) {
    throw new Error("Obsidian build input path must be a directory");
  }

  const entries = await readdir(inputDir, { withFileTypes: true });
  const actualNames = entries.map((entry) => entry.name).sort();
  const expectedNames = [...inputFileNames].sort();
  const actualNameSet = new Set(actualNames);
  const expectedNameSet = new Set<string>(expectedNames);
  const unexpectedNames = actualNames.filter(
    (name) => !expectedNameSet.has(name),
  );
  const missingNames = expectedNames.filter((name) => !actualNameSet.has(name));
  if (unexpectedNames.length > 0 || missingNames.length > 0) {
    const problems = [
      ...unexpectedNames.map((name) => `unexpected input file: ${name}`),
      ...missingNames.map((name) => `missing input file: ${name}`),
    ];
    throw new Error(
      `Obsidian build input is not allowlisted: ${problems.join("; ")}`,
    );
  }

  const files = new Map<string, Buffer>();
  for (const name of inputFileNames) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry || entry.isSymbolicLink()) {
      throw new Error(`${name}: symbolic links are not permitted`);
    }
    if (!entry.isFile()) {
      throw new Error(`${name}: expected a regular file`);
    }
    files.set(
      name,
      await readRegularFile(join(inputDir, name), maxFileBytes[name], name),
    );
  }
  return files;
}

function archiveFilePaths(): string[] {
  return inputFileNames.map((name) => `${pluginId}/${name}`);
}

async function verifyArchive(
  archivePath: string,
  inputFiles: Map<string, Buffer>,
): Promise<void> {
  await runTool("unzip", ["-tqq", archivePath]);
  const listing = (await runTool("unzip", ["-Z1", archivePath]))
    .toString("utf8")
    .split(/\r?\n/)
    .filter((entry) => entry.length > 0);
  const expectedFiles = new Set(archiveFilePaths());
  const seenFiles = new Set<string>();

  for (const entry of listing) {
    if (entry === `${pluginId}/`) {
      continue;
    }
    if (!expectedFiles.has(entry)) {
      throw new Error(`ZIP contains an unexpected path: ${entry}`);
    }
    if (seenFiles.has(entry)) {
      throw new Error(`ZIP contains a duplicate path: ${entry}`);
    }
    seenFiles.add(entry);
  }

  if (
    seenFiles.size !== expectedFiles.size ||
    [...expectedFiles].some((entry) => !seenFiles.has(entry))
  ) {
    throw new Error("ZIP does not contain the exact allowlisted plugin files");
  }

  for (const name of inputFileNames) {
    const archived = await runTool("unzip", [
      "-p",
      archivePath,
      `${pluginId}/${name}`,
    ]);
    const expected = inputFiles.get(name);
    if (!expected || sha256(archived) !== sha256(expected)) {
      throw new Error(`ZIP content hash does not match input: ${name}`);
    }
  }
}

async function writeExclusive(
  path: string,
  content: Buffer,
  onCreated: (path: string) => void,
): Promise<void> {
  const file = await open(path, "wx", 0o644);
  onCreated(path);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function packageObsidian(
  options: PackageObsidianOptions,
): Promise<PackageObsidianResult> {
  const root = resolve(options.root ?? repositoryRoot);
  const inputDir = resolve(options.inputDir ?? join(root, "dist", pluginId));
  const outputDir = resolve(options.outputDir);
  if (inputDir === outputDir || outputDir.startsWith(`${inputDir}/`)) {
    throw new Error(
      "Output directory must be outside the Obsidian build input directory",
    );
  }

  const canonicalManifestBytes = await readRegularFile(
    join(root, "packages", "obsidian", "manifest.json"),
    maxFileBytes["manifest.json"],
    "packages/obsidian/manifest.json",
  );
  const canonicalManifest = parseManifest(
    canonicalManifestBytes,
    "packages/obsidian/manifest.json",
  );
  const inputFiles = await readAllowlistedInputs(inputDir);
  const buildManifest = parseManifest(
    inputFiles.get("manifest.json") as Buffer,
    "build output",
  );
  if (
    buildManifest.id !== canonicalManifest.id ||
    buildManifest.version !== canonicalManifest.version ||
    buildManifest.minAppVersion !== canonicalManifest.minAppVersion
  ) {
    throw new Error(
      "Build output manifest id, version, and minAppVersion must match packages/obsidian/manifest.json",
    );
  }

  const archiveName = `${pluginId}-${canonicalManifest.version}.zip`;
  const targetNames = [...rawOutputNames, archiveName];
  const outputMetadata = await lstatIfPresent(outputDir);
  if (outputMetadata?.isSymbolicLink()) {
    throw new Error("Output directory must not be a symlink");
  }
  if (outputMetadata && !outputMetadata.isDirectory()) {
    throw new Error("Output path must be a directory");
  }
  if (outputMetadata) {
    const existing = await Promise.all(
      targetNames.map(
        async (name) =>
          [name, await lstatIfPresent(join(outputDir, name))] as const,
      ),
    );
    const collisions = existing
      .filter(([, metadata]) => metadata !== undefined)
      .map(([name]) => name);
    if (collisions.length > 0) {
      throw new Error(
        `Refusing to overwrite existing output: ${collisions.join(", ")}`,
      );
    }
  }

  await requireArchiveTools();
  const temporaryDir = await mkdtemp(
    join(tmpdir(), "obsidian-release-package-"),
  );
  const createdOutputPaths: string[] = [];

  try {
    const stagedPluginDir = join(temporaryDir, pluginId);
    await mkdir(stagedPluginDir);
    for (const name of inputFileNames) {
      const stagedPath = join(stagedPluginDir, name);
      const originalBytes = inputFiles.get(name);
      if (!originalBytes) {
        throw new Error(`Missing validated build input: ${name}`);
      }
      await writeFile(stagedPath, originalBytes, { flag: "wx" });
      const stagedBytes = await readFile(stagedPath);
      if (sha256(stagedBytes) !== sha256(originalBytes)) {
        throw new Error(`Staged content hash does not match input: ${name}`);
      }
    }

    const archivePath = join(temporaryDir, archiveName);
    await runTool("zip", ["-X", "-q", "-r", archivePath, pluginId], {
      cwd: temporaryDir,
    });
    const archiveStat = await lstat(archivePath);
    if (
      !archiveStat.isFile() ||
      archiveStat.size < 1 ||
      archiveStat.size > maxArchiveBytes
    ) {
      throw new Error("Generated ZIP has an unexpected file type or size");
    }
    await verifyArchive(archivePath, inputFiles);
    const archiveBytes = await readFile(archivePath);
    await mkdir(outputDir, { recursive: true });
    const finalOutputMetadata = await lstat(outputDir);
    if (
      finalOutputMetadata.isSymbolicLink() ||
      !finalOutputMetadata.isDirectory()
    ) {
      throw new Error("Output path must be a regular directory, not a symlink");
    }
    const finalCollisions = await Promise.all(
      targetNames.map(
        async (name) =>
          [name, await lstatIfPresent(join(outputDir, name))] as const,
      ),
    );
    const existingTargets = finalCollisions
      .filter(([, metadata]) => metadata !== undefined)
      .map(([name]) => name);
    if (existingTargets.length > 0) {
      throw new Error(
        `Refusing to overwrite existing output: ${existingTargets.join(", ")}`,
      );
    }

    const outputs = new Map<string, Buffer>();
    for (const name of rawOutputNames) {
      outputs.set(name, inputFiles.get(name) as Buffer);
    }
    outputs.set(archiveName, archiveBytes);

    for (const [name, content] of outputs) {
      const outputPath = join(outputDir, name);
      await writeExclusive(outputPath, content, (createdPath) => {
        createdOutputPaths.push(createdPath);
      });
    }

    const hashes: Record<string, string> = {};
    for (const [name, expectedContent] of outputs) {
      const outputBytes = await readFile(join(outputDir, name));
      const outputHash = sha256(outputBytes);
      if (outputHash !== sha256(expectedContent)) {
        throw new Error(`Output readback hash does not match source: ${name}`);
      }
      hashes[name] = outputHash;
    }

    return {
      archivePath: join(outputDir, archiveName),
      outputPaths: [...outputs.keys()].map((name) => join(outputDir, name)),
      sha256: hashes,
    };
  } catch (error) {
    await Promise.all(
      createdOutputPaths.map((path) => rm(path, { force: true })),
    );
    throw error;
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

function parseOutputArgument(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--output" || args[1] === "") {
    throw new Error(
      "Usage: bun run scripts/package-obsidian.ts --output <directory>",
    );
  }
  return args[1];
}

if (import.meta.main) {
  try {
    const outputDir = parseOutputArgument(process.argv.slice(2));
    const result = await packageObsidian({ outputDir });
    console.log("Obsidian release package created:");
    for (const path of result.outputPaths) {
      const name = basename(path);
      console.log(`${path} sha256=${result.sha256[name]}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

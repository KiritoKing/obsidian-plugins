import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoSymlinkComponents,
  createExclusiveFile,
  identityOf,
  lstatIfExists,
  sameIdentity,
  unlinkIfOwned,
  type FileIdentity,
} from "../src/runtime-files.ts";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(packageDirectory, "../../.output/native-host");
const outputPath = resolve(outputDirectory, "browser-profile-title-host");
const receiptPath = `${outputPath}.build-receipt.json`;
const buildLockPath = `${outputPath}.build.lock`;
const format = "chlrc-native-host-standalone-v1" as const;
const bunBuildResiduePattern = /^\.[a-f0-9]+-\d+\.bun-build$/;

type BuildReceipt = {
  format: typeof format;
  platform: string;
  arch: string;
  sha256: string;
};

type ExistingBuild = {
  binary: FileIdentity;
  receipt: FileIdentity;
};

async function hashFile(path: string): Promise<string> {
  return await new Promise<string>((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", () => resolveHash(hash.digest("hex")));
  });
}

function isReceipt(value: unknown): value is BuildReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt).sort();
  return (
    keys.join(",") === "arch,format,platform,sha256" &&
    receipt.format === format &&
    typeof receipt.platform === "string" &&
    typeof receipt.arch === "string" &&
    typeof receipt.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(receipt.sha256)
  );
}

async function inspectExistingBuild(): Promise<ExistingBuild | undefined> {
  await assertNoSymlinkComponents(outputPath);
  await assertNoSymlinkComponents(receiptPath);
  const [binaryStats, receiptStats] = await Promise.all([
    lstatIfExists(outputPath),
    lstatIfExists(receiptPath),
  ]);
  if (!binaryStats && !receiptStats) return undefined;
  if (!binaryStats || !receiptStats) {
    throw new Error(
      "Existing native host output is incomplete; refusing to overwrite it",
    );
  }
  if (
    !binaryStats.isFile() ||
    binaryStats.isSymbolicLink() ||
    (binaryStats.mode & 0o111) === 0
  ) {
    throw new Error(
      "Existing native host output is not a regular executable; refusing to overwrite it",
    );
  }
  if (
    !receiptStats.isFile() ||
    receiptStats.isSymbolicLink() ||
    (receiptStats.mode & 0o077) !== 0
  ) {
    throw new Error(
      "Existing native host build receipt is unsafe; refusing to overwrite it",
    );
  }
  let receiptValue: unknown;
  try {
    receiptValue = JSON.parse(await Bun.file(receiptPath).text());
  } catch {
    throw new Error(
      "Existing native host build receipt is invalid; refusing to overwrite it",
    );
  }
  if (
    !isReceipt(receiptValue) ||
    receiptValue.platform !== process.platform ||
    receiptValue.arch !== process.arch
  ) {
    throw new Error(
      "Existing native host receipt does not identify this build; refusing to overwrite it",
    );
  }
  if ((await hashFile(outputPath)) !== receiptValue.sha256) {
    throw new Error(
      "Existing native host output does not match its receipt; refusing to overwrite it",
    );
  }
  return { binary: identityOf(binaryStats), receipt: identityOf(receiptStats) };
}

async function sameExistingBuild(
  expected: ExistingBuild | undefined,
): Promise<boolean> {
  const actual = await inspectExistingBuild();
  if (!expected || !actual) return expected === actual;
  return (
    expected.binary.dev === actual.binary.dev &&
    expected.binary.ino === actual.binary.ino &&
    expected.receipt.dev === actual.receipt.dev &&
    expected.receipt.ino === actual.receipt.ino
  );
}

async function writeReceipt(
  path: string,
  receipt: BuildReceipt,
): Promise<FileIdentity> {
  return await createExclusiveFile(path, `${JSON.stringify(receipt)}\n`);
}

async function assertPublishedIdentity(
  path: string,
  identity: FileIdentity | undefined,
): Promise<void> {
  if (!identity)
    throw new Error(
      "Native host build publication did not create its expected file",
    );
  const stats = await lstat(path);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    !sameIdentity(identity, stats)
  ) {
    throw new Error("Native host build output changed during publication");
  }
}

async function smokeStandalone(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn([outputPath, ...args], {
    cwd: outputDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!child.stdout || !child.stderr) {
    child.kill();
    throw new Error(
      "Native host standalone smoke could not capture its output",
    );
  }
  const timeout = setTimeout(() => child.kill(), 5_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyStandaloneEntrypoints(stateBase: string): Promise<void> {
  const help = await smokeStandalone(["--help"]);
  if (
    help.exitCode !== 0 ||
    !help.stdout.includes("Usage:") ||
    help.stdout.includes("AUTHENTICATION_FAILED") ||
    help.stderr.length > 0
  ) {
    throw new Error("Native host standalone --help smoke failed");
  }

  const doctor = await smokeStandalone([
    "doctor",
    "--channel",
    "build-smoke",
    "--state-base",
    stateBase,
  ]);
  if (
    doctor.exitCode !== 0 ||
    doctor.stdout.trim() !==
      "Runtime state: not-configured (channel: build-smoke)" ||
    doctor.stderr.length > 0
  ) {
    throw new Error("Native host standalone doctor smoke failed");
  }
}

await assertNoSymlinkComponents(outputDirectory);
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const outputDirectoryStats = await lstat(outputDirectory);
if (
  !outputDirectoryStats.isDirectory() ||
  outputDirectoryStats.isSymbolicLink()
) {
  throw new Error("Native host build output directory is unsafe");
}

const lockIdentity = await createExclusiveFile(
  buildLockPath,
  `pid=${process.pid}\n`,
);
const suffix = randomBytes(16).toString("hex");
const stagedBinaryPath = resolve(
  outputDirectory,
  `.${basename(outputPath)}.${suffix}.tmp`,
);
const stagedReceiptPath = `${stagedBinaryPath}.build-receipt.json`;
const backupBinaryPath = `${stagedBinaryPath}.previous`;
const backupReceiptPath = `${stagedReceiptPath}.previous`;
let initialBuild: ExistingBuild | undefined;
let stagedBinaryIdentity: FileIdentity | undefined;
let stagedReceiptIdentity: FileIdentity | undefined;
let backupBinaryIdentity: FileIdentity | undefined;
let backupReceiptIdentity: FileIdentity | undefined;
let publishedBinaryIdentity: FileIdentity | undefined;
let publishedReceiptIdentity: FileIdentity | undefined;
let preserveBackups = false;
const preexistingBunBuildResidue = new Set<string>();

try {
  for (const name of await readdir(outputDirectory)) {
    if (bunBuildResiduePattern.test(name)) preexistingBunBuildResidue.add(name);
  }
  if (
    (await lstatIfExists(stagedBinaryPath)) ||
    (await lstatIfExists(stagedReceiptPath)) ||
    (await lstatIfExists(backupBinaryPath)) ||
    (await lstatIfExists(backupReceiptPath))
  ) {
    throw new Error(
      "A temporary native host build path already exists; refusing to overwrite it",
    );
  }
  initialBuild = await inspectExistingBuild();
  const child = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      resolve(packageDirectory, "src/cli.ts"),
      "--outfile",
      stagedBinaryPath,
    ],
    {
      cwd: outputDirectory,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await child.exited;
  const stagedBinaryStats = await lstatIfExists(stagedBinaryPath);
  if (stagedBinaryStats?.isFile() && !stagedBinaryStats.isSymbolicLink()) {
    stagedBinaryIdentity = identityOf(stagedBinaryStats);
  }
  if (exitCode !== 0) throw new Error("Native host standalone build failed");
  if (!stagedBinaryStats?.isFile() || stagedBinaryStats.isSymbolicLink()) {
    throw new Error("Native host build did not produce a regular executable");
  }

  await chmod(stagedBinaryPath, 0o755);
  stagedBinaryIdentity = identityOf(await lstat(stagedBinaryPath));
  const receipt: BuildReceipt = {
    format,
    platform: process.platform,
    arch: process.arch,
    sha256: await hashFile(stagedBinaryPath),
  };
  stagedReceiptIdentity = await writeReceipt(stagedReceiptPath, receipt);

  if (!(await sameExistingBuild(initialBuild))) {
    throw new Error(
      "Native host build output changed during compilation; refusing to overwrite it",
    );
  }

  if (initialBuild) {
    await link(outputPath, backupBinaryPath);
    backupBinaryIdentity = identityOf(await lstat(backupBinaryPath));
    await link(receiptPath, backupReceiptPath);
    backupReceiptIdentity = identityOf(await lstat(backupReceiptPath));
    if (!(await sameExistingBuild(initialBuild))) {
      throw new Error(
        "Native host build output changed before publication; refusing to overwrite it",
      );
    }
    await rename(stagedBinaryPath, outputPath);
    stagedBinaryIdentity = undefined;
    publishedBinaryIdentity = identityOf(await lstat(outputPath));
  } else {
    await link(stagedBinaryPath, outputPath);
    await unlink(stagedBinaryPath);
    stagedBinaryIdentity = undefined;
    publishedBinaryIdentity = identityOf(await lstat(outputPath));
  }

  if (initialBuild) {
    await rename(stagedReceiptPath, receiptPath);
    stagedReceiptIdentity = undefined;
    publishedReceiptIdentity = identityOf(await lstat(receiptPath));
  } else {
    await link(stagedReceiptPath, receiptPath);
    await unlink(stagedReceiptPath);
    stagedReceiptIdentity = undefined;
    publishedReceiptIdentity = identityOf(await lstat(receiptPath));
  }

  const finalBuild = await inspectExistingBuild();
  if (
    !finalBuild ||
    finalBuild.binary.dev !== publishedBinaryIdentity.dev ||
    finalBuild.binary.ino !== publishedBinaryIdentity.ino ||
    finalBuild.receipt.dev !== publishedReceiptIdentity.dev ||
    finalBuild.receipt.ino !== publishedReceiptIdentity.ino
  ) {
    throw new Error(
      "Native host standalone output failed publication readback",
    );
  }
  await chmod(outputPath, 0o755);
  const chmodStats = await lstat(outputPath);
  if ((chmodStats.mode & 0o777) !== 0o755)
    throw new Error("Native host executable permissions could not be secured");
  await verifyStandaloneEntrypoints(
    resolve(outputDirectory, `.doctor-smoke-${suffix}`),
  );

  await unlinkIfOwned(backupBinaryPath, backupBinaryIdentity).catch(
    () => undefined,
  );
  await unlinkIfOwned(backupReceiptPath, backupReceiptIdentity).catch(
    () => undefined,
  );
  console.log(
    "Native host standalone executable and local build receipt created.",
  );
} catch (error) {
  let rollbackFailed = false;
  if (publishedReceiptIdentity) {
    try {
      await assertPublishedIdentity(receiptPath, publishedReceiptIdentity);
      if (initialBuild) await rename(backupReceiptPath, receiptPath);
      else await unlinkIfOwned(receiptPath, publishedReceiptIdentity);
    } catch {
      rollbackFailed = true;
    }
  }
  if (publishedBinaryIdentity) {
    try {
      await assertPublishedIdentity(outputPath, publishedBinaryIdentity);
      if (initialBuild) await rename(backupBinaryPath, outputPath);
      else await unlinkIfOwned(outputPath, publishedBinaryIdentity);
    } catch {
      rollbackFailed = true;
    }
  }
  preserveBackups = rollbackFailed;
  if (rollbackFailed) {
    throw new Error(
      "Native host publication failed and rollback could not safely complete; previous build backups were preserved",
    );
  }
  throw error;
} finally {
  await unlinkIfOwned(stagedBinaryPath, stagedBinaryIdentity).catch(
    () => undefined,
  );
  await unlinkIfOwned(stagedReceiptPath, stagedReceiptIdentity).catch(
    () => undefined,
  );
  if (!preserveBackups) {
    await unlinkIfOwned(backupBinaryPath, backupBinaryIdentity).catch(
      () => undefined,
    );
    await unlinkIfOwned(backupReceiptPath, backupReceiptIdentity).catch(
      () => undefined,
    );
  }
  const currentEntries = await readdir(outputDirectory).catch(() => []);
  for (const name of currentEntries) {
    if (
      !bunBuildResiduePattern.test(name) ||
      preexistingBunBuildResidue.has(name)
    ) {
      continue;
    }
    const residuePath = resolve(outputDirectory, name);
    const residueStats = await lstatIfExists(residuePath).catch(
      () => undefined,
    );
    if (residueStats?.isFile() && !residueStats.isSymbolicLink()) {
      await unlinkIfOwned(residuePath, identityOf(residueStats)).catch(
        () => undefined,
      );
    }
  }
  await unlinkIfOwned(buildLockPath, lockIdentity).catch(() => undefined);
}

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  HOST_NAME,
  isConnectionInfo,
  validChannel,
} from "@chlrc/browser-profile-title-protocol";
import {
  DEVELOPMENT_NATIVE_MESSAGING_ORIGIN,
  SUPPORTED_NATIVE_MESSAGING_ORIGINS,
} from "@chlrc/browser-profile-title-protocol/identity";
import {
  SOCKET_BASENAME,
  channelDirectory,
  connectionFile,
  stateBaseDirectory,
} from "@chlrc/browser-profile-title-protocol/paths";
import {
  assertNoSymlinkComponents,
  assertPrivateDirectory,
  createExclusiveFile,
  ensureDirectory,
  identityOf,
  isErrno,
  lstatIfExists,
  sameIdentity,
  unlinkIfOwned,
  type FileIdentity,
} from "./runtime-files.ts";
import { probeSocket } from "./bridge-server.ts";

export type BrowserName = "chrome" | "chromium" | "edge";

export type NativeHostManifest = {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
};

export type InstallOptions = {
  browser?: BrowserName;
  binaryPath?: string;
  stateDir?: string;
  replace?: boolean;
  dryRun?: boolean;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  xdgConfigHome?: string;
};

export type InstallResult = {
  manifestPath: string;
  manifest: NativeHostManifest;
  dryRun: boolean;
  replaced: boolean;
};

const BUILD_RECEIPT_SUFFIX = ".build-receipt.json";
const BUILD_RECEIPT_FORMAT = "chlrc-native-host-standalone-v1" as const;
const NATIVE_HOST_FILE = `${HOST_NAME}.json`;
const NATIVE_HOST_DESCRIPTION =
  "Local browser profile title bridge for Obsidian";

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", () => resolveHash(hash.digest("hex")));
  });
}

function isBrowserName(value: unknown): value is BrowserName {
  return value === "chrome" || value === "chromium" || value === "edge";
}

export function browserUserDataDirectory(options: {
  browser: BrowserName;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  xdgConfigHome?: string;
}): string {
  const platform = options.platform ?? process.platform;
  const home = options.homeDirectory ?? homedir();
  if (platform === "darwin") {
    const productDirectory =
      options.browser === "chrome"
        ? "Google/Chrome"
        : options.browser === "edge"
          ? "Microsoft Edge"
          : "Chromium";
    return join(home, "Library", "Application Support", productDirectory);
  }
  if (platform === "linux") {
    const configHome =
      options.xdgConfigHome ??
      process.env.XDG_CONFIG_HOME ??
      join(home, ".config");
    const productDirectory =
      options.browser === "chrome"
        ? "google-chrome"
        : options.browser === "edge"
          ? "microsoft-edge"
          : "chromium";
    return join(configHome, productDirectory);
  }
  throw new Error(
    "Native Messaging installation supports macOS and Linux only",
  );
}

async function validateStandaloneBinary(
  binaryPath: string,
  platform: string,
  arch: string,
): Promise<string> {
  const absolute = resolve(binaryPath);
  await assertNoSymlinkComponents(absolute);
  const binaryStats = await lstat(absolute);
  if (
    !binaryStats.isFile() ||
    binaryStats.isSymbolicLink() ||
    (binaryStats.mode & 0o111) === 0
  ) {
    throw new Error(
      "A built executable file is required for Native Messaging installation",
    );
  }
  const realBinary = await realpath(absolute);
  if (realBinary !== absolute)
    throw new Error("The host executable cannot be a symbolic link");
  if (
    basename(absolute).toLowerCase() === "bun" ||
    basename(absolute).toLowerCase() === "node"
  ) {
    throw new Error(
      "The Native Messaging host must be a standalone executable, not a runtime interpreter",
    );
  }

  const receiptPath = `${absolute}${BUILD_RECEIPT_SUFFIX}`;
  await assertNoSymlinkComponents(receiptPath);
  const receiptStats = await lstatIfExists(receiptPath);
  if (
    !receiptStats?.isFile() ||
    receiptStats.isSymbolicLink() ||
    (receiptStats.mode & 0o077) !== 0
  ) {
    throw new Error("The standalone host build receipt is missing or unsafe");
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch {
    throw new Error("The standalone host build receipt is invalid");
  }
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !("format" in receipt) ||
    receipt.format !== BUILD_RECEIPT_FORMAT ||
    !("platform" in receipt) ||
    receipt.platform !== platform ||
    !("arch" in receipt) ||
    receipt.arch !== arch ||
    !("sha256" in receipt) ||
    typeof receipt.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256)
  ) {
    throw new Error(
      "The standalone host build receipt does not match this executable",
    );
  }
  if ((await sha256File(absolute)) !== receipt.sha256) {
    throw new Error(
      "The standalone host build receipt does not match this executable",
    );
  }
  return absolute;
}

function hasNativeHostManifestShape(
  value: unknown,
): value is NativeHostManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  const keys = Object.keys(manifest).sort();
  const expected = [
    "allowed_origins",
    "description",
    "name",
    "path",
    "type",
  ].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    manifest.name === HOST_NAME &&
    manifest.type === "stdio" &&
    manifest.description === NATIVE_HOST_DESCRIPTION &&
    typeof manifest.path === "string" &&
    isAbsolute(manifest.path) &&
    Array.isArray(manifest.allowed_origins)
  );
}

function hasExpectedOrigins(
  origins: string[],
  expected: readonly string[],
): boolean {
  return (
    origins.length === expected.length &&
    origins.every((origin, index) => origin === expected[index])
  );
}

function isOwnedManifest(value: unknown): value is NativeHostManifest {
  if (!hasNativeHostManifestShape(value)) return false;
  return (
    hasExpectedOrigins(value.allowed_origins, [
      DEVELOPMENT_NATIVE_MESSAGING_ORIGIN,
    ]) ||
    hasExpectedOrigins(
      value.allowed_origins,
      SUPPORTED_NATIVE_MESSAGING_ORIGINS,
    )
  );
}

function exactManifest(value: unknown): value is NativeHostManifest {
  return (
    isOwnedManifest(value) &&
    hasExpectedOrigins(
      value.allowed_origins,
      SUPPORTED_NATIVE_MESSAGING_ORIGINS,
    )
  );
}

async function assertReplaceableManifest(path: string): Promise<string> {
  const contents = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(
      "The existing Native Messaging manifest is not managed by this host",
    );
  }
  if (!isOwnedManifest(parsed)) {
    throw new Error(
      "The existing Native Messaging manifest is not managed by this host",
    );
  }
  return contents;
}

export async function installNativeMessagingManifest(
  options: InstallOptions = {},
): Promise<InstallResult> {
  const browser = options.browser ?? "chrome";
  if (!isBrowserName(browser))
    throw new Error("Choose Chrome, Chromium, or Edge");
  const platform = options.platform ?? process.platform;
  const arch = process.arch;
  const binaryPath = options.binaryPath ?? process.execPath;
  const absoluteBinary = await validateStandaloneBinary(
    binaryPath,
    platform,
    arch,
  );
  const userDataDirectory = options.stateDir
    ? resolve(options.stateDir)
    : browserUserDataDirectory({
        browser,
        platform,
        homeDirectory: options.homeDirectory,
        xdgConfigHome: options.xdgConfigHome,
      });
  const manifestDirectory = join(userDataDirectory, "NativeMessagingHosts");
  const manifestPath = join(manifestDirectory, NATIVE_HOST_FILE);
  await assertNoSymlinkComponents(manifestPath);
  const manifest: NativeHostManifest = {
    name: HOST_NAME,
    description: NATIVE_HOST_DESCRIPTION,
    path: absoluteBinary,
    type: "stdio",
    allowed_origins: [...SUPPORTED_NATIVE_MESSAGING_ORIGINS],
  };
  const existing = await lstatIfExists(manifestPath);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(
      "The existing Native Messaging manifest is not a regular file",
    );
  }
  if (existing && !options.replace) {
    throw new Error(
      "An existing Native Messaging manifest requires explicit --replace",
    );
  }
  if (existing && options.replace)
    await assertReplaceableManifest(manifestPath);
  if (options.dryRun) {
    return {
      manifestPath,
      manifest,
      dryRun: true,
      replaced: Boolean(existing),
    };
  }

  const ensured = await ensureDirectory(manifestDirectory);
  let lockIdentity: FileIdentity | undefined;
  let tempPath: string | undefined;
  let tempIdentity: FileIdentity | undefined;
  let targetIdentity: FileIdentity | undefined;
  const lockPath = `${manifestPath}.install.lock`;
  try {
    await assertPrivateDirectory(manifestDirectory);
    if (await lstatIfExists(lockPath))
      throw new Error(
        "Another Native Messaging manifest install is in progress",
      );
    try {
      lockIdentity = await createExclusiveFile(
        lockPath,
        `pid=${process.pid}\n`,
      );
    } catch (error) {
      if (isErrno(error, "EEXIST"))
        throw new Error(
          "Another Native Messaging manifest install is in progress",
        );
      throw error;
    }

    const latest = await lstatIfExists(manifestPath);
    if (latest?.isSymbolicLink() || (latest && !latest.isFile())) {
      throw new Error(
        "The existing Native Messaging manifest is not a regular file",
      );
    }
    if (latest && !options.replace) {
      throw new Error(
        "An existing Native Messaging manifest requires explicit --replace",
      );
    }
    let targetContents: string | undefined;
    if (latest) {
      targetContents = await assertReplaceableManifest(manifestPath);
      targetIdentity = identityOf(latest);
    }

    tempPath = join(
      manifestDirectory,
      `.${NATIVE_HOST_FILE}.${randomBytes(8).toString("hex")}.tmp`,
    );
    tempIdentity = await createExclusiveFile(
      tempPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const tempStats = await lstat(tempPath);
    if ((tempStats.mode & 0o777) !== 0o600)
      throw new Error("The manifest file permissions could not be secured");

    if (targetIdentity) {
      const beforeReplace = await lstatIfExists(manifestPath);
      const beforeContents = await readFile(manifestPath, "utf8");
      if (
        !beforeReplace ||
        !sameIdentity(targetIdentity, beforeReplace) ||
        beforeReplace.isSymbolicLink() ||
        beforeContents !== targetContents
      ) {
        throw new Error(
          "The existing Native Messaging manifest changed during installation",
        );
      }
      await rename(tempPath, manifestPath);
      tempIdentity = undefined;
    } else {
      await link(tempPath, manifestPath);
      await unlink(tempPath);
      tempIdentity = undefined;
    }
    await chmod(manifestPath, 0o600);
    const readback = await readFile(manifestPath, "utf8");
    const parsed: unknown = JSON.parse(readback);
    const installedStats = await lstat(manifestPath);
    if (
      !exactManifest(parsed) ||
      JSON.stringify(parsed) !== JSON.stringify(manifest) ||
      installedStats.isSymbolicLink() ||
      !installedStats.isFile() ||
      (installedStats.mode & 0o777) !== 0o600
    ) {
      throw new Error(
        "Native Messaging manifest readback did not match the requested configuration",
      );
    }
    return {
      manifestPath,
      manifest,
      dryRun: false,
      replaced: Boolean(targetIdentity),
    };
  } finally {
    if (tempPath)
      await unlinkIfOwned(tempPath, tempIdentity).catch(() => undefined);
    await unlinkIfOwned(lockPath, lockIdentity).catch(() => undefined);
    for (const directory of [...ensured.created].reverse()) {
      try {
        await rmdir(directory);
      } catch {
        // A concurrent writer or the installed manifest may keep the directory in place.
      }
    }
  }
}

export type RuntimeDoctorState =
  | "not-configured"
  | "active"
  | "stale-socket"
  | "stale-connection"
  | "stale-lock"
  | "unsafe-state";

export type RuntimeDoctorReport = {
  channel: string;
  state: RuntimeDoctorState;
};

export async function inspectRuntimeState(
  options: { channel?: string; stateBase?: string } = {},
): Promise<RuntimeDoctorReport> {
  const channel = options.channel ?? "default";
  if (!validChannel(channel))
    return { channel: "default", state: "unsafe-state" };
  const base = options.stateBase ?? stateBaseDirectory();
  const directory = channelDirectory(channel, base);
  const socketPath = join(directory, SOCKET_BASENAME);
  const connectionPath = connectionFile(channel, base);
  const lockPath = join(directory, "host.lock");
  try {
    await assertNoSymlinkComponents(directory);
    const directoryStats = await lstatIfExists(directory);
    if (!directoryStats) return { channel, state: "not-configured" };
    if (
      !directoryStats.isDirectory() ||
      directoryStats.isSymbolicLink() ||
      (directoryStats.mode & 0o777) !== 0o700
    ) {
      return { channel, state: "unsafe-state" };
    }

    const [socketStats, connectionStats, lockStats] = await Promise.all([
      lstatIfExists(socketPath),
      lstatIfExists(connectionPath),
      lstatIfExists(lockPath),
    ]);
    if (
      [socketStats, connectionStats, lockStats].some((stats) =>
        stats?.isSymbolicLink(),
      )
    ) {
      return { channel, state: "unsafe-state" };
    }
    if (
      socketStats &&
      (!socketStats.isSocket() || (socketStats.mode & 0o777) !== 0o600)
    ) {
      return { channel, state: "unsafe-state" };
    }
    if (
      connectionStats &&
      (!connectionStats.isFile() || (connectionStats.mode & 0o777) !== 0o600)
    ) {
      return { channel, state: "unsafe-state" };
    }
    if (
      lockStats &&
      (!lockStats.isFile() || (lockStats.mode & 0o777) !== 0o600)
    ) {
      return { channel, state: "unsafe-state" };
    }
    if (socketStats) {
      let validConnection = false;
      if (connectionStats) {
        try {
          const value: unknown = JSON.parse(
            await readFile(connectionPath, "utf8"),
          );
          validConnection =
            isConnectionInfo(value) &&
            value.channel === channel &&
            value.socketPath === socketPath;
        } catch {
          validConnection = false;
        }
      }
      if (validConnection && lockStats && (await probeSocket(socketPath))) {
        return { channel, state: "active" };
      }
      return { channel, state: "stale-socket" };
    }
    if (connectionStats) return { channel, state: "stale-connection" };
    if (lockStats) return { channel, state: "stale-lock" };
    return { channel, state: "not-configured" };
  } catch {
    return { channel, state: "unsafe-state" };
  }
}

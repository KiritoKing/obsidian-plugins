import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";

export type FileIdentity = { dev: number; ino: number };

export function identityOf(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

export function sameIdentity(left: FileIdentity, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function lstatIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

export function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export async function assertNoSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean)) {
    current = resolve(current, part);
    const stats = await lstatIfExists(current);
    if (!stats) continue;
    if (stats.isSymbolicLink())
      throw new Error("Unsafe symbolic link in local state path");
  }
}

export async function ensureDirectory(
  path: string,
  mode: 0o700 = 0o700,
): Promise<{ created: string[] }> {
  const absolute = resolve(path);
  await assertNoSymlinkComponents(absolute);
  const root = parse(absolute).root;
  const created: string[] = [];
  let current = root;
  for (const part of absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean)) {
    current = resolve(current, part);
    const existing = await lstatIfExists(current);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error("Local state path is not a directory");
      }
      continue;
    }
    try {
      await mkdir(current, { mode });
      created.push(current);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const raced = await lstat(current);
      if (!raced.isDirectory() || raced.isSymbolicLink()) {
        throw new Error("Local state path is not a directory");
      }
    }
  }
  return { created };
}

export async function assertPrivateDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700
  ) {
    throw new Error("Local state directory must be a private 0700 directory");
  }
}

export async function createExclusiveFile(
  path: string,
  contents: string,
): Promise<FileIdentity> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  let identity: FileIdentity | undefined;
  try {
    identity = identityOf(await handle.stat());
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    const stats = await handle.stat();
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
      throw new Error("Local state file permissions could not be secured");
    }
    return identityOf(stats);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlinkIfOwned(path, identity).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function unlinkIfOwned(
  path: string,
  identity: FileIdentity | undefined,
): Promise<void> {
  if (!identity) return;
  try {
    const stats = await lstat(path);
    if (!stats.isSymbolicLink() && sameIdentity(identity, stats))
      await unlink(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

export async function isWithinDirectory(
  filePath: string,
  directory: string,
): Promise<boolean> {
  const realParent = await realpath(dirname(resolve(filePath))).catch(
    () => undefined,
  );
  const realRoot = await realpath(directory).catch(() => undefined);
  if (!realParent || !realRoot) return false;
  return realParent === realRoot || realParent.startsWith(`${realRoot}/`);
}

export function assertAbsolutePath(path: string): string {
  if (!isAbsolute(path)) throw new Error("An absolute local path is required");
  return resolve(path);
}

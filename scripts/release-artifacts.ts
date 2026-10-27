import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { RELEASE_EXTENSION_PUBLIC_KEY } from "../packages/protocol/src/release-identity.ts";
import { verifyCrx3 } from "./crx3.ts";
import { runPackagingTool } from "./package-chrome.ts";

export function releaseVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  )
    throw new Error(
      "Release tag must be a plain x.y.z version matching the manifests",
    );
  return value;
}

export function releaseAssetNames(version: string): string[] {
  releaseVersion(version);
  return [
    `browser-profile-title-bridge-${version}.crx`,
    `browser-profile-title-bridge-${version}.zip`,
    `browser-profile-link-title-${version}.zip`,
    `browser-profile-title-host-linux-x64-${version}.tar.gz`,
    `browser-profile-title-host-darwin-arm64-${version}.tar.gz`,
    "main.js",
    "manifest.json",
    "styles.css",
  ].sort();
}

export async function verifyReleaseArtifacts(
  directory: string,
  version: string,
): Promise<Record<string, string>> {
  const expected = releaseAssetNames(version);
  const entries = (await readdir(directory))
    .filter((name) => name !== "SHA256SUMS")
    .sort();
  if (entries.join("\n") !== expected.join("\n"))
    throw new Error(
      "Release must contain exactly the eight allowlisted artifacts",
    );
  const hashes: Record<string, string> = {};
  for (const name of expected) {
    const path = join(directory, name);
    const stats = await lstat(path);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size === 0 ||
      stats.size > 128 * 1024 * 1024
    )
      throw new Error(`Unsafe release artifact: ${name}`);
    hashes[name] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  const crx = await readFile(
    join(directory, `browser-profile-title-bridge-${version}.crx`),
  );
  const verified = verifyCrx3(crx, RELEASE_EXTENSION_PUBLIC_KEY);
  if (
    !verified.zip.equals(
      await readFile(
        join(directory, `browser-profile-title-bridge-${version}.zip`),
      ),
    )
  )
    throw new Error("Chrome ZIP must be the verified CRX payload");
  const pluginManifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  if (
    pluginManifest.id !== "browser-profile-link-title" ||
    pluginManifest.version !== version ||
    pluginManifest.isDesktopOnly !== true
  )
    throw new Error("Obsidian release manifest mismatch");
  const chromeManifest = JSON.parse(
    await runPackagingTool([
      "unzip",
      "-p",
      join(directory, `browser-profile-title-bridge-${version}.zip`),
      "manifest.json",
    ]),
  );
  if (
    chromeManifest.version !== version ||
    chromeManifest.key !== RELEASE_EXTENSION_PUBLIC_KEY ||
    chromeManifest.host_permissions !== undefined
  )
    throw new Error("Chrome release manifest mismatch");
  const pluginZip = join(
    directory,
    `browser-profile-link-title-${version}.zip`,
  );
  const pluginEntries = (await runPackagingTool(["unzip", "-Z1", pluginZip]))
    .trim()
    .split(/\r?\n/)
    .filter((name) => !name.endsWith("/"))
    .sort();
  const pluginFiles = [
    "LICENSE",
    "README.md",
    "main.js",
    "manifest.json",
    "styles.css",
  ]
    .map((name) => `browser-profile-link-title/${name}`)
    .sort();
  if (pluginEntries.join("\n") !== pluginFiles.join("\n"))
    throw new Error("Unexpected Obsidian ZIP contents");
  for (const name of ["main.js", "manifest.json", "styles.css"]) {
    const archived = await runPackagingTool([
      "unzip",
      "-p",
      pluginZip,
      `browser-profile-link-title/${name}`,
    ]);
    if (archived !== (await readFile(join(directory, name), "utf8")))
      throw new Error(`Obsidian raw attachment differs from ZIP: ${name}`);
  }
  for (const target of ["linux-x64", "darwin-arm64"]) {
    const contents = (
      await runPackagingTool([
        "tar",
        "-tzf",
        join(
          directory,
          `browser-profile-title-host-${target}-${version}.tar.gz`,
        ),
      ])
    )
      .trim()
      .split(/\r?\n/)
      .sort();
    if (contents.join(",") !== "INSTALL.md,LICENSE,browser-profile-title-host")
      throw new Error("Unexpected native-host archive contents");
  }
  return hashes;
}

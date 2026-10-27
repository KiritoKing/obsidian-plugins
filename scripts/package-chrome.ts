import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { RELEASE_EXTENSION_PUBLIC_KEY } from "../packages/protocol/src/release-identity.ts";
import { extensionId, verifyCrx3 } from "./crx3.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowedFile =
  /^(?:manifest\.json|background\.js|popup\.html|options\.html|(?:assets|chunks|icons)\/[A-Za-z0-9._-]+\.(?:js|css|png))$/;
const allowedDirectory = /^(?:assets|chunks|icons)\/$/;

export interface ChromePackageOptions {
  inputDir?: string;
  outputDir: string;
  privateKeyPem: string;
  chromePath?: string;
  expectedPublicKey?: string;
}

export async function runPackagingTool(
  command: string[],
  options: { cwd?: string; privateOutput?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "TEMP", "LANG", "LC_ALL", "LD_LIBRARY_PATH"]
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name] as string]),
    ),
  });
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(
        options.privateOutput
          ? `Chrome packaging failed (exit ${code}); private output withheld`
          : `${command[0]} failed (exit ${code}): ${stderr.slice(0, 500)}`,
      );
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

async function sourceFiles(directory: string, prefix = ""): Promise<string[]> {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error("Extension input must be a regular directory");
  const result: string[] = [];
  for (const name of await readdir(directory)) {
    const relative = `${prefix}${name}`;
    const path = join(directory, name);
    const entry = await lstat(path);
    if (entry.isSymbolicLink())
      throw new Error("Extension symlinks are forbidden");
    if (entry.isDirectory() && allowedDirectory.test(`${relative}/`))
      result.push(...(await sourceFiles(path, `${relative}/`)));
    else if (
      entry.isFile() &&
      entry.size <= 2 * 1024 * 1024 &&
      allowedFile.test(relative)
    )
      result.push(relative);
    else throw new Error(`Unexpected extension build entry: ${relative}`);
  }
  return result.sort();
}

export async function packageChrome(options: ChromePackageOptions): Promise<{
  version: string;
  extensionId: string;
  files: Record<string, string>;
}> {
  if (!Bun.which("unzip")) throw new Error("Packaging requires unzip");
  const input = resolve(
    options.inputDir ?? join(root, "packages/extension/.output/chrome-mv3"),
  );
  const output = resolve(options.outputDir);
  const names = await sourceFiles(input);
  const manifest = JSON.parse(
    await readFile(join(input, "manifest.json"), "utf8"),
  );
  if (
    ["manifest.json", "background.js", "popup.html", "options.html"].some(
      (name) => !names.includes(name),
    )
  )
    throw new Error("The extension build is incomplete");
  if (
    manifest.manifest_version !== 3 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)
  )
    throw new Error("Expected a versioned production MV3 manifest");
  if (manifest.host_permissions !== undefined)
    throw new Error("Release extensions must not pregrant sites");
  if (
    !Array.isArray(manifest.permissions) ||
    manifest.permissions.toSorted().join(",") !==
      "activeTab,nativeMessaging,scripting,storage"
  )
    throw new Error("Unexpected release extension permissions");
  const publicKey = options.expectedPublicKey ?? RELEASE_EXTENSION_PUBLIC_KEY;
  const privateKey = createPrivateKey(options.privateKeyPem);
  const actualPublic = createPublicKey(privateKey).export({
    type: "spki",
    format: "der",
  });
  if (actualPublic.toString("base64") !== publicKey)
    throw new Error("Signing secret does not match the fixed release identity");
  const id = extensionId(actualPublic);
  const scratch = await mkdtemp(join(tmpdir(), "title-release-chrome-"));
  const stage = join(scratch, "extension");
  const keyPath = join(scratch, "signing-key.pem");
  const written: string[] = [];
  try {
    await mkdir(stage, { mode: 0o700 });
    for (const name of names) {
      await mkdir(dirname(join(stage, name)), { recursive: true });
      await copyFile(join(input, name), join(stage, name));
    }
    manifest.key = publicKey;
    await writeFile(
      join(stage, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await writeFile(keyPath, options.privateKeyPem, {
      flag: "wx",
      mode: 0o600,
    });
    const chromePath = options.chromePath ?? chromium.executablePath();
    await runPackagingTool(
      [
        chromePath,
        "--headless=new",
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${join(scratch, "profile")}`,
        `--pack-extension=${stage}`,
        `--pack-extension-key=${keyPath}`,
      ],
      { privateOutput: true },
    );
    await rm(keyPath);
    const crx = await readFile(`${stage}.crx`);
    const verified = verifyCrx3(crx, publicKey);
    if (verified.extensionId !== id)
      throw new Error("Packed extension ID mismatch");
    const zipPath = join(scratch, "extension.zip");
    await writeFile(zipPath, verified.zip);
    const entries = (await runPackagingTool(["unzip", "-Z1", zipPath]))
      .trim()
      .split(/\r?\n/);
    if (
      entries.some(
        (name) => !(allowedFile.test(name) || allowedDirectory.test(name)),
      ) ||
      entries
        .filter((name) => !name.endsWith("/"))
        .sort()
        .join("\n") !== names.join("\n")
    )
      throw new Error("CRX archive contains unexpected files");
    const packagedManifest = JSON.parse(
      await runPackagingTool(["unzip", "-p", zipPath, "manifest.json"]),
    );
    if (
      packagedManifest.key !== publicKey ||
      packagedManifest.version !== manifest.version
    )
      throw new Error("CRX manifest readback failed");
    await runPackagingTool(["unzip", "-tqq", zipPath]);
    await mkdir(output, { recursive: true });
    const outputStats = await lstat(output);
    if (!outputStats.isDirectory() || outputStats.isSymbolicLink())
      throw new Error("Release output must be a regular directory");
    const files: Record<string, string> = {};
    for (const [suffix, content] of [
      ["crx", crx],
      ["zip", verified.zip],
    ] as const) {
      const name = `browser-profile-title-bridge-${manifest.version}.${suffix}`;
      const destination = join(output, name);
      await writeFile(destination, content, { flag: "wx" });
      written.push(destination);
      const actual = await readFile(destination);
      if (!actual.equals(content))
        throw new Error("Chrome artifact readback failed");
      files[name] = createHash("sha256").update(actual).digest("hex");
    }
    return { version: manifest.version, extensionId: id, files };
  } catch (error) {
    for (const path of written) await rm(path);
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output" || !args[1])
    throw new Error("Usage: package-chrome.ts --output <directory>");
  const pem = process.env.CRX_PRIVATE_KEY;
  if (!pem)
    throw new Error("CRX_PRIVATE_KEY is required for signed release packaging");
  const result = await packageChrome({
    outputDir: args[1],
    privateKeyPem: pem,
  });
  console.log(JSON.stringify(result));
}

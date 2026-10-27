import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPackagingTool } from "./package-chrome.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function packageNativeHost(output: string): Promise<string> {
  if (!Bun.which("tar")) throw new Error("Native packaging requires tar");
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("This native host supports macOS and Linux only");
  const version = (await Bun.file(join(root, "package.json")).json()).version;
  const binary = join(root, ".output/native-host/browser-profile-title-host");
  const info = await lstat(binary);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 128 * 1024 * 1024 ||
    !(info.mode & 0o111)
  )
    throw new Error("Expected the compiled native-host executable");
  const receipt = await Bun.file(`${binary}.build-receipt.json`).json();
  const bytes = await readFile(binary);
  if (
    receipt.platform !== process.platform ||
    receipt.arch !== process.arch ||
    receipt.sha256 !== createHash("sha256").update(bytes).digest("hex")
  )
    throw new Error("Native build receipt mismatch");
  const scratch = await mkdtemp(join(tmpdir(), "title-release-native-"));
  const name = `browser-profile-title-host-${process.platform}-${process.arch}-${version}.tar.gz`;
  try {
    await writeFile(join(scratch, "browser-profile-title-host"), bytes, {
      mode: 0o755,
    });
    await writeFile(
      join(scratch, "LICENSE"),
      await readFile(join(root, "LICENSE")),
    );
    await writeFile(
      join(scratch, "INSTALL.md"),
      `# Browser Profile Title native host ${version}\n\nBuilt for ${process.platform}/${process.arch}. Keep this directory at a stable path.\n\nPreview registration:\n\n\`\`\`sh\n./browser-profile-title-host install --dry-run --binary "$PWD/browser-profile-title-host" --browser chrome\n\`\`\`\n\nRun the same command without --dry-run to register it. Existing registrations require an explicit --replace. The host allows exactly the development and signed-release extension identities. No browser credentials are exported. See the repository README and SECURITY.md for installation and trust boundaries.\n`,
    );
    const archive = join(scratch, name);
    await runPackagingTool(
      [
        "tar",
        "-czf",
        archive,
        "browser-profile-title-host",
        "INSTALL.md",
        "LICENSE",
      ],
      { cwd: scratch },
    );
    const entries = (await runPackagingTool(["tar", "-tzf", archive]))
      .trim()
      .split(/\r?\n/)
      .sort();
    if (entries.join(",") !== "INSTALL.md,LICENSE,browser-profile-title-host")
      throw new Error("Native archive content mismatch");
    await mkdir(resolve(output), { recursive: true });
    const content = await readFile(archive);
    await writeFile(join(resolve(output), name), content, { flag: "wx" });
    if (!(await readFile(join(resolve(output), name))).equals(content))
      throw new Error("Native archive readback failed");
    return name;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output" || !args[1])
    throw new Error("Usage: package-native-host.ts --output <directory>");
  console.log(await packageNativeHost(args[1]));
}

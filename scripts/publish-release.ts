import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseVersion, verifyReleaseArtifacts } from "./release-artifacts.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function gh(
  args: string[],
  allowMissing = false,
): Promise<string | undefined> {
  const child = Bun.spawn(["gh", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: Object.fromEntries(
      ["PATH", "HOME", "LANG", "GH_TOKEN"]
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name] as string]),
    ),
  });
  const timeout = setTimeout(() => child.kill(), 120_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) {
      if (allowMissing && /release not found|HTTP 404|Not Found/i.test(stderr))
        return undefined;
      throw new Error(
        `GitHub Release command failed (exit ${code}): ${stderr.slice(0, 300)}`,
      );
    }
    return stdout;
  } finally {
    clearTimeout(timeout);
  }
}

if (!import.meta.main)
  throw new Error("Use the release publisher as a CI command");
const version = releaseVersion(process.env.RELEASE_VERSION);
const repository = process.env.GITHUB_REPOSITORY;
const commit = process.env.GITHUB_SHA;
if (
  !repository ||
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
  !commit ||
  !/^[a-f0-9]{40}$/.test(commit) ||
  !process.env.GH_TOKEN
)
  throw new Error(
    "Release publishing requires the authenticated GitHub Actions context",
  );
const workspace = await Bun.file(join(root, "package.json")).json();
if (workspace.version !== version)
  throw new Error("Release tag and workspace version differ");
const directory = join(root, ".output/release");
const hashes = await verifyReleaseArtifacts(directory, version);
const sums = Object.entries(hashes)
  .map(([name, hash]) => `${hash}  ${name}\n`)
  .join("");
await writeFile(join(directory, "SHA256SUMS"), sums, { flag: "wx" });
hashes.SHA256SUMS = createHash("sha256").update(sums).digest("hex");
const readback = await mkdtemp(join(tmpdir(), "title-release-readback-"));
try {
  const existingText = await gh(
    [
      "release",
      "view",
      version,
      "--repo",
      repository,
      "--json",
      "isDraft,targetCommitish,assets",
    ],
    true,
  );
  const existing = existingText ? JSON.parse(existingText) : undefined;
  if (existing && existing.targetCommitish !== commit)
    throw new Error(
      "Existing release belongs to another revision; refusing replacement",
    );
  if (!existing) {
    await gh([
      "release",
      "create",
      version,
      "--repo",
      repository,
      "--verify-tag",
      "--target",
      commit,
      "--draft",
      "--title",
      `Title Bridge ${version}`,
      "--notes-file",
      join(root, "RELEASE_NOTES.md"),
    ]);
  }
  const existingNames = new Set<string>(
    (existing?.assets ?? []).map((asset: { name: string }) => asset.name),
  );
  if ([...existingNames].some((name) => !(name in hashes)))
    throw new Error("Unexpected existing release assets");
  if (existingNames.size) {
    await gh([
      "release",
      "download",
      version,
      "--repo",
      repository,
      "--dir",
      readback,
    ]);
    for (const name of existingNames) {
      if (
        createHash("sha256")
          .update(await readFile(join(readback, name)))
          .digest("hex") !== hashes[name]
      )
        throw new Error("Existing release asset differs; refusing overwrite");
    }
    await rm(readback, { recursive: true });
    await import("node:fs/promises").then(({ mkdir }) => mkdir(readback));
  }
  const missing = Object.keys(hashes).filter(
    (name) => !existingNames.has(name),
  );
  if (existing && !existing.isDraft && missing.length)
    throw new Error("A published release cannot be changed by this workflow");
  if (missing.length)
    await gh([
      "release",
      "upload",
      version,
      "--repo",
      repository,
      ...missing.map((name) => join(directory, name)),
    ]);
  await gh([
    "release",
    "download",
    version,
    "--repo",
    repository,
    "--dir",
    readback,
  ]);
  for (const [name, hash] of Object.entries(hashes)) {
    if (
      createHash("sha256")
        .update(await readFile(join(readback, name)))
        .digest("hex") !== hash
    )
      throw new Error("Uploaded release asset readback failed");
  }
  if (!existing || existing.isDraft)
    await gh([
      "release",
      "edit",
      version,
      "--repo",
      repository,
      "--draft=false",
      "--latest",
    ]);
  const published = JSON.parse(
    (await gh([
      "release",
      "view",
      version,
      "--repo",
      repository,
      "--json",
      "url,isDraft,assets",
    ])) as string,
  );
  if (
    published.isDraft ||
    published.assets.length !== Object.keys(hashes).length
  )
    throw new Error("Release publication readback failed");
  console.log(
    JSON.stringify({
      url: published.url,
      artifacts: Object.keys(hashes).length,
      byteReadbackPassed: true,
    }),
  );
} finally {
  await rm(readback, { recursive: true, force: true });
}

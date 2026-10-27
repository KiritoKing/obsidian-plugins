import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { packageObsidian } from "./package-obsidian";

const pluginId = "browser-profile-link-title";
const fileNames = [
  "LICENSE",
  "README.md",
  "main.js",
  "manifest.json",
  "styles.css",
] as const;
const tempDirectories: string[] = [];

interface Fixture {
  base: string;
  root: string;
  inputDir: string;
  outputDir: string;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "obsidian-release-test-"));
  tempDirectories.push(base);
  const root = join(base, "repo");
  const inputDir = join(base, "build", pluginId);
  const outputDir = join(base, "release");
  const canonicalManifest = {
    id: pluginId,
    name: "Browser Profile Link Title",
    version: "0.2.0",
    minAppVersion: "1.0.0",
  };

  await mkdir(join(root, "packages", "obsidian"), { recursive: true });
  await writeFile(
    join(root, "packages", "obsidian", "manifest.json"),
    JSON.stringify(canonicalManifest),
  );
  await mkdir(inputDir, { recursive: true });
  const fixtureContents: Record<(typeof fileNames)[number], string> = {
    LICENSE: "Synthetic license text for packaging tests.\n",
    "README.md": "Synthetic install instructions.\n",
    "main.js": "const title = 'Synthetic';\n",
    "manifest.json": JSON.stringify(canonicalManifest),
    "styles.css": ".test { color: black; }\n",
  };
  await Promise.all(
    fileNames.map((name) =>
      writeFile(join(inputDir, name), fixtureContents[name]),
    ),
  );
  return { base, root, inputDir, outputDir };
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Obsidian release packaging", () => {
  it("creates the exact plugin ZIP and raw files with source-matching hashes", async () => {
    const fixture = await makeFixture();
    const result = await packageObsidian(fixture);
    const zipPath = join(fixture.outputDir, `${pluginId}-0.2.0.zip`);
    const zipEntries = execFileSync("unzip", ["-Z1", zipPath])
      .toString("utf8")
      .split(/\r?\n/)
      .filter((entry) => entry.length > 0 && entry !== `${pluginId}/`)
      .sort();

    expect(result.archivePath).toBe(zipPath);
    expect(result.outputPaths.map((path) => basename(path)).sort()).toEqual(
      [
        `${pluginId}-0.2.0.zip`,
        "main.js",
        "manifest.json",
        "styles.css",
      ].sort(),
    );
    expect(zipEntries).toEqual(
      fileNames.map((name) => `${pluginId}/${name}`).sort(),
    );

    for (const name of fileNames) {
      const source = await readFile(join(fixture.inputDir, name));
      const archived = execFileSync("unzip", [
        "-p",
        zipPath,
        `${pluginId}/${name}`,
      ]);
      expect(sha256(archived)).toBe(sha256(source));
    }
    for (const name of ["main.js", "manifest.json", "styles.css"]) {
      const source = await readFile(join(fixture.inputDir, name));
      const output = await readFile(join(fixture.outputDir, name));
      expect(sha256(output)).toBe(sha256(source));
    }
  });

  it("rejects a build manifest whose release version differs from the source manifest", async () => {
    const fixture = await makeFixture();
    await writeFile(
      join(fixture.inputDir, "manifest.json"),
      JSON.stringify({
        id: pluginId,
        name: "Browser Profile Link Title",
        version: "0.3.0",
        minAppVersion: "1.0.0",
      }),
    );

    await expect(packageObsidian(fixture)).rejects.toThrow(
      "Build output manifest id, version, and minAppVersion must match",
    );
  });

  it("rejects private runtime state instead of collecting it", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.inputDir, "data.json"), '{"private":true}');

    await expect(packageObsidian(fixture)).rejects.toThrow(
      "unexpected input file: data.json",
    );
  });

  it("refuses to overwrite an existing release target", async () => {
    const fixture = await makeFixture();
    await mkdir(fixture.outputDir, { recursive: true });
    const existingTarget = join(fixture.outputDir, "main.js");
    const sentinel = Buffer.from("pre-existing output owned by the caller\n");
    await writeFile(existingTarget, sentinel);

    await expect(packageObsidian(fixture)).rejects.toThrow(
      "Refusing to overwrite existing output: main.js",
    );
    expect(await readFile(existingTarget)).toEqual(sentinel);
  });

  it("rejects a symlink in the input allowlist", async () => {
    const fixture = await makeFixture();
    await rm(join(fixture.inputDir, "README.md"));
    await symlink(
      join(fixture.inputDir, "main.js"),
      join(fixture.inputDir, "README.md"),
    );

    await expect(packageObsidian(fixture)).rejects.toThrow(
      "README.md: symbolic links are not permitted",
    );
  });
});

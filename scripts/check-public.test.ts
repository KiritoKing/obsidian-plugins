import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicRegistryIssues, publicSourceIssues } from "./check-public.ts";

test("lockfile registry checks reject non-public dependency sources and credentials", () => {
  const lock = (url: string): string =>
    JSON.stringify({
      packages: { fixture: ["fixture@1.0.0", url, {}, "sha512-synthetic"] },
    });
  expect(
    publicRegistryIssues(
      lock("https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz"),
    ),
  ).toEqual([]);
  expect(
    publicRegistryIssues(lock("https://packages.example.test/fixture.tgz")),
  ).not.toEqual([]);
  expect(
    publicRegistryIssues(
      lock("https://user:password@registry.npmjs.org/fixture.tgz"),
    ),
  ).not.toEqual([]);
  expect(
    publicRegistryIssues(
      lock("https://registry.npmjs.org/fixture.tgz?token=synthetic"),
    ),
  ).not.toEqual([]);
  expect(
    publicRegistryIssues(
      JSON.stringify({
        packages: { local: ["local@workspace:packages/local"] },
      }),
    ),
  ).toEqual([]);
});

test("public scan rejects runtime files and source links while ignoring build output", async () => {
  const base = await mkdtemp(join(tmpdir(), "title-public-"));
  try {
    await writeFile(
      join(base, "README.md"),
      "Synthetic public documentation.\n",
    );
    await mkdir(join(base, "dist"));
    await writeFile(
      join(base, "dist", "connection.json"),
      "ignored build fixture",
    );
    expect(await publicSourceIssues(base)).toEqual([]);
    await writeFile(join(base, "connection.json"), "synthetic runtime fixture");
    await symlink("README.md", join(base, "source-link"));
    const issues = await publicSourceIssues(base);
    expect(issues.some((issue) => issue.startsWith("connection.json:"))).toBe(
      true,
    );
    expect(issues.some((issue) => issue.startsWith("source-link:"))).toBe(true);
    await writeFile(
      join(base, ".npmrc"),
      "registry=https://packages.example.test/\n",
    );
    expect(
      (await publicSourceIssues(base)).some((issue) =>
        issue.startsWith(".npmrc:"),
      ),
    ).toBe(true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("public scan allows the exact valid RGBA icon asset", async () => {
  const base = await mkdtemp(join(tmpdir(), "title-public-icon-"));
  try {
    const iconDirectory = join(
      base,
      "packages",
      "extension",
      "public",
      "icons",
    );
    await mkdir(iconDirectory, { recursive: true });
    await writeFile(
      join(iconDirectory, "icon-16.png"),
      await readFile(
        join(process.cwd(), "packages/extension/public/icons/icon-16.png"),
      ),
    );
    expect(await publicSourceIssues(base)).toEqual([]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("public scan allows the exact 1254px RGBA master up to 2 MiB", async () => {
  const base = await mkdtemp(join(tmpdir(), "title-public-master-"));
  try {
    const assetDirectory = join(base, "packages", "extension", "assets");
    await mkdir(assetDirectory, { recursive: true });
    await writeFile(
      join(assetDirectory, "browser-profile-title-bridge-master.png"),
      await readFile(
        join(
          process.cwd(),
          "packages/extension/assets/browser-profile-title-bridge-master.png",
        ),
      ),
    );
    expect(await publicSourceIssues(base)).toEqual([]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("public scan rejects fake, wrong-size, oversized, linked and unlisted PNGs", async () => {
  const base = await mkdtemp(join(tmpdir(), "title-public-icon-invalid-"));
  try {
    const iconDirectory = join(
      base,
      "packages",
      "extension",
      "public",
      "icons",
    );
    await mkdir(iconDirectory, { recursive: true });
    const icon16 = await readFile(
      join(process.cwd(), "packages/extension/public/icons/icon-16.png"),
    );
    const icon128 = await readFile(
      join(process.cwd(), "packages/extension/public/icons/icon-128.png"),
    );
    const master = await readFile(
      join(
        process.cwd(),
        "packages/extension/assets/browser-profile-title-bridge-master.png",
      ),
    );
    await writeFile(join(iconDirectory, "icon-16.png"), "synthetic fake PNG");
    await writeFile(join(iconDirectory, "icon-32.png"), icon16);
    await writeFile(
      join(iconDirectory, "icon-128.png"),
      Buffer.concat([icon128, Buffer.alloc(256 * 1024)]),
    );
    await writeFile(join(iconDirectory, "extra.png"), icon16);
    const assetDirectory = join(base, "packages", "extension", "assets");
    await mkdir(assetDirectory, { recursive: true });
    await writeFile(
      join(assetDirectory, "browser-profile-title-bridge-master.png"),
      Buffer.concat([master, Buffer.alloc(2 * 1024 * 1024)]),
    );
    await symlink(
      join(process.cwd(), "packages/extension/public/icons/icon-48.png"),
      join(iconDirectory, "icon-48.png"),
    );

    const issues = await publicSourceIssues(base);
    expect(
      issues.some((issue) => issue.includes("icon-16.png: invalid PNG")),
    ).toBe(true);
    expect(
      issues.some((issue) => issue.includes("icon-32.png: expected 32 × 32")),
    ).toBe(true);
    expect(
      issues.some((issue) =>
        issue.includes("icon-128.png: public PNG exceeds"),
      ),
    ).toBe(true);
    expect(
      issues.some((issue) => issue.includes("extra.png: unexpected binary")),
    ).toBe(true);
    expect(
      issues.some((issue) => issue.includes("icon-48.png: source symlinks")),
    ).toBe(true);
    expect(
      issues.some((issue) =>
        issue.includes(
          "browser-profile-title-bridge-master.png: unexpected large source file",
        ),
      ),
    ).toBe(true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

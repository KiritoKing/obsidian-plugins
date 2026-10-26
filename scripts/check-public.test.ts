import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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

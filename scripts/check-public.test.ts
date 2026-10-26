import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicSourceIssues } from "./check-public.ts";

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
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const root = process.cwd();
const excluded = new Set([
  ".git",
  "node_modules",
  ".cache",
  ".output",
  ".wxt",
  "dist",
  "artifacts",
  "coverage",
  "test-results",
  "playwright-report",
]);
const forbiddenNames = new Set([
  "connection.json",
  "Cookies",
  "Login Data",
  "Local State",
]);
const secretPatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\/(?:Users|home)\/[A-Za-z][^\s/"']+\//,
];

export async function publicSourceIssues(directory: string): Promise<string[]> {
  const issues: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const file = join(current, entry.name);
      const display = relative(directory, file);
      if (entry.isSymbolicLink()) {
        issues.push(`${display}: source symlinks are not permitted`);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(file);
        continue;
      }
      if (forbiddenNames.has(basename(file)) || entry.name.startsWith(".env")) {
        issues.push(`${display}: local state or environment file in source`);
        continue;
      }
      const info = await lstat(file);
      if (info.size > 2 * 1024 * 1024) {
        issues.push(`${display}: unexpected large source file`);
        continue;
      }
      const content = await readFile(file);
      if (content.includes(0)) {
        issues.push(`${display}: unexpected binary source file`);
        continue;
      }
      const text = content.toString("utf8");
      for (const pattern of secretPatterns) {
        if (pattern.test(text))
          issues.push(
            `${display}: possible credential or personal absolute path`,
          );
      }
    }
  }
  await visit(directory);
  return issues;
}

if (import.meta.main) {
  const issues = await publicSourceIssues(root);
  const attribution = await readFile(join(root, "ATTRIBUTION.md"), "utf8");
  if (!attribution.includes("542a47d0592a293d2eec8ba126d08bf1729dc18b")) {
    issues.push("ATTRIBUTION.md: missing pinned upstream provenance");
  }
  const license = await readFile(
    join(root, "packages", "obsidian", "LICENSE"),
    "utf8",
  );
  if (!license.includes("Copyright 2024 Matt Furden")) {
    issues.push("packages/obsidian/LICENSE: missing upstream copyright");
  }
  if (issues.length > 0) {
    for (const issue of issues) console.error(issue);
    process.exitCode = 1;
  } else {
    console.log(
      "Public source checks passed; no runtime state, obvious credentials or personal paths found.",
    );
  }
}

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(
  packageRoot,
  "../../dist/browser-profile-link-title",
);

const result = await Bun.build({
  entrypoints: [join(packageRoot, "src/main.ts")],
  outdir: outputDirectory,
  naming: "main.js",
  target: "node",
  format: "cjs",
  external: ["obsidian", "electron", "node:*"],
});

if (!result.success) {
  throw new Error(result.logs.map((log) => log.message).join("\n"));
}

await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  ["manifest.json", "styles.css", "README.md", "LICENSE"].map((fileName) =>
    copyFile(join(packageRoot, fileName), join(outputDirectory, fileName)),
  ),
);

console.log(`Built Obsidian plugin package at ${outputDirectory}`);

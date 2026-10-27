# Personal Obsidian plugins

- This is the canonical source for the plugins and local browser-profile title bridge in this repository. Installed plugin directories are build outputs.
- Use Bun and TypeScript. Keep exact direct dependency versions and commit the root `bun.lock`; do not add another package-manager lockfile.
- Read the root README and the relevant package README before changing a package. Keep source changes inside the package you own; coordinate shared protocol changes first.
- Preserve the Auto Link Title upstream MIT notice and provenance in `ATTRIBUTION.md`. Do not copy unreviewed installed plugins, vault notes, browser profiles or runtime state into this repository.
- Authentication stays in the browser profile. Never export cookies, tokens, passwords, profile databases or page content into source, logs, tests or fixtures. Use synthetic public test data.
- Only return the requested title or explicitly requested selection. The browser path remains preferred; the user's 2026-10-27 request authorizes restoring the pinned upstream title-scraping chain as a fallback. Keep that fallback explicit in documentation and do not restore insecure Electron window settings, add a new third-party service, use model services, load remote executable code, or expose arbitrary shell/script RPC.
- Runtime state belongs in the user's application-state directory outside the vault and Git checkout. Do not hardcode personal paths, hostnames or accounts in reusable code.
- Browser and Obsidian bundles run in their host runtimes and must not assume Bun globals. Bun-specific code belongs in the native host and tooling.
- Run `bun run check` before source delivery. Report unit, local browser-fixture, authenticated-profile and remote-CI evidence separately.
- Preserve unrelated changes. Only remove task-owned temporary outputs and test processes. Do not install into a real browser profile, replace an existing plugin, publish packages or upload a store listing unless the user authorizes that action.

# Browser Profile Link Title

This is a maintained, unofficial Auto Link Title fork for Obsidian Desktop. It preserves the editor paste, drop, selection, and manual-link commands while resolving titles through the local browser-profile bridge first. When that request fails or returns no usable title, the plugin automatically uses the pinned upstream scraping path: a bounded `HEAD` check, a hardened temporary Electron window when available, then a bounded HTTP HTML-title parser. The legacy path uses an isolated in-memory session and never shares Chrome or Obsidian cookies. The HTTP parser reads a bounded response in memory and extracts only the HTML title; response bodies are never stored or logged. Only a usable title or a non-HTML URL filename can become note content; a failed lookup leaves the URL in place.

## Build and test

Run these commands from the monorepo root after installing dependencies with the checked-in Bun lock. This package pins `obsidian` for typechecking; the shared protocol is a workspace dependency.

```sh
bun run --filter @chlrc/obsidian-browser-profile-title typecheck
bun run --filter @chlrc/obsidian-browser-profile-title test
bun run --filter @chlrc/obsidian-browser-profile-title build
```

The build writes five allowlisted files to `dist/browser-profile-link-title/`: `main.js`, `manifest.json`, `styles.css`, this README, and the original MIT license. This directory is build input; it is not the GitHub Release package. It does not install into or replace an existing Obsidian plugin.

## GitHub Release: manual install and upgrade

The GitHub Release provides `browser-profile-link-title-<version>.zip` and raw `main.js`, `manifest.json`, and `styles.css` files. To install, extract the ZIP into the vault's `.obsidian/plugins/` directory so it creates `.obsidian/plugins/browser-profile-link-title/` with the five package files, then enable **Browser Profile Link Title** in Obsidian's Community plugins settings. On a first install, disable the older **Auto Link Title** plugin before enabling this fork to prevent two paste handlers from running. This fork has its own plugin ID and does not import the older plugin's settings.

To upgrade this plugin, disable it in Obsidian, then replace `main.js`, `manifest.json`, and `styles.css` in `.obsidian/plugins/browser-profile-link-title/` with the raw files from the same Release. Keep the existing `data.json` so this plugin's settings remain available, then re-enable it. You can also extract the ZIP over the existing plugin directory; do not delete the directory or its `data.json` first.

This is a manual GitHub Release installation. No BRAT or official Obsidian community directory installation path is provided.

## Build a Release package

After building the plugin, run this from the monorepo root:

```sh
bun run scripts/package-obsidian.ts --output ./release-artifacts
```

The command writes `browser-profile-link-title-0.2.0.zip` and the three raw runtime files into the output directory. The ZIP contains exactly `browser-profile-link-title/{main.js,manifest.json,styles.css,README.md,LICENSE}`. Packaging requires the system `zip` and `unzip` commands on `PATH`; the script checks for both, validates the archive and file hashes, and refuses to overwrite target files already in the output directory. macOS and Ubuntu CI environments must have both system commands available.

## Behavior and privacy

- Authentication remains in the browser profile. The plugin reads a user-local connection descriptor outside the vault and checks it before opening a local Unix socket.
- Requests and replies follow `@chlrc/browser-profile-title-protocol`; request IDs, bounded timeouts, and response validation prevent stale or unrelated replies from changing the editor.
- A failed browser lookup falls back once to the original local scraper. Turn this off with `legacyFallbackEnabled` in plugin settings to retain browser-only behavior.
- The legacy window uses `webSecurity: true`, `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`; it denies new windows, downloads, permissions, and non-HTTP(S) navigation, then destroys the window and clears its temporary session data.
- No third-party scraper or title API is used. The fallback makes direct bounded requests to the supplied HTTP(S) URL and caps HTML reads at 2 MiB.
- Settings contain only bridge and editor behavior, including the fallback toggle. Tokens and private socket paths are never persisted in Obsidian settings or logged; resolver route and failure reason exist only in memory.

## Source provenance

The editor integration is adapted from Auto Link Title 1.5.5 under its original MIT license. See the monorepo's `ATTRIBUTION.md` and the included `LICENSE` for provenance and license terms.

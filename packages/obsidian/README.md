# Browser Profile Link Title

This is a maintained, unofficial Auto Link Title fork for Obsidian Desktop. It preserves the editor paste, drop, selection, and manual-link commands while resolving titles through the local browser-profile bridge first. When that request fails or returns no usable title, the plugin automatically uses the pinned upstream scraping path: a bounded `HEAD` check, a hardened temporary Electron window when available, then a bounded HTTP HTML-title parser. The legacy path uses an isolated in-memory session and never shares Chrome or Obsidian cookies. The HTTP parser reads a bounded response in memory and extracts only the HTML title; response bodies are never stored or logged. Only a usable title or a non-HTML URL filename can become note content; a failed lookup leaves the URL in place.

## Build and test

Run these commands from the monorepo root after installing dependencies with the checked-in Bun lock. This package pins `obsidian` for typechecking; the shared protocol is a workspace dependency.

```sh
bun run --filter @chlrc/obsidian-browser-profile-title typecheck
bun run --filter @chlrc/obsidian-browser-profile-title test
bun run --filter @chlrc/obsidian-browser-profile-title build
```

The build writes a manual-install package to `dist/browser-profile-link-title/` with `main.js`, `manifest.json`, `styles.css`, this README, and the original MIT license. It does not install into or replace an existing Obsidian plugin. Copy the built directory to a separate Obsidian plugin directory only when you explicitly choose to test it.

## Behavior and privacy

- Authentication remains in the browser profile. The plugin reads a user-local connection descriptor outside the vault and checks it before opening a local Unix socket.
- Requests and replies follow `@chlrc/browser-profile-title-protocol`; request IDs, bounded timeouts, and response validation prevent stale or unrelated replies from changing the editor.
- A failed browser lookup falls back once to the original local scraper. Turn this off with `legacyFallbackEnabled` in plugin settings to retain browser-only behavior.
- The legacy window uses `webSecurity: true`, `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`; it denies new windows, downloads, permissions, and non-HTTP(S) navigation, then destroys the window and clears its temporary session data.
- No third-party scraper or title API is used. The fallback makes direct bounded requests to the supplied HTTP(S) URL and caps HTML reads at 2 MiB.
- Settings contain only bridge and editor behavior, including the fallback toggle. Tokens and private socket paths are never persisted in Obsidian settings or logged; resolver route and failure reason exist only in memory.

## Source provenance

The editor integration is adapted from Auto Link Title 1.5.5 under its original MIT license. See the monorepo's `ATTRIBUTION.md` and the included `LICENSE` for provenance and license terms.

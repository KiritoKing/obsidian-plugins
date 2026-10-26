# Browser Profile Link Title

This is a maintained, unofficial Auto Link Title fork for Obsidian Desktop. It preserves the editor paste, drop, selection, and manual-link commands while resolving titles through the local browser-profile bridge. Only the returned title becomes note content; the plugin does not read page bodies or browser cookies, and it does not store bridge tokens in Obsidian settings.

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
- A failed lookup leaves the original URL intact. The plugin has no third-party scraper, title API, or hidden browser-window fallback.
- Settings contain only the bridge channel, timeout, and editor behavior. Tokens and private socket paths are never persisted in Obsidian settings or logged.

## Source provenance

The editor integration is adapted from Auto Link Title 1.5.5 under its original MIT license. See the monorepo's `ATTRIBUTION.md` and the included `LICENSE` for provenance and license terms.

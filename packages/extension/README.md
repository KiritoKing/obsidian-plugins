# Browser profile title extension

Chrome MV3 extension for the local browser profile title bridge. The extension connects to the registered Native Messaging host, which keeps authentication in the Chrome profile where the extension is installed.

## Privacy and site access

- The manifest has no default site access. A user can grant one exact HTTP(S) origin from the popup's current-site card or from the settings page; access can be revoked in settings.
- A background title request requires Chrome to confirm access to the requested origin and an explicit approval recorded for that exact origin by this extension. A broader Chrome permission may cover the Chrome access check, but it never counts as the extension's explicit approval. Settings shows those two states separately.
- The popup displays the current origin without its path and reports restricted pages, missing Chrome access, missing explicit approval, and fully authorized sites. **Read this page title** uses the popup's `activeTab` gesture for that one visible tab and does not save or enable background access.
- The reader injects a fixed function into the main frame's isolated world and reads only `document.title` and the final page URL needed for redirect checks. It does not read page HTML, cookies, storage, or authentication data.
- The extension returns the requested title with the request URL and `source: "browser"`. It does not call a title service or execute request-provided code.
- Channel configuration and exact site approvals are stored in `chrome.storage.local`. Requests and task state stay in the background worker; no settings are synced.
- Temporary background tabs are closed only when this extension created them. An existing exact-URL tab is reused and left open.

## Development

From the repository root:

```sh
bun run --filter @chlrc/browser-profile-title-extension dev
bun run --filter @chlrc/browser-profile-title-extension typecheck
bun run --filter @chlrc/browser-profile-title-extension build
bun run --filter @chlrc/browser-profile-title-extension zip
```

The public extension key is imported from `@chlrc/browser-profile-title-protocol/identity` so the unpacked extension ID matches the native host allowlist. The ZIP output is a build artifact and must not be installed into a personal Chrome profile without explicit authorization.

Unit tests use synthetic URLs and page titles:

```sh
bun test packages/extension/tests
```

Build and unit tests do not verify authenticated access in a user's Chrome profile. Real-profile installation and host configuration are separate acceptance steps.

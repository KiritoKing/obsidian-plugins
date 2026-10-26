# Browser profile title extension

Chrome MV3 extension for the local browser profile title bridge. The extension connects to the registered Native Messaging host, which keeps authentication in the Chrome profile where the extension is installed.

## Privacy and site access

- The manifest has no default site access. A user grants one exact HTTP(S) origin at a time from the settings page; access can be revoked there.
- A background title request requires both Chrome's exact origin permission and an explicit approval recorded by the settings page. Broad host permissions granted in Chrome settings do not authorize requests. The popup's current-tab action is a separate user gesture scoped by Chrome's `activeTab` permission.
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

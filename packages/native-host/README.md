# Native Messaging Host

`@chlrc/browser-profile-title-host` connects the Chrome extension's Native Messaging stdio to a user-local Unix socket used by the Obsidian plugin. It forwards only validated title bridge requests and responses. It has no shell, JavaScript, cookie, profile-database, or arbitrary RPC interface.

The host allows exactly the development origin `chrome-extension://ligookeeainjhapkanfmgabeenmeljbn/` and release origin `chrome-extension://fgcokpikjhdcomfiingeapogdkgaalol/`. Before creating a socket, it requires a version 1 `hello` whose extension ID matches the origin Chrome passed to the process. Unknown origins, unknown IDs, and mismatched origin/ID pairs are rejected. Native Messaging and the socket both use the shared four-byte little-endian length plus UTF-8 JSON framing, capped at 1 MiB. The host handles `ping` locally, namespaces request IDs across clients, enforces bounded timeouts, and sends cancellation frames when requests time out or a socket client disconnects.

## Runtime state

Runtime state lives outside the vault and checkout. macOS uses the current user's Application Support directory; Linux uses `$XDG_STATE_HOME` or the current user's `.local/state` directory. Each channel gets a private `0700` directory, a `0600` `connection.json`, a `0600` Unix socket, and a `0600` host lock. Pairing tokens are generated as 32 random bytes encoded with base64url and are never printed by `doctor`.

The host never replaces an existing lock, connection file, or socket. A second process for the same channel returns `PROFILE_IN_USE`. A stale socket, connection file, or lock is reported by `doctor` for manual review and is not removed automatically. The socket path must fit the local macOS/Linux Unix-socket limit; a long path produces a fixed instruction to choose a shorter state directory. Windows is unsupported.

## Build and CLI

Use the root Bun workspace scripts:

```sh
bun run --filter '@chlrc/browser-profile-title-host' typecheck
bun run --filter '@chlrc/browser-profile-title-host' test
bun run --filter '@chlrc/browser-profile-title-host' build
```

The build creates an ignored standalone executable under the repository's `.output/native-host/` directory and a local receipt used to reject a Bun or Node interpreter as the installed host. The compile disables automatic `.env` and `bunfig.toml` loading. The receipt is local build metadata and is not a public artifact.

```sh
browser-profile-title-host doctor [--channel default]
browser-profile-title-host install --dry-run --binary <standalone-host> --browser chrome
browser-profile-title-host install --dry-run --binary <standalone-host> --browser chromium --state-dir <browser-user-data-root>
browser-profile-title-host install --binary <standalone-host> --browser edge
browser-profile-title-host install --binary <standalone-host> --browser chrome --replace
```

`install --dry-run` validates the standalone binary and prints the manifest it would write. The manifest lists exactly the development and release origins above. `--state-dir` selects a browser user-data root, such as an isolated persistent profile used for testing. Without it, the standard per-user Chrome, Chromium, or Edge data directory is selected for macOS or Linux. Installation writes only the user-level `NativeMessagingHosts/com.chlrc.browser_profile_title.json` manifest; it does not copy or overwrite the executable. Existing manifests require explicit `--replace`; replacement accepts only this host's known manifest shape, including the legacy development-only origin list, and upgrades it to both origins. Writes are atomic, user-readable only, and checked by readback. This package implementation has not installed a manifest into a real browser profile.

Chrome launches the executable with its extension origin as the only argument. `run <origin>` is also available for local fixtures. On stdin close, parse failure, or process termination, the host cancels outstanding browser work, closes client sockets, and removes only the socket, connection file, lock, and empty directories it created.

## API

The package exports:

- `createBridgeServer(options)`: create and bind the authenticated user-local socket server.
- `runNativeHost(options)`: run the Native Messaging stdio loop with injectable streams, state base, signal, and exit callback.
- `installNativeMessagingManifest(options)`: validate and install or dry-run a per-user manifest.
- `inspectRuntimeState(options)`: report a token-free runtime diagnosis.
- `browserUserDataDirectory(options)`: resolve a browser's standard user-data root.

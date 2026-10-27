# GitHub releases

Releases are built by `.github/workflows/release.yml` from plain `x.y.z` tags. The tag must match the root, Chrome and Obsidian versions. No Chrome Web Store, Obsidian community-directory or npm publication is performed.

## Signing identity

The release public key and extension ID are maintained in `packages/protocol/src/release-identity.ts`. The repository Actions secret `CRX_PRIVATE_KEY` holds the corresponding private key. Do not rotate it to retry a failed build: changing the key changes Chrome's extension identity. Development builds retain their original public identity; the native host supports exactly these two identities.

Only the signed-package step receives the secret. Its Chrome subprocess uses an isolated temporary profile, and its private key file has mode `0600` in a private temporary directory. The key is removed on success and failure. Packaging checks the public key before invoking Chrome, independently verifies the CRX3 signature and identity, and extracts the matching ZIP payload. Neither private keys nor profiles are release artifacts.

## Build and publish

Before tagging, run `bun run check` and `bun run test:browser`. The release workflow repeats these checks on Linux, signs the Chrome package, then runs the browser fixture again using the signed ZIP and release extension identity. The macOS arm64 job builds and smoke-tests the native executable on its target platform.

Packaging commands use existing build outputs and refuse to overwrite artifacts:

```sh
bun run package:chrome --output .output/release
bun run package:obsidian --output .output/release
bun run package:native --output .output/release
```

Chrome packaging requires the matching signing secret, Playwright's Chromium and `unzip`. Obsidian packaging requires `zip` and `unzip`. Native packaging requires `tar`; builds must run on their target OS and architecture. CI installs pinned project dependencies with the frozen Bun lockfile.

The publisher requires exactly eight artifacts: Chrome CRX/ZIP, Obsidian ZIP plus three raw plugin files, and native-host archives for macOS arm64 and Linux x64. It verifies their manifests and archive contents, adds `SHA256SUMS`, creates a draft, uploads the nine files, downloads them into a separate temporary directory and compares hashes before making the release public. A retry can resume a matching draft; it cannot overwrite different bytes or add missing files to an already public release.

After publication, independently download the release files, verify `SHA256SUMS` and the CRX public identity, and check that the release points at the intended commit. Remote CI, public artifact integrity and local real-profile installation are separate acceptance layers. Record the evidence in `VALIDATION.md`.

## Installation boundaries

On macOS/Windows, ordinary Chrome restricts off-store CRX installation. The matching ZIP supports **Load unpacked** for personal use; see [Chrome's distribution documentation](https://developer.chrome.com/docs/extensions/how-to/distribute). The release ZIP has the same fixed identity as its signed CRX. Every separate extension installation needs its own site approvals. Do not run two bridge extensions on the same channel.

Obsidian users extract the plugin ZIP into `.obsidian/plugins/`, enable it manually and preserve their existing `data.json`. Native-host registration remains an explicit per-user action. Publishing a GitHub release does not install or replace software in a personal browser or vault.

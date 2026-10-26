# Validation receipt

Recorded on 2026-10-26. This receipt separates source/build verification, a disposable browser fixture, and access to a user's private pages.

## Local source and build

Environment: macOS arm64, Bun 1.3.14, TypeScript 6.0.3, WXT 0.21.4, Vite 7.3.7 and Playwright 1.64.1. The browser fixture used Google Chrome for Testing 156.0.8078.4.

`bun run check` passed:

- Biome formatting and lint, independent TypeScript checks for tooling and all four packages.
- 55 unit tests with 189 assertions across 12 files: framing, request boundaries, exact site consent and revocation, queue bounds/cancellation, title stability, browser-tab ownership, socket authentication/lifecycle, installer readback, editor replacement guards, Markdown escaping and dependency-source portability.
- Production extension build, Obsidian Desktop CommonJS bundle, and standalone native-host compilation.
- The native-host build directly executes the compiled binary's `--help` and isolated `doctor` commands. Repeated builds verify the previous output receipt before replacing task-owned build artifacts.
- Public-source checks for unexpected binaries, runtime state, obvious credentials, personal paths, public-registry dependency sources and upstream attribution.

A separate empty-cache fixture installed all 292 packages from the public npm registry with `--frozen-lockfile --ignore-scripts`. All 207 locked external package versions and integrity digests were checked against official public metadata before normalizing tarball locations; dependency versions and the graph were preserved.

The extension ZIP was also built. The production manifest is MV3, has no pregranted sites, and declares only `activeTab`, `nativeMessaging`, `scripting` and `storage`, with HTTP(S) sites optional. The public extension key and host allowlist use the same fixed extension ID.

## Real browser fixture

`bun run test:browser` passed the complete chain:

`Obsidian BridgeClient → authenticated Unix socket → standalone Native Messaging host → Chrome extension → rendered page title`.

The test creates a disposable persistent browser profile, seeds a synthetic HTTP-only session cookie directly into that profile, and serves a loopback document. An unauthenticated direct request sees a sign-in page; a browser request sees the document title. Cookies never enter a bridge request or response.

Verified behavior:

- Before explicit site consent, the request returns `HOST_PERMISSION_REQUIRED`.
- An exact existing tab is reused without reloading or closing it.
- A newly created background tab uses the same profile session and is closed afterward.
- Recognized login pages, access-denied pages and cross-origin redirects fail with explicit codes.
- An unstable title times out, cancels browser work and closes only the temporary tab.
- Revocation clears the extension's own approval even when Chrome refuses to remove its fixture-required permission. Later requests are denied and the existing tab remains open.
- Explicit disconnect removes the pairing descriptor; subsequent client calls report unavailable.
- The browser, native-host runtime files, temporary profile and loopback fixture are cleaned up, and the fixture port can be bound again.

The test copies the production build and adds a required permission for its exact loopback origin **only in the disposable fixture manifest**. It still clicks the extension's Grant site UI. This does not test Chrome's native optional-permission prompt. The Native Messaging manifest is registered only inside the disposable browser profile.

## Findings fixed during integration

- API/unit tests initially missed a compiled-entrypoint argument bug. The real standalone `--help` invocation reproduced it; the corrected entrypoint and build smoke now cover that failure class.
- Chrome can reject permission removal. Revocation now removes the extension's approval before attempting Chrome removal, with a regression test and live browser readback.
- Bun compilation left temporary binaries in the package directory. Compilation now uses the ignored output directory and cleans only newly created build residues; public-source scanning catches regressions.
- The first remote CI could not reach registry locations inherited from the development machine. The project now pins the public registry, the lockfile retains its verified versions and integrity digests, and CI checks allowed dependency sources before installation. No global registry configuration was changed.

## Limits and remaining acceptance

- No extension, host registration or replacement plugin was installed into a personal browser profile or an existing vault.
- Actual SSO and Feishu Docx/Wiki pages have not been verified. Title detection is heuristic; a generic or misleading application-shell title may need a site-specific adapter.
- Initial macOS headless runs intermittently timed out while opening a new background page. Later complete runs with page/network lifecycle diagnostics passed. The precise cause remains unconfirmed; timeout safely preserves the URL, and private-page latency needs real-profile acceptance.
- Obsidian's actual paste/drop UI, Chrome's optional-permission dialog, development hot reload, Chrome Web Store distribution and Edge/Chromium branded-profile installation remain unverified.
- Linux is checked by the repository CI when it runs. Windows and Obsidian Mobile are unsupported. Long home/state paths or long channel names can exceed the Unix-socket path limit.
- This version retrieves titles only. It has no page-body extraction, Feishu CLI adapter, external resolver fallback or package/store publication.

Remote CI results are available under the repository's [Actions](https://github.com/KiritoKing/obsidian-plugins/actions). A local pass is not a remote CI result.

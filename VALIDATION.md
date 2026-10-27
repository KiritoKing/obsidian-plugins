# Validation receipt

This receipt separates source/build verification, a disposable browser fixture, and access to a user's private pages. The first sections record the 2026-10-26 v0.1 baseline; the v0.2 update is recorded below.

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

## v0.1 source-delivery limits (2026-10-26)

- No extension, host registration or replacement plugin was installed into a personal browser profile or an existing vault.
- Actual SSO and Feishu Docx/Wiki pages have not been verified. Title detection is heuristic; a generic or misleading application-shell title may need a site-specific adapter.
- Initial macOS headless runs intermittently timed out while opening a new background page. Later complete runs with page/network lifecycle diagnostics passed. The precise cause remains unconfirmed; timeout safely preserves the URL, and private-page latency needs real-profile acceptance.
- Obsidian's actual paste/drop UI, Chrome's optional-permission dialog, development hot reload, Chrome Web Store distribution and Edge/Chromium branded-profile installation remain unverified.
- Linux is checked by the repository CI when it runs. Windows and Obsidian Mobile are unsupported. Long home/state paths or long channel names can exceed the Unix-socket path limit.
- This version retrieves titles only. It has no page-body extraction, Feishu CLI adapter, external resolver fallback or package/store publication.

Remote CI results are available under the repository's [Actions](https://github.com/KiritoKing/obsidian-plugins/actions). A local pass is not a remote CI result.

## v0.2 — current-site authorization, interface refresh and fallback (2026-10-27)

The popup now identifies the current HTTP(S) origin, shows its effective authorization, and provides **Grant this site**. Popup and settings use consistent responsive light/dark layouts. They distinguish Chrome access from the extension's exact-origin approval and refresh when another extension view changes consent. Restricted pages and denied or unverified grants remain explicit.

Obsidian tries the browser first, then the pinned upstream scraping chain once when approval is missing, the bridge is unavailable, or the browser lookup fails or returns an unusable title. The fallback uses its own bounded requests and a hardened temporary Electron session; it does not inherit Chrome authentication. Both-path failure preserves the URL. Native Obsidian settings now show connection and last-lookup status, a default-on fallback toggle and grouped editor controls.

### Source and isolated-browser verification

- `bun run check` passed: 96 unit tests, 369 assertions across 15 files, formatting, lint, independent typechecks, all builds and public-source checks. No dependency graph or lockfile change was required.
- Resolver tests cover every protocol error, missing/authentication/timeout/thrown bridge failures, unusable browser titles, disabled fallback, successful fallback, both-path failure and late replies. Legacy tests cover bounded HEAD/render/HTML behavior, delayed titles and temporary-window disposal.
- `bun run test:browser` passed all nine reported checks. It verifies the current-site grant, live settings refresh, keyboard form submission, restricted-page behavior, responsive/light/dark layouts, authenticated ping, title transport, tab ownership, timeout/revocation/disconnect and cleanup.
- The popup fixture renders the production popup as an extension tab and adapts only its active-tab query to a real fixture tab. Other Chrome APIs remain real. The fixture-only loopback host grant and synthetic profile remain as described above. This verifies production UI behavior but does not assert toolbar-popup activation or Chrome's native optional-permission prompt.
- Popup and settings screenshots were inspected at 380 px, 390 px and desktop widths. The production MV3 manifest still has no pregranted sites. The v0.2 extension ZIP was built.

### Installed Obsidian verification

- The existing plugin was upgraded to v0.2.0 with a private backup and file-hash readback. Runtime confirms the new plugin remains enabled/loaded, the original plugin remains disabled, and fallback defaults on. Existing settings and plugin-list preservation are checked separately at handoff.
- Through the actual installed plugin and real Electron runtime, seven loopback scenarios passed: static HTML, JavaScript-delayed title, rejected HEAD, a non-HTML filename, no title, a sign-in page, and an unavailable bridge channel. Unapproved sites used fallback; an unavailable channel reported `bridge-unavailable`. The non-HTML case made no GET request. Temporary test settings were restored without saving them.
- The final loopback verification used a 6000 ms per-path budget. An initial 2000 ms cold-start run could expire before the hidden renderer was ready; it is not used as success evidence.
- Actual native clipboard paste produced the expected Markdown link via fallback. A second paste with no usable title preserved the raw URL and added no Markdown label. The task note's base content/frontmatter remained intact.
- The native Obsidian settings were opened and visually checked; **Check connection** performed an authenticated ping and displayed **Connected**, with fallback enabled. Hidden Electron window counts were equal before and after testing.
- Real testing found Electron's address-only default title on title-less HTML. The classifier now rejects a matching URL with or without its scheme, while preserving normal tutorial titles that mention URLs or login. A regression test and the repeated real-runtime check pass.
- The task note was moved to the system trash, its tab was closed and the original active tab restored. The task server exited, its port was rebound successfully, and test-only files were removed. Production bridge state is retained for normal use.

### Remaining v0.2 acceptance

- Reloading the unpacked extension in the everyday Chrome profile requires a manual action because the browser tool cannot access privileged extension-management pages. Confirmation and a fresh signed-in-page check are pending at this recording point.
- Native toolbar-popup activation, the native Chrome permission prompt, real drag/drop UI and deliberately expired authentication in the everyday profile are not newly verified by this update.
- v0.2 has local source/build/fixture/runtime evidence. It has not been pushed or run through remote CI; the earlier linked CI applies to the v0.1 source baseline.

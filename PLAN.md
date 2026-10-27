# Implementation plan

## Goal

Maintain personal Obsidian plugins as an independent public component repository. Import the MIT-licensed Auto Link Title source at tag 1.5.5 with attribution, then replace authenticated title retrieval with a local Chrome extension using the profile in which that extension is installed.

## Scope

- Bun + TypeScript workspace containing a Chrome MV3 extension, native messaging host, shared protocol and maintained Obsidian plugin fork.
- Browser-first title retrieval for explicitly permitted HTTP(S) sites; never export cookies or use a third-party title service.
- Local pairing/runtime state outside Git and vault settings; bounded requests, cancellation and safe editor replacement.
- User-owned repository integration as `tools/obsidian-plugins` in the public profile repository, without publishing unrelated staged drafts.
- No npm publication, Chrome Web Store publication or change to existing plugin settings as part of source delivery.

## Work and ownership

1. Root integration: repository metadata, shared protocol, dependency lock, CI, public-source checks and GitHub/submodule delivery.
2. Browser extension: background connection, exact-site optional permissions, title reader and small status/permission UI.
3. Native host: framed stdio, authenticated user-local socket, timeout/cancellation, installer and diagnostic command.
4. Obsidian fork: preserve upstream editor commands, route titles through the browser bridge and retain attribution.
5. Verification: type/lint/tests/build, local browser fixtures, protocol integration, packaged artifact inspection and remote readback.

Independent package ownership allows implementation in parallel. Shared protocol is defined before package implementations and changed only through root coordination.

## Acceptance

- A request travels from a local client through the host and Chrome extension to a permitted rendered page, and returns its title without exporting browser authentication data.
- Missing host, revoked site permission, login page, timeout and cancellation preserve the original link and report a useful state.
- Async responses do not overwrite text edited after dispatch; title text is escaped before Markdown insertion.
- No public source, archive or Git history contains private addresses, machine-specific paths, credentials or local runtime data.
- Unit/fixture/CI evidence is reported separately from verification in a user's authenticated browser profile.

## Initial status

Plan recorded before implementation. Actual test and delivery results belong in `VALIDATION.md`.

## 2026-10-27 — current-site access, interface refresh, and legacy fallback

The user's current request supersedes the initial browser-only/no-fallback scope. Keep the browser path preferred and restore the upstream title-scraping path as an automatic fallback when a site is not approved, the bridge is disconnected, or the browser request fails. Both failures must preserve the original URL and the existing editor concurrency guards.

Planned impact (recorded before implementation):

1. `packages/extension/entrypoints/{popup,options}/` and extension UI helpers/tests: add a one-click **Grant this site** action from the current HTTP(S) tab, visible authorization states, and consistent responsive light/dark interfaces. Keep permissions scoped to the displayed site and request them only from the user's click. Keep manual site entry and revocation available.
2. `packages/obsidian/src/` and package tests: inspect pinned Auto Link Title 1.5.5, restore its title-resolution behavior through bounded host-supported requests, and compose browser-first resolution with automatic legacy fallback. Do not restore insecure Electron window settings or export browser credentials. Show the route and useful error/connection state without persisting browsing history.
3. `packages/obsidian/src/settings.ts` and `styles.css`: modernize the native Obsidian settings with grouped controls and clear bridge/fallback/editor status. Preserve existing settings, provenance, editor behavior, and original plugin data.
4. Root/package documentation, attribution as needed, and `scripts/test-browser.ts`: update the changed behavior and add deterministic fixtures for current-site authorization/status, browser success, each fallback trigger, successful fallback, and both-path failure.
5. Build/check the source and inspect popup/options/settings visuals in isolated fixtures. Update the already-authorized local Obsidian installation with a private backup and hash readback, verify real Electron fallback and native clipboard paste, and update the existing vault workflow record. Keep the current user's Chrome profile, site grants, original plugin configuration, and unrelated vault changes intact. A real Chrome reload remains a user action under the browser tool's privileged-page restriction.

Ownership: extension worker owns the extension package; fallback worker owns the Obsidian resolver, model, main integration, and their tests; root owns Obsidian settings UI/styles, root integration/docs, browser fixtures, final validation and installation handoff. Shared protocol changes require root coordination; none is planned initially.

Acceptance: the popup identifies the current site and shows its effective authorization before/after **Grant this site**; unsupported pages and denied permissions remain explicit; the settings list reflects grants/revocations; modern interfaces work at popup and full-page sizes with keyboard access and light/dark themes; every specified browser failure invokes the old path once; browser success does not invoke fallback; both failures and stale editor responses preserve user text. Local, fixture, and authenticated-profile evidence are reported separately.

## 2026-10-27 — generated icon and GitHub Release

The user authorizes publishing both components to GitHub, a CI-built Chrome CRX and an Obsidian manual-install release, without submitting to the Obsidian community directory. The first public release uses the existing unpublished version `0.2.0`, with a matching `0.2.0` tag. No browser-store submission is included.

Planned impact, recorded before implementation:

1. Generate one original document/link icon with the built-in image tool, retain its prompt/provenance, add production PNG renditions and connect them to the extension and its UI. Public-source scanning permits only the exact reviewed PNG assets after validating their format, dimensions and size.
2. Preserve the current development extension ID. Its original signing private key was never exported; it cannot sign a release. The user explicitly approved a new stable release signing identity and storage only in this repository's GitHub Actions secret `CRX_PRIVATE_KEY`. Generate the key in memory, retain only its public identity in source and never upload the private key as an artifact. CI uses a private temporary file and removes it after signing.
3. Admit exactly the development and release extension IDs in the Native Messaging installer/handshake. Keep the protocol and existing development installation compatible; no browser-profile configuration or permissions are changed as part of release work.
4. Add deterministic allowlisted packaging for the Obsidian ZIP and raw `main.js`, `manifest.json`, `styles.css`; package the Chrome CRX/ZIP and supported native-host binaries. Record hashes and verify archive contents, version and signing identity. Package only build outputs, never vault data, browser state, signing material or local diagnostics.
5. Add a tag-triggered release workflow with least-privilege jobs: full checks and isolated browser integration, platform-native builds, signed CRX packaging, artifact inspection and SHA-256 readback before a public GitHub Release. Publish from the tested source revision; record local/CI/download evidence separately.
6. Update installation/release documentation and publish the authorized source/tag/release to `KiritoKing/obsidian-plugins`. Keep unrelated vault and parent-repository work intact; no npm, Chrome Web Store or Obsidian-directory publication.

Ownership: icon worker owns the extension's image assets/configuration/UI and the narrow public-image gate; native worker owns only dual-identity protocol/host compatibility; packaging worker owns only Obsidian package creation/tests/docs; root owns signing provisioning, release identity, Chrome packaging, CI, release integration and final readback. Shared interfaces are agreed before changing them.

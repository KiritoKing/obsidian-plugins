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

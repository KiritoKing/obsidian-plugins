# Local data boundary

## Release identity and signing

Development and signed releases use separate fixed extension identities. Native Messaging permits only these two identities and checks that the connected Chrome origin agrees with the protocol greeting. The signing private key is stored in the repository's `CRX_PRIVATE_KEY` Actions secret. Only the CRX packaging step receives it; the packer writes a private temporary key file, verifies the generated CRX3 signature and public identity, then removes the temporary directory. Release assets never include the private key.

Release ZIPs contain the exact payload of the verified CRX. The publisher accepts only the eight named artifacts, uploads to a draft, downloads and compares every byte before publishing, and includes `SHA256SUMS`. Re-running publication refuses to replace a different uploaded asset or modify an already published release.

## Browser data

The browser extension reads only a title from a permitted page by default. Authentication is handled by the browser profile and is never exported through the bridge.

The native host accepts a fixed, versioned protocol. It does not provide arbitrary code execution, shell execution, proxying, file reads or cookie access. Local socket clients authenticate with pairing material stored in a user-only runtime directory outside the vault and source checkout.

The same operating-system user and installed Obsidian plugins already have broad local access. Socket permissions and pairing prevent accidental cross-profile routing and unauthenticated local clients; they are not a sandbox against a compromised user account.

## Original-scraper fallback

The browser-first resolver can fall back to the title-scraping behavior derived from the pinned Auto Link Title upstream. This path runs inside Obsidian, not through the local bridge. It may request page HTML or load a hidden renderer, but returns only a title and does not store page bodies.

The fallback never receives Chrome cookies or profile storage. Hidden renderers use independent in-memory sessions, normal web security, context isolation and sandboxing with Node integration disabled. New windows, downloads and non-HTTP(S) navigation are blocked, and task-owned windows and listeners are cleaned up on completion or timeout. The original plugin's service credentials are not migrated, and no LinkPreview or new external title service is enabled.

Current-site grants still require a user click and Chrome's optional-permission flow. The displayed site must also have an exact explicit approval in the extension; a broad Chrome permission alone is not an approval. A legacy fallback does not grant browser access or reuse its authenticated session.

Use synthetic fixtures for tests. Do not attach browser profiles, pairing documents, full URLs for private resources, page content or credentials to public issues.

Remote source publication, local fixture tests, real-profile verification and store publication are separate proof and authorization boundaries. See `VALIDATION.md` for what has actually been tested.

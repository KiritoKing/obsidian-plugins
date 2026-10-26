# Local data boundary

The browser extension reads only a title from a permitted page by default. Authentication is handled by the browser profile and is never exported through the bridge.

The native host accepts a fixed, versioned protocol. It does not provide arbitrary code execution, shell execution, proxying, file reads or cookie access. Local socket clients authenticate with pairing material stored in a user-only runtime directory outside the vault and source checkout.

The same operating-system user and installed Obsidian plugins already have broad local access. Socket permissions and pairing prevent accidental cross-profile routing and unauthenticated local clients; they are not a sandbox against a compromised user account.

Use synthetic fixtures for tests. Do not attach browser profiles, pairing documents, full URLs for private resources, page content or credentials to public issues.

Remote source publication, local fixture tests, real-profile verification and store publication are separate proof and authorization boundaries. See `VALIDATION.md` for what has actually been tested.

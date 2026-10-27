# Title Bridge 0.2.0

This release includes the Chrome companion, the unofficial Obsidian Desktop plugin, and native bridge executables. It is distributed through GitHub only.

- Approve the current website from the Chrome popup with **Grant this site** and see its authorization state immediately.
- Refreshed popup and settings layouts, light/dark themes, and the new generated document/link icon.
- Browser-profile titles remain preferred. Missing permission, a disconnected bridge or a failed lookup automatically tries the original scraper; if both paths fail, the URL stays intact.
- Browser credentials stay in Chrome. The fallback uses an independent temporary session.

## Downloads

- **Chrome:** `browser-profile-title-bridge-0.2.0.zip` for unpacked installation; `browser-profile-title-bridge-0.2.0.crx` is the signed CRX3 package.
- **Obsidian:** extract `browser-profile-link-title-0.2.0.zip` into the vault's `.obsidian/plugins/` directory. The separate `main.js`, `manifest.json`, and `styles.css` attachments contain the same build. Preserve existing `data.json` when upgrading and disable the original Auto Link Title to avoid duplicate paste handlers.
- **Native bridge:** extract the archive matching macOS arm64 or Linux x64, keep it at a stable path, and follow its `INSTALL.md`. Native Messaging registration is required for browser-profile titles; the Obsidian fallback can work without it.
- **Integrity:** `SHA256SUMS` covers every artifact. CRX signatures and extension identity are verified before publication.

The signed release identity is `fgcokpikjhdcomfiingeapogdkgaalol`; source development builds retain `ligookeeainjhapkanfmgabeenmeljbn`. The host supports exactly these identities. Existing development installs continue to work; a separate release installation needs its own site approvals.

Windows and Obsidian Mobile are unsupported. Other desktop CPU architectures can build the host from source. Ordinary Chrome on macOS/Windows restricts installation of CRX files outside the store; use the ZIP with **Load unpacked** for personal development installs. See [Chrome's distribution policy](https://developer.chrome.com/docs/extensions/how-to/distribute).

No Chrome Web Store or Obsidian community-directory submission is included. Build and acceptance boundaries are recorded in [VALIDATION.md](https://github.com/KiritoKing/obsidian-plugins/blob/0.2.0/VALIDATION.md).

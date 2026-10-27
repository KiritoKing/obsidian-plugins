# Personal Obsidian plugins

Personal, unofficial Obsidian plugins and a local browser-profile title bridge. This repository is a component of the [KiritoKing personal productivity system](https://github.com/KiritoKing/KiritoKing), alongside the separately maintained Paseo and DSH plugin repositories.

| Component              | Purpose                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `packages/obsidian`    | Maintained Auto Link Title fork using the local browser bridge     |
| `packages/extension`   | Chrome MV3 extension reading titles in its current browser profile |
| `packages/native-host` | User-local Native Messaging and socket transport                   |
| `packages/protocol`    | Shared request validation, errors and runtime path contract        |

Browser authentication stays in the browser. The Obsidian plugin receives a title and status, not cookies or tokens. Sites are explicitly permitted in the extension. When the browser path is unavailable, the original Auto Link Title scraper runs as a fallback with its own page request; no external title service is added.

## How it works

Paste a URL into Obsidian. The plugin sends a bounded request over a private local Unix socket. Chrome launches the standalone Native Messaging host and the extension reads `document.title` in the profile where it is installed. An exact matching tab is reused; otherwise the extension opens a background tab and closes it after the request. Cookies, local storage and page bodies never cross the bridge.

The extension requires a separate approval for each site. Open its popup on the target page and click **Grant this site**. The popup shows the current site's authorization and bridge connection state; settings list approved sites and support manual grants and revocation.

Browser requests reject recognized login pages, access-denied pages, cross-origin redirects and unusable titles. Missing approval, a disconnected bridge, timeout or another browser failure automatically invokes the original scraper when fallback is enabled. It uses an independent session rather than Chrome's sign-in, so a private page may still need browser approval. If both paths fail, the original URL stays intact. Titles inserted into notes follow the vault's normal storage and sync settings.

The plugin retrieves titles only. The fallback may load page HTML to extract a title, but it does not import or store document bodies or call a Feishu API. Its hidden renderer keeps normal web security and isolation enabled. The upstream LinkPreview service is not enabled.

## Install from source

The initial target is Obsidian Desktop with Chrome on macOS or Linux. Build and test results, including the limits of fixture testing, are recorded in [VALIDATION.md](VALIDATION.md). Windows and mobile Obsidian are unsupported.

1. Install Bun 1.3.14, clone this repository to a stable directory, and build it:

   ```sh
   bun install --frozen-lockfile --ignore-scripts
   bun run check
   ```

2. In `chrome://extensions`, enable Developer mode and choose **Load unpacked** with `packages/extension/.output/chrome-mv3`. Install it in the Chrome profile that is already signed in to the target sites. Its fixed unpacked ID is `ligookeeainjhapkanfmgabeenmeljbn`.

3. Preview the local host registration, then run the same command without `--dry-run` when the destination is correct:

   ```sh
   ./.output/native-host/browser-profile-title-host install --dry-run --binary "$PWD/.output/native-host/browser-profile-title-host" --browser chrome
   ./.output/native-host/browser-profile-title-host install --binary "$PWD/.output/native-host/browser-profile-title-host" --browser chrome
   ```

   Registration writes one user-level Native Messaging manifest. Keep the checkout at the same path afterward. Existing registrations require explicit `--replace`; Chromium and Edge locations are available in the [host CLI](packages/native-host/README.md).

4. Open the extension on a target page and click **Grant this site**, then confirm Chrome's permission prompt. The site card shows when title access is approved. Keep channel `default` for the first profile; the settings page supports other channels, manual site grants and revocation. Give additional profiles different channels so requests have an explicit destination.

5. Copy `dist/browser-profile-link-title/` into the vault's `.obsidian/plugins/` directory, then enable **Browser Profile Link Title** in Obsidian. Disable Auto Link Title while using its fork to avoid competing paste handlers. Set the same channel in the plugin settings.

Open a target page in the chosen Chrome profile and use **Enhance existing URL with browser title**, or paste a URL into a note. If sign-in is needed, complete it in Chrome and retry. Obsidian settings show connection and last-lookup status and let you disable the default-on original-scraper fallback. The plugin has a distinct ID and does not migrate the old plugin's settings or service credentials.

There is no Chrome Web Store listing or published npm package. Source delivery and local fixture tests do not confirm access to a particular private business page.

## Development

Use Bun 1.3.14 or the exact version recorded in `package.json`.
The project `.npmrc` and lockfile use the public npm registry. Public-source checks reject alternate dependency origins and credential-bearing registry URLs before CI installs dependencies.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun x playwright install chromium
bun run test:browser
```

The browser test creates a disposable Chromium profile with a synthetic login session and a loopback page. Its fixture copy of the production manifest pregrants only that loopback origin, while the extension's own site-consent UI is exercised. It never opens or copies a personal browser profile or installs into one.

Read [PLAN.md](PLAN.md) for scope and acceptance and [SECURITY.md](SECURITY.md) for local trust boundaries. The source fork retains its upstream MIT license; see [ATTRIBUTION.md](ATTRIBUTION.md).

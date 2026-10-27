import assert from "node:assert/strict";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { HOST_NAME } from "../packages/protocol/src/index.ts";
import {
  EXTENSION_ID,
  EXTENSION_PUBLIC_KEY,
  RELEASE_EXTENSION_ID,
  RELEASE_EXTENSION_PUBLIC_KEY,
} from "../packages/protocol/src/identity.ts";
import { runPackagingTool } from "./package-chrome.ts";
import {
  channelDirectory,
  connectionFile,
} from "../packages/protocol/src/paths.ts";
import { installNativeMessagingManifest } from "../packages/native-host/src/install.ts";
import {
  BridgeClient,
  BridgeClientError,
} from "../packages/obsidian/src/bridge-client.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtExtension = join(root, "packages/extension/.output/chrome-mv3");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--release-zip"))
  throw new Error(
    "Usage: test-browser.ts [--release-zip <signed-release-zip>]",
  );
const releaseZip = args[1] ? resolve(args[1]) : undefined;
const fixtureExtensionId = releaseZip ? RELEASE_EXTENSION_ID : EXTENSION_ID;
const fixturePublicKey = releaseZip
  ? RELEASE_EXTENSION_PUBLIC_KEY
  : EXTENSION_PUBLIC_KEY;
const hostBinary = join(root, ".output/native-host/browser-profile-title-host");
const uiArtifacts = join(root, ".output/ui-title-access");
const channel = `bt-${crypto.randomUUID().slice(0, 6)}`;
const runtimeDirectory = channelDirectory(channel);
const descriptorPath = connectionFile(channel);
const scratch = await realpath(await mkdtemp(join(tmpdir(), "browser-title-")));
const profileDirectory = join(scratch, "profile");
const extensionDirectory = join(scratch, "extension");
const authenticatedRequests = new Map<string, number>();
const browserEvents: Array<{
  event: string;
  path: string;
  detail?: string | number;
}> = [];
let context: BrowserContext | undefined;
let diagnosticOptions: Page | undefined;
let ownsRuntime = false;

// Only synthetic authentication is used. The bridge never receives this cookie.
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    const path = new URL(request.url).pathname;
    const authenticated =
      request.headers.get("cookie")?.includes("fixture-session=logged-in") ===
      true;
    if (authenticated)
      authenticatedRequests.set(
        path,
        (authenticatedRequests.get(path) ?? 0) + 1,
      );
    if (path === "/redirect")
      return Response.redirect(
        `http://localhost:${new URL(request.url).port}/document`,
      );
    if (path === "/unstable") {
      return html(
        '<title>Changing title</title><script>let n=0;setInterval(()=>document.title="Changing "+(++n),100)</script>',
      );
    }
    if (path === "/forbidden") return html("<title>Access denied</title>", 403);
    if (path === "/login" || !authenticated)
      return html("<title>Sign-in required</title>");
    return html(
      "<title>Loading…</title><h1>Synthetic document</h1><script>setTimeout(()=>document.title='Fixture: authenticated [document]',300)</script>",
    );
  },
});
const origin = `http://127.0.0.1:${fixture.port}`;
const fixturePort = fixture.port;

function html(body: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8">${body}`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function waitFor(
  check: () => Promise<boolean>,
  message: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(message);
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return true;
    throw error;
  }
}

async function expectRemote(
  client: BridgeClient,
  url: string,
  code: string,
): Promise<void> {
  await assert.rejects(
    client.resolveTitle(url),
    (error: unknown) =>
      error instanceof BridgeClientError && error.remoteCode === code,
  );
}

async function tabCount(options: Page): Promise<number> {
  return options.evaluate(async () => (await chrome.tabs.query({})).length);
}

async function openPopupFixture(
  browserContext: BrowserContext,
  options: Page,
  activePage: Page,
): Promise<Page> {
  await activePage.bringToFront();
  const currentTab = await options.evaluate(async (url) => {
    return (await chrome.tabs.query({})).find((tab) => tab.url === url);
  }, activePage.url());
  assert.ok(currentTab, "The fixture page must be a real browser tab");
  const popup = await browserContext.newPage();
  // Headless Chromium does not expose the action-popup surface as a Playwright
  // page. Render the production popup as a tab with only its active-tab query
  // adapted to the real fixture tab. Permission, storage, title reading and
  // Native Messaging APIs remain real; toolbar activation is not asserted.
  await popup.addInitScript((tab: chrome.tabs.Tab) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    Object.defineProperty(chrome.tabs, "query", {
      value: (info: chrome.tabs.QueryInfo) =>
        info.active && info.lastFocusedWindow
          ? Promise.resolve([tab])
          : query(info),
    });
  }, currentTab);
  await popup.setViewportSize({ width: 380, height: 760 });
  await popup.goto(`chrome-extension://${fixtureExtensionId}/popup.html`);
  await popup.locator("#grant-site").waitFor({ state: "visible" });
  return popup;
}

async function captureUi(page: Page, name: string): Promise<void> {
  await mkdir(uiArtifacts, { recursive: true });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    `${name} must not overflow horizontally`,
  );
  await page.screenshot({
    path: join(uiArtifacts, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

try {
  assert.equal(
    await missing(runtimeDirectory),
    true,
    "The random test channel must be unused",
  );
  ownsRuntime = true;
  if (releaseZip) {
    const entries = (await runPackagingTool(["unzip", "-Z1", releaseZip]))
      .trim()
      .split(/\r?\n/);
    if (
      entries.some(
        (name) =>
          name.startsWith("/") ||
          name.split("/").includes("..") ||
          !/^[A-Za-z0-9._/-]+$/.test(name),
      )
    )
      throw new Error("Unsafe release ZIP entry");
    await mkdir(extensionDirectory);
    await runPackagingTool([
      "unzip",
      "-q",
      releaseZip,
      "-d",
      extensionDirectory,
    ]);
  } else {
    await cp(builtExtension, extensionDirectory, {
      recursive: true,
      errorOnExist: true,
    });
  }
  const manifestPath = join(extensionDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(
    manifest.host_permissions,
    undefined,
    "The production extension must have no pregranted sites",
  );
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.key, fixturePublicKey);
  // This fixture-only grant avoids automating Chrome's native permission dialog.
  // The extension's own exact-site consent UI is still exercised below.
  manifest.host_permissions = [`${origin}/*`];
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await mkdir(profileDirectory, { mode: 0o700 });

  context = await chromium.launchPersistentContext(profileDirectory, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const record = (
    event: string,
    url: string,
    detail?: string | number,
  ): void => {
    if (url.startsWith(origin))
      browserEvents.push({ event, path: new URL(url).pathname, detail });
  };
  context.on("page", (page) => {
    page.on("domcontentloaded", () => record("domcontentloaded", page.url()));
    page.on("load", () => record("load", page.url()));
    page.on("pageerror", (error) =>
      record("pageerror", page.url(), error.message),
    );
  });
  context.on("response", (response) =>
    record("response", response.url(), response.status()),
  );
  context.on("requestfailed", (request) =>
    record("requestfailed", request.url(), request.failure()?.errorText),
  );
  await context.addCookies([
    {
      name: "fixture-session",
      value: "logged-in",
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  assert.match(
    await (await fetch(`${origin}/document`)).text(),
    /Sign-in required/,
  );

  const options = await context.newPage();
  diagnosticOptions = options;
  await options.goto(`chrome-extension://${fixtureExtensionId}/options.html`);
  await options.locator("#channel").fill(channel);
  await options.locator("#save-channel").click();
  await waitFor(
    async () =>
      (await options.locator("#channel-status").textContent())?.includes(
        "Channel saved",
      ) === true,
    "The extension did not save the isolated channel",
  );

  // Register only inside this disposable browser profile, after selecting its channel.
  const installation = await installNativeMessagingManifest({
    binaryPath: hostBinary,
    stateDir: profileDirectory,
  });
  assert.equal(installation.manifest.name, HOST_NAME);
  assert.equal(installation.dryRun, false);
  await options.locator("#reconnect").click();
  await waitFor(
    async () =>
      (await options.locator("#connection").textContent())?.includes(
        "Connected on channel",
      ) === true,
    "Chrome did not connect to the standalone Native Messaging host",
  );

  const client = new BridgeClient(channel, 8_000);
  assert.equal(await client.ping(), true);
  await expectRemote(client, `${origin}/document`, "HOST_PERMISSION_REQUIRED");

  const existing = await context.newPage();
  await existing.goto(`${origin}/document`);
  await existing.waitForFunction(
    () => document.title === "Fixture: authenticated [document]",
  );
  const popup = await openPopupFixture(context, options, existing);
  await waitFor(
    async () => (await popup.locator("#site-origin").textContent()) === origin,
    "The popup did not identify the current site",
  );
  assert.equal(
    await popup.locator("#site-badge").textContent(),
    "Not authorized",
  );
  assert.equal(await popup.locator("#grant-site").isEnabled(), true);
  assert.equal(
    (await popup.locator("#site-origin").textContent())?.includes("/document"),
    false,
    "The site card must display only the origin",
  );
  await popup.emulateMedia({ colorScheme: "light" });
  await captureUi(popup, "popup-needs-approval-light");
  await popup.locator("#grant-site").click();
  await waitFor(
    async () =>
      (await popup.locator("#site-badge").textContent()) === "Authorized",
    "Grant this site did not verify both permission layers",
  );
  assert.equal(await popup.locator("#grant-site").isEnabled(), false);
  await popup.emulateMedia({ colorScheme: "dark" });
  await captureUi(popup, "popup-authorized-dark");
  await popup.close();
  await waitFor(
    async () =>
      (await options.locator("#site-list").textContent())?.includes(
        "Extension approval: Granted",
      ) === true,
    "The settings page did not refresh after granting from the popup",
  );
  console.log("PASS current-site popup authorization and live settings status");

  await options.locator("#site-list button").first().click();
  await expectRemote(client, `${origin}/document`, "HOST_PERMISSION_REQUIRED");
  await options.locator("#site-url").fill(`${origin}/document`);
  await options.locator("#site-url").press("Enter");
  await waitFor(
    async () =>
      (await options.locator("#site-list").textContent())?.includes(
        "Extension approval: Granted",
      ) === true,
    "The extension did not record precise site consent",
  );
  assert.match(
    (await options.locator("#site-list").textContent()) ?? "",
    /Chrome access: Available/,
  );
  await options.setViewportSize({ width: 1180, height: 900 });
  await options.emulateMedia({ colorScheme: "light" });
  await captureUi(options, "settings-authorized-light");
  await options.emulateMedia({ colorScheme: "dark" });
  await captureUi(options, "settings-authorized-dark");
  await options.setViewportSize({ width: 390, height: 844 });
  await captureUi(options, "settings-mobile-dark");
  await options.setViewportSize({ width: 1180, height: 900 });

  const restricted = await openPopupFixture(context, options, options);
  await waitFor(
    async () =>
      (await restricted.locator("#site-badge").textContent()) ===
      "Restricted page",
    "The popup did not explain restricted pages",
  );
  assert.equal(await restricted.locator("#grant-site").isEnabled(), false);
  assert.equal(await restricted.locator("#read-title").isEnabled(), false);
  await restricted.close();
  console.log(
    "PASS restricted pages, responsive settings and light/dark layouts",
  );

  const beforeCount = await tabCount(options);
  const beforeRequests = authenticatedRequests.get("/document") ?? 0;
  assert.equal(
    await client.resolveTitle(`${origin}/document`),
    "Fixture: authenticated [document]",
  );
  assert.equal(
    await tabCount(options),
    beforeCount,
    "Reading an existing tab must retain it",
  );
  assert.equal(
    authenticatedRequests.get("/document"),
    beforeRequests,
    "Existing tabs must not be reloaded",
  );
  assert.equal(await existing.title(), "Fixture: authenticated [document]");
  console.log(
    "PASS existing profile session and existing-tab reuse through the Obsidian client, socket, native host and extension",
  );

  assert.equal(
    await client.resolveTitle(`${origin}/temporary`),
    "Fixture: authenticated [document]",
  );
  await waitFor(
    async () => (await tabCount(options)) === beforeCount,
    "The temporary browser tab was not closed",
  );
  assert.ok(
    (authenticatedRequests.get("/temporary") ?? 0) > 0,
    "New tabs must use the profile session",
  );
  console.log("PASS authenticated background-tab creation and cleanup");

  await expectRemote(client, `${origin}/login`, "AUTH_REQUIRED");
  await expectRemote(client, `${origin}/forbidden`, "FORBIDDEN");
  await expectRemote(client, `${origin}/redirect`, "FORBIDDEN");
  console.log("PASS login, access-denied and cross-origin redirect rejection");

  await assert.rejects(
    new BridgeClient(channel, 1_200).resolveTitle(`${origin}/unstable`),
    (error: unknown) =>
      error instanceof BridgeClientError &&
      (error.kind === "timeout" || error.remoteCode === "TIMEOUT"),
  );
  await waitFor(
    async () => (await tabCount(options)) === beforeCount,
    "A timed-out request left a temporary tab behind",
  );
  console.log("PASS timeout cancellation and temporary-tab cleanup");

  await options.locator("#site-list button").first().click();
  await waitFor(
    () =>
      options.evaluate(async (pattern) => {
        const stored = await chrome.storage.local.get("explicitSiteOrigins");
        return (
          Array.isArray(stored.explicitSiteOrigins) &&
          !stored.explicitSiteOrigins.includes(pattern)
        );
      }, `${origin}/*`),
    "The extension did not complete site-consent revocation",
  );
  await expectRemote(client, `${origin}/document`, "HOST_PERMISSION_REQUIRED");
  assert.equal(await existing.title(), "Fixture: authenticated [document]");
  console.log(
    "PASS site-consent revocation without closing the user's existing tab",
  );

  await options.locator("#disconnect").click();
  await waitFor(
    () => missing(descriptorPath),
    "Disconnect did not remove the pairing descriptor",
  );
  await assert.rejects(
    client.resolveTitle(`${origin}/document`),
    (error: unknown) =>
      error instanceof BridgeClientError && error.kind === "unavailable",
  );
  console.log("PASS explicit disconnect and unavailable-host handling");
} catch (error) {
  // This context contains only disposable synthetic fixtures. Never collect diagnostics
  // from a personal profile or print the pairing descriptor.
  const pages = await Promise.all(
    (context?.pages() ?? []).map(async (page) => ({
      kind: page.url().startsWith(origin)
        ? new URL(page.url()).pathname
        : "extension-or-blank",
      title: page.url().startsWith(origin)
        ? await page.title().catch(() => "closed")
        : "",
      state: page.url().startsWith(origin)
        ? await page
            .evaluate(() => ({
              ready: document.readyState,
              bodyChars: document.body?.textContent?.length,
            }))
            .catch(() => "closed")
        : "",
    })),
  );
  const connection = await diagnosticOptions
    ?.evaluate(async (fixtureOrigin) => {
      const state = await chrome.runtime.sendMessage({
        type: "get-connection-state",
      });
      const tabs = (await chrome.tabs.query({}))
        .filter((tab) => tab.url?.startsWith(fixtureOrigin))
        .map((tab) => ({
          status: tab.status,
          path: new URL(tab.url ?? fixtureOrigin).pathname,
        }));
      return { connected: state.connected, error: state.error?.code, tabs };
    }, origin)
    .catch(() => undefined);
  console.error("Synthetic fixture diagnostics", {
    pages,
    connection,
    authenticatedPaths: [...authenticatedRequests.entries()],
    browserEvents: browserEvents.slice(-30),
  });
  throw error;
} finally {
  await context?.close();
  fixture.stop(true);
  if (ownsRuntime) {
    await waitFor(
      () => missing(descriptorPath),
      "The task-owned native host did not stop",
    );
    const entries = await readdir(runtimeDirectory).catch(() => []);
    assert.equal(
      entries.length,
      0,
      "The native host left runtime files behind",
    );
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
  await rm(scratch, { recursive: true, force: true });
  const portProbe = createServer();
  await new Promise<void>((resolveProbe, rejectProbe) => {
    portProbe.once("error", rejectProbe);
    portProbe.listen(fixturePort, "127.0.0.1", () =>
      portProbe.close(() => resolveProbe()),
    );
  });
}
console.log(
  "PASS isolated browser, native-host runtime, fixture port and temporary-file cleanup",
);

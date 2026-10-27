import { EXPLICIT_SITE_ORIGINS_KEY } from "../../src/site-consent";
import {
  grantSiteApproval,
  isExplicitSiteOriginsStorageChange,
  readCurrentSiteAccess,
  unavailableSite,
} from "../../src/site-access";
import { classifyPage, normalizeTitle } from "../../src/page-classification";
import {
  readVisibleTitle,
  type InjectedTitleResult,
} from "../../src/title-reader";
import { exactOriginPattern } from "../../src/url-policy";
import { removeExplicitSiteConsent } from "../../src/site-consent";
import type { ConnectionView } from "../../src/native-connection";

const connectionText = element<HTMLParagraphElement>("connection");
const connectionDot = element<HTMLSpanElement>("connection-dot");
const channelText = element<HTMLSpanElement>("channel");
const siteBadge = element<HTMLSpanElement>("site-badge");
const siteOrigin = element<HTMLParagraphElement>("site-origin");
const siteDetail = element<HTMLParagraphElement>("site-detail");
const siteFeedback = element<HTMLParagraphElement>("site-feedback");
const grantButton = element<HTMLButtonElement>("grant-site");
const readerStatus = element<HTMLParagraphElement>("reader-status");
const titleOutput = element<HTMLParagraphElement>("title-output");
const readTitleButton = element<HTMLButtonElement>("read-title");
const reconnectButton = element<HTMLButtonElement>("reconnect");
const disconnectButton = element<HTMLButtonElement>("disconnect");

const siteAccessReader = {
  readChromeOrigins: async () =>
    (await chrome.permissions.getAll()).origins ?? [],
  readExplicitApprovals: async () => {
    const stored = await chrome.storage.local.get(EXPLICIT_SITE_ORIGINS_KEY);
    return stored[EXPLICIT_SITE_ORIGINS_KEY];
  },
  containsChromePermission: (pattern: string) =>
    chrome.permissions.contains({ origins: [pattern] }),
};

let currentTab: chrome.tabs.Tab | undefined;
let currentAccess:
  | Awaited<ReturnType<typeof readCurrentSiteAccess>>
  | undefined;
let siteRefreshId = 0;
let grantBusy = false;
let titleBusy = false;
let connectionActionBusy = false;

grantButton.addEventListener("click", () => {
  void grantCurrentSite();
});

readTitleButton.addEventListener("click", () => {
  void readCurrentPageTitle();
});

reconnectButton.addEventListener("click", () => {
  void runConnectionAction("reconnect");
});

disconnectButton.addEventListener("click", () => {
  void runConnectionAction("disconnect");
});

element<HTMLButtonElement>("open-settings").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (isConnectionMessage(message)) renderConnection(message.state);
});

chrome.permissions.onAdded.addListener(() => void refreshCurrentSite());
chrome.permissions.onRemoved.addListener(() => void refreshCurrentSite());
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (isExplicitSiteOriginsStorageChange(changes, areaName)) {
    void refreshCurrentSite();
  }
});
chrome.tabs.onActivated.addListener(() => void refreshCurrentSite());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    tabId === currentTab?.id &&
    (typeof changeInfo.url === "string" || changeInfo.status === "complete")
  ) {
    void refreshCurrentSite();
  }
});
window.addEventListener("focus", () => void refreshCurrentSite());

void refreshConnection();
void refreshCurrentSite();

async function refreshConnection(): Promise<void> {
  try {
    const state = await chrome.runtime.sendMessage({
      type: "get-connection-state",
    });
    if (isConnectionView(state)) renderConnection(state);
    else throw new Error("Invalid connection state");
  } catch {
    connectionText.textContent = "Extension background is unavailable.";
    connectionDot.className = "status-dot disconnected";
  }
}

async function refreshCurrentSite(): Promise<void> {
  const refreshId = ++siteRefreshId;
  let observedUrl: string | undefined;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (refreshId !== siteRefreshId) return;
    currentTab = tab;
    observedUrl = tab?.url;
    const access = await readCurrentSiteAccess(tab?.url, siteAccessReader);
    if (refreshId !== siteRefreshId) return;

    const [latest] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (latest?.id !== tab?.id || latest?.url !== tab?.url) {
      if (refreshId === siteRefreshId) void refreshCurrentSite();
      return;
    }

    currentTab = tab;
    currentAccess = access;
    renderCurrentSite(access);
  } catch {
    if (refreshId !== siteRefreshId) return;
    currentTab = undefined;
    currentAccess = unavailableSite(observedUrl);
    renderCurrentSite(currentAccess);
  }
}

async function grantCurrentSite(): Promise<void> {
  const access = currentAccess;
  const tab = currentTab;
  if (
    grantBusy ||
    !access?.pattern ||
    !tab ||
    access.status === "restricted-page" ||
    access.status === "unavailable" ||
    access.status === "authorized"
  ) {
    return;
  }

  grantBusy = true;
  siteFeedback.textContent = "Waiting for Chrome permission…";
  grantButton.disabled = true;
  grantButton.setAttribute("aria-busy", "true");

  // grantSiteApproval calls permissions.request before its first await. Keep
  // this call directly in the click path so Chrome retains the user gesture.
  const resultPromise = grantSiteApproval(access.pattern, {
    requestChromePermission: (pattern) =>
      chrome.permissions.request({ origins: [pattern] }),
    readExplicitApprovals: siteAccessReader.readExplicitApprovals,
    saveExplicitApprovals: async (origins) => {
      await chrome.storage.local.set({
        [EXPLICIT_SITE_ORIGINS_KEY]: origins,
      });
    },
    clearExplicitApproval: async (pattern) => {
      const stored = await chrome.storage.local.get(EXPLICIT_SITE_ORIGINS_KEY);
      await chrome.storage.local.set({
        [EXPLICIT_SITE_ORIGINS_KEY]: removeExplicitSiteConsent(
          stored[EXPLICIT_SITE_ORIGINS_KEY],
          pattern,
        ),
      });
    },
    containsChromePermission: siteAccessReader.containsChromePermission,
    isCurrentSite: async () => {
      const [active] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (active?.id !== tab.id || !active.url) return false;
      try {
        return exactOriginPattern(active.url) === access.pattern;
      } catch {
        return false;
      }
    },
  });

  const result = await resultPromise;
  grantBusy = false;
  grantButton.removeAttribute("aria-busy");
  siteFeedback.textContent = grantResultMessage(result);
  await refreshCurrentSite();
}

async function readCurrentPageTitle(): Promise<void> {
  if (titleBusy) return;
  titleBusy = true;
  titleOutput.textContent = "";
  readerStatus.textContent = "Reading the current page…";
  readTitleButton.disabled = true;
  readTitleButton.textContent = "Reading…";
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (typeof tab?.id !== "number" || !tab.url) {
      readerStatus.textContent = "Open an HTTP(S) page, then try again.";
      return;
    }
    exactOriginPattern(tab.url);
    const resultList = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      world: "ISOLATED",
      func: readVisibleTitle,
      args: [secureId(), 12_000],
    });
    const result = resultList[0]?.result as InjectedTitleResult | undefined;
    if (result?.state !== "ready") {
      readerStatus.textContent =
        "The page title did not become stable. Try again after the page finishes loading.";
      return;
    }
    const title = normalizeTitle(result.title);
    const failure = classifyPage(result.url, title);
    if (failure) {
      readerStatus.textContent = failure.message;
      return;
    }
    titleOutput.textContent = title;
    readerStatus.textContent = "Title read from the current browser tab.";
  } catch {
    readerStatus.textContent =
      "This page is not available to the extension. Open a regular HTTP(S) page and try again.";
  } finally {
    titleBusy = false;
    readTitleButton.textContent = "Read this page title";
    readTitleButton.disabled = currentAccess?.status === "restricted-page";
  }
}

async function runConnectionAction(
  type: "reconnect" | "disconnect",
): Promise<void> {
  if (connectionActionBusy) return;
  connectionActionBusy = true;
  setConnectionButtonsDisabled(true);
  connectionText.textContent =
    type === "reconnect" ? "Connecting to the local host…" : "Disconnecting…";
  connectionDot.className = "status-dot connecting";
  try {
    await chrome.runtime.sendMessage({ type });
  } catch {
    connectionText.textContent =
      "The connection action could not be completed.";
  } finally {
    connectionActionBusy = false;
    setConnectionButtonsDisabled(false);
    await refreshConnection();
  }
}

function renderCurrentSite(
  access: Awaited<ReturnType<typeof readCurrentSiteAccess>>,
): void {
  siteOrigin.textContent = access.origin ?? "Unavailable on this page";
  siteBadge.className = `badge ${siteBadgeClass(access.status)}`;
  siteBadge.textContent = siteStatusLabel(access.status);

  switch (access.status) {
    case "authorized":
      siteDetail.textContent =
        "Chrome access and this extension’s site approval are both active.";
      break;
    case "not-authorized":
      siteDetail.textContent =
        "Chrome access is available, but this site still needs explicit approval in the extension.";
      break;
    case "chrome-permission-missing":
      siteDetail.textContent = access.explicitApproval
        ? "Extension approval is saved, but Chrome does not currently confirm access to this site."
        : "Chrome has not confirmed access to this site. Granting it here also records the extension’s exact site approval.";
      break;
    case "unavailable":
      siteDetail.textContent =
        "Chrome and extension approval could not be checked. Reopen this popup to refresh the access state.";
      break;
    case "restricted-page":
      siteDetail.textContent =
        "Chrome restricts extension access on this page. Open a regular HTTP(S) site to continue.";
      break;
  }

  grantButton.disabled =
    grantBusy ||
    access.status === "authorized" ||
    access.status === "restricted-page" ||
    access.status === "unavailable";
  readTitleButton.disabled = titleBusy || access.status === "restricted-page";
}

function renderConnection(view: ConnectionView): void {
  channelText.textContent = view.channel;
  if (view.connected) {
    connectionText.textContent = "Connected to the local host.";
    connectionDot.className = "status-dot connected";
  } else if (view.retrying) {
    connectionText.textContent = "Disconnected. Retrying with a delay…";
    connectionDot.className = "status-dot disconnected";
  } else if (view.connecting) {
    connectionText.textContent = "Connecting to the local host…";
    connectionDot.className = "status-dot connecting";
  } else {
    connectionText.textContent = view.error?.message ?? "Disconnected.";
    connectionDot.className = "status-dot disconnected";
  }
  setConnectionButtonsDisabled(connectionActionBusy);
}

function setConnectionButtonsDisabled(disabled: boolean): void {
  reconnectButton.disabled = disabled;
  disconnectButton.disabled = disabled;
}

function grantResultMessage(
  result: Awaited<ReturnType<typeof grantSiteApproval>>,
): string {
  switch (result) {
    case "authorized":
      return "Site approved. Chrome and extension approval were confirmed.";
    case "denied":
      return "Chrome did not grant access. No extension approval was saved.";
    case "permission-error":
      return "Chrome could not process the site permission request. Try again from this page.";
    case "approval-save-failed":
      return "Chrome may have granted access, but extension approval could not be saved. Background title requests remain disabled.";
    case "chrome-permission-missing":
      return "Chrome did not confirm site access, so title requests remain disabled.";
    case "site-changed":
      return "The page changed during approval. Check this site again before retrying.";
    case "verification-failed":
      return "Approval could not be verified. Refresh site access in Settings before retrying.";
  }
}

function siteStatusLabel(
  status: Awaited<ReturnType<typeof readCurrentSiteAccess>>["status"],
): string {
  switch (status) {
    case "authorized":
      return "Authorized";
    case "not-authorized":
      return "Not authorized";
    case "chrome-permission-missing":
      return "Chrome permission missing";
    case "unavailable":
      return "State unavailable";
    case "restricted-page":
      return "Restricted page";
  }
}

function siteBadgeClass(
  status: Awaited<ReturnType<typeof readCurrentSiteAccess>>["status"],
): string {
  switch (status) {
    case "authorized":
      return "success";
    case "not-authorized":
      return "warning";
    case "chrome-permission-missing":
    case "unavailable":
    case "restricted-page":
      return "neutral";
  }
}

function isConnectionMessage(
  value: unknown,
): value is { type: "connection-state"; state: ConnectionView } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "connection-state" &&
    "state" in value &&
    isConnectionView(value.state)
  );
}

function isConnectionView(value: unknown): value is ConnectionView {
  return (
    typeof value === "object" &&
    value !== null &&
    "connected" in value &&
    typeof value.connected === "boolean" &&
    "connecting" in value &&
    typeof value.connecting === "boolean" &&
    "retrying" in value &&
    typeof value.retrying === "boolean" &&
    "channel" in value &&
    typeof value.channel === "string"
  );
}

function secureId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing popup element: ${id}`);
  return value as T;
}

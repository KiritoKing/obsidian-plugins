import {
  parseWebUrl,
  validChannel,
} from "@chlrc/browser-profile-title-protocol";
import { exactOriginPattern } from "../../src/url-policy";
import {
  EXPLICIT_SITE_ORIGINS_KEY,
  hasExplicitSiteConsent,
  removeExplicitSiteConsent,
} from "../../src/site-consent";
import { revokeSiteApproval } from "../../src/site-revocation";
import {
  grantSiteApproval,
  isExplicitSiteOriginsStorageChange,
  readSiteAccessList,
  type SiteAccessStatus,
} from "../../src/site-access";
import type { ConnectionView } from "../../src/native-connection";

const connectionText = element<HTMLParagraphElement>("connection");
const connectionBadge = element<HTMLSpanElement>("connection-badge");
const connectionDot = element<HTMLSpanElement>("connection-dot");
const channelInput = element<HTMLInputElement>("channel");
const channelStatus = element<HTMLParagraphElement>("channel-status");
const channelSaveButton = element<HTMLButtonElement>("save-channel");
const siteInput = element<HTMLInputElement>("site-url");
const permissionStatus = element<HTMLParagraphElement>("permission-status");
const siteList = element<HTMLUListElement>("site-list");
const emptySites = element<HTMLParagraphElement>("empty-sites");
const sitesLoading = element<HTMLParagraphElement>("sites-loading");
const sitesError = element<HTMLParagraphElement>("sites-error");
const broadPermissionCard = element<HTMLDivElement>("broad-permission-card");
const broadPermissionList = element<HTMLUListElement>("broad-permission-list");
const grantButton = element<HTMLButtonElement>("grant-site");

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

let listRefreshId = 0;
let siteGrantBusy = false;
let connectionActionBusy = false;

element<HTMLFormElement>("grant-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void grantSite();
});

channelSaveButton.addEventListener("click", () => {
  void saveChannel();
});

element<HTMLButtonElement>("reconnect").addEventListener("click", () => {
  void runConnectionAction("reconnect");
});

element<HTMLButtonElement>("disconnect").addEventListener("click", () => {
  void runConnectionAction("disconnect");
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (isConnectionMessage(message)) renderConnection(message.state);
});
chrome.permissions.onAdded.addListener(() => void refreshSiteList());
chrome.permissions.onRemoved.addListener(() => void refreshSiteList());
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (isExplicitSiteOriginsStorageChange(changes, areaName)) {
    void refreshSiteList();
  }
});

void Promise.all([refreshConnection(), loadChannel(), refreshSiteList()]);

async function refreshConnection(): Promise<void> {
  try {
    const state = await chrome.runtime.sendMessage({
      type: "get-connection-state",
    });
    if (isConnectionView(state)) renderConnection(state);
    else throw new Error("Invalid connection state");
  } catch {
    connectionText.textContent =
      "Extension settings could not load the bridge state.";
    connectionBadge.className = "badge danger";
    connectionBadge.textContent = "Unavailable";
    connectionDot.className = "status-dot disconnected";
  }
}

async function loadChannel(): Promise<void> {
  try {
    const values = await chrome.storage.local.get("channel");
    if (validChannel(values.channel)) channelInput.value = values.channel;
  } catch {
    channelStatus.textContent = "The saved channel could not be loaded.";
  }
}

async function saveChannel(): Promise<void> {
  const value = channelInput.value.trim();
  if (!validChannel(value)) {
    channelStatus.textContent =
      "Enter a channel with lowercase letters, numbers, or hyphens (up to 40 characters).";
    channelInput.setAttribute("aria-invalid", "true");
    return;
  }
  channelInput.removeAttribute("aria-invalid");
  channelSaveButton.disabled = true;
  channelSaveButton.setAttribute("aria-busy", "true");
  channelStatus.textContent = "Saving the channel and reconnecting…";
  try {
    const result = await chrome.runtime.sendMessage({
      type: "set-channel",
      channel: value,
    });
    if (result?.ok) {
      channelStatus.textContent = "Channel saved. The bridge is reconnecting.";
      await refreshConnection();
    } else {
      channelStatus.textContent = "The channel could not be saved.";
    }
  } catch {
    channelStatus.textContent = "The channel could not be saved.";
  } finally {
    channelSaveButton.disabled = false;
    channelSaveButton.removeAttribute("aria-busy");
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
  connectionBadge.className = "badge neutral";
  connectionBadge.textContent =
    type === "reconnect" ? "Connecting" : "Disconnecting";
  connectionDot.className = "status-dot connecting";
  try {
    const result = await chrome.runtime.sendMessage({ type });
    if (result?.ok === false) {
      connectionText.textContent =
        "The connection action could not be completed.";
    }
  } catch {
    connectionText.textContent =
      "The connection action could not be completed.";
  } finally {
    connectionActionBusy = false;
    setConnectionButtonsDisabled(false);
    await refreshConnection();
  }
}

async function grantSite(): Promise<void> {
  if (siteGrantBusy) return;
  let pattern: string;
  try {
    const parsed = parseWebUrl(siteInput.value.trim());
    pattern = exactOriginPattern(parsed.href);
  } catch {
    permissionStatus.textContent =
      "Enter a valid HTTP(S) site URL without a username or password.";
    siteInput.setAttribute("aria-invalid", "true");
    return;
  }
  siteInput.removeAttribute("aria-invalid");
  siteGrantBusy = true;
  grantButton.disabled = true;
  grantButton.setAttribute("aria-busy", "true");
  grantButton.textContent = "Requesting…";
  permissionStatus.textContent = "Waiting for Chrome permission…";

  // This begins synchronously in the submit gesture. Do not await or query
  // other APIs before Chrome sees permissions.request.
  const resultPromise = grantSiteApproval(pattern, {
    requestChromePermission: (requestedPattern) =>
      chrome.permissions.request({ origins: [requestedPattern] }),
    readExplicitApprovals: siteAccessReader.readExplicitApprovals,
    saveExplicitApprovals: async (origins) => {
      await chrome.storage.local.set({
        [EXPLICIT_SITE_ORIGINS_KEY]: origins,
      });
    },
    containsChromePermission: siteAccessReader.containsChromePermission,
  });

  const result = await resultPromise;
  siteGrantBusy = false;
  grantButton.disabled = false;
  grantButton.removeAttribute("aria-busy");
  grantButton.textContent = "Grant site";
  permissionStatus.textContent = grantResultMessage(result);
  if (result === "authorized") siteInput.value = "";
  await refreshSiteList();
}

async function refreshSiteList(): Promise<void> {
  const refreshId = ++listRefreshId;
  sitesLoading.hidden = false;
  sitesError.hidden = true;
  sitesError.textContent = "";
  try {
    const result = await readSiteAccessList(siteAccessReader);
    if (refreshId !== listRefreshId) return;
    renderSites(result);
    sitesLoading.hidden = true;
  } catch {
    if (refreshId !== listRefreshId) return;
    sitesLoading.hidden = true;
    sitesError.textContent =
      "Site access could not be loaded. Refresh this page and try again.";
    sitesError.hidden = false;
  }
}

function renderSites(
  result: Awaited<ReturnType<typeof readSiteAccessList>>,
): void {
  siteList.replaceChildren();
  emptySites.hidden = result.sites.length > 0;
  for (const access of result.sites) {
    const item = document.createElement("li");
    item.className = "site-row";

    const top = document.createElement("div");
    top.className = "site-row-top";
    const identity = document.createElement("div");
    identity.className = "site-identity";
    const origin = document.createElement("span");
    origin.className = "site-origin";
    origin.textContent = access.origin ?? "HTTP(S) origin";
    const status = document.createElement("span");
    status.className = `badge ${siteBadgeClass(access.status)}`;
    status.textContent = siteStatusLabel(access.status);
    identity.append(origin, status);

    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "revoke-button";
    revoke.textContent = "Revoke";
    revoke.setAttribute(
      "aria-label",
      `Revoke site approval for ${access.origin ?? "this origin"}`,
    );
    revoke.addEventListener("click", () => {
      if (access.pattern) void revokeOrigin(access.pattern, revoke);
    });
    top.append(identity, revoke);

    const permissions = document.createElement("div");
    permissions.className = "permission-chips";
    permissions.append(
      permissionChip(
        "Chrome access",
        access.chromeAccess ? "Available" : "Missing",
        access.chromeAccess,
      ),
      permissionChip(
        "Extension approval",
        access.explicitApproval ? "Granted" : "Needed",
        access.explicitApproval,
      ),
    );

    const description = document.createElement("p");
    description.className = "site-row-description";
    description.textContent = siteDescription(access.status);
    item.append(top, permissions, description);
    siteList.append(item);
  }

  broadPermissionList.replaceChildren();
  for (const pattern of result.broadChromePermissions) {
    const item = document.createElement("li");
    const value = document.createElement("code");
    value.textContent = pattern;
    const status = document.createElement("span");
    status.className = "badge warning";
    status.textContent = "Chrome access only";
    item.append(value, status);
    broadPermissionList.append(item);
  }
  broadPermissionCard.hidden = result.broadChromePermissions.length === 0;
}

async function revokeOrigin(
  pattern: string,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  permissionStatus.textContent = "Revoking the exact site approval…";
  try {
    const result = await revokeSiteApproval(pattern, {
      clearApproval: async (originPattern) => {
        const stored = await chrome.storage.local.get(
          EXPLICIT_SITE_ORIGINS_KEY,
        );
        await chrome.storage.local.set({
          [EXPLICIT_SITE_ORIGINS_KEY]: removeExplicitSiteConsent(
            stored[EXPLICIT_SITE_ORIGINS_KEY],
            originPattern,
          ),
        });
      },
      notifyBackground: async (originPattern) => {
        const response = await chrome.runtime.sendMessage({
          type: "site-consent-revoked",
          origin: originPattern,
        });
        if (response?.ok !== true) {
          throw new Error(
            "The background did not confirm request cancellation.",
          );
        }
      },
      removeChromePermission: (originPattern) =>
        chrome.permissions.remove({ origins: [originPattern] }),
    });

    const [chromeAccess, stored] = await Promise.all([
      chrome.permissions.contains({ origins: [pattern] }),
      chrome.storage.local.get(EXPLICIT_SITE_ORIGINS_KEY),
    ]);
    const explicitApproval = hasExplicitSiteConsent(
      stored[EXPLICIT_SITE_ORIGINS_KEY],
      pattern,
    );
    permissionStatus.textContent = explicitApproval
      ? "The extension could not confirm that this site's approval was cleared."
      : chromeAccess
        ? "Extension approval is disabled. Chrome access remains available, but title requests stay off without exact approval."
        : result.backgroundNotified
          ? "Site approval and Chrome access for this exact origin were revoked."
          : "Site approval was cleared, but cancellation of an active request could not be confirmed.";
  } catch {
    permissionStatus.textContent =
      "The extension could not clear this site's approval. No Chrome permission change was attempted.";
  } finally {
    button.disabled = false;
  }
  await refreshSiteList();
}

function renderConnection(view: ConnectionView): void {
  if (view.connected) {
    connectionText.textContent = `Connected on channel “${view.channel}”.`;
    connectionBadge.className = "badge success";
    connectionBadge.textContent = "Connected";
    connectionDot.className = "status-dot connected";
  } else if (view.retrying) {
    connectionText.textContent = "Disconnected. Retrying with a delay…";
    connectionBadge.className = "badge warning";
    connectionBadge.textContent = "Retrying";
    connectionDot.className = "status-dot disconnected";
  } else if (view.connecting) {
    connectionText.textContent = "Connecting to the local host…";
    connectionBadge.className = "badge neutral";
    connectionBadge.textContent = "Connecting";
    connectionDot.className = "status-dot connecting";
  } else {
    connectionText.textContent = view.error?.message ?? "Disconnected.";
    connectionBadge.className = "badge neutral";
    connectionBadge.textContent = "Disconnected";
    connectionDot.className = "status-dot disconnected";
  }
  setConnectionButtonsDisabled(connectionActionBusy);
}

function setConnectionButtonsDisabled(disabled: boolean): void {
  element<HTMLButtonElement>("reconnect").disabled = disabled;
  element<HTMLButtonElement>("disconnect").disabled = disabled;
}

function permissionChip(
  category: string,
  value: string,
  enabled: boolean,
): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = `permission-chip ${enabled ? "enabled" : "disabled"}`;
  chip.textContent = `${category}: ${value}`;
  return chip;
}

function siteDescription(status: SiteAccessStatus): string {
  switch (status) {
    case "authorized":
      return "Title requests are enabled for this exact origin.";
    case "not-authorized":
      return "Chrome access is present, but this origin still needs explicit approval in the extension.";
    case "chrome-permission-missing":
      return "Chrome does not currently confirm access. The extension approval alone cannot enable title requests.";
    case "unavailable":
      return "Chrome access and extension approval could not be verified. Refresh the site access list.";
    case "restricted-page":
      return "This page is restricted by Chrome and cannot be used for background title requests.";
  }
}

function siteStatusLabel(status: SiteAccessStatus): string {
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

function siteBadgeClass(status: SiteAccessStatus): string {
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

function grantResultMessage(
  result: Awaited<ReturnType<typeof grantSiteApproval>>,
): string {
  switch (result) {
    case "authorized":
      return "Site approved for background title requests. Chrome access and exact extension approval were verified.";
    case "denied":
      return "Chrome did not grant access. No extension approval was saved.";
    case "permission-error":
      return "Chrome could not process the permission request. Try again from this page.";
    case "approval-save-failed":
      return "Chrome may have granted access, but exact extension approval could not be saved. Title requests remain disabled.";
    case "chrome-permission-missing":
      return "Chrome did not confirm access, so title requests remain disabled.";
    case "site-changed":
      return "The page changed during approval. Check site access before retrying.";
    case "verification-failed":
      return "Site approval could not be verified. Refresh this page and try again.";
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

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing settings element: ${id}`);
  return value as T;
}

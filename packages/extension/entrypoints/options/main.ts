import {
  parseWebUrl,
  validChannel,
} from "@chlrc/browser-profile-title-protocol";
import { exactOriginPattern } from "../../src/url-policy";
import {
  addExplicitSiteConsent,
  EXPLICIT_SITE_ORIGINS_KEY,
  explicitSiteOrigins,
  isExactOriginPattern,
  removeExplicitSiteConsent,
} from "../../src/site-consent";
import { revokeSiteApproval } from "../../src/site-revocation";
import type { ConnectionView } from "../../src/native-connection";

const connectionText = element<HTMLParagraphElement>("connection");
const channelInput = element<HTMLInputElement>("channel");
const channelStatus = element<HTMLParagraphElement>("channel-status");
const siteInput = element<HTMLInputElement>("site-url");
const permissionStatus = element<HTMLParagraphElement>("permission-status");
const siteList = element<HTMLUListElement>("site-list");
const emptySites = element<HTMLParagraphElement>("empty-sites");

element<HTMLButtonElement>("save-channel").addEventListener("click", () => {
  void saveChannel();
});

element<HTMLButtonElement>("reconnect").addEventListener("click", () => {
  channelStatus.textContent = "Reconnecting…";
  void chrome.runtime.sendMessage({ type: "reconnect" });
});

element<HTMLButtonElement>("disconnect").addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "disconnect" });
  channelStatus.textContent = "Disconnected.";
});

element<HTMLButtonElement>("grant-site").addEventListener("click", () => {
  void grantSite();
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (isConnectionMessage(message)) renderConnection(message.state);
});
chrome.permissions.onAdded.addListener(() => void refreshSiteList());
chrome.permissions.onRemoved.addListener(() => void refreshSiteList());

void Promise.all([
  chrome.runtime
    .sendMessage({ type: "get-connection-state" })
    .then((state: ConnectionView) => renderConnection(state)),
  chrome.storage.local.get("channel").then((values) => {
    if (validChannel(values.channel)) channelInput.value = values.channel;
  }),
  refreshSiteList(),
]).catch(() => {
  connectionText.textContent = "Extension settings could not be loaded.";
});

async function saveChannel(): Promise<void> {
  const value = channelInput.value.trim();
  if (!validChannel(value)) {
    channelStatus.textContent =
      "Enter a channel with lowercase letters, numbers, or hyphens (up to 40 characters).";
    return;
  }
  channelStatus.textContent = "Saving and reconnecting…";
  try {
    const result = await chrome.runtime.sendMessage({
      type: "set-channel",
      channel: value,
    });
    channelStatus.textContent = result?.ok
      ? "Channel saved."
      : "The channel could not be saved.";
  } catch {
    channelStatus.textContent = "The channel could not be saved.";
  }
}

async function grantSite(): Promise<void> {
  permissionStatus.textContent = "";
  let pattern: string;
  try {
    const parsed = parseWebUrl(siteInput.value.trim());
    pattern = exactOriginPattern(parsed.href);
  } catch {
    permissionStatus.textContent =
      "Enter a valid HTTP(S) site URL without username or password.";
    return;
  }
  try {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) {
      permissionStatus.textContent =
        "Chrome did not grant access to that site.";
      return;
    }
    const stored = await chrome.storage.local.get(EXPLICIT_SITE_ORIGINS_KEY);
    await chrome.storage.local.set({
      [EXPLICIT_SITE_ORIGINS_KEY]: addExplicitSiteConsent(
        stored[EXPLICIT_SITE_ORIGINS_KEY],
        pattern,
      ),
    });
    permissionStatus.textContent = "Site access granted for title requests.";
    siteInput.value = "";
  } catch {
    permissionStatus.textContent =
      "Access may have been granted in Chrome, but the explicit site approval could not be saved. Try Grant site again.";
  }
  try {
    await refreshSiteList();
  } catch {
    // Keep the result message; the permission grant or revocation has already completed.
  }
}

async function refreshSiteList(): Promise<void> {
  const [permissions, stored] = await Promise.all([
    chrome.permissions.getAll(),
    chrome.storage.local.get(EXPLICIT_SITE_ORIGINS_KEY),
  ]);
  const explicit = new Set(
    explicitSiteOrigins(stored[EXPLICIT_SITE_ORIGINS_KEY]),
  );
  const origins = [...new Set(permissions.origins ?? [])]
    .filter((origin) => /^https?:\/\//i.test(origin))
    .sort();
  siteList.replaceChildren();
  emptySites.hidden = origins.length > 0;
  for (const origin of origins) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    const exact = isExactOriginPattern(origin);
    const enabled = exact && explicit.has(origin);
    label.textContent = `${displayOrigin(origin)} — ${enabled ? "enabled for title requests" : exact ? "click Grant site to enable title requests" : "broad permission ignored for title requests"}`;
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "revoke";
    revoke.textContent = "Revoke";
    revoke.setAttribute(
      "aria-label",
      `Revoke access for ${displayOrigin(origin)}`,
    );
    revoke.addEventListener("click", () => {
      void revokeOrigin(origin, revoke);
    });
    item.append(label, revoke);
    siteList.append(item);
  }
}

async function revokeOrigin(
  origin: string,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  try {
    const result = await revokeSiteApproval(origin, {
      clearApproval: async (pattern) => {
        const stored = await chrome.storage.local.get(
          EXPLICIT_SITE_ORIGINS_KEY,
        );
        await chrome.storage.local.set({
          [EXPLICIT_SITE_ORIGINS_KEY]: removeExplicitSiteConsent(
            stored[EXPLICIT_SITE_ORIGINS_KEY],
            pattern,
          ),
        });
      },
      notifyBackground: async (pattern) => {
        const response = await chrome.runtime.sendMessage({
          type: "site-consent-revoked",
          origin: pattern,
        });
        if (response?.ok !== true) {
          throw new Error(
            "The background did not confirm request cancellation.",
          );
        }
      },
      removeChromePermission: (pattern) =>
        chrome.permissions.remove({ origins: [pattern] }),
    });
    let chromeStatus: string;
    try {
      const permissions = await chrome.permissions.getAll();
      const chromeStillHasExactPermission = (
        permissions.origins ?? []
      ).includes(origin);
      chromeStatus = chromeStillHasExactPermission
        ? "Chrome access permission was not removed."
        : result.chromePermissionRemoved
          ? "Chrome's exact origin permission was removed."
          : "Chrome no longer lists the exact origin permission.";
    } catch {
      chromeStatus = "Chrome's permission state could not be checked.";
    }
    permissionStatus.textContent = result.backgroundNotified
      ? `Site approval is disabled in the extension. ${chromeStatus}`
      : `Site approval is disabled in the extension, but cancellation of an active request could not be confirmed. ${chromeStatus}`;
  } catch {
    permissionStatus.textContent =
      "The extension could not clear this site's approval. No Chrome permission change was attempted.";
  } finally {
    button.disabled = false;
  }
  await refreshSiteList();
}

function displayOrigin(pattern: string): string {
  const exact = /^(https?):\/\/([^/]+)\/\*$/.exec(pattern);
  return exact ? `${exact[1]}://${exact[2]}` : "Granted HTTP(S) site pattern";
}

function renderConnection(view: ConnectionView): void {
  if (view.connected)
    connectionText.textContent = `Connected on channel “${view.channel}”.`;
  else if (view.retrying)
    connectionText.textContent = "Disconnected. Retrying with a delay…";
  else if (view.connecting)
    connectionText.textContent = "Connecting to the local host…";
  else connectionText.textContent = view.error?.message ?? "Disconnected.";
  if (!channelInput.value) channelInput.value = view.channel;
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
    typeof value.state === "object" &&
    value.state !== null
  );
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing settings element: ${id}`);
  return value as T;
}

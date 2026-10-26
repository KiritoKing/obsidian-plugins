import { parseWebUrl } from "@chlrc/browser-profile-title-protocol";
import { classifyPage, normalizeTitle } from "../../src/page-classification";
import {
  readVisibleTitle,
  type InjectedTitleResult,
} from "../../src/title-reader";
import type { ConnectionView } from "../../src/native-connection";

const connectionText = element<HTMLParagraphElement>("connection");
const channelText = element<HTMLSpanElement>("channel");
const readerStatus = element<HTMLParagraphElement>("reader-status");
const titleOutput = element<HTMLParagraphElement>("title-output");

element<HTMLButtonElement>("reconnect").addEventListener("click", () => {
  readerStatus.textContent = "";
  void chrome.runtime.sendMessage({ type: "reconnect" });
});

element<HTMLButtonElement>("disconnect").addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "disconnect" });
});

element<HTMLButtonElement>("open-settings").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

element<HTMLButtonElement>("read-title").addEventListener("click", () => {
  void readCurrentPageTitle();
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (isConnectionMessage(message)) renderConnection(message.state);
});

void chrome.runtime
  .sendMessage({ type: "get-connection-state" })
  .then((state: ConnectionView) => {
    renderConnection(state);
  })
  .catch(() => {
    connectionText.textContent = "Extension background is unavailable.";
  });

async function readCurrentPageTitle(): Promise<void> {
  titleOutput.textContent = "";
  readerStatus.textContent = "Reading the current page…";
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (typeof tab?.id !== "number" || !tab.url) {
      readerStatus.textContent = "Open an HTTP(S) page, then try again.";
      return;
    }
    parseWebUrl(tab.url);
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
  }
}

function renderConnection(view: ConnectionView): void {
  channelText.textContent = view.channel;
  if (view.connected)
    connectionText.textContent = "Connected to the local host.";
  else if (view.retrying)
    connectionText.textContent = "Disconnected. Retrying with a delay…";
  else if (view.connecting)
    connectionText.textContent = "Connecting to the local host…";
  else connectionText.textContent = view.error?.message ?? "Disconnected.";
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

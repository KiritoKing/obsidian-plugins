import type { BrowserTab, TitleResolutionPlatform } from "./title-resolution";
import {
  cancelVisibleTitleRead,
  readVisibleTitle,
  type InjectedTitleResult,
} from "./title-reader";
import {
  EXPLICIT_SITE_ORIGINS_KEY,
  isExactOriginPattern,
  isSiteAuthorized,
} from "./site-consent";

export function createChromeTitlePlatform(): TitleResolutionPlatform {
  return {
    async containsOrigin(pattern) {
      if (!isExactOriginPattern(pattern)) return false;
      const [permissions, stored] = await Promise.all([
        chrome.permissions.getAll(),
        chrome.storage.local.get(EXPLICIT_SITE_ORIGINS_KEY),
      ]);
      return isSiteAuthorized(
        permissions.origins,
        stored[EXPLICIT_SITE_ORIGINS_KEY],
        pattern,
      );
    },
    async listTabs() {
      const tabs = await chrome.tabs.query({});
      return tabs.flatMap((tab) =>
        typeof tab.id === "number"
          ? [{ id: tab.id, url: tab.url, status: tab.status }]
          : [],
      );
    },
    async getTab(tabId) {
      return toBrowserTab(await chrome.tabs.get(tabId));
    },
    async createBackgroundTab(url) {
      const tab = await chrome.tabs.create({ url, active: false });
      if (typeof tab.id !== "number")
        throw new Error("Chrome did not return a tab id.");
      return toBrowserTab(tab);
    },
    waitForTabComplete(tabId, timeoutMs, signal) {
      return waitForTabComplete(tabId, timeoutMs, signal);
    },
    async readTitle(tabId, taskId, timeoutMs) {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        world: "ISOLATED",
        func: readVisibleTitle,
        args: [taskId, timeoutMs],
      });
      const result = results[0]?.result as InjectedTitleResult | undefined;
      if (
        !result ||
        typeof result.title !== "string" ||
        typeof result.url !== "string"
      ) {
        throw new Error("The page title could not be read.");
      }
      return result;
    },
    async cancelRead(tabId, taskId) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          world: "ISOLATED",
          func: cancelVisibleTitleRead,
          args: [taskId],
        });
      } catch {
        // Navigation or tab closure already ended the isolated-world task.
      }
    },
    async closeTab(tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // The user or browser may already have closed the task-owned tab.
      }
    },
  };
}

function toBrowserTab(tab: chrome.tabs.Tab): BrowserTab {
  if (typeof tab.id !== "number")
    throw new Error("Chrome returned a tab without an id.");
  return { id: tab.id, url: tab.url, status: tab.status };
}

function waitForTabComplete(
  tabId: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<BrowserTab> {
  if (signal.aborted) return Promise.reject(new Error("Cancelled"));
  return new Promise<BrowserTab>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, tab?: BrowserTab): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (tab) resolve(tab);
      else reject(new Error("The tab did not finish loading."));
    };
    const onUpdated: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (
      updatedId,
      changeInfo,
      tab,
    ) => {
      if (updatedId === tabId && changeInfo.status === "complete") {
        try {
          finish(undefined, toBrowserTab(tab));
        } catch (error) {
          finish(toError(error));
        }
      }
    };
    const onRemoved = (removedId: number): void => {
      if (removedId === tabId) finish(new Error("The tab was closed."));
    };
    const onAbort = (): void => finish(new Error("Cancelled"));
    const timer = setTimeout(
      () => finish(new Error("The page load timed out.")),
      timeoutMs,
    );

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    signal.addEventListener("abort", onAbort, { once: true });
    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") finish(undefined, toBrowserTab(tab));
      })
      .catch((error: unknown) => finish(toError(error)));
  });
}

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("The browser tab operation failed.");
}

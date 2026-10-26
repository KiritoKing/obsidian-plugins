import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  parseWebUrl,
  type ErrorCode,
  type ResolveTitleRequest,
  type TitleResult,
} from "@chlrc/browser-profile-title-protocol";
import { classifyPage, normalizeTitle } from "./page-classification";
import { exactOriginPattern, isExactUrl, isSameOrigin } from "./url-policy";
import type { InjectedTitleResult } from "./title-reader";

export type BrowserTab = { id: number; url?: string; status?: string };

export interface TitleResolutionPlatform {
  containsOrigin(pattern: string): Promise<boolean>;
  listTabs(): Promise<BrowserTab[]>;
  getTab(tabId: number): Promise<BrowserTab>;
  createBackgroundTab(url: string): Promise<BrowserTab>;
  waitForTabComplete(
    tabId: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<BrowserTab>;
  readTitle(
    tabId: number,
    taskId: string,
    timeoutMs: number,
  ): Promise<InjectedTitleResult>;
  cancelRead(tabId: number, taskId: string): Promise<void>;
  closeTab(tabId: number): Promise<void>;
}

export class TitleResolutionError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TitleResolutionError";
  }
}

export async function resolveTitle(
  request: ResolveTitleRequest,
  taskId: string,
  platform: TitleResolutionPlatform,
  signal: AbortSignal,
): Promise<TitleResult> {
  const requested = parseWebUrl(request.url);
  const permission = exactOriginPattern(request.url);
  if (!(await platform.containsOrigin(permission))) {
    throw new TitleResolutionError(
      "HOST_PERMISSION_REQUIRED",
      "Grant this site in extension settings before requesting its title.",
    );
  }

  let ownedTabId: number | undefined;
  let activeTabId: number | undefined;
  let readStarted = false;
  const onAbort = (): void => {
    if (readStarted && activeTabId !== undefined)
      void platform.cancelRead(activeTabId, taskId).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    ensureNotAborted(signal);
    const tabs = await platform.listTabs();
    ensureNotAborted(signal);
    const matchingTab = tabs.find((tab) => isExactUrl(tab.url, requested.href));
    if (matchingTab) {
      activeTabId = matchingTab.id;
    } else {
      const created = await platform.createBackgroundTab(requested.href);
      activeTabId = created.id;
      ownedTabId = created.id;
    }
    ensureNotAborted(signal);

    let tab = await platform.getTab(activeTabId);
    if (tab.status !== "complete") {
      const waitMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(DEFAULT_TIMEOUT_MS, request.timeoutMs),
      );
      tab = await platform.waitForTabComplete(activeTabId, waitMs, signal);
    }
    ensureNotAborted(signal);

    const finalUrl = tab.url;
    if (!finalUrl || !isSameOrigin(finalUrl, requested.origin)) {
      throw new TitleResolutionError(
        "FORBIDDEN",
        "The page redirected outside the permitted site.",
      );
    }
    if (!(await platform.containsOrigin(permission))) {
      throw new TitleResolutionError(
        "HOST_PERMISSION_REQUIRED",
        "Permission for this site was removed during the request.",
      );
    }
    const finalPage = parseWebUrl(finalUrl);
    if (finalPage.origin !== requested.origin) {
      throw new TitleResolutionError(
        "FORBIDDEN",
        "The page redirected outside the permitted site.",
      );
    }

    readStarted = true;
    const read = await raceAbort(
      platform.readTitle(activeTabId, taskId, MAX_TIMEOUT_MS),
      signal,
    );
    ensureNotAborted(signal);
    if (read.state === "cancelled") {
      throw new TitleResolutionError(
        "CANCELLED",
        "The title request was cancelled.",
      );
    }
    if (read.state === "timeout") {
      throw new TitleResolutionError(
        "TIMEOUT",
        "The page title did not become stable before the request timed out.",
      );
    }
    if (!isSameOrigin(read.url, requested.origin)) {
      throw new TitleResolutionError(
        "FORBIDDEN",
        "The page redirected outside the permitted site.",
      );
    }
    if (!(await platform.containsOrigin(permission))) {
      throw new TitleResolutionError(
        "HOST_PERMISSION_REQUIRED",
        "Permission for this site was removed during the request.",
      );
    }

    const title = normalizeTitle(read.title);
    const pageFailure = classifyPage(read.url, title);
    if (pageFailure)
      throw new TitleResolutionError(pageFailure.code, pageFailure.message);
    return { title, url: request.url, source: "browser" };
  } catch (error) {
    if (signal.aborted)
      throw new TitleResolutionError(
        "CANCELLED",
        "The title request was cancelled.",
      );
    if (error instanceof TitleResolutionError) throw error;
    throw new TitleResolutionError(
      "TITLE_UNAVAILABLE",
      "The browser could not read a title from this page.",
    );
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (ownedTabId !== undefined) {
      await platform.closeTab(ownedTabId).catch(() => undefined);
    }
  }
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new TitleResolutionError(
      "CANCELLED",
      "The title request was cancelled.",
    );
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(
      new TitleResolutionError("CANCELLED", "The title request was cancelled."),
    );
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(
        new TitleResolutionError(
          "CANCELLED",
          "The title request was cancelled.",
        ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

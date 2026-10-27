import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { DEFAULT_TIMEOUT_MS } from "@chlrc/browser-profile-title-protocol";
import { parseWebUrl } from "@chlrc/browser-profile-title-protocol";
import { cleanTitle } from "./title-format";
import { isUsableTitle } from "./title-resolver";

const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const HTML_CONTENT_TYPE = /(?:text\/html|application\/xhtml\+xml)/i;
const TITLE_STABILITY_MS = 200;
const AUTH_PATH_SEGMENT =
  /^(?:login|log-in|signin|sign-in|logon|auth|authenticate|authorization|oauth|sso)$/i;

export type LegacyTitleFailureKind =
  | "timeout"
  | "unavailable"
  | "no-title"
  | "blocked"
  | "failed";

export class LegacyTitleError extends Error {
  constructor(readonly kind: LegacyTitleFailureKind) {
    super(kind);
    this.name = "LegacyTitleError";
  }
}

export interface LegacyHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
  finalUrl: string;
}

export interface LegacyRenderedPage {
  title: string;
  finalUrl: string;
}

export interface LegacyTitleDependencies {
  head(url: string, timeoutMs: number): Promise<LegacyHttpResponse>;
  get(url: string, timeoutMs: number): Promise<LegacyHttpResponse>;
  render?(url: string, timeoutMs: number): Promise<LegacyRenderedPage>;
}

interface ElectronEvent {
  preventDefault?(): void;
}

type ElectronListener = (...args: unknown[]) => void;

export interface ElectronEventSource {
  on(event: string, listener: ElectronListener): unknown;
  removeListener(event: string, listener: ElectronListener): unknown;
}

export interface ElectronSessionLike extends ElectronEventSource {
  setPermissionRequestHandler?(
    handler:
      | ((
          webContents: unknown,
          permission: string,
          callback: (allowed: boolean) => void,
        ) => void)
      | null,
  ): void;
  setPermissionCheckHandler?(
    handler: ((webContents: unknown, permission: string) => boolean) | null,
  ): void;
  clearStorageData?(): Promise<void> | void;
  clearCache?(): Promise<void> | void;
}

export interface ElectronWebContentsLike extends ElectronEventSource {
  session: ElectronSessionLike;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
}

export interface ElectronWindowLike {
  webContents: ElectronWebContentsLike;
  destroy(): void;
  isDestroyed?(): boolean;
}

export interface SecureBrowserWindowOptions {
  show: false;
  width: number;
  height: number;
  webPreferences: {
    webSecurity: true;
    nodeIntegration: false;
    contextIsolation: true;
    sandbox: true;
    webviewTag: false;
    partition: string;
  };
}

export type SecureWindowFactory = (
  options: SecureBrowserWindowOptions,
) => ElectronWindowLike;

export async function resolveLegacyTitle(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  dependencies: LegacyTitleDependencies = createDefaultLegacyDependencies(),
): Promise<string> {
  const requestedUrl = canonicalWebUrl(url);
  const deadline = Date.now() + validTimeout(timeoutMs);
  const headBudget = Math.max(
    25,
    Math.min(1500, Math.floor(validTimeout(timeoutMs) * 0.2)),
  );

  let headResponse: LegacyHttpResponse | null = null;
  try {
    headResponse = await withDeadline(
      () =>
        dependencies.head(
          requestedUrl,
          Math.min(headBudget, timeLeft(deadline)),
        ),
      Math.min(headBudget, timeLeft(deadline)),
    );
  } catch {
    // Some servers reject HEAD even when their page can be read. Keep trying.
  }

  let headUrl = requestedUrl;
  if (headResponse) {
    try {
      headUrl = safeResponseUrl(headResponse.finalUrl, requestedUrl);
    } catch {
      headResponse = null;
    }
  }
  if (
    headResponse &&
    isSuccessful(headResponse.status) &&
    hasKnownNonHtmlType(headResponse.headers) &&
    !isAuthenticationPage(headUrl)
  ) {
    const fileTitle = filenameTitle(headUrl);
    if (isUsableTitle(fileTitle)) return cleanTitle(fileTitle);
  }

  if (dependencies.render) {
    const remaining = timeLeft(deadline);
    const reserveForHttp = Math.min(1500, Math.floor(remaining * 0.25));
    const renderBudget = remaining - reserveForHttp;
    if (renderBudget > 0) {
      try {
        const boundedRenderBudget = Math.max(1, renderBudget - 10);
        const rendered = await withDeadline(
          () =>
            dependencies.render?.(
              requestedUrl,
              boundedRenderBudget,
            ) as Promise<LegacyRenderedPage>,
          renderBudget,
        );
        const finalUrl = safeResponseUrl(rendered.finalUrl, requestedUrl);
        if (
          !isAuthenticationPage(finalUrl) &&
          isUsableTitle(rendered.title, finalUrl)
        ) {
          return cleanTitle(rendered.title);
        }
      } catch (error) {
        if (error instanceof LegacyTitleError && error.kind === "timeout") {
          // The HTTP parser still gets the reserved part of the deadline.
        }
      }
    }
  }

  const remaining = timeLeft(deadline);
  if (remaining <= 0) throw new LegacyTitleError("timeout");

  let response: LegacyHttpResponse;
  try {
    response = await withDeadline(
      () => dependencies.get(requestedUrl, remaining),
      remaining,
    );
  } catch (error) {
    if (failureKind(error) === "timeout") throw new LegacyTitleError("timeout");
    throw new LegacyTitleError("unavailable");
  }

  const finalUrl = safeResponseUrl(response.finalUrl, requestedUrl);
  if (response.status === 401 || response.status === 403) {
    throw new LegacyTitleError("blocked");
  }
  if (!isSuccessful(response.status)) throw new LegacyTitleError("unavailable");

  if (isHtmlResponse(response.headers, response.body ?? "")) {
    const title = parseHtmlTitle(response.body ?? "");
    if (
      !title ||
      isAuthenticationPage(finalUrl) ||
      isAuthenticationMarkup(response.body ?? "") ||
      !isUsableTitle(title, finalUrl)
    ) {
      throw new LegacyTitleError("no-title");
    }
    return cleanTitle(title);
  }

  if (isAuthenticationPage(finalUrl)) throw new LegacyTitleError("blocked");
  const fileTitle = filenameTitle(finalUrl);
  if (!isUsableTitle(fileTitle, finalUrl))
    throw new LegacyTitleError("no-title");
  return cleanTitle(fileTitle);
}

export function createElectronTitleReader(
  createWindow: SecureWindowFactory,
  createPartition: () => string = () =>
    `temp:browser-profile-title-${randomToken()}`,
): (url: string, timeoutMs: number) => Promise<LegacyRenderedPage> {
  return (url, timeoutMs) =>
    new Promise<LegacyRenderedPage>((resolve, reject) => {
      let parsedUrl: URL;
      try {
        parsedUrl = parseWebUrl(url);
      } catch {
        reject(new LegacyTitleError("blocked"));
        return;
      }

      let window: ElectronWindowLike;
      try {
        window = createWindow(secureBrowserWindowOptions(createPartition()));
      } catch {
        reject(new LegacyTitleError("unavailable"));
        return;
      }

      const contents = window.webContents;
      const session = contents.session;
      const registered: Array<{
        target: ElectronEventSource;
        event: string;
        listener: ElectronListener;
      }> = [];
      let settled = false;
      let loadFinished = false;
      let stableTitleTimer: ReturnType<typeof setTimeout> | undefined;
      const safeTimeoutMs = validTimeout(timeoutMs);
      const timer = setTimeout(
        () => finish(new LegacyTitleError("timeout")),
        safeTimeoutMs,
      );

      const finish = (error?: LegacyTitleError, page?: LegacyRenderedPage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stableTitleTimer) clearTimeout(stableTitleTimer);
        for (const entry of registered) {
          try {
            entry.target.removeListener(entry.event, entry.listener);
          } catch {
            // Continue disposing the remaining listeners and the window.
          }
        }
        try {
          session.setPermissionRequestHandler?.(null);
          session.setPermissionCheckHandler?.(null);
        } catch {
          // The temporary session is discarded with its window.
        }
        try {
          if (!window.isDestroyed?.()) window.destroy();
        } catch {
          // A failed navigation can destroy its own window first.
        }
        try {
          for (const clearing of [
            session.clearStorageData?.(),
            session.clearCache?.(),
          ]) {
            if (
              clearing &&
              typeof (clearing as Promise<void>).catch === "function"
            ) {
              void (clearing as Promise<void>).catch(() => undefined);
            }
          }
        } catch {
          // The partition is in-memory and is released with the window.
        }
        if (error) reject(error);
        else if (page) resolve(page);
        else reject(new LegacyTitleError("no-title"));
      };

      const listen = (
        target: ElectronEventSource,
        event: string,
        listener: ElectronListener,
      ) => {
        target.on(event, listener);
        registered.push({ target, event, listener });
      };

      try {
        session.setPermissionRequestHandler?.(
          (_contents, _permission, callback) => callback(false),
        );
        session.setPermissionCheckHandler?.(() => false);
        contents.setWindowOpenHandler(() => ({ action: "deny" }));

        const onNavigation = (...args: unknown[]) => {
          const [event, navigationUrl] = args as [ElectronEvent, unknown];
          if (typeof navigationUrl !== "string" || !isHttpUrl(navigationUrl)) {
            event?.preventDefault?.();
            finish(new LegacyTitleError("blocked"));
          }
        };
        listen(contents, "will-navigate", onNavigation);
        listen(contents, "will-redirect", onNavigation);

        const onDownload = (...args: unknown[]) => {
          const [event, item] = args as [ElectronEvent, { cancel?(): void }?];
          event?.preventDefault?.();
          try {
            item?.cancel?.();
          } catch {
            // The download was already stopped by its session event.
          }
          finish(new LegacyTitleError("blocked"));
        };
        listen(session, "will-download", onDownload);

        const scheduleStableTitleCheck = () => {
          if (settled || !loadFinished) return;
          if (stableTitleTimer) clearTimeout(stableTitleTimer);

          let finalUrl: string;
          let title: string;
          try {
            finalUrl = canonicalWebUrl(contents.getURL());
            title = contents.getTitle();
          } catch {
            finish(new LegacyTitleError("no-title"));
            return;
          }

          if (!isUsableTitle(title, finalUrl)) return;
          stableTitleTimer = setTimeout(() => {
            stableTitleTimer = undefined;
            if (settled) return;
            try {
              const currentUrl = canonicalWebUrl(contents.getURL());
              const currentTitle = contents.getTitle();
              if (
                currentUrl === finalUrl &&
                currentTitle === title &&
                isUsableTitle(currentTitle, currentUrl)
              ) {
                finish(undefined, {
                  title: currentTitle,
                  finalUrl: currentUrl,
                });
                return;
              }
              scheduleStableTitleCheck();
            } catch {
              finish(new LegacyTitleError("no-title"));
            }
          }, TITLE_STABILITY_MS);
        };

        const onLoadFinished = () => {
          loadFinished = true;
          scheduleStableTitleCheck();
        };
        listen(contents, "did-finish-load", onLoadFinished);
        listen(contents, "page-title-updated", scheduleStableTitleCheck);

        const onLoadFailed = (...args: unknown[]) => {
          const [, errorCode, , , isMainFrame] = args;
          if (isMainFrame === false) return;
          finish(
            errorCode === -3
              ? new LegacyTitleError("blocked")
              : new LegacyTitleError("unavailable"),
          );
        };
        listen(contents, "did-fail-load", onLoadFailed);

        void contents.loadURL(parsedUrl.href).catch(() => {
          finish(new LegacyTitleError("unavailable"));
        });
      } catch {
        finish(new LegacyTitleError("unavailable"));
      }
    });
}

export function secureBrowserWindowOptions(
  partition: string,
): SecureBrowserWindowOptions {
  if (!partition.startsWith("temp:") || partition.length > 128) {
    throw new LegacyTitleError("blocked");
  }
  return {
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      webSecurity: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      partition,
    },
  };
}

export function parseHtmlTitle(html: string): string | null {
  if (html.length > MAX_HTTP_BODY_BYTES) return null;
  const titleMatch = /<title\b([^>]*)>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!titleMatch) return null;
  const titleText = decodeHtmlEntities(
    titleMatch[2].replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]*>/g, " "),
  );
  const cleaned = cleanTitle(titleText);
  if (cleaned) return cleaned;

  const noTitleAttribute =
    /(?:^|\s)no-title(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/i.exec(
      titleMatch[1],
    );
  if (!noTitleAttribute) return null;
  const fallbackTitle = decodeHtmlEntities(
    noTitleAttribute[1] ?? noTitleAttribute[2] ?? noTitleAttribute[3] ?? "",
  );
  return cleanTitle(fallbackTitle) || null;
}

export function filenameTitle(url: string): string {
  try {
    const pathSegments = parseWebUrl(url).pathname.split("/").filter(Boolean);
    const lastSegment = pathSegments.at(-1);
    if (!lastSegment) return "";
    let decoded = lastSegment;
    try {
      decoded = decodeURIComponent(lastSegment);
    } catch {
      // Keep the encoded segment when it contains malformed escape sequences.
    }
    return cleanTitle(decoded);
  } catch {
    return "";
  }
}

function createDefaultLegacyDependencies(): LegacyTitleDependencies {
  const render = createDefaultElectronReader();
  return {
    head: (url, timeoutMs) => requestHttpWithRedirects(url, "HEAD", timeoutMs),
    get: (url, timeoutMs) => requestHttpWithRedirects(url, "GET", timeoutMs),
    ...(render ? { render } : {}),
  };
}

function createDefaultElectronReader():
  | ((url: string, timeoutMs: number) => Promise<LegacyRenderedPage>)
  | undefined {
  try {
    const electron = require("electron") as {
      remote?: {
        BrowserWindow?: new (options: SecureBrowserWindowOptions) => unknown;
      };
    };
    const BrowserWindow = electron.remote?.BrowserWindow;
    if (!BrowserWindow) return undefined;
    return createElectronTitleReader(
      (options) => new BrowserWindow(options) as ElectronWindowLike,
    );
  } catch {
    return undefined;
  }
}

async function requestHttpWithRedirects(
  url: string,
  method: "HEAD" | "GET",
  timeoutMs: number,
): Promise<LegacyHttpResponse> {
  const deadline = Date.now() + validTimeout(timeoutMs);
  let currentUrl = canonicalWebUrl(url);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const remaining = timeLeft(deadline);
    if (remaining <= 0) throw new LegacyTitleError("timeout");
    const response = await requestOne(currentUrl, method, remaining);
    const location = headerValue(response.headers.location);
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      return { ...response, finalUrl: currentUrl };
    }

    if (redirectCount === MAX_REDIRECTS) {
      throw new LegacyTitleError("blocked");
    }
    try {
      currentUrl = canonicalWebUrl(new URL(location, currentUrl).href);
    } catch {
      throw new LegacyTitleError("blocked");
    }
  }

  throw new LegacyTitleError("blocked");
}

async function requestOne(
  url: string,
  method: "HEAD" | "GET",
  timeoutMs: number,
): Promise<LegacyHttpResponse> {
  const parsed = parseWebUrl(url);
  const makeRequest = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  const boundedTimeout = Math.max(1, Math.floor(timeoutMs));

  return new Promise<LegacyHttpResponse>((resolve, reject) => {
    let settled = false;
    const chunks: Uint8Array[] = [];
    let size = 0;
    const finish = (
      error?: LegacyTitleError,
      response?: LegacyHttpResponse,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (response) resolve(response);
      else reject(new LegacyTitleError("unavailable"));
    };
    const timer = setTimeout(() => {
      request.destroy();
      finish(new LegacyTitleError("timeout"));
    }, boundedTimeout);

    const request = makeRequest(
      parsed,
      {
        method,
        agent: false,
        headers: {
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Encoding": "identity",
          ...(method === "GET"
            ? { Range: `bytes=0-${MAX_HTTP_BODY_BYTES - 1}` }
            : {}),
          "User-Agent": "BrowserProfileLinkTitle/0.1",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const headers = normalizeHeaders(response.headers);
        response.once("error", () =>
          finish(new LegacyTitleError("unavailable")),
        );
        if (
          method === "HEAD" ||
          isRedirectStatus(status) ||
          (method === "GET" && hasKnownNonHtmlType(headers))
        ) {
          finish(undefined, { status, headers, finalUrl: parsed.href });
          response.destroy();
          return;
        }

        const contentLength = Number(headerValue(headers["content-length"]));
        if (
          Number.isFinite(contentLength) &&
          contentLength > MAX_HTTP_BODY_BYTES
        ) {
          finish(new LegacyTitleError("failed"));
          response.destroy();
          request.destroy();
          return;
        }

        response.on("data", (chunk: Uint8Array | string) => {
          if (settled) return;
          const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          size += bytes.byteLength;
          if (size > MAX_HTTP_BODY_BYTES) {
            finish(new LegacyTitleError("failed"));
            response.destroy();
            request.destroy();
            return;
          }
          chunks.push(bytes);
        });
        response.once("end", () => {
          if (settled) return;
          const encoding = responseCharset(
            headerValue(headers["content-type"]),
          );
          let body: string;
          try {
            body = new TextDecoder(encoding).decode(Buffer.concat(chunks));
          } catch {
            body = Buffer.concat(chunks).toString("utf8");
          }
          finish(undefined, { status, headers, body, finalUrl: parsed.href });
        });
      },
    );

    request.once("error", (error: unknown) => {
      finish(
        failureKind(error) === "timeout"
          ? new LegacyTitleError("timeout")
          : new LegacyTitleError("unavailable"),
      );
    });
    request.setTimeout(boundedTimeout, () => {
      request.destroy(new LegacyTitleError("timeout"));
    });
    request.end();
  });
}

function normalizeHeaders(
  headers: Record<string, string | string[] | number | undefined>,
): Record<string, string | string[] | undefined> {
  const normalized: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] =
      typeof value === "number" ? String(value) : value;
  }
  return normalized;
}

function isHtmlResponse(
  headers: Record<string, string | string[] | undefined>,
  body: string,
): boolean {
  const contentType = headerValue(headers["content-type"]);
  if (contentType) return HTML_CONTENT_TYPE.test(contentType);
  return /^\s*(?:<!doctype\s+html|<html\b|<head\b)/i.test(body);
}

function hasKnownNonHtmlType(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const contentType = headerValue(headers["content-type"]);
  return Boolean(contentType && !HTML_CONTENT_TYPE.test(contentType));
}

function isAuthenticationPage(url: string): boolean {
  try {
    return parseWebUrl(url)
      .pathname.split("/")
      .some((segment) => {
        let decoded = segment;
        try {
          decoded = decodeURIComponent(segment);
        } catch {
          // Test the encoded segment as-is when it is not valid percent encoding.
        }
        return AUTH_PATH_SEGMENT.test(decoded);
      });
  } catch {
    return true;
  }
}

function isAuthenticationMarkup(markup: string): boolean {
  const hasPasswordField = /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(
    markup,
  );
  if (!hasPasswordField) return false;
  const text = decodeHtmlEntities(
    markup
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  );
  return /sign\s*in|log\s*in|login|authenticate|登录|登陆|身份验证/i.test(text);
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    copy: "©",
    gt: ">",
    hellip: "…",
    ldquo: "“",
    lsquo: "‘",
    mdash: "—",
    nbsp: " ",
    ndash: "–",
    quot: '"',
    rdquo: "”",
    reg: "®",
    rsquo: "’",
  };
  return value.replace(
    /&(#(?:x[\da-f]{1,8}|\d{1,8})|[a-z][a-z\d]{1,20});/gi,
    (entity, code: string) => {
      if (code.startsWith("#")) {
        const numeric =
          code[1]?.toLowerCase() === "x"
            ? Number.parseInt(code.slice(2), 16)
            : Number.parseInt(code.slice(1), 10);
        if (
          !Number.isInteger(numeric) ||
          numeric <= 0 ||
          numeric > 0x10ffff ||
          (numeric >= 0xd800 && numeric <= 0xdfff)
        ) {
          return "\uFFFD";
        }
        return String.fromCodePoint(numeric);
      }
      return named[code.toLowerCase()] ?? entity;
    },
  );
}

function responseCharset(contentType: string | undefined): string {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType ?? "");
  return charset?.[1] ?? "utf-8";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isSuccessful(status: number): boolean {
  return status >= 200 && status < 300;
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function canonicalWebUrl(url: string): string {
  try {
    return parseWebUrl(url).href;
  } catch {
    throw new LegacyTitleError("blocked");
  }
}

function safeResponseUrl(url: string, fallbackUrl: string): string {
  return canonicalWebUrl(url || fallbackUrl);
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function validTimeout(timeoutMs: number): number {
  return Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30_000
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;
}

function timeLeft(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function failureKind(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}

function withDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) return Promise.reject(new LegacyTitleError("timeout"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new LegacyTitleError("timeout"));
    }, timeoutMs);
    Promise.resolve()
      .then(operation)
      .then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

function randomToken(): string {
  return randomBytes(18).toString("base64url");
}

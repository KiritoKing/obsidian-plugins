import { cleanTitle } from "./title-format";

export type ResolverStatusRoute =
  | "idle"
  | "browser"
  | "fallback"
  | "unavailable";

export type ResolverStatusReason =
  | "host-permission-required"
  | "bridge-authentication"
  | "bridge-timeout"
  | "bridge-unavailable"
  | "browser-authentication"
  | "browser-title-unavailable"
  | "browser-failure"
  | "legacy-timeout"
  | "legacy-unavailable"
  | "legacy-no-title"
  | "legacy-blocked"
  | "legacy-failure";

export interface ResolverStatusSnapshot {
  readonly route: ResolverStatusRoute;
  readonly reason: ResolverStatusReason | null;
  readonly message: string;
}

export interface TitleResolution {
  title: string;
  route: "browser" | "fallback";
}

export interface TitleResolverOptions {
  browserTitle(url: string): Promise<string>;
  legacyTitle(url: string, timeoutMs: number): Promise<string>;
  fallbackEnabled: boolean;
  timeoutMs: number;
  onStatus?(status: ResolverStatusSnapshot): void;
}

export const INITIAL_RESOLVER_STATUS: ResolverStatusSnapshot = {
  route: "idle",
  reason: null,
  message: "No title lookup has run yet.",
};

const AUTH_OR_ACCESS_TITLE =
  /^(?:(?:please\s+)?(?:sign[\s-]?in|log[\s-]?in|login|logon)(?:\s+(?:to|at)\s+[\p{L}\p{N}][\p{L}\p{N} .'-]{0,80})?|authentication required|permission required|access denied|access restricted|permission denied|no permission|not authorized|request blocked|page unavailable|not found|forbidden|unauthorized)$/iu;
const AUTH_OR_ACCESS_TITLE_CJK =
  /^(?:登录|登陆|请登录|请先登录|需要登录|需要登录才能继续|无权限|权限不足|访问被拒绝|访问受限|请求被拒绝|页面不存在|页面不可用|未授权|认证失败|禁止访问)$/u;
const PLACEHOLDER_TITLE =
  /^(?:loading(?:\.{1,3}|…)?|untitled|title unavailable|site unreachable|title unavailable\s*[|:/—–-]\s*site unreachable)$/i;
const AUTH_PATH_SEGMENT =
  /^(?:login|log-in|signin|sign-in|logon|auth|authenticate|authorization|oauth|sso)$/i;

export function isUsableTitle(
  value: unknown,
  requestedUrl?: string,
): value is string {
  if (typeof value !== "string") return false;
  const normalized = cleanTitle(value);
  return (
    normalized.length > 0 &&
    !PLACEHOLDER_TITLE.test(normalized) &&
    !AUTH_OR_ACCESS_TITLE.test(normalized) &&
    !AUTH_OR_ACCESS_TITLE_CJK.test(normalized) &&
    !isSameWebUrl(normalized, requestedUrl) &&
    !isAuthenticationUrl(requestedUrl)
  );
}

export async function resolveTitleWithFallback(
  url: string,
  options: TitleResolverOptions,
): Promise<TitleResolution | null> {
  let browserFailure: unknown;
  let browserReason: ResolverStatusReason = "browser-failure";

  publishStatus(options, {
    route: "browser",
    reason: null,
    message: "Looking up the title through the browser profile.",
  });

  try {
    const title = await withTimeout(
      () => options.browserTitle(url),
      safeTimeout(options.timeoutMs) + 25,
    );
    if (isUsableTitle(title, url)) {
      const normalizedTitle = cleanTitle(title);
      publishStatus(options, {
        route: "browser",
        reason: null,
        message: "The title was retrieved through the browser profile.",
      });
      return { title: normalizedTitle, route: "browser" };
    }
    browserFailure = new Error("unusable browser title");
    browserReason = "browser-title-unavailable";
  } catch (error) {
    browserFailure = error;
    browserReason = browserReasonFor(error);
  }

  if (!options.fallbackEnabled) {
    publishStatus(options, {
      route: "unavailable",
      reason: browserReason,
      message: `${browserMessage(browserReason)} The legacy fallback is disabled.`,
    });
    throw browserFailure;
  }

  publishStatus(options, {
    route: "fallback",
    reason: browserReason,
    message: `${browserMessage(browserReason)} Trying the legacy title lookup.`,
  });

  try {
    const title = await withTimeout(
      () => options.legacyTitle(url, safeTimeout(options.timeoutMs)),
      safeTimeout(options.timeoutMs) + 25,
    );
    if (isUsableTitle(title, url)) {
      const normalizedTitle = cleanTitle(title);
      publishStatus(options, {
        route: "fallback",
        reason: browserReason,
        message: "The title was retrieved through the legacy fallback.",
      });
      return { title: normalizedTitle, route: "fallback" };
    }
    publishStatus(options, {
      route: "unavailable",
      reason: "legacy-no-title",
      message: "Neither lookup path returned a usable page title.",
    });
    return null;
  } catch (error) {
    const reason = legacyReasonFor(error);
    publishStatus(options, {
      route: "unavailable",
      reason,
      message: legacyMessage(reason),
    });
    return null;
  }
}

function isSameWebUrl(title: string, requestedUrl?: string): boolean {
  if (!requestedUrl) return false;
  try {
    const requestUrl = new URL(requestedUrl);
    if (!isHttpProtocol(requestUrl.protocol)) return false;

    const absoluteTitleUrl = tryParseHttpUrl(title);
    if (absoluteTitleUrl) return absoluteTitleUrl.href === requestUrl.href;

    const bareTitleUrl = tryParseBareWebUrl(title);
    return Boolean(bareTitleUrl && sameWebLocation(bareTitleUrl, requestUrl));
  } catch {
    return false;
  }
}

function tryParseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return isHttpProtocol(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

function tryParseBareWebUrl(value: string): URL | null {
  if (!value || /\s/.test(value) || value.includes("://")) return null;
  const withoutProtocolRelativePrefix = value.startsWith("//")
    ? value.slice(2)
    : value;
  try {
    return new URL(`http://${withoutProtocolRelativePrefix}`);
  } catch {
    return null;
  }
}

function sameWebLocation(left: URL, right: URL): boolean {
  return (
    left.username === right.username &&
    left.password === right.password &&
    left.host === right.host &&
    left.pathname === right.pathname &&
    left.search === right.search &&
    left.hash === right.hash
  );
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function isAuthenticationUrl(url?: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.split("/").some((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Test the encoded segment when it is malformed.
      }
      return AUTH_PATH_SEGMENT.test(decoded);
    });
  } catch {
    return false;
  }
}

function publishStatus(
  options: TitleResolverOptions,
  status: ResolverStatusSnapshot,
): void {
  try {
    options.onStatus?.({ ...status });
  } catch {
    // Status listeners must not change title-resolution behavior.
  }
}

class ResolverTimeoutError extends Error {
  readonly kind = "timeout";

  constructor() {
    super("timeout");
    this.name = "ResolverTimeoutError";
  }
}

function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ResolverTimeoutError());
    }, timeoutMs);

    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
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

function safeTimeout(value: number): number {
  return Number.isInteger(value) && value >= 100 && value <= 30_000
    ? value
    : 12_000;
}

function browserReasonFor(error: unknown): ResolverStatusReason {
  const record = errorRecord(error);
  if (record.kind === "timeout" || record.remoteCode === "TIMEOUT")
    return "bridge-timeout";
  if (record.kind === "authentication") return "bridge-authentication";
  if (record.kind === "unavailable") return "bridge-unavailable";
  if (record.remoteCode === "HOST_PERMISSION_REQUIRED")
    return "host-permission-required";
  if (
    record.remoteCode === "AUTH_REQUIRED" ||
    record.remoteCode === "AUTHENTICATION_FAILED" ||
    record.remoteCode === "FORBIDDEN"
  ) {
    return "browser-authentication";
  }
  if (
    record.remoteCode === "TITLE_UNAVAILABLE" ||
    record.remoteCode === "UNSUPPORTED"
  ) {
    return "browser-title-unavailable";
  }
  return "browser-failure";
}

function legacyReasonFor(error: unknown): ResolverStatusReason {
  const kind = errorRecord(error).kind;
  if (kind === "timeout") return "legacy-timeout";
  if (kind === "unavailable" || kind === "network") return "legacy-unavailable";
  if (kind === "no-title") return "legacy-no-title";
  if (kind === "blocked") return "legacy-blocked";
  return "legacy-failure";
}

function browserMessage(reason: ResolverStatusReason): string {
  switch (reason) {
    case "host-permission-required":
      return "The browser extension does not have access to this site.";
    case "bridge-authentication":
    case "browser-authentication":
      return "The browser profile could not authenticate the title request.";
    case "bridge-timeout":
      return "The browser title request timed out.";
    case "bridge-unavailable":
      return "The browser title bridge is unavailable.";
    case "browser-title-unavailable":
      return "The browser did not return a usable title.";
    default:
      return "The browser title lookup failed.";
  }
}

function legacyMessage(reason: ResolverStatusReason): string {
  switch (reason) {
    case "legacy-timeout":
      return "Neither lookup returned a title before the request timed out.";
    case "legacy-unavailable":
      return "The browser lookup and legacy network request both failed.";
    case "legacy-no-title":
      return "Neither lookup path returned a usable page title.";
    case "legacy-blocked":
      return "The legacy page lookup was blocked for safety.";
    default:
      return "Neither lookup path returned a usable page title.";
  }
}

function errorRecord(error: unknown): {
  kind?: string;
  remoteCode?: string;
} {
  if (typeof error !== "object" || error === null) return {};
  const value = error as { kind?: unknown; remoteCode?: unknown };
  return {
    kind: typeof value.kind === "string" ? value.kind : undefined,
    remoteCode:
      typeof value.remoteCode === "string" ? value.remoteCode : undefined,
  };
}

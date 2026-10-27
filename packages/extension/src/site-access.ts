import { parseWebUrl } from "@chlrc/browser-profile-title-protocol";
import {
  EXPLICIT_SITE_ORIGINS_KEY,
  explicitSiteOrigins,
  hasExplicitSiteConsent,
  isExactOriginPattern,
} from "./site-consent";
import { exactOriginPattern } from "./url-policy";

export type SiteAccessStatus =
  | "authorized"
  | "not-authorized"
  | "chrome-permission-missing"
  | "unavailable"
  | "restricted-page";

export type SiteAccessView = {
  status: SiteAccessStatus;
  origin?: string;
  pattern?: string;
  chromeAccess: boolean;
  explicitApproval: boolean;
};

export type SiteAccessReader = {
  readChromeOrigins: () => Promise<unknown>;
  readExplicitApprovals: () => Promise<unknown>;
  containsChromePermission: (pattern: string) => Promise<boolean>;
};

export type SiteAccessList = {
  sites: SiteAccessView[];
  broadChromePermissions: string[];
};

export function isExplicitSiteOriginsStorageChange(
  changes: Record<string, unknown>,
  areaName: string,
): boolean {
  return areaName === "local" && EXPLICIT_SITE_ORIGINS_KEY in changes;
}

export type GrantSiteActions = {
  requestChromePermission: (pattern: string) => Promise<boolean>;
  readExplicitApprovals: () => Promise<unknown>;
  saveExplicitApprovals: (origins: string[]) => Promise<void>;
  clearExplicitApproval?: (pattern: string) => Promise<void>;
  containsChromePermission: (pattern: string) => Promise<boolean>;
  isCurrentSite?: () => Promise<boolean>;
};

export type GrantSiteResult =
  | "authorized"
  | "denied"
  | "permission-error"
  | "approval-save-failed"
  | "chrome-permission-missing"
  | "site-changed"
  | "verification-failed";

export function siteAccessView(
  origin: string,
  pattern: string,
  chromeAccess: boolean,
  explicitApproval: boolean,
): SiteAccessView {
  return {
    status: !chromeAccess
      ? "chrome-permission-missing"
      : explicitApproval
        ? "authorized"
        : "not-authorized",
    origin,
    pattern,
    chromeAccess,
    explicitApproval,
  };
}

export function inspectCurrentSite(
  value: string | undefined,
  chromeAccess: boolean,
  explicitApprovals: unknown,
): SiteAccessView {
  if (!value) return restrictedPage();
  try {
    const url = parseWebUrl(value);
    const pattern = exactOriginPattern(url.href);
    return siteAccessView(
      url.origin,
      pattern,
      chromeAccess,
      hasExplicitSiteConsent(explicitApprovals, pattern),
    );
  } catch {
    return restrictedPage();
  }
}

export async function readCurrentSiteAccess(
  value: string | undefined,
  reader: SiteAccessReader,
): Promise<SiteAccessView> {
  if (!value) return restrictedPage();
  let pattern: string;
  try {
    pattern = exactOriginPattern(parseWebUrl(value).href);
  } catch {
    return restrictedPage();
  }
  try {
    const [chromeAccess, explicitApprovals] = await Promise.all([
      reader.containsChromePermission(pattern),
      reader.readExplicitApprovals(),
    ]);
    return inspectCurrentSite(value, chromeAccess, explicitApprovals);
  } catch {
    return unavailableSite(value);
  }
}

export function unavailableSite(value?: string): SiteAccessView {
  if (value) {
    try {
      const url = parseWebUrl(value);
      return {
        status: "unavailable",
        origin: url.origin,
        pattern: exactOriginPattern(url.href),
        chromeAccess: false,
        explicitApproval: false,
      };
    } catch {
      // The page URL itself is unavailable or outside HTTP(S).
    }
  }
  return {
    status: "unavailable",
    chromeAccess: false,
    explicitApproval: false,
  };
}

export async function readSiteAccessList(
  reader: SiteAccessReader,
): Promise<SiteAccessList> {
  const [rawChromeOrigins, explicitValue] = await Promise.all([
    reader.readChromeOrigins(),
    reader.readExplicitApprovals(),
  ]);
  const chromeOrigins = stringValues(rawChromeOrigins);
  const explicit = explicitSiteOrigins(explicitValue);
  const exactPatterns = [
    ...new Set([...chromeOrigins.filter(isExactOriginPattern), ...explicit]),
  ].sort();
  const sites = await Promise.all(
    exactPatterns.map(async (pattern) => {
      const chromeAccess = await reader.containsChromePermission(pattern);
      return siteAccessView(
        originFromPattern(pattern),
        pattern,
        chromeAccess,
        explicit.includes(pattern),
      );
    }),
  );
  return {
    sites,
    broadChromePermissions: [...new Set(chromeOrigins)]
      .filter(isBroadHttpPermission)
      .sort(),
  };
}

export async function retainChromeCoveredApprovals(
  value: unknown,
  containsChromePermission: (pattern: string) => Promise<boolean>,
): Promise<string[]> {
  const approvals = explicitSiteOrigins(value);
  const checks = await Promise.all(
    approvals.map(async (pattern) => ({
      pattern,
      covered: await containsChromePermission(pattern),
    })),
  );
  return checks.filter((check) => check.covered).map((check) => check.pattern);
}

/**
 * The permission request is deliberately invoked before the first await so a
 * caller can run this function directly from a user-gesture event handler.
 */
export async function grantSiteApproval(
  pattern: string,
  actions: GrantSiteActions,
): Promise<GrantSiteResult> {
  if (!isExactOriginPattern(pattern)) return "permission-error";

  let permissionRequest: Promise<boolean>;
  try {
    permissionRequest = actions.requestChromePermission(pattern);
  } catch {
    return "permission-error";
  }

  let granted: boolean;
  try {
    granted = await permissionRequest;
  } catch {
    return "permission-error";
  }
  if (!granted) return "denied";

  if (!(await isCurrentSite(actions))) return "site-changed";

  let previousApprovals: unknown;
  try {
    previousApprovals = await actions.readExplicitApprovals();
  } catch {
    return "approval-save-failed";
  }
  const wasAlreadyApproved = hasExplicitSiteConsent(previousApprovals, pattern);
  let saved = false;
  try {
    const next = [
      ...new Set([...explicitSiteOrigins(previousApprovals), pattern]),
    ];
    await actions.saveExplicitApprovals(next);
    saved = true;
  } catch {
    // Read back below. A previously saved approval can still be effective.
  }

  let chromeAccess: boolean;
  let explicitApprovals: unknown;
  try {
    [chromeAccess, explicitApprovals] = await Promise.all([
      actions.containsChromePermission(pattern),
      actions.readExplicitApprovals(),
    ]);
  } catch {
    return saved ? "verification-failed" : "approval-save-failed";
  }

  const explicitlyApproved = hasExplicitSiteConsent(explicitApprovals, pattern);
  if (!(await isCurrentSite(actions))) {
    if (!wasAlreadyApproved && explicitlyApproved) {
      try {
        await actions.clearExplicitApproval?.(pattern);
      } catch {
        // The result stays a failure even if the cleanup could not be saved.
      }
    }
    return "site-changed";
  }
  if (chromeAccess && explicitlyApproved) return "authorized";
  if (!explicitlyApproved && !saved) return "approval-save-failed";
  if (!chromeAccess) return "chrome-permission-missing";
  return "verification-failed";
}

function restrictedPage(): SiteAccessView {
  return {
    status: "restricted-page",
    chromeAccess: false,
    explicitApproval: false,
  };
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isBroadHttpPermission(value: string): boolean {
  return (
    (value === "<all_urls>" || /^(?:\*|https?):\/\/[^/]+\/.*$/.test(value)) &&
    !isExactOriginPattern(value)
  );
}

function originFromPattern(pattern: string): string {
  return pattern.slice(0, -2);
}

async function isCurrentSite(actions: GrantSiteActions): Promise<boolean> {
  if (!actions.isCurrentSite) return true;
  try {
    return await actions.isCurrentSite();
  } catch {
    return false;
  }
}

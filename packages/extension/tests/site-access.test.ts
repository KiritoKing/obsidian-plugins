import { describe, expect, it } from "bun:test";
import { EXPLICIT_SITE_ORIGINS_KEY } from "../src/site-consent";
import {
  grantSiteApproval,
  inspectCurrentSite,
  isExplicitSiteOriginsStorageChange,
  readCurrentSiteAccess,
  readSiteAccessList,
  retainChromeCoveredApprovals,
  unavailableSite,
  type GrantSiteActions,
  type SiteAccessReader,
} from "../src/site-access";

const pattern = "https://example.test/*";

describe("site access state", () => {
  it("refreshes only for changes to exact approvals in Chrome local storage", () => {
    expect(
      isExplicitSiteOriginsStorageChange(
        { [EXPLICIT_SITE_ORIGINS_KEY]: {} },
        "local",
      ),
    ).toBe(true);
    expect(isExplicitSiteOriginsStorageChange({ channel: {} }, "local")).toBe(
      false,
    );
    expect(
      isExplicitSiteOriginsStorageChange(
        { [EXPLICIT_SITE_ORIGINS_KEY]: {} },
        "sync",
      ),
    ).toBe(false);
  });

  it("shows only the origin and requires both Chrome access and explicit approval", () => {
    expect(
      inspectCurrentSite(
        "https://example.test/private/path?view=details",
        true,
        [pattern],
      ),
    ).toEqual({
      status: "authorized",
      origin: "https://example.test",
      pattern,
      chromeAccess: true,
      explicitApproval: true,
    });
    expect(
      inspectCurrentSite("https://example.test/private", true, []),
    ).toMatchObject({ status: "not-authorized", chromeAccess: true });
    expect(
      inspectCurrentSite("https://example.test/private", false, [pattern]),
    ).toMatchObject({
      status: "chrome-permission-missing",
      explicitApproval: true,
    });
  });

  it("marks non-HTTP and missing tabs as restricted pages without reading permissions", async () => {
    const reader = makeReader();
    await expect(
      readCurrentSiteAccess("chrome://extensions", reader),
    ).resolves.toMatchObject({
      status: "restricted-page",
    });
    await expect(
      readCurrentSiteAccess(undefined, reader),
    ).resolves.toMatchObject({
      status: "restricted-page",
    });
    expect(reader.calls.contains).toEqual([]);
    expect(reader.calls.readApprovals).toBe(0);
  });

  it("keeps permission read failures distinct from restricted pages", async () => {
    const reader = makeReader({
      contains: async () => {
        throw new Error("Chrome permission state unavailable");
      },
    });
    await expect(
      readCurrentSiteAccess("https://example.test/page", reader),
    ).resolves.toMatchObject({
      status: "unavailable",
      origin: "https://example.test",
      chromeAccess: false,
      explicitApproval: false,
    });
    expect(unavailableSite("https://example.test/page")).toMatchObject({
      status: "unavailable",
      origin: "https://example.test",
    });
  });

  it("refreshes popup and options state from actual permission coverage and exact approvals", async () => {
    let chromeCanAccess = true;
    let approvals: unknown = [];
    const current = makeReader({
      origins: ["https://*.example.test/*"],
      contains: async () => chromeCanAccess,
      readApprovals: async () => approvals,
    });

    await expect(
      readCurrentSiteAccess("https://example.test/page", current),
    ).resolves.toMatchObject({
      status: "not-authorized",
      explicitApproval: false,
    });
    const pendingList = await readSiteAccessList(current);
    expect(pendingList.broadChromePermissions).toEqual([
      "https://*.example.test/*",
    ]);
    expect(pendingList.sites).toEqual([]);

    approvals = [pattern];
    const [popupView, settingsList] = await Promise.all([
      readCurrentSiteAccess("https://example.test/another-page", current),
      readSiteAccessList(current),
    ]);
    expect(popupView).toMatchObject({
      status: "authorized",
      explicitApproval: true,
    });
    expect(settingsList.sites).toEqual([
      {
        status: "authorized",
        origin: "https://example.test",
        pattern,
        chromeAccess: true,
        explicitApproval: true,
      },
    ]);
    expect(current.calls.contains).toEqual([pattern, pattern, pattern]);

    chromeCanAccess = false;
    await expect(
      readCurrentSiteAccess("https://example.test/page", current),
    ).resolves.toMatchObject({
      status: "chrome-permission-missing",
      explicitApproval: true,
    });
  });
});

describe("one-click site grant", () => {
  it("requests Chrome access synchronously, stores exact approval, and verifies readback", async () => {
    const events: string[] = [];
    let approvals: unknown = [];
    const actions: GrantSiteActions = {
      requestChromePermission: () => {
        events.push("request");
        return Promise.resolve(true);
      },
      readExplicitApprovals: async () => {
        events.push("read");
        return approvals;
      },
      saveExplicitApprovals: async (origins) => {
        events.push("save");
        approvals = origins;
      },
      containsChromePermission: async () => {
        events.push("verify-chrome");
        return true;
      },
      isCurrentSite: async () => {
        events.push("check-current-site");
        return true;
      },
    };

    const result = grantSiteApproval(pattern, actions);
    expect(events).toEqual(["request"]);
    await expect(result).resolves.toBe("authorized");
    expect(events[0]).toBe("request");
    expect(events).toContain("save");
    expect(approvals).toEqual([pattern]);
  });

  it("does not save approval when Chrome denies the permission request", async () => {
    let saved = false;
    const actions = makeGrantActions({
      requestChromePermission: async () => false,
      saveExplicitApprovals: async () => {
        saved = true;
      },
    });

    await expect(grantSiteApproval(pattern, actions)).resolves.toBe("denied");
    expect(saved).toBe(false);
  });

  it("does not report success when Chrome access is granted but explicit storage fails", async () => {
    const actions = makeGrantActions({
      requestChromePermission: async () => true,
      containsChromePermission: async () => true,
      saveExplicitApprovals: async () => {
        throw new Error("Storage unavailable");
      },
    });

    await expect(grantSiteApproval(pattern, actions)).resolves.toBe(
      "approval-save-failed",
    );
  });

  it("stops before explicit storage when the current tab changes during the Chrome prompt", async () => {
    let saved = false;
    const actions = makeGrantActions({
      requestChromePermission: async () => true,
      isCurrentSite: async () => false,
      saveExplicitApprovals: async () => {
        saved = true;
      },
    });

    await expect(grantSiteApproval(pattern, actions)).resolves.toBe(
      "site-changed",
    );
    expect(saved).toBe(false);
  });

  it("does not report success if the page changes before the verified readback", async () => {
    let approvals: unknown = [];
    let currentChecks = 0;
    const actions = makeGrantActions({
      readExplicitApprovals: async () => approvals,
      saveExplicitApprovals: async (origins) => {
        approvals = origins;
      },
      isCurrentSite: async () => ++currentChecks === 1,
      clearExplicitApproval: async (approvedPattern) => {
        approvals = (approvals as string[]).filter(
          (value) => value !== approvedPattern,
        );
      },
    });

    await expect(grantSiteApproval(pattern, actions)).resolves.toBe(
      "site-changed",
    );
    expect(approvals).toEqual([]);
  });

  it("does not report success when readback cannot confirm Chrome coverage", async () => {
    const actions = makeGrantActions({
      readExplicitApprovals: async () => [pattern],
      containsChromePermission: async () => false,
    });

    await expect(grantSiteApproval(pattern, actions)).resolves.toBe(
      "chrome-permission-missing",
    );
  });
});

describe("permission removal cleanup", () => {
  it("keeps exact approvals covered by a broad Chrome permission", async () => {
    const secondPattern = "https://other.test/*";
    const retained = await retainChromeCoveredApprovals(
      [pattern, secondPattern],
      async (candidate) => candidate === pattern,
    );

    expect(retained).toEqual([pattern]);
  });
});

function makeReader(
  overrides: {
    origins?: string[];
    contains?: (pattern: string) => Promise<boolean>;
    readApprovals?: () => Promise<unknown>;
  } = {},
): SiteAccessReader & {
  calls: { contains: string[]; readApprovals: number };
} {
  const calls = { contains: [] as string[], readApprovals: 0 };
  return {
    calls,
    readChromeOrigins: async () => overrides.origins ?? [],
    readExplicitApprovals: async () => {
      calls.readApprovals += 1;
      return overrides.readApprovals ? overrides.readApprovals() : [];
    },
    containsChromePermission: async (value) => {
      calls.contains.push(value);
      return overrides.contains ? overrides.contains(value) : false;
    },
  };
}

function makeGrantActions(
  overrides: Partial<GrantSiteActions> = {},
): GrantSiteActions {
  return {
    requestChromePermission: async () => true,
    readExplicitApprovals: async () => [],
    saveExplicitApprovals: async () => undefined,
    containsChromePermission: async () => true,
    ...overrides,
  };
}

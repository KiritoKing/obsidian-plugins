import { describe, expect, it } from "bun:test";
import {
  isSiteAuthorized,
  removeExplicitSiteConsent,
} from "../src/site-consent";
import { revokeSiteApproval } from "../src/site-revocation";

describe("site approval revocation", () => {
  it("clears and notifies before Chrome removal, and stays denied if Chrome refuses", async () => {
    const origin = "http://localhost:4173/*";
    const chromePermissions = [origin];
    let explicitApprovals: string[] = [origin];
    const actions: string[] = [];

    const result = await revokeSiteApproval(origin, {
      clearApproval: async (pattern) => {
        actions.push("clear-app-approval");
        explicitApprovals = removeExplicitSiteConsent(
          explicitApprovals,
          pattern,
        );
      },
      notifyBackground: async () => {
        actions.push("stop-active-request");
      },
      removeChromePermission: async () => {
        actions.push("remove-chrome-permission");
        throw new Error("Chrome refuses to remove a required permission.");
      },
    });

    expect(actions).toEqual([
      "clear-app-approval",
      "stop-active-request",
      "remove-chrome-permission",
    ]);
    expect(result).toEqual({
      backgroundNotified: true,
      chromePermissionRemoved: false,
    });
    expect(chromePermissions).toContain(origin);
    expect(explicitApprovals).toEqual([]);
    expect(isSiteAuthorized(chromePermissions, explicitApprovals, origin)).toBe(
      false,
    );
  });
});

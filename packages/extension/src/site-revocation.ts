import { isExactOriginPattern } from "./site-consent";

export type SiteRevocationActions = {
  clearApproval: (pattern: string) => Promise<void>;
  notifyBackground: (pattern: string) => Promise<void>;
  removeChromePermission: (pattern: string) => Promise<boolean>;
};

export type SiteRevocationResult = {
  backgroundNotified: boolean;
  chromePermissionRemoved: boolean;
};

export async function revokeSiteApproval(
  pattern: string,
  actions: SiteRevocationActions,
): Promise<SiteRevocationResult> {
  if (!isExactOriginPattern(pattern)) {
    throw new TypeError("Only an exact HTTP(S) origin can be revoked.");
  }

  await actions.clearApproval(pattern);
  let backgroundNotified = false;
  try {
    await actions.notifyBackground(pattern);
    backgroundNotified = true;
  } catch {
    // The cleared local approval still denies new requests if notification fails.
  }

  let chromePermissionRemoved = false;
  try {
    chromePermissionRemoved = await actions.removeChromePermission(pattern);
  } catch {
    // Chrome can keep a required permission; the extension approval stays cleared.
  }

  return { backgroundNotified, chromePermissionRemoved };
}

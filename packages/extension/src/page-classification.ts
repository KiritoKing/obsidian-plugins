import type { ErrorCode } from "@chlrc/browser-profile-title-protocol";

export type PageFailure = { code: ErrorCode; message: string };

const LOGIN_HINT =
  /(?:^|[\s/_-])(?:login|logon|signin|sign-in|sign_in|authenticate|authentication|authorize|authorization)(?:$|[\s/?#_-])/i;
const DENIED_HINT =
  /(?:\b403\b|\b401\b|forbidden|access denied|permission denied|not authorized|unauthorized)/i;
const GENERIC_TITLE =
  /^(?:untitled|loading(?:\.{1,3}|…)?|home|dashboard|react app|vite \+ react|application|app)$/i;

export function classifyPage(
  url: string,
  title: string,
): PageFailure | undefined {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    return {
      code: "TITLE_UNAVAILABLE",
      message: "The browser returned an invalid page address.",
    };
  }

  const hint = `${path} ${title}`;
  if (DENIED_HINT.test(hint)) {
    return { code: "FORBIDDEN", message: "This page denied access." };
  }
  if (LOGIN_HINT.test(hint)) {
    return {
      code: "AUTH_REQUIRED",
      message: "This page appears to require sign-in in the browser profile.",
    };
  }
  if (!title || GENERIC_TITLE.test(title)) {
    return {
      code: "TITLE_UNAVAILABLE",
      message: "The page did not provide a usable title.",
    };
  }
  return undefined;
}

export function normalizeTitle(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 2048);
}

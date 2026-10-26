import { parseWebUrl } from "@chlrc/browser-profile-title-protocol";

export function exactOriginPattern(value: string): string {
  const url = parseWebUrl(value);
  return `${url.protocol}//${url.host}/*`;
}

export function canonicalWebUrl(value: string): string {
  return parseWebUrl(value).href;
}

export function isSameOrigin(value: string, expectedOrigin: string): boolean {
  try {
    return parseWebUrl(value).origin === expectedOrigin;
  } catch {
    return false;
  }
}

export function isExactUrl(
  value: string | undefined,
  expectedUrl: string,
): boolean {
  if (!value) return false;
  try {
    return parseWebUrl(value).href === expectedUrl;
  } catch {
    return false;
  }
}

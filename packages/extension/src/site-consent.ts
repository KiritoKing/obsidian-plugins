export const EXPLICIT_SITE_ORIGINS_KEY = "explicitSiteOrigins";

export function isExactOriginPattern(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(https?):\/\/([^/]+)\/\*$/.exec(value);
  if (!match || match[2].includes("*")) return false;
  try {
    const url = new URL(`${match[1]}://${match[2]}/`);
    return (
      !url.username &&
      !url.password &&
      url.protocol === `${match[1]}:` &&
      url.host === match[2]
    );
  } catch {
    return false;
  }
}

export function explicitSiteOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isExactOriginPattern))];
}

export function hasExplicitSiteConsent(
  value: unknown,
  pattern: string,
): boolean {
  return (
    isExactOriginPattern(pattern) &&
    explicitSiteOrigins(value).includes(pattern)
  );
}

export function isSiteAuthorized(
  chromeOrigins: unknown,
  explicitOrigins: unknown,
  pattern: string,
): boolean {
  return (
    isExactOriginPattern(pattern) &&
    Array.isArray(chromeOrigins) &&
    chromeOrigins.includes(pattern) &&
    hasExplicitSiteConsent(explicitOrigins, pattern)
  );
}

export function addExplicitSiteConsent(
  value: unknown,
  pattern: string,
): string[] {
  if (!isExactOriginPattern(pattern)) {
    throw new TypeError("Only exact HTTP(S) origin patterns can be approved.");
  }
  return [...new Set([...explicitSiteOrigins(value), pattern])];
}

export function removeExplicitSiteConsent(
  value: unknown,
  pattern: string,
): string[] {
  if (!isExactOriginPattern(pattern)) return explicitSiteOrigins(value);
  return explicitSiteOrigins(value).filter((origin) => origin !== pattern);
}

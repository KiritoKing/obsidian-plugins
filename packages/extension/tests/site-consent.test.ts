import { describe, expect, it } from "bun:test";
import {
  addExplicitSiteConsent,
  explicitSiteOrigins,
  hasExplicitSiteConsent,
  isSiteAuthorized,
  isExactOriginPattern,
  removeExplicitSiteConsent,
} from "../src/site-consent";

describe("explicit site approval", () => {
  it("accepts only normalized exact HTTP(S) origins", () => {
    expect(isExactOriginPattern("https://example.test/*")).toBe(true);
    expect(isExactOriginPattern("http://localhost:3000/*")).toBe(true);
    expect(isExactOriginPattern("https://*.example.test/*")).toBe(false);
    expect(isExactOriginPattern("https://example.test/path/*")).toBe(false);
    expect(isExactOriginPattern("<all_urls>")).toBe(false);
    expect(isExactOriginPattern("https://EXAMPLE.test/*")).toBe(false);
  });

  it("deduplicates valid approvals and ignores broad or malformed stored values", () => {
    const grants = addExplicitSiteConsent(
      [
        "https://example.test/*",
        "http://*/*",
        "invalid",
        "https://example.test/*",
      ],
      "https://other.test/*",
    );
    expect(grants).toEqual(["https://example.test/*", "https://other.test/*"]);
    expect(explicitSiteOrigins({ unexpected: true })).toEqual([]);
  });

  it("requires a matching exact approval", () => {
    expect(
      hasExplicitSiteConsent(
        ["https://*.example.test/*"],
        "https://example.test/*",
      ),
    ).toBe(false);
    expect(
      hasExplicitSiteConsent(
        ["https://example.test/*"],
        "https://example.test/*",
      ),
    ).toBe(true);
  });

  it("clears only the exact approval that was revoked", () => {
    expect(
      removeExplicitSiteConsent(
        ["https://example.test/*", "https://other.test/*"],
        "https://example.test/*",
      ),
    ).toEqual(["https://other.test/*"]);
    expect(
      removeExplicitSiteConsent(
        ["https://example.test/*"],
        "https://*.example.test/*",
      ),
    ).toEqual(["https://example.test/*"]);
  });

  it("requires Chrome access coverage and an exact extension approval", () => {
    expect(isSiteAuthorized(true, [], "https://example.test/*")).toBe(false);
    expect(
      isSiteAuthorized(
        false,
        ["https://example.test/*"],
        "https://example.test/*",
      ),
    ).toBe(false);
    expect(
      isSiteAuthorized(
        true,
        ["https://example.test/*"],
        "https://example.test/*",
      ),
    ).toBe(true);
  });
});

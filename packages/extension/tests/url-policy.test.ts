import { describe, expect, it } from "bun:test";
import {
  canonicalWebUrl,
  exactOriginPattern,
  isExactUrl,
  isSameOrigin,
} from "../src/url-policy";

describe("site permission patterns", () => {
  it("creates a narrow origin permission, including an explicit port", () => {
    expect(exactOriginPattern("https://example.test:8443/a/page?q=1")).toBe(
      "https://example.test:8443/*",
    );
    expect(exactOriginPattern("http://localhost:3000/")).toBe(
      "http://localhost:3000/*",
    );
  });

  it("rejects credentials and non-web schemes", () => {
    expect(() =>
      exactOriginPattern("https://user:secret@example.test/path"),
    ).toThrow();
    expect(() => exactOriginPattern("file:///tmp/page.html")).toThrow();
  });

  it("canonicalizes URLs and compares exact URLs and origins", () => {
    expect(canonicalWebUrl("https://EXAMPLE.test:443/a/../b")).toBe(
      "https://example.test/b",
    );
    expect(isExactUrl("https://example.test/b", "https://example.test/b")).toBe(
      true,
    );
    expect(
      isExactUrl("https://example.test/other", "https://example.test/b"),
    ).toBe(false);
    expect(
      isSameOrigin("https://example.test/elsewhere", "https://example.test"),
    ).toBe(true);
    expect(isSameOrigin("https://other.test/", "https://example.test")).toBe(
      false,
    );
  });
});

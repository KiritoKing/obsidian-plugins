import { describe, expect, it } from "bun:test";
import { classifyPage, normalizeTitle } from "../src/page-classification";

describe("rendered page title checks", () => {
  it("normalizes a title to one line and caps it at 2048 characters", () => {
    expect(normalizeTitle("  First\n\tSecond  ")).toBe("First Second");
    expect(normalizeTitle("x".repeat(2050))).toHaveLength(2048);
  });

  it("recognizes login, denied, empty, and generic shell pages", () => {
    expect(classifyPage("https://example.test/login", "Sign in")).toMatchObject(
      { code: "AUTH_REQUIRED" },
    );
    expect(
      classifyPage("https://example.test/", "403 Forbidden"),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(classifyPage("https://example.test/", "")).toMatchObject({
      code: "TITLE_UNAVAILABLE",
    });
    expect(classifyPage("https://example.test/", "React App")).toMatchObject({
      code: "TITLE_UNAVAILABLE",
    });
    expect(
      classifyPage("https://example.test/article", "A useful title"),
    ).toBeUndefined();
  });
});

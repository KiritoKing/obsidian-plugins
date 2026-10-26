import { describe, expect, test } from "bun:test";
import { isPositionInCode, normalizeWebUrl } from "../src/checkif";
import {
  cleanTitle,
  escapeMarkdownTitle,
  formatMarkdownLink,
  resolvedTitleReplacement,
  safeReplacementRange,
} from "../src/title-format";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/settings-model";

describe("title formatting", () => {
  test("removes control and invisible characters and shortens long titles", () => {
    expect(cleanTitle("  Alpha\r\n\u0000 beta\u200B  ")).toBe("Alpha beta");
    expect(cleanTitle("abcdefghij", 5)).toBe("abcde...");
    expect(cleanTitle("short", 5)).toBe("short");
  });

  test("escapes Markdown label punctuation", () => {
    expect(escapeMarkdownTitle("*bold* [link] (x) | `code`")).toBe(
      "\\*bold\\* \\[link\\] \\(x\\) \\| \\`code\\`",
    );
  });

  test("formats a safe angle-bracket destination from a web URL", () => {
    expect(
      formatMarkdownLink("A *title*", "https://example.com/a b?x=<tag>"),
    ).toBe("[A \\*title\\*](<https://example.com/a%20b?x=%3Ctag%3E>)");
  });

  test("leaves the original URL available when there is no usable title", () => {
    expect(
      resolvedTitleReplacement("\u200B\u0000", "https://example.com/"),
    ).toBeNull();
    expect(
      resolvedTitleReplacement("  Page title  ", "https://example.com/"),
    ).toBe("[Page title](<https://example.com/>)");
  });

  test("only returns a replacement range for an unchanged editor snapshot", () => {
    const original = "before https://example.com after";
    expect(
      safeReplacementRange(original, original, 7, "https://example.com"),
    ).toEqual({ start: 7, end: 26 });
    expect(
      safeReplacementRange(`${original}!`, original, 7, "https://example.com"),
    ).toBeNull();
    expect(
      safeReplacementRange(original, original, 8, "https://example.com"),
    ).toBeNull();
  });
});

describe("URL and code checks", () => {
  test("accepts HTTP(S) and normalizes www links", () => {
    expect(normalizeWebUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeWebUrl("www.example.com/path")).toBe(
      "https://www.example.com/path",
    );
    expect(normalizeWebUrl("file:///tmp/note")).toBeNull();
    expect(normalizeWebUrl("https://user:pass@example.com")).toBeNull();
  });

  test("skips inline and fenced code while allowing text after a closed fence", () => {
    const inline = "text `https://example.com` outside";
    expect(isPositionInCode(inline, inline.indexOf("https") + 3)).toBe(true);
    expect(isPositionInCode(inline, inline.lastIndexOf("outside") + 2)).toBe(
      false,
    );

    const fenced = "```ts\nhttps://example.com\n```\nafter";
    expect(isPositionInCode(fenced, fenced.indexOf("https") + 5)).toBe(true);
    expect(isPositionInCode(fenced, fenced.indexOf("after") + 2)).toBe(false);
  });
});

describe("settings persistence", () => {
  test("keeps only validated user settings and never persists connection secrets", () => {
    const settings = sanitizeSettings({
      channel: "../outside",
      timeoutMs: 99_999,
      maximumTitleLength: -1,
      enhanceDefaultPaste: false,
      token: "must-not-be-kept",
      socketPath: "/private/socket",
    });

    expect(settings.channel).toBe(DEFAULT_SETTINGS.channel);
    expect(settings.timeoutMs).toBe(DEFAULT_SETTINGS.timeoutMs);
    expect(settings.maximumTitleLength).toBe(
      DEFAULT_SETTINGS.maximumTitleLength,
    );
    expect(settings.enhanceDefaultPaste).toBe(false);
    expect(Object.keys(settings).sort()).toEqual([
      "channel",
      "enhanceDefaultPaste",
      "enhanceDropEvents",
      "maximumTitleLength",
      "shouldPreserveSelectionAsTitle",
      "timeoutMs",
      "websiteBlacklist",
    ]);
  });
});

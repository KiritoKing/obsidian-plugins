import { describe, expect, test } from "bun:test";
import {
  ERROR_CODES,
  type ErrorCode,
} from "@chlrc/browser-profile-title-protocol";
import { BridgeClientError } from "../src/bridge-client";
import {
  resolveTitleWithFallback,
  type ResolverStatusSnapshot,
} from "../src/title-resolver";

const PAGE_URL = "https://example.com/article";

describe("browser-first title resolution", () => {
  test("returns a browser title without calling the fallback", async () => {
    let fallbackCalls = 0;
    const statuses: ResolverStatusSnapshot[] = [];

    const result = await resolveTitleWithFallback(PAGE_URL, {
      browserTitle: async () => "  Browser title  ",
      legacyTitle: async () => {
        fallbackCalls++;
        return "Legacy title";
      },
      fallbackEnabled: true,
      timeoutMs: 500,
      onStatus: (status) => statuses.push(status),
    });

    expect(result).toEqual({ title: "Browser title", route: "browser" });
    expect(fallbackCalls).toBe(0);
    expect(statuses.at(-1)).toMatchObject({
      route: "browser",
      reason: null,
    });
  });

  test("falls back for every bridge remote error code", async () => {
    for (const code of ERROR_CODES) {
      let fallbackCalls = 0;
      const result = await resolveTitleWithFallback(PAGE_URL, {
        browserTitle: async () => {
          throw new BridgeClientError("remote", code as ErrorCode);
        },
        legacyTitle: async () => {
          fallbackCalls++;
          return "Fallback title";
        },
        fallbackEnabled: true,
        timeoutMs: 500,
      });

      expect(result).toEqual({ title: "Fallback title", route: "fallback" });
      expect(fallbackCalls).toBe(1);
    }
  });

  test("falls back for missing host, authentication, timeout and thrown errors", async () => {
    const failures: unknown[] = [
      new BridgeClientError("unavailable"),
      new BridgeClientError("authentication"),
      new BridgeClientError("timeout"),
      new BridgeClientError("protocol"),
      new Error("synthetic failure"),
    ];

    for (const failure of failures) {
      let fallbackCalls = 0;
      const result = await resolveTitleWithFallback(PAGE_URL, {
        browserTitle: async () => {
          throw failure;
        },
        legacyTitle: async () => {
          fallbackCalls++;
          return "Legacy title";
        },
        fallbackEnabled: true,
        timeoutMs: 500,
      });

      expect(result?.route).toBe("fallback");
      expect(fallbackCalls).toBe(1);
    }
  });

  test("falls back when the browser returns an empty or login title", async () => {
    for (const browserTitle of [
      "",
      " \u200b ",
      "Sign in",
      "Sign in to Example",
      "Please sign in to continue",
      "登录",
      "请先登录",
    ]) {
      let fallbackCalls = 0;
      const result = await resolveTitleWithFallback(PAGE_URL, {
        browserTitle: async () => browserTitle,
        legacyTitle: async () => {
          fallbackCalls++;
          return "Readable page title";
        },
        fallbackEnabled: true,
        timeoutMs: 500,
      });

      expect(result).toEqual({
        title: "Readable page title",
        route: "fallback",
      });
      expect(fallbackCalls).toBe(1);
    }
  });

  test("keeps tutorial titles that mention login or 登录", async () => {
    for (const browserTitle of [
      "OAuth 登录流程详解",
      "如何实现登录页",
      "How to implement a login page",
      "OAuth login flow explained",
    ]) {
      let fallbackCalls = 0;
      const result = await resolveTitleWithFallback(PAGE_URL, {
        browserTitle: async () => browserTitle,
        legacyTitle: async () => {
          fallbackCalls++;
          return "unused";
        },
        fallbackEnabled: true,
        timeoutMs: 500,
      });

      expect(result).toEqual({ title: browserTitle, route: "browser" });
      expect(fallbackCalls).toBe(0);
    }
  });

  test("rejects placeholders and a title that is just the requested URL", async () => {
    for (const browserTitle of [
      "Loading…",
      "Loading...",
      "Untitled",
      "Title Unavailable | Site Unreachable",
      "Site Unreachable",
      PAGE_URL,
    ]) {
      let fallbackCalls = 0;
      const result = await resolveTitleWithFallback(PAGE_URL, {
        browserTitle: async () => browserTitle,
        legacyTitle: async () => {
          fallbackCalls++;
          return "Recovered page title";
        },
        fallbackEnabled: true,
        timeoutMs: 500,
      });

      expect(result).toEqual({
        title: "Recovered page title",
        route: "fallback",
      });
      expect(fallbackCalls).toBe(1);
    }
  });

  test("rejects browser URL display without a scheme but keeps URL mentions in tutorials", async () => {
    for (const item of [
      {
        url: "http://127.0.0.1:54999/no-title",
        title: "127.0.0.1:54999/no-title",
      },
      {
        url: "https://example.com/article?mode=compact#result",
        title: "example.com/article?mode=compact#result",
      },
      {
        url: "https://example.com/article?mode=compact#result",
        title: "//example.com/article?mode=compact#result",
      },
    ]) {
      const result = await resolveTitleWithFallback(item.url, {
        browserTitle: async () => item.title,
        legacyTitle: async () => "Recovered page title",
        fallbackEnabled: true,
        timeoutMs: 500,
      });

      expect(result).toEqual({
        title: "Recovered page title",
        route: "fallback",
      });
    }

    for (const browserTitle of [
      "How to inspect https://example.com/article?mode=compact#result in DevTools",
      "How to read 127.0.0.1:54999/no-title in a browser",
    ]) {
      const result = await resolveTitleWithFallback(PAGE_URL, {
        browserTitle: async () => browserTitle,
        legacyTitle: async () => "unused",
        fallbackEnabled: true,
        timeoutMs: 500,
      });

      expect(result).toEqual({ title: browserTitle, route: "browser" });
    }
  });

  test("returns unavailable after both paths fail without putting URL or title in status", async () => {
    const statuses: ResolverStatusSnapshot[] = [];
    const result = await resolveTitleWithFallback(PAGE_URL, {
      browserTitle: async () => {
        throw new BridgeClientError("unavailable");
      },
      legacyTitle: async () => "   ",
      fallbackEnabled: true,
      timeoutMs: 500,
      onStatus: (status) => statuses.push(status),
    });

    expect(result).toBeNull();
    expect(statuses.at(-1)).toMatchObject({
      route: "unavailable",
      reason: "legacy-no-title",
    });
    const finalStatus = JSON.stringify(statuses.at(-1));
    expect(finalStatus).not.toContain("example.com");
    expect(finalStatus).not.toContain("Browser title");
  });

  test("preserves browser errors and skips fallback when disabled", async () => {
    const originalError = new BridgeClientError(
      "remote",
      "HOST_PERMISSION_REQUIRED",
    );
    let fallbackCalls = 0;
    const statuses: ResolverStatusSnapshot[] = [];

    await expect(
      resolveTitleWithFallback(PAGE_URL, {
        browserTitle: async () => {
          throw originalError;
        },
        legacyTitle: async () => {
          fallbackCalls++;
          return "unused";
        },
        fallbackEnabled: false,
        timeoutMs: 500,
        onStatus: (status) => statuses.push(status),
      }),
    ).rejects.toBe(originalError);

    expect(fallbackCalls).toBe(0);
    expect(statuses.at(-1)).toMatchObject({
      route: "unavailable",
      reason: "host-permission-required",
    });
  });

  test("ignores a browser response that arrives after its deadline", async () => {
    let resolveBrowser: (title: string) => void = () => undefined;
    const browserPromise = new Promise<string>((resolve) => {
      resolveBrowser = resolve;
    });

    const result = await resolveTitleWithFallback(PAGE_URL, {
      browserTitle: () => browserPromise,
      legacyTitle: async (_url, timeoutMs) => {
        expect(timeoutMs).toBe(100);
        return "Fallback arrived first";
      },
      fallbackEnabled: true,
      timeoutMs: 100,
    });

    resolveBrowser("Late browser title");
    expect(result).toEqual({
      title: "Fallback arrived first",
      route: "fallback",
    });
  });
});

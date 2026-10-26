import { describe, expect, it } from "bun:test";
import {
  resolveTitle,
  TitleResolutionError,
  type TitleResolutionPlatform,
} from "../src/title-resolution";
import type { ResolveTitleRequest } from "@chlrc/browser-profile-title-protocol";

const request: ResolveTitleRequest = {
  version: 1,
  type: "resolve-title",
  id: "request_1",
  url: "https://example.test/article",
  timeoutMs: 2_000,
};

function makePlatform(overrides: Partial<TitleResolutionPlatform> = {}) {
  const calls = {
    created: 0,
    closed: [] as number[],
    read: 0,
    cancelled: [] as string[],
  };
  const platform: TitleResolutionPlatform = {
    containsOrigin: async () => true,
    listTabs: async () => [],
    getTab: async (id) => ({ id, status: "complete", url: request.url }),
    createBackgroundTab: async (url) => {
      calls.created += 1;
      return { id: 22, status: "loading", url };
    },
    waitForTabComplete: async (id) => ({
      id,
      status: "complete",
      url: request.url,
    }),
    readTitle: async () => {
      calls.read += 1;
      return { state: "ready", title: "Article title", url: request.url };
    },
    cancelRead: async (_id, taskId) => {
      calls.cancelled.push(taskId);
    },
    closeTab: async (id) => {
      calls.closed.push(id);
    },
    ...overrides,
  };
  return { platform, calls };
}

describe("title request resolution", () => {
  it("requires an exact site grant before inspecting tabs", async () => {
    const { platform, calls } = makePlatform({
      containsOrigin: async () => false,
    });
    await expect(
      resolveTitle(request, "task_1", platform, new AbortController().signal),
    ).rejects.toMatchObject({ code: "HOST_PERMISSION_REQUIRED" });
    expect(calls.created).toBe(0);
    expect(calls.read).toBe(0);
  });

  it("reuses an exact tab and leaves it open", async () => {
    const { platform, calls } = makePlatform({
      listTabs: async () => [{ id: 7, status: "complete", url: request.url }],
    });
    await expect(
      resolveTitle(request, "task_2", platform, new AbortController().signal),
    ).resolves.toEqual({
      title: "Article title",
      url: request.url,
      source: "browser",
    });
    expect(calls.created).toBe(0);
    expect(calls.closed).toEqual([]);
  });

  it("closes a tab it created and refuses a cross-origin redirect", async () => {
    const { platform, calls } = makePlatform({
      getTab: async (id) => ({ id, status: "loading", url: request.url }),
      waitForTabComplete: async (id) => ({
        id,
        status: "complete",
        url: "https://other.test/login",
      }),
    });
    await expect(
      resolveTitle(request, "task_3", platform, new AbortController().signal),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls.read).toBe(0);
    expect(calls.closed).toEqual([22]);
  });

  it("cancels the injected reader and closes only its own tab", async () => {
    const controller = new AbortController();
    let beginRead: (() => void) | undefined;
    const { platform, calls } = makePlatform({
      readTitle: async () =>
        new Promise((resolve) => {
          beginRead = () =>
            resolve({
              state: "ready",
              title: "Article title",
              url: request.url,
            });
        }),
    });
    const pending = resolveTitle(
      request,
      "task_cancel",
      platform,
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(TitleResolutionError);
    expect(calls.cancelled).toEqual(["task_cancel"]);
    expect(calls.closed).toEqual([22]);
    beginRead?.();
  });

  it("checks permission again after page loading", async () => {
    let checks = 0;
    const { platform, calls } = makePlatform({
      containsOrigin: async () => ++checks === 1,
    });
    await expect(
      resolveTitle(request, "task_4", platform, new AbortController().signal),
    ).rejects.toMatchObject({ code: "HOST_PERMISSION_REQUIRED" });
    expect(calls.read).toBe(0);
    expect(calls.closed).toEqual([22]);
  });
});

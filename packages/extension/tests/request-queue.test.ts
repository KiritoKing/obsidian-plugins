import { describe, expect, it } from "bun:test";
import type {
  BridgeResponse,
  ResolveTitleRequest,
} from "@chlrc/browser-profile-title-protocol";
import { TitleRequestQueue } from "../src/request-queue";

function request(
  id: string,
  url = "https://example.test/article",
  timeoutMs = 2_000,
): ResolveTitleRequest {
  return { version: 1, type: "resolve-title", id, url, timeoutMs };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("bounded title request queue", () => {
  it("deduplicates the same URL and emits a response for each request id", async () => {
    let release: (() => void) | undefined;
    let started = 0;
    const responses: BridgeResponse[] = [];
    const queue = new TitleRequestQueue(
      async () => {
        started += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          title: "One title",
          url: "https://example.test/article",
          source: "browser",
        };
      },
      (response) => responses.push(response),
      { makeTaskId: () => "task_dedupe" },
    );

    queue.handle(request("one"));
    queue.handle(request("two", "https://example.test/article"));
    await settle();
    expect(started).toBe(1);
    release?.();
    await settle();
    expect(responses.filter((response) => response.ok)).toHaveLength(2);
    expect(responses.map((response) => response.id).sort()).toEqual([
      "one",
      "two",
    ]);
    queue.close();
  });

  it("cancels the original request and acknowledges cancellation", async () => {
    let taskSignal: AbortSignal | undefined;
    const responses: BridgeResponse[] = [];
    const queue = new TitleRequestQueue(
      (_request, _taskId, signal) => {
        taskSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("cancelled"), { code: "CANCELLED" }),
              ),
            { once: true },
          );
        });
      },
      (response) => responses.push(response),
      { makeTaskId: () => "task_cancel" },
    );

    queue.handle(request("original"));
    await settle();
    queue.handle({
      version: 1,
      type: "cancel",
      id: "cancel_op",
      requestId: "original",
    });
    await settle();
    expect(taskSignal?.aborted).toBe(true);
    expect(responses).toContainEqual({
      version: 1,
      type: "response",
      id: "original",
      ok: false,
      error: { code: "CANCELLED", message: "The title request was cancelled." },
    });
    expect(responses).toContainEqual({
      version: 1,
      type: "response",
      id: "cancel_op",
      ok: true,
      result: { cancelled: true },
    });
    queue.close();
  });

  it("times out each waiter at its own requested bound", async () => {
    const responses: BridgeResponse[] = [];
    const queue = new TitleRequestQueue(
      () => new Promise(() => undefined),
      (response) => responses.push(response),
      {
        makeTaskId: () => "task_timeout",
      },
    );
    queue.handle(request("short", "https://example.test/slow", 100));
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(responses).toContainEqual({
      version: 1,
      type: "response",
      id: "short",
      ok: false,
      error: { code: "TIMEOUT", message: "The title request timed out." },
    });
    queue.close();
  });

  it("serializes work and rejects requests beyond the small queue limit", async () => {
    const responses: BridgeResponse[] = [];
    const queue = new TitleRequestQueue(
      () => new Promise(() => undefined),
      (response) => responses.push(response),
      {
        maxTasks: 2,
        makeTaskId: () => "task_bounded",
      },
    );
    queue.handle(request("first", "https://one.test/"));
    queue.handle(request("second", "https://two.test/"));
    queue.handle(request("third", "https://three.test/"));
    await settle();
    expect(responses).toContainEqual({
      version: 1,
      type: "response",
      id: "third",
      ok: false,
      error: {
        code: "TITLE_UNAVAILABLE",
        message: "The title request queue is full.",
      },
    });
    queue.close();
  });

  it("runs no more than one distinct URL at a time", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const responses: BridgeResponse[] = [];
    const queue = new TitleRequestQueue(
      async (item) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { title: "Title", url: item.url, source: "browser" };
      },
      (response) => responses.push(response),
      { makeTaskId: () => "task_serial" },
    );

    queue.handle(request("first", "https://one.test/"));
    queue.handle(request("second", "https://two.test/"));
    await settle();
    expect(releases).toHaveLength(1);
    releases[0]?.();
    await settle();
    expect(releases).toHaveLength(2);
    releases[1]?.();
    await settle();
    expect(maximumActive).toBe(1);
    expect(responses.filter((response) => response.ok)).toHaveLength(2);
    queue.close();
  });

  it("fails active requests as soon as their origin permission is revoked", async () => {
    let taskSignal: AbortSignal | undefined;
    const responses: BridgeResponse[] = [];
    const queue = new TitleRequestQueue(
      (_request, _taskId, signal) => {
        taskSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("cancelled"), { code: "CANCELLED" }),
              ),
            { once: true },
          );
        });
      },
      (response) => responses.push(response),
      { makeTaskId: () => "task_revoked" },
    );

    queue.handle(request("revoked"));
    await settle();
    queue.failForRemovedOrigins(["https://example.test/*"]);
    await settle();
    expect(taskSignal?.aborted).toBe(true);
    expect(responses[0]).toMatchObject({
      id: "revoked",
      ok: false,
      error: { code: "HOST_PERMISSION_REQUIRED" },
    });
    queue.close();
  });
});

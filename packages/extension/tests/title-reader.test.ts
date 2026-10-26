import { afterEach, describe, expect, it } from "bun:test";
import { cancelVisibleTitleRead, readVisibleTitle } from "../src/title-reader";

const originalDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);
const originalLocation = Object.getOwnPropertyDescriptor(
  globalThis,
  "location",
);

afterEach(() => {
  if (originalDocument)
    Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
  if (originalLocation)
    Object.defineProperty(globalThis, "location", originalLocation);
  else Reflect.deleteProperty(globalThis, "location");
});

describe("isolated page-title reader", () => {
  it("waits for a title to settle after a single-page app update", async () => {
    const page = { title: "Loading…" };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: page,
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://example.test/article" },
    });
    setTimeout(() => {
      page.title = "Final article title";
    }, 250);

    await expect(readVisibleTitle("stable_task", 2_000)).resolves.toEqual({
      state: "ready",
      title: "Final article title",
      url: "https://example.test/article",
    });
  });

  it("can be cancelled while waiting for a stable title", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { title: "Loading" },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://example.test/slow" },
    });
    const pending = readVisibleTitle("cancel_task", 5_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelVisibleTitleRead("cancel_task")).toBe(true);
    await expect(pending).resolves.toMatchObject({ state: "cancelled" });
  });
});

import { describe, expect, test } from "bun:test";
import {
  createElectronTitleReader,
  LegacyTitleError,
  parseHtmlTitle,
  resolveLegacyTitle,
  type ElectronEventSource,
  type ElectronSessionLike,
  type ElectronWebContentsLike,
  type ElectronWindowLike,
  type LegacyHttpResponse,
  type SecureBrowserWindowOptions,
} from "../src/legacy-title-resolver";

const PAGE_URL = "https://example.com/articles/sample";

describe("legacy title lookup", () => {
  test("parses and normalizes an HTML title", () => {
    expect(
      parseHtmlTitle(
        "<!doctype html><html><head><title>  A &amp; B &#x2014; Page  </title></head></html>",
      ),
    ).toBe("A & B — Page");
  });

  test("uses and entity-decodes the upstream no-title fallback attribute", () => {
    expect(
      parseHtmlTitle('<title no-title="Fallback &amp; name"></title>'),
    ).toBe("Fallback & name");
    expect(
      parseHtmlTitle(
        '<title no-title="Fallback name">Actual &amp; preferred</title>',
      ),
    ).toBe("Actual & preferred");
  });

  test("returns no title for an empty or title-less HTML document", () => {
    expect(
      parseHtmlTitle("<!doctype html><html><head></head></html>"),
    ).toBeNull();
    expect(parseHtmlTitle("<title> \u200b </title>")).toBeNull();
  });

  test("uses the URL filename for a non-HTML HEAD response without fetching its body", async () => {
    let renderCalls = 0;
    let getCalls = 0;
    const result = await resolveLegacyTitle(PAGE_URL, 1000, {
      head: async () =>
        response(
          200,
          { "content-type": "application/pdf" },
          undefined,
          "https://example.com/files/quarterly%20report.pdf",
        ),
      render: async () => {
        renderCalls++;
        return { title: "unused", finalUrl: PAGE_URL };
      },
      get: async () => {
        getCalls++;
        return response(200, {}, "unused body", PAGE_URL);
      },
    });

    expect(result).toBe("quarterly report.pdf");
    expect(renderCalls).toBe(0);
    expect(getCalls).toBe(0);
  });

  test("continues through HTTP parsing when HEAD fails", async () => {
    let getCalls = 0;
    const result = await resolveLegacyTitle(PAGE_URL, 1000, {
      head: async () => {
        throw new LegacyTitleError("unavailable");
      },
      get: async () => {
        getCalls++;
        return htmlResponse("Public page title");
      },
    });

    expect(result).toBe("Public page title");
    expect(getCalls).toBe(1);
  });

  test("continues to HTTP parsing after a bounded, stalled HEAD request", async () => {
    let headTimeout = 0;
    let getCalls = 0;
    const result = await resolveLegacyTitle(PAGE_URL, 300, {
      head: async (_url, timeoutMs) => {
        headTimeout = timeoutMs;
        return new Promise<LegacyHttpResponse>(() => undefined);
      },
      get: async () => {
        getCalls++;
        return htmlResponse("Title after HEAD timeout");
      },
    });

    expect(headTimeout).toBeLessThan(300);
    expect(result).toBe("Title after HEAD timeout");
    expect(getCalls).toBe(1);
  });

  test("uses a rendered Electron title before the HTTP HTML parser", async () => {
    let getCalls = 0;
    const result = await resolveLegacyTitle(PAGE_URL, 1000, {
      head: async () => {
        throw new LegacyTitleError("unavailable");
      },
      render: async () => ({ title: "Rendered page", finalUrl: PAGE_URL }),
      get: async () => {
        getCalls++;
        return htmlResponse("unused");
      },
    });

    expect(result).toBe("Rendered page");
    expect(getCalls).toBe(0);
  });

  test("uses HTTP HTML parsing after the rendered path fails", async () => {
    const result = await resolveLegacyTitle(PAGE_URL, 1000, {
      head: async () => {
        throw new LegacyTitleError("unavailable");
      },
      render: async () => {
        throw new LegacyTitleError("unavailable");
      },
      get: async () => htmlResponse("HTTP page title"),
    });

    expect(result).toBe("HTTP page title");
  });

  test("uses a bounded HTTP parser when a short render budget is under 100ms", async () => {
    const fixture = new FakeWindow("pending");
    let renderTimeoutMs = 0;
    const reader = createElectronTitleReader(
      () => fixture,
      () => "temp:short-budget",
    );
    const result = await resolveLegacyTitle(PAGE_URL, 130, {
      head: async () => {
        throw new LegacyTitleError("unavailable");
      },
      render: async (url, timeoutMs) => {
        renderTimeoutMs = timeoutMs;
        return reader(url, timeoutMs);
      },
      get: async () => htmlResponse("HTTP title after short render budget"),
    });

    expect(renderTimeoutMs).toBeLessThan(100);
    expect(result).toBe("HTTP title after short render budget");
    expect(fixture.destroyed).toBe(true);
    expect(fixture.webContents.listenerCount()).toBe(0);
  });

  test("rejects login, permission and HTTP error pages", async () => {
    for (const item of [
      htmlResponse("Sign in to Example"),
      htmlResponse(
        "Welcome",
        '<form><input type="password"><button>Sign in</button></form>',
      ),
      htmlResponse("Dashboard", "", "https://example.com/auth/continue"),
      response(
        403,
        { "content-type": "text/html" },
        "<title>Forbidden</title>",
        PAGE_URL,
      ),
    ]) {
      await expect(
        resolveLegacyTitle(PAGE_URL, 1000, {
          head: async () => {
            throw new LegacyTitleError("unavailable");
          },
          get: async () => item,
        }),
      ).rejects.toMatchObject({ kind: expect.any(String) });
    }
  });

  test("bounds a stalled final HTTP request", async () => {
    await expect(
      resolveLegacyTitle(PAGE_URL, 100, {
        head: async () => {
          throw new LegacyTitleError("unavailable");
        },
        get: async () => new Promise<LegacyHttpResponse>(() => undefined),
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("secure Electron title window", () => {
  test("uses hardened web preferences and disposes the window on success", async () => {
    const fixture = new FakeWindow("success");
    const captured: { options: SecureBrowserWindowOptions | null } = {
      options: null,
    };
    const reader = createElectronTitleReader(
      (value) => {
        captured.options = value;
        return fixture;
      },
      () => "temp:test-title-session",
    );

    await expect(reader(PAGE_URL, 500)).resolves.toEqual({
      title: "Synthetic rendered title",
      finalUrl: PAGE_URL,
    });

    expect(captured.options).toMatchObject({
      show: false,
      webPreferences: {
        webSecurity: true,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
        partition: "temp:test-title-session",
      },
    });
    expect(captured.options?.webPreferences).not.toHaveProperty("preload");
    expect(fixture.webContents.popupHandler?.()).toEqual({ action: "deny" });
    expect(fixture.destroyed).toBe(true);
    expect(fixture.webContents.listenerCount()).toBe(0);
    expect(fixture.webContents.session.listenerCount()).toBe(0);
    expect(fixture.webContents.session.storageClearCalls).toBe(1);
    expect(fixture.webContents.session.cacheClearCalls).toBe(1);
    expect(fixture.webContents.session.permissionRequestHandler).toBeNull();
    expect(fixture.webContents.session.permissionCheckHandler).toBeNull();
    expect(fixture.webContents.session.lastPermissionDecision).toBe(false);
  });

  test("destroys and detaches listeners after a failed navigation", async () => {
    const fixture = new FakeWindow("failure");
    const reader = createElectronTitleReader(
      () => fixture,
      () => "temp:failure",
    );

    await expect(reader(PAGE_URL, 500)).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(fixture.destroyed).toBe(true);
    expect(fixture.webContents.listenerCount()).toBe(0);
    expect(fixture.webContents.session.listenerCount()).toBe(0);
  });

  test("destroys the hidden window when the render deadline expires", async () => {
    const fixture = new FakeWindow("pending");
    const reader = createElectronTitleReader(
      () => fixture,
      () => "temp:timeout",
    );

    await expect(reader(PAGE_URL, 100)).rejects.toMatchObject({
      kind: "timeout",
    });
    expect(fixture.destroyed).toBe(true);
    expect(fixture.webContents.listenerCount()).toBe(0);
    expect(fixture.webContents.session.listenerCount()).toBe(0);
  });

  test("waits for a title updated after the page load before returning", async () => {
    const fixture = new FakeWindow("delayed-title");
    const reader = createElectronTitleReader(
      () => fixture,
      () => "temp:delayed-title",
    );

    await expect(reader(PAGE_URL, 1000)).resolves.toEqual({
      title: "Delayed rendered title",
      finalUrl: PAGE_URL,
    });
    expect(fixture.destroyed).toBe(true);
    expect(fixture.webContents.listenerCount()).toBe(0);
    expect(fixture.webContents.session.listenerCount()).toBe(0);
  });

  test("does not return a persistent placeholder title and cleans up on timeout", async () => {
    const fixture = new FakeWindow("placeholder");
    const reader = createElectronTitleReader(
      () => fixture,
      () => "temp:placeholder",
    );

    await expect(reader(PAGE_URL, 100)).rejects.toMatchObject({
      kind: "timeout",
    });
    expect(fixture.destroyed).toBe(true);
    expect(fixture.webContents.listenerCount()).toBe(0);
    expect(fixture.webContents.session.listenerCount()).toBe(0);
  });

  test("blocks non-HTTP navigation and cancels downloads", async () => {
    const navigationFixture = new FakeWindow("file-navigation");
    const navigationReader = createElectronTitleReader(
      () => navigationFixture,
      () => "temp:navigation",
    );
    await expect(navigationReader(PAGE_URL, 500)).rejects.toMatchObject({
      kind: "blocked",
    });
    expect(navigationFixture.navigationPrevented).toBe(true);
    expect(navigationFixture.destroyed).toBe(true);

    const downloadFixture = new FakeWindow("download");
    const downloadReader = createElectronTitleReader(
      () => downloadFixture,
      () => "temp:download",
    );
    await expect(downloadReader(PAGE_URL, 500)).rejects.toMatchObject({
      kind: "blocked",
    });
    expect(downloadFixture.downloadPrevented).toBe(true);
    expect(downloadFixture.destroyed).toBe(true);
  });
});

function response(
  status: number,
  headers: LegacyHttpResponse["headers"],
  body: string | undefined,
  finalUrl: string,
): LegacyHttpResponse {
  return { status, headers, body, finalUrl };
}

function htmlResponse(
  title: string,
  body = "",
  finalUrl = PAGE_URL,
): LegacyHttpResponse {
  return response(
    200,
    { "content-type": "text/html; charset=utf-8" },
    `<html><head><title>${title}</title></head><body>${body}</body></html>`,
    finalUrl,
  );
}

type FakeMode =
  | "success"
  | "delayed-title"
  | "placeholder"
  | "failure"
  | "pending"
  | "file-navigation"
  | "download";

class FakeEventSource implements ElectronEventSource {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0,
    );
  }
}

class FakeSession extends FakeEventSource implements ElectronSessionLike {
  permissionRequestHandler:
    | ((
        webContents: unknown,
        permission: string,
        callback: (allowed: boolean) => void,
      ) => void)
    | null = null;
  permissionCheckHandler:
    | ((webContents: unknown, permission: string) => boolean)
    | null = null;
  storageClearCalls = 0;
  cacheClearCalls = 0;
  lastPermissionDecision: boolean | null = null;

  setPermissionRequestHandler(
    handler:
      | ((
          webContents: unknown,
          permission: string,
          callback: (allowed: boolean) => void,
        ) => void)
      | null,
  ): void {
    this.permissionRequestHandler = handler;
    handler?.({}, "notifications", (allowed) => {
      this.lastPermissionDecision = allowed;
    });
  }

  setPermissionCheckHandler(
    handler: ((webContents: unknown, permission: string) => boolean) | null,
  ): void {
    this.permissionCheckHandler = handler;
  }

  clearStorageData(): void {
    this.storageClearCalls++;
  }

  clearCache(): void {
    this.cacheClearCalls++;
  }
}

class FakeWebContents
  extends FakeEventSource
  implements ElectronWebContentsLike
{
  readonly session = new FakeSession();
  popupHandler: (() => { action: "deny" }) | null = null;
  navigationPrevented = false;
  downloadPrevented = false;
  private loadedUrl = PAGE_URL;
  private title = "Synthetic rendered title";

  constructor(private readonly mode: FakeMode) {
    super();
  }

  loadURL(url: string): Promise<void> {
    this.loadedUrl = url;
    queueMicrotask(() => {
      if (this.mode === "success") this.emit("did-finish-load");
      if (this.mode === "delayed-title") {
        this.title = "Loading…";
        this.emit("did-finish-load");
        setTimeout(() => {
          this.title = "Delayed rendered title";
          this.emit("page-title-updated", {}, this.title);
        }, 20);
      }
      if (this.mode === "placeholder") {
        this.title = "Title Unavailable | Site Unreachable";
        this.emit("did-finish-load");
      }
      if (this.mode === "failure")
        this.emit("did-fail-load", {}, -2, "synthetic error", url, true);
      if (this.mode === "file-navigation") {
        const event = {
          preventDefault: () => {
            this.navigationPrevented = true;
          },
        };
        this.emit("will-navigate", event, "file:///synthetic-fixture");
      }
      if (this.mode === "download") {
        const event = {
          preventDefault: () => {
            this.downloadPrevented = true;
          },
        };
        this.session.emit("will-download", event, { cancel: () => undefined });
      }
    });
    return Promise.resolve();
  }

  getURL(): string {
    return this.loadedUrl;
  }

  getTitle(): string {
    return this.title;
  }

  setWindowOpenHandler(handler: () => { action: "deny" }): void {
    this.popupHandler = handler;
  }
}

class FakeWindow implements ElectronWindowLike {
  readonly webContents: FakeWebContents;
  destroyed = false;

  constructor(mode: FakeMode) {
    this.webContents = new FakeWebContents(mode);
  }

  destroy(): void {
    this.destroyed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  get navigationPrevented(): boolean {
    return this.webContents.navigationPrevented;
  }

  get downloadPrevented(): boolean {
    return this.webContents.downloadPrevented;
  }
}

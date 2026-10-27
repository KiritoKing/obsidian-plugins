import {
  HOST_NAME,
  PROTOCOL_VERSION,
  errorResponse,
  isBridgeRequest,
  isRecord,
  validChannel,
  type BridgeResponse,
  type ErrorCode,
} from "@chlrc/browser-profile-title-protocol";
import { EXTENSION_ID } from "@chlrc/browser-profile-title-protocol/identity";
import { createChromeTitlePlatform } from "./chrome-platform";
import { TitleRequestQueue } from "./request-queue";
import { EXPLICIT_SITE_ORIGINS_KEY, explicitSiteOrigins } from "./site-consent";
import { retainChromeCoveredApprovals } from "./site-access";
import { resolveTitle } from "./title-resolution";

const CHANNEL_KEY = "channel";
const CONNECTION_ENABLED_KEY = "connectionEnabled";
const MAX_RECONNECT_ATTEMPTS = 8;

export type ConnectionView = {
  connected: boolean;
  connecting: boolean;
  retrying: boolean;
  channel: string;
  error?: { code: ErrorCode; message: string };
};

export class NativeConnectionController {
  private port: chrome.runtime.Port | undefined;
  private queue: TitleRequestQueue | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;
  private generation = 0;
  private manuallyDisconnected = false;
  private view: ConnectionView = {
    connected: false,
    connecting: false,
    retrying: false,
    channel: "default",
  };

  start(): void {
    void chrome.storage.local
      .get([CHANNEL_KEY, CONNECTION_ENABLED_KEY])
      .then((stored) => {
        const channel = stored[CHANNEL_KEY];
        if (validChannel(channel)) this.view.channel = channel;
        this.publish();
        if (stored[CONNECTION_ENABLED_KEY] === false) return;
        void this.connect(false);
      })
      .catch(() => {
        void this.connect(false);
      });
  }

  getState(): ConnectionView {
    return {
      ...this.view,
      error: this.view.error ? { ...this.view.error } : undefined,
    };
  }

  async reconnect(): Promise<void> {
    this.manuallyDisconnected = false;
    this.retryAttempt = 0;
    this.clearRetry();
    await chrome.storage.local.set({ [CONNECTION_ENABLED_KEY]: true });
    this.disconnectCurrent();
    await this.connect(false);
  }

  disconnect(): void {
    this.manuallyDisconnected = true;
    this.clearRetry();
    this.retryAttempt = 0;
    void chrome.storage.local.set({ [CONNECTION_ENABLED_KEY]: false });
    this.disconnectCurrent();
    this.setView({
      connected: false,
      connecting: false,
      retrying: false,
      channel: this.view.channel,
    });
  }

  async setChannel(value: unknown): Promise<boolean> {
    if (!validChannel(value)) return false;
    await chrome.storage.local.set({ [CHANNEL_KEY]: value });
    this.view.channel = value;
    await this.reconnect();
    return true;
  }

  permissionsRemoved(_origins: string[]): void {
    void chrome.storage.local
      .get(EXPLICIT_SITE_ORIGINS_KEY)
      .then(async (stored) => {
        const previous = explicitSiteOrigins(stored[EXPLICIT_SITE_ORIGINS_KEY]);
        const remaining = await retainChromeCoveredApprovals(
          previous,
          (pattern) => chrome.permissions.contains({ origins: [pattern] }),
        );
        const noLongerCovered = previous.filter(
          (pattern) => !remaining.includes(pattern),
        );
        this.queue?.failForRemovedOrigins(noLongerCovered);
        return chrome.storage.local.set({
          [EXPLICIT_SITE_ORIGINS_KEY]: remaining,
        });
      })
      .catch(() => undefined);
  }

  siteConsentRevoked(origin: string): void {
    this.queue?.failForRemovedOrigins([origin]);
  }

  private async connect(isRetry: boolean): Promise<void> {
    if (this.manuallyDisconnected) return;
    this.clearRetry();
    this.generation += 1;
    const generation = this.generation;
    this.setView({
      connected: false,
      connecting: true,
      retrying: isRetry,
      channel: this.view.channel,
    });

    if (chrome.runtime.id !== EXTENSION_ID) {
      this.setFailure(
        generation,
        "BRIDGE_UNAVAILABLE",
        "The extension id does not match the configured native host.",
      );
      return;
    }

    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch {
      this.setFailure(
        generation,
        "BRIDGE_UNAVAILABLE",
        "The local native messaging host is unavailable.",
      );
      return;
    }
    this.port = port;
    const queue = new TitleRequestQueue(
      (request, taskId, signal) =>
        resolveTitle(request, taskId, createChromeTitlePlatform(), signal),
      (response) => this.sendResponse(port, response),
      { makeTaskId: secureId },
    );
    this.queue = queue;
    port.onMessage.addListener((value: unknown) =>
      this.onNativeMessage(generation, port, queue, value),
    );
    port.onDisconnect.addListener(() => this.onDisconnect(generation, port));

    try {
      port.postMessage({
        version: PROTOCOL_VERSION,
        type: "hello",
        channel: this.view.channel,
        extensionId: chrome.runtime.id,
        instanceId: secureId(),
      });
      this.handshakeTimer = setTimeout(() => {
        if (
          generation !== this.generation ||
          this.port !== port ||
          this.view.connected
        )
          return;
        try {
          port.disconnect();
        } catch {
          this.onDisconnect(generation, port);
        }
      }, 5_000);
    } catch {
      this.onDisconnect(generation, port);
    }
  }

  private onNativeMessage(
    generation: number,
    port: chrome.runtime.Port,
    queue: TitleRequestQueue,
    value: unknown,
  ): void {
    if (generation !== this.generation || this.port !== port) return;
    if (
      isRecord(value) &&
      value.version === PROTOCOL_VERSION &&
      value.type === "status"
    ) {
      this.clearHandshake();
      const connected = value.connected === true;
      const channel = validChannel(value.channel)
        ? value.channel
        : this.view.channel;
      if (connected) {
        this.retryAttempt = 0;
        this.setView({
          connected: true,
          connecting: false,
          retrying: false,
          channel,
        });
      } else {
        const code =
          asErrorCode(isRecord(value.error) ? value.error.code : undefined) ??
          "BRIDGE_UNAVAILABLE";
        this.setView({
          connected: false,
          connecting: false,
          retrying: false,
          channel,
          error: { code, message: connectionErrorMessage(code) },
        });
        try {
          port.disconnect();
        } catch {
          this.onDisconnect(generation, port);
        }
      }
      return;
    }
    if (isBridgeRequest(value)) {
      queue.handle(value);
      return;
    }
    if (
      isRecord(value) &&
      typeof value.id === "string" &&
      /^[A-Za-z0-9_-]{1,96}$/.test(value.id)
    ) {
      this.sendResponse(
        port,
        errorResponse(
          value.id,
          "INVALID_REQUEST",
          "The native host sent an invalid request.",
        ),
      );
    }
  }

  private onDisconnect(generation: number, port: chrome.runtime.Port): void {
    if (generation !== this.generation || this.port !== port) return;
    this.queue?.close();
    this.queue = undefined;
    this.port = undefined;
    this.clearHandshake();
    this.setView({
      connected: false,
      connecting: false,
      retrying: false,
      channel: this.view.channel,
      error: {
        code: "BRIDGE_UNAVAILABLE",
        message: "The local browser bridge disconnected.",
      },
    });
    if (!this.manuallyDisconnected) this.scheduleReconnect(generation);
  }

  private scheduleReconnect(generation: number): void {
    if (this.retryAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.setView({
        connected: false,
        connecting: false,
        retrying: false,
        channel: this.view.channel,
        error: {
          code: "BRIDGE_UNAVAILABLE",
          message:
            "Reconnect stopped after repeated failures. Reconnect manually when the local host is ready.",
        },
      });
      return;
    }
    this.retryAttempt += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** (this.retryAttempt - 1));
    this.setView({ ...this.view, retrying: true });
    this.retryTimer = setTimeout(() => {
      if (generation !== this.generation || this.manuallyDisconnected) return;
      void this.connect(true);
    }, delay);
  }

  private setFailure(
    generation: number,
    code: ErrorCode,
    message: string,
  ): void {
    if (generation !== this.generation) return;
    this.setView({
      connected: false,
      connecting: false,
      retrying: false,
      channel: this.view.channel,
      error: { code, message },
    });
    if (!this.manuallyDisconnected) this.scheduleReconnect(generation);
  }

  private sendResponse(
    port: chrome.runtime.Port,
    response: BridgeResponse,
  ): void {
    if (this.port !== port) return;
    try {
      port.postMessage(response);
    } catch {
      // The disconnect handler owns cleanup and bounded reconnection.
    }
  }

  private disconnectCurrent(): void {
    this.generation += 1;
    this.clearHandshake();
    this.queue?.close();
    this.queue = undefined;
    const port = this.port;
    this.port = undefined;
    if (port) {
      try {
        port.disconnect();
      } catch {
        // Already disconnected.
      }
    }
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private clearHandshake(): void {
    if (this.handshakeTimer !== undefined) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  private setView(view: ConnectionView): void {
    this.view = view;
    this.publish();
  }

  private publish(): void {
    const view = this.getState();
    void chrome.runtime
      .sendMessage({ type: "connection-state", state: view })
      .catch(() => undefined);
  }
}

function secureId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function asErrorCode(value: unknown): ErrorCode | undefined {
  const codes: ErrorCode[] = [
    "AUTH_REQUIRED",
    "HOST_PERMISSION_REQUIRED",
    "FORBIDDEN",
    "TIMEOUT",
    "UNSUPPORTED",
    "BRIDGE_UNAVAILABLE",
    "CANCELLED",
    "INVALID_REQUEST",
    "AUTHENTICATION_FAILED",
    "PROFILE_IN_USE",
    "TITLE_UNAVAILABLE",
  ];
  return typeof value === "string" && codes.includes(value as ErrorCode)
    ? (value as ErrorCode)
    : undefined;
}

function connectionErrorMessage(code: ErrorCode): string {
  if (code === "PROFILE_IN_USE")
    return "The selected channel is already in use.";
  if (code === "AUTHENTICATION_FAILED")
    return "The local host could not authenticate this extension.";
  if (code === "HOST_PERMISSION_REQUIRED")
    return "Grant the site before requesting its title.";
  return "The local browser bridge is not ready.";
}

export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 12_000;
export const MAX_TIMEOUT_MS = 30_000;
export const HOST_NAME = "com.chlrc.browser_profile_title";
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const ERROR_CODES = [
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
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type ResolveTitleRequest = {
  version: 1;
  type: "resolve-title";
  id: string;
  url: string;
  timeoutMs: number;
};
export type BridgeRequest =
  | ResolveTitleRequest
  | { version: 1; type: "ping"; id: string }
  | { version: 1; type: "cancel"; id: string; requestId: string };
export type TitleResult = { title: string; url: string; source: "browser" };
export type BridgeResponse =
  | {
      version: 1;
      type: "response";
      id: string;
      ok: true;
      result: TitleResult | { pong: true } | { cancelled: true };
    }
  | {
      version: 1;
      type: "response";
      id: string;
      ok: false;
      error: { code: ErrorCode; message: string };
    };
export type NativeHello = {
  version: 1;
  type: "hello";
  channel: string;
  extensionId: string;
  instanceId: string;
};
export type NativeStatus = {
  version: 1;
  type: "status";
  connected: boolean;
  channel: string;
  error?: { code: ErrorCode; message: string };
};
export type Authenticate = { version: 1; type: "authenticate"; token: string };
export type Authenticated = { version: 1; type: "authenticated" };
export type ConnectionInfo = {
  version: 1;
  socketPath: string;
  token: string;
  pid: number;
  channel: string;
};

export function isConnectionInfo(value: unknown): value is ConnectionInfo {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.socketPath === "string" &&
    value.socketPath.length > 0 &&
    value.socketPath.length <= 4096 &&
    typeof value.token === "string" &&
    TOKEN_PATTERN.test(value.token) &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    validChannel(value.channel)
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(value);
}
export function validChannel(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);
}
export function parseWebUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 8192)
    throw new Error("Invalid web URL");
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Only credential-free HTTP(S) URLs are supported");
  }
  return url;
}
export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (!isRecord(value) || value.version !== 1 || !validId(value.id))
    return false;
  if (value.type === "ping") return true;
  if (value.type === "cancel") return validId(value.requestId);
  if (
    value.type !== "resolve-title" ||
    !Number.isInteger(value.timeoutMs) ||
    (value.timeoutMs as number) < 100 ||
    (value.timeoutMs as number) > MAX_TIMEOUT_MS
  )
    return false;
  try {
    parseWebUrl(value.url);
    return true;
  } catch {
    return false;
  }
}
export function isBridgeResponse(value: unknown): value is BridgeResponse {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.type !== "response" ||
    !validId(value.id)
  )
    return false;
  if (value.ok === false)
    return (
      isRecord(value.error) &&
      ERROR_CODES.includes(value.error.code as ErrorCode) &&
      typeof value.error.message === "string" &&
      value.error.message.length <= 512
    );
  if (value.ok !== true || !isRecord(value.result)) return false;
  if (value.result.pong === true || value.result.cancelled === true)
    return true;
  if (
    typeof value.result.title !== "string" ||
    value.result.title.length > 2048 ||
    value.result.source !== "browser"
  )
    return false;
  try {
    parseWebUrl(value.result.url);
    return true;
  } catch {
    return false;
  }
}
export function isNativeHello(value: unknown): value is NativeHello {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.type === "hello" &&
    validChannel(value.channel) &&
    typeof value.extensionId === "string" &&
    /^[a-p]{32}$/.test(value.extensionId) &&
    validId(value.instanceId)
  );
}
export function errorResponse(
  id: string,
  code: ErrorCode,
  message: string,
): BridgeResponse {
  return {
    version: 1,
    type: "response",
    id,
    ok: false,
    error: { code, message },
  };
}
export function encodeFrame(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  if (payload.length === 0 || payload.length > MAX_FRAME_BYTES)
    throw new Error("Frame exceeds size limit");
  const frame = new Uint8Array(payload.length + 4);
  new DataView(frame.buffer).setUint32(0, payload.length, true);
  frame.set(payload, 4);
  return frame;
}
export class FrameDecoder {
  private buffered: Uint8Array = new Uint8Array();
  push(chunk: Uint8Array): unknown[] {
    const joined = new Uint8Array(this.buffered.length + chunk.length);
    joined.set(this.buffered);
    joined.set(chunk, this.buffered.length);
    this.buffered = joined;
    const messages: unknown[] = [];
    while (this.buffered.length >= 4) {
      const length = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset,
        4,
      ).getUint32(0, true);
      if (length === 0 || length > MAX_FRAME_BYTES)
        throw new Error("Invalid frame size");
      if (this.buffered.length < length + 4) break;
      messages.push(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            this.buffered.subarray(4, length + 4),
          ),
        ),
      );
      this.buffered = this.buffered.slice(length + 4);
    }
    return messages;
  }
  get pendingBytes(): number {
    return this.buffered.length;
  }
}

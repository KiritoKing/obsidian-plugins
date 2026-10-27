import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { basename, dirname, resolve } from "node:path";
import {
  DEFAULT_TIMEOUT_MS,
  encodeFrame,
  FrameDecoder,
  isBridgeResponse,
  isConnectionInfo,
  isRecord,
  MAX_FRAME_BYTES,
  MAX_TIMEOUT_MS,
  parseWebUrl,
  PROTOCOL_VERSION,
  type BridgeResponse,
  type ConnectionInfo,
  type ErrorCode,
  type ResolveTitleRequest,
  validChannel,
} from "@chlrc/browser-profile-title-protocol";
import {
  channelDirectory,
  connectionFile,
  CONNECTION_BASENAME,
  SOCKET_BASENAME,
  stateBaseDirectory,
} from "@chlrc/browser-profile-title-protocol/paths";

export type BridgeFailureKind =
  | "unavailable"
  | "authentication"
  | "timeout"
  | "protocol"
  | "remote";

export class BridgeClientError extends Error {
  constructor(
    readonly kind: BridgeFailureKind,
    readonly remoteCode?: ErrorCode,
  ) {
    super(kind);
    this.name = "BridgeClientError";
  }
}

export class BridgeClient {
  constructor(
    private readonly channel = "default",
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly baseDirectory?: string,
  ) {}

  async resolveTitle(url: string): Promise<string> {
    let parsedUrl: URL;
    try {
      parsedUrl = parseWebUrl(url);
    } catch {
      throw new BridgeClientError("protocol");
    }

    const connection = await readBridgeConnection(
      this.channel,
      this.baseDirectory,
    );
    const request: ResolveTitleRequest = {
      version: PROTOCOL_VERSION,
      type: "resolve-title",
      id: randomBytes(18).toString("base64url"),
      url,
      timeoutMs: isTimeout(this.timeoutMs)
        ? this.timeoutMs
        : DEFAULT_TIMEOUT_MS,
    };
    const result = await this.exchange(connection, request, parsedUrl.href);
    if (typeof result !== "string") throw new BridgeClientError("protocol");
    return result;
  }

  async ping(): Promise<boolean> {
    try {
      const connection = await readBridgeConnection(
        this.channel,
        this.baseDirectory,
      );
      const result = await this.exchange(connection, {
        version: PROTOCOL_VERSION,
        type: "ping",
        id: randomBytes(18).toString("base64url"),
      });
      return result === true;
    } catch {
      return false;
    }
  }

  private exchange(
    connection: ConnectionInfo,
    request: ResolveTitleRequest | { version: 1; type: "ping"; id: string },
    canonicalUrl?: string,
  ): Promise<string | true> {
    const timeoutMs =
      request.type === "resolve-title"
        ? request.timeoutMs
        : isTimeout(this.timeoutMs)
          ? this.timeoutMs
          : DEFAULT_TIMEOUT_MS;

    return new Promise<string | true>((resolveResult, rejectResult) => {
      let phase: "authentication" | "response" = "authentication";
      let settled = false;
      let wroteRequest = false;
      const decoder = new FrameDecoder();
      const socket: Socket = createConnection({ path: connection.socketPath });
      const timer = setTimeout(
        () => finish(new BridgeClientError("timeout")),
        timeoutMs,
      );

      const finish = (
        error?: BridgeClientError,
        result?: string | true,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) rejectResult(error);
        else if (result !== undefined) resolveResult(result);
        else rejectResult(new BridgeClientError("protocol"));
      };

      socket.once("connect", () => {
        try {
          socket.write(
            encodeFrame({
              version: PROTOCOL_VERSION,
              type: "authenticate",
              token: connection.token,
            }),
          );
        } catch {
          finish(new BridgeClientError("protocol"));
        }
      });

      socket.on("data", (chunk) => {
        if (settled) return;
        try {
          for (const frame of decoder.push(chunk)) {
            if (phase === "authentication") {
              if (!isAuthenticated(frame)) {
                finish(new BridgeClientError("authentication"));
                return;
              }
              phase = "response";
              wroteRequest = true;
              socket.write(encodeFrame(request));
              continue;
            }

            if (
              !wroteRequest ||
              !isBridgeResponse(frame) ||
              frame.id !== request.id
            ) {
              finish(new BridgeClientError("protocol"));
              return;
            }
            const error = responseError(frame);
            if (error) {
              finish(error);
              return;
            }
            if (request.type === "ping") {
              if (!isPongResponse(frame)) {
                finish(new BridgeClientError("protocol"));
                return;
              }
              finish(undefined, true);
              return;
            }
            finish(undefined, responseTitle(frame, canonicalUrl ?? ""));
            return;
          }
          if (decoder.pendingBytes > MAX_FRAME_BYTES + 4) {
            finish(new BridgeClientError("protocol"));
          }
        } catch {
          finish(new BridgeClientError("protocol"));
        }
      });

      socket.once("error", () => finish(new BridgeClientError("unavailable")));
      socket.once("close", () => {
        if (!settled) finish(new BridgeClientError("unavailable"));
      });
    });
  }
}

export async function readBridgeConnection(
  channel: string,
  baseDirectory?: string,
): Promise<ConnectionInfo> {
  try {
    if (!validChannel(channel)) throw new Error("invalid channel");
    const base = baseDirectory ?? stateBaseDirectory();
    const directory = resolve(channelDirectory(channel, base));
    const descriptorPath = resolve(connectionFile(channel, base));
    const expectedSocketPath = resolve(directory, SOCKET_BASENAME);

    if (
      dirname(descriptorPath) !== directory ||
      basename(descriptorPath) !== CONNECTION_BASENAME
    ) {
      throw new Error("invalid descriptor path");
    }
    await assertPrivateDirectory(await lstat(directory));

    const beforeOpen = await lstat(descriptorPath);
    assertPrivateFile(beforeOpen);
    const handle = await open(
      descriptorPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let raw: string;
    try {
      const opened = await handle.stat();
      assertPrivateFile(opened);
      if (!sameFile(beforeOpen, opened) || opened.size > 8192) {
        throw new Error("descriptor changed or too large");
      }
      raw = await handle.readFile({ encoding: "utf8" });
      if (raw.length > 8192) throw new Error("descriptor too large");
    } finally {
      await handle.close();
    }

    const afterRead = await lstat(descriptorPath);
    assertPrivateFile(afterRead);
    if (!sameFile(beforeOpen, afterRead)) throw new Error("descriptor changed");

    const parsed: unknown = JSON.parse(raw);
    if (!isConnectionInfo(parsed) || parsed.channel !== channel) {
      throw new Error("invalid descriptor");
    }
    if (
      parsed.socketPath !== expectedSocketPath ||
      dirname(parsed.socketPath) !== directory ||
      basename(parsed.socketPath) !== SOCKET_BASENAME
    ) {
      throw new Error("socket outside channel directory");
    }

    const socketStats = await lstat(expectedSocketPath);
    assertPrivateSocket(socketStats);
    return parsed;
  } catch {
    throw new BridgeClientError("unavailable");
  }
}

function isTimeout(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && value <= MAX_TIMEOUT_MS;
}

function isAuthenticated(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.version === PROTOCOL_VERSION &&
    value.type === "authenticated" &&
    Object.keys(value).length === 2
  );
}

function responseError(response: BridgeResponse): BridgeClientError | null {
  return response.ok
    ? null
    : new BridgeClientError("remote", response.error.code);
}

function isPongResponse(response: BridgeResponse): boolean {
  if (!response.ok) return false;
  const result = response.result as unknown;
  return (
    isRecord(result) && result.pong === true && Object.keys(result).length === 1
  );
}

function responseTitle(
  response: BridgeResponse,
  canonicalUrl: string,
): string | undefined {
  if (!response.ok || !isRecord(response.result)) return undefined;
  const result = response.result as Record<string, unknown>;
  const { title, url, source } = result;
  if (
    typeof title !== "string" ||
    title.trim().length === 0 ||
    typeof url !== "string" ||
    source !== "browser"
  ) {
    return undefined;
  }
  try {
    if (parseWebUrl(url).href !== canonicalUrl) return undefined;
  } catch {
    return undefined;
  }
  return title;
}

function assertPrivateDirectory(stats: Stats): void {
  assertOwnedByCurrentUser(stats);
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    (stats.mode & 0o777) !== 0o700
  ) {
    throw new Error("unsafe channel directory");
  }
}

function assertPrivateFile(stats: Stats): void {
  assertOwnedByCurrentUser(stats);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw new Error("unsafe connection file");
  }
}

function assertPrivateSocket(stats: Stats): void {
  assertOwnedByCurrentUser(stats);
  if (
    stats.isSymbolicLink() ||
    !stats.isSocket() ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw new Error("unsafe bridge socket");
  }
}

function assertOwnedByCurrentUser(stats: Stats): void {
  const uid = process.getuid?.();
  if (uid === undefined || stats.uid !== uid)
    throw new Error("unexpected owner");
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

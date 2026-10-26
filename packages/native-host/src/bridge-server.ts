import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, rmdir } from "node:fs/promises";
import {
  createServer,
  createConnection,
  type Server,
  type Socket,
} from "node:net";
import { join } from "node:path";
import {
  DEFAULT_TIMEOUT_MS,
  FrameDecoder,
  MAX_FRAME_BYTES,
  MAX_TIMEOUT_MS,
  PROTOCOL_VERSION,
  TOKEN_PATTERN,
  encodeFrame,
  errorResponse,
  isBridgeRequest,
  isBridgeResponse,
  isConnectionInfo,
  isRecord,
  parseWebUrl,
  validChannel,
  validId,
  type BridgeRequest,
  type BridgeResponse,
  type ConnectionInfo,
  type ErrorCode,
} from "@chlrc/browser-profile-title-protocol";
import {
  SOCKET_BASENAME,
  channelDirectory,
  connectionFile,
  stateBaseDirectory,
} from "@chlrc/browser-profile-title-protocol/paths";
import { LONG_SOCKET_PATH_MESSAGE, SAFE_ERROR_MESSAGES } from "./errors.ts";
import {
  assertNoSymlinkComponents,
  assertPrivateDirectory,
  createExclusiveFile,
  ensureDirectory,
  identityOf,
  isErrno,
  lstatIfExists,
  unlinkIfOwned,
  type FileIdentity,
} from "./runtime-files.ts";

const SOCKET_PATH_LIMIT_BYTES = 100;
const AUTH_TIMEOUT_MS = 5_000;
const MAX_CLIENTS = 64;
const MAX_PENDING_PER_CLIENT = 64;
const MAX_PENDING_TOTAL = 1_024;
const CLOSE_GRACE_MS = 200;

type ClientState = {
  socket: Socket;
  decoder: FrameDecoder;
  authenticated: boolean;
  authTimer?: ReturnType<typeof setTimeout>;
  chain: Promise<void>;
  requestIds: Map<string, string>;
};

type PendingRequest = {
  nativeId: string;
  client: ClientState;
  clientId: string;
  kind: "resolve-title" | "cancel";
  timer?: ReturnType<typeof setTimeout>;
};

export type BridgeServerOptions = {
  channel: string;
  stateBase?: string;
  sendNative: (request: BridgeRequest) => Promise<void> | void;
  onClientCount?: (count: number) => void;
};

export type BridgeServerHandle = {
  readonly connectionInfo: ConnectionInfo;
  readonly socketPath: string;
  readonly clientCount: number;
  acceptNativeResponse(value: unknown): boolean;
  close(): Promise<void>;
};

export class BridgeStartError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message = SAFE_ERROR_MESSAGES[code]) {
    super(message);
    this.name = "BridgeStartError";
    this.code = code;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function validRequestShape(value: unknown): value is BridgeRequest {
  if (!isBridgeRequest(value) || !isRecord(value)) return false;
  if (value.type === "resolve-title") {
    return hasExactKeys(value, ["version", "type", "id", "url", "timeoutMs"]);
  }
  if (value.type === "cancel") {
    return hasExactKeys(value, ["version", "type", "id", "requestId"]);
  }
  return (
    value.type === "ping" && hasExactKeys(value, ["version", "type", "id"])
  );
}

function validResponseShape(value: unknown): value is BridgeResponse {
  if (!isBridgeResponse(value) || !isRecord(value)) return false;
  if (value.ok === false) {
    return (
      hasExactKeys(value, ["version", "type", "id", "ok", "error"]) &&
      isRecord(value.error) &&
      hasExactKeys(value.error, ["code", "message"])
    );
  }
  if (
    !hasExactKeys(value, ["version", "type", "id", "ok", "result"]) ||
    !isRecord(value.result)
  ) {
    return false;
  }
  if ("pong" in value.result && value.result.pong === true)
    return hasExactKeys(value.result, ["pong"]);
  if ("cancelled" in value.result && value.result.cancelled === true) {
    return hasExactKeys(value.result, ["cancelled"]);
  }
  return hasExactKeys(value.result, ["title", "url", "source"]);
}

function writeFrame(socket: Socket, value: unknown): boolean {
  try {
    const frame = Buffer.from(encodeFrame(value));
    if (socket.destroyed || socket.writableLength > MAX_FRAME_BYTES * 2)
      return false;
    socket.write(frame);
    return true;
  } catch {
    return false;
  }
}

function toSafeResponse(
  response: BridgeResponse,
  clientId: string,
): BridgeResponse {
  if (response.ok) return { ...response, id: clientId };
  return errorResponse(
    clientId,
    response.error.code,
    SAFE_ERROR_MESSAGES[response.error.code],
  );
}

function makeNativeId(): string {
  return `host-${randomBytes(16).toString("hex")}`;
}

function makeCancelRequest(requestId: string): BridgeRequest {
  return {
    version: PROTOCOL_VERSION,
    type: "cancel",
    id: makeNativeId(),
    requestId,
  };
}

function parseAuthenticate(value: unknown): string | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "type", "token"]))
    return undefined;
  if (value.version !== PROTOCOL_VERSION || value.type !== "authenticate")
    return undefined;
  if (typeof value.token !== "string" || !TOKEN_PATTERN.test(value.token))
    return undefined;
  return value.token;
}

function equalToken(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate, "base64url");
  const right = Buffer.from(expected, "base64url");
  return (
    left.length === right.length &&
    left.length >= 32 &&
    timingSafeTokenEqual(left, right)
  );
}

function timingSafeTokenEqual(left: Buffer, right: Buffer): boolean {
  return timingSafeEqual(left, right);
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
}

function removeCreatedDirectories(paths: string[]): Promise<void> {
  return (async () => {
    for (const path of [...paths].reverse()) {
      try {
        await rmdir(path);
      } catch (error) {
        if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTEMPTY"))
          throw error;
      }
    }
  })();
}

export async function createBridgeServer(
  options: BridgeServerOptions,
): Promise<BridgeServerHandle> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new BridgeStartError("UNSUPPORTED");
  }
  if (!validChannel(options.channel))
    throw new BridgeStartError("INVALID_REQUEST");

  const base = options.stateBase ?? stateBaseDirectory();
  const directory = channelDirectory(options.channel, base);
  const socketPath = join(directory, SOCKET_BASENAME);
  const connectionPath = connectionFile(options.channel, base);
  const lockPath = join(directory, "host.lock");
  if (Buffer.byteLength(socketPath, "utf8") >= SOCKET_PATH_LIMIT_BYTES) {
    throw new BridgeStartError("UNSUPPORTED", LONG_SOCKET_PATH_MESSAGE);
  }

  let createdDirectories: string[] = [];
  let lockIdentity: FileIdentity | undefined;
  let connectionIdentity: FileIdentity | undefined;
  let socketIdentity: FileIdentity | undefined;
  let server: Server | undefined;
  let listening = false;
  let closed = false;
  const clients = new Set<ClientState>();
  const pending = new Map<string, PendingRequest>();

  try {
    const ensured = await ensureDirectory(directory);
    createdDirectories = ensured.created;
    await assertPrivateDirectory(directory);
    await assertNoSymlinkComponents(directory);

    if (await lstatIfExists(lockPath))
      throw new BridgeStartError("PROFILE_IN_USE");
    try {
      lockIdentity = await createExclusiveFile(
        lockPath,
        `pid=${process.pid}\n`,
      );
    } catch (error) {
      if (isErrno(error, "EEXIST"))
        throw new BridgeStartError("PROFILE_IN_USE");
      throw error;
    }

    if (
      (await lstatIfExists(connectionPath)) ||
      (await lstatIfExists(socketPath))
    ) {
      throw new BridgeStartError("PROFILE_IN_USE");
    }

    const token = randomBytes(32).toString("base64url");
    const connectionInfo: ConnectionInfo = {
      version: PROTOCOL_VERSION,
      socketPath,
      token,
      pid: process.pid,
      channel: options.channel,
    };
    if (!isConnectionInfo(connectionInfo))
      throw new BridgeStartError("INVALID_REQUEST");

    const getClientPending = (client: ClientState): PendingRequest[] =>
      [...pending.values()].filter((request) => request.client === client);

    const forgetRequestId = (request: PendingRequest) => {
      if (request.timer) clearTimeout(request.timer);
      pending.delete(request.nativeId);
      if (
        request.client.requestIds.get(request.clientId) === request.nativeId
      ) {
        request.client.requestIds.delete(request.clientId);
      }
    };

    const sendCancel = async (nativeRequestId: string) => {
      try {
        await options.sendNative(makeCancelRequest(nativeRequestId));
      } catch {
        // Cancellation is best-effort when a client disappears or the browser is closing.
      }
    };

    const respondAndForget = (
      request: PendingRequest,
      response: BridgeResponse,
    ) => {
      forgetRequestId(request);
      writeFrame(
        request.client.socket,
        toSafeResponse(response, request.clientId),
      );
    };

    const handleClientRequest = async (client: ClientState, value: unknown) => {
      if (!client.authenticated) {
        const tokenCandidate = parseAuthenticate(value);
        if (!tokenCandidate || !equalToken(tokenCandidate, token)) {
          client.socket.destroy();
          return;
        }
        client.authenticated = true;
        if (client.authTimer) clearTimeout(client.authTimer);
        writeFrame(client.socket, {
          version: PROTOCOL_VERSION,
          type: "authenticated",
        });
        return;
      }

      if (!validRequestShape(value)) {
        if (isRecord(value) && validId(value.id)) {
          writeFrame(
            client.socket,
            errorResponse(
              value.id,
              "INVALID_REQUEST",
              SAFE_ERROR_MESSAGES.INVALID_REQUEST,
            ),
          );
          return;
        }
        client.socket.destroy();
        return;
      }

      if (value.type === "ping") {
        writeFrame(client.socket, {
          version: PROTOCOL_VERSION,
          type: "response",
          id: value.id,
          ok: true,
          result: { pong: true },
        });
        return;
      }

      if (
        pending.size >= MAX_PENDING_TOTAL ||
        client.requestIds.size >= MAX_PENDING_PER_CLIENT
      ) {
        writeFrame(
          client.socket,
          errorResponse(
            value.id,
            "BRIDGE_UNAVAILABLE",
            SAFE_ERROR_MESSAGES.BRIDGE_UNAVAILABLE,
          ),
        );
        return;
      }

      if (client.requestIds.has(value.id)) {
        writeFrame(
          client.socket,
          errorResponse(
            value.id,
            "INVALID_REQUEST",
            SAFE_ERROR_MESSAGES.INVALID_REQUEST,
          ),
        );
        return;
      }

      if (value.type === "cancel") {
        const targetNativeId = client.requestIds.get(value.requestId);
        if (
          !targetNativeId ||
          pending.get(targetNativeId)?.kind !== "resolve-title"
        ) {
          writeFrame(client.socket, {
            version: PROTOCOL_VERSION,
            type: "response",
            id: value.id,
            ok: true,
            result: { cancelled: true },
          });
          return;
        }
        const nativeId = makeNativeId();
        const request: PendingRequest = {
          nativeId,
          client,
          clientId: value.id,
          kind: "cancel",
        };
        pending.set(nativeId, request);
        client.requestIds.set(value.id, nativeId);
        request.timer = setTimeout(() => {
          const active = pending.get(nativeId);
          if (active !== request) return;
          respondAndForget(
            request,
            errorResponse(value.id, "TIMEOUT", SAFE_ERROR_MESSAGES.TIMEOUT),
          );
        }, DEFAULT_TIMEOUT_MS);
        request.timer.unref?.();
        try {
          await options.sendNative({
            version: PROTOCOL_VERSION,
            type: "cancel",
            id: nativeId,
            requestId: targetNativeId,
          });
        } catch {
          respondAndForget(
            request,
            errorResponse(
              value.id,
              "BRIDGE_UNAVAILABLE",
              SAFE_ERROR_MESSAGES.BRIDGE_UNAVAILABLE,
            ),
          );
        }
        return;
      }

      const nativeId = makeNativeId();
      const safeUrl = parseWebUrl(value.url).href;
      const timeoutMs = Math.min(value.timeoutMs, MAX_TIMEOUT_MS);
      const request: PendingRequest = {
        nativeId,
        client,
        clientId: value.id,
        kind: "resolve-title",
      };
      pending.set(nativeId, request);
      client.requestIds.set(value.id, nativeId);
      request.timer = setTimeout(() => {
        if (pending.get(nativeId) !== request) return;
        respondAndForget(
          request,
          errorResponse(value.id, "TIMEOUT", SAFE_ERROR_MESSAGES.TIMEOUT),
        );
        void sendCancel(nativeId);
      }, timeoutMs);
      request.timer.unref?.();
      try {
        await options.sendNative({
          version: PROTOCOL_VERSION,
          type: "resolve-title",
          id: nativeId,
          url: safeUrl,
          timeoutMs,
        });
      } catch {
        respondAndForget(
          request,
          errorResponse(
            value.id,
            "BRIDGE_UNAVAILABLE",
            SAFE_ERROR_MESSAGES.BRIDGE_UNAVAILABLE,
          ),
        );
      }
    };

    const onSocket = (socket: Socket) => {
      if (closed || clients.size >= MAX_CLIENTS) {
        socket.destroy();
        return;
      }
      socket.setNoDelay(true);
      const client: ClientState = {
        socket,
        decoder: new FrameDecoder(),
        authenticated: false,
        chain: Promise.resolve(),
        requestIds: new Map(),
      };
      clients.add(client);
      options.onClientCount?.(clients.size);
      client.authTimer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
      client.authTimer.unref?.();
      socket.on("data", (chunk: Buffer) => {
        let messages: unknown[];
        try {
          messages = client.decoder.push(
            new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
          );
        } catch {
          socket.destroy();
          return;
        }
        for (const message of messages) {
          client.chain = client.chain
            .then(() => handleClientRequest(client, message))
            .catch(() => {
              socket.destroy();
            });
        }
      });
      socket.on("error", () => undefined);
      socket.on("close", () => {
        if (client.authTimer) clearTimeout(client.authTimer);
        clients.delete(client);
        options.onClientCount?.(clients.size);
        for (const request of getClientPending(client)) {
          if (request.kind === "resolve-title")
            void sendCancel(request.nativeId);
          forgetRequestId(request);
        }
      });
    };

    server = createServer(onSocket);
    await listen(server, socketPath);
    listening = true;
    await chmod(socketPath, 0o600);
    const socketStats = await lstatIfExists(socketPath);
    if (
      !socketStats?.isSocket() ||
      socketStats.isSymbolicLink() ||
      (socketStats.mode & 0o777) !== 0o600
    ) {
      throw new BridgeStartError("BRIDGE_UNAVAILABLE");
    }
    socketIdentity = identityOf(socketStats);

    connectionIdentity = await createExclusiveFile(
      connectionPath,
      `${JSON.stringify(connectionInfo)}\n`,
    );

    const shutdown = async (code: ErrorCode = "BRIDGE_UNAVAILABLE") => {
      if (closed) return;
      closed = true;
      const all = [...pending.values()];
      await Promise.all(
        all
          .filter((request) => request.kind === "resolve-title")
          .map((request) => sendCancel(request.nativeId)),
      );
      for (const request of all) {
        const response = errorResponse(
          request.clientId,
          code,
          SAFE_ERROR_MESSAGES[code],
        );
        respondAndForget(request, response);
      }
      for (const client of clients) {
        if (client.authTimer) clearTimeout(client.authTimer);
        client.socket.end();
      }
      const clientsToClose = [...clients];
      if (clientsToClose.length > 0) {
        await Promise.race([
          Promise.all(
            clientsToClose.map(
              (client) =>
                new Promise<void>((resolveClose) => {
                  if (client.socket.destroyed) return resolveClose();
                  client.socket.once("close", () => resolveClose());
                }),
            ),
          ),
          new Promise<void>((resolveClose) =>
            setTimeout(resolveClose, CLOSE_GRACE_MS),
          ),
        ]);
        for (const client of clientsToClose) client.socket.destroy();
      }
      if (server) await closeServer(server);
      await unlinkIfOwned(socketPath, socketIdentity);
      await unlinkIfOwned(connectionPath, connectionIdentity);
      await unlinkIfOwned(lockPath, lockIdentity);
      await removeCreatedDirectories(createdDirectories);
    };

    const handle: BridgeServerHandle = {
      connectionInfo,
      socketPath,
      get clientCount() {
        return clients.size;
      },
      acceptNativeResponse(value: unknown): boolean {
        if (closed || !validResponseShape(value)) return false;
        const request = pending.get(value.id);
        if (!request) return false;
        respondAndForget(request, toSafeResponse(value, request.clientId));
        return true;
      },
      close: () => shutdown(),
    };
    return handle;
  } catch (error) {
    if (server && listening) {
      for (const client of clients) client.socket.destroy();
      await closeServer(server).catch(() => undefined);
      await unlinkIfOwned(socketPath, socketIdentity).catch(() => undefined);
    }
    await unlinkIfOwned(connectionPath, connectionIdentity).catch(
      () => undefined,
    );
    await unlinkIfOwned(lockPath, lockIdentity).catch(() => undefined);
    await removeCreatedDirectories(createdDirectories).catch(() => undefined);
    if (error instanceof BridgeStartError) throw error;
    if (isErrno(error, "EADDRINUSE") || isErrno(error, "EEXIST")) {
      throw new BridgeStartError("PROFILE_IN_USE");
    }
    throw new BridgeStartError("BRIDGE_UNAVAILABLE");
  }
}

export function isNativeBridgeResponse(
  value: unknown,
): value is BridgeResponse {
  return validResponseShape(value);
}

export async function probeSocket(
  socketPath: string,
  timeoutMs = 200,
): Promise<boolean> {
  return await new Promise<boolean>((resolveProbe) => {
    let finished = false;
    const done = (connected: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(connected);
    };
    const socket = createConnection({ path: socketPath });
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

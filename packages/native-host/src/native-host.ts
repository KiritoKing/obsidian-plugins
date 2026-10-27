import type { Readable, Writable } from "node:stream";
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  encodeFrame,
  isBridgeResponse,
  isNativeHello,
  isRecord,
  validChannel,
  type ErrorCode,
  type NativeHello,
  type NativeStatus,
} from "@chlrc/browser-profile-title-protocol";
import {
  EXTENSION_ID,
  extensionIdFromNativeMessagingOrigin,
  type SupportedExtensionId,
} from "@chlrc/browser-profile-title-protocol/identity";
import {
  BridgeStartError,
  createBridgeServer,
  isNativeBridgeResponse,
  type BridgeServerHandle,
} from "./bridge-server.ts";
import { SAFE_ERROR_MESSAGES } from "./errors.ts";

export type NativeHostOptions = {
  argv?: string[];
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
  stateBase?: string;
  signal?: AbortSignal;
  exit?: (code: number) => void;
};

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isNativeHelloFrame(value: unknown): value is NativeHello {
  return (
    isNativeHello(value) &&
    isRecord(value) &&
    hasExactKeys(value, [
      "version",
      "type",
      "channel",
      "extensionId",
      "instanceId",
    ])
  );
}

function writeFrame(stream: Writable, value: unknown): Promise<void> {
  const frame = Buffer.from(encodeFrame(value));
  return new Promise<void>((resolve, reject) => {
    stream.write(frame, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function writeFixedLog(stream: Writable, message: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      stream.write(`${message}\n`, () => resolve());
    } catch {
      resolve();
    }
  });
}

function statusMessage(
  connected: boolean,
  channel: string,
  code?: ErrorCode,
): NativeStatus {
  if (code) {
    return {
      version: PROTOCOL_VERSION,
      type: "status",
      connected,
      channel,
      error: { code, message: SAFE_ERROR_MESSAGES[code] },
    };
  }
  return { version: PROTOCOL_VERSION, type: "status", connected, channel };
}

export async function runNativeHost(
  options: NativeHostOptions = {},
): Promise<number> {
  const argv = options.argv ?? [];
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;

  const launchExtensionId =
    argv.length === 1
      ? extensionIdFromNativeMessagingOrigin(argv[0])
      : undefined;
  if (!launchExtensionId) {
    try {
      await writeFrame(
        output,
        statusMessage(false, "default", "AUTHENTICATION_FAILED"),
      );
    } catch {
      // The browser may have closed the native messaging pipe already.
    }
    await writeFixedLog(errorOutput, "Native host rejected the caller origin.");
    options.exit?.(1);
    return 1;
  }

  const decoder = new FrameDecoder();
  let bridge: BridgeServerHandle | undefined;
  let channel = "default";
  let helloAccepted = false;
  let ending = false;
  let endCode = 0;
  let chain = Promise.resolve();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const finish = async (
    code: number,
    errorCode?: ErrorCode,
    logMessage?: string,
  ) => {
    if (ending) return;
    ending = true;
    endCode = code;
    const currentChannel = validChannel(channel) ? channel : "default";
    if (bridge) {
      await bridge.close().catch(() => undefined);
      bridge = undefined;
    }
    if (errorCode) {
      await writeFrame(
        output,
        statusMessage(false, currentChannel, errorCode),
      ).catch(() => undefined);
    } else if (helloAccepted) {
      await writeFrame(output, statusMessage(false, currentChannel)).catch(
        () => undefined,
      );
    }
    if (logMessage) await writeFixedLog(errorOutput, logMessage);
    resolveDone();
  };

  const handleMessage = async (value: unknown) => {
    if (ending) return;
    if (!helloAccepted) {
      if (
        !isNativeHelloFrame(value) ||
        value.extensionId !== launchExtensionId
      ) {
        await finish(
          1,
          "AUTHENTICATION_FAILED",
          "Native host rejected the browser handshake.",
        );
        return;
      }
      channel = value.channel;
      let started: BridgeServerHandle;
      try {
        started = await createBridgeServer({
          channel,
          stateBase: options.stateBase,
          sendNative: async (request) => writeFrame(output, request),
        });
      } catch (error) {
        const code =
          error instanceof BridgeStartError ? error.code : "BRIDGE_UNAVAILABLE";
        const logMessage =
          error instanceof BridgeStartError &&
          error.message !== SAFE_ERROR_MESSAGES[code]
            ? error.message
            : `Native host could not start the local bridge (${code}).`;
        await finish(1, code, logMessage);
        return;
      }
      bridge = started;
      helloAccepted = true;
      try {
        await writeFrame(output, statusMessage(true, channel));
      } catch {
        await finish(
          1,
          "BRIDGE_UNAVAILABLE",
          "Native host could not report its connection status.",
        );
      }
      return;
    }

    if (!isNativeBridgeResponse(value) || !isBridgeResponse(value)) {
      await finish(
        1,
        "INVALID_REQUEST",
        "Native host received an invalid browser response.",
      );
      return;
    }
    bridge?.acceptNativeResponse(value);
  };

  const onData = (chunk: Buffer) => {
    if (ending) return;
    let messages: unknown[];
    try {
      messages = decoder.push(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
    } catch {
      void finish(
        1,
        "INVALID_REQUEST",
        "Native host received an invalid framed message.",
      );
      return;
    }
    for (const message of messages) {
      chain = chain
        .then(() => handleMessage(message))
        .catch(() =>
          finish(
            1,
            "BRIDGE_UNAVAILABLE",
            "Native host could not process a browser message.",
          ),
        );
    }
  };

  const onEnd = () => {
    chain = chain
      .then(async () => {
        if (ending) return;
        if (!helloAccepted) {
          await finish(
            1,
            undefined,
            "Native host closed before the browser handshake.",
          );
          return;
        }
        await finish(0);
      })
      .catch(() =>
        finish(1, "BRIDGE_UNAVAILABLE", "Native host could not close cleanly."),
      );
  };

  const onError = () => {
    void finish(1, "BRIDGE_UNAVAILABLE", "Native host input stream failed.");
  };

  const onAbort = () => {
    void finish(0);
  };

  input.on("data", onData);
  input.once("end", onEnd);
  input.once("close", onEnd);
  input.once("error", onError);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  await done;
  input.off("data", onData);
  input.off("end", onEnd);
  input.off("close", onEnd);
  input.off("error", onError);
  options.signal?.removeEventListener("abort", onAbort);
  options.exit?.(endCode);
  return endCode;
}

export function nativeMessagingOrigin(
  extensionId: SupportedExtensionId = EXTENSION_ID,
): string {
  return `chrome-extension://${extensionId}/`;
}

import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import {
  TOKEN_PATTERN,
  encodeFrame,
  type BridgeRequest,
  type ConnectionInfo,
} from "@chlrc/browser-profile-title-protocol";
import {
  EXTENSION_ID,
  RELEASE_EXTENSION_ID,
  SUPPORTED_EXTENSION_IDS,
} from "@chlrc/browser-profile-title-protocol/identity";
import {
  channelDirectory,
  connectionFile,
} from "@chlrc/browser-profile-title-protocol/paths";
import { BridgeStartError, createBridgeServer } from "../src/bridge-server.ts";
import {
  inspectRuntimeState,
  installNativeMessagingManifest,
} from "../src/install.ts";
import { nativeMessagingOrigin, runNativeHost } from "../src/native-host.ts";
import {
  FrameReader,
  connectFrames,
  makeShortTempDirectory,
  removeTempDirectory,
} from "./helpers.ts";

const titleRequest = (id: string, timeoutMs = 2_000) => ({
  version: 1,
  type: "resolve-title",
  id,
  url: "https://example.test/article",
  timeoutMs,
});

const titleResponse = (id: string, title: string) => ({
  version: 1,
  type: "response",
  id,
  ok: true,
  result: {
    title,
    url: "https://example.test/article",
    source: "browser",
  },
});

async function authenticate(
  client: Awaited<ReturnType<typeof connectFrames>>,
  token: string,
): Promise<void> {
  client.send({ version: 1, type: "authenticate", token });
  expect(await client.next()).toEqual({ version: 1, type: "authenticated" });
}

async function withBridge<T>(
  action: (context: {
    base: string;
    handle: Awaited<ReturnType<typeof createBridgeServer>>;
    native: FrameReader;
    output: PassThrough;
  }) => Promise<T>,
): Promise<T> {
  const base = await makeShortTempDirectory();
  const output = new PassThrough();
  const native = new FrameReader(output);
  const handle = await createBridgeServer({
    channel: "test-channel",
    stateBase: base,
    sendNative: (request) => {
      output.write(Buffer.from(encodeFrame(request)));
    },
  });
  try {
    return await action({ base, handle, native, output });
  } finally {
    await handle.close();
    output.destroy();
    await removeTempDirectory(base);
  }
}

describe("authenticated native bridge", () => {
  test("handles fragmented frames and Unicode title responses", async () => {
    await withBridge(async ({ handle, native }) => {
      const client = await connectFrames(handle.socketPath);
      try {
        await authenticate(client, handle.connectionInfo.token);
        await client.sendSplit(titleRequest("unicode", 1_000));
        const request = (await native.next()) as BridgeRequest;
        expect(request.type).toBe("resolve-title");
        if (request.type !== "resolve-title")
          throw new Error("Expected a title request");
        expect(request.url).toBe("https://example.test/article");
        expect(
          handle.acceptNativeResponse(titleResponse(request.id, "标题 🌏")),
        ).toBe(true);
        expect(await client.next()).toMatchObject({
          type: "response",
          id: "unicode",
          ok: true,
          result: { title: "标题 🌏", source: "browser" },
        });
      } finally {
        client.destroy();
      }
    });
  });

  test("rejects a wrong pairing token without returning a protocol response", async () => {
    await withBridge(async ({ handle }) => {
      const client = await connectFrames(handle.socketPath);
      try {
        client.send({
          version: 1,
          type: "authenticate",
          token: randomBytes(32).toString("base64url"),
        });
        await client.closed;
        expect(handle.clientCount).toBe(0);
      } finally {
        client.destroy();
      }
    });
  });

  test("times out a pending request and sends a native cancellation", async () => {
    await withBridge(async ({ handle, native }) => {
      const client = await connectFrames(handle.socketPath);
      try {
        await authenticate(client, handle.connectionInfo.token);
        client.send(titleRequest("short-timeout", 100));
        const request = (await native.next()) as BridgeRequest;
        expect(request.type).toBe("resolve-title");
        if (request.type !== "resolve-title")
          throw new Error("Expected a title request");
        expect(await client.next()).toMatchObject({
          type: "response",
          id: "short-timeout",
          ok: false,
          error: { code: "TIMEOUT" },
        });
        expect(await native.next()).toMatchObject({
          version: 1,
          type: "cancel",
          requestId: request.id,
        });
      } finally {
        client.destroy();
      }
    });
  });

  test("forwards explicit cancellation and keeps request IDs isolated per client", async () => {
    await withBridge(async ({ handle, native }) => {
      const first = await connectFrames(handle.socketPath);
      const second = await connectFrames(handle.socketPath);
      try {
        await authenticate(first, handle.connectionInfo.token);
        await authenticate(second, handle.connectionInfo.token);
        first.send(titleRequest("shared-id"));
        second.send(titleRequest("shared-id"));
        const firstNative = (await native.next()) as BridgeRequest;
        const secondNative = (await native.next()) as BridgeRequest;
        expect(firstNative.type).toBe("resolve-title");
        expect(secondNative.type).toBe("resolve-title");
        if (
          firstNative.type !== "resolve-title" ||
          secondNative.type !== "resolve-title"
        ) {
          throw new Error("Expected title requests from both clients");
        }
        expect(firstNative.id).not.toBe(secondNative.id);

        first.send({
          version: 1,
          type: "cancel",
          id: "cancel-one",
          requestId: "shared-id",
        });
        const cancel = (await native.next()) as BridgeRequest;
        expect(cancel).toMatchObject({
          type: "cancel",
          requestId: firstNative.id,
        });
        if (cancel.type !== "cancel")
          throw new Error("Expected a cancellation request");
        expect(
          handle.acceptNativeResponse({
            version: 1,
            type: "response",
            id: cancel.id,
            ok: true,
            result: { cancelled: true },
          }),
        ).toBe(true);
        expect(await first.next()).toMatchObject({
          type: "response",
          id: "cancel-one",
          ok: true,
          result: { cancelled: true },
        });

        expect(
          handle.acceptNativeResponse(
            titleResponse(secondNative.id, "Second client"),
          ),
        ).toBe(true);
        expect(await second.next()).toMatchObject({
          type: "response",
          id: "shared-id",
          ok: true,
          result: { title: "Second client" },
        });
        expect(
          handle.acceptNativeResponse({
            version: 1,
            type: "response",
            id: firstNative.id,
            ok: false,
            error: { code: "CANCELLED", message: "cancelled" },
          }),
        ).toBe(true);
        expect(await first.next()).toMatchObject({
          type: "response",
          id: "shared-id",
          ok: false,
          error: { code: "CANCELLED" },
        });
      } finally {
        first.destroy();
        second.destroy();
      }
    });
  });

  test("cancels native work when the socket client disconnects", async () => {
    await withBridge(async ({ handle, native }) => {
      const client = await connectFrames(handle.socketPath);
      await authenticate(client, handle.connectionInfo.token);
      client.send(titleRequest("disconnect-me"));
      const request = (await native.next()) as BridgeRequest;
      if (request.type !== "resolve-title")
        throw new Error("Expected a title request");
      client.destroy();
      expect(await native.next()).toMatchObject({
        type: "cancel",
        requestId: request.id,
      });
      expect(
        handle.acceptNativeResponse(titleResponse(request.id, "late")),
      ).toBe(false);
    });
  });

  test("does not replace runtime state owned by another host", async () => {
    const base = await makeShortTempDirectory();
    const first = await createBridgeServer({
      channel: "same-profile",
      stateBase: base,
      sendNative: () => undefined,
    });
    const connectionPath = connectionFile("same-profile", base);
    try {
      let secondError: unknown;
      try {
        await createBridgeServer({
          channel: "same-profile",
          stateBase: base,
          sendNative: () => undefined,
        });
      } catch (error) {
        secondError = error;
      }
      expect(secondError).toBeInstanceOf(BridgeStartError);
      expect((secondError as BridgeStartError).code).toBe("PROFILE_IN_USE");
      const stored = JSON.parse(
        await readFile(connectionPath, "utf8"),
      ) as ConnectionInfo;
      expect(stored.channel).toBe("same-profile");
      expect(TOKEN_PATTERN.test(stored.token)).toBe(true);
      expect((await lstat(first.socketPath)).isSocket()).toBe(true);
      expect(
        await inspectRuntimeState({ channel: "same-profile", stateBase: base }),
      ).toEqual({
        channel: "same-profile",
        state: "active",
      });
    } finally {
      await first.close();
      await removeTempDirectory(base);
    }
  });
});

describe("Native Messaging lifecycle", () => {
  for (const extensionId of SUPPORTED_EXTENSION_IDS) {
    test(`accepts the exact extension hello and cleans up on stdin EOF (${extensionId})`, async () => {
      const base = await makeShortTempDirectory();
      const input = new PassThrough();
      const output = new PassThrough();
      const errorOutput = new PassThrough();
      const reader = new FrameReader(output);
      const logChunks: Buffer[] = [];
      errorOutput.on("data", (chunk: Buffer) => logChunks.push(chunk));
      const host = runNativeHost({
        argv: [nativeMessagingOrigin(extensionId)],
        input,
        output,
        errorOutput,
        stateBase: base,
      });
      try {
        input.write(
          Buffer.from(
            encodeFrame({
              version: 1,
              type: "hello",
              channel: "native-eof",
              extensionId,
              instanceId: "test-instance",
            }),
          ),
        );
        expect(await reader.next()).toEqual({
          version: 1,
          type: "status",
          connected: true,
          channel: "native-eof",
        });

        const connection = JSON.parse(
          await readFile(connectionFile("native-eof", base), "utf8"),
        ) as ConnectionInfo;
        expect(TOKEN_PATTERN.test(connection.token)).toBe(true);
        const client = await connectFrames(connection.socketPath);
        await authenticate(client, connection.token);
        client.send(titleRequest("active-on-eof", 5_000));
        const forwarded = (await reader.next()) as BridgeRequest;
        if (forwarded.type !== "resolve-title")
          throw new Error("Expected a forwarded title request");

        input.end();
        expect(await reader.next()).toMatchObject({
          type: "cancel",
          requestId: forwarded.id,
        });
        expect(await client.next()).toMatchObject({
          type: "response",
          id: "active-on-eof",
          ok: false,
          error: { code: "BRIDGE_UNAVAILABLE" },
        });
        expect(await reader.next()).toEqual({
          version: 1,
          type: "status",
          connected: false,
          channel: "native-eof",
        });
        expect(await host).toBe(0);
        expect(
          await inspectRuntimeState({ channel: "native-eof", stateBase: base }),
        ).toEqual({
          channel: "native-eof",
          state: "not-configured",
        });
        await expect(
          readFile(connectionFile("native-eof", base), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(Buffer.concat(logChunks).toString("utf8")).toBe("");
        client.destroy();
      } finally {
        input.destroy();
        output.destroy();
        errorOutput.destroy();
        await removeTempDirectory(base);
      }
    });
  }

  test("rejects an unknown third extension origin before starting the bridge", async () => {
    const base = await makeShortTempDirectory();
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const reader = new FrameReader(output);
    const unknownId = "a".repeat(32);
    const host = runNativeHost({
      argv: [`chrome-extension://${unknownId}/`],
      input,
      output,
      errorOutput,
      stateBase: base,
    });
    try {
      expect(await reader.next()).toEqual({
        version: 1,
        type: "status",
        connected: false,
        channel: "default",
        error: {
          code: "AUTHENTICATION_FAILED",
          message: "Authentication failed.",
        },
      });
      expect(await host).toBe(1);
      expect(
        await inspectRuntimeState({ channel: "default", stateBase: base }),
      ).toEqual({
        channel: "default",
        state: "not-configured",
      });
    } finally {
      input.destroy();
      output.destroy();
      errorOutput.destroy();
      await removeTempDirectory(base);
    }
  });

  test("rejects unknown and mismatched hello identities under an allowed origin", async () => {
    for (const helloExtensionId of ["a".repeat(32), RELEASE_EXTENSION_ID]) {
      const base = await makeShortTempDirectory();
      const input = new PassThrough();
      const output = new PassThrough();
      const errorOutput = new PassThrough();
      const reader = new FrameReader(output);
      const host = runNativeHost({
        argv: [nativeMessagingOrigin(EXTENSION_ID)],
        input,
        output,
        errorOutput,
        stateBase: base,
      });
      try {
        input.write(
          Buffer.from(
            encodeFrame({
              version: 1,
              type: "hello",
              channel: "mismatched-hello",
              extensionId: helloExtensionId,
              instanceId: "test-instance",
            }),
          ),
        );
        expect(await reader.next()).toEqual({
          version: 1,
          type: "status",
          connected: false,
          channel: "default",
          error: {
            code: "AUTHENTICATION_FAILED",
            message: "Authentication failed.",
          },
        });
        expect(await host).toBe(1);
        expect(
          await inspectRuntimeState({
            channel: "mismatched-hello",
            stateBase: base,
          }),
        ).toEqual({
          channel: "mismatched-hello",
          state: "not-configured",
        });
      } finally {
        input.destroy();
        output.destroy();
        errorOutput.destroy();
        await removeTempDirectory(base);
      }
    }
  });
});

describe("installer and doctor", () => {
  async function createFixtureBinary(
    directory: string,
    name: string,
  ): Promise<string> {
    const path = `${directory}/${name}`;
    const contents = `fixture executable ${name}`;
    await writeFile(path, contents, { mode: 0o700 });
    await chmod(path, 0o700);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    const receipt = {
      format: "chlrc-native-host-standalone-v1",
      platform: process.platform,
      arch: process.arch,
      sha256,
    };
    await writeFile(
      `${path}.build-receipt.json`,
      `${JSON.stringify(receipt)}\n`,
      { mode: 0o600 },
    );
    return path;
  }

  test("dry-run leaves the profile untouched; install requires explicit replacement and reads back", async () => {
    const root = await makeShortTempDirectory();
    const profile = `${root}/profile`;
    const binary = await createFixtureBinary(root, "fixture-host");
    try {
      const preview = await installNativeMessagingManifest({
        binaryPath: binary,
        stateDir: profile,
        dryRun: true,
      });
      expect(preview.dryRun).toBe(true);
      await expect(
        lstat(`${profile}/NativeMessagingHosts`),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const installed = await installNativeMessagingManifest({
        binaryPath: binary,
        stateDir: profile,
      });
      expect(installed.dryRun).toBe(false);
      expect(installed.replaced).toBe(false);
      const firstContents = await readFile(installed.manifestPath, "utf8");
      expect(JSON.parse(firstContents)).toMatchObject({
        path: binary,
        type: "stdio",
        allowed_origins: [
          "chrome-extension://ligookeeainjhapkanfmgabeenmeljbn/",
          "chrome-extension://fgcokpikjhdcomfiingeapogdkgaalol/",
        ],
      });
      expect((await lstat(installed.manifestPath)).mode & 0o777).toBe(0o600);

      await expect(
        installNativeMessagingManifest({
          binaryPath: binary,
          stateDir: profile,
        }),
      ).rejects.toThrow("explicit --replace");
      expect(await readFile(installed.manifestPath, "utf8")).toBe(
        firstContents,
      );

      const legacyManifest = {
        name: "com.chlrc.browser_profile_title",
        description: "Local browser profile title bridge for Obsidian",
        path: binary,
        type: "stdio",
        allowed_origins: [
          "chrome-extension://ligookeeainjhapkanfmgabeenmeljbn/",
        ],
      };
      await writeFile(
        installed.manifestPath,
        `${JSON.stringify(legacyManifest, null, 2)}\n`,
        { mode: 0o600 },
      );
      await expect(
        installNativeMessagingManifest({
          binaryPath: binary,
          stateDir: profile,
        }),
      ).rejects.toThrow("explicit --replace");
      expect(
        JSON.parse(await readFile(installed.manifestPath, "utf8")),
      ).toEqual(legacyManifest);

      const replacementBinary = await createFixtureBinary(
        root,
        "replacement-host",
      );
      const replaced = await installNativeMessagingManifest({
        binaryPath: replacementBinary,
        stateDir: profile,
        replace: true,
      });
      expect(replaced.replaced).toBe(true);
      expect(
        JSON.parse(await readFile(replaced.manifestPath, "utf8")),
      ).toMatchObject({
        path: replacementBinary,
        allowed_origins: [
          "chrome-extension://ligookeeainjhapkanfmgabeenmeljbn/",
          "chrome-extension://fgcokpikjhdcomfiingeapogdkgaalol/",
        ],
      });
      expect((await lstat(replaced.manifestPath)).mode & 0o777).toBe(0o600);

      const thirdPartyManifest = {
        ...legacyManifest,
        name: "third-party.native-host",
        allowed_origins: [
          "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
        ],
      };
      await writeFile(
        replaced.manifestPath,
        `${JSON.stringify(thirdPartyManifest, null, 2)}\n`,
        { mode: 0o600 },
      );
      await expect(
        installNativeMessagingManifest({
          binaryPath: binary,
          stateDir: profile,
          replace: true,
        }),
      ).rejects.toThrow("not managed by this host");
      expect(JSON.parse(await readFile(replaced.manifestPath, "utf8"))).toEqual(
        thirdPartyManifest,
      );
    } finally {
      await removeTempDirectory(root);
    }
  });

  test("doctor returns only token-free active and stale-state categories", async () => {
    const base = await makeShortTempDirectory();
    const active = await createBridgeServer({
      channel: "doctor-test",
      stateBase: base,
      sendNative: () => undefined,
    });
    try {
      const report = await inspectRuntimeState({
        channel: "doctor-test",
        stateBase: base,
      });
      expect(report).toEqual({ channel: "doctor-test", state: "active" });
      expect(JSON.stringify(report).includes(active.connectionInfo.token)).toBe(
        false,
      );
    } finally {
      await active.close();
    }
    try {
      await mkdir(channelDirectory("doctor-test", base), { mode: 0o700 });
      await writeFile(connectionFile("doctor-test", base), "stale");
      await chmod(connectionFile("doctor-test", base), 0o600);
      const report = await inspectRuntimeState({
        channel: "doctor-test",
        stateBase: base,
      });
      expect(report).toEqual({
        channel: "doctor-test",
        state: "stale-connection",
      });
      expect(JSON.stringify(report).includes("token")).toBe(false);
      expect(
        await lstat(channelDirectory("doctor-test", base)).then((stats) =>
          stats.isDirectory(),
        ),
      ).toBe(true);
    } finally {
      await removeTempDirectory(base);
    }
  });
});

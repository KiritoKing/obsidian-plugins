import { describe, expect, test } from "bun:test";
import {
  FrameDecoder,
  MAX_FRAME_BYTES,
  encodeFrame,
  isBridgeRequest,
  isBridgeResponse,
  isConnectionInfo,
  parseWebUrl,
  validChannel,
} from "../src/index.ts";
import {
  DEVELOPMENT_NATIVE_MESSAGING_ORIGIN,
  EXTENSION_ID,
  RELEASE_EXTENSION_ID,
  RELEASE_NATIVE_MESSAGING_ORIGIN,
  SUPPORTED_EXTENSION_IDS,
  SUPPORTED_NATIVE_MESSAGING_ORIGINS,
  extensionIdFromNativeMessagingOrigin,
  isSupportedExtensionId,
  nativeMessagingOriginForExtensionId,
} from "../src/identity.ts";

describe("framed JSON", () => {
  test("reassembles fragmented Unicode and multiple replies", () => {
    const a = encodeFrame({ title: "Synthetic 标题 🧪" });
    const b = encodeFrame({ id: "second" });
    const all = new Uint8Array(a.length + b.length);
    all.set(a);
    all.set(b, a.length);
    const decoder = new FrameDecoder();
    const messages = [];
    for (let i = 0; i < all.length; i += 3)
      messages.push(...decoder.push(all.subarray(i, i + 3)));
    expect(messages).toEqual([
      { title: "Synthetic 标题 🧪" },
      { id: "second" },
    ]);
    expect(decoder.pendingBytes).toBe(0);
  });
  test("rejects oversized, zero and malformed JSON frames", () => {
    const tooLarge = new Uint8Array(4);
    new DataView(tooLarge.buffer).setUint32(0, MAX_FRAME_BYTES + 1, true);
    expect(() => new FrameDecoder().push(tooLarge)).toThrow();
    expect(() => new FrameDecoder().push(new Uint8Array(4))).toThrow();
    expect(() =>
      new FrameDecoder().push(new Uint8Array([1, 0, 0, 0, 123])),
    ).toThrow();
    expect(() => encodeFrame("a".repeat(MAX_FRAME_BYTES))).toThrow();
  });
});

describe("request boundaries", () => {
  const request = {
    version: 1,
    type: "resolve-title",
    id: "test-1",
    url: "https://intranet.example.test/page#route",
    timeoutMs: 2000,
  };
  test("preserves query/hash without permitting other schemes or embedded credentials", () => {
    expect(parseWebUrl(request.url).hash).toBe("#route");
    for (const url of [
      "file:///tmp/example",
      "javascript:alert(1)",
      "https://name:pass@example.test/",
    ]) {
      expect(isBridgeRequest({ ...request, url })).toBe(false);
    }
    expect(isBridgeRequest(request)).toBe(true);
  });
  test("rejects unbounded timeout, arbitrary method and path-like channel", () => {
    expect(isBridgeRequest({ ...request, timeoutMs: 60_000 })).toBe(false);
    expect(isBridgeRequest({ ...request, type: "execute-code" })).toBe(false);
    expect(validChannel("../other")).toBe(false);
    expect(validChannel("profile-a")).toBe(true);
  });
  test("requires a valid title reply and explicit error code", () => {
    expect(
      isBridgeResponse({
        version: 1,
        type: "response",
        id: "x",
        ok: true,
        result: { title: "Title", url: request.url, source: "browser" },
      }),
    ).toBe(true);
    expect(
      isBridgeResponse({
        version: 1,
        type: "response",
        id: "x",
        ok: true,
        result: {
          title: "Title",
          url: "file:///tmp/example",
          source: "browser",
        },
      }),
    ).toBe(false);
    expect(
      isBridgeResponse({
        version: 1,
        type: "response",
        id: "x",
        ok: false,
        error: { code: "unknown", message: "failure" },
      }),
    ).toBe(false);
  });
  test("validates pairing document shape without handling it as a request", () => {
    const connection = {
      version: 1,
      socketPath: "/tmp/example/bridge.sock",
      token: "a".repeat(43),
      pid: 42,
      channel: "default",
    };
    expect(isConnectionInfo(connection)).toBe(true);
    expect(isConnectionInfo({ ...connection, token: "short" })).toBe(false);
    expect(isBridgeRequest(connection)).toBe(false);
  });
});

describe("fixed extension identities", () => {
  test("admits exactly the development and release identities and origins", () => {
    expect(EXTENSION_ID).toBe("ligookeeainjhapkanfmgabeenmeljbn");
    expect(RELEASE_EXTENSION_ID).toBe("fgcokpikjhdcomfiingeapogdkgaalol");
    expect(SUPPORTED_EXTENSION_IDS).toEqual([
      EXTENSION_ID,
      RELEASE_EXTENSION_ID,
    ]);
    expect(SUPPORTED_NATIVE_MESSAGING_ORIGINS).toEqual([
      DEVELOPMENT_NATIVE_MESSAGING_ORIGIN,
      RELEASE_NATIVE_MESSAGING_ORIGIN,
    ]);

    for (const extensionId of SUPPORTED_EXTENSION_IDS) {
      expect(isSupportedExtensionId(extensionId)).toBe(true);
      expect(
        extensionIdFromNativeMessagingOrigin(
          nativeMessagingOriginForExtensionId(extensionId),
        ),
      ).toBe(extensionId);
    }

    const unknownId = "a".repeat(32);
    expect(isSupportedExtensionId(unknownId)).toBe(false);
    expect(nativeMessagingOriginForExtensionId(unknownId)).toBeUndefined();
    expect(
      extensionIdFromNativeMessagingOrigin(`chrome-extension://${unknownId}/`),
    ).toBeUndefined();
    expect(
      extensionIdFromNativeMessagingOrigin(
        `chrome-extension://${EXTENSION_ID}/extra`,
      ),
    ).toBeUndefined();
  });
});

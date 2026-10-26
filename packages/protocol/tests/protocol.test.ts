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

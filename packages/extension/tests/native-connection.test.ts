import { describe, expect, test } from "bun:test";
import {
  EXTENSION_ID,
  RELEASE_EXTENSION_ID,
} from "@chlrc/browser-profile-title-protocol/identity";
import { NativeConnectionController } from "../src/native-connection";

function createChromeMock(extensionId: string) {
  const posted: unknown[] = [];
  let nativeConnections = 0;
  const event = { addListener: (_listener: unknown) => undefined };
  const port = {
    onMessage: event,
    onDisconnect: event,
    postMessage: (value: unknown) => posted.push(value),
    disconnect: () => undefined,
  };
  const chromeMock = {
    runtime: {
      id: extensionId,
      sendMessage: async () => undefined,
      connectNative: () => {
        nativeConnections += 1;
        return port;
      },
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
      },
    },
    permissions: {
      contains: async () => true,
    },
  } as unknown as typeof chrome;
  return {
    chrome: chromeMock,
    posted,
    get nativeConnections() {
      return nativeConnections;
    },
  };
}

async function withChromeMock<T>(
  extensionId: string,
  action: (mock: ReturnType<typeof createChromeMock>) => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const mock = createChromeMock(extensionId);
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: mock.chrome,
  });
  try {
    return await action(mock);
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "chrome", descriptor);
    } else {
      Reflect.deleteProperty(globalThis, "chrome");
    }
  }
}

describe("native connection extension identity", () => {
  for (const extensionId of [EXTENSION_ID, RELEASE_EXTENSION_ID]) {
    test(`connects with the fixed extension identity ${extensionId}`, async () => {
      await withChromeMock(extensionId, async (mock) => {
        const controller = new NativeConnectionController();
        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mock.nativeConnections).toBe(1);
        expect(mock.posted).toContainEqual(
          expect.objectContaining({ type: "hello", extensionId }),
        );
        controller.disconnect();
      });
    });
  }

  test("rejects an unknown third extension identity before connecting", async () => {
    await withChromeMock("a".repeat(32), async (mock) => {
      const controller = new NativeConnectionController();
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mock.nativeConnections).toBe(0);
      expect(controller.getState().error?.code).toBe("BRIDGE_UNAVAILABLE");
      controller.disconnect();
    });
  });
});

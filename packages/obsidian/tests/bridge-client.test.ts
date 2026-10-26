import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { BridgeClient, readBridgeConnection } from "../src/bridge-client";
import {
  FrameDecoder,
  encodeFrame,
  type ResolveTitleRequest,
} from "@chlrc/browser-profile-title-protocol";
import {
  channelDirectory,
  connectionFile,
  SOCKET_BASENAME,
} from "@chlrc/browser-profile-title-protocol/paths";

interface Fixture {
  channel: string;
  baseDirectory: string;
  directory: string;
  descriptorPath: string;
  socketPath: string;
  server: Server;
  close(): Promise<void>;
}

const fixtures = new Set<Fixture>();

afterAll(async () => {
  await Promise.all([...fixtures].map((fixture) => fixture.close()));
});

describe("local browser bridge client", () => {
  test("authenticates, sends a framed request, and returns only the title", async () => {
    const fixture = await createFixture({
      onRequest(request, socket) {
        const reply = encodeFrame({
          version: 1,
          type: "response",
          id: request.id,
          ok: true,
          result: {
            title: "Browser profile title",
            url: request.url,
            source: "browser",
          },
        });
        socket.write(reply.subarray(0, 3));
        setTimeout(() => socket.write(reply.subarray(3)), 5);
      },
    });

    try {
      const result = await new BridgeClient(
        fixture.channel,
        2000,
        fixture.baseDirectory,
      ).resolveTitle("https://example.com/page");
      expect(result).toBe("Browser profile title");
    } finally {
      await fixture.close();
    }
  });

  test("rejects an invalid authentication acknowledgement", async () => {
    const fixture = await createFixture({
      authReply: { version: 1, type: "unauthorized" },
    });

    try {
      await expect(
        new BridgeClient(
          fixture.channel,
          1000,
          fixture.baseDirectory,
        ).resolveTitle("https://example.com/"),
      ).rejects.toMatchObject({ kind: "authentication" });
    } finally {
      await fixture.close();
    }
  });

  test("rejects a response with an unrelated request id", async () => {
    const fixture = await createFixture({
      onRequest(request, socket) {
        socket.write(
          encodeFrame({
            version: 1,
            type: "response",
            id: `${request.id}-other`,
            ok: true,
            result: {
              title: "wrong request",
              url: request.url,
              source: "browser",
            },
          }),
        );
      },
    });

    try {
      await expect(
        new BridgeClient(
          fixture.channel,
          1000,
          fixture.baseDirectory,
        ).resolveTitle("https://example.com/"),
      ).rejects.toMatchObject({ kind: "protocol" });
    } finally {
      await fixture.close();
    }
  });

  test("times out without changing the requested URL or returning a partial title", async () => {
    const fixture = await createFixture({ onRequest() {} });

    try {
      await expect(
        new BridgeClient(
          fixture.channel,
          150,
          fixture.baseDirectory,
        ).resolveTitle("https://example.com/"),
      ).rejects.toMatchObject({ kind: "timeout" });
    } finally {
      await fixture.close();
    }
  });

  test("rejects symbolic-link descriptors and sockets outside the channel", async () => {
    const fixture = await createFixture({ onRequest() {} });
    const originalDescriptor = await readFile(fixture.descriptorPath, "utf8");
    const alternatePath = join(fixture.directory, "descriptor-copy.json");

    try {
      await writeFile(alternatePath, originalDescriptor, { mode: 0o600 });
      await chmod(alternatePath, 0o600);
      await unlink(fixture.descriptorPath);
      await symlink(alternatePath, fixture.descriptorPath);
      await expect(
        readBridgeConnection(fixture.channel, fixture.baseDirectory),
      ).rejects.toMatchObject({ kind: "unavailable" });

      await unlink(fixture.descriptorPath);
      await writeDescriptor(fixture, "/tmp/outside-bridge.sock");
      await expect(
        readBridgeConnection(fixture.channel, fixture.baseDirectory),
      ).rejects.toMatchObject({ kind: "unavailable" });
    } finally {
      await fixture.close();
    }
  });

  test("rejects a connection directory with broader permissions", async () => {
    const fixture = await createFixture({ onRequest() {} });

    try {
      await chmod(fixture.directory, 0o755);
      await expect(
        readBridgeConnection(fixture.channel, fixture.baseDirectory),
      ).rejects.toMatchObject({ kind: "unavailable" });
    } finally {
      await fixture.close();
    }
  });
});

async function createFixture(options: {
  authReply?: unknown;
  onRequest?(request: ResolveTitleRequest, socket: Socket): void;
}): Promise<Fixture> {
  const baseDirectory = await mkdtemp("/tmp/bpt-");
  const channel = `test-${randomBytes(3).toString("hex")}`;
  const directory = channelDirectory(channel, baseDirectory);
  const descriptorPath = connectionFile(channel, baseDirectory);
  const socketPath = join(directory, SOCKET_BASENAME);
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);

  const token = randomBytes(32).toString("base64url");
  const server = createServer((socket) => {
    const decoder = new FrameDecoder();
    let authenticated = false;
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (!authenticated) {
          expect(frame).toMatchObject({
            version: 1,
            type: "authenticate",
            token,
          });
          authenticated = true;
          socket.write(
            encodeFrame(
              options.authReply ?? { version: 1, type: "authenticated" },
            ),
          );
          continue;
        }
        if (isResolveTitleRequest(frame)) options.onRequest?.(frame, socket);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  await writeDescriptor(
    {
      channel,
      descriptorPath,
      socketPath,
    },
    socketPath,
    token,
  );

  const fixture: Fixture = {
    channel,
    baseDirectory,
    directory,
    descriptorPath,
    socketPath,
    server,
    close: async () => {
      if (fixtures.has(fixture)) fixtures.delete(fixture);
      await closeServer(server);
      await rm(baseDirectory, { recursive: true, force: true });
    },
  };
  fixtures.add(fixture);
  return fixture;
}

async function writeDescriptor(
  fixture: Pick<Fixture, "channel" | "descriptorPath" | "socketPath">,
  socketPath: string,
  token = randomBytes(32).toString("base64url"),
): Promise<void> {
  await writeFile(
    fixture.descriptorPath,
    JSON.stringify({
      version: 1,
      socketPath,
      token,
      pid: process.pid,
      channel: fixture.channel,
    }),
    { mode: 0o600 },
  );
  await chmod(fixture.descriptorPath, 0o600);
}

function isResolveTitleRequest(value: unknown): value is ResolveTitleRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "resolve-title"
  );
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

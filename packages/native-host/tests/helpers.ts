import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import {
  FrameDecoder,
  encodeFrame,
} from "@chlrc/browser-profile-title-protocol";

type Waiter = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class FrameSocket {
  readonly socket: Socket;
  private readonly decoder = new FrameDecoder();
  private readonly queue: unknown[] = [];
  private readonly waiters: Waiter[] = [];
  readonly closed: Promise<void>;

  constructor(socket: Socket) {
    this.socket = socket;
    this.closed = new Promise((resolveClose) =>
      socket.once("close", () => resolveClose()),
    );
    socket.on("data", (chunk: Buffer) => {
      for (const value of this.decoder.push(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      )) {
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(value);
        } else this.queue.push(value);
      }
    });
    socket.on("error", () => undefined);
  }

  send(value: unknown): void {
    this.socket.write(Buffer.from(encodeFrame(value)));
  }

  async sendSplit(value: unknown): Promise<void> {
    const frame = Buffer.from(encodeFrame(value));
    this.socket.write(frame.subarray(0, 2));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    this.socket.write(frame.subarray(2, 5));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    this.socket.write(frame.subarray(5));
  }

  next(timeoutMs = 2_000): Promise<unknown> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolveMessage, rejectMessage) => {
      const waiter = {
        resolve: resolveMessage,
        reject: rejectMessage,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          rejectMessage(new Error("Timed out waiting for a framed message"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  destroy(): void {
    this.socket.destroy();
  }
}

export class FrameReader {
  private readonly decoder = new FrameDecoder();
  private readonly queue: unknown[] = [];
  private readonly waiters: Waiter[] = [];

  constructor(stream: NodeJS.ReadableStream) {
    stream.on("data", (chunk: Buffer) => {
      for (const value of this.decoder.push(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      )) {
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(value);
        } else this.queue.push(value);
      }
    });
  }

  next(timeoutMs = 2_000): Promise<unknown> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolveMessage, rejectMessage) => {
      const waiter = {
        resolve: resolveMessage,
        reject: rejectMessage,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          rejectMessage(new Error("Timed out waiting for a framed message"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

export async function makeShortTempDirectory(): Promise<string> {
  const temporaryRoot = await realpath("/tmp").catch(() => realpath(tmpdir()));
  return await mkdtemp(join(temporaryRoot, "bpt-"));
}

export async function removeTempDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function connectFrames(path: string): Promise<FrameSocket> {
  const socket = createConnection({ path });
  await new Promise<void>((resolveConnect, rejectConnect) => {
    socket.once("connect", resolveConnect);
    socket.once("error", rejectConnect);
  });
  return new FrameSocket(socket);
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for local state");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}

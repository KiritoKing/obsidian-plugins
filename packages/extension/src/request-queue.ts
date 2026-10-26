import {
  ERROR_CODES,
  MAX_TIMEOUT_MS,
  errorResponse,
  isBridgeRequest,
  isRecord,
  type BridgeResponse,
  type ErrorCode,
  type ResolveTitleRequest,
  type TitleResult,
} from "@chlrc/browser-profile-title-protocol";
import { canonicalWebUrl, exactOriginPattern } from "./url-policy";

export type ResolveTask = (
  request: ResolveTitleRequest,
  taskId: string,
  signal: AbortSignal,
) => Promise<TitleResult>;
export type QueueOptions = { maxTasks?: number; makeTaskId: () => string };

type Waiter = {
  request: ResolveTitleRequest;
  timer: ReturnType<typeof setTimeout>;
};
type Task = {
  key: string;
  taskId: string;
  request: ResolveTitleRequest;
  controller: AbortController;
  waiters: Map<string, Waiter>;
};

const DEFAULT_MAX_TASKS = 4;

export class TitleRequestQueue {
  private readonly maxTasks: number;
  private readonly queued: Task[] = [];
  private readonly tasksByUrl = new Map<string, Task>();
  private readonly taskByRequestId = new Map<string, Task>();
  private active: Task | undefined;
  private closed = false;

  constructor(
    private readonly resolve: ResolveTask,
    private readonly respond: (response: BridgeResponse) => void,
    private readonly options: QueueOptions,
  ) {
    this.maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
  }

  handle(value: unknown): void {
    if (this.closed) return;
    if (!isBridgeRequest(value)) {
      this.respondInvalid(value);
      return;
    }
    if (value.type === "ping") {
      this.respond({
        version: 1,
        type: "response",
        id: value.id,
        ok: true,
        result: { pong: true },
      });
      return;
    }
    if (value.type === "cancel") {
      this.cancel(value.requestId);
      this.respond({
        version: 1,
        type: "response",
        id: value.id,
        ok: true,
        result: { cancelled: true },
      });
      return;
    }
    this.enqueue(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const task of this.tasksByUrl.values()) {
      for (const waiter of task.waiters.values()) clearTimeout(waiter.timer);
      task.controller.abort();
    }
    this.queued.length = 0;
    this.taskByRequestId.clear();
    this.tasksByUrl.clear();
  }

  private enqueue(request: ResolveTitleRequest): void {
    if (this.taskByRequestId.has(request.id)) {
      this.respond(
        errorResponse(
          request.id,
          "INVALID_REQUEST",
          "A request with this id is already active.",
        ),
      );
      return;
    }
    let urlKey: string;
    try {
      urlKey = canonicalWebUrl(request.url);
    } catch {
      this.respond(
        errorResponse(
          request.id,
          "INVALID_REQUEST",
          "Only credential-free HTTP(S) URLs are supported.",
        ),
      );
      return;
    }

    let task = this.tasksByUrl.get(urlKey);
    if (!task) {
      if (this.tasksByUrl.size >= this.maxTasks) {
        this.respond(
          errorResponse(
            request.id,
            "TITLE_UNAVAILABLE",
            "The title request queue is full.",
          ),
        );
        return;
      }
      task = {
        key: urlKey,
        taskId: this.options.makeTaskId(),
        request: { ...request },
        controller: new AbortController(),
        waiters: new Map(),
      };
      this.tasksByUrl.set(urlKey, task);
      this.queued.push(task);
    } else {
      task.request = {
        ...task.request,
        timeoutMs: Math.max(task.request.timeoutMs, request.timeoutMs),
      };
    }

    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(100, request.timeoutMs),
    );
    const timer = setTimeout(() => this.expire(request.id), timeoutMs);
    task.waiters.set(request.id, { request, timer });
    this.taskByRequestId.set(request.id, task);
    void this.pump();
  }

  private cancel(requestId: string): void {
    const task = this.taskByRequestId.get(requestId);
    const waiter = task?.waiters.get(requestId);
    if (!task || !waiter) return;
    clearTimeout(waiter.timer);
    task.waiters.delete(requestId);
    this.taskByRequestId.delete(requestId);
    this.respond(
      errorResponse(requestId, "CANCELLED", "The title request was cancelled."),
    );
    if (task.waiters.size > 0) return;
    task.controller.abort();
    if (task !== this.active) this.removeTask(task);
  }

  failForRemovedOrigins(origins: string[]): void {
    const removed = new Set(origins);
    for (const task of this.tasksByUrl.values()) {
      let pattern: string;
      try {
        pattern = exactOriginPattern(task.request.url);
      } catch {
        continue;
      }
      if (!removed.has(pattern)) continue;
      for (const [id, waiter] of task.waiters) {
        clearTimeout(waiter.timer);
        this.taskByRequestId.delete(id);
        this.respond(
          errorResponse(
            id,
            "HOST_PERMISSION_REQUIRED",
            "Permission for this site was removed during the request.",
          ),
        );
      }
      task.waiters.clear();
      task.controller.abort();
      if (task !== this.active) this.removeTask(task);
    }
  }

  private expire(requestId: string): void {
    const task = this.taskByRequestId.get(requestId);
    const waiter = task?.waiters.get(requestId);
    if (!task || !waiter) return;
    task.waiters.delete(requestId);
    this.taskByRequestId.delete(requestId);
    this.respond(
      errorResponse(requestId, "TIMEOUT", "The title request timed out."),
    );
    if (task.waiters.size > 0) return;
    task.controller.abort();
    if (task !== this.active) this.removeTask(task);
  }

  private async pump(): Promise<void> {
    if (this.closed || this.active) return;
    const task = this.queued.shift();
    if (!task) return;
    if (task.waiters.size === 0) {
      this.removeTask(task);
      return this.pump();
    }

    this.active = task;
    try {
      const result = await this.resolve(
        task.request,
        task.taskId,
        task.controller.signal,
      );
      for (const [id, waiter] of task.waiters) {
        clearTimeout(waiter.timer);
        this.respond({ version: 1, type: "response", id, ok: true, result });
        this.taskByRequestId.delete(id);
      }
    } catch (error) {
      const code: ErrorCode = isErrorCode(
        (error as { code?: unknown } | null)?.code,
      )
        ? (error as { code: ErrorCode }).code
        : "TITLE_UNAVAILABLE";
      const message = safeMessage(code, error);
      for (const [id, waiter] of task.waiters) {
        clearTimeout(waiter.timer);
        this.respond(errorResponse(id, code, message));
        this.taskByRequestId.delete(id);
      }
    } finally {
      this.removeTask(task);
      this.active = undefined;
      if (!this.closed) void this.pump();
    }
  }

  private removeTask(task: Task): void {
    this.tasksByUrl.delete(task.key);
    const index = this.queued.indexOf(task);
    if (index >= 0) this.queued.splice(index, 1);
    for (const id of task.waiters.keys()) this.taskByRequestId.delete(id);
    task.waiters.clear();
  }

  private respondInvalid(value: unknown): void {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,96}$/.test(value.id)
    )
      return;
    this.respond(
      errorResponse(
        value.id,
        "INVALID_REQUEST",
        "The title request was invalid.",
      ),
    );
  }
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODES.includes(value as ErrorCode);
}

function safeMessage(code: ErrorCode, error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  if (
    typeof message === "string" &&
    message.length <= 512 &&
    !/https?:\/\//i.test(message)
  )
    return message;
  const defaults: Record<ErrorCode, string> = {
    AUTH_REQUIRED:
      "This page appears to require sign-in in the browser profile.",
    HOST_PERMISSION_REQUIRED:
      "Grant this site in extension settings before requesting its title.",
    FORBIDDEN:
      "This page denied access or redirected outside the permitted site.",
    TIMEOUT: "The title request timed out.",
    UNSUPPORTED: "This page cannot be read by the extension.",
    BRIDGE_UNAVAILABLE: "The local browser bridge is unavailable.",
    CANCELLED: "The title request was cancelled.",
    INVALID_REQUEST: "The title request was invalid.",
    AUTHENTICATION_FAILED: "The local browser bridge could not authenticate.",
    PROFILE_IN_USE:
      "The browser profile is already connected to another bridge session.",
    TITLE_UNAVAILABLE: "The browser could not read a title from this page.",
  };
  return defaults[code];
}

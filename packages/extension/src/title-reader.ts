export type InjectedTitleResult = {
  state: "ready" | "timeout" | "cancelled";
  title: string;
  url: string;
};

/** This function is serialized by chrome.scripting and runs in the isolated main frame. */
export async function readVisibleTitle(
  taskId: string,
  timeoutMs: number,
): Promise<InjectedTitleResult> {
  const registryKey = "__chlrcBrowserProfileTitleReadsV1";
  type ReadState = { cancelled: boolean };
  const root = globalThis as typeof globalThis & { [key: string]: unknown };
  let registry = root[registryKey] as Record<string, ReadState> | undefined;
  if (!registry) {
    registry = Object.create(null) as Record<string, ReadState>;
    root[registryKey] = registry;
  }
  const state: ReadState = { cancelled: false };
  registry[taskId] = state;

  const startedAt = Date.now();
  let previous = "";
  let stableTicks = 0;
  while (Date.now() - startedAt < timeoutMs) {
    if (state.cancelled) {
      delete registry[taskId];
      return { state: "cancelled", title: "", url: location.href };
    }
    const title = (document.title ?? "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 2048);
    if (title && title === previous) stableTicks += 1;
    else {
      previous = title;
      stableTicks = 0;
    }
    if (stableTicks >= 4) {
      delete registry[taskId];
      return { state: "ready", title, url: location.href };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }

  const title = (document.title ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 2048);
  delete registry[taskId];
  return { state: "timeout", title, url: location.href };
}

/** This fixed function only flips the cancellation flag in the extension's isolated world. */
export function cancelVisibleTitleRead(taskId: string): boolean {
  const registryKey = "__chlrcBrowserProfileTitleReadsV1";
  const root = globalThis as typeof globalThis & { [key: string]: unknown };
  const registry = root[registryKey] as
    | Record<string, { cancelled: boolean }>
    | undefined;
  const state = registry?.[taskId];
  if (!state) return false;
  state.cancelled = true;
  return true;
}

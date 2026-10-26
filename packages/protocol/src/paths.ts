import { homedir } from "node:os";
import { join } from "node:path";
import { validChannel } from "./index.ts";

export const SOCKET_BASENAME = "bridge.sock";
export const CONNECTION_BASENAME = "connection.json";

export function stateBaseDirectory(): string {
  if (process.platform === "darwin")
    return join(
      homedir(),
      "Library",
      "Application Support",
      "obsidian-browser-title",
    );
  if (process.platform === "linux")
    return join(
      process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
      "obsidian-browser-title",
    );
  throw new Error("The native bridge currently supports macOS and Linux");
}
export function channelDirectory(
  channel = "default",
  base = stateBaseDirectory(),
): string {
  if (!validChannel(channel)) throw new Error("Invalid channel name");
  return join(base, channel);
}
export function connectionFile(
  channel = "default",
  base = stateBaseDirectory(),
): string {
  return join(channelDirectory(channel, base), CONNECTION_BASENAME);
}

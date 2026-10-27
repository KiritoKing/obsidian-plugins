import { isRecord, validChannel } from "@chlrc/browser-profile-title-protocol";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from "@chlrc/browser-profile-title-protocol";

export interface BrowserProfileTitleSettings {
  channel: string;
  timeoutMs: number;
  enhanceDefaultPaste: boolean;
  enhanceDropEvents: boolean;
  shouldPreserveSelectionAsTitle: boolean;
  websiteBlacklist: string;
  maximumTitleLength: number;
  legacyFallbackEnabled: boolean;
}

export const DEFAULT_SETTINGS: BrowserProfileTitleSettings = {
  channel: "default",
  timeoutMs: DEFAULT_TIMEOUT_MS,
  enhanceDefaultPaste: true,
  enhanceDropEvents: true,
  shouldPreserveSelectionAsTitle: false,
  websiteBlacklist: "",
  maximumTitleLength: 0,
  legacyFallbackEnabled: true,
};

export function sanitizeSettings(value: unknown): BrowserProfileTitleSettings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS };

  const channel =
    typeof value.channel === "string" && validChannel(value.channel)
      ? value.channel
      : DEFAULT_SETTINGS.channel;
  const timeoutMs =
    typeof value.timeoutMs === "number" &&
    Number.isInteger(value.timeoutMs) &&
    value.timeoutMs >= 100 &&
    value.timeoutMs <= MAX_TIMEOUT_MS
      ? value.timeoutMs
      : DEFAULT_SETTINGS.timeoutMs;
  const maximumTitleLength =
    typeof value.maximumTitleLength === "number" &&
    Number.isInteger(value.maximumTitleLength) &&
    value.maximumTitleLength >= 0 &&
    value.maximumTitleLength <= 2000
      ? value.maximumTitleLength
      : DEFAULT_SETTINGS.maximumTitleLength;

  return {
    channel,
    timeoutMs,
    maximumTitleLength,
    enhanceDefaultPaste:
      typeof value.enhanceDefaultPaste === "boolean"
        ? value.enhanceDefaultPaste
        : DEFAULT_SETTINGS.enhanceDefaultPaste,
    enhanceDropEvents:
      typeof value.enhanceDropEvents === "boolean"
        ? value.enhanceDropEvents
        : DEFAULT_SETTINGS.enhanceDropEvents,
    shouldPreserveSelectionAsTitle:
      typeof value.shouldPreserveSelectionAsTitle === "boolean"
        ? value.shouldPreserveSelectionAsTitle
        : DEFAULT_SETTINGS.shouldPreserveSelectionAsTitle,
    websiteBlacklist:
      typeof value.websiteBlacklist === "string"
        ? value.websiteBlacklist.slice(0, 4096)
        : DEFAULT_SETTINGS.websiteBlacklist,
    legacyFallbackEnabled:
      typeof value.legacyFallbackEnabled === "boolean"
        ? value.legacyFallbackEnabled
        : DEFAULT_SETTINGS.legacyFallbackEnabled,
  };
}

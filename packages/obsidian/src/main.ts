import { Notice, Plugin } from "obsidian";
import type { Editor } from "obsidian";
import type { ErrorCode } from "@chlrc/browser-profile-title-protocol";
import {
  getEditorPositionFromIndex,
  getIndexFromEditorPosition,
  getSelectionOrUrl,
} from "./editor-enhancements";
import {
  isAfterQuote,
  isImage,
  isInCode,
  isLinkedUrl,
  isMarkdownLinkAlready,
  normalizeWebUrl,
} from "./checkif";
import { BridgeClient, BridgeClientError } from "./bridge-client";
import { resolveLegacyTitle } from "./legacy-title-resolver";
import {
  BrowserProfileTitleSettingTab,
  DEFAULT_SETTINGS,
  sanitizeSettings,
  type BrowserProfileTitleSettings,
} from "./settings";
import {
  formatMarkdownLink,
  resolvedTitleReplacement,
  safeReplacementRange,
} from "./title-format";
import {
  INITIAL_RESOLVER_STATUS,
  resolveTitleWithFallback,
  type ResolverStatusSnapshot,
} from "./title-resolver";

export type { ResolverStatusSnapshot } from "./title-resolver";

interface ActiveEditorSnapshot {
  editor: Editor;
  filePath: string | null;
}

export default class BrowserProfileLinkTitle extends Plugin {
  settings: BrowserProfileTitleSettings = { ...DEFAULT_SETTINGS };
  private resolverStatus: ResolverStatusSnapshot = {
    ...INITIAL_RESOLVER_STATUS,
  };

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerEvent(
      this.app.workspace.on("editor-paste", (event, editor) => {
        void this.pasteUrlWithTitle(event, editor);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("editor-drop", (event, editor) => {
        void this.dropUrlWithTitle(event, editor);
      }),
    );

    this.addCommand({
      id: "auto-link-title-paste",
      name: "Paste URL and fetch title from browser profile",
      editorCallback: (editor) => void this.manualPasteUrlWithTitle(editor),
      hotkeys: [],
    });
    this.addCommand({
      id: "auto-link-title-normal-paste",
      name: "Normal paste (without title lookup)",
      editorCallback: (editor) => void this.normalPaste(editor),
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "v" }],
    });
    this.addCommand({
      id: "enhance-url-with-title",
      name: "Enhance existing URL with browser title",
      editorCallback: (editor) => void this.addTitleToLink(editor),
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "e" }],
    });

    this.addSettingTab(new BrowserProfileTitleSettingTab(this.app, this));
  }

  async normalPaste(editor: Editor): Promise<void> {
    const clipboardText = await this.readClipboardText();
    if (clipboardText !== null && clipboardText !== "") {
      editor.replaceSelection(clipboardText);
    }
  }

  async manualPasteUrlWithTitle(editor: Editor): Promise<void> {
    const clipboardText = await this.readClipboardText();
    if (clipboardText === null || clipboardText === "") return;

    const url = normalizeWebUrl(clipboardText);
    if (!url || isImage(url) || isInCode(editor)) {
      editor.replaceSelection(clipboardText);
      return;
    }
    if (isMarkdownLinkAlready(editor) || isAfterQuote(editor)) {
      editor.replaceSelection(clipboardText);
      return;
    }

    const selectedText = editor.getSelection().trim();
    if (selectedText && this.settings.shouldPreserveSelectionAsTitle) {
      editor.replaceSelection(formatMarkdownLink(selectedText, url));
      return;
    }
    await this.insertUrlThenResolve(editor, url);
  }

  async pasteUrlWithTitle(
    event: ClipboardEvent,
    editor: Editor,
  ): Promise<void> {
    if (!this.settings.enhanceDefaultPaste || event.defaultPrevented) return;
    if (
      isInCode(editor) ||
      isMarkdownLinkAlready(editor) ||
      isAfterQuote(editor)
    ) {
      return;
    }

    const clipboardText = event.clipboardData?.getData("text/plain") ?? "";
    const url = normalizeWebUrl(clipboardText);
    if (!url || isImage(url)) return;

    event.stopPropagation();
    event.preventDefault();
    const selectedText = editor.getSelection().trim();
    if (selectedText && this.settings.shouldPreserveSelectionAsTitle) {
      editor.replaceSelection(formatMarkdownLink(selectedText, url));
      return;
    }
    await this.insertUrlThenResolve(editor, url);
  }

  async dropUrlWithTitle(event: DragEvent, editor: Editor): Promise<void> {
    if (!this.settings.enhanceDropEvents || event.defaultPrevented) return;
    if (
      isInCode(editor) ||
      isMarkdownLinkAlready(editor) ||
      isAfterQuote(editor)
    ) {
      return;
    }

    const dropText = event.dataTransfer?.getData("text/plain") ?? "";
    const url = normalizeWebUrl(dropText);
    if (!url || isImage(url)) return;

    event.stopPropagation();
    event.preventDefault();
    const selectedText = editor.getSelection().trim();
    if (selectedText && this.settings.shouldPreserveSelectionAsTitle) {
      editor.replaceSelection(formatMarkdownLink(selectedText, url));
      return;
    }
    await this.insertUrlThenResolve(editor, url);
  }

  async addTitleToLink(editor: Editor): Promise<void> {
    if (isInCode(editor)) return;
    const range = getSelectionOrUrl(editor);
    if (!range.text) return;

    const url = isLinkedUrl(range.text)
      ? this.getUrlFromLink(range.text)
      : normalizeWebUrl(range.text);
    if (!url || isImage(url) || this.isBlacklisted(url)) return;

    const originalValue = editor.getValue();
    const startIndex = getIndexFromEditorPosition(originalValue, range.start);
    const endIndex = getIndexFromEditorPosition(originalValue, range.end);
    const context = this.captureActiveEditor(editor);
    if (!context) return;

    try {
      const title = await this.resolveTitle(url);
      const replacement = resolvedTitleReplacement(
        title ?? "",
        url,
        this.settings.maximumTitleLength,
      );
      if (!replacement) {
        this.showUnavailableNotice();
        return;
      }
      const currentValue = editor.getValue();
      if (!this.isSameActiveEditor(context) || currentValue !== originalValue)
        return;
      const originalText = originalValue.slice(startIndex, endIndex);
      const safeRange = safeReplacementRange(
        currentValue,
        originalValue,
        startIndex,
        originalText,
      );
      if (!safeRange || safeRange.end !== endIndex) return;
      editor.replaceRange(
        replacement,
        getEditorPositionFromIndex(currentValue, safeRange.start),
        getEditorPositionFromIndex(currentValue, safeRange.end),
      );
    } catch (error) {
      this.showLookupError(error);
    }
  }

  getUrlFromLink(link: string): string | null {
    const match = /^\[[^\]]*\]\((?:<)?([^\s<>]+)(?:>)?\)$/.exec(link);
    return match ? normalizeWebUrl(match[1]) : null;
  }

  async loadSettings(): Promise<void> {
    this.settings = sanitizeSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    this.settings = sanitizeSettings(this.settings);
    await this.saveData({ ...this.settings });
  }

  getResolverStatus(): ResolverStatusSnapshot {
    return { ...this.resolverStatus };
  }

  async checkBrowserConnection(): Promise<boolean> {
    return this.createBridgeClient().ping();
  }

  private async insertUrlThenResolve(
    editor: Editor,
    url: string,
  ): Promise<void> {
    if (this.isBlacklisted(url)) {
      const hostname = new URL(url).hostname;
      editor.replaceSelection(formatMarkdownLink(hostname, url));
      return;
    }

    const originalValue = editor.getValue();
    const startPosition = editor.getCursor("from");
    const startIndex = getIndexFromEditorPosition(originalValue, startPosition);
    const context = this.captureActiveEditor(editor);
    editor.replaceSelection(url);
    const insertedValue = editor.getValue();
    if (!context) return;

    try {
      const title = await this.resolveTitle(url);
      const replacement = resolvedTitleReplacement(
        title ?? "",
        url,
        this.settings.maximumTitleLength,
      );
      if (!replacement) {
        this.showUnavailableNotice();
        return;
      }
      const currentValue = editor.getValue();
      if (!this.isSameActiveEditor(context)) return;
      const range = safeReplacementRange(
        currentValue,
        insertedValue,
        startIndex,
        url,
      );
      if (!range) return;
      editor.replaceRange(
        replacement,
        getEditorPositionFromIndex(currentValue, range.start),
        getEditorPositionFromIndex(currentValue, range.end),
      );
    } catch (error) {
      this.showLookupError(error);
    }
  }

  private captureActiveEditor(editor: Editor): ActiveEditorSnapshot | null {
    const active = this.app.workspace.activeEditor;
    if (active?.editor !== editor) return null;
    return { editor, filePath: active.file?.path ?? null };
  }

  private isSameActiveEditor(snapshot: ActiveEditorSnapshot): boolean {
    const active = this.app.workspace.activeEditor;
    return (
      active?.editor === snapshot.editor &&
      (active.file?.path ?? null) === snapshot.filePath
    );
  }

  private createBridgeClient(): BridgeClient {
    return new BridgeClient(this.settings.channel, this.settings.timeoutMs);
  }

  private async resolveTitle(url: string): Promise<string | null> {
    const result = await resolveTitleWithFallback(url, {
      browserTitle: (requestedUrl) =>
        this.createBridgeClient().resolveTitle(requestedUrl),
      legacyTitle: resolveLegacyTitle,
      fallbackEnabled: this.settings.legacyFallbackEnabled,
      timeoutMs: this.settings.timeoutMs,
      onStatus: (status) => {
        this.resolverStatus = { ...status };
      },
    });
    return result?.title ?? null;
  }

  private isBlacklisted(url: string): boolean {
    const lowerUrl = url.toLowerCase();
    return this.settings.websiteBlacklist
      .split(/,|\n/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .some((entry) => lowerUrl.includes(entry));
  }

  private async readClipboardText(): Promise<string | null> {
    try {
      return await navigator.clipboard.readText();
    } catch {
      new Notice("Could not read clipboard text.");
      return null;
    }
  }

  private showUnavailableNotice(): void {
    new Notice(
      "No page title was available. The original URL was left unchanged.",
    );
  }

  private showLookupError(error: unknown): void {
    if (!(error instanceof BridgeClientError)) {
      new Notice("Title lookup failed. The original URL was left unchanged.");
      return;
    }

    if (error.kind === "timeout") {
      new Notice(
        "Browser title lookup timed out. The original URL was left unchanged.",
      );
      return;
    }
    if (error.kind === "unavailable") {
      new Notice(
        "Browser title bridge is unavailable. The original URL was left unchanged.",
      );
      return;
    }
    if (error.kind === "authentication") {
      new Notice(
        "Browser profile authentication failed. Open the page in your browser and try again.",
      );
      return;
    }
    if (error.kind === "remote") {
      new Notice(remoteNotice(error.remoteCode));
      return;
    }
    new Notice(
      "Browser title lookup failed. The original URL was left unchanged.",
    );
  }
}

function remoteNotice(code?: ErrorCode): string {
  switch (code) {
    case "AUTH_REQUIRED":
    case "AUTHENTICATION_FAILED":
    case "FORBIDDEN":
      return "Open the page in your browser profile and allow title access, then try again.";
    case "HOST_PERMISSION_REQUIRED":
      return "Allow the browser extension to access the page, then try again.";
    case "PROFILE_IN_USE":
      return "The browser profile is busy. Try again when it is available.";
    case "TIMEOUT":
      return "Browser title lookup timed out. The original URL was left unchanged.";
    case "TITLE_UNAVAILABLE":
    case "UNSUPPORTED":
      return "No page title was available. The original URL was left unchanged.";
    case "CANCELLED":
      return "Browser title lookup was cancelled. The original URL was left unchanged.";
    default:
      return "Browser title lookup failed. The original URL was left unchanged.";
  }
}

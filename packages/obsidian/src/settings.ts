import type BrowserProfileLinkTitle from "./main";
import { validChannel } from "@chlrc/browser-profile-title-protocol";
import { PluginSettingTab, Setting, type App } from "obsidian";
import { MAX_TIMEOUT_MS } from "@chlrc/browser-profile-title-protocol";

export { DEFAULT_SETTINGS, sanitizeSettings } from "./settings-model";
export type { BrowserProfileTitleSettings } from "./settings-model";

export class BrowserProfileTitleSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: BrowserProfileLinkTitle,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Browser bridge channel")
      .setDesc(
        "The local browser-profile bridge channel. Use the same channel as the bridge.",
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.channel)
          .setPlaceholder("default")
          .onChange(async (value) => {
            const channel = value.trim();
            if (!validChannel(channel)) return;
            this.plugin.settings.channel = channel;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Title lookup timeout")
      .setDesc("Wait time in milliseconds, from 100 to 30000.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.timeoutMs))
          .onChange(async (value) => {
            const timeout = Number(value);
            if (
              !Number.isInteger(timeout) ||
              timeout < 100 ||
              timeout > MAX_TIMEOUT_MS
            )
              return;
            this.plugin.settings.timeoutMs = timeout;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Enhance default paste")
      .setDesc("Resolve a page title when pasting a web link into the editor.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enhanceDefaultPaste)
          .onChange(async (value) => {
            this.plugin.settings.enhanceDefaultPaste = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Enhance drop events")
      .setDesc("Resolve a page title when dropping a web link into the editor.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enhanceDropEvents)
          .onChange(async (value) => {
            this.plugin.settings.enhanceDropEvents = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Preserve selected text as title")
      .setDesc(
        "Use selected text as the link label when pasting a URL over it.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.shouldPreserveSelectionAsTitle)
          .onChange(async (value) => {
            this.plugin.settings.shouldPreserveSelectionAsTitle = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Maximum title length")
      .setDesc(
        "Set to 0 to keep the full title. The maximum is 2000 characters.",
      )
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maximumTitleLength))
          .onChange(async (value) => {
            const length = Number(value);
            if (!Number.isInteger(length) || length < 0 || length > 2000)
              return;
            this.plugin.settings.maximumTitleLength = length;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Website blacklist")
      .setDesc(
        "Comma-separated text that disables automatic title lookup for matching links.",
      )
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.websiteBlacklist)
          .setPlaceholder("localhost, example.internal")
          .onChange(async (value) => {
            this.plugin.settings.websiteBlacklist = value.slice(0, 4096);
            await this.plugin.saveSettings();
          }),
      );
  }
}

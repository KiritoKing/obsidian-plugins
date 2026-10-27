import type BrowserProfileLinkTitle from "./main";
import { validChannel } from "@chlrc/browser-profile-title-protocol";
import {
  ButtonComponent,
  PluginSettingTab,
  Setting,
  setIcon,
  type App,
} from "obsidian";
import { MAX_TIMEOUT_MS } from "@chlrc/browser-profile-title-protocol";

export { DEFAULT_SETTINGS, sanitizeSettings } from "./settings-model";
export type { BrowserProfileTitleSettings } from "./settings-model";

export class BrowserProfileTitleSettingTab extends PluginSettingTab {
  private displayGeneration = 0;

  constructor(
    app: App,
    private readonly plugin: BrowserProfileLinkTitle,
  ) {
    super(app, plugin);
  }

  display(): void {
    const generation = ++this.displayGeneration;
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("bplt-settings");

    const hero = containerEl.createDiv({ cls: "bplt-hero" });
    const heroIcon = hero.createDiv({ cls: "bplt-hero-icon" });
    setIcon(heroIcon, "link-2");
    const heading = hero.createDiv();
    heading.createDiv({
      cls: "bplt-eyebrow",
      text: "YOUR LINKS, MADE READABLE",
    });
    heading.createEl("h2", { text: "Browser Profile Link Title" });
    heading.createEl("p", {
      text: "Browser first. The original scraper helps when a browser lookup misses.",
    });

    const connection = this.card(
      "Browser connection",
      "Use the same profile channel as the Chrome extension.",
      "chrome",
    );
    const connectionBar = connection.createDiv({ cls: "bplt-status-bar" });
    const browserBadge = connectionBar.createSpan({ cls: "bplt-badge" });
    browserBadge.setAttribute("role", "status");
    browserBadge.setAttribute("aria-live", "polite");
    const connectionHelp = connection.createEl("p", { cls: "bplt-help" });
    const lastLookup = connection.createDiv({ cls: "bplt-last-lookup" });
    const renderLastLookup = (): void => {
      const status = this.plugin.getResolverStatus();
      lastLookup.empty();
      lastLookup.createSpan({ cls: "bplt-small-label", text: "LAST LOOKUP" });
      lastLookup.createSpan({ text: status.message });
      lastLookup.setAttribute("data-route", status.route);
    };
    let checking = false;
    const checkButton = new ButtonComponent(connectionBar)
      .setButtonText("Check connection")
      .setTooltip("Check the browser profile without opening a page");
    const checkConnection = async (): Promise<void> => {
      if (checking) return;
      checking = true;
      const checkedChannel = this.plugin.settings.channel;
      browserBadge.setText("Checking…");
      browserBadge.setAttribute("data-state", "checking");
      connectionHelp.setText("Checking your browser connection…");
      checkButton.setDisabled(true);
      let connected = false;
      try {
        connected = await this.plugin.checkBrowserConnection();
      } catch {
        // Keep raw errors and local connection details out of the interface.
      }
      if (generation !== this.displayGeneration) return;
      checking = false;
      checkButton.setDisabled(false);
      if (checkedChannel !== this.plugin.settings.channel) {
        browserBadge.setText("Profile changed");
        browserBadge.setAttribute("data-state", "offline");
        connectionHelp.setText(
          "Check the connection again for this profile channel.",
        );
        return;
      }
      browserBadge.setText(connected ? "Connected" : "Not connected");
      browserBadge.setAttribute(
        "data-state",
        connected ? "connected" : "offline",
      );
      connectionHelp.setText(
        connected
          ? `Ready on channel “${checkedChannel}”. Manage website access from the Chrome popup.`
          : this.plugin.settings.legacyFallbackEnabled
            ? "Connect the Chrome extension for signed-in pages. The original scraper will handle browser misses."
            : "Connect the Chrome extension, or turn on the original scraper fallback below.",
      );
      renderLastLookup();
    };
    checkButton.onClick(() => void checkConnection());

    new Setting(connection)
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

    const fallback = this.card(
      "A fallback when you need it",
      "If neither path finds a title, your original link stays intact.",
      "route",
    );
    const flow = fallback.createDiv({ cls: "bplt-flow" });
    flow.createSpan({ text: "Browser profile" });
    flow
      .createSpan({ cls: "bplt-flow-arrow", text: "→" })
      .setAttribute("aria-hidden", "true");
    const fallbackStep = flow.createSpan({ text: "Original scraper" });
    const renderFallbackStep = (): void => {
      fallbackStep.setAttribute(
        "data-enabled",
        String(this.plugin.settings.legacyFallbackEnabled),
      );
    };
    renderFallbackStep();
    new Setting(fallback)
      .setName("Use original scraper as fallback")
      .setDesc(
        "Try it when a site is not approved, Chrome is disconnected, or a browser lookup fails.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.legacyFallbackEnabled)
          .onChange(async (value) => {
            this.plugin.settings.legacyFallbackEnabled = value;
            await this.plugin.saveSettings();
            renderFallbackStep();
          }),
      );
    fallback.createEl("p", {
      cls: "bplt-help bplt-help-inset",
      text: "The fallback uses its own page request. Signed-in websites may still need Grant this site in the Chrome popup.",
    });

    const editor = this.card(
      "Make links feel natural",
      "Choose when titles are added to your notes.",
      "text-cursor-input",
    );
    const advanced = containerEl.createEl("details", { cls: "bplt-advanced" });
    advanced.createEl("summary", { text: "Fine-tune your links" });
    const advancedBody = advanced.createDiv({ cls: "bplt-advanced-body" });
    new Setting(advancedBody)
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

    new Setting(editor)
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

    new Setting(editor)
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

    new Setting(editor)
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

    new Setting(advancedBody)
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

    new Setting(advancedBody)
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

    containerEl.createEl("p", {
      cls: "bplt-footer",
      text: "Website access is managed in Chrome → Browser Profile Title Bridge. Grant access one site at a time.",
    });
    containerEl
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "input:not([aria-label]), textarea:not([aria-label])",
      )
      .forEach((input) => {
        const name = input
          .closest(".setting-item")
          ?.querySelector(".setting-item-name")?.textContent;
        if (name) input.setAttribute("aria-label", name);
      });
    renderLastLookup();
    void checkConnection();
  }

  hide(): void {
    this.displayGeneration += 1;
  }

  private card(title: string, description: string, icon: string): HTMLElement {
    const card = this.containerEl.createDiv({ cls: "bplt-card" });
    const header = card.createDiv({ cls: "bplt-card-heading" });
    const iconEl = header.createSpan({ cls: "bplt-card-icon" });
    iconEl.setAttribute("aria-hidden", "true");
    setIcon(iconEl, icon);
    const copy = header.createDiv();
    copy.createEl("h3", { text: title });
    copy.createEl("p", { text: description });
    return card;
  }
}

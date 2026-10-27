import { EXTENSION_PUBLIC_KEY } from "@chlrc/browser-profile-title-protocol/identity";
import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Browser Profile Title Bridge",
    description:
      "Read page titles from this Chrome profile for the local Obsidian bridge.",
    key: EXTENSION_PUBLIC_KEY,
    icons: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
    action: {
      default_icon: {
        16: "icons/icon-16.png",
        32: "icons/icon-32.png",
        48: "icons/icon-48.png",
        128: "icons/icon-128.png",
      },
    },
    permissions: ["activeTab", "nativeMessaging", "scripting", "storage"],
    optional_host_permissions: ["http://*/*", "https://*/*"],
  },
});

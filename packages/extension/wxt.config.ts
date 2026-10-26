import { EXTENSION_PUBLIC_KEY } from "@chlrc/browser-profile-title-protocol/identity";
import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Browser Profile Title Bridge",
    description:
      "Read page titles from this Chrome profile for the local Obsidian bridge.",
    key: EXTENSION_PUBLIC_KEY,
    permissions: ["activeTab", "nativeMessaging", "scripting", "storage"],
    optional_host_permissions: ["http://*/*", "https://*/*"],
  },
});

import { isRecord } from "@chlrc/browser-profile-title-protocol";
import { NativeConnectionController } from "../src/native-connection";
import { isExactOriginPattern } from "../src/site-consent";

export default defineBackground(() => {
  const connection = new NativeConnectionController();

  chrome.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse) => {
      if (!isRecord(message) || typeof message.type !== "string") return false;
      if (
        message.type === "site-consent-revoked" &&
        sender.id === chrome.runtime.id &&
        isExactOriginPattern(message.origin)
      ) {
        connection.siteConsentRevoked(message.origin);
        sendResponse({ ok: true });
        return false;
      }
      if (message.type === "get-connection-state") {
        sendResponse(connection.getState());
        return false;
      }
      if (message.type === "reconnect") {
        void connection
          .reconnect()
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ ok: false }));
        return true;
      }
      if (message.type === "disconnect") {
        connection.disconnect();
        sendResponse({ ok: true });
        return false;
      }
      if (message.type === "set-channel") {
        void connection
          .setChannel(message.channel)
          .then((ok) => sendResponse({ ok }))
          .catch(() => sendResponse({ ok: false }));
        return true;
      }
      return false;
    },
  );

  chrome.permissions.onRemoved.addListener((removed) => {
    connection.permissionsRemoved(removed.origins ?? []);
  });

  connection.start();
});

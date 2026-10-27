import { RELEASE_EXTENSION_ID } from "./release-identity.ts";

// Public key only; no private key is exported or stored.
export const EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAox7gH6n+dikdzFRTFQZATMrTN1VoXJh9lqM/n6MAIc/G3FpWY9aPX6HN+lfnWEz6p+8XmHEMT0lATO4ioilE2qfvDgUK3jt9ps/m2NTT045+b/l9QeYsTO7us08fJ/dFxtpS6ky7es9j+Y7SI6KBrtaRS0NJ2Id7lrNFKG8OvQtFytVhhuTwGITmg2Ut0TE+6SZqU+YlEWA95Hz4nKdIKOvNZtZghBZHdm4YhoBsRLXUebefZjA3V26pr26e8uaTDeREmJm55wCt6SSIT9WCUBsNKQgghaC/hIU9IRnh39v7vORgMnXnhGRp7hA0/yh7F3V60jhN1cYjo0nu+Z/bqQIDAQAB";
export const EXTENSION_ID = "ligookeeainjhapkanfmgabeenmeljbn";

export {
  RELEASE_EXTENSION_ID,
  RELEASE_EXTENSION_PUBLIC_KEY,
} from "./release-identity.ts";

export const SUPPORTED_EXTENSION_IDS = [
  EXTENSION_ID,
  RELEASE_EXTENSION_ID,
] as const;
export type SupportedExtensionId = (typeof SUPPORTED_EXTENSION_IDS)[number];

export const DEVELOPMENT_NATIVE_MESSAGING_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
export const RELEASE_NATIVE_MESSAGING_ORIGIN = `chrome-extension://${RELEASE_EXTENSION_ID}/`;
export const SUPPORTED_NATIVE_MESSAGING_ORIGINS = [
  DEVELOPMENT_NATIVE_MESSAGING_ORIGIN,
  RELEASE_NATIVE_MESSAGING_ORIGIN,
] as const;

export function isSupportedExtensionId(
  value: unknown,
): value is SupportedExtensionId {
  return (
    typeof value === "string" &&
    (value === EXTENSION_ID || value === RELEASE_EXTENSION_ID)
  );
}

export function nativeMessagingOriginForExtensionId(
  value: unknown,
): string | undefined {
  if (!isSupportedExtensionId(value)) return undefined;
  return `chrome-extension://${value}/`;
}

export function extensionIdFromNativeMessagingOrigin(
  value: unknown,
): SupportedExtensionId | undefined {
  if (typeof value !== "string") return undefined;
  return SUPPORTED_EXTENSION_IDS.find(
    (extensionId) => nativeMessagingOriginForExtensionId(extensionId) === value,
  );
}

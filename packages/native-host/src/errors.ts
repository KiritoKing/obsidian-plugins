import type { ErrorCode } from "@chlrc/browser-profile-title-protocol";

export const SAFE_ERROR_MESSAGES: Record<ErrorCode, string> = {
  AUTH_REQUIRED: "Authentication is required.",
  HOST_PERMISSION_REQUIRED: "Browser permission is required.",
  FORBIDDEN: "The request is not allowed.",
  TIMEOUT: "The browser title request timed out.",
  UNSUPPORTED: "This host setup is not supported on this system.",
  BRIDGE_UNAVAILABLE: "The browser bridge is unavailable.",
  CANCELLED: "The browser title request was cancelled.",
  INVALID_REQUEST: "The request is invalid.",
  AUTHENTICATION_FAILED: "Authentication failed.",
  PROFILE_IN_USE: "This browser profile is already connected.",
  TITLE_UNAVAILABLE: "The page title is unavailable.",
};

export const LONG_SOCKET_PATH_MESSAGE =
  "The local socket path is too long; choose a shorter state directory.";

import { isIP } from "node:net";

export function validateOptionalUrl(name: string, value: string): string {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return "";
  }
  return validateRequiredUrl(name, trimmedValue);
}

export function validateRequiredUrl(name: string, value: string): string {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    throw new Error(`${name} must not be empty`);
  }

  try {
    void new URL(trimmedValue);
    return trimmedValue;
  } catch {
    throw new Error(`${name} must be a valid URL, received "${value}"`);
  }
}

export function validateConnectOrigin(value: string): string {
  const message =
    "BB_CONNECT_ORIGIN must be an HTTPS relay origin (<handle>.<connect-domain>), or HTTP for a local <handle>.bb.localhost origin";
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(message);
  }
  const labels = url.hostname.split(".");
  const local = url.hostname.endsWith(".localhost");
  if (
    isIP(url.hostname) !== 0 ||
    labels.length < 3 ||
    labels.some((label) => label.length === 0) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname.indexOf(".") <= 0 ||
    url.protocol !== (local ? "http:" : "https:")
  ) {
    throw new Error(message);
  }
  return url.origin;
}

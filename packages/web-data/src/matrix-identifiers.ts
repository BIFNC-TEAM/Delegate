import { isIP } from "node:net";

export function normalizeMatrixUserId(value: string): string {
  return normalizeMatrixIdentifier(value, "@", "Matrix user id");
}

export function normalizeMatrixRoomId(value: string): string {
  return normalizeMatrixIdentifier(value, "!", "Matrix room id");
}

export function matrixServerNameFromUserId(value: string): string {
  return matrixServerNameFromIdentifier(
    normalizeMatrixUserId(value),
    "Matrix user id",
  );
}

export function normalizeMatrixServerName(value: string): string {
  const serverName = value.trim();
  if (!isValidMatrixServerName(serverName)) {
    throw new Error("Matrix server name is invalid.");
  }
  return serverName;
}

function normalizeMatrixIdentifier(
  value: string,
  sigil: "@" | "!",
  label: string,
): string {
  const identifier = value.trim();
  const separator = identifier.indexOf(":", 1);
  const localpart =
    separator > 1 ? identifier.slice(1, separator) : "";
  const serverName =
    separator > 1 ? identifier.slice(separator + 1) : "";
  if (
    identifier[0] !== sigil
    || !localpart
    || /\s|:/.test(localpart)
    || !isValidMatrixServerName(serverName)
    || Buffer.byteLength(identifier, "utf8") > 255
  ) {
    throw new Error(
      sigil === "@"
        ? `${label} must be a full MXID.`
        : `${label} must be a full room id.`,
    );
  }
  return `${sigil}${localpart}:${serverName}`;
}

export function isValidMatrixServerName(value: string): boolean {
  if (!value || value.length > 255 || /\s/.test(value)) return false;

  let host = value;
  let port: string | undefined;
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]");
    if (closingBracket <= 1) return false;
    host = value.slice(1, closingBracket);
    const suffix = value.slice(closingBracket + 1);
    if (suffix) {
      if (!suffix.startsWith(":")) return false;
      port = suffix.slice(1);
    }
    if (isIP(host) !== 6) return false;
  } else {
    const separator = value.lastIndexOf(":");
    if (separator !== -1) {
      if (value.indexOf(":") !== separator) return false;
      host = value.slice(0, separator);
      port = value.slice(separator + 1);
    }
    if (!host) return false;
    if (isIP(host) !== 4 && !isValidDnsName(host)) return false;
  }

  return port === undefined
    || (/^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65_535);
}

function matrixServerNameFromIdentifier(
  identifier: string,
  label: string,
): string {
  const separator = identifier.indexOf(":", 1);
  if (separator <= 1 || separator === identifier.length - 1) {
    throw new Error(`${label} must be a full MXID.`);
  }
  return identifier.slice(separator + 1);
}

function isValidDnsName(value: string): boolean {
  if (value.length > 255 || /^\d+(?:\.\d+){3}$/.test(value)) return false;
  return value.split(".").every(
    (label) =>
      label.length > 0
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

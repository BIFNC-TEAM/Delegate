import {
  chmodSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

export const requiredAuthAppKeys = [
  "LOGTO_DASHBOARD_APP_ID",
  "LOGTO_DASHBOARD_APP_SECRET",
  "LOGTO_REPS_APP_ID",
  "LOGTO_REPS_APP_SECRET",
  "LOGTO_WEBHOOK_SIGNING_KEY",
  "LOGTO_MANAGEMENT_APP_ID",
  "LOGTO_MANAGEMENT_APP_SECRET",
];

export function parseAuthApps(source) {
  const values = new Map();
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
    if (!match) continue;
    const [, key, raw] = match;
    const trimmed = raw.trim();
    let value = trimmed;
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        value = "";
      }
    } else if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      value = trimmed.slice(1, -1);
    }
    values.set(key, value);
  }

  return Object.fromEntries(values);
}

export function serializeAuthApps(values) {
  return `${requiredAuthAppKeys.map((key) => {
    const value = String(values[key] ?? "");
    if (!value || /[\s\0"'\\]/u.test(value)) {
      throw new Error(`Invalid Docker env_file value for ${key}`);
    }
    return `${key}=${value}`;
  }).join("\n")}\n`;
}

export function validateAuthApps(source) {
  const values = parseAuthApps(source);
  const missing = requiredAuthAppKeys.filter((key) => {
    const value = values[key];
    return typeof value !== "string" || !value.trim() || /[\r\n]/u.test(value);
  });
  if (missing.length > 0) {
    throw new Error(`Incomplete Logto application bootstrap; missing ${missing.join(", ")}`);
  }

  const rawValues = Object.fromEntries(
    source.split(/\r?\n/u).flatMap((line) => {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
      return match ? [[match[1], match[2]]] : [];
    }),
  );
  const quoted = requiredAuthAppKeys.filter((key) => {
    const value = rawValues[key];
    return typeof value === "string"
      && (/^['"]/u.test(value) || /['"]$/u.test(value));
  });
  if (quoted.length > 0) {
    throw new Error(
      `Docker env_file values must be unquoted; quoted ${quoted.join(", ")}`,
    );
  }

  return values;
}

const isMain = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isMain) {
  const normalize = process.argv[2] === "--normalize";
  const envPath = process.argv[normalize ? 3 : 2]
    ?? "/home/ubuntu/delegate/shared/env/auth-apps.env";
  const source = readFileSync(envPath, "utf8");
  if (normalize) {
    const normalized = serializeAuthApps(parseAuthApps(source));
    validateAuthApps(normalized);
    const temporaryPath = `${envPath}.tmp-${process.pid}`;
    writeFileSync(temporaryPath, normalized, { mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, envPath);
    chmodSync(envPath, 0o600);
    console.log(`auth-apps: normalized (${requiredAuthAppKeys.length} entries)`);
  } else {
    validateAuthApps(source);
    console.log(`auth-apps: ready (${requiredAuthAppKeys.length} required entries set)`);
  }
}

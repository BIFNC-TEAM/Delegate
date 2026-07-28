import type { TelegramBotRuntimeConfig } from "./telegram-bot-runtime";

const defaultReconcileIntervalMs = 5_000;
const defaultLeaseDurationMs = 120_000;
const defaultLeaseRenewIntervalMs = 20_000;
const defaultLeaseOperationTimeoutMs = 10_000;
const maximumTelegramApiTimeoutMs = 60_000;

export type TelegramSupervisorLeaseTiming = {
  leaseDurationMs: number;
  renewIntervalMs: number;
  operationTimeoutMs: number;
};

export function legacyRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
): TelegramBotRuntimeConfig | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;
  const tokenBotId = token.match(/^([1-9]\d*):/)?.[1];
  const configuredBotId = env.TELEGRAM_BOT_ID?.trim();
  if (
    !tokenBotId
    || (configuredBotId && configuredBotId !== tokenBotId)
  ) {
    throw new Error(
      "Legacy TELEGRAM_BOT_ID must match the numeric Bot token prefix.",
    );
  }
  const username =
    env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  return {
    internalConnectionId: `legacy:${tokenBotId}`,
    botId: tokenBotId,
    ...(username ? { username } : {}),
    token,
    credentialRevision: 1,
    legacy: true,
  };
}

export function isSameTelegramRuntimeRevision(
  current: Pick<
    TelegramBotRuntimeConfig,
    "botId" | "credentialRevision" | "legacy"
  >,
  desired: Pick<
    TelegramBotRuntimeConfig,
    "botId" | "credentialRevision" | "legacy"
  >,
) {
  return (
    current.botId === desired.botId
    && current.credentialRevision === desired.credentialRevision
    && current.legacy === desired.legacy
  );
}

export function resolveReconcileIntervalMs(
  env: Readonly<Record<string, string | undefined>>,
) {
  const raw =
    env.TELEGRAM_RUNTIME_RECONCILE_MS?.trim()
    || String(defaultReconcileIntervalMs);
  const intervalMs = Number(raw);
  if (
    !Number.isInteger(intervalMs)
    || intervalMs < 1_000
    || intervalMs > 60_000
  ) {
    throw new Error(
      "TELEGRAM_RUNTIME_RECONCILE_MS must be an integer between 1000 and 60000.",
    );
  }
  return intervalMs;
}

export function resolveTelegramSupervisorLeaseTiming(
  env: Readonly<Record<string, string | undefined>>,
): TelegramSupervisorLeaseTiming {
  const leaseDurationMs = readBoundedInteger(
    env.TELEGRAM_RUNTIME_LEASE_MS,
    defaultLeaseDurationMs,
    60_000,
    15 * 60_000,
    "TELEGRAM_RUNTIME_LEASE_MS",
  );
  const renewIntervalMs = readBoundedInteger(
    env.TELEGRAM_RUNTIME_LEASE_RENEW_MS,
    defaultLeaseRenewIntervalMs,
    5_000,
    60_000,
    "TELEGRAM_RUNTIME_LEASE_RENEW_MS",
  );
  const operationTimeoutMs = readBoundedInteger(
    env.TELEGRAM_RUNTIME_LEASE_DB_TIMEOUT_MS,
    defaultLeaseOperationTimeoutMs,
    1_000,
    30_000,
    "TELEGRAM_RUNTIME_LEASE_DB_TIMEOUT_MS",
  );
  if (
    renewIntervalMs
    + operationTimeoutMs
    + maximumTelegramApiTimeoutMs
    > leaseDurationMs
  ) {
    throw new Error(
      "Telegram runtime lease timing must leave at least one maximum Telegram API timeout between a failed heartbeat and lease expiry.",
    );
  }
  return {
    leaseDurationMs,
    renewIntervalMs,
    operationTimeoutMs,
  };
}

function readBoundedInteger(
  rawValue: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  name: string,
) {
  const value = Number(rawValue?.trim() || String(defaultValue));
  if (
    !Number.isInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

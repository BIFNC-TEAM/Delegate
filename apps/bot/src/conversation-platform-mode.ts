import { ChannelUnavailableError } from "@delegate/web-data";

export type TelegramConversationPlatformMode = "legacy" | "shadow" | "worker";

export function resolveTelegramConversationPlatformMode(
  env: Record<string, string | undefined> = process.env,
): TelegramConversationPlatformMode {
  const configuredMode =
    env.TELEGRAM_CONVERSATION_PLATFORM_MODE?.trim().toLowerCase() || "worker";
  if (
    configuredMode !== "legacy"
    && configuredMode !== "shadow"
    && configuredMode !== "worker"
  ) {
    throw new Error(
      `Unsupported TELEGRAM_CONVERSATION_PLATFORM_MODE "${configuredMode}".`,
    );
  }
  if (env.NODE_ENV === "production" && configuredMode !== "worker") {
    throw new Error(
      "Production Telegram traffic must use TELEGRAM_CONVERSATION_PLATFORM_MODE=worker.",
    );
  }
  return configuredMode;
}

export function assertTelegramPaidFlowUsesUnifiedRuntime(
  mode: TelegramConversationPlatformMode,
  env: Record<string, string | undefined> = process.env,
) {
  if (mode !== "worker") {
    throw new Error(
      "Telegram purchases are disabled until the unified conversation worker owns this channel.",
    );
  }
  assertTelegramStarsLivePaymentEnabled(env);
}

export function isTelegramPaidFlowAvailable(
  mode: TelegramConversationPlatformMode,
  env: Record<string, string | undefined> = process.env,
): boolean {
  try {
    assertTelegramPaidFlowUsesUnifiedRuntime(mode, env);
    return true;
  } catch {
    return false;
  }
}

export function assertTelegramStarsLivePaymentEnabled(
  env: Record<string, string | undefined> = process.env,
) {
  if (env.TELEGRAM_STARS_LIVE_ENABLED?.trim().toLowerCase() !== "true") {
    throw new Error(
      "Telegram Stars purchases are disabled by the release gate.",
    );
  }
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Production Telegram Stars remain disabled until durable webhook ingress is implemented.",
    );
  }
}

export function shouldFailClosedAfterConversationPlatformWrite(
  mode: TelegramConversationPlatformMode,
  error: unknown,
) {
  return mode === "worker" || error instanceof ChannelUnavailableError;
}

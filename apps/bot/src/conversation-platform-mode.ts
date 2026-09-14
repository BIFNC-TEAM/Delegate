export type TelegramConversationPlatformMode = "legacy" | "shadow" | "worker";

export function resolveTelegramConversationPlatformMode(
  env: Record<string, string | undefined> = process.env,
): TelegramConversationPlatformMode {
  const configuredMode =
    env.TELEGRAM_CONVERSATION_PLATFORM_MODE?.trim().toLowerCase() || "worker";
  if (
    configuredMode !== "worker"
  ) {
    throw new Error(
      `TELEGRAM_CONVERSATION_PLATFORM_MODE must be worker; legacy and shadow ownership are retired.`,
    );
  }
  return configuredMode;
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
  void mode;
  void error;
  return true;
}

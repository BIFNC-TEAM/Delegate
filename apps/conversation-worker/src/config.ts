import { z } from "zod";

import {
  resolveModelRuntimeEnv,
  resolveProviderAttemptOrder,
  type ModelProvider,
  type ModelRuntimeState,
} from "@delegate/model-runtime";

const defaultOutboxProcessingLeaseMs = 5 * 60_000;
const minimumOutboxProcessingLeaseMs = defaultOutboxProcessingLeaseMs;

const configSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pollMs: z.number().int().min(100).max(60_000),
  matrixHomeserverUrl: z.string().url().optional(),
  matrixApplicationServiceToken: z.string().min(24).optional(),
  telegramBotToken: z.string().min(20).optional(),
  telegramConversationPlatformMode: z.enum(["legacy", "shadow", "worker"]).optional(),
  telegramRequestTimeoutMs: z.number().int().min(1_000).max(60_000).optional(),
  outboxProcessingLeaseMs: z.number().int()
    .min(minimumOutboxProcessingLeaseMs)
    .max(24 * 60 * 60_000)
    .optional(),
});

export type ConversationWorkerConfig = z.infer<typeof configSchema>;

export type ConversationWorkerModelReadiness = {
  state: ModelRuntimeState;
  configuredProvider: ModelProvider | "unsupported";
  fallbackProvider?: ModelProvider | "unsupported";
  readyProviders: ModelProvider[];
};

function sanitizeModelProvider(provider: string): ModelProvider | "unsupported" {
  return provider === "openai" || provider === "bailian" || provider === "anthropic"
    ? provider
    : "unsupported";
}

export function resolveConversationWorkerModelReadiness(
  env: Record<string, string | undefined> = process.env,
): ConversationWorkerModelReadiness {
  const runtime = resolveModelRuntimeEnv(env);

  return {
    state: runtime.state,
    configuredProvider: sanitizeModelProvider(runtime.provider),
    ...(runtime.fallbackProvider
      ? { fallbackProvider: sanitizeModelProvider(runtime.fallbackProvider) }
      : {}),
    readyProviders: resolveProviderAttemptOrder(runtime),
  };
}

export function resolveConversationWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): ConversationWorkerConfig {
  const matrixHomeserverUrl = env.MATRIX_HOMESERVER_URL?.trim() || undefined;
  const matrixApplicationServiceToken = env.MATRIX_AS_TOKEN?.trim() || undefined;
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  const telegramConversationPlatformMode =
    env.TELEGRAM_CONVERSATION_PLATFORM_MODE?.trim().toLowerCase() || "worker";
  if (Boolean(matrixHomeserverUrl) !== Boolean(matrixApplicationServiceToken)) {
    throw new Error("MATRIX_HOMESERVER_URL and MATRIX_AS_TOKEN must be configured together.");
  }
  if (
    env.NODE_ENV === "production"
    && telegramConversationPlatformMode !== "worker"
  ) {
    throw new Error(
      "Production Telegram traffic must use TELEGRAM_CONVERSATION_PLATFORM_MODE=worker.",
    );
  }

  return configSchema.parse({
    port: Number(env.CONVERSATION_WORKER_PORT || 4040),
    pollMs: Number(env.CONVERSATION_WORKER_POLL_MS || 500),
    ...(matrixHomeserverUrl ? { matrixHomeserverUrl } : {}),
    ...(matrixApplicationServiceToken ? { matrixApplicationServiceToken } : {}),
    ...(telegramBotToken ? { telegramBotToken } : {}),
    telegramConversationPlatformMode,
    telegramRequestTimeoutMs: Number(env.TELEGRAM_REQUEST_TIMEOUT_MS || 15_000),
    outboxProcessingLeaseMs: Number(
      env.CONVERSATION_OUTBOX_PROCESSING_LEASE_MS || defaultOutboxProcessingLeaseMs,
    ),
  });
}

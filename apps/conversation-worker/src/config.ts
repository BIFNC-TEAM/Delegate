import { z } from "zod";

import {
  resolveModelRuntimeEnv,
  resolveProviderAttemptOrder,
  type ModelProvider,
  type ModelRuntimeState,
} from "@delegate/model-runtime";

const defaultOutboxProcessingLeaseMs = 5 * 60_000;
const minimumOutboxProcessingLeaseMs = defaultOutboxProcessingLeaseMs;
const defaultMemoryTickTimeoutMs = 60_000;
const defaultReadinessStaleMs = 3 * 60_000;

export const conversationWorkerMemoryLoopDefaults = {
  memoryLifecyclePollMs: 1_000,
  memoryProjectionPollMs: 500,
  memoryCleanupPollMs: 1_000,
  memoryReconciliationPollMs: 60_000,
  memoryTickTimeoutMs: defaultMemoryTickTimeoutMs,
  readinessStaleMs: defaultReadinessStaleMs,
} as const;

const configSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pollMs: z.number().int().min(100).max(60_000),
  memoryLifecyclePollMs: z.number().int().min(100).max(60_000),
  memoryProjectionPollMs: z.number().int().min(100).max(60_000),
  memoryCleanupPollMs: z.number().int().min(100).max(60_000),
  memoryReconciliationPollMs: z.number().int().min(1_000).max(60 * 60_000),
  memoryTickTimeoutMs: z.number().int().min(1_000).max(15 * 60_000),
  readinessStaleMs: z.number().int().min(1_000).max(24 * 60 * 60_000),
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

type ResolvedConversationWorkerConfig = z.infer<typeof configSchema>;
type MemoryLoopConfigKey = keyof typeof conversationWorkerMemoryLoopDefaults;

/**
 * The memory-loop fields are optional for older in-process callers. The env
 * resolver always materializes them; scheduler and health callers apply the
 * same exported defaults when constructing a config directly.
 */
export type ConversationWorkerConfig = Omit<
  ResolvedConversationWorkerConfig,
  MemoryLoopConfigKey
> & Partial<Pick<ResolvedConversationWorkerConfig, MemoryLoopConfigKey>>;

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
  if (
    telegramConversationPlatformMode !== "worker"
    && env.TELEGRAM_CONVERSATION_COMPAT_DIAGNOSTICS_ENABLED?.trim().toLowerCase() !== "true"
  ) {
    throw new Error(
      "Telegram legacy/shadow modes require TELEGRAM_CONVERSATION_COMPAT_DIAGNOSTICS_ENABLED=true and are diagnostics-only.",
    );
  }

  return configSchema.parse({
    port: Number(env.CONVERSATION_WORKER_PORT || 4040),
    pollMs: Number(env.CONVERSATION_WORKER_POLL_MS || 500),
    memoryLifecyclePollMs: Number(
      env.MEMORY_LIFECYCLE_POLL_MS
      || conversationWorkerMemoryLoopDefaults.memoryLifecyclePollMs,
    ),
    memoryProjectionPollMs: Number(
      env.MEMORY_PROJECTION_POLL_MS
      || conversationWorkerMemoryLoopDefaults.memoryProjectionPollMs,
    ),
    memoryCleanupPollMs: Number(
      env.MEMORY_CLEANUP_POLL_MS
      || conversationWorkerMemoryLoopDefaults.memoryCleanupPollMs,
    ),
    memoryReconciliationPollMs: Number(
      env.MEMORY_RECONCILIATION_POLL_MS
      || conversationWorkerMemoryLoopDefaults.memoryReconciliationPollMs,
    ),
    memoryTickTimeoutMs: Number(
      env.MEMORY_WORKER_TICK_TIMEOUT_MS
      || conversationWorkerMemoryLoopDefaults.memoryTickTimeoutMs,
    ),
    readinessStaleMs: Number(
      env.CONVERSATION_WORKER_READINESS_STALE_MS
      || conversationWorkerMemoryLoopDefaults.readinessStaleMs,
    ),
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

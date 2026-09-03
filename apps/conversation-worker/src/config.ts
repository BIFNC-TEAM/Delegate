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
  representativePublicOrigin: z.string().url().optional(),
  matrixApplicationServiceToken: z.string().min(24).optional(),
  telegramBotToken: z.string().min(20).optional(),
  telegramConversationPlatformMode: z.enum(["legacy", "shadow", "worker"]).optional(),
  turnPlannerV2Mode: z.enum(["disabled", "shadow", "active_low_risk"]),
  turnPlannerV3Mode: z.enum(["disabled", "shadow", "active_readonly", "active_governed"]),
  pendingClarificationMode: z.enum(["disabled", "shadow", "active"]),
  telegramRequestTimeoutMs: z.number().int().min(1_000).max(60_000).optional(),
  outboxProcessingLeaseMs: z.number().int()
    .min(minimumOutboxProcessingLeaseMs)
    .max(24 * 60 * 60_000)
    .optional(),
});

type ResolvedConversationWorkerConfig = z.infer<typeof configSchema>;
type MemoryLoopConfigKey = keyof typeof conversationWorkerMemoryLoopDefaults;
type BackwardCompatibleConfigKey = MemoryLoopConfigKey
  | "turnPlannerV2Mode"
  | "turnPlannerV3Mode"
  | "pendingClarificationMode";

/**
 * The memory-loop fields are optional for older in-process callers. The env
 * resolver always materializes them; scheduler and health callers apply the
 * same exported defaults when constructing a config directly.
 */
export type ConversationWorkerConfig = Omit<
  ResolvedConversationWorkerConfig,
  BackwardCompatibleConfigKey
> & Partial<Pick<ResolvedConversationWorkerConfig, BackwardCompatibleConfigKey>>;

export function resolveTurnPlannerRunPolicy(input: {
  turnPlannerV2Mode?: ConversationWorkerConfig["turnPlannerV2Mode"];
  turnPlannerV3Mode?: ConversationWorkerConfig["turnPlannerV3Mode"];
  hasPersistedDelegationRequest: boolean;
}) {
  const v2Mode = input.turnPlannerV2Mode ?? "disabled";
  const v3Mode = input.turnPlannerV3Mode ?? "disabled";
  const v3Active = v3Mode === "active_readonly" || v3Mode === "active_governed";
  return {
    runV2Planner: !v3Active && v2Mode !== "disabled",
    runV3Planner:
      v3Mode !== "disabled" && !input.hasPersistedDelegationRequest,
    allowLegacyDetailedPlanner: !v3Active,
    authoritativeProtocol: v3Active ? 3 as const : 2 as const,
  };
}

export type ConversationWorkerModelReadiness = {
  state: ModelRuntimeState;
  configuredProvider: ModelProvider | "unsupported";
  fallbackProvider?: ModelProvider | "unsupported";
  readyProviders: ModelProvider[];
};

function sanitizeModelProvider(provider: string): ModelProvider | "unsupported" {
  return provider === "agicto"
    || provider === "openai"
    || provider === "bailian"
    || provider === "anthropic"
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
  const representativePublicOrigin = resolveRepresentativePublicOrigin(
    env.NEXT_PUBLIC_REPRESENTATIVE_URL,
    env.NODE_ENV,
  );
  const telegramConversationPlatformMode =
    env.TELEGRAM_CONVERSATION_PLATFORM_MODE?.trim().toLowerCase() || "worker";
  const turnPlannerV3Mode =
    env.TURN_PLAN_V3_MODE?.trim().toLowerCase() || "disabled";
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
    env.NODE_ENV === "production"
    && (turnPlannerV3Mode === "active_readonly" || turnPlannerV3Mode === "active_governed")
    && env.TURN_PLAN_V3_ACTIVE_RELEASE_APPROVED?.trim().toLowerCase() !== "true"
  ) {
    throw new Error(
      "Production V3 active modes require TURN_PLAN_V3_ACTIVE_RELEASE_APPROVED=true after release-gate review.",
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
    ...(representativePublicOrigin ? { representativePublicOrigin } : {}),
    ...(matrixApplicationServiceToken ? { matrixApplicationServiceToken } : {}),
    ...(telegramBotToken ? { telegramBotToken } : {}),
    telegramConversationPlatformMode,
    turnPlannerV2Mode:
      env.TURN_PLANNER_V2_MODE?.trim().toLowerCase() || "shadow",
    turnPlannerV3Mode,
    pendingClarificationMode:
      env.PENDING_CLARIFICATION_MODE?.trim().toLowerCase() || "shadow",
    telegramRequestTimeoutMs: Number(env.TELEGRAM_REQUEST_TIMEOUT_MS || 15_000),
    outboxProcessingLeaseMs: Number(
      env.CONVERSATION_OUTBOX_PROCESSING_LEASE_MS || defaultOutboxProcessingLeaseMs,
    ),
  });
}

function resolveRepresentativePublicOrigin(
  value: string | undefined,
  nodeEnv: string | undefined,
) {
  const configured = value?.trim();
  if (!configured) return undefined;
  const url = new URL(configured);
  const localLoopbackHttp = url.protocol === "http:"
    && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || (
      nodeEnv === "production"
      && url.protocol !== "https:"
      && !localLoopbackHttp
    )
  ) {
    throw new Error(
      "NEXT_PUBLIC_REPRESENTATIVE_URL must be a canonical HTTP(S) origin; production requires HTTPS except for loopback development.",
    );
  }
  return url.origin;
}

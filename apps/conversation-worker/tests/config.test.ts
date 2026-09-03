import { describe, expect, it } from "vitest";

import {
  resolveConversationWorkerConfig,
  resolveConversationWorkerModelReadiness,
  resolveTurnPlannerRunPolicy,
} from "../src/config";

describe("conversation worker config", () => {
  it("runs only V3 in active modes and replays persisted delegation steps", () => {
    expect(resolveTurnPlannerRunPolicy({
      turnPlannerV2Mode: "active_low_risk",
      turnPlannerV3Mode: "active_governed",
      hasPersistedDelegationRequest: false,
    })).toEqual({
      runV2Planner: false,
      runV3Planner: true,
      allowLegacyDetailedPlanner: false,
      authoritativeProtocol: 3,
    });
    expect(resolveTurnPlannerRunPolicy({
      turnPlannerV2Mode: "shadow",
      turnPlannerV3Mode: "active_governed",
      hasPersistedDelegationRequest: true,
    })).toMatchObject({
      runV2Planner: false,
      runV3Planner: false,
      authoritativeProtocol: 3,
    });
  });
  it("allows web-only processing without Matrix credentials", () => {
    expect(resolveConversationWorkerConfig({})).toMatchObject({
      port: 4040,
      pollMs: 500,
      memoryLifecyclePollMs: 1_000,
      memoryProjectionPollMs: 500,
      memoryCleanupPollMs: 1_000,
      memoryReconciliationPollMs: 60_000,
      memoryTickTimeoutMs: 60_000,
      readinessStaleMs: 180_000,
      telegramConversationPlatformMode: "worker",
      turnPlannerV2Mode: "shadow",
      turnPlannerV3Mode: "disabled",
      pendingClarificationMode: "shadow",
      telegramRequestTimeoutMs: 15_000,
      outboxProcessingLeaseMs: 5 * 60_000,
    });
  });

  it("supports disabled, shadow, and active pending clarification rollout", () => {
    expect(resolveConversationWorkerConfig({
      PENDING_CLARIFICATION_MODE: "disabled",
    })).toMatchObject({ pendingClarificationMode: "disabled" });
    expect(resolveConversationWorkerConfig({
      PENDING_CLARIFICATION_MODE: "shadow",
    })).toMatchObject({ pendingClarificationMode: "shadow" });
    expect(resolveConversationWorkerConfig({
      PENDING_CLARIFICATION_MODE: "active",
    })).toMatchObject({ pendingClarificationMode: "active" });
    expect(() => resolveConversationWorkerConfig({
      PENDING_CLARIFICATION_MODE: "invalid",
    })).toThrow();
  });

  it("supports shadow and read-only V3 rollout before governed lanes exist", () => {
    expect(resolveConversationWorkerConfig({
      TURN_PLAN_V3_MODE: "shadow",
    })).toMatchObject({ turnPlannerV3Mode: "shadow" });
    expect(resolveConversationWorkerConfig({
      TURN_PLAN_V3_MODE: "active_readonly",
    })).toMatchObject({ turnPlannerV3Mode: "active_readonly" });
    expect(resolveConversationWorkerConfig({
      TURN_PLAN_V3_MODE: "active_governed",
    })).toMatchObject({ turnPlannerV3Mode: "active_governed" });
    expect(() => resolveConversationWorkerConfig({
      TURN_PLAN_V3_MODE: "full",
    })).toThrow();
  });

  it("requires an explicit release attestation for production V3 active modes", () => {
    expect(() => resolveConversationWorkerConfig({
      NODE_ENV: "production",
      TURN_PLAN_V3_MODE: "active_governed",
    })).toThrow("TURN_PLAN_V3_ACTIVE_RELEASE_APPROVED=true");
    expect(resolveConversationWorkerConfig({
      NODE_ENV: "production",
      TURN_PLAN_V3_MODE: "active_governed",
      TURN_PLAN_V3_ACTIVE_RELEASE_APPROVED: "true",
    })).toMatchObject({ turnPlannerV3Mode: "active_governed" });
  });

  it("supports an explicit V2 planner rollout mode", () => {
    expect(resolveConversationWorkerConfig({
      TURN_PLANNER_V2_MODE: "active_low_risk",
    })).toMatchObject({ turnPlannerV2Mode: "active_low_risk" });
    expect(resolveConversationWorkerConfig({
      TURN_PLANNER_V2_MODE: "disabled",
    })).toMatchObject({ turnPlannerV2Mode: "disabled" });
    expect(() => resolveConversationWorkerConfig({
      TURN_PLANNER_V2_MODE: "full",
    })).toThrow();
  });

  it("validates the canonical public representative origin used for channel links", () => {
    expect(resolveConversationWorkerConfig({
      NEXT_PUBLIC_REPRESENTATIVE_URL: "https://representatives.example.test",
    })).toMatchObject({
      representativePublicOrigin: "https://representatives.example.test",
    });
    expect(() => resolveConversationWorkerConfig({
      NEXT_PUBLIC_REPRESENTATIVE_URL: "https://user:secret@representatives.example.test/path",
    })).toThrow("canonical HTTP(S) origin");
    expect(() => resolveConversationWorkerConfig({
      NODE_ENV: "production",
      NEXT_PUBLIC_REPRESENTATIVE_URL: "http://representatives.example.test",
    })).toThrow("production requires HTTPS");
    expect(resolveConversationWorkerConfig({
      NODE_ENV: "production",
      NEXT_PUBLIC_REPRESENTATIVE_URL: "http://localhost:3002",
    })).toMatchObject({
      representativePublicOrigin: "http://localhost:3002",
    });
  });

  it("validates independent memory loop polling and readiness bounds", () => {
    expect(resolveConversationWorkerConfig({
      MEMORY_PROJECTION_POLL_MS: "700",
      MEMORY_LIFECYCLE_POLL_MS: "800",
      MEMORY_CLEANUP_POLL_MS: "900",
      MEMORY_RECONCILIATION_POLL_MS: "120000",
      MEMORY_WORKER_TICK_TIMEOUT_MS: "45000",
      CONVERSATION_WORKER_READINESS_STALE_MS: "240000",
    })).toMatchObject({
      memoryProjectionPollMs: 700,
      memoryLifecyclePollMs: 800,
      memoryCleanupPollMs: 900,
      memoryReconciliationPollMs: 120_000,
      memoryTickTimeoutMs: 45_000,
      readinessStaleMs: 240_000,
    });

    expect(() => resolveConversationWorkerConfig({
      MEMORY_LIFECYCLE_POLL_MS: "99",
    })).toThrow();
    expect(() => resolveConversationWorkerConfig({
      MEMORY_PROJECTION_POLL_MS: "99",
    })).toThrow();
    expect(() => resolveConversationWorkerConfig({
      MEMORY_CLEANUP_POLL_MS: "60001",
    })).toThrow();
    expect(() => resolveConversationWorkerConfig({
      MEMORY_RECONCILIATION_POLL_MS: "999",
    })).toThrow();
    expect(() => resolveConversationWorkerConfig({
      MEMORY_WORKER_TICK_TIMEOUT_MS: "999",
    })).toThrow();
    expect(() => resolveConversationWorkerConfig({
      CONVERSATION_WORKER_READINESS_STALE_MS: "999",
    })).toThrow();
  });

  it("requires Matrix URL and application-service token together", () => {
    expect(() => resolveConversationWorkerConfig({ MATRIX_HOMESERVER_URL: "https://matrix.example" })).toThrow(
      "must be configured together",
    );
  });

  it("validates Telegram delivery ownership and request timeout", () => {
    expect(resolveConversationWorkerConfig({
      TELEGRAM_CONVERSATION_PLATFORM_MODE: "worker",
      TELEGRAM_REQUEST_TIMEOUT_MS: "9000",
      CONVERSATION_OUTBOX_PROCESSING_LEASE_MS: "20000000",
    })).toMatchObject({
      telegramConversationPlatformMode: "worker",
      telegramRequestTimeoutMs: 9_000,
      outboxProcessingLeaseMs: 20_000_000,
    });
    expect(() =>
      resolveConversationWorkerConfig({
        TELEGRAM_CONVERSATION_PLATFORM_MODE: "typo",
      })
    ).toThrow();
    expect(() =>
      resolveConversationWorkerConfig({
        NODE_ENV: "production",
        TELEGRAM_CONVERSATION_PLATFORM_MODE: "legacy",
      })
    ).toThrow("Production Telegram traffic must use");
    expect(() =>
      resolveConversationWorkerConfig({
        TELEGRAM_CONVERSATION_PLATFORM_MODE: "shadow",
      })
    ).toThrow("diagnostics-only");
    expect(resolveConversationWorkerConfig({
      TELEGRAM_CONVERSATION_PLATFORM_MODE: "shadow",
      TELEGRAM_CONVERSATION_COMPAT_DIAGNOSTICS_ENABLED: "true",
    })).toMatchObject({ telegramConversationPlatformMode: "shadow" });
    expect(() =>
      resolveConversationWorkerConfig({
        TELEGRAM_REQUEST_TIMEOUT_MS: "500",
      })
    ).toThrow();
    expect(() =>
      resolveConversationWorkerConfig({
        CONVERSATION_OUTBOX_PROCESSING_LEASE_MS: String(5 * 60_000 - 1),
      })
    ).toThrow();
    expect(resolveConversationWorkerConfig({
      CONVERSATION_OUTBOX_PROCESSING_LEASE_MS: String(5 * 60_000),
    })).toMatchObject({
      outboxProcessingLeaseMs: 5 * 60_000,
    });
  });
});

describe("conversation worker model readiness", () => {
  it("reports AGICTO as the configured provider using the existing OpenViking credential", () => {
    const readiness = resolveConversationWorkerModelReadiness({
      DELEGATE_MODEL_PROVIDER: "agicto",
      OPENVIKING_MODEL_API_KEY: "test-agicto-key",
      OPENVIKING_MODEL_API_BASE: "https://api.agicto.cn/v1",
      OPENVIKING_VLM_MODEL: "qwen-plus",
    });

    expect(readiness).toEqual({
      state: "ready",
      configuredProvider: "agicto",
      readyProviders: ["agicto"],
    });
    expect(JSON.stringify(readiness)).not.toContain("test-agicto-key");
  });

  it("reports missing credentials without exposing credential values", () => {
    const readiness = resolveConversationWorkerModelReadiness({
      DELEGATE_MODEL_PROVIDER: "bailian",
    });

    expect(readiness).toEqual({
      state: "missing_credentials",
      configuredProvider: "bailian",
      readyProviders: [],
    });
    expect(JSON.stringify(readiness)).not.toContain("apiKey");
  });

  it("reports the credentialed primary and fallback providers", () => {
    const readiness = resolveConversationWorkerModelReadiness({
      DELEGATE_MODEL_PROVIDER: "bailian",
      DELEGATE_BAILIAN_API_KEY: "test-bailian-key",
      DELEGATE_MODEL_FALLBACK_PROVIDER: "openai",
      OPENAI_API_KEY: "test-openai-key",
    });

    expect(readiness).toEqual({
      state: "ready",
      configuredProvider: "bailian",
      fallbackProvider: "openai",
      readyProviders: ["bailian", "openai"],
    });
    expect(JSON.stringify(readiness)).not.toContain("test-bailian-key");
    expect(JSON.stringify(readiness)).not.toContain("test-openai-key");
  });

  it("does not echo unsupported provider configuration through readiness", () => {
    const readiness = resolveConversationWorkerModelReadiness({
      DELEGATE_MODEL_PROVIDER: "private-provider-name",
      DELEGATE_MODEL_FALLBACK_PROVIDER: "another-private-provider",
    });

    expect(readiness).toEqual({
      state: "unsupported_provider",
      configuredProvider: "unsupported",
      fallbackProvider: "unsupported",
      readyProviders: [],
    });
    expect(JSON.stringify(readiness)).not.toContain("private-provider-name");
    expect(JSON.stringify(readiness)).not.toContain("another-private-provider");
  });
});

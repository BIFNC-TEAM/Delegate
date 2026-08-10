import { describe, expect, it } from "vitest";

import {
  resolveConversationWorkerConfig,
  resolveConversationWorkerModelReadiness,
} from "../src/config";

describe("conversation worker config", () => {
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
      telegramRequestTimeoutMs: 15_000,
      outboxProcessingLeaseMs: 5 * 60_000,
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

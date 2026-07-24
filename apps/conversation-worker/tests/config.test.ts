import { describe, expect, it } from "vitest";

import { resolveConversationWorkerConfig } from "../src/config";

describe("conversation worker config", () => {
  it("allows web-only processing without Matrix credentials", () => {
    expect(resolveConversationWorkerConfig({})).toMatchObject({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
      telegramRequestTimeoutMs: 15_000,
      outboxProcessingLeaseMs: 5 * 60 * 60_000,
    });
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
        CONVERSATION_OUTBOX_PROCESSING_LEASE_MS: "1000",
      })
    ).toThrow();
  });
});

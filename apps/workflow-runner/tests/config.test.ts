import { describe, expect, it } from "vitest";

import { resolveWorkflowRunnerConfig } from "../src/config";

describe("workflow-runner payment reconciliation config", () => {
  it("keeps the worker disabled by default with a safe lease", () => {
    const config = resolveWorkflowRunnerConfig({});

    expect(config.paymentReconciliation).toMatchObject({
      enabled: false,
      pollMs: 5_000,
      batchSize: 10,
      leaseMs: 75_000,
      pendingBackoffMs: 10_000,
      errorBackoffMs: 5_000,
      maxBackoffMs: 600_000,
    });
    expect(config.readinessStaleMs).toBe(180_000);
    expect(config.openVikingMaintenance).toEqual({
      pollMs: 5_000,
      syncBatchSize: 2,
      memoryDeletionBatchSize: 12,
    });
    expect(config.logtoIdentityReconciliation).toEqual({
      enabled: false,
      pollMs: 15 * 60_000,
    });
  });

  it("supports the legacy flag while preferring processing over collection", () => {
    expect(
      resolveWorkflowRunnerConfig({
        DELEGATE_WECHAT_PAY_ENABLED: "true",
      }).paymentReconciliation.enabled,
    ).toBe(true);
    expect(() =>
      resolveWorkflowRunnerConfig({
        DELEGATE_WECHAT_PAY_ENABLED: "TRUE",
      }),
    ).toThrow('must be exactly "true" or "false"');
    expect(
      resolveWorkflowRunnerConfig({
        DELEGATE_WECHAT_PAY_ENABLED: "true",
        DELEGATE_WECHAT_PAY_COLLECTION_ENABLED: "false",
        DELEGATE_WECHAT_PAY_PROCESSING_ENABLED: "true",
      }).paymentReconciliation.enabled,
    ).toBe(true);
  });

  it("rejects collection when durable processing is disabled", () => {
    expect(() =>
      resolveWorkflowRunnerConfig({
        DELEGATE_WECHAT_PAY_COLLECTION_ENABLED: "true",
        DELEGATE_WECHAT_PAY_PROCESSING_ENABLED: "false",
      }),
    ).toThrow("requires DELEGATE_WECHAT_PAY_PROCESSING_ENABLED=true");
  });

  it("rejects a lease shorter than the provider request boundary", () => {
    expect(() =>
      resolveWorkflowRunnerConfig({
        WECHAT_PAY_RECONCILIATION_LEASE_MS: "74999",
      }),
    ).toThrow("must be an integer between 75000");
  });

  it("bounds OpenViking maintenance cadence and batches", () => {
    expect(
      resolveWorkflowRunnerConfig({
        OPENVIKING_MAINTENANCE_POLL_MS: "1000",
        OPENVIKING_SYNC_BATCH_SIZE: "20",
        OPENVIKING_MEMORY_DELETE_BATCH_SIZE: "100",
      }).openVikingMaintenance,
    ).toEqual({
      pollMs: 1_000,
      syncBatchSize: 20,
      memoryDeletionBatchSize: 100,
    });
    expect(() =>
      resolveWorkflowRunnerConfig({
        OPENVIKING_SYNC_BATCH_SIZE: "21",
      }),
    ).toThrow("OPENVIKING_SYNC_BATCH_SIZE must be an integer between 1 and 20");
  });

  it("enables bounded Logto identity reconciliation only with complete M2M credentials", () => {
    expect(resolveWorkflowRunnerConfig({
      LOGTO_ENDPOINT: "https://auth.example.com",
      LOGTO_MANAGEMENT_APP_ID: "app-id",
      LOGTO_MANAGEMENT_APP_SECRET: "app-secret",
      LOGTO_RECONCILIATION_POLL_MS: "60000",
    }).logtoIdentityReconciliation).toEqual({
      enabled: true,
      pollMs: 60_000,
    });
    expect(() => resolveWorkflowRunnerConfig({
      LOGTO_MANAGEMENT_APP_ID: "app-id",
    })).toThrow("must be configured together");
    expect(() => resolveWorkflowRunnerConfig({
      LOGTO_ENDPOINT: "https://auth.example.com",
      LOGTO_MANAGEMENT_APP_ID: "app-id",
      LOGTO_MANAGEMENT_APP_SECRET: "app-secret",
      LOGTO_RECONCILIATION_POLL_MS: "59999",
    })).toThrow("LOGTO_RECONCILIATION_POLL_MS must be an integer between 60000");
  });
});

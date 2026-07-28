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
});

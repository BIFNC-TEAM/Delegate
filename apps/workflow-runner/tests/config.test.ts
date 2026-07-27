import { describe, expect, it } from "vitest";

import { resolveWorkflowRunnerConfig } from "../src/config";

describe("workflow-runner payment reconciliation config", () => {
  it("keeps the worker disabled by default with a safe lease", () => {
    const config = resolveWorkflowRunnerConfig({});

    expect(config.paymentReconciliation).toMatchObject({
      enabled: false,
      pollMs: 5_000,
      batchSize: 10,
      leaseMs: 30_000,
      pendingBackoffMs: 10_000,
      errorBackoffMs: 5_000,
      maxBackoffMs: 600_000,
    });
  });

  it("enables reconciliation only for the exact release flag", () => {
    expect(
      resolveWorkflowRunnerConfig({
        DELEGATE_WECHAT_PAY_ENABLED: "true",
      }).paymentReconciliation.enabled,
    ).toBe(true);
    expect(
      resolveWorkflowRunnerConfig({
        DELEGATE_WECHAT_PAY_ENABLED: "TRUE",
      }).paymentReconciliation.enabled,
    ).toBe(false);
  });

  it("rejects a lease shorter than the provider request boundary", () => {
    expect(() =>
      resolveWorkflowRunnerConfig({
        WECHAT_PAY_RECONCILIATION_LEASE_MS: "29999",
      }),
    ).toThrow("must be an integer between 30000");
  });
});

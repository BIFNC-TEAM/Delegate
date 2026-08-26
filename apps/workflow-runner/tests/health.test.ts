import { describe, expect, it } from "vitest";

import { buildWorkflowRunnerReadiness } from "../src/health";

const now = new Date("2026-07-28T08:00:00.000Z");
const readyPreflight = {
  ready: true,
  status: "ready" as const,
  collectionEnabled: false,
  processingEnabled: true,
  errorCode: null,
};
const disabledLogtoReconciliation = {
  enabled: false,
  lastTickAt: null,
  lastTickFailed: false,
  staleAfterMs: 30 * 60_000,
};

describe("workflow-runner readiness", () => {
  it("accepts processing-only mode when both loops and the database are ready", () => {
    expect(
      buildWorkflowRunnerReadiness({
        now,
        staleAfterMs: 180_000,
        databaseReady: true,
        weChatPay: readyPreflight,
        workflow: {
          lastTickAt: "2026-07-28T07:59:55.000Z",
          lastTickFailed: false,
        },
        temporal: {
          required: false,
          status: "disabled",
        },
        paymentReconciliation: {
          enabled: true,
          lastTickAt: "2026-07-28T07:59:50.000Z",
          lastTickFailed: false,
          persistentWorkerFailure: false,
        },
        logtoIdentityReconciliation: disabledLogtoReconciliation,
      }),
    ).toMatchObject({
      status: "ready",
      reasons: [],
      databaseReady: true,
      loops: {
        workflow: "ready",
        paymentReconciliation: "ready",
      },
    });
  });

  it("does not require a payment tick while processing is disabled", () => {
    const snapshot = buildWorkflowRunnerReadiness({
      now,
      staleAfterMs: 180_000,
      databaseReady: true,
      weChatPay: {
        ready: true,
        status: "disabled",
        collectionEnabled: false,
        processingEnabled: false,
        errorCode: null,
      },
      workflow: {
        lastTickAt: "2026-07-28T07:59:55.000Z",
        lastTickFailed: false,
      },
      temporal: {
        required: false,
        status: "disabled",
      },
      paymentReconciliation: {
        enabled: false,
        lastTickAt: null,
        lastTickFailed: false,
        persistentWorkerFailure: false,
      },
      logtoIdentityReconciliation: disabledLogtoReconciliation,
    });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.loops.paymentReconciliation).toBe("disabled");
  });

  it("reports only stable readiness reasons", () => {
    const snapshot = buildWorkflowRunnerReadiness({
      now,
      staleAfterMs: 30_000,
      databaseReady: false,
      weChatPay: {
        ready: false,
        status: "misconfigured",
        collectionEnabled: false,
        processingEnabled: true,
        errorCode: "wechat_pay_configuration_invalid",
      },
      workflow: {
        lastTickAt: "2026-07-28T07:00:00.000Z",
        lastTickFailed: false,
      },
      temporal: {
        required: true,
        status: "failed",
      },
      paymentReconciliation: {
        enabled: true,
        lastTickAt: "2026-07-28T07:59:59.000Z",
        lastTickFailed: true,
        persistentWorkerFailure: false,
      },
      logtoIdentityReconciliation: disabledLogtoReconciliation,
    });

    expect(snapshot).toMatchObject({
      status: "not_ready",
      reasons: [
        "database_unavailable",
        "wechat_pay_configuration_invalid",
        "workflow_loop_stale",
        "temporal_bridge_failed",
        "wechat_payment_reconciliation_loop_failed",
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });

  it("remains not ready after restart while a durable worker failure is unresolved", () => {
    const snapshot = buildWorkflowRunnerReadiness({
      now,
      staleAfterMs: 180_000,
      databaseReady: true,
      weChatPay: readyPreflight,
      workflow: {
        lastTickAt: "2026-07-28T07:59:55.000Z",
        lastTickFailed: false,
      },
      temporal: {
        required: false,
        status: "disabled",
      },
      paymentReconciliation: {
        enabled: true,
        lastTickAt: "2026-07-28T07:59:59.000Z",
        lastTickFailed: false,
        persistentWorkerFailure: true,
      },
      logtoIdentityReconciliation: disabledLogtoReconciliation,
    });

    expect(snapshot).toMatchObject({
      status: "not_ready",
      reasons: [
        "wechat_payment_reconciliation_loop_failed",
      ],
      loops: {
        paymentReconciliation: "failed",
      },
    });
  });

  it("fails readiness closed while production Temporal is unavailable", () => {
    const snapshot = buildWorkflowRunnerReadiness({
      now,
      staleAfterMs: 180_000,
      databaseReady: true,
      weChatPay: readyPreflight,
      workflow: {
        lastTickAt: "2026-07-28T07:59:55.000Z",
        lastTickFailed: false,
      },
      temporal: {
        required: true,
        status: "starting",
      },
      paymentReconciliation: {
        enabled: false,
        lastTickAt: null,
        lastTickFailed: false,
        persistentWorkerFailure: false,
      },
      logtoIdentityReconciliation: disabledLogtoReconciliation,
    });

    expect(snapshot).toMatchObject({
      status: "not_ready",
      reasons: ["temporal_bridge_starting"],
      temporal: {
        required: true,
        status: "starting",
      },
    });
  });

  it("fails readiness when enabled Logto reconciliation has not completed", () => {
    const snapshot = buildWorkflowRunnerReadiness({
      now,
      staleAfterMs: 180_000,
      databaseReady: true,
      weChatPay: readyPreflight,
      workflow: {
        lastTickAt: "2026-07-28T07:59:55.000Z",
        lastTickFailed: false,
      },
      temporal: { required: false, status: "disabled" },
      paymentReconciliation: {
        enabled: false,
        lastTickAt: null,
        lastTickFailed: false,
        persistentWorkerFailure: false,
      },
      logtoIdentityReconciliation: {
        enabled: true,
        lastTickAt: null,
        lastTickFailed: false,
        staleAfterMs: 30 * 60_000,
      },
    });

    expect(snapshot.reasons).toContain(
      "logto_identity_reconciliation_loop_missing",
    );
    expect(snapshot.loops.logtoIdentityReconciliation).toBe("missing");
  });

  it("uses the slower Logto cadence without weakening payment freshness", () => {
    const snapshot = buildWorkflowRunnerReadiness({
      now,
      staleAfterMs: 180_000,
      databaseReady: true,
      weChatPay: readyPreflight,
      workflow: {
        lastTickAt: "2026-07-28T07:59:55.000Z",
        lastTickFailed: false,
      },
      temporal: { required: false, status: "disabled" },
      paymentReconciliation: {
        enabled: true,
        lastTickAt: "2026-07-28T07:50:00.000Z",
        lastTickFailed: false,
        persistentWorkerFailure: false,
      },
      logtoIdentityReconciliation: {
        enabled: true,
        lastTickAt: "2026-07-28T07:50:00.000Z",
        lastTickFailed: false,
        staleAfterMs: 30 * 60_000,
      },
    });

    expect(snapshot.loops.paymentReconciliation).toBe("stale");
    expect(snapshot.loops.logtoIdentityReconciliation).toBe("ready");
  });
});

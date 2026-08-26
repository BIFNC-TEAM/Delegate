import type { WeChatPayRuntimePreflight } from "@delegate/web-data";

export type WorkflowRunnerReadinessInput = {
  now: Date;
  staleAfterMs: number;
  databaseReady: boolean;
  weChatPay: WeChatPayRuntimePreflight;
  workflow: {
    lastTickAt: string | null;
    lastTickFailed: boolean;
  };
  temporal: {
    required: boolean;
    status: "disabled" | "starting" | "running" | "failed";
    error?: string;
  };
  paymentReconciliation: {
    enabled: boolean;
    lastTickAt: string | null;
    lastTickFailed: boolean;
    persistentWorkerFailure: boolean;
  };
  logtoIdentityReconciliation: {
    enabled: boolean;
    lastTickAt: string | null;
    lastTickFailed: boolean;
    staleAfterMs: number;
  };
};

export type WorkflowRunnerReadinessSnapshot = {
  status: "ready" | "not_ready";
  service: "workflow-runner";
  reasons: string[];
  databaseReady: boolean;
  weChatPay: WeChatPayRuntimePreflight;
  loops: {
    workflow: "ready" | "missing" | "stale" | "failed";
    paymentReconciliation:
      | "disabled"
      | "ready"
      | "missing"
      | "stale"
      | "failed";
    logtoIdentityReconciliation:
      | "disabled"
      | "ready"
      | "missing"
      | "stale"
      | "failed";
  };
  temporal: {
    required: boolean;
    status: "disabled" | "starting" | "running" | "failed";
  };
};

export function buildWorkflowRunnerReadiness(
  input: WorkflowRunnerReadinessInput,
): WorkflowRunnerReadinessSnapshot {
  const reasons: string[] = [];
  if (!input.databaseReady) {
    reasons.push("database_unavailable");
  }
  if (!input.weChatPay.ready) {
    reasons.push(
      input.weChatPay.errorCode
      ?? "wechat_pay_configuration_invalid",
    );
  }

  const workflow = loopStatus({
    now: input.now,
    lastTickAt: input.workflow.lastTickAt,
    lastTickFailed: input.workflow.lastTickFailed,
    staleAfterMs: input.staleAfterMs,
  });
  if (workflow !== "ready") {
    reasons.push(`workflow_loop_${workflow}`);
  }
  if (input.temporal.required && input.temporal.status !== "running") {
    reasons.push(`temporal_bridge_${input.temporal.status}`);
  }

  const paymentReconciliation =
    input.paymentReconciliation.enabled
      ? loopStatus({
          now: input.now,
          lastTickAt:
            input.paymentReconciliation.lastTickAt,
          lastTickFailed:
            input.paymentReconciliation.lastTickFailed
            || input.paymentReconciliation
              .persistentWorkerFailure,
          staleAfterMs: input.staleAfterMs,
        })
      : "disabled";
  if (
    paymentReconciliation !== "ready"
    && paymentReconciliation !== "disabled"
  ) {
    reasons.push(
      `wechat_payment_reconciliation_loop_${paymentReconciliation}`,
    );
  }

  const logtoIdentityReconciliation =
    input.logtoIdentityReconciliation.enabled
      ? loopStatus({
          now: input.now,
          lastTickAt: input.logtoIdentityReconciliation.lastTickAt,
          lastTickFailed:
            input.logtoIdentityReconciliation.lastTickFailed,
          staleAfterMs:
            input.logtoIdentityReconciliation.staleAfterMs,
        })
      : "disabled";
  if (
    logtoIdentityReconciliation !== "ready"
    && logtoIdentityReconciliation !== "disabled"
  ) {
    reasons.push(
      `logto_identity_reconciliation_loop_${logtoIdentityReconciliation}`,
    );
  }

  return {
    status: reasons.length === 0 ? "ready" : "not_ready",
    service: "workflow-runner",
    reasons,
    databaseReady: input.databaseReady,
    weChatPay: input.weChatPay,
    loops: {
      workflow,
      paymentReconciliation,
      logtoIdentityReconciliation,
    },
    temporal: {
      required: input.temporal.required,
      status: input.temporal.status,
    },
  };
}

function loopStatus(input: {
  now: Date;
  lastTickAt: string | null;
  lastTickFailed: boolean;
  staleAfterMs: number;
}): "ready" | "missing" | "stale" | "failed" {
  if (!input.lastTickAt) {
    return "missing";
  }
  if (input.lastTickFailed) {
    return "failed";
  }
  const timestamp = new Date(input.lastTickAt).getTime();
  const ageMs = input.now.getTime() - timestamp;
  if (
    !Number.isFinite(timestamp)
    || ageMs < -5_000
    || ageMs > input.staleAfterMs
  ) {
    return "stale";
  }
  return "ready";
}

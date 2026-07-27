import { getWorkflowEngineConfig } from "@delegate/workflows";

export function resolveWorkflowRunnerConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return {
    port: parseInt(env.WORKFLOW_RUNNER_PORT?.trim() || "4020", 10),
    pollMs: parseInt(
      env.WORKFLOW_RUNNER_POLL_MS?.trim() || "5000",
      10,
    ),
    approvalTimeoutMinutes: parseInt(
      env.WORKFLOW_APPROVAL_TIMEOUT_MINUTES?.trim() || "30",
      10,
    ),
    batchSize: parseInt(
      env.WORKFLOW_RUNNER_BATCH_SIZE?.trim() || "10",
      10,
    ),
    paymentReconciliation: {
      enabled: env.DELEGATE_WECHAT_PAY_ENABLED === "true",
      pollMs: readBoundedInteger(
        env,
        "WECHAT_PAY_RECONCILIATION_POLL_MS",
        5_000,
        1_000,
        60_000,
      ),
      batchSize: readBoundedInteger(
        env,
        "WECHAT_PAY_RECONCILIATION_BATCH_SIZE",
        10,
        1,
        100,
      ),
      leaseMs: readBoundedInteger(
        env,
        "WECHAT_PAY_RECONCILIATION_LEASE_MS",
        30_000,
        30_000,
        10 * 60_000,
      ),
      pendingBackoffMs: readBoundedInteger(
        env,
        "WECHAT_PAY_RECONCILIATION_PENDING_BACKOFF_MS",
        10_000,
        1_000,
        10 * 60_000,
      ),
      errorBackoffMs: readBoundedInteger(
        env,
        "WECHAT_PAY_RECONCILIATION_ERROR_BACKOFF_MS",
        5_000,
        1_000,
        10 * 60_000,
      ),
      maxBackoffMs: readBoundedInteger(
        env,
        "WECHAT_PAY_RECONCILIATION_MAX_BACKOFF_MS",
        10 * 60_000,
        1_000,
        24 * 60 * 60_000,
      ),
    },
    engine: getWorkflowEngineConfig(env),
  } as const;
}

function readBoundedInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export const workflowRunnerConfig =
  resolveWorkflowRunnerConfig();

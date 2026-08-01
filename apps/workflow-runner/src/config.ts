import { getWorkflowEngineConfig } from "@delegate/workflows";
import { resolveWeChatPayReleaseFlags } from "@delegate/web-data";

export function resolveWorkflowRunnerConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const weChatPayRelease =
    resolveWeChatPayReleaseFlags(env);
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
    readinessStaleMs: readBoundedInteger(
      env,
      "WORKFLOW_RUNNER_READINESS_STALE_MS",
      180_000,
      30_000,
      60 * 60_000,
    ),
    paymentReconciliation: {
      enabled: weChatPayRelease.processingEnabled,
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
        75_000,
        75_000,
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
    openVikingMaintenance: {
      pollMs: readBoundedInteger(
        env,
        "OPENVIKING_MAINTENANCE_POLL_MS",
        5_000,
        1_000,
        60_000,
      ),
      syncBatchSize: readBoundedInteger(
        env,
        "OPENVIKING_SYNC_BATCH_SIZE",
        2,
        1,
        20,
      ),
      memoryDeletionBatchSize: readBoundedInteger(
        env,
        "OPENVIKING_MEMORY_DELETE_BATCH_SIZE",
        12,
        1,
        100,
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

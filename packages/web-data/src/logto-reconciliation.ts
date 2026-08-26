import {
  AuthIdentityProvider,
  AuthIdentityStatus,
} from "@prisma/client";

import { readLogtoIssuer } from "./auth-session";
import {
  reconcileLogtoIdentityLifecycleState,
  type LogtoLifecycleResult,
} from "./logto-lifecycle";
import {
  createLogtoManagementClient,
  readLogtoManagementConfig,
  type LogtoManagementUser,
} from "./logto-management";
import { prisma } from "./prisma";

export const LOGTO_RECONCILIATION_WORKER_KEY =
  "logto-identity-reconciliation";

type LocalIdentity = {
  issuer: string;
  subject: string;
  status: AuthIdentityStatus;
};

export type LogtoReconciliationSummary = {
  enabled: boolean;
  processed: boolean;
  remoteUsers: number;
  localIdentities: number;
  suspended: number;
  reactivated: number;
  deletionPending: number;
  unchanged: number;
  revokedSessions: number;
};

type ReconciliationDependencies = {
  listRemoteUsers(): Promise<LogtoManagementUser[]>;
  loadLocalIdentities(
    issuer: string,
    createdBefore: Date,
  ): Promise<LocalIdentity[]>;
  applyState(input: {
    issuer: string;
    providerSubject: string;
    state: "ACTIVE" | "SUSPENDED" | "DELETED";
    now: Date;
  }): Promise<LogtoLifecycleResult>;
  checkpointStarted(now: Date): Promise<void>;
  checkpointSucceeded(
    now: Date,
    summary: LogtoReconciliationSummary,
  ): Promise<void>;
  checkpointFailed(now: Date, errorCode: string): Promise<void>;
};

export async function runLogtoIdentityReconciliation(
  options: {
    env?: Record<string, string | undefined> | undefined;
    now?: Date | undefined;
  } = {},
  dependencies?: ReconciliationDependencies,
): Promise<LogtoReconciliationSummary> {
  const env = options.env ?? process.env;
  const config = readLogtoManagementConfig(env);
  if (!config) return emptySummary(false);
  const issuer = readLogtoIssuer(env);
  const now = options.now ?? new Date();
  const resolvedDependencies = dependencies ?? defaultDependencies(config);
  await resolvedDependencies.checkpointStarted(now);

  try {
    const [remoteUsers, localIdentities] = await Promise.all([
      resolvedDependencies.listRemoteUsers(),
      resolvedDependencies.loadLocalIdentities(issuer, now),
    ]);
    const remoteBySubject = new Map(
      remoteUsers.map((user) => [user.id, user]),
    );
    const summary = emptySummary(true);
    summary.processed = true;
    summary.remoteUsers = remoteUsers.length;
    summary.localIdentities = localIdentities.length;

    for (const identity of localIdentities) {
      const remote = remoteBySubject.get(identity.subject);
      const state = !remote
        ? "DELETED" as const
        : remote.isSuspended
          ? "SUSPENDED" as const
          : "ACTIVE" as const;
      const result = await resolvedDependencies.applyState({
        issuer: identity.issuer,
        providerSubject: identity.subject,
        state,
        now,
      });
      summary.revokedSessions += result.revokedSessions;
      if (result.effect === "SUSPENDED") summary.suspended += 1;
      else if (result.effect === "REACTIVATED") summary.reactivated += 1;
      else if (result.effect === "DELETION_PENDING") {
        summary.deletionPending += 1;
      } else summary.unchanged += 1;
    }

    await resolvedDependencies.checkpointSucceeded(now, summary);
    return summary;
  } catch (error) {
    await resolvedDependencies.checkpointFailed(
      now,
      reconciliationErrorCode(error),
    );
    throw error;
  }
}

function defaultDependencies(
  config: NonNullable<ReturnType<typeof readLogtoManagementConfig>>,
): ReconciliationDependencies {
  const management = createLogtoManagementClient(config);
  return {
    listRemoteUsers: () => management.listAllUsers(),
    loadLocalIdentities: (issuer, createdBefore) =>
      prisma.authIdentity.findMany({
        where: {
          provider: AuthIdentityProvider.LOGTO,
          issuer,
          status: {
            in: [AuthIdentityStatus.ACTIVE, AuthIdentityStatus.SUSPENDED],
          },
          createdAt: { lte: createdBefore },
        },
        select: { issuer: true, subject: true, status: true },
        orderBy: { id: "asc" },
      }),
    applyState: (input) => reconcileLogtoIdentityLifecycleState(input),
    checkpointStarted: (now) =>
      prisma.operationalWorkerCheckpoint.upsert({
        where: { workerKey: LOGTO_RECONCILIATION_WORKER_KEY },
        create: {
          workerKey: LOGTO_RECONCILIATION_WORKER_KEY,
          lastStartedAt: now,
          lastHeartbeatAt: now,
        },
        update: {
          lastStartedAt: now,
          lastHeartbeatAt: now,
        },
      }).then(() => undefined),
    checkpointSucceeded: (now, summary) =>
      prisma.operationalWorkerCheckpoint.update({
        where: { workerKey: LOGTO_RECONCILIATION_WORKER_KEY },
        data: {
          lastHeartbeatAt: now,
          lastSuccessAt: now,
          consecutiveFailures: 0,
          lastErrorCode: null,
          lastSummary: summary,
        },
      }).then(() => undefined),
    checkpointFailed: (now, errorCode) =>
      prisma.operationalWorkerCheckpoint.update({
        where: { workerKey: LOGTO_RECONCILIATION_WORKER_KEY },
        data: {
          lastHeartbeatAt: now,
          consecutiveFailures: { increment: 1 },
          lastErrorCode: errorCode,
        },
      }).then(() => undefined),
  };
}

function emptySummary(enabled: boolean): LogtoReconciliationSummary {
  return {
    enabled,
    processed: false,
    remoteUsers: 0,
    localIdentities: 0,
    suspended: 0,
    reactivated: 0,
    deletionPending: 0,
    unchanged: 0,
    revokedSessions: 0,
  };
}

function reconciliationErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown";
  if (message.includes("token request")) return "logto_management_token_failed";
  if (message.includes("users request")) return "logto_management_users_failed";
  if (message.includes("MAX_PAGES")) return "logto_management_page_cap";
  return "logto_identity_reconciliation_failed";
}

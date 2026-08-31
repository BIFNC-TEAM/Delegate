import type {
  ComputeFilesystemMode,
  ComputeNetworkMode,
} from "@delegate/compute-protocol";

import { computeBrokerConfig } from "./config";
import { prisma } from "./prisma";
import { recordSandboxMetric } from "./sandbox-metrics";
import {
  SandboxProviderError,
  type SandboxProvider,
  type SandboxProviderLease,
} from "./sandbox-provider";
import {
  createSandboxProviderOperation,
  markSandboxProviderOperationBound,
  markSandboxProviderOperationCalled,
  markSandboxProviderOperationFailed,
  markSandboxProviderOperationResolved,
} from "./sandbox-provider-operations";
import { SandboxProviderRegistry } from "./sandbox-provider-registry";
import { mapRunnerTypeFromDb } from "./serializers";

type SandboxManagedSession = {
  id: string;
  representativeId: string;
  contactId: string | null;
  conversationId: string | null;
  baseImage: string;
  runtimeClass: string;
  runnerType: string;
  expiresAt: Date | null;
};

export type EnsureUserSandboxLeaseParams = {
  session: SandboxManagedSession;
  networkMode: ComputeNetworkMode;
  filesystemMode: ComputeFilesystemMode;
  hostWorkspaceRoot?: string | undefined;
  providerFactory: SandboxProviderFactory;
  selectProviderForNewIdentity: () => Promise<{
    providerKind: "docker" | "daytona" | "tencent";
    decisionSource: "legacy" | "manual_override" | "default";
    routingDigest?: string | null | undefined;
  }>;
  idleStopMinutes?: number | undefined;
};

type SandboxLeaseWithIdentity = {
  id: string;
  sandboxIdentityId: string;
  provider: string;
  providerSandboxId: string | null;
  runnerLeaseId: string | null;
  containerId: string | null;
  sessionRoot: string | null;
  status: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  stoppedAt: Date | null;
  errorReason: string | null;
  runtimeClass: string;
  identityLifecycleEpoch: number;
  sandboxIdentity: {
    representativeId: string;
    contactId: string;
  };
};

export type SandboxProviderFactory = (providerKind: "docker" | "daytona" | "tencent") => Promise<SandboxProvider>;

export async function ensureUserSandboxLease(params: EnsureUserSandboxLeaseParams) {
  if (!params.session.contactId) {
    throw new Error("sandbox_identity_requires_contact");
  }

  const now = new Date();
  const scopeKey = buildSandboxScopeKey(params.session.conversationId);
  const expiresAt = new Date(
    now.getTime() + (params.idleStopMinutes ?? computeBrokerConfig.sandboxLifecycle.idleStopMinutes) * 60 * 1000,
  );

  const identityKey = {
    representativeId: params.session.representativeId,
    contactId: params.session.contactId,
    scopeKey,
  };
  const existingIdentity = await prisma.sandboxIdentity.findUnique({
    where: { representativeId_contactId_scopeKey: identityKey },
    select: { provider: true },
  });
  const selection = existingIdentity
    ? {
        providerKind: mapSandboxProviderFromDb(existingIdentity.provider),
        decisionSource: "legacy" as const,
        routingDigest: null,
      }
    : await params.selectProviderForNewIdentity();
  const selectedProvider = mapSandboxProviderToDb(selection.providerKind);

  const reservation = await prisma.$transaction(async (tx) => {
    const contact = await tx.contact.findUnique({
      where: { id: params.session.contactId! },
      select: { audienceIdentityId: true },
    });
    const created = await tx.sandboxIdentity.createMany({
      data: [{
        representativeId: params.session.representativeId,
        contactId: params.session.contactId!,
        scopeKey,
        audienceIdentityId: contact?.audienceIdentityId ?? null,
        provider: selectedProvider,
        providerIdentityKey: buildProviderIdentityKey(
          params.session.representativeId,
          params.session.contactId!,
          scopeKey,
        ),
        status: "ACTIVE",
        lifecycleEpoch: 1,
        lastUsedAt: now,
      }],
      skipDuplicates: true,
    });
    const identityCandidate = await tx.sandboxIdentity.findUniqueOrThrow({
      where: {
        representativeId_contactId_scopeKey: identityKey,
      },
    });
    await tx.$queryRaw`SELECT "id" FROM "SandboxIdentity" WHERE "id" = ${identityCandidate.id} FOR UPDATE`;
    const identity = await tx.sandboxIdentity.findUniqueOrThrow({
      where: { id: identityCandidate.id },
    });
    if (identity.status === "ARCHIVED") throw new Error("sandbox_identity_archived");
    if (identity.status === "DELETED") throw new Error("sandbox_identity_deleted");

    const providerKind = mapSandboxProviderFromDb(identity.provider);
    const provider = mapSandboxProviderToDb(providerKind);
    await tx.sandboxIdentity.update({
      where: { id: identity.id },
      data: {
        audienceIdentityId: contact?.audienceIdentityId ?? null,
        lastUsedAt: now,
      },
    });
    if (created.count === 1) {
      await tx.eventAudit.create({
        data: {
          representativeId: params.session.representativeId,
          contactId: params.session.contactId,
          conversationId: params.session.conversationId,
          type: "SANDBOX_IDENTITY_CREATED",
          payload: {
            sandboxIdentityId: identity.id,
            provider: providerKind,
            decisionSource: selection.decisionSource,
            routingDigest: selection.routingDigest ?? null,
            scopeType: scopeKey === "contact" ? "contact" : "conversation",
          },
        },
      });
    }

    const reusableLease = await tx.sandboxLease.findFirst({
      where: {
        sandboxIdentityId: identity.id,
        provider,
        networkMode: params.networkMode.toUpperCase() as "NO_NETWORK" | "ALLOWLIST" | "FULL",
        filesystemMode: params.filesystemMode.toUpperCase() as "WORKSPACE_ONLY" | "READ_ONLY_WORKSPACE" | "EPHEMERAL_FULL",
        baseImage: params.session.baseImage,
        runtimeClass: mapRuntimeClassToDb(params.session.runtimeClass),
        identityLifecycleEpoch: identity.lifecycleEpoch,
        status: {
          in: ["RUNNING", "STOPPED"],
        },
      },
      orderBy: [{ lastUsedAt: "desc" }, { updatedAt: "desc" }],
    });

    const createdLease = !reusableLease;
    const lease = reusableLease
      ? reusableLease.status === "RUNNING"
        ? await tx.sandboxLease.update({
            where: { id: reusableLease.id },
            data: {
              lastUsedAt: now,
              expiresAt,
              errorReason: null,
            },
          })
        : await tx.sandboxLease.update({
            where: { id: reusableLease.id },
            data: {
              status: "STARTING",
              lastUsedAt: now,
              expiresAt,
              stoppedAt: null,
              errorReason: null,
            },
          })
      : await tx.sandboxLease.create({
          data: {
            sandboxIdentityId: identity.id,
            provider,
            networkMode: params.networkMode.toUpperCase() as "NO_NETWORK" | "ALLOWLIST" | "FULL",
            filesystemMode: params.filesystemMode.toUpperCase() as "WORKSPACE_ONLY" | "READ_ONLY_WORKSPACE" | "EPHEMERAL_FULL",
            baseImage: params.session.baseImage,
            runtimeClass: mapRuntimeClassToDb(params.session.runtimeClass),
            identityLifecycleEpoch: identity.lifecycleEpoch,
            status: "STARTING",
            lastUsedAt: now,
            expiresAt,
          },
        });

    await tx.computeSession.update({
      where: { id: params.session.id },
      data: {
        sandboxLeaseId: lease.id,
      },
    });

    const operation = createdLease
      ? await createSandboxProviderOperation(tx, {
          sandboxLeaseId: lease.id,
          provider,
          now,
        })
      : null;

    return {
      identity,
      lease,
      createdLease,
      providerKind,
      operation,
      providerSandboxId: lease.providerSandboxId ?? reusableLease?.providerSandboxId ?? null,
    };
  });

  let provider: SandboxProvider | null = null;
  let startedProviderLease: SandboxProviderLease | null = null;
  let providerCallStarted = false;
  try {
    provider = await params.providerFactory(reservation.providerKind);
    if (!reservation.createdLease && reservation.lease.status === "RUNNING") {
      return {
        identity: reservation.identity,
        lease: reservation.lease,
        providerLease: buildProviderLeaseFromReservation(reservation.lease, reservation.providerKind),
      };
    }
    if (reservation.operation) {
      const called = await prisma.sandboxProviderOperation.updateMany(
        markSandboxProviderOperationCalled(reservation.operation.id, now),
      );
      if (called.count !== 1) throw new Error("sandbox_provider_operation_fence_lost");
    }
    providerCallStarted = true;
    const providerLease = await provider.start({
      sandboxIdentityId: reservation.identity.id,
      sandboxLeaseId: reservation.lease.id,
      creationKey: reservation.operation?.creationKey,
      runtimeClass: mapRuntimeClassFromDb(params.session.runtimeClass),
      providerSandboxId: reservation.providerSandboxId,
      runnerType: mapRunnerTypeFromDb(params.session.runnerType),
      image: params.session.baseImage,
      hostWorkspaceRoot: params.hostWorkspaceRoot ?? computeBrokerConfig.hostWorkspaceRoot,
      networkMode: params.networkMode,
      filesystemMode: params.filesystemMode,
      sessionId: params.session.id,
    });
    startedProviderLease = providerLease;

    const lease = await prisma.$transaction(async (tx) => {
      const currentIdentity = await tx.sandboxIdentity.findUniqueOrThrow({
        where: { id: reservation.identity.id },
        select: { status: true, lifecycleEpoch: true },
      });
      if (
        currentIdentity.status !== "ACTIVE" ||
        currentIdentity.lifecycleEpoch !== reservation.identity.lifecycleEpoch
      ) {
        throw new Error("sandbox_identity_concurrent_change");
      }
      const bound = await tx.sandboxLease.updateMany({
        where: {
          id: reservation.lease.id,
          status: "STARTING",
          identityLifecycleEpoch: reservation.identity.lifecycleEpoch,
        },
        data: {
          status: "RUNNING",
          providerSandboxId: providerLease.providerSandboxId,
          runnerLeaseId: providerLease.leaseId,
          containerId: providerLease.containerId,
          sessionRoot: providerLease.sessionRoot,
          lastUsedAt: now,
          expiresAt,
          stoppedAt: null,
          errorReason: null,
        },
      });
      if (bound.count !== 1) throw new Error("sandbox_identity_concurrent_change");
      const updatedLease = await tx.sandboxLease.findUniqueOrThrow({
        where: { id: reservation.lease.id },
      });
      await tx.computeSession.update({
        where: { id: params.session.id },
        data: {
          sandboxLeaseId: updatedLease.id,
          runnerLeaseId: providerLease.leaseId,
          containerId: providerLease.containerId,
          leaseLastUsedAt: now,
          lastHeartbeatAt: now,
        },
      });
      if (reservation.operation) {
        const boundOperation = await tx.sandboxProviderOperation.updateMany(markSandboxProviderOperationBound({
          operationId: reservation.operation.id,
          providerSandboxId: providerLease.providerSandboxId,
          now,
        }));
        if (boundOperation.count !== 1) throw new Error("sandbox_provider_operation_fence_lost");
      }
      return updatedLease;
    });
    await prisma.eventAudit.create({
      data: {
        representativeId: params.session.representativeId,
        contactId: params.session.contactId,
        conversationId: params.session.conversationId,
        type: "SANDBOX_LEASE_STARTED",
        payload: {
          sandboxIdentityId: reservation.identity.id,
          sandboxLeaseId: lease.id,
          provider: reservation.providerKind,
          providerSandboxId: providerLease.providerSandboxId,
          computeSessionId: params.session.id,
        },
      },
    });
    if (reservation.operation) {
      const resolved = await prisma.sandboxProviderOperation.updateMany(
        markSandboxProviderOperationResolved(reservation.operation.id),
      );
      if (resolved.count !== 1) throw new Error("sandbox_provider_operation_fence_lost");
    }
    recordSandboxMetric("sandbox_identity_upserts_total");
    if (reservation.createdLease) {
      recordSandboxMetric("sandbox_leases_created_total");
    }
    recordSandboxMetric("sandbox_leases_started_total");

    return {
      identity: reservation.identity,
      lease,
      providerLease,
    };
  } catch (error) {
    const providerError = error instanceof SandboxProviderError ? error : null;
    const knownLocalError = error instanceof Error && [
      "sandbox_identity_concurrent_change",
      "sandbox_provider_operation_fence_lost",
    ].includes(error.message)
      ? error.message
      : null;
    const errorReason = providerError?.code.toLowerCase()
      ?? knownLocalError
      ?? (providerCallStarted ? "sandbox_provider_start_unknown" : "sandbox_provider_configuration_failed");
    if (knownLocalError && provider && startedProviderLease) {
      await provider.stop({
        lease: startedProviderLease ?? buildProviderLeaseFromReservation(
          reservation.lease,
          reservation.providerKind,
        ),
        sessionId: params.session.id,
      }).catch(() => undefined);
    }
    await prisma.sandboxLease.update({
      where: { id: reservation.lease.id },
      data: {
        status: "ERROR",
        errorReason,
      },
    });
    if (reservation.operation) {
      await prisma.sandboxProviderOperation.updateMany(markSandboxProviderOperationFailed({
        operationId: reservation.operation.id,
        errorCode: errorReason,
        ambiguous: providerCallStarted && (providerError?.ambiguous ?? true),
      }));
    }
    recordSandboxMetric("sandbox_leases_errors_total");
    await prisma.eventAudit.create({
      data: {
        representativeId: params.session.representativeId,
        contactId: params.session.contactId,
        conversationId: params.session.conversationId,
        type: "SANDBOX_LEASE_ERRORED",
        payload: {
          sandboxIdentityId: reservation.identity.id,
          sandboxLeaseId: reservation.lease.id,
          provider: reservation.providerKind,
          computeSessionId: params.session.id,
          errorReason,
        },
      },
    });
    throw error;
  }
}

export function buildSandboxScopeKey(conversationId: string | null | undefined) {
  return conversationId ? `conversation:${conversationId}` : "contact";
}

export function buildProviderIdentityKey(
  representativeId: string,
  contactId: string,
  scopeKey = "contact",
) {
  return `delegate:${representativeId}:${contactId}:${scopeKey}`;
}

export function mapSandboxProviderToDb(provider: "docker" | "daytona" | "tencent") {
  return provider.toUpperCase() as "DOCKER" | "DAYTONA" | "TENCENT";
}

export async function cleanupIdleSandboxLeases(params: {
  now?: Date | undefined;
  idleStopMinutes?: number | undefined;
  limit?: number | undefined;
  providerFactory?: SandboxProviderFactory | undefined;
} = {}) {
  const now = params.now ?? new Date();
  const idleStopMinutes = params.idleStopMinutes ?? computeBrokerConfig.sandboxLifecycle.idleStopMinutes;
  const idleCutoff = new Date(now.getTime() - idleStopMinutes * 60 * 1000);
  const leases = await prisma.sandboxLease.findMany({
    where: {
      status: "RUNNING",
      OR: [
        {
          expiresAt: {
            lte: now,
          },
        },
        {
          lastUsedAt: {
            lte: idleCutoff,
          },
        },
      ],
    },
    orderBy: [{ lastUsedAt: "asc" }, { updatedAt: "asc" }],
    take: params.limit ?? 25,
    include: {
      sandboxIdentity: {
        select: {
          representativeId: true,
          contactId: true,
        },
      },
    },
  });

  const result = {
    stopped: 0,
    failed: 0,
    skipped: 0,
  };

  for (const lease of leases) {
    try {
      const stopped = await stopSandboxLease({
        leaseId: lease.id,
        reason: "idle_timeout",
        now,
        providerFactory: params.providerFactory,
      });
      if (stopped.status === "stopped") {
        result.stopped += 1;
        recordSandboxMetric("sandbox_leases_idle_stopped_total");
      } else {
        result.skipped += 1;
      }
    } catch {
      result.failed += 1;
    }
  }

  return result;
}

export function startSandboxLeaseCleanupLoop(params: {
  intervalMs?: number | undefined;
  idleStopMinutes?: number | undefined;
  logger?: Pick<typeof console, "error"> | undefined;
} = {}) {
  const intervalMs = params.intervalMs ?? computeBrokerConfig.sandboxLifecycle.cleanupIntervalMs;
  const timer = setInterval(() => {
    void cleanupIdleSandboxLeases({
      idleStopMinutes: params.idleStopMinutes,
    }).catch((error) => {
      (params.logger ?? console).error("sandbox lease cleanup failed", error);
    });
  }, intervalMs);

  timer.unref?.();
  return timer;
}

export async function stopSandboxLease(params: {
  leaseId: string;
  sessionId?: string | null | undefined;
  reason?: string | null | undefined;
  now?: Date | undefined;
  providerFactory?: SandboxProviderFactory | undefined;
}): Promise<{ status: "stopped" | "skipped"; leaseId: string }> {
  const lease = await prisma.sandboxLease.findUnique({
    where: { id: params.leaseId },
    include: {
      sandboxIdentity: {
        select: {
          representativeId: true,
          contactId: true,
        },
      },
    },
  });

  if (!lease) {
    throw new Error("sandbox_lease_not_found");
  }

  if (lease.status === "STOPPED" || lease.status === "ARCHIVED") {
    return {
      status: "skipped",
      leaseId: lease.id,
    };
  }

  if (lease.status !== "STOPPING") {
    await prisma.sandboxLease.update({
      where: { id: lease.id },
      data: {
        status: "STOPPING",
      },
    });
  }

  const providerKind = mapSandboxProviderFromDb(lease.provider);
  const provider = params.providerFactory
    ? await params.providerFactory(providerKind)
    : await createProviderForLease(providerKind);

  try {
    await provider.stop({
      lease: buildProviderLeaseFromRecord(lease),
      sessionId: params.sessionId ?? lease.providerSandboxId ?? lease.id,
    });
    const stoppedAt = params.now ?? new Date();
    await prisma.sandboxLease.update({
      where: { id: lease.id },
      data: {
        status: "STOPPED",
        stoppedAt,
        errorReason: null,
      },
    });
    await prisma.eventAudit.create({
      data: {
        representativeId: lease.sandboxIdentity.representativeId,
        contactId: lease.sandboxIdentity.contactId,
        conversationId: null,
        type: "SANDBOX_LEASE_STOPPED",
        payload: {
          sandboxIdentityId: lease.sandboxIdentityId,
          sandboxLeaseId: lease.id,
          provider: providerKind,
          providerSandboxId: lease.providerSandboxId,
          reason: params.reason ?? "manual_stop",
        },
      },
    });
    recordSandboxMetric("sandbox_leases_stopped_total");

    return {
      status: "stopped",
      leaseId: lease.id,
    };
  } catch (error) {
    const errorReason = error instanceof Error ? error.message.slice(0, 240) : "sandbox_provider_stop_failed";
    await prisma.sandboxLease.update({
      where: { id: lease.id },
      data: {
        status: "ERROR",
        errorReason,
      },
    });
    recordSandboxMetric("sandbox_leases_errors_total");
    await prisma.eventAudit.create({
      data: {
        representativeId: lease.sandboxIdentity.representativeId,
        contactId: lease.sandboxIdentity.contactId,
        conversationId: null,
        type: "SANDBOX_LEASE_ERRORED",
        payload: {
          sandboxIdentityId: lease.sandboxIdentityId,
          sandboxLeaseId: lease.id,
          provider: providerKind,
          providerSandboxId: lease.providerSandboxId,
          reason: params.reason ?? "manual_stop",
          errorReason,
        },
      },
    });
    throw error;
  }
}

async function createProviderForLease(providerKind: "docker" | "daytona" | "tencent") {
  return createConfiguredProviderRegistry().create(providerKind);
}

export function createConfiguredProviderRegistry() {
  return new SandboxProviderRegistry({
    legacyProvider: computeBrokerConfig.sandboxProvider,
    sandboxLifecycle: computeBrokerConfig.sandboxLifecycle,
    daytona: computeBrokerConfig.daytona,
    tencent: computeBrokerConfig.tencent,
  });
}

function buildProviderLeaseFromRecord(lease: SandboxLeaseWithIdentity): SandboxProviderLease {
  const providerKind = mapSandboxProviderFromDb(lease.provider);
  const providerSandboxId = lease.providerSandboxId ?? lease.runnerLeaseId ?? lease.id;

  return {
    id: lease.id,
    provider: providerKind,
    runnerType: providerKind === "docker" ? "docker" : "vm",
    leaseId: lease.runnerLeaseId ?? providerSandboxId,
    providerSandboxId,
    containerId: lease.containerId,
    containerName: lease.containerId,
    sessionRoot: lease.sessionRoot ?? (providerKind === "docker" ? "/delegate-session" : "/workspace"),
  };
}

function buildProviderLeaseFromReservation(
  lease: {
    id: string;
    runnerLeaseId: string | null;
    providerSandboxId: string | null;
    containerId: string | null;
    sessionRoot: string | null;
  },
  providerKind: "docker" | "daytona" | "tencent",
): SandboxProviderLease {
  const providerSandboxId = lease.providerSandboxId ?? lease.runnerLeaseId ?? lease.id;
  return {
    id: lease.id,
    provider: providerKind,
    runnerType: providerKind === "docker" ? "docker" : "vm",
    leaseId: lease.runnerLeaseId ?? providerSandboxId,
    providerSandboxId,
    containerId: lease.containerId,
    containerName: lease.containerId,
    sessionRoot: lease.sessionRoot ?? (providerKind === "docker" ? "/delegate-session" : "/workspace"),
  };
}

function mapRuntimeClassToDb(value: string) {
  return value.toUpperCase() as "CODE" | "BROWSER";
}

function mapRuntimeClassFromDb(value: string) {
  return value.toLowerCase() as "code" | "browser";
}

function mapSandboxProviderFromDb(value: string) {
  return value.toLowerCase() as "docker" | "daytona" | "tencent";
}

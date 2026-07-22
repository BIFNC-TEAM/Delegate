import type {
  ComputeFilesystemMode,
  ComputeNetworkMode,
} from "@delegate/compute-protocol";

import { computeBrokerConfig } from "./config";
import { prisma } from "./prisma";
import { recordSandboxMetric } from "./sandbox-metrics";
import {
  createDockerSandboxProvider,
  createSandboxProviderFromConfig,
  type SandboxProvider,
  type SandboxProviderLease,
} from "./sandbox-provider";
import { mapRunnerTypeFromDb } from "./serializers";

type SandboxManagedSession = {
  id: string;
  representativeId: string;
  contactId: string | null;
  conversationId: string | null;
  baseImage: string;
  runnerType: string;
  expiresAt: Date | null;
};

export type EnsureUserSandboxLeaseParams = {
  session: SandboxManagedSession;
  networkMode: ComputeNetworkMode;
  filesystemMode: ComputeFilesystemMode;
  hostWorkspaceRoot?: string | undefined;
  provider: SandboxProvider;
  providerKind: "docker" | "daytona";
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
  sandboxIdentity: {
    representativeId: string;
    contactId: string;
  };
};

export type SandboxProviderFactory = (providerKind: "docker" | "daytona") => Promise<SandboxProvider>;

export async function ensureUserSandboxLease(params: EnsureUserSandboxLeaseParams) {
  if (!params.session.contactId) {
    throw new Error("sandbox_identity_requires_contact");
  }

  const now = new Date();
  const provider = mapSandboxProviderToDb(params.providerKind);
  const scopeKey = buildSandboxScopeKey(params.session.conversationId);
  const expiresAt = new Date(
    now.getTime() + (params.idleStopMinutes ?? computeBrokerConfig.sandboxLifecycle.idleStopMinutes) * 60 * 1000,
  );

  const reservation = await prisma.$transaction(async (tx) => {
    const contact = await tx.contact.findUnique({
      where: { id: params.session.contactId! },
      select: { audienceIdentityId: true },
    });
    const identity = await tx.sandboxIdentity.upsert({
      where: {
        representativeId_contactId_scopeKey: {
          representativeId: params.session.representativeId,
          contactId: params.session.contactId!,
          scopeKey,
        },
      },
      update: {
        provider,
        audienceIdentityId: contact?.audienceIdentityId ?? null,
        scopeKey,
        status: "ACTIVE",
        lastUsedAt: now,
        deletedAt: null,
      },
      create: {
        representativeId: params.session.representativeId,
        contactId: params.session.contactId!,
        scopeKey,
        audienceIdentityId: contact?.audienceIdentityId ?? null,
        provider,
        providerIdentityKey: buildProviderIdentityKey(
          params.session.representativeId,
          params.session.contactId!,
          scopeKey,
        ),
        status: "ACTIVE",
        lastUsedAt: now,
      },
    });

    const reusableLease = await tx.sandboxLease.findFirst({
      where: {
        sandboxIdentityId: identity.id,
        provider,
        networkMode: params.networkMode.toUpperCase() as "NO_NETWORK" | "ALLOWLIST" | "FULL",
        filesystemMode: params.filesystemMode.toUpperCase() as "WORKSPACE_ONLY" | "READ_ONLY_WORKSPACE" | "EPHEMERAL_FULL",
        baseImage: params.session.baseImage,
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

    return {
      identity,
      lease,
      createdLease,
      providerSandboxId: lease.providerSandboxId ?? reusableLease?.providerSandboxId ?? null,
    };
  });

  try {
    const providerLease = await params.provider.start({
      sandboxIdentityId: reservation.identity.id,
      sandboxLeaseId: reservation.lease.id,
      providerSandboxId: reservation.providerSandboxId,
      runnerType: mapRunnerTypeFromDb(params.session.runnerType),
      image: params.session.baseImage,
      hostWorkspaceRoot: params.hostWorkspaceRoot ?? computeBrokerConfig.hostWorkspaceRoot,
      networkMode: params.networkMode,
      filesystemMode: params.filesystemMode,
      sessionId: params.session.id,
    });

    const lease = await prisma.sandboxLease.update({
      where: { id: reservation.lease.id },
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
    await prisma.computeSession.update({
      where: { id: params.session.id },
      data: {
        sandboxLeaseId: lease.id,
        runnerLeaseId: providerLease.leaseId,
        containerId: providerLease.containerId,
        leaseLastUsedAt: now,
        lastHeartbeatAt: now,
      },
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
          provider: params.providerKind,
          providerSandboxId: providerLease.providerSandboxId,
          computeSessionId: params.session.id,
        },
      },
    });
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
    const errorReason = error instanceof Error ? error.message.slice(0, 240) : "sandbox_provider_start_failed";
    await prisma.sandboxLease.update({
      where: { id: reservation.lease.id },
      data: {
        status: "ERROR",
        errorReason,
      },
    });
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
          provider: params.providerKind,
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

export function mapSandboxProviderToDb(provider: "docker" | "daytona") {
  return provider.toUpperCase() as "DOCKER" | "DAYTONA";
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

async function createProviderForLease(providerKind: "docker" | "daytona") {
  if (providerKind === "docker") {
    return createDockerSandboxProvider();
  }

  const configured = await createSandboxProviderFromConfig({
    ...computeBrokerConfig,
    sandboxProvider: "daytona",
  });
  if (configured.providerKind !== "daytona") {
    throw new Error("Daytona sandbox provider is not configured.");
  }
  return configured.provider;
}

function buildProviderLeaseFromRecord(lease: SandboxLeaseWithIdentity): SandboxProviderLease {
  const providerKind = mapSandboxProviderFromDb(lease.provider);
  const providerSandboxId = lease.providerSandboxId ?? lease.runnerLeaseId ?? lease.id;

  return {
    id: lease.id,
    provider: providerKind,
    runnerType: providerKind === "daytona" ? "vm" : "docker",
    leaseId: lease.runnerLeaseId ?? providerSandboxId,
    providerSandboxId,
    containerId: lease.containerId,
    containerName: lease.containerId,
    sessionRoot: lease.sessionRoot ?? "/delegate-session",
  };
}

function mapSandboxProviderFromDb(value: string) {
  return value.toLowerCase() as "docker" | "daytona";
}

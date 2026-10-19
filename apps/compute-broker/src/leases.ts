import type { ComputeFilesystemMode, ComputeNetworkMode } from "@delegate/compute-protocol";
import type { ComputeSession } from "@prisma/client";

import { computeBrokerConfig } from "./config";
import { prisma } from "./prisma";
import { releaseRunnerLease } from "./runner";
import {
  createConfiguredProviderRegistry,
  ensureUserSandboxLease,
  stopSandboxLease,
} from "./sandbox-leases";
import { resolveProviderForNewIdentity } from "./sandbox-routing";
import { mapLeaseStatusFromDb, mapRunnerTypeFromDb } from "./serializers";
import { SessionError } from "./session-error";
import { buildTencentLeaseImage, resolveTencentSandboxTool } from "./tencent-sandbox-config";

type LeaseManagedSession = ComputeSession;

export async function ensureComputeSessionLease(params: {
  recoverMissingBrowserRuntime?: boolean;
  session: LeaseManagedSession;
  networkMode: ComputeNetworkMode;
  networkAllowlist?: readonly string[] | undefined;
  filesystemMode: ComputeFilesystemMode;
}) {
  if (
    mapLeaseStatusFromDb(params.session.leaseStatus) === "ready" &&
    params.session.runnerLeaseId &&
    params.session.containerId
  ) {
    await assertReadyComputeSessionLease(params.session, params.networkMode);
    return params.session;
  }

  if (!params.session.contactId) {
    throw new SessionError(409, "cloud_sandbox_contact_required");
  }
  return ensureSandboxBackedComputeSessionLease(params);
}

async function assertReadyComputeSessionLease(session: LeaseManagedSession, networkMode: ComputeNetworkMode) {
  const allInOneEnabled = Boolean(computeBrokerConfig.tencent.allInOneTool);
  if (computeBrokerConfig.nodeEnv !== "production" && !allInOneEnabled) return;
  if (!session.sandboxLeaseId) {
    if (computeBrokerConfig.nodeEnv === "production") {
      throw new SessionError(409, "sandbox_provider_migration_required");
    }
    return;
  }
  const lease = await prisma.sandboxLease.findUnique({
    where: { id: session.sandboxLeaseId },
    select: { provider: true, baseImage: true, networkMode: true },
  });
  if (!lease || (lease.provider === "DOCKER" && computeBrokerConfig.nodeEnv === "production")) {
    throw new SessionError(409, "sandbox_provider_migration_required");
  }
  if (lease.provider === "TENCENT" && allInOneEnabled) {
    const expectedImage = buildTencentLeaseImage({
      domain: computeBrokerConfig.tencent.domain,
      tool: resolveTencentSandboxTool(computeBrokerConfig.tencent, networkMode),
      image: session.baseImage,
    });
    if (lease.baseImage !== expectedImage || lease.networkMode !== networkMode.toUpperCase()) {
      // Do not move an existing session (and its uploaded files) to another
      // machine silently. The caller must open a fresh compute session.
      throw new SessionError(409, "sandbox_template_changed_new_session_required");
    }
  }
}

async function ensureSandboxBackedComputeSessionLease(params: {
  recoverMissingBrowserRuntime?: boolean;
  session: LeaseManagedSession;
  networkMode: ComputeNetworkMode;
  networkAllowlist?: readonly string[] | undefined;
  filesystemMode: ComputeFilesystemMode;
}) {
  const now = new Date();
  const providerRegistry = createConfiguredProviderRegistry();
  const sandbox = await ensureUserSandboxLease({
    session: params.session,
    networkMode: params.networkMode,
    networkAllowlist: params.networkAllowlist,
    filesystemMode: params.filesystemMode,
    hostWorkspaceRoot: computeBrokerConfig.hostWorkspaceRoot,
    providerFactory: (providerKind) => providerRegistry.create(providerKind),
    selectProviderForNewIdentity: () => selectProviderForNewComputeIdentity(params.session, providerRegistry),
    idleStopMinutes: computeBrokerConfig.sandboxLifecycle.idleStopMinutes,
    recoverMissingBrowserRuntime: params.recoverMissingBrowserRuntime === true,
  });

  const updated = await prisma.computeSession.update({
    where: { id: params.session.id },
    data: {
      status:
        params.session.status === "RUNNING" ? "RUNNING" : params.session.status === "COMPLETED" ? "COMPLETED" : "IDLE",
      leaseStatus: "READY",
      sandboxLeaseId: sandbox.lease.id,
      runnerLeaseId: sandbox.providerLease.leaseId,
      containerId: sandbox.providerLease.containerId,
      leaseAcquiredAt: params.session.leaseAcquiredAt ?? now,
      leaseLastUsedAt: now,
      lastHeartbeatAt: now,
      failureReason: null,
    },
  });

  await prisma.eventAudit.create({
    data: {
      representativeId: params.session.representativeId,
      contactId: params.session.contactId,
      conversationId: params.session.conversationId ?? null,
      type: "COMPUTE_SESSION_STARTED",
      payload: {
        sessionId: params.session.id,
        sandboxIdentityId: sandbox.identity.id,
        sandboxLeaseId: sandbox.lease.id,
        leaseId: sandbox.providerLease.leaseId,
        containerId: sandbox.providerLease.containerId,
        runnerType: sandbox.providerLease.runnerType,
        sandboxProvider: sandbox.providerLease.provider,
        providerSandboxId: sandbox.providerLease.providerSandboxId,
      },
    },
  });

  return updated;
}

export async function releaseComputeSessionLease(session: LeaseManagedSession) {
  if (session.sandboxLeaseId) {
    await stopSandboxLease({
      leaseId: session.sandboxLeaseId,
      sessionId: session.id,
      reason: "compute_session_release",
    });

    return prisma.computeSession.update({
      where: { id: session.id },
      data: {
        leaseStatus: "RELEASED",
        leaseReleasedAt: new Date(),
        containerId: null,
        lastHeartbeatAt: new Date(),
      },
    });
  }

  const runnerType = mapRunnerTypeFromDb(session.runnerType);
  if (runnerType !== "docker") {
    throw new Error(`Unsupported compute runner type: ${runnerType}`);
  }

  await releaseRunnerLease({
    runnerType,
    sessionId: session.id,
    leaseId: session.runnerLeaseId,
    containerId: session.containerId,
  });

  return prisma.computeSession.update({
    where: { id: session.id },
    data: {
      leaseStatus: "RELEASED",
      leaseReleasedAt: new Date(),
      containerId: null,
      lastHeartbeatAt: new Date(),
    },
  });
}

/** Shared provider routing for ordinary and exclusive execution leases. */
export async function selectProviderForNewComputeIdentity(
  session: { representativeId: string },
  providerRegistry: ReturnType<typeof createConfiguredProviderRegistry>,
) {
  if (computeBrokerConfig.sandboxRoutingMode === "legacy") {
    return {
      providerKind: providerRegistry.resolveLegacyProvider(),
      decisionSource: "legacy" as const,
      routingDigest: null,
    };
  }
  const routing = computeBrokerConfig.sandboxRouting;
  if (!routing) throw new Error("sandbox_routing_document_required");
  const representative = await prisma.representative.findUnique({
    where: { id: session.representativeId },
    select: { sandboxTestEligible: true, lifecycleState: true },
  });
  if (!representative || representative.lifecycleState === "ARCHIVED") {
    throw new Error("sandbox_routing_representative_inactive");
  }
  if (!representative.sandboxTestEligible) {
    throw new Error("sandbox_routing_representative_not_test_eligible");
  }
  const selected = resolveProviderForNewIdentity(routing, session.representativeId);
  if (!providerRegistry.configured(selected.provider)) {
    throw new Error("sandbox_provider_not_configured");
  }
  return {
    providerKind: selected.provider,
    decisionSource: selected.decisionSource,
    routingDigest: routing.digest,
  };
}

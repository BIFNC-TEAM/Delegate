import { createHash, randomBytes } from "node:crypto";
import {
  createComputeSessionRequestSchema,
  createComputeSessionResponseSchema,
} from "@delegate/compute-protocol";
import { releaseComputeSessionLease } from "./leases";
import { prisma } from "./prisma";
import { computeBrokerConfig } from "./config";
import { SessionError } from "./session-error";
import {
  mapRequestedByToDb,
  mapRunnerTypeToDb,
  mapSessionStatusFromDb,
  serializeSession,
} from "./serializers";
import { computeLifecycleHooks } from "./lifecycle-hooks";
import { closeBrowserSessionForComputeSession } from "./browser-sessions";
import { isDelegationTaskSessionContextValid } from "./delegation-task-context";
import { loadComputeRuntimeAuthority } from "./runtime-authority";

export async function createComputeSession(rawInput: unknown) {
  const input = createComputeSessionRequestSchema.parse(rawInput);
  const representative = await prisma.representative.findUnique({
    where: { id: input.representativeId },
    select: {
      id: true,
      slug: true,
      activeVersionId: true,
      computeEnabled: true,
      capabilityProfiles: {
        where: { isDefault: true },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          networkMode: true,
          filesystemMode: true,
        },
      },
    },
  });

  if (!representative) {
    throw new SessionError(404, "representative_not_found");
  }

  if (!representative.computeEnabled) {
    throw new SessionError(409, "compute_disabled_for_representative");
  }

  if (Boolean(input.delegationTaskId) !== Boolean(input.delegationTaskStepId)) {
    throw new SessionError(400, "delegation_task_and_step_must_be_provided_together");
  }
  if (input.delegationTaskId && input.delegationTaskStepId) {
    const task = await prisma.delegationTask.findUnique({
      where: { id: input.delegationTaskId },
      select: {
        representativeId: true,
        contactId: true,
        originConversationId: true,
        status: true,
        generationRuns: {
          where: { id: input.generationRunId ?? "__no_generation_run__" },
          select: { id: true },
          take: 1,
        },
        resourcePolicy: { select: { allowedCapabilities: true } },
        steps: {
          where: { id: input.delegationTaskStepId },
          select: { id: true, capability: true },
          take: 1,
        },
      },
    });
    if (!isDelegationTaskSessionContextValid({
      representativeId: input.representativeId,
      ...(input.contactId ? { contactId: input.contactId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.generationRunId ? { generationRunId: input.generationRunId } : {}),
      delegationTaskStepId: input.delegationTaskStepId,
      requestedCapabilities: input.requestedCapabilities,
    }, task)) {
      throw new SessionError(409, "delegation_task_context_mismatch");
    }
  }

  const runtimeAuthority = await loadComputeRuntimeAuthority({
    representativeId: representative.id,
    representativeSlug: representative.slug,
    activeVersionId: representative.activeVersionId,
    requestedBy: input.requestedBy,
    ...(input.contactId ? { contactId: input.contactId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.generationRunId ? { generationRunId: input.generationRunId } : {}),
    ...(input.delegationTaskId ? { delegationTaskId: input.delegationTaskId } : {}),
  });
  if (!runtimeAuthority.compute.enabled) {
    throw new SessionError(409, "compute_disabled_for_published_version");
  }
  for (const capability of input.requestedCapabilities) {
    if (runtimeAuthority.compute.capabilityModes[capability] === "deny") {
      throw new SessionError(403, `capability_not_granted_by_published_version:${capability}`);
    }
  }

  const defaultPolicyProfile = representative.capabilityProfiles[0];
  const defaultPolicyProfileId = defaultPolicyProfile?.id;
  if (!defaultPolicyProfileId || !defaultPolicyProfile) {
    throw new SessionError(409, "capability_policy_profile_missing");
  }

  if (
    input.requestedBaseImage &&
    !input.requestedCapabilities.includes("browser") &&
    input.requestedBaseImage !== runtimeAuthority.compute.baseImage
  ) {
    throw new SessionError(403, "requested_base_image_not_granted_by_published_version");
  }
  const requestedBaseImage =
    input.requestedCapabilities.includes("browser")
      ? computeBrokerConfig.browserImage
      : runtimeAuthority.compute.baseImage;
  const leaseToken = randomBytes(24).toString("hex");
  const leaseTokenHash = sha256(leaseToken);
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + runtimeAuthority.compute.maxSessionMinutes * 60 * 1000,
  );

  const session = await prisma.computeSession.create({
    data: {
      representativeId: input.representativeId,
      representativeVersionId: runtimeAuthority.representativeVersionId,
      contactId: input.contactId ?? null,
      conversationId: input.conversationId ?? null,
      generationRunId: input.generationRunId ?? null,
      delegationTaskId: input.delegationTaskId ?? null,
      delegationTaskStepId: input.delegationTaskStepId ?? null,
      subagentId: input.subagentId,
      policyProfileId: defaultPolicyProfileId,
      requestedBy: mapRequestedByToDb(input.requestedBy),
      status: "REQUESTED",
      runnerType: mapRunnerTypeToDb(computeBrokerConfig.runnerType),
      baseImage: requestedBaseImage,
      leaseTokenHash,
      expiresAt,
    },
  });

  await prisma.eventAudit.create({
    data: {
      representativeId: input.representativeId,
      contactId: input.contactId ?? null,
      conversationId: input.conversationId ?? null,
      delegationTaskId: input.delegationTaskId ?? null,
      type: "COMPUTE_SESSION_REQUESTED",
      payload: {
        requestedCapabilities: input.requestedCapabilities,
        subagentId: input.subagentId,
        requestedBy: input.requestedBy,
        reason: input.reason,
        sessionId: session.id,
        delegationTaskId: input.delegationTaskId ?? null,
        delegationTaskStepId: input.delegationTaskStepId ?? null,
        representativeVersionId: runtimeAuthority.representativeVersionId,
      },
    },
  });

  const response = createComputeSessionResponseSchema.parse({
    session: serializeSession(session),
    lease: {
      sessionId: session.id,
      status: "requested",
      leaseStatus: "requested",
      runnerType: computeBrokerConfig.runnerType,
      baseImage: session.baseImage,
      leaseToken,
      expiresAt: session.expiresAt?.toISOString(),
      leaseAcquiredAt: null,
      leaseReleasedAt: null,
    },
  });

  return response;
}

export async function getComputeSession(sessionId: string) {
  const session = await prisma.computeSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    throw new SessionError(404, "compute_session_not_found");
  }

  return serializeSession(session);
}

export async function heartbeatComputeSession(sessionId: string, reason?: string) {
  const session = await prisma.computeSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    throw new SessionError(404, "compute_session_not_found");
  }

  if (session.endedAt) {
    throw new SessionError(409, "compute_session_already_terminated");
  }

  const updated = await prisma.computeSession.update({
    where: { id: sessionId },
    data: {
      lastHeartbeatAt: new Date(),
    },
  });

  await prisma.eventAudit.create({
    data: {
      representativeId: updated.representativeId,
      contactId: updated.contactId ?? null,
      conversationId: updated.conversationId ?? null,
      delegationTaskId: updated.delegationTaskId ?? null,
      type: "COMPUTE_SESSION_HEARTBEAT",
      payload: {
        sessionId: updated.id,
        heartbeat: true,
        reason: reason ?? "lease_heartbeat",
      },
    },
  });

  return serializeSession(updated);
}

export async function terminateComputeSession(sessionId: string, reason?: string) {
  const session = await prisma.computeSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    throw new SessionError(404, "compute_session_not_found");
  }

  const endedAt = new Date();
  const stopping = await prisma.computeSession.update({
    where: { id: sessionId },
    data: {
      status: session.status === "FAILED" ? session.status : "STOPPING",
      leaseStatus:
        session.leaseStatus === "RELEASED" || session.leaseStatus === "FAILED"
          ? session.leaseStatus
          : "RELEASING",
      lastHeartbeatAt: endedAt,
    },
  });

  const released =
    session.leaseStatus === "RELEASED" || session.leaseStatus === "FAILED"
      ? stopping
      : await releaseComputeSessionLease(stopping);
  const updated = await prisma.computeSession.update({
    where: { id: sessionId },
    data: {
      status: session.status === "FAILED" ? session.status : "COMPLETED",
      endedAt,
      failureReason: session.status === "FAILED" ? session.failureReason : reason ?? session.failureReason,
    },
  });

  await closeBrowserSessionForComputeSession({
    computeSessionId: sessionId,
    reason: reason ?? "compute_session_terminated",
  });

  await prisma.eventAudit.create({
    data: {
      representativeId: updated.representativeId,
      contactId: updated.contactId ?? null,
      conversationId: updated.conversationId ?? null,
      delegationTaskId: updated.delegationTaskId ?? null,
      type: "COMPUTE_SESSION_TERMINATED",
      payload: {
        sessionId: updated.id,
        reason: reason ?? "manual_terminate",
        previousLeaseStatus: released.leaseStatus,
      },
    },
  });

  await computeLifecycleHooks.emit({
    kind: "session_ended",
    scope: {
      representativeId: updated.representativeId,
      contactId: updated.contactId ?? null,
      conversationId: updated.conversationId ?? null,
    },
    sessionId: updated.id,
    reason: reason ?? "manual_terminate",
    finalStatus: mapSessionStatusFromDb(updated.status),
  });

  return serializeSession(updated);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

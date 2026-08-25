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
import {
  isDelegationTaskSessionContextValid,
  resolveDelegationTaskSessionDurationMinutes,
} from "./delegation-task-context";
import { requireAudienceGenerationRunAuthorization } from "./entitlements";
import { lockAndFenceDelegatedGenerationWork } from "./generation-work-fence";
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
  const isDelegatedGeneration = Boolean(
    input.delegationTaskId && input.delegationTaskStepId,
  );
  if (
    isDelegatedGeneration
    && (
      !input.conversationId
      || !input.generationRunId
      || !input.generationWorkLease
    )
  ) {
    throw new SessionError(400, "delegation_generation_lease_required");
  }

  await requireAudienceGenerationRunAuthorization({
    requestedBy: input.requestedBy,
    representativeId: input.representativeId,
    ...(input.contactId ? { contactId: input.contactId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.generationRunId ? { generationRunId: input.generationRunId } : {}),
  });

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

  const sessionData = {
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
    status: "REQUESTED" as const,
    runnerType: mapRunnerTypeToDb(computeBrokerConfig.runnerType),
    baseImage: requestedBaseImage,
    leaseTokenHash,
    expiresAt,
  };
  const createAuditData = (sessionId: string) => ({
    representativeId: input.representativeId,
    contactId: input.contactId ?? null,
    conversationId: input.conversationId ?? null,
    delegationTaskId: input.delegationTaskId ?? null,
    type: "COMPUTE_SESSION_REQUESTED" as const,
    payload: {
      requestedCapabilities: input.requestedCapabilities,
      subagentId: input.subagentId,
      requestedBy: input.requestedBy,
      reason: input.reason,
      sessionId,
      delegationTaskId: input.delegationTaskId ?? null,
      delegationTaskStepId: input.delegationTaskStepId ?? null,
      representativeVersionId: runtimeAuthority.representativeVersionId,
      ...(input.generationWorkLease
        ? {
            generationOutboxId: input.generationWorkLease.outboxId,
            generationLeaseAttempt: input.generationWorkLease.leaseAttempt,
          }
        : {}),
    },
  });

  const session = isDelegatedGeneration
    ? await prisma.$transaction(async (tx) => {
        const conversationId = input.conversationId!;
        const generationRunId = input.generationRunId!;
        const delegationTaskId = input.delegationTaskId!;
        const delegationTaskStepId = input.delegationTaskStepId!;
        const generationWorkLease = input.generationWorkLease!;
        await lockAndFenceDelegatedGenerationWork(tx, {
          conversationId,
          generationRunId,
          delegationTaskId,
          ...generationWorkLease,
        });
        const task = await tx.delegationTask.findUnique({
          where: { id: delegationTaskId },
          select: {
            representativeId: true,
            contactId: true,
            originConversationId: true,
            status: true,
            generationRuns: {
              where: { delegationTaskStepId },
              orderBy: { createdAt: "desc" },
              select: {
                id: true,
                status: true,
                delegationTaskStepId: true,
              },
              take: 1,
            },
            resourcePolicy: {
              select: {
                allowedCapabilities: true,
                maxDurationMinutes: true,
              },
            },
            steps: {
              where: { id: delegationTaskStepId },
              select: { id: true, capability: true, status: true },
              take: 1,
            },
          },
        });
        if (!isDelegationTaskSessionContextValid({
          representativeId: input.representativeId,
          ...(input.contactId ? { contactId: input.contactId } : {}),
          conversationId,
          generationRunId,
          delegationTaskStepId,
          requestedCapabilities: input.requestedCapabilities,
        }, task)) {
          throw new SessionError(409, "delegation_task_context_mismatch");
        }
        const delegatedSessionDurationMinutes =
          resolveDelegationTaskSessionDurationMinutes({
            representativeMaxSessionMinutes:
              runtimeAuthority.compute.maxSessionMinutes,
            resourcePolicy: task?.resourcePolicy,
          });
        const delegatedExpiresAt = buildDelegatedSessionExpiry(
          now,
          delegatedSessionDurationMinutes,
        );
        if (delegatedExpiresAt <= now) {
          throw new SessionError(409, "delegation_task_duration_exhausted");
        }

        let existing = await tx.computeSession.findUnique({
          where: { generationOutboxId: generationWorkLease.outboxId },
        });
        if (!existing) {
          const legacySession = await tx.computeSession.findFirst({
            where: {
              generationRunId,
              delegationTaskId,
              delegationTaskStepId,
              generationOutboxId: null,
            },
            orderBy: { createdAt: "asc" },
          });
          if (legacySession) {
            existing = await tx.computeSession.update({
              where: { id: legacySession.id },
              data: {
                generationOutboxId: generationWorkLease.outboxId,
                generationLeaseAttempt: generationWorkLease.leaseAttempt,
                leaseTokenHash,
                expiresAt: resolveDelegatedSessionExpiryCeiling(
                  legacySession.expiresAt,
                  legacySession.createdAt,
                  delegatedSessionDurationMinutes,
                ),
              },
            });
          }
        }
        if (existing) {
          if (
            existing.representativeId !== input.representativeId
            || existing.contactId !== (input.contactId ?? null)
            || existing.conversationId !== conversationId
            || existing.generationRunId !== generationRunId
            || existing.delegationTaskId !== delegationTaskId
            || existing.delegationTaskStepId !== delegationTaskStepId
          ) {
            throw new SessionError(409, "generation_execution_context_mismatch");
          }
          const existingExpiresAt = resolveDelegatedSessionExpiryCeiling(
            existing.expiresAt,
            existing.createdAt,
            delegatedSessionDurationMinutes,
          );
          if (existingExpiresAt <= now) {
            throw new SessionError(409, "compute_session_expired");
          }
          return existing.generationLeaseAttempt === generationWorkLease.leaseAttempt
            && existing.leaseTokenHash === leaseTokenHash
            && existing.expiresAt?.getTime() === existingExpiresAt.getTime()
            ? existing
            : tx.computeSession.update({
                where: { id: existing.id },
                data: {
                  generationLeaseAttempt: generationWorkLease.leaseAttempt,
                  leaseTokenHash,
                  expiresAt: existingExpiresAt,
                },
              });
        }

        const created = await tx.computeSession.create({
          data: {
            ...sessionData,
            expiresAt: delegatedExpiresAt,
            generationOutboxId: generationWorkLease.outboxId,
            generationLeaseAttempt: generationWorkLease.leaseAttempt,
          },
        });
        await tx.eventAudit.create({ data: createAuditData(created.id) });
        return created;
      })
    : await prisma.computeSession.create({ data: sessionData });
  if (!isDelegatedGeneration) {
    await prisma.eventAudit.create({ data: createAuditData(session.id) });
  }

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

export async function replaceApprovedV3ExecutionSession(input: {
  executionId: string;
  approvalId: string;
  executionLeaseToken: string;
}) {
  const current = await prisma.toolExecution.findUnique({
    where: { id: input.executionId },
    include: {
      session: true,
      planAction: { include: { turnPlan: { include: { activeExecutionFence: true } } } },
    },
  });
  const approval = await prisma.approvalRequest.findUnique({
    where: { id: input.approvalId },
  });
  if (!current?.session || !current.planAction || !approval) {
    return current;
  }
  const plan = current.planAction.turnPlan;
  const fence = plan.activeExecutionFence;
  if (
    current.status !== "RUNNING"
    || current.executionLeaseToken !== input.executionLeaseToken
    || current.approvalRequestId !== input.approvalId
    || approval.status !== "APPROVED"
    || approval.toolExecutionId !== current.id
    || !fence
    || fence.activePlanId !== plan.id
    || fence.activeRevision !== plan.revision
    || fence.executionEpoch !== plan.executionEpoch
  ) {
    throw new SessionError(409, "approved_plan_action_fence_lost");
  }
  const representative = await prisma.representative.findUnique({
    where: { id: current.session.representativeId },
    select: {
      id: true,
      slug: true,
      activeVersionId: true,
      capabilityProfiles: {
        where: { isDefault: true },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true },
      },
    },
  });
  if (!representative?.capabilityProfiles[0]) {
    throw new SessionError(409, "capability_policy_profile_missing");
  }
  const runtimeAuthority = await loadComputeRuntimeAuthority({
    representativeId: representative.id,
    representativeSlug: representative.slug,
    activeVersionId: current.session.representativeVersionId
      ?? representative.activeVersionId,
    requestedBy: "audience",
    ...(current.session.contactId ? { contactId: current.session.contactId } : {}),
    ...(current.session.conversationId
      ? { conversationId: current.session.conversationId }
      : {}),
    ...(current.session.generationRunId
      ? { generationRunId: current.session.generationRunId }
      : {}),
    ...(current.session.delegationTaskId
      ? { delegationTaskId: current.session.delegationTaskId }
      : {}),
  });
  const capability = mapDbCapabilityToRuntime(current.capability);
  if (
    !runtimeAuthority.compute.enabled
    || runtimeAuthority.compute.capabilityModes[capability] === "deny"
  ) {
    throw new SessionError(403, "capability_not_granted_by_published_version");
  }
  const now = new Date();
  const leaseTokenHash = sha256(randomBytes(24).toString("hex"));
  const expiresAt = new Date(
    now.getTime() + runtimeAuthority.compute.maxSessionMinutes * 60 * 1_000,
  );
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${current.id}))
    `;
    const [stillCurrent, stillApproved] = await Promise.all([
      tx.toolExecution.findUnique({
        where: { id: current.id },
        include: {
          planAction: {
            include: {
              turnPlan: { include: { activeExecutionFence: true } },
            },
          },
        },
      }),
      tx.approvalRequest.findUnique({ where: { id: input.approvalId } }),
    ]);
    const currentPlan = stillCurrent?.planAction?.turnPlan;
    const currentFence = currentPlan?.activeExecutionFence;
    if (
      !stillCurrent
      || stillCurrent.status !== "RUNNING"
      || stillCurrent.executionLeaseToken !== input.executionLeaseToken
      || stillCurrent.approvalRequestId !== input.approvalId
      || stillApproved?.status !== "APPROVED"
      || stillApproved.toolExecutionId !== stillCurrent.id
      || !currentPlan
      || !currentFence
      || currentFence.activePlanId !== currentPlan.id
      || currentFence.activeRevision !== currentPlan.revision
      || currentFence.executionEpoch !== currentPlan.executionEpoch
    ) {
      throw new SessionError(409, "compute_execution_claim_lost");
    }
    const fresh = await tx.computeSession.create({
      data: {
        representativeId: current.session!.representativeId,
        representativeVersionId: runtimeAuthority.representativeVersionId,
        contactId: current.session!.contactId,
        conversationId: current.session!.conversationId,
        generationRunId: current.session!.generationRunId,
        delegationTaskId: current.session!.delegationTaskId,
        delegationTaskStepId: current.session!.delegationTaskStepId,
        subagentId: current.session!.subagentId,
        policyProfileId: representative.capabilityProfiles[0]!.id,
        requestedBy: current.session!.requestedBy,
        status: "REQUESTED",
        runnerType: mapRunnerTypeToDb(computeBrokerConfig.runnerType),
        baseImage: capability === "browser"
          ? computeBrokerConfig.browserImage
          : runtimeAuthority.compute.baseImage,
        leaseTokenHash,
        expiresAt,
      },
    });
    const rebound = await tx.toolExecution.update({
      where: { id: current.id },
      data: { sessionId: fresh.id },
    });
    await tx.approvalRequest.update({
      where: { id: input.approvalId },
      data: { sessionId: fresh.id },
    });
    await tx.computeSession.updateMany({
      where: { id: current.session!.id, endedAt: null },
      data: {
        status: "EXPIRED",
        endedAt: now,
        failureReason: "superseded_by_post_approval_execution_lease",
      },
    });
    await tx.eventAudit.create({
      data: {
        representativeId: fresh.representativeId,
        contactId: fresh.contactId,
        conversationId: fresh.conversationId,
        delegationTaskId: fresh.delegationTaskId,
        type: "COMPUTE_SESSION_REQUESTED",
        payload: {
          sessionId: fresh.id,
          approvalRequestId: input.approvalId,
          executionId: current.id,
          source: "post_approval_fresh_lease",
          previousSessionId: current.session!.id,
        },
      },
    });
    return rebound;
  });
}

function mapDbCapabilityToRuntime(
  capability: string,
): "exec" | "read" | "write" | "process" | "browser" | "mcp" {
  switch (capability) {
    case "READ": return "read";
    case "WRITE": return "write";
    case "PROCESS": return "process";
    case "BROWSER": return "browser";
    case "MCP": return "mcp";
    case "EXEC": return "exec";
    default: throw new SessionError(409, "approved_execution_capability_invalid");
  }
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

function resolveDelegatedSessionExpiryCeiling(
  existing: Date | null,
  createdAt: Date,
  maxDurationMinutes: number,
) {
  const ceiling = buildDelegatedSessionExpiry(
    createdAt,
    maxDurationMinutes,
  );
  return existing && existing <= ceiling ? existing : ceiling;
}

function buildDelegatedSessionExpiry(
  createdAt: Date,
  maxDurationMinutes: number,
) {
  return new Date(
    createdAt.getTime() + Math.max(0, maxDurationMinutes) * 60 * 1_000,
  );
}

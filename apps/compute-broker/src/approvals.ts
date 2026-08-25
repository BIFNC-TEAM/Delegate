import {
  approvalExpirationDedupeKey,
  getWorkflowEngineConfig,
  resolveWorkflowDispatchTarget,
  scheduleApprovalExpiration,
  shouldDispatchWorkflowViaTemporalOutbox,
} from "@delegate/workflows";
import { capabilityEffectV3Schema } from "@delegate/runtime";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { SessionError } from "./session-error";

const approvalTimeoutMinutes = parseInt(
  process.env.WORKFLOW_APPROVAL_TIMEOUT_MINUTES?.trim() || "30",
  10,
);
const workflowEngineConfig = getWorkflowEngineConfig(process.env);

type ApprovalRequestContext = {
  representativeId: string;
  contactId: string | null;
  conversationId: string | null;
  generationRunId: string | null;
  delegationTaskId: string | null;
  delegationTaskStepId: string | null;
  sessionId: string | null;
  toolExecutionId: string | null;
  subagentId: string | null;
  reason: string;
  requestedActionSummary: string;
  riskSummary: string;
  requestPayloadHash: string | null;
  matchedPolicyRuleId: string | null;
};

type ApprovalRequestParams = {
  representativeId: string;
  contactId?: string | null;
  conversationId?: string | null;
  generationRunId?: string | null;
  delegationTaskId?: string | null;
  delegationTaskStepId?: string | null;
  sessionId: string;
  executionId: string;
  subagentId: string;
  reason: string;
  requestedActionSummary: string;
  riskSummary: string;
  requestPayloadHash?: string;
  matchedPolicyRuleId?: string;
};

export async function createApprovalRequestForExecution(
  params: ApprovalRequestParams,
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const existingApproval = await tx.approvalRequest.findUnique({
        where: {
          toolExecutionId: params.executionId,
        },
      });
      if (existingApproval) {
        assertApprovalRequestContext(existingApproval, params);
        return existingApproval;
      }

      const execution = await tx.toolExecution.findUnique({
        where: { id: params.executionId },
        select: {
          planAction: { select: { inputSnapshot: true } },
        },
      });
      const maximumApprovedEffect = readPlanActionEffect(
        execution?.planAction?.inputSnapshot,
      );

      const scheduledAt = scheduleApprovalExpiration(
        new Date(),
        approvalTimeoutMinutes,
      );
      const approval = await tx.approvalRequest.create({
        data: {
          representativeId: params.representativeId,
          contactId: params.contactId ?? null,
          conversationId: params.conversationId ?? null,
          generationRunId: params.generationRunId ?? null,
          delegationTaskId: params.delegationTaskId ?? null,
          delegationTaskStepId: params.delegationTaskStepId ?? null,
          sessionId: params.sessionId,
          toolExecutionId: params.executionId,
          subagentId: params.subagentId,
          status: "PENDING",
          reason: params.reason,
          requestedActionSummary: params.requestedActionSummary,
          riskSummary: params.riskSummary,
          expiresAt: scheduledAt,
          requestPayloadHash: params.requestPayloadHash ?? null,
          matchedPolicyRuleId: params.matchedPolicyRuleId ?? null,
          maximumApprovedEffect: maximumApprovedEffect
            ? maximumApprovedEffect as Prisma.InputJsonObject
            : Prisma.JsonNull,
        },
      });

      await tx.toolExecution.update({
        where: { id: params.executionId },
        data: {
          approvalRequestId: approval.id,
        },
      });

      await tx.eventAudit.create({
        data: {
          representativeId: params.representativeId,
          contactId: params.contactId ?? null,
          conversationId: params.conversationId ?? null,
          delegationTaskId: params.delegationTaskId ?? null,
          type: "APPROVAL_REQUESTED",
          payload: {
            approvalRequestId: approval.id,
            delegationTaskId: params.delegationTaskId ?? null,
            delegationTaskStepId: params.delegationTaskStepId ?? null,
            executionId: params.executionId,
            subagentId: params.subagentId,
            reason: params.reason,
          },
        },
      });

      const dedupeKey = approvalExpirationDedupeKey(approval.id);
      const existingWorkflow = await tx.workflowRun.findUnique({
        where: {
          dedupeKey,
        },
        select: {
          id: true,
        },
      });

      if (!existingWorkflow) {
        const dispatchTarget = resolveWorkflowDispatchTarget({
          config: workflowEngineConfig,
          kind: "approval_expiration",
          representativeKey: params.representativeId,
          subjectId: approval.id,
        });
        const isTemporal =
          shouldDispatchWorkflowViaTemporalOutbox(dispatchTarget);
        const workflow = await tx.workflowRun.create({
          data: {
            representativeId: params.representativeId,
            contactId: params.contactId ?? null,
            conversationId: params.conversationId ?? null,
            delegationTaskId: params.delegationTaskId ?? null,
            approvalRequestId: approval.id,
            subagentId: params.subagentId,
            kind: "APPROVAL_EXPIRATION",
            engine: isTemporal ? "TEMPORAL" : "LOCAL_RUNNER",
            status: "QUEUED",
            ...(isTemporal
              ? {
                  enginePhase: "DISPATCH_PENDING",
                  nextWakeAt: scheduledAt,
                }
              : {}),
            dedupeKey,
            queueName: dispatchTarget.queueName,
            externalWorkflowId: dispatchTarget.externalWorkflowId,
            scheduledAt,
            input: {
              approvalId: approval.id,
              subagentId: params.subagentId,
              timeoutMinutes: approvalTimeoutMinutes,
            },
            ...(isTemporal
              ? {
                  commandOutbox: {
                    create: {
                      commandType: "START",
                      payload: {
                        source: "approval_expiration_enqueue",
                        scheduledAt: scheduledAt.toISOString(),
                      },
                    },
                  },
                }
              : {}),
          },
        });

        await tx.eventAudit.create({
          data: {
            representativeId: params.representativeId,
            contactId: params.contactId ?? null,
            conversationId: params.conversationId ?? null,
            type: "WORKFLOW_ENQUEUED",
            payload: {
              workflowRunId: workflow.id,
              workflowKind: "approval_expiration",
              approvalRequestId: approval.id,
              subagentId: params.subagentId,
              configuredEngine: dispatchTarget.configuredEngine,
              effectiveEngine: dispatchTarget.effectiveEngine,
              queueName: dispatchTarget.queueName,
              externalWorkflowId: dispatchTarget.externalWorkflowId,
              temporalReady: dispatchTarget.temporalReady,
              fallbackReason: dispatchTarget.fallbackReason,
              scheduledAt: scheduledAt.toISOString(),
            },
          },
        });
      }

      return approval;
    });
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) {
      throw error;
    }

    const existingApproval = await prisma.approvalRequest.findUnique({
      where: {
        toolExecutionId: params.executionId,
      },
    });
    if (!existingApproval) {
      throw error;
    }

    assertApprovalRequestContext(existingApproval, params);
    return existingApproval;
  }
}

function readPlanActionEffect(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = capabilityEffectV3Schema.safeParse(
    (value as Record<string, unknown>)["effect"],
  );
  return parsed.success ? parsed.data : null;
}

function assertApprovalRequestContext(
  approval: ApprovalRequestContext,
  params: ApprovalRequestParams,
) {
  const matches =
    approval.representativeId === params.representativeId &&
    approval.contactId === (params.contactId ?? null) &&
    approval.conversationId === (params.conversationId ?? null) &&
    approval.generationRunId === (params.generationRunId ?? null) &&
    approval.delegationTaskId === (params.delegationTaskId ?? null) &&
    approval.delegationTaskStepId === (params.delegationTaskStepId ?? null) &&
    approval.sessionId === params.sessionId &&
    approval.toolExecutionId === params.executionId &&
    approval.subagentId === params.subagentId &&
    approval.reason === params.reason &&
    approval.requestedActionSummary === params.requestedActionSummary &&
    approval.riskSummary === params.riskSummary &&
    approval.requestPayloadHash === (params.requestPayloadHash ?? null) &&
    approval.matchedPolicyRuleId === (params.matchedPolicyRuleId ?? null);

  if (!matches) {
    throw new SessionError(409, "approval_request_execution_context_mismatch");
  }
}

function isPrismaUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

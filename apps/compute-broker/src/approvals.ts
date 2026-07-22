import {
  approvalExpirationDedupeKey,
  getWorkflowEngineConfig,
  resolveWorkflowDispatchTarget,
  scheduleApprovalExpiration,
  shouldDispatchWorkflowViaTemporalOutbox,
} from "@delegate/workflows";
import { prisma } from "./prisma";

const approvalTimeoutMinutes = parseInt(
  process.env.WORKFLOW_APPROVAL_TIMEOUT_MINUTES?.trim() || "30",
  10,
);
const workflowEngineConfig = getWorkflowEngineConfig(process.env);

export async function createApprovalRequestForExecution(params: {
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
}) {
  return prisma.$transaction(async (tx) => {
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
      const isTemporal = shouldDispatchWorkflowViaTemporalOutbox(dispatchTarget);
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
}

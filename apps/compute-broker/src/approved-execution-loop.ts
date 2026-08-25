import { finalizeComputeApprovalConversation } from "@delegate/web-data";

import { processNextApprovedExecution } from "./executions";
import { prisma } from "./prisma";

let processing = false;

export function startApprovedExecutionLoop(input: { intervalMs?: number } = {}) {
  const intervalMs = Math.max(250, input.intervalMs ?? 750);

  const tick = async () => {
    if (processing) return;
    processing = true;
    try {
      await recoverInterruptedApprovedExecutions();
      for (let count = 0; count < 5; count += 1) {
        const processed = await processNextApprovedExecution();
        if (!processed) break;
      }
      await reconcileApprovalConversationResults();
    } catch (error) {
      console.error("approved compute execution loop failed", error);
    } finally {
      processing = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function recoverInterruptedApprovedExecutions() {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 10 * 60 * 1000);
  const stale = await prisma.toolExecution.findMany({
    where: {
      status: "RUNNING",
      approvalRequestId: { not: null },
      // V3 attempts are reconciled by their phase-aware runtime invariant
      // worker; this legacy recovery cannot distinguish pre-call from an
      // unknown external result safely.
      planActionId: null,
      AND: [
        {
          OR: [
            { startedAt: { lt: staleBefore } },
            {
              startedAt: null,
              createdAt: { lt: staleBefore },
            },
          ],
        },
        {
          session: {
            expiresAt: { lte: now },
          },
        },
      ],
    },
    select: {
      id: true,
      sessionId: true,
      executionLeaseToken: true,
    },
    take: 20,
  });
  for (const execution of stale) {
    const failed = await prisma.toolExecution.updateMany({
      where: {
        id: execution.id,
        status: "RUNNING",
        executionLeaseToken: execution.executionLeaseToken,
      },
      data: {
        status: "FAILED",
        finishedAt: now,
        executionLeaseToken: null,
      },
    });
    if (failed.count === 1 && execution.sessionId) {
      await prisma.computeSession.updateMany({
        where: { id: execution.sessionId },
        data: {
          status: "IDLE",
          failureReason: "approved_execution_result_unknown",
          lastHeartbeatAt: now,
        },
      });
    }
  }
}

export async function reconcileApprovalConversationResults() {
  const approvals = await prisma.approvalRequest.findMany({
    where: {
      status: { in: ["APPROVED", "REJECTED", "EXPIRED"] },
      generationRunId: { not: null },
      generationRun: { status: "WAITING_APPROVAL" },
    },
    orderBy: { resolvedAt: "asc" },
    take: 20,
  });

  for (const approval of approvals) {
    if (approval.status === "REJECTED" || approval.status === "EXPIRED") {
      await finalizeComputeApprovalConversation({
        approvalId: approval.id,
        outcome: approval.status === "REJECTED" ? "rejected" : "expired",
      });
      continue;
    }
    if (!approval.toolExecutionId) continue;
    const execution = await prisma.toolExecution.findUnique({
      where: { id: approval.toolExecutionId },
      select: {
        planActionId: true,
        status: true,
        actionResult: {
          select: {
            semanticOutcome: true,
            failure: true,
          },
        },
        requestedPath: true,
        session: { select: { failureReason: true } },
        artifacts: {
          select: {
            id: true,
            kind: true,
            objectKey: true,
            mimeType: true,
            sizeBytes: true,
            summary: true,
          },
        },
      },
    });
    if (!execution || !["SUCCEEDED", "FAILED", "CANCELED"].includes(execution.status)) continue;
    const v3Outcome = execution.planActionId
      ? resolveVerifiedV3ApprovalOutcome(execution)
      : null;
    if (execution.planActionId && !v3Outcome) {
      // A terminal-looking attempt without its atomic ActionResult is an
      // interrupted pre-verification state. Never publish completion.
      continue;
    }
    await finalizeComputeApprovalConversation({
      approvalId: approval.id,
      outcome: v3Outcome?.outcome
        ?? (execution.status === "SUCCEEDED"
          ? "completed"
          : execution.status === "CANCELED"
            ? "policy_denied"
            : "failed"),
      ...(v3Outcome?.failureReason || execution.session?.failureReason
        ? {
            failureReason:
              v3Outcome?.failureReason ?? execution.session?.failureReason!,
          }
        : {}),
      ...(execution.artifacts.length
        ? {
            artifacts: execution.artifacts.map((artifact) => ({
              id: artifact.id,
              kind: artifact.kind.toLowerCase(),
              objectKey: artifact.objectKey,
              mimeType: artifact.mimeType,
              sizeBytes: artifact.sizeBytes,
              summary: artifact.summary,
              ...(artifact.kind === "FILE" && execution.requestedPath
                ? { fileName: execution.requestedPath.split("/").pop() || "result.txt" }
                : {}),
            })),
          }
        : {}),
    });
  }
}

function resolveVerifiedV3ApprovalOutcome(execution: {
  status: string;
  actionResult: {
    semanticOutcome: string;
    failure: unknown;
  } | null;
}) {
  const result = execution.actionResult;
  if (!result) return null;
  if (result.semanticOutcome === "succeeded") {
    // The ActionResult transaction must converge both records. Treat an
    // inconsistent aggregate as unfinished instead of guessing success.
    return execution.status === "SUCCEEDED"
      ? { outcome: "completed" as const }
      : null;
  }
  const failureCode = readActionResultFailureCode(result.failure);
  return {
    outcome: "failed" as const,
    failureReason: result.semanticOutcome === "unknown"
      ? failureCode === "success_contract_missing"
        ? "external_tool_success_contract_missing"
        : "external_tool_semantic_outcome_unknown"
      : result.semanticOutcome === "partial"
        ? "external_tool_semantic_outcome_partial"
        : failureCode ?? "external_tool_semantic_failure",
  };
}

function readActionResultFailureCode(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const code = (value as Record<string, unknown>)["code"];
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

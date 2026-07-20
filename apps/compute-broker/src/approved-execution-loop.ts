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

async function recoverInterruptedApprovedExecutions() {
  await prisma.toolExecution.updateMany({
    where: {
      status: "RUNNING",
      approvalRequestId: { not: null },
      startedAt: null,
    },
    data: { status: "QUEUED" },
  });

  const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
  const stale = await prisma.toolExecution.findMany({
    where: {
      status: "RUNNING",
      approvalRequestId: { not: null },
      startedAt: { lt: staleBefore },
    },
    select: { id: true, sessionId: true },
    take: 20,
  });
  const now = new Date();
  for (const execution of stale) {
    const failed = await prisma.toolExecution.updateMany({
      where: { id: execution.id, status: "RUNNING" },
      data: { status: "FAILED", finishedAt: now },
    });
    if (failed.count === 1) {
      await prisma.computeSession.updateMany({
        where: { id: execution.sessionId },
        data: {
          status: "IDLE",
          failureReason: "approved_execution_interrupted",
          lastHeartbeatAt: now,
        },
      });
    }
  }
}

async function reconcileApprovalConversationResults() {
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
      select: { status: true, session: { select: { failureReason: true } } },
    });
    if (!execution || !["SUCCEEDED", "FAILED", "CANCELED"].includes(execution.status)) continue;
    await finalizeComputeApprovalConversation({
      approvalId: approval.id,
      outcome:
        execution.status === "SUCCEEDED"
          ? "completed"
          : execution.status === "CANCELED"
            ? "policy_denied"
            : "failed",
      ...(execution.session.failureReason
        ? { failureReason: execution.session.failureReason }
        : {}),
    });
  }
}

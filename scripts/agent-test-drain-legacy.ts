import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl || !/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:15432\/delegate(?:\?|$)/u.test(databaseUrl)) {
  throw new Error("DATABASE_URL must target the isolated 127.0.0.1:15432 Delegate database.");
}

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const { resolveRepresentativeComputeApproval, applyRepresentativeDelegationTaskAction } =
    await import("../packages/web-data/src/index.ts");
  try {
    const tasks = await prisma.delegationTask.findMany({
      where: { status: { notIn: ["COMPLETED", "FAILED", "CANCELED", "EXPIRED"] } },
      select: {
        id: true,
        status: true,
        representative: { select: { slug: true, ownerId: true } },
        approvalRequests: {
          where: { status: "PENDING" },
          select: { id: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    for (const task of tasks) {
      for (const approval of task.approvalRequests) {
        try {
          await resolveRepresentativeComputeApproval({
            representativeSlug: task.representative.slug,
            approvalId: approval.id,
            resolution: "rejected",
            resolvedBy: task.representative.ownerId,
            decisionNote: "Isolated Pi migration cleanup rejected stale pre-migration approval.",
          });
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "approval_request_expired")) {
            throw error;
          }
        }
      }
      const current = await prisma.delegationTask.findUnique({
        where: { id: task.id },
        select: { status: true },
      });
      if (current && !["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(current.status)) {
        await applyRepresentativeDelegationTaskAction({
          representativeSlug: task.representative.slug,
          taskId: task.id,
          action: "cancel",
          actorId: task.representative.ownerId,
          actorType: "owner",
        });
      }
    }
    const drainedAt = new Date();
    await prisma.generationRun.updateMany({
      where: {
        delegationTaskId: { in: tasks.map((task) => task.id) },
        status: { in: ["QUEUED", "PROCESSING", "WAITING_APPROVAL", "WAITING_HUMAN"] },
      },
      data: {
        status: "CANCELED",
        canceledAt: drainedAt,
        completedAt: null,
        errorCode: "pi_migration_legacy_task_drained",
        errorMessage: "Stale isolated pre-Pi task was terminalized during regression migration cleanup.",
      },
    });
    const terminalTasks = await prisma.delegationTask.findMany({
      where: { status: { in: ["COMPLETED", "FAILED", "CANCELED", "EXPIRED"] } },
      select: { id: true },
    });
    const canceledWorkflows = await prisma.workflowRun.updateMany({
      where: {
        delegationTaskId: { in: terminalTasks.map((task) => task.id) },
        status: { in: ["QUEUED", "RUNNING"] },
      },
      data: {
        status: "CANCELED",
        completedAt: drainedAt,
        lastError: "pi_migration_legacy_task_drained",
      },
    });
    process.stdout.write(
      `Drained ${tasks.length} isolated legacy task(s) and ${canceledWorkflows.count} orphaned workflow(s).\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

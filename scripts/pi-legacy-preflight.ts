import { Prisma, PrismaClient } from "@prisma/client";

const ACTIVE_PLAN_STATUSES = ["PROPOSED", "VALIDATED", "EXECUTING"] as const;
const ACTIVE_TASK_STATUSES = [
  "DRAFT",
  "CLARIFYING",
  "READY",
  "AWAITING_APPROVAL",
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_USER",
  "WAITING_FOR_OWNER",
] as const;
const ACTIVE_RUN_STATUSES = ["QUEUED", "PROCESSING", "WAITING_APPROVAL", "WAITING_HUMAN"] as const;
const ACTIVE_WORKFLOW_STATUSES = ["QUEUED", "RUNNING"] as const;

type PreflightResult = {
  checkedAt: string;
  safeToRemoveLegacyRuntime: boolean;
  blockers: Array<{ category: string; count: number }>;
  observations: {
    activeTurnPlans: number;
    activeDelegationTasks: number;
    activeDelegatedGenerationRuns: number;
    activeLegacyWorkflowRuns: number;
    pendingLegacyApprovals: number;
    activeLegacyToolExecutions: number;
    activeLegacyComputeSessions: number;
    unresolvedLegacyExternalEffects: number;
    reconciliationRequiredPlanActions: number;
    activePiGenerationRuns: number;
  };
};

function parseArgs(argv: string[]) {
  return {
    allowActive: argv.includes("--allow-active"),
  };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the read-only Pi legacy preflight.");
  }
  const { allowActive } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const observations = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const hasTurnPlans = await tableExists(tx, "ConversationTurnPlan");
      const hasDelegationTasks = await tableExists(tx, "DelegationTask");
      const hasPlanActions = await tableExists(tx, "ConversationPlanAction");
      const hasExternalEffects = await tableExists(
        tx,
        "DelegationTaskExternalEffect",
      );
      const hasGenerationTaskId = await columnExists(
        tx,
        "GenerationRun",
        "delegationTaskId",
      );
      const hasWorkflowTurnPlanId = await columnExists(tx, "WorkflowRun", "turnPlanId");
      const hasWorkflowTaskId = await columnExists(tx, "WorkflowRun", "delegationTaskId");
      const hasApprovalTaskId = await columnExists(tx, "ApprovalRequest", "delegationTaskId");
      const hasApprovalTaskStepId = await columnExists(
        tx,
        "ApprovalRequest",
        "delegationTaskStepId",
      );
      const hasToolPlanActionId = await columnExists(tx, "ToolExecution", "planActionId");
      const hasToolTaskId = await columnExists(tx, "ToolExecution", "delegationTaskId");
      const hasToolTaskStepId = await columnExists(
        tx,
        "ToolExecution",
        "delegationTaskStepId",
      );
      const hasSessionTaskId = await columnExists(tx, "ComputeSession", "delegationTaskId");
      const hasSessionTaskStepId = await columnExists(
        tx,
        "ComputeSession",
        "delegationTaskStepId",
      );
      const activeRunStatuses = sqlStringList(ACTIVE_RUN_STATUSES);

      const activeTurnPlans = hasTurnPlans
        ? await countRows(
            tx,
            `SELECT COUNT(*) AS count FROM "ConversationTurnPlan" WHERE "status"::text IN (${sqlStringList(ACTIVE_PLAN_STATUSES)})`,
          )
        : 0;
      const activeDelegationTasks = hasDelegationTasks
        ? await countRows(
            tx,
            `SELECT COUNT(*) AS count FROM "DelegationTask" WHERE "status"::text IN (${sqlStringList(ACTIVE_TASK_STATUSES)})`,
          )
        : 0;
      const activeDelegatedGenerationRuns = hasGenerationTaskId
        ? await countRows(
            tx,
            `SELECT COUNT(*) AS count FROM "GenerationRun" WHERE "delegationTaskId" IS NOT NULL AND "status"::text IN (${activeRunStatuses})`,
          )
        : 0;
      const workflowCoordinates = [
        hasWorkflowTurnPlanId ? `"turnPlanId" IS NOT NULL` : null,
        hasWorkflowTaskId ? `"delegationTaskId" IS NOT NULL` : null,
      ].filter((value): value is string => Boolean(value));
      const activeLegacyWorkflowRuns = workflowCoordinates.length
        ? await countRows(
            tx,
            `SELECT COUNT(*) AS count FROM "WorkflowRun" WHERE "status"::text IN (${sqlStringList(ACTIVE_WORKFLOW_STATUSES)}) AND (${workflowCoordinates.join(" OR ")})`,
          )
        : 0;
      const approvalCoordinates = [
        hasApprovalTaskId ? `"delegationTaskId" IS NOT NULL` : null,
        hasApprovalTaskStepId ? `"delegationTaskStepId" IS NOT NULL` : null,
      ].filter((value): value is string => Boolean(value));
      const pendingLegacyApprovals = approvalCoordinates.length
        ? await countRows(
            tx,
            `SELECT COUNT(*) AS count FROM "ApprovalRequest" WHERE "status"::text = 'PENDING' AND (${approvalCoordinates.join(" OR ")})`,
          )
        : 0;
      const executionCoordinates = [
        hasToolPlanActionId ? `"planActionId" IS NOT NULL` : null,
        hasToolTaskId ? `"delegationTaskId" IS NOT NULL` : null,
        hasToolTaskStepId ? `"delegationTaskStepId" IS NOT NULL` : null,
      ].filter((value): value is string => Boolean(value));
      const activeLegacyToolExecutions = executionCoordinates.length
        ? await countRows(
            tx,
            `SELECT COUNT(*) AS count FROM "ToolExecution" WHERE "status"::text IN ('QUEUED', 'RUNNING', 'BLOCKED') AND (${executionCoordinates.join(" OR ")})`,
          )
        : 0;
      const sessionCoordinates = [
        hasSessionTaskId ? `"delegationTaskId" IS NOT NULL` : null,
        hasSessionTaskStepId ? `"delegationTaskStepId" IS NOT NULL` : null,
      ].filter((value): value is string => Boolean(value));
      const activeLegacyComputeSessions = sessionCoordinates.length
        ? await countRows(
            tx,
            `SELECT COUNT(*) AS count FROM "ComputeSession" WHERE "endedAt" IS NULL AND (${sessionCoordinates.join(" OR ")})`,
          )
        : 0;
      const unresolvedLegacyExternalEffects = hasExternalEffects
        ? await countRows(
            tx,
            `SELECT COUNT(*) AS count FROM "DelegationTaskExternalEffect" WHERE "status"::text IN ('PROPOSED', 'WAITING_APPROVAL', 'APPROVED', 'EXECUTING', 'RECONCILIATION_REQUIRED')`,
          )
        : 0;
      const reconciliationRequiredPlanActions = hasPlanActions
        ? await countRows(
            tx,
            `SELECT COUNT(*) AS count FROM "ConversationPlanAction" WHERE "status"::text = 'RECONCILIATION_REQUIRED'`,
          )
        : 0;
      const activePiGenerationRuns = await countRows(
        tx,
        `SELECT COUNT(*) AS count FROM "GenerationRun" WHERE ${hasGenerationTaskId ? `"delegationTaskId" IS NULL AND ` : ""}"status"::text IN (${activeRunStatuses})`,
      );
      return {
        activeTurnPlans,
        activeDelegationTasks,
        activeDelegatedGenerationRuns,
        activeLegacyWorkflowRuns,
        pendingLegacyApprovals,
        activeLegacyToolExecutions,
        activeLegacyComputeSessions,
        unresolvedLegacyExternalEffects,
        reconciliationRequiredPlanActions,
        activePiGenerationRuns,
      };
    });
    const {
      activeTurnPlans,
      activeDelegationTasks,
      activeDelegatedGenerationRuns,
      activeLegacyWorkflowRuns,
      pendingLegacyApprovals,
      activeLegacyToolExecutions,
      activeLegacyComputeSessions,
      unresolvedLegacyExternalEffects,
      reconciliationRequiredPlanActions,
      activePiGenerationRuns,
    } = observations;
    const blockers = [
      ["active_turn_plans", activeTurnPlans],
      ["active_delegation_tasks", activeDelegationTasks],
      ["active_delegated_generation_runs", activeDelegatedGenerationRuns],
      ["active_legacy_workflow_runs", activeLegacyWorkflowRuns],
      ["pending_legacy_approvals", pendingLegacyApprovals],
      ["active_legacy_tool_executions", activeLegacyToolExecutions],
      ["active_legacy_compute_sessions", activeLegacyComputeSessions],
      ["unresolved_legacy_external_effects", unresolvedLegacyExternalEffects],
      ["reconciliation_required_plan_actions", reconciliationRequiredPlanActions],
    ]
      .filter((entry): entry is [string, number] => entry[1] > 0)
      .map(([category, count]) => ({ category, count }));
    const result: PreflightResult = {
      checkedAt: new Date().toISOString(),
      safeToRemoveLegacyRuntime: blockers.length === 0,
      blockers,
      observations: {
        activeTurnPlans,
        activeDelegationTasks,
        activeDelegatedGenerationRuns,
        activeLegacyWorkflowRuns,
        pendingLegacyApprovals,
        activeLegacyToolExecutions,
        activeLegacyComputeSessions,
        unresolvedLegacyExternalEffects,
        reconciliationRequiredPlanActions,
        activePiGenerationRuns,
      },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.safeToRemoveLegacyRuntime && !allowActive) {
      process.exitCode = 2;
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function tableExists(tx: Prisma.TransactionClient, table: string) {
  const rows = await tx.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = $1
        AND relation.relkind IN ('r', 'p')
    ) AS exists`,
    table,
  );
  return rows[0]?.exists === true;
}

async function columnExists(
  tx: Prisma.TransactionClient,
  table: string,
  column: string,
) {
  const rows = await tx.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = $1
        AND attribute.attname = $2
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) AS exists`,
    table,
    column,
  );
  return rows[0]?.exists === true;
}

async function countRows(tx: Prisma.TransactionClient, sql: string) {
  const rows = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(sql);
  return Number(rows[0]?.count ?? 0n);
}

function sqlStringList(values: readonly string[]) {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

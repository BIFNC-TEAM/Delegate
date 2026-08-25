import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, tx, executionState } = vi.hoisted(() => {
  const executionState = {
    status: "RUNNING",
    executionLeaseToken: "lease-token-1",
    billingFinalizedAt: null as Date | null,
    billingSnapshot: null as Record<string, unknown> | null,
    billingAdmission: null as Record<string, unknown> | null,
    planActionId: null as string | null,
  };
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    toolExecution: {
      findUnique: vi.fn(async () => ({ ...executionState })),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (
          where.status !== executionState.status
          || where.executionLeaseToken !== executionState.executionLeaseToken
          || (where.billingFinalizedAt === null && executionState.billingFinalizedAt !== null)
        ) return { count: 0 };
        executionState.billingFinalizedAt = data.billingFinalizedAt;
        executionState.billingSnapshot = data.billingSnapshot;
        return { count: 1 };
      }),
    },
    conversation: {
      update: vi.fn().mockResolvedValue({ id: "conversation-1" }),
    },
    ledgerEntry: {
      create: vi.fn().mockResolvedValue({ id: "ledger-1" }),
    },
  };
  return {
    executionState,
    tx,
    mockPrisma: {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));

describe("execution cost recording idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executionState.status = "RUNNING";
    executionState.executionLeaseToken = "lease-token-1";
    executionState.billingFinalizedAt = null;
    executionState.billingSnapshot = null;
    executionState.billingAdmission = null;
    executionState.planActionId = null;
  });

  it("replays the persisted cost summary without recording twice", async () => {
    const { recordExecutionCosts } = await import("../src/billing");
    const input = buildCostInput();
    const first = await recordExecutionCosts(input);
    const second = await recordExecutionCosts(input);

    expect(second).toEqual(first);
    expect(first).toEqual({
      computeCostCents: 2,
      browserCostCents: 0,
      providerCostCents: 0,
      mcpCostCents: 0,
      storageCostCents: 1,
    });
    expect(tx.conversation.update).toHaveBeenCalledTimes(1);
    expect(tx.ledgerEntry.create).toHaveBeenCalledTimes(2);
    expect(tx.toolExecution.updateMany).toHaveBeenCalledTimes(1);
  });

  it("refuses to record after the execution claim is lost", async () => {
    executionState.executionLeaseToken = "new-owner-token";
    const { recordExecutionCosts } = await import("../src/billing");

    await expect(recordExecutionCosts(buildCostInput())).rejects.toMatchObject({
      statusCode: 409,
      message: "compute_execution_claim_lost",
    });
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it("does not create an Action-level ledger when the GenerationRun owns billing", async () => {
    executionState.planActionId = "action-1";
    executionState.billingAdmission = {
      decision: "not_billable",
      reasonCode: "generation_run_owns_conversation_billing",
    };
    const { recordExecutionCosts } = await import("../src/billing");

    await expect(recordExecutionCosts(buildCostInput())).resolves.toEqual({
      computeCostCents: 0,
      browserCostCents: 0,
      providerCostCents: 0,
      mcpCostCents: 0,
      storageCostCents: 0,
    });
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it("fails closed when a V3 Action is missing the Generation-owned billing admission", async () => {
    executionState.planActionId = "action-1";
    const { recordExecutionCosts } = await import("../src/billing");

    await expect(recordExecutionCosts(buildCostInput())).rejects.toMatchObject({
      statusCode: 409,
      message: "v3_action_billing_admission_missing",
    });
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });
});

function buildCostInput() {
  return {
    representativeId: "representative-1",
    contactId: "contact-1",
    conversationId: "conversation-1",
    sessionId: "session-1",
    toolExecutionId: "execution-1",
    delegationTaskId: "task-1",
    computeCostCents: 2,
    browserCostCents: 0,
    providerCostCents: 0,
    mcpCostCents: 0,
    storageCostCents: 1,
    capability: "write" as const,
    wallMs: 1_000,
    artifactBytes: 128,
    finishedAt: new Date("2026-07-24T10:00:00.000Z"),
    expectedExecutionLeaseToken: "lease-token-1",
  };
}

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, tx, executionState } = vi.hoisted(() => {
  const executionState = {
    status: "RUNNING",
    executionLeaseToken: "lease-token-1",
    billingFinalizedAt: null as Date | null,
    billingSnapshot: null as Record<string, unknown> | null,
  };
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    toolExecution: {
      findUnique: vi.fn(async () => ({ ...executionState })),
      updateMany: vi.fn(async ({ where, data }: {
        where: {
          status?: string;
          executionLeaseToken?: string;
          billingFinalizedAt?: null;
        };
        data: {
          billingFinalizedAt: Date;
          billingSnapshot: Record<string, unknown>;
        };
      }) => {
        if (
          where.status !== executionState.status
          || where.executionLeaseToken !== executionState.executionLeaseToken
          || (
            where.billingFinalizedAt === null
            && executionState.billingFinalizedAt !== null
          )
        ) {
          return { count: 0 };
        }
        executionState.billingFinalizedAt = data.billingFinalizedAt;
        executionState.billingSnapshot = data.billingSnapshot;
        return { count: 1 };
      }),
    },
    conversation: {
      findUnique: vi.fn().mockResolvedValue({
        id: "conversation-1",
        computeBudgetRemainingCredits: 10,
      }),
      update: vi.fn().mockResolvedValue({ id: "conversation-1" }),
    },
    wallet: {
      findUnique: vi.fn().mockResolvedValue({
        ownerId: "owner-1",
        balanceCredits: 20,
        sponsorPoolCredit: 5,
      }),
      update: vi.fn().mockResolvedValue({ ownerId: "owner-1" }),
    },
    ledgerEntry: {
      create: vi.fn().mockResolvedValue({ id: "ledger-1" }),
    },
  };
  return {
    executionState,
    tx,
    mockPrisma: {
      $transaction: vi.fn(
        async (callback: (client: typeof tx) => unknown) => callback(tx),
      ),
    },
  };
});

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

describe("execution billing idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executionState.status = "RUNNING";
    executionState.executionLeaseToken = "lease-token-1";
    executionState.billingFinalizedAt = null;
    executionState.billingSnapshot = null;
    tx.conversation.findUnique.mockResolvedValue({
      id: "conversation-1",
      computeBudgetRemainingCredits: 10,
    });
    tx.wallet.findUnique.mockResolvedValue({
      ownerId: "owner-1",
      balanceCredits: 20,
      sponsorPoolCredit: 5,
    });
  });

  it("replays the persisted billing summary without debiting twice", async () => {
    const { applyExecutionBilling } = await import("../src/billing");
    const input = buildBillingInput();

    const first = await applyExecutionBilling(input);
    const second = await applyExecutionBilling(input);

    expect(second).toEqual(first);
    expect(tx.conversation.update).toHaveBeenCalledTimes(1);
    expect(tx.wallet.update).toHaveBeenCalledTimes(1);
    expect(tx.ledgerEntry.create).toHaveBeenCalledTimes(3);
    expect(tx.toolExecution.updateMany).toHaveBeenCalledTimes(1);
    expect(
      tx.$executeRaw.mock.calls.slice(0, 3).map((call) => call[1]),
    ).toEqual([
      "execution-1",
      "owner-1",
      "conversation-1",
    ]);
  });

  it("refuses to charge after the execution claim is lost", async () => {
    executionState.executionLeaseToken = "new-owner-token";
    const { applyExecutionBilling } = await import("../src/billing");

    await expect(
      applyExecutionBilling(buildBillingInput()),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "compute_execution_claim_lost",
    });
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
    expect(tx.wallet.update).not.toHaveBeenCalled();
  });

  it("records the uncovered remainder when available credits are partial", async () => {
    tx.conversation.findUnique.mockResolvedValue({
      id: "conversation-1",
      computeBudgetRemainingCredits: 3,
    });
    tx.wallet.findUnique.mockResolvedValue({
      ownerId: "owner-1",
      balanceCredits: 0,
      sponsorPoolCredit: 0,
    });
    const { applyExecutionBilling } = await import("../src/billing");

    const summary = await applyExecutionBilling(buildBillingInput());

    expect(summary.actualCredits).toBe(5);
    const planDebits = tx.ledgerEntry.create.mock.calls
      .map((call) => call[0].data)
      .filter((entry) => entry.kind === "PLAN_DEBIT");
    expect(planDebits).toEqual([
      expect.objectContaining({
        quantity: 3,
        creditDelta: -3,
        notes: "conversation_budget_debit",
      }),
      expect.objectContaining({
        quantity: 2,
        creditDelta: -2,
        notes: "unsettled_debit",
      }),
    ]);
  });
});

function buildBillingInput() {
  return {
    representativeId: "representative-1",
    contactId: "contact-1",
    conversationId: "conversation-1",
    sessionId: "session-1",
    toolExecutionId: "execution-1",
    delegationTaskId: "task-1",
    ownerId: "owner-1",
    computeCredits: 4,
    storageCredits: 1,
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

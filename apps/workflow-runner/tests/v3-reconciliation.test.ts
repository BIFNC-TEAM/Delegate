import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attemptFindMany: vi.fn(),
  attemptUpdateMany: vi.fn(),
  actionUpdateMany: vi.fn(),
  unitUpdateMany: vi.fn(),
  fenceFindMany: vi.fn(),
  effectUpdateMany: vi.fn(),
  outboxUpdateMany: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: {
    toolExecution: {
      findMany: mocks.attemptFindMany,
      updateMany: mocks.attemptUpdateMany,
    },
    conversationPlanAction: { updateMany: mocks.actionUpdateMany },
    billableUnit: { updateMany: mocks.unitUpdateMany },
    delegationTaskExternalEffect: { updateMany: mocks.effectUpdateMany },
    outboxEvent: { updateMany: mocks.outboxUpdateMany },
    planExecutionFence: { findMany: mocks.fenceFindMany },
  },
}));

describe("V3 runtime reconciliation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.attemptFindMany.mockResolvedValue([]);
    mocks.attemptUpdateMany.mockResolvedValue({ count: 0 });
    mocks.actionUpdateMany.mockResolvedValue({ count: 0 });
    mocks.unitUpdateMany.mockResolvedValue({ count: 0 });
    mocks.fenceFindMany.mockResolvedValue([]);
    mocks.effectUpdateMany.mockResolvedValue({ count: 0 });
    mocks.outboxUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("holds a stale call-started attempt for reconciliation instead of retrying", async () => {
    mocks.attemptFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: "attempt-started",
        planActionId: "action-1",
        executionOutboxId: "execution-outbox-1",
        externalEffectId: "effect-1",
      }]);
    mocks.attemptUpdateMany.mockResolvedValueOnce({ count: 1 });
    const { reconcileV3RuntimeInvariants } = await import("../src/v3-reconciliation");
    const summary = await reconcileV3RuntimeInvariants({
      now: new Date("2026-08-21T10:30:00Z"),
      staleBefore: new Date("2026-08-21T10:00:00Z"),
    });
    expect(summary.attemptsHeldForReconciliation).toBe(1);
    expect(mocks.attemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        attemptPhase: "OUTCOME_UNKNOWN",
        transportOutcome: "outcome_unknown",
      }),
    }));
    expect(mocks.effectUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "RECONCILIATION_REQUIRED" }),
    }));
    expect(mocks.outboxUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastError: "execution_outcome_unknown" }),
    }));
  });

  it("fails an orphaned pre-call attempt without retrying an external call", async () => {
    mocks.attemptFindMany.mockResolvedValueOnce([{ id: "attempt-1", planActionId: "action-1" }]);
    mocks.attemptUpdateMany.mockResolvedValueOnce({ count: 1 });
    const { reconcileV3RuntimeInvariants } = await import("../src/v3-reconciliation");
    const summary = await reconcileV3RuntimeInvariants({
      now: new Date("2026-08-21T10:30:00Z"),
      staleBefore: new Date("2026-08-21T10:00:00Z"),
    });
    expect(summary.attemptsClosed).toBe(1);
    expect(mocks.attemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        attemptPhase: "FAILED_BEFORE_CALL",
        transportOutcome: "confirmed_not_sent",
      }),
    }));
  });

  it("reports fence drift and holds stale reservations", async () => {
    mocks.unitUpdateMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 3 });
    mocks.fenceFindMany.mockResolvedValueOnce([{
      activeRevision: 2,
      executionEpoch: 4,
      activePlan: { revision: 3, executionEpoch: 5, status: "EXECUTING" },
    }]);
    const { reconcileV3RuntimeInvariants } = await import("../src/v3-reconciliation");
    await expect(reconcileV3RuntimeInvariants()).resolves.toMatchObject({
      pendingUnitsReleased: 2,
      unitsHeldForReconciliation: 3,
      fenceDrift: 1,
    });
  });

  it("holds a terminal attempt with no verified ActionResult for reconciliation", async () => {
    mocks.attemptFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: "attempt-terminal-gap",
        planActionId: "action-terminal-gap",
        executionOutboxId: "outbox-terminal-gap",
        externalEffectId: "effect-terminal-gap",
      }]);
    mocks.actionUpdateMany.mockResolvedValueOnce({ count: 1 });
    const { reconcileV3RuntimeInvariants } = await import("../src/v3-reconciliation");

    await expect(reconcileV3RuntimeInvariants()).resolves.toMatchObject({
      terminalAttemptsMissingResultHeld: 1,
    });
    expect(mocks.effectUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "RECONCILIATION_REQUIRED",
        failureReason: "terminal_execution_missing_verified_result",
      }),
    }));
    expect(mocks.outboxUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "PROCESSED",
        lastError: "terminal_execution_missing_verified_result",
      }),
    }));
  });
});

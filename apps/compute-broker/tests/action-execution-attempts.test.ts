import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  actionFindUnique: vi.fn(),
  actionUpdate: vi.fn(),
  planUpdateMany: vi.fn(),
  attemptFindFirst: vi.fn(),
  attemptCreate: vi.fn(),
  outboxCreate: vi.fn(),
  externalEffectUpsert: vi.fn(),
}));

vi.mock("../src/prisma", () => {
  const tx = {
    $executeRaw: mocks.executeRaw,
    conversationPlanAction: {
      findUnique: mocks.actionFindUnique,
      update: mocks.actionUpdate,
    },
    conversationTurnPlan: { updateMany: mocks.planUpdateMany },
    toolExecution: {
      findFirst: mocks.attemptFindFirst,
      create: mocks.attemptCreate,
    },
    outboxEvent: { create: mocks.outboxCreate },
    delegationTaskExternalEffect: { upsert: mocks.externalEffectUpsert },
  };
  return {
    prisma: {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx)),
    },
  };
});

describe("action execution attempt enqueue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.actionFindUnique.mockResolvedValue({
      id: "action-1",
      status: "READY",
      authorizationPhase: "PRE_EXECUTION",
      effectiveDecision: "ALLOW",
      authorizationVersion: 3,
      delegationTaskId: null,
      delegationTaskStepId: null,
      turnPlan: {
        id: "plan-1",
        protocolVersion: 3,
        revision: 2,
        executionEpoch: 4,
        shadowMode: false,
        conversationId: "conversation-1",
        status: "VALIDATED",
        activeExecutionFence: {
          activePlanId: "plan-1",
          activeRevision: 2,
          executionEpoch: 4,
        },
      },
    });
    mocks.attemptFindFirst.mockResolvedValue(null);
    mocks.outboxCreate.mockResolvedValue({ id: "outbox-execution-1" });
    mocks.attemptCreate.mockImplementation(async ({ data }) => ({ id: "attempt-1", ...data }));
    mocks.actionUpdate.mockResolvedValue({});
    mocks.externalEffectUpsert.mockResolvedValue({ id: "effect-1" });
    mocks.planUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("creates the attempt and durable outbox in one transaction", async () => {
    const { enqueueActionExecutionAttempt } = await import(
      "../src/action-execution-attempts"
    );
    const attempt = await enqueueActionExecutionAttempt({
      sessionId: "session-1",
      request: computeRequest(),
      expectedAuthorizationVersion: 3,
      billingAdmission: {
        decision: "not_billable",
        reasonCode: "generation_run_owns_conversation_billing",
      },
    });

    expect(mocks.outboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: "action_execution_attempt",
        aggregateId: "action-1",
        eventType: "action.execution.requested",
        idempotencyKey: "action.execution.requested:plan-1:4:action-1:1",
      }),
    });
    expect(mocks.attemptCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        planActionId: "action-1",
        planRevision: 2,
        executionEpoch: 4,
        attemptNumber: 1,
        attemptPhase: "CREATED",
        executionOutboxId: "outbox-execution-1",
        status: "QUEUED",
      }),
    });
    expect(attempt).toMatchObject({ id: "attempt-1", executionOutboxId: "outbox-execution-1" });
  });

  it("returns an existing current attempt instead of enqueuing twice", async () => {
    mocks.attemptFindFirst.mockResolvedValueOnce({ id: "attempt-existing" });
    const { enqueueActionExecutionAttempt } = await import(
      "../src/action-execution-attempts"
    );
    await expect(enqueueActionExecutionAttempt({
      sessionId: "session-1",
      request: computeRequest(),
      expectedAuthorizationVersion: 3,
      billingAdmission: {
        decision: "not_billable",
        reasonCode: "generation_run_owns_conversation_billing",
      },
    })).resolves.toEqual({ id: "attempt-existing" });
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
  });

  it("rejects stale plan epochs before creating an outbox", async () => {
    mocks.actionFindUnique.mockResolvedValueOnce({
      id: "action-1",
      status: "READY",
      authorizationPhase: "PRE_EXECUTION",
      effectiveDecision: "ALLOW",
      authorizationVersion: 3,
      delegationTaskId: null,
      delegationTaskStepId: null,
      turnPlan: {
        id: "plan-1",
        protocolVersion: 3,
        revision: 2,
        executionEpoch: 5,
        shadowMode: false,
        conversationId: "conversation-1",
        activeExecutionFence: {
          activePlanId: "plan-1",
          activeRevision: 2,
          executionEpoch: 5,
        },
      },
    });
    const { enqueueActionExecutionAttempt } = await import(
      "../src/action-execution-attempts"
    );
    await expect(enqueueActionExecutionAttempt({
      sessionId: "session-1",
      request: computeRequest(),
      expectedAuthorizationVersion: 3,
      billingAdmission: {
        decision: "not_billable",
        reasonCode: "generation_run_owns_conversation_billing",
      },
    })).rejects.toThrow("plan_execution_fence_lost");
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
  });

  it("requires the current pre-execution authorization projection", async () => {
    mocks.actionFindUnique.mockResolvedValueOnce({
      id: "action-1",
      status: "READY",
      authorizationPhase: "INITIAL",
      effectiveDecision: "ALLOW",
      authorizationVersion: 2,
      delegationTaskId: null,
      delegationTaskStepId: null,
      turnPlan: {
        id: "plan-1",
        protocolVersion: 3,
        revision: 2,
        executionEpoch: 4,
        shadowMode: false,
        conversationId: "conversation-1",
        activeExecutionFence: {
          activePlanId: "plan-1",
          activeRevision: 2,
          executionEpoch: 4,
        },
      },
    });
    const { enqueueActionExecutionAttempt } = await import(
      "../src/action-execution-attempts"
    );
    await expect(enqueueActionExecutionAttempt({
      sessionId: "session-1",
      request: computeRequest(),
      expectedAuthorizationVersion: 3,
      billingAdmission: {
        decision: "not_billable",
        reasonCode: "generation_run_owns_conversation_billing",
      },
    })).rejects.toThrow("pre_execution_authorization_required");
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
  });
});

function computeRequest() {
  return {
    executor: "compute" as const,
    planId: "plan-1",
    planRevision: 2,
    executionEpoch: 4,
    actionId: "action-1",
    generationRunId: "run-1",
    capabilityKey: "compute.read",
    capabilityVersion: "1",
    capabilityDefinitionHash: `sha256:${"a".repeat(64)}`,
    argumentsHash: `sha256:${"b".repeat(64)}`,
    idempotencyKey: "turn-plan:plan-1:revision:2:action:action-1",
    capability: "read" as const,
    payload: { path: "README.md" },
  };
}

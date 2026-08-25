import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAPABILITY_CANONICALIZATION_VERSION_V3,
  buildCapabilityCatalog,
  buildCapabilityCatalogV3,
  stableSha256,
  turnEnvelopeSchema,
  type CapabilityCatalogV3,
  type TurnPlanV2,
  type TurnPlanV3,
} from "@delegate/runtime";

const { mockPrisma } = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    conversationTurnPlan: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationPlanAction: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    toolExecution: { findMany: vi.fn(), updateMany: vi.fn() },
    approvalRequest: { updateMany: vi.fn() },
    delegationTaskExternalEffect: { updateMany: vi.fn() },
    messageDeliveryAttempt: { findMany: vi.fn(), updateMany: vi.fn() },
    billableUnit: { updateMany: vi.fn() },
    workflowRun: { findMany: vi.fn(), update: vi.fn() },
    workflowCommandOutbox: { create: vi.fn() },
    actionAuthorizationDecision: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    conversation: { findUnique: vi.fn() },
    message: { findUnique: vi.fn(), updateMany: vi.fn() },
    generationRun: { findUnique: vi.fn() },
    representativeVersion: { findUnique: vi.fn() },
    delegationTask: { findUnique: vi.fn() },
    outboxEvent: { findUnique: vi.fn(), updateMany: vi.fn() },
    planExecutionFence: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  };
  return {
    mockPrisma: {
      ...tx,
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx)),
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));

describe("conversation turn plan persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.$transaction.mockImplementation(async (callback) =>
      callback(mockPrisma));
    mockPrisma.conversationTurnPlan.findUnique.mockResolvedValue(null);
    mockPrisma.conversationTurnPlan.findFirst.mockResolvedValue(null);
    mockPrisma.conversationPlanAction.findFirst.mockResolvedValue(null);
    mockPrisma.conversationPlanAction.findMany.mockResolvedValue([]);
    mockPrisma.toolExecution.findMany.mockResolvedValue([]);
    mockPrisma.toolExecution.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.outboxEvent.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.approvalRequest.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.delegationTaskExternalEffect.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.messageDeliveryAttempt.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.messageDeliveryAttempt.findMany.mockResolvedValue([]);
    mockPrisma.message.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.billableUnit.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.workflowRun.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findUnique.mockResolvedValue({
      representativeId: "rep-1",
    });
    mockPrisma.message.findUnique.mockResolvedValue({
      conversationId: "conversation-1",
    });
    mockPrisma.generationRun.findUnique.mockResolvedValue({
      conversationId: "conversation-1",
      inputMessageId: "message-1",
      representativeVersionId: "version-1",
      status: "PROCESSING",
    });
    mockPrisma.representativeVersion.findUnique.mockResolvedValue({
      representativeId: "rep-1",
    });
    mockPrisma.delegationTask.findUnique.mockResolvedValue(null);
    mockPrisma.outboxEvent.findUnique.mockResolvedValue({
      aggregateType: "generation_run",
      aggregateId: "run-1",
      eventType: "generation.requested",
      status: "PROCESSING",
      attemptCount: 1,
      availableAt: new Date(Date.now() + 60_000),
    });
    mockPrisma.planExecutionFence.findUnique.mockResolvedValue(null);
    mockPrisma.planExecutionFence.upsert.mockImplementation(async ({ create, update }) => ({
      ...create,
      ...update,
    }));
    mockPrisma.conversationTurnPlan.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.conversationPlanAction.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.conversationTurnPlan.create.mockImplementation(async ({ data }) => ({
      ...data,
      actions: data.actions.create,
    }));
  });

  it("persists an immutable validated plan and capability-grounded actions", async () => {
    const catalog = buildCapabilityCatalog();
    const capability = catalog.capabilities.find(
      (candidate) => candidate.key === "artifact.generate_document",
    )!;
    const envelope = buildEnvelope(catalog);
    const plan: TurnPlanV2 = {
      protocolVersion: 2,
      planId: "plan-1",
      objective: "生成地理学习教程",
      mode: "execute",
      goals: [{ id: "goal-1", description: "生成教程", priority: 100 }],
      deliverables: [{
        id: "deliverable-1",
        kind: "artifact",
        format: "markdown",
        producedByActionIds: ["action-1"],
        completionCriteria: ["返回可下载文件"],
      }],
      uncertainties: [],
      questions: [],
      actions: [{
        id: "action-1",
        capability: {
          key: capability.key,
          version: capability.version,
          definitionHash: capability.definitionHash,
        },
        arguments: { topic: "地理学习教程", format: "markdown" },
        argumentProvenance: {
          topic: { source: "user_message", pointer: "/currentMessage/text" },
          format: { source: "user_message", pointer: "/currentMessage/text" },
        },
        dependsOn: [],
        expectedOutputSchema: capability.outputSchema,
        completionCriteria: ["生成非空文件"],
        onFailure: "stop",
      }],
    };
    const { persistConversationTurnPlan } = await import(
      "../src/conversation-turn-plans"
    );

    await persistConversationTurnPlan({
      representativeId: "rep-1",
      representativeVersionId: "version-1",
      conversationId: "conversation-1",
      generationRunId: "run-1",
      inputMessageId: "message-1",
      envelope,
      catalog,
      plan,
      plannerProvider: "openai",
      plannerModel: "test-model",
      promptVersion: "turn-planner.v2.strict.1",
      shadowMode: true,
    });

    expect(mockPrisma.conversationTurnPlan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "plan-1",
        status: "VALIDATED",
        revision: 1,
        shadowMode: true,
        planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        capabilityCatalogHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        actions: {
          create: [expect.objectContaining({
            actionKey: "action-1",
            capabilityKey: "artifact.generate_document",
            capabilityDefinitionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            argumentsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            sideEffectClass: "INTERNAL",
          })],
        },
      }),
      include: { actions: { orderBy: { sequence: "asc" } } },
    });
  });

  it("persists a V3 shadow plan without changing the active execution fence", async () => {
    const catalog = buildV3Catalog();
    const plan = buildV3Plan(catalog);
    const { persistConversationTurnPlanV3 } = await import(
      "../src/conversation-turn-plans"
    );

    await persistConversationTurnPlanV3({
      representativeId: "rep-1",
      representativeVersionId: "version-1",
      conversationId: "conversation-1",
      generationRunId: "run-1",
      inputMessageId: "message-1",
      envelope: buildEnvelope(buildCapabilityCatalog()),
      catalog,
      plan,
      plannerProvider: "openai",
      plannerModel: "test-model",
      promptVersion: "turn-planner.v3.strict.1",
      plannerProposalHash: stableSha256({ proposal: "v3" }),
      shadowMode: true,
    });

    expect(mockPrisma.conversationTurnPlan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "turn-plan-v3-1",
        schemaVersion: "turn-plan.v3",
        protocolVersion: 3,
        revision: 1,
        executionEpoch: 0,
        shadowMode: true,
        scopeKey: expect.stringMatching(/^turn-plan-scope:v1:[a-f0-9]{64}$/),
        validationPolicyVersion: "turn-plan-v3-policy.1",
        actions: {
          create: [
            expect.objectContaining({
              actionKey: "retrieve-knowledge",
              dependencyPolicy: [],
              activationPolicy: { mode: "primary" },
              failurePolicy: expect.objectContaining({ strategy: "clarify" }),
            }),
            expect.objectContaining({
              actionKey: "compose-response",
              dependsOnActionIds: [expect.stringMatching(/^cpa_/)],
              dependencyPolicy: [expect.objectContaining({
                actionId: expect.stringMatching(/^cpa_/),
                allowedStatuses: ["succeeded", "failed"],
              })],
            }),
          ],
        },
      }),
      include: { actions: { orderBy: { sequence: "asc" } } },
    });
    expect(mockPrisma.planExecutionFence.upsert).not.toHaveBeenCalled();
  });

  it("advances a V3 active execution fence only after the plan is persisted", async () => {
    const catalog = buildV3Catalog();
    const plan = buildV3Plan(catalog);
    const { persistConversationTurnPlanV3 } = await import(
      "../src/conversation-turn-plans"
    );

    await persistConversationTurnPlanV3({
      representativeId: "rep-1",
      representativeVersionId: "version-1",
      conversationId: "conversation-1",
      generationRunId: "run-1",
      inputMessageId: "message-1",
      envelope: buildEnvelope(buildCapabilityCatalog()),
      catalog,
      plan,
      plannerProvider: "openai",
      plannerModel: "test-model",
      promptVersion: "turn-planner.v3.strict.1",
      shadowMode: false,
    });

    expect(mockPrisma.planExecutionFence.upsert).toHaveBeenCalledWith({
      where: { scopeKey: expect.stringMatching(/^turn-plan-scope:v1:/) },
      create: expect.objectContaining({
        activePlanId: "turn-plan-v3-1",
        activeRevision: 1,
        executionEpoch: 1,
      }),
      update: expect.objectContaining({
        activePlanId: "turn-plan-v3-1",
        activeRevision: 1,
        executionEpoch: 1,
      }),
    });
  });

  it("supersedes pre-call work but holds call-started work for reconciliation", async () => {
    const catalog = buildV3Catalog();
    const plan = {
      ...buildV3Plan(catalog),
      planId: "turn-plan-v3-2",
      revision: 2,
    };
    mockPrisma.conversationTurnPlan.findFirst
      .mockResolvedValueOnce({ revision: 1 })
      .mockResolvedValueOnce({ id: "turn-plan-v3-old", status: "EXECUTING" });
    mockPrisma.planExecutionFence.findUnique.mockResolvedValue({
      activePlanId: "turn-plan-v3-old",
      activeRevision: 1,
      executionEpoch: 7,
    });
    mockPrisma.conversationPlanAction.findMany.mockResolvedValue([
      { id: "old-action-pre" },
      { id: "old-action-started" },
    ]);
    mockPrisma.toolExecution.findMany.mockResolvedValue([{
      id: "attempt-pre",
      planActionId: "old-action-pre",
      status: "RUNNING",
      attemptPhase: "CALL_PREPARED",
      executionOutboxId: "outbox-pre",
    }, {
      id: "attempt-started",
      planActionId: "old-action-started",
      status: "RUNNING",
      attemptPhase: "CALL_STARTED",
      executionOutboxId: "outbox-started",
    }]);
    mockPrisma.messageDeliveryAttempt.findMany.mockResolvedValue([{
      id: "delivery-pre",
      messageId: "message-pre",
      status: "PROCESSING",
      attemptPhase: "CALL_PREPARED",
      deliveryOutboxId: "delivery-outbox-pre",
      deliveryLeaseAttempt: 1,
      externalMessageId: null,
    }, {
      id: "delivery-started",
      messageId: "message-started",
      status: "PROCESSING",
      attemptPhase: "CALL_STARTED",
      deliveryOutboxId: "delivery-outbox-started",
      deliveryLeaseAttempt: 1,
      externalMessageId: null,
    }, {
      id: "delivery-accepted",
      messageId: "message-accepted",
      status: "PROVIDER_ACCEPTED",
      attemptPhase: "PROVIDER_ACCEPTED",
      deliveryOutboxId: "delivery-outbox-accepted",
      deliveryLeaseAttempt: 1,
      externalMessageId: "provider-accepted-1",
    }]);
    const { persistConversationTurnPlanV3 } = await import(
      "../src/conversation-turn-plans"
    );

    await persistConversationTurnPlanV3({
      representativeId: "rep-1",
      representativeVersionId: "version-1",
      conversationId: "conversation-1",
      generationRunId: "run-1",
      inputMessageId: "message-1",
      envelope: buildEnvelope(buildCapabilityCatalog()),
      catalog,
      plan,
      plannerProvider: "openai",
      plannerModel: "test-model",
      promptVersion: "turn-planner.v3.strict.1",
      shadowMode: false,
    });

    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["outbox-pre"] },
        eventType: "action.execution.requested",
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      },
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        lastError: "turn_plan_superseded_before_call",
      }),
    });
    expect(mockPrisma.conversationPlanAction.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-action-started"] }, status: "EXECUTING" },
      data: { status: "RECONCILIATION_REQUIRED" },
    });
    expect(mockPrisma.billableUnit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          actionId: { in: ["old-action-started"] },
          status: { in: ["RESERVED", "TRANSFERRED", "SETTLEMENT_PENDING"] },
        }),
        data: expect.objectContaining({ status: "HELD_FOR_RECONCILIATION" }),
      }),
    );
    expect(mockPrisma.messageDeliveryAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["delivery-pre"] } },
      data: expect.objectContaining({
        status: "CANCELED",
        attemptPhase: "CANCELED_BEFORE_START",
        failureCode: "turn_plan_superseded_before_delivery",
      }),
    });
    expect(mockPrisma.messageDeliveryAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["delivery-started"] } },
      data: expect.objectContaining({
        status: "RECONCILIATION_REQUIRED",
        attemptPhase: "OUTCOME_UNKNOWN",
        failureCode: "turn_plan_superseded_after_delivery_call_started",
      }),
    });
    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["delivery-outbox-pre"] },
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      },
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        lastError: "turn_plan_superseded_before_delivery",
      }),
    });
    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["delivery-outbox-started"] },
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      },
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        lastError: "turn_plan_delivery_reconciliation_required",
      }),
    });
    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["delivery-outbox-accepted"] },
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      },
      data: expect.objectContaining({
        status: "PROCESSED",
        lastError: "turn_plan_superseded_after_provider_acceptance",
      }),
    });
  });

  it("rejects a plan whose message belongs to another conversation", async () => {
    mockPrisma.message.findUnique.mockResolvedValueOnce({
      conversationId: "conversation-other",
    });
    const catalog = buildCapabilityCatalog();
    const envelope = buildEnvelope(catalog);
    const capability = catalog.capabilities.find(
      (candidate) => candidate.key === "artifact.generate_document",
    )!;
    const plan = buildDocumentPlan(capability);
    const { persistConversationTurnPlan } = await import(
      "../src/conversation-turn-plans"
    );

    await expect(persistConversationTurnPlan({
      representativeId: "rep-1",
      representativeVersionId: "version-1",
      conversationId: "conversation-1",
      generationRunId: "run-1",
      inputMessageId: "message-1",
      envelope,
      catalog,
      plan,
      plannerProvider: "openai",
      plannerModel: "test-model",
      promptVersion: "turn-planner.v2.strict.1",
      shadowMode: true,
    })).rejects.toThrow(
      "Turn plan conversation and input message coordinates do not match.",
    );
    expect(mockPrisma.conversationTurnPlan.create).not.toHaveBeenCalled();
  });

  it("rejects plan persistence after the generation work lease is lost", async () => {
    mockPrisma.outboxEvent.findUnique.mockResolvedValueOnce({
      aggregateType: "generation_run",
      aggregateId: "run-1",
      eventType: "generation.requested",
      status: "PROCESSING",
      attemptCount: 2,
      availableAt: new Date(Date.now() + 60_000),
    });
    const catalog = buildCapabilityCatalog();
    const capability = catalog.capabilities.find(
      (candidate) => candidate.key === "artifact.generate_document",
    )!;
    const { persistConversationTurnPlan } = await import(
      "../src/conversation-turn-plans"
    );

    await expect(persistConversationTurnPlan({
      representativeId: "rep-1",
      representativeVersionId: "version-1",
      conversationId: "conversation-1",
      generationRunId: "run-1",
      inputMessageId: "message-1",
      envelope: buildEnvelope(catalog),
      catalog,
      plan: buildDocumentPlan(capability),
      plannerProvider: "openai",
      plannerModel: "test-model",
      promptVersion: "turn-planner.v2.strict.1",
      shadowMode: false,
      generationWorkLease: { outboxId: "outbox-1", leaseAttempt: 1 },
    })).rejects.toThrow("generation work lease was lost");
    expect(mockPrisma.conversationTurnPlan.create).not.toHaveBeenCalled();
  });

  it("fails closed when a replay changes an already assigned plan id", async () => {
    mockPrisma.conversationTurnPlan.findUnique.mockResolvedValue({
      id: "plan-1",
      conversationId: "conversation-1",
      inputMessageId: "message-1",
      planHash: "f".repeat(64),
      requestHash: "e".repeat(64),
      revision: 1,
      status: "VALIDATED",
      actions: [],
    });
    const catalog = buildCapabilityCatalog();
    const capability = catalog.capabilities.find(
      (candidate) => candidate.key === "artifact.generate_document",
    )!;
    const { persistConversationTurnPlan } = await import(
      "../src/conversation-turn-plans"
    );

    await expect(persistConversationTurnPlan({
      representativeId: "rep-1",
      representativeVersionId: "version-1",
      conversationId: "conversation-1",
      generationRunId: "run-1",
      inputMessageId: "message-1",
      envelope: buildEnvelope(catalog),
      catalog,
      plan: buildDocumentPlan(capability),
      plannerProvider: "openai",
      plannerModel: "test-model",
      promptVersion: "turn-planner.v2.strict.1",
      shadowMode: false,
    })).rejects.toThrow("different immutable plan");
    expect(mockPrisma.conversationTurnPlan.create).not.toHaveBeenCalled();
  });

  it("keeps same-phase authorization at the strictest decision", async () => {
    mockPrisma.conversationPlanAction.findUnique.mockResolvedValue({
      id: "action-1",
      argumentsHash: "a".repeat(64),
    });
    mockPrisma.actionAuthorizationDecision.findFirst.mockResolvedValue({
      sequence: 1,
      phase: "INITIAL",
      decision: "DENY",
    });
    mockPrisma.actionAuthorizationDecision.create.mockImplementation(
      async ({ data }) => data,
    );
    const { recordConversationPlanActionAuthorization } = await import(
      "../src/conversation-turn-plans"
    );

    const decision = await recordConversationPlanActionAuthorization({
      planActionId: "action-1",
      phase: "initial",
      decision: "allow",
      reason: "late allow",
    });

    expect(decision).toMatchObject({ decision: "DENY", phase: "INITIAL" });
    expect(mockPrisma.conversationPlanAction.update).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: { status: "FAILED" },
    });
  });

  it("rejects a lower authorization phase after pre-execution review", async () => {
    mockPrisma.conversationPlanAction.findUnique.mockResolvedValue({
      id: "action-1",
      argumentsHash: "a".repeat(64),
    });
    mockPrisma.actionAuthorizationDecision.findFirst.mockResolvedValue({
      sequence: 2,
      phase: "PRE_EXECUTION",
      decision: "DENY",
    });
    const { recordConversationPlanActionAuthorization } = await import(
      "../src/conversation-turn-plans"
    );

    await expect(recordConversationPlanActionAuthorization({
      planActionId: "action-1",
      phase: "initial",
      decision: "allow",
      reason: "stale retry",
    })).rejects.toThrow("Authorization phase cannot move backwards");
    expect(mockPrisma.actionAuthorizationDecision.create).not.toHaveBeenCalled();
    expect(mockPrisma.conversationPlanAction.update).not.toHaveBeenCalled();
  });

  it("does not let a later authorization phase loosen an earlier deny", async () => {
    mockPrisma.conversationPlanAction.findUnique.mockResolvedValue({
      id: "action-1",
      argumentsHash: "a".repeat(64),
      status: "READY",
      authorizationVersion: 1,
      effectiveDecision: "DENY",
    });
    mockPrisma.actionAuthorizationDecision.findFirst.mockResolvedValue({
      sequence: 1,
      phase: "INITIAL",
      decision: "DENY",
    });
    mockPrisma.actionAuthorizationDecision.create.mockImplementation(
      async ({ data }) => data,
    );
    const { recordConversationPlanActionAuthorization } = await import(
      "../src/conversation-turn-plans"
    );

    const decision = await recordConversationPlanActionAuthorization({
      planActionId: "action-1",
      phase: "pre_execution",
      decision: "allow",
      reason: "stale approval",
      policyVersion: "policy-v2",
    });

    expect(decision).toMatchObject({
      phase: "PRE_EXECUTION",
      decision: "DENY",
    });
    expect(mockPrisma.conversationPlanAction.updateMany).toHaveBeenCalledWith({
      where: { id: "action-1", authorizationVersion: 1 },
      data: expect.objectContaining({
        authorizationPhase: "PRE_EXECUTION",
        effectiveDecision: "DENY",
        authorizationPolicyVersion: "policy-v2",
      }),
    });
  });

  it("allows an approved intent to satisfy an earlier ask in a later phase", async () => {
    mockPrisma.conversationPlanAction.findUnique.mockResolvedValue({
      id: "action-1",
      argumentsHash: "a".repeat(64),
      status: "WAITING_APPROVAL",
      authorizationVersion: 1,
      effectiveDecision: "ASK",
    });
    mockPrisma.actionAuthorizationDecision.findFirst.mockResolvedValue({
      sequence: 1,
      phase: "INITIAL",
      decision: "ASK",
    });
    mockPrisma.actionAuthorizationDecision.create.mockImplementation(
      async ({ data }) => data,
    );
    const { recordConversationPlanActionAuthorization } = await import(
      "../src/conversation-turn-plans"
    );

    const decision = await recordConversationPlanActionAuthorization({
      planActionId: "action-1",
      phase: "post_approval",
      decision: "allow",
      reason: "The immutable ActionIntent was approved.",
    });

    expect(decision).toMatchObject({
      phase: "POST_APPROVAL",
      decision: "ALLOW",
    });
    expect(mockPrisma.conversationPlanAction.updateMany).toHaveBeenCalledWith({
      where: { id: "action-1", authorizationVersion: 1 },
      data: expect.objectContaining({
        authorizationPhase: "POST_APPROVAL",
        effectiveDecision: "ALLOW",
      }),
    });
  });

  it("does not reopen a succeeded action when authorization is replayed", async () => {
    mockPrisma.conversationPlanAction.findUnique.mockResolvedValue({
      id: "action-1",
      argumentsHash: "a".repeat(64),
      status: "SUCCEEDED",
    });
    mockPrisma.actionAuthorizationDecision.findFirst.mockResolvedValue({
      sequence: 1,
      phase: "INITIAL",
      decision: "ALLOW",
    });
    mockPrisma.actionAuthorizationDecision.create.mockImplementation(
      async ({ data }) => data,
    );
    const { recordConversationPlanActionAuthorization } = await import(
      "../src/conversation-turn-plans"
    );

    await recordConversationPlanActionAuthorization({
      planActionId: "action-1",
      phase: "initial",
      decision: "allow",
      reason: "idempotent retry",
    });

    expect(mockPrisma.conversationPlanAction.update).not.toHaveBeenCalled();
  });

  it("does not reopen an executing action when initial authorization is replayed", async () => {
    mockPrisma.conversationPlanAction.findUnique.mockResolvedValue({
      id: "action-1",
      argumentsHash: "a".repeat(64),
      status: "EXECUTING",
    });
    mockPrisma.actionAuthorizationDecision.findFirst.mockResolvedValue({
      sequence: 1,
      phase: "INITIAL",
      decision: "ALLOW",
    });
    mockPrisma.actionAuthorizationDecision.create.mockImplementation(
      async ({ data }) => data,
    );
    const { recordConversationPlanActionAuthorization } = await import(
      "../src/conversation-turn-plans"
    );

    await recordConversationPlanActionAuthorization({
      planActionId: "action-1",
      phase: "initial",
      decision: "allow",
      reason: "worker retry",
    });

    expect(mockPrisma.conversationPlanAction.update).not.toHaveBeenCalled();
  });

  it("preserves reconciliation-required actions when the plan later fails", async () => {
    mockPrisma.conversationPlanAction.findFirst.mockResolvedValue({
      id: "action-reconcile",
    });
    mockPrisma.conversationPlanAction.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.conversationTurnPlan.updateMany.mockResolvedValue({ count: 1 });
    const { failConversationTurnPlan } = await import(
      "../src/conversation-turn-plans"
    );

    await expect(failConversationTurnPlan({
      planId: "plan-1",
      actionId: "action-reconcile",
      reason: "provider outcome unknown",
    })).resolves.toBe(true);

    expect(mockPrisma.conversationPlanAction.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            notIn: ["SUCCEEDED", "SKIPPED", "RECONCILIATION_REQUIRED"],
          },
        }),
      }),
    );
    expect(mockPrisma.conversationPlanAction.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          status: expect.objectContaining({
            notIn: expect.arrayContaining(["RECONCILIATION_REQUIRED"]),
          }),
        }),
      }),
    );
    expect(mockPrisma.conversationTurnPlan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "EXECUTING",
          validationResult: expect.objectContaining({
            reconciliationRequired: true,
          }),
        }),
      }),
    );
  });

  it("completes only when every action succeeded with a valid output", async () => {
    const startedAt = new Date("2026-08-17T08:00:00.000Z");
    mockPrisma.conversationTurnPlan.findUnique.mockResolvedValue({
      id: "plan-1",
      status: "VALIDATED",
      startedAt,
      actions: [{
        id: "action-1",
        status: "SUCCEEDED",
        expectedOutput: { artifactId: "artifact-1", fileName: "guide.md" },
        expectedOutputSchema: {
          type: "object",
          required: ["artifactId", "fileName"],
          properties: {
            artifactId: { type: "string" },
            fileName: { type: "string" },
          },
        },
      }],
    });
    const { completeConversationTurnPlan } = await import(
      "../src/conversation-turn-plans"
    );

    await expect(completeConversationTurnPlan({ planId: "plan-1" }))
      .resolves.toBe(true);
    expect(mockPrisma.conversationTurnPlan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ startedAt }),
      }),
    );
  });

  it("refuses completion while a required action is still ready", async () => {
    mockPrisma.conversationTurnPlan.findUnique.mockResolvedValue({
      id: "plan-1",
      status: "VALIDATED",
      startedAt: null,
      actions: [{
        id: "action-1",
        status: "READY",
        expectedOutput: null,
        expectedOutputSchema: { type: "object" },
      }],
    });
    const { completeConversationTurnPlan } = await import(
      "../src/conversation-turn-plans"
    );

    await expect(completeConversationTurnPlan({ planId: "plan-1" }))
      .rejects.toThrow("cannot complete before action action-1 succeeds");
    expect(mockPrisma.conversationTurnPlan.updateMany).not.toHaveBeenCalled();
  });

  it("refuses V3 completion when a required Goal deliverable is not satisfied", async () => {
    const plan = buildV3Plan(buildV3Catalog());
    mockPrisma.conversationTurnPlan.findUnique.mockResolvedValue({
      id: plan.planId,
      protocolVersion: 3,
      executionEpoch: 2,
      planSnapshot: plan,
      status: "EXECUTING",
      startedAt: new Date("2026-08-17T08:00:00.000Z"),
      actions: [{
        id: "action-knowledge-db",
        actionKey: "retrieve-knowledge",
        authorizationVersion: 3,
        status: "SUCCEEDED",
        expectedOutput: { status: "found", evidenceRefs: ["evidence-1"] },
        expectedOutputSchema: {
          type: "object",
          properties: {
            status: { type: "string" },
            evidenceRefs: { type: "array", items: { type: "string" } },
          },
          required: ["status", "evidenceRefs"],
          additionalProperties: false,
        },
      }],
    });
    const { completeConversationTurnPlan } = await import(
      "../src/conversation-turn-plans"
    );

    await expect(completeConversationTurnPlan({ planId: plan.planId }))
      .rejects.toThrow("goal answer-goal is waiting");
    expect(mockPrisma.conversationTurnPlan.updateMany).not.toHaveBeenCalled();
  });

  it("revalidates the persisted Composer draft against final Goal and Evidence truth", async () => {
    const plan = buildV3Plan(buildV3Catalog());
    const completedRecord = (composerOutput: unknown) => ({
      id: plan.planId,
      protocolVersion: 3,
      executionEpoch: 2,
      planSnapshot: plan,
      status: "EXECUTING",
      startedAt: new Date("2026-08-17T08:00:00.000Z"),
      actions: [{
        id: "action-knowledge-db",
        actionKey: "retrieve-knowledge",
        capabilityKey: "knowledge.retrieve_authorized",
        authorizationVersion: 3,
        status: "SUCCEEDED",
        expectedOutput: { evidenceRefs: ["evidence-1"] },
        expectedOutputSchema: plan.actions[0]!.expectedOutputSchema,
        actionResults: [{
          id: "result-knowledge",
          transportOutcome: "response_received",
          semanticOutcome: "succeeded",
          evidenceBindings: [],
        }],
      }, {
        id: "action-compose-db",
        actionKey: "compose-response",
        capabilityKey: "response.compose",
        authorizationVersion: 4,
        status: "SUCCEEDED",
        expectedOutput: composerOutput,
        expectedOutputSchema: plan.actions[1]!.expectedOutputSchema,
        actionResults: [{
          id: "result-compose",
          transportOutcome: "response_received",
          semanticOutcome: "succeeded",
          evidenceBindings: [{
            evidenceId: "evidence-1",
            evidenceClass: "authorized_knowledge",
            sourceActionId: "retrieve-knowledge",
            actionResultId: "result-knowledge",
            goalIds: ["answer-goal"],
            sourceKinds: ["public_knowledge"],
          }],
        }],
      }],
    });
    mockPrisma.conversationTurnPlan.findUnique.mockResolvedValue(completedRecord({
      segments: [{
        kind: "claim",
        goalId: "answer-goal",
        text: "已依据授权知识回答。",
        sourceClass: "authorized_knowledge",
        evidenceRefs: ["evidence-1"],
      }],
    }));
    const { completeConversationTurnPlan } = await import(
      "../src/conversation-turn-plans"
    );

    await expect(completeConversationTurnPlan({ planId: plan.planId }))
      .resolves.toBe(true);

    mockPrisma.conversationTurnPlan.findUnique.mockResolvedValue(completedRecord({
      segments: [{
        kind: "status",
        goalId: "answer-goal",
        statusCode: "goal_waiting",
      }],
    }));
    await expect(completeConversationTurnPlan({ planId: plan.planId }))
      .rejects.toThrow("final evidence validation");

    plan.goals.push({
      ...plan.goals[0]!,
      id: "answer-goal-2",
    });
    mockPrisma.conversationTurnPlan.findUnique.mockResolvedValue(completedRecord({
      segments: [{
        kind: "claim",
        text: "旧版未绑定 Goal 的回答。",
        sourceClass: "authorized_knowledge",
        evidenceRefs: ["evidence-1"],
      }],
    }));
    await expect(completeConversationTurnPlan({ planId: plan.planId }))
      .rejects.toThrow("final evidence validation");
  });

  it("closes every remaining action when the plan fails", async () => {
    mockPrisma.conversationTurnPlan.updateMany.mockResolvedValue({ count: 1 });
    const { failConversationTurnPlan } = await import(
      "../src/conversation-turn-plans"
    );

    await expect(failConversationTurnPlan({
      planId: "plan-1",
      actionId: "action-1",
      reason: "output validation failed",
    })).resolves.toBe(true);

    expect(mockPrisma.conversationPlanAction.updateMany).toHaveBeenCalledWith({
      where: {
        turnPlanId: "plan-1",
        status: {
          notIn: [
            "SUCCEEDED",
            "SKIPPED",
            "FAILED",
            "CANCELED",
            "RECONCILIATION_REQUIRED",
          ],
        },
      },
      data: {
        status: "CANCELED",
        completedAt: expect.any(Date),
      },
    });
  });
});

function buildDocumentPlan(
  capability: ReturnType<typeof buildCapabilityCatalog>["capabilities"][number],
): TurnPlanV2 {
  return {
    protocolVersion: 2,
    planId: "plan-1",
    objective: "生成地理学习教程",
    mode: "execute",
    goals: [{ id: "goal-1", description: "生成教程", priority: 100 }],
    deliverables: [],
    uncertainties: [],
    questions: [],
    actions: [{
      id: "action-1",
      capability: {
        key: capability.key,
        version: capability.version,
        definitionHash: capability.definitionHash,
      },
      arguments: { topic: "地理学习教程", format: "markdown" },
      argumentProvenance: {
        topic: { source: "user_message", pointer: "/currentMessage/text" },
        format: { source: "user_message", pointer: "/currentMessage/text" },
      },
      dependsOn: [],
      expectedOutputSchema: capability.outputSchema,
      completionCriteria: ["生成非空文件"],
      onFailure: "stop",
    }],
  };
}

function buildEnvelope(catalog: ReturnType<typeof buildCapabilityCatalog>) {
  return turnEnvelopeSchema.parse({
    currentMessage: {
      id: "message-1",
      text: "请生成一份地理学习教程，以 Markdown 文件提供",
      language: "zh",
    },
    attachments: [],
    recentTurns: [],
    conversationSummary: null,
    activeCollector: null,
    activeTask: null,
    pendingApproval: null,
    activeHandoff: null,
    actorIdentity: { contactId: "contact-1" },
    channel: { kind: "web", supportsAttachments: true },
    representativeVersion: {
      representativeId: "rep-1",
      version: "version-1",
    },
    serviceState: { available: true },
    authorizedContext: [],
    capabilitySnapshot: catalog,
  });
}

function buildV3Catalog() {
  const common = {
    version: "1",
    effect: {
      boundary: "internal" as const,
      mutation: "none" as const,
      reversibility: "not_applicable" as const,
    },
    idempotency: "naturally_idempotent" as const,
    supportedChannels: ["web"],
    requiredIdentityScopes: [],
    requiredDataScopes: [],
    tags: [],
    canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
  };
  return buildCapabilityCatalogV3([{
    ...common,
    key: "knowledge.retrieve_authorized",
    description: "Retrieve authorized evidence.",
    executor: "knowledge",
    inputSchema: closedObjectSchema({ question: { type: "string" } }, ["question"]),
    outputSchema: closedObjectSchema({ evidenceRefs: {
      type: "array",
      items: { type: "string" },
    } }, ["evidenceRefs"]),
    semantics: {
      operations: ["answer", "read", "search", "explain"],
      evidenceClasses: ["authorized_knowledge"],
      freshnessClasses: ["stable", "bounded"],
      authorityClasses: ["owner_authorized"],
      domains: ["owner knowledge"],
      aliases: ["knowledge"],
    },
  }, {
    ...common,
    key: "response.compose",
    description: "Compose a claim-bound response.",
    executor: "builtin",
    inputSchema: closedObjectSchema({}, []),
    outputSchema: closedObjectSchema({ segments: {
      type: "array",
      items: { type: "object" },
    } }, ["segments"]),
    semantics: {
      operations: ["answer", "explain", "deliver"],
      evidenceClasses: ["none", "authorized_knowledge", "capability_result"],
      freshnessClasses: ["stable", "bounded"],
      authorityClasses: ["general", "owner_authorized"],
      domains: ["response"],
      aliases: ["compose"],
    },
  }]);
}

function buildV3Plan(catalog: CapabilityCatalogV3): TurnPlanV3 {
  const knowledge = catalog.capabilities.find(
    (item) => item.key === "knowledge.retrieve_authorized",
  )!;
  const composer = catalog.capabilities.find(
    (item) => item.key === "response.compose",
  )!;
  return {
    protocolVersion: 3,
    planId: "turn-plan-v3-1",
    scopeKey: {
      kind: "generation_turn",
      conversationId: "conversation-1",
      inputMessageId: "message-1",
    },
    revision: 1,
    envelopeHash: stableSha256({ inputMessageId: "message-1" }),
    capabilityCatalogHash: catalog.catalogHash,
    capabilityCandidateSnapshotHash: `sha256:${"c".repeat(64)}`,
    validationPolicyVersion: "turn-plan-v3-policy.1",
    objective: "Answer from authorized knowledge.",
    goals: [{
      id: "answer-goal",
      objective: "Answer the current question.",
      sourcePointers: ["/currentMessage/text"],
      strategy: "knowledge",
      operation: "answer",
      semanticConfidence: 0.95,
      generalEligibility: "not_allowed",
      actionIds: ["retrieve-knowledge", "compose-response"],
      deliverableIds: ["reply"],
      evidenceRequirement: {
        kind: "authorized_knowledge",
        freshness: "bounded",
        allowedSourceKinds: ["public_knowledge"],
        citationRequired: true,
        minimumEvidenceCount: 1,
      },
      failurePolicy: {
        strategy: "clarify",
        reasonCode: "knowledge_unavailable",
      },
    }],
    actions: [{
      id: "retrieve-knowledge",
      capability: {
        key: knowledge.key,
        version: knowledge.version,
        definitionHash: knowledge.definitionHash,
      },
      arguments: { question: "请生成一份地理学习教程，以 Markdown 文件提供" },
      argumentProvenance: {
        question: { source: "user_message", pointer: "/currentMessage/text" },
      },
      dependencies: [],
      activation: { mode: "primary" },
      expectedOutputSchema: knowledge.outputSchema,
      completionCriteria: ["Authorized evidence is returned."],
      failurePolicy: {
        strategy: "clarify",
        requiredFields: ["authorized knowledge"],
      },
    }, {
      id: "compose-response",
      capability: {
        key: composer.key,
        version: composer.version,
        definitionHash: composer.definitionHash,
      },
      arguments: {},
      argumentProvenance: {},
      dependencies: [{
        actionId: "retrieve-knowledge",
        allowedStatuses: ["succeeded", "failed"],
      }],
      activation: { mode: "primary" },
      expectedOutputSchema: composer.outputSchema,
      completionCriteria: ["Every claim is bound to evidence."],
      failurePolicy: {
        strategy: "stop",
        publicMessageCode: "composition_failed",
      },
    }],
    deliverables: [{
      id: "reply",
      kind: "message",
      format: "text",
      producedByActionIds: ["compose-response"],
      completionCriteria: ["Validated message draft is ready."],
    }],
    decisionTrace: ["knowledge_required"],
  };
}

function closedObjectSchema(
  properties: Record<string, unknown>,
  required: string[],
) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  assertFallbackGroupAdmissionInTransaction,
  claimDelegatedGenerationExecution,
} from "../src/generation-work-fence";

describe("delegated generation execution fence", () => {
  it("allows only the next eligible Action in a fallback group", async () => {
    const earlier = {
      id: "fallback-1",
      status: "FAILED",
      activationPolicy: {
        mode: "on_failure",
        sourceActionId: "primary-1",
        allowedFailureCodes: ["remote_failed"],
        fallbackGroupKey: "remote-read",
        priority: 10,
      },
    };
    const current = {
      id: "fallback-2",
      turnPlanId: "plan-1",
      status: "READY",
      activationPolicy: {
        mode: "on_failure",
        sourceActionId: "primary-1",
        allowedFailureCodes: ["remote_failed"],
        fallbackGroupKey: "remote-read",
        priority: 20,
      },
    };
    const later = {
      id: "fallback-3",
      turnPlanId: "plan-1",
      status: "PLANNED",
      activationPolicy: {
        mode: "on_failure",
        sourceActionId: "primary-1",
        allowedFailureCodes: ["remote_failed"],
        fallbackGroupKey: "remote-read",
        priority: 30,
      },
    };
    const findMany = vi.fn().mockResolvedValue([earlier, current, later]);
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      conversationPlanAction: {
        findMany,
      },
    } as unknown as Prisma.TransactionClient;

    await expect(assertFallbackGroupAdmissionInTransaction(tx, current))
      .resolves.toBeUndefined();

    findMany.mockResolvedValueOnce([
      { ...earlier, status: "EXECUTING" },
      current,
      later,
    ]);
    await expect(assertFallbackGroupAdmissionInTransaction(tx, current))
      .rejects.toThrow("plan_action_fallback_group_already_claimed");

    findMany.mockResolvedValueOnce([
      earlier,
      { ...current, status: "QUEUED" },
      later,
    ]);
    await expect(assertFallbackGroupAdmissionInTransaction(tx, later))
      .rejects.toThrow("plan_action_fallback_group_already_claimed");

    findMany.mockResolvedValueOnce([
      earlier,
      { ...current, status: "FAILED" },
      later,
    ]);
    await expect(assertFallbackGroupAdmissionInTransaction(tx, later))
      .resolves.toBeUndefined();
  });

  it("lets attempt B observe attempt A's durable claim and rejects stale A on resume", async () => {
    let currentAttempt = 1;
    let persistedExecution: Record<string, unknown> | null = null;
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      persistedExecution = {
        id: "execution-1",
        ...data,
        responseSnapshot: null,
        finishedAt: null,
        exitCode: null,
        cpuMs: null,
        wallMs: null,
        bytesRead: null,
        bytesWritten: null,
        createdAt: new Date("2026-07-24T08:00:00.000Z"),
      };
      return persistedExecution;
    });
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      persistedExecution = { ...persistedExecution, ...data };
      return persistedExecution;
    });
    const tx = {
      $executeRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        if (values.includes("outbox-1")) {
          return values.includes(currentAttempt) ? 1 : 0;
        }
        return 1;
      }),
      computeSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: "session-1",
          conversationId: "conversation-1",
          generationRunId: "run-1",
          generationOutboxId: "outbox-1",
          delegationTaskId: "task-1",
          delegationTaskStepId: "step-1",
        }),
      },
      generationRun: {
        findUnique: vi.fn().mockResolvedValue({
          status: "PROCESSING",
          delegationTaskId: "task-1",
          delegationTaskStepId: "step-1",
        }),
      },
      delegationTask: {
        findUnique: vi.fn().mockResolvedValue({
          status: "RUNNING",
          steps: [{ id: "step-1", status: "RUNNING" }],
        }),
      },
      conversation: { findUnique: vi.fn().mockResolvedValue({ state: "AI_QUEUED" }) },
      toolExecution: {
        findUnique: vi.fn(async () => persistedExecution),
        findFirst: vi.fn().mockResolvedValue(null),
        create,
        update,
      },
    } as unknown as Prisma.TransactionClient;
    const base = {
      sessionId: "session-1",
      conversationId: "conversation-1",
      generationRunId: "run-1",
      delegationTaskId: "task-1",
      delegationTaskStepId: "step-1",
      outboxId: "outbox-1",
      requestPayloadHash: "request-hash",
      execution: {
        delegationTaskId: "task-1",
        delegationTaskStepId: "step-1",
        capability: "WRITE" as const,
        subagentId: "compute-agent",
        status: "RUNNING" as const,
        requestedCommand: "report",
        requestedPath: "outputs/report.txt",
        requestPayload: "{}",
        workingDirectory: null,
        mcpBindingId: null,
        policyDecision: "ALLOW" as const,
        startedAt: new Date("2026-07-24T08:00:00.000Z"),
      },
    };

    const attemptA = await claimDelegatedGenerationExecution(tx, {
      ...base,
      leaseAttempt: 1,
    });
    expect(attemptA.claimed).toBe(true);

    currentAttempt = 2;
    const attemptB = await claimDelegatedGenerationExecution(tx, {
      ...base,
      leaseAttempt: 2,
    });
    expect(attemptB).toMatchObject({
      claimed: false,
      execution: {
        id: "execution-1",
        generationLeaseAttempt: 2,
        status: "RUNNING",
      },
    });
    expect(create).toHaveBeenCalledTimes(1);

    await expect(
      claimDelegatedGenerationExecution(tx, {
        ...base,
        leaseAttempt: 1,
      }),
    ).rejects.toThrow("generation_work_lease_lost");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects a different normalized request for the same outbox", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      computeSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: "session-1",
          conversationId: "conversation-1",
          generationRunId: "run-1",
          generationOutboxId: "outbox-1",
          delegationTaskId: "task-1",
          delegationTaskStepId: "step-1",
        }),
      },
      generationRun: {
        findUnique: vi.fn().mockResolvedValue({
          status: "PROCESSING",
          delegationTaskId: "task-1",
          delegationTaskStepId: "step-1",
        }),
      },
      delegationTask: {
        findUnique: vi.fn().mockResolvedValue({
          status: "RUNNING",
          steps: [{ id: "step-1", status: "RUNNING" }],
        }),
      },
      conversation: { findUnique: vi.fn().mockResolvedValue({ state: "AI_QUEUED" }) },
      toolExecution: {
        findUnique: vi.fn().mockResolvedValue({
          id: "execution-1",
          sessionId: "session-1",
          generationLeaseAttempt: 1,
          requestPayloadHash: "original-hash",
        }),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      claimDelegatedGenerationExecution(tx, {
        sessionId: "session-1",
        conversationId: "conversation-1",
        generationRunId: "run-1",
        delegationTaskId: "task-1",
        delegationTaskStepId: "step-1",
        outboxId: "outbox-1",
        leaseAttempt: 2,
        requestPayloadHash: "different-hash",
        execution: {
          capability: "WRITE",
          status: "RUNNING",
        },
      }),
    ).rejects.toThrow("generation_execution_request_mismatch");
  });

  it("atomically admits a later V3 DAG step under the original Plan fence", async () => {
    const actionState: Record<string, unknown> = {
      id: "action-db-1",
      argumentsHash: "a".repeat(64),
      status: "PLANNED",
      authorizationPhase: null,
      effectiveDecision: null,
      authorizationVersion: 0,
    };
    let latestAuthorization: Record<string, unknown> | null = null;
    const executionCreate = vi.fn(async ({ data }) => ({ id: "execution-v3", ...data }));
    const outboxCreate = vi.fn().mockResolvedValue({ id: "execution-outbox-1" });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      computeSession: { findUnique: vi.fn().mockResolvedValue({
        id: "session-1",
        conversationId: "conversation-1",
        generationRunId: "run-step-2",
        generationOutboxId: "generation-outbox-1",
        delegationTaskId: "task-1",
        delegationTaskStepId: "step-1",
      }) },
      generationRun: { findUnique: vi.fn().mockResolvedValue({
        status: "PROCESSING",
        delegationTaskId: "task-1",
        delegationTaskStepId: "step-1",
      }) },
      delegationTask: { findUnique: vi.fn().mockResolvedValue({
        status: "RUNNING",
        steps: [{ id: "step-1", status: "RUNNING" }],
      }) },
      conversation: { findUnique: vi.fn().mockResolvedValue({ state: "AI_QUEUED" }) },
      conversationPlanAction: {
        findMany: vi.fn().mockResolvedValue([{
          ...actionState,
          capabilityKey: "mcp.crm.lookup",
          turnPlan: {
            id: "plan-1",
            conversationId: "conversation-1",
            generationRunId: "run-plan-origin",
            delegationTaskId: "task-1",
            revision: 2,
            executionEpoch: 7,
            activeExecutionFence: {
              activePlanId: "plan-1",
              activeRevision: 2,
              executionEpoch: 7,
            },
          },
          externalEffects: [{ id: "effect-1" }],
        }]),
        findUnique: vi.fn(async () => ({ ...actionState })),
        updateMany: vi.fn(async ({ data }) => {
          if (data.authorizationVersion?.increment) {
            actionState.authorizationVersion = Number(actionState.authorizationVersion) + 1;
            actionState.authorizationPhase = data.authorizationPhase;
            actionState.effectiveDecision = data.effectiveDecision;
          }
          return { count: 1 };
        }),
        update: vi.fn(async ({ data }) => {
          Object.assign(actionState, data);
          return { ...actionState };
        }),
      },
      actionAuthorizationDecision: {
        findFirst: vi.fn(async () => latestAuthorization),
        create: vi.fn(async ({ data }) => {
          latestAuthorization = data;
          return data;
        }),
      },
      toolExecution: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: executionCreate,
      },
      outboxEvent: { create: outboxCreate },
      conversationTurnPlan: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      delegationTaskExternalEffect: { update: vi.fn().mockResolvedValue({}) },
    } as unknown as Prisma.TransactionClient;

    const admitted = await claimDelegatedGenerationExecution(tx, {
      sessionId: "session-1",
      conversationId: "conversation-1",
      generationRunId: "run-step-2",
      delegationTaskId: "task-1",
      delegationTaskStepId: "step-1",
      outboxId: "generation-outbox-1",
      leaseAttempt: 1,
      requestPayloadHash: "request-hash",
      authorization: {
        decision: "allow",
        reason: "policy allowed",
        policyVersion: "policy-1",
      },
      execution: {
        capability: "MCP",
        status: "RUNNING",
        executionLeaseToken: "execution-lease-1",
      },
    });

    expect(admitted.claimed).toBe(true);
    expect(outboxCreate).toHaveBeenCalledOnce();
    expect(executionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        planActionId: "action-db-1",
        planRevision: 2,
        executionEpoch: 7,
        attemptPhase: "CALL_PREPARED",
        executionOutboxId: "execution-outbox-1",
        externalEffectId: "effect-1",
        billingAdmission: {
          decision: "not_billable",
          reasonCode: "generation_run_owns_conversation_billing",
        },
        executionLeaseToken: "execution-lease-1",
      }),
    });
    expect(latestAuthorization).toMatchObject({
      phase: "PRE_EXECUTION",
      decision: "ALLOW",
      sequence: 2,
    });
    expect(actionState.status).toBe("EXECUTING");
  });
});

import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { claimDelegatedGenerationExecution } from "../src/generation-work-fence";

describe("delegated generation execution fence", () => {
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
});

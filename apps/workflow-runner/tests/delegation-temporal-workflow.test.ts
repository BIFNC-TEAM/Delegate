import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  activity,
  handlers,
  condition,
} = vi.hoisted(() => ({
  activity: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>(),
  condition: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => ({
    executeWorkflowRunActivity: vi.fn(),
    executeDelegationExecutionTransitionActivity: activity,
  }),
  condition,
  defineSignal: (name: string) => name,
  setHandler: (name: string, handler: (payload: unknown) => void) => {
    handlers.set(name, handler);
  },
  sleep: vi.fn(),
}));

import {
  DELEGATION_APPROVAL_SIGNAL,
} from "@delegate/workflows";
import { runDelegationExecutionWorkflow } from "../src/temporal/workflows";

describe("Temporal delegation execution workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
  });

  it("wakes on approval and persists every transition through an idempotent activity", async () => {
    activity
      .mockResolvedValueOnce({
        workflowRunId: "workflow-1",
        delegationTaskId: "task-1",
        phase: "waiting_approval",
        revision: 1,
        lastTransitionId: "bootstrap:0",
      })
      .mockResolvedValueOnce({
        workflowRunId: "workflow-1",
        delegationTaskId: "task-1",
        phase: "completed",
        revision: 2,
        lastTransitionId: "signal:approval:approval-1:approved",
      });
    condition.mockImplementation(async () => {
      const duplicateDelivery = {
        signalId: "approval:approval-1:approved",
        kind: "approval_resolved",
        approvalId: "approval-1",
        resolution: "approved",
        occurredAt: "2026-08-17T08:00:00.000Z",
      } as const;
      handlers.get(DELEGATION_APPROVAL_SIGNAL)?.(duplicateDelivery);
      // Temporal Signal delivery is at-least-once from the DB outbox. The
      // workflow must collapse a dispatcher retry before invoking activity.
      handlers.get(DELEGATION_APPROVAL_SIGNAL)?.(duplicateDelivery);
      return true;
    });

    await runDelegationExecutionWorkflow({
      workflowRunId: "workflow-1",
      delegationTaskId: "task-1",
    });

    expect(activity).toHaveBeenNthCalledWith(1, {
      workflowRunId: "workflow-1",
      delegationTaskId: "task-1",
      transitionId: "bootstrap:0",
    });
    expect(activity).toHaveBeenNthCalledWith(2, {
      workflowRunId: "workflow-1",
      delegationTaskId: "task-1",
      transitionId: "signal:approval:approval-1:approved",
      signal: expect.objectContaining({
        signalId: "approval:approval-1:approved",
        kind: "approval_resolved",
        approvalId: "approval-1",
      }),
    });
    expect(activity).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { executeWorkflowRunActivity, sleep } = vi.hoisted(() => ({
  executeWorkflowRunActivity: vi.fn(),
  sleep: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => ({
    executeWorkflowRunActivity,
  }),
  sleep,
}));

import { runDelegateWorkflowRun } from "../src/temporal/workflows";

describe("Temporal native timer workflow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T10:00:00.000Z"));
    vi.clearAllMocks();
    sleep.mockResolvedValue(undefined);
    executeWorkflowRunActivity.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("durably sleeps until a future scheduledAt before running the activity", async () => {
    await runDelegateWorkflowRun({
      workflowRunId: "workflow-future",
      scheduledAt: "2026-04-05T10:05:00.000Z",
    });

    expect(sleep).toHaveBeenCalledWith(5 * 60 * 1000);
    expect(executeWorkflowRunActivity).toHaveBeenCalledWith("workflow-future");
  });

  it("runs the activity immediately when scheduledAt is already due", async () => {
    await runDelegateWorkflowRun({
      workflowRunId: "workflow-past-due",
      scheduledAt: "2026-04-05T09:59:00.000Z",
    });

    expect(sleep).not.toHaveBeenCalled();
    expect(executeWorkflowRunActivity).toHaveBeenCalledWith("workflow-past-due");
  });

  it("keeps retries and late wake-ups DB-driven by passing only the workflow run id to the activity", async () => {
    const input = {
      workflowRunId: "workflow-retry",
      scheduledAt: "2026-04-05T09:55:00.000Z",
    };

    await runDelegateWorkflowRun(input);
    await runDelegateWorkflowRun(input);

    expect(sleep).not.toHaveBeenCalled();
    expect(executeWorkflowRunActivity).toHaveBeenNthCalledWith(1, "workflow-retry");
    expect(executeWorkflowRunActivity).toHaveBeenNthCalledWith(2, "workflow-retry");
  });
});

import { describe, expect, it } from "vitest";

import {
  approvalExpirationDedupeKey,
  buildWorkflowExternalId,
  getWorkflowEngineConfig,
  handoffFollowUpDedupeKey,
  isWorkflowEnginePhaseTerminal,
  isWorkflowTerminal,
  LOCAL_WORKFLOW_QUEUE,
  resolveWorkflowDispatchTarget,
  scheduleApprovalExpiration,
  scheduleHandoffFollowUp,
  shouldDispatchWorkflowViaTemporalOutbox,
  temporalWorkflowRunInputSchema,
  workflowEnginePhaseSchema,
} from "../src/index";

describe("workflow helpers", () => {
  it("builds stable dedupe keys", () => {
    expect(handoffFollowUpDedupeKey("handoff_123")).toBe("handoff_follow_up:handoff_123");
    expect(approvalExpirationDedupeKey("approval_123")).toBe("approval_expiration:approval_123");
  });

  it("schedules handoff follow-up in hours", () => {
    const now = new Date("2026-03-25T10:00:00.000Z");

    expect(scheduleHandoffFollowUp(now, 24).toISOString()).toBe("2026-03-26T10:00:00.000Z");
  });

  it("schedules approval expiration in minutes", () => {
    const now = new Date("2026-03-25T10:00:00.000Z");

    expect(scheduleApprovalExpiration(now, 45).toISOString()).toBe("2026-03-25T10:45:00.000Z");
  });

  it("knows which workflow statuses are terminal", () => {
    expect(isWorkflowTerminal("queued")).toBe(false);
    expect(isWorkflowTerminal("running")).toBe(false);
    expect(isWorkflowTerminal("completed")).toBe(true);
    expect(isWorkflowTerminal("failed")).toBe(true);
    expect(isWorkflowTerminal("canceled")).toBe(true);
  });

  it("parses the workflow engine phases used for Temporal-native state modeling", () => {
    expect(workflowEnginePhaseSchema.parse("dispatch_pending")).toBe("dispatch_pending");
    expect(workflowEnginePhaseSchema.parse("waiting_timer")).toBe("waiting_timer");
    expect(workflowEnginePhaseSchema.parse("cancel_requested")).toBe("cancel_requested");
  });

  it("knows which workflow engine phases are terminal", () => {
    expect(isWorkflowEnginePhaseTerminal("dispatch_pending")).toBe(false);
    expect(isWorkflowEnginePhaseTerminal("waiting_timer")).toBe(false);
    expect(isWorkflowEnginePhaseTerminal("activity_running")).toBe(false);
    expect(isWorkflowEnginePhaseTerminal("completed")).toBe(true);
    expect(isWorkflowEnginePhaseTerminal("failed")).toBe(true);
    expect(isWorkflowEnginePhaseTerminal("canceled")).toBe(true);
  });

  it("falls back to the local runner when Temporal is not fully configured", () => {
    const config = getWorkflowEngineConfig({
      WORKFLOW_ENGINE: "temporal",
      WORKFLOW_TEMPORAL_NAMESPACE: "delegate",
    });

    expect(config.configuredEngine).toBe("temporal");
    expect(config.effectiveEngine).toBe("local_runner");
    expect(config.localQueueName).toBe(LOCAL_WORKFLOW_QUEUE);
    expect(config.fallbackReason).toBe("temporal_not_fully_configured");
  });

  it("builds a Temporal-ready dispatch target when the config is complete", () => {
    const config = getWorkflowEngineConfig({
      WORKFLOW_ENGINE: "temporal",
      WORKFLOW_TEMPORAL_ADDRESS: "127.0.0.1:7233",
      WORKFLOW_TEMPORAL_NAMESPACE: "delegate",
      WORKFLOW_TEMPORAL_TASK_QUEUE: "delegate-public-runtime",
    });
    const target = resolveWorkflowDispatchTarget({
      config,
      kind: "handoff_follow_up",
      representativeKey: "lin-founder-rep",
      subjectId: "handoff_123",
    });

    expect(config.effectiveEngine).toBe("temporal");
    expect(target.queueName).toBe("delegate-public-runtime");
    expect(target.externalWorkflowId).toBe(
      buildWorkflowExternalId({
        kind: "handoff_follow_up",
        representativeKey: "lin-founder-rep",
        subjectId: "handoff_123",
      }),
    );
  });

  it("parses the explicit Temporal workflow timing input", () => {
    expect(
      temporalWorkflowRunInputSchema.parse({
        workflowRunId: "workflow-123",
        scheduledAt: "2026-04-05T12:00:00.000Z",
      }),
    ).toEqual({
      workflowRunId: "workflow-123",
      scheduledAt: "2026-04-05T12:00:00.000Z",
    });
  });

  it("flags only Temporal dispatch targets for outbox start commands", () => {
    expect(
      shouldDispatchWorkflowViaTemporalOutbox({ effectiveEngine: "temporal" }),
    ).toBe(true);
    expect(
      shouldDispatchWorkflowViaTemporalOutbox({ effectiveEngine: "local_runner" }),
    ).toBe(false);
  });
});

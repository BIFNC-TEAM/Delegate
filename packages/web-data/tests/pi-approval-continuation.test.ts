import { describe, expect, it } from "vitest";

import {
  markPiApprovalContinuationCompleted,
  markPiApprovalContinuationPending,
  readPiApprovalContinuation,
} from "../src/pi-approval-continuation";

describe("Pi approval continuation snapshots", () => {
  it("preserves the generation context and records a bounded approved result handoff", () => {
    const pending = markPiApprovalContinuationPending(
      { agentTrace: { runtime: "delegate-pi-runtime.1" } },
      "approval-1",
    );
    expect(readPiApprovalContinuation(pending)).toEqual({
      version: 1,
      approvalId: "approval-1",
      status: "pending",
      artifacts: [],
    });

    const completed = markPiApprovalContinuationCompleted(pending, {
      approvalId: "approval-1",
      completedAt: new Date("2026-09-11T08:00:00.000Z"),
      artifacts: [{
        id: "artifact-1",
        kind: "stdout",
        mimeType: "text/plain",
        sizeBytes: 42,
      }],
    });
    expect(completed).toMatchObject({
      agentTrace: { runtime: "delegate-pi-runtime.1" },
    });
    expect(readPiApprovalContinuation(completed)).toEqual({
      version: 1,
      approvalId: "approval-1",
      status: "completed",
      completedAt: "2026-09-11T08:00:00.000Z",
      artifacts: [{
        id: "artifact-1",
        kind: "stdout",
        mimeType: "text/plain",
        sizeBytes: 42,
      }],
    });
  });

  it("rejects malformed continuation state instead of trusting partial data", () => {
    expect(readPiApprovalContinuation({
      piApprovalContinuation: {
        version: 1,
        approvalId: 42,
        status: "completed",
      },
    })).toBeUndefined();
  });
  it("preserves v2 checkpoint and failed-read result and fences another approval", () => {
    const checkpoint = { version: 2, pending: { approvalId: "a1", callId: "c1", toolName: "browse_in_sandbox" }, turnsUsed: 4, activeMs: 100 };
    const pending = markPiApprovalContinuationPending({ piExecutionProtocol: "goal_v2" }, "a1", checkpoint);
    expect(readPiApprovalContinuation(pending)?.checkpoint).toEqual(checkpoint);
    expect(() => markPiApprovalContinuationCompleted(pending, { approvalId: "old", completedAt: new Date(), artifacts: [] })).toThrow("action_mismatch");
    const completed = markPiApprovalContinuationCompleted(pending, { approvalId: "a1", completedAt: new Date(), artifacts: [], resultStatus: "failed" });
    expect(readPiApprovalContinuation(completed)).toMatchObject({ version: 2, status: "completed", resultStatus: "failed", checkpoint });
    expect(() => readPiApprovalContinuation({ piApprovalContinuation: { version: 2, checkpoint: { version: 2, text: "x".repeat(1024 * 1024) } } })).toThrow("checkpoint_invalid");
  });

});

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
});

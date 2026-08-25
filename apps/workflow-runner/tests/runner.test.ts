import { ApprovalStatus, HandoffStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { WorkflowEnginePhase } from "@delegate/workflows";

import {
  deriveApprovalExpirationOutcome,
  deriveHandoffFollowUpOutcome,
} from "../src/runner";

describe("workflow-runner decisions", () => {
  it("expires only pending approvals", () => {
    expect(deriveApprovalExpirationOutcome(ApprovalStatus.PENDING)).toBe("expire");
    expect(deriveApprovalExpirationOutcome(ApprovalStatus.APPROVED)).toBe("skip");
    expect(deriveApprovalExpirationOutcome(ApprovalStatus.REJECTED)).toBe("skip");
    expect(deriveApprovalExpirationOutcome(ApprovalStatus.EXPIRED)).toBe("skip");
  });

  it("keeps follow-up only for open owner inbox work", () => {
    expect(deriveHandoffFollowUpOutcome(HandoffStatus.OPEN)).toBe("follow_up");
    expect(deriveHandoffFollowUpOutcome(HandoffStatus.REVIEWING)).toBe("follow_up");
    expect(deriveHandoffFollowUpOutcome(HandoffStatus.ACCEPTED)).toBe("skip");
    expect(deriveHandoffFollowUpOutcome(HandoffStatus.CLOSED)).toBe("skip");
  });

  it("keeps local-runner decisions unchanged across the new engine phases", () => {
    const phases: WorkflowEnginePhase[] = [
      "dispatch_pending",
      "waiting_timer",
      "waiting_signal",
      "activity_running",
      "retry_backoff",
      "cancel_requested",
      "completed",
      "failed",
      "canceled",
    ];

    for (const _phase of phases) {
      expect(deriveApprovalExpirationOutcome(ApprovalStatus.PENDING)).toBe("expire");
      expect(deriveApprovalExpirationOutcome(ApprovalStatus.APPROVED)).toBe("skip");
      expect(deriveHandoffFollowUpOutcome(HandoffStatus.OPEN)).toBe("follow_up");
      expect(deriveHandoffFollowUpOutcome(HandoffStatus.CLOSED)).toBe("skip");
    }
  });
});

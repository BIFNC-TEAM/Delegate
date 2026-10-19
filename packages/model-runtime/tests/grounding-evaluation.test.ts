import { describe, expect, it } from "vitest";
import { evaluateGroundingDecision } from "../scripts/grounding-evaluation";

describe("fixed-candidate grounding evaluation", () => {
  it("does not count an invalid evidence id as detection of invented policy terms", () => {
    // Real focused-review failure: the model accepted the added condition, then
    // the host blocked its source id because the protocol requires a call id.
    expect(evaluateGroundingDecision({ expectedRelease: false,
      assessment: { releaseCandidate: false, claimsSupported: true, verdict: "continue" } }))
      .toEqual({ pass: false, decisionMatches: true, status: "blocked_without_identifying_error" });
  });
  it("counts an explicit unsupported-claim rejection separately from a host-only block", () => {
    expect(evaluateGroundingDecision({ expectedRelease: false,
      assessment: { releaseCandidate: false, claimsSupported: false, verdict: "continue" } }))
      .toEqual({ pass: true, decisionMatches: true, status: "passed" });
  });
  it("does not accept a declared unsupported claim that was nevertheless released", () => {
    expect(evaluateGroundingDecision({ expectedRelease: false,
      assessment: { releaseCandidate: true, claimsSupported: false, verdict: "complete" } }).pass).toBe(false);
  });
  it("records a missed unsupported answer", () => {
    expect(evaluateGroundingDecision({ expectedRelease: false,
      assessment: { releaseCandidate: true, claimsSupported: true, verdict: "complete" } }).status).toBe("unsupported_answer_released");
  });
  it("keeps valid answers as positive controls", () => {
    expect(evaluateGroundingDecision({ expectedRelease: true,
      assessment: { releaseCandidate: true, claimsSupported: true, verdict: "complete" } }).pass).toBe(true);
    expect(evaluateGroundingDecision({ expectedRelease: true,
      assessment: { releaseCandidate: false, claimsSupported: true, verdict: "continue" } }).status).toBe("correct_answer_rejected");
  });
  it.each([undefined, "Error", "SyntaxError"])("does not count missing or failed model output as a rejection: %s", error => {
    expect(evaluateGroundingDecision({ expectedRelease: false, error }).status).toBe("evaluation_error");
  });
});

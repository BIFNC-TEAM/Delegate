/** Evaluation-only: being blocked does not prove the reviewer found a factual error. */
export function evaluateGroundingDecision(input: {
  expectedRelease: boolean;
  assessment?: { releaseCandidate: boolean; claimsSupported: boolean; verdict: string } | undefined;
  error?: string | undefined;
}) {
  const { assessment } = input;
  if (input.error || !assessment) return { pass: false, decisionMatches: false, status: "evaluation_error" as const };
  const decisionMatches = assessment.releaseCandidate === input.expectedRelease;
  if (input.expectedRelease) {
    const pass = decisionMatches && assessment.claimsSupported;
    return { pass, decisionMatches, status: pass ? "passed" as const : "correct_answer_rejected" as const };
  }
  if (!decisionMatches) return { pass: false, decisionMatches, status: "unsupported_answer_released" as const };
  const identifiedUnsupportedClaim = !assessment.claimsSupported && assessment.verdict === "continue";
  return { pass: identifiedUnsupportedClaim, decisionMatches,
    status: identifiedUnsupportedClaim ? "passed" as const : "blocked_without_identifying_error" as const };
}

export function isComputeGenerationExecutionInProgressError(
  error: unknown,
): error is Error & { code: "generation_execution_in_progress" } {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "generation_execution_in_progress",
  );
}

export function isComputeExecutionClaimLostError(
  error: unknown,
): error is Error & {
  code: "compute_execution_claim_lost" | "compute_execution_claim_missing";
} {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (
      error.code === "compute_execution_claim_lost"
      || error.code === "compute_execution_claim_missing"
    ),
  );
}

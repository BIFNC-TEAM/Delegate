export type CurrentBindingCandidate = {
  provider: "TELEGRAM" | "MATRIX";
  providerSubject: string;
  issuer: string;
  connectionId: string | null;
};

export type CurrentBindingCollections = {
  telegram: CurrentBindingCandidate[];
  matrix: CurrentBindingCandidate[];
};

export type PendingBindingInstruction = {
  provider: "telegram" | "matrix";
  scope: {
    issuer: string;
    connectionId: string;
  };
  expectedProviderSubject?: string;
  consumedProviderSubject?: string;
};

const transientFailureDelaysMs = [2_000, 4_000, 8_000, 16_000] as const;

/**
 * CONSUMED is historical. Only report success when the proof still belongs to
 * the representative's current endpoint after the authoritative state reload.
 */
export function isInstructionBindingCurrent(
  currentBindings: CurrentBindingCollections,
  instruction: PendingBindingInstruction,
): boolean {
  const candidates =
    instruction.provider === "telegram"
      ? currentBindings.telegram
      : currentBindings.matrix;
  if (
    !instruction.consumedProviderSubject
    || (
      instruction.provider === "matrix"
      && (
        !instruction.expectedProviderSubject
        || instruction.expectedProviderSubject
          !== instruction.consumedProviderSubject
      )
    )
  ) {
    return false;
  }
  return candidates.some(
    (binding) =>
      binding.provider === instruction.provider.toUpperCase()
      && binding.issuer === instruction.scope.issuer
      && binding.connectionId === instruction.scope.connectionId
      && binding.providerSubject === instruction.consumedProviderSubject,
  );
}

/**
 * Retry transient failures with bounded exponential backoff. Returning null
 * pauses automatic polling until the visitor explicitly asks to retry.
 */
export function bindingPollRetryDelayMs(
  consecutiveFailureCount: number,
): number | null {
  if (
    !Number.isInteger(consecutiveFailureCount)
    || consecutiveFailureCount < 1
  ) {
    return transientFailureDelaysMs[0];
  }
  return transientFailureDelaysMs[consecutiveFailureCount - 1] ?? null;
}

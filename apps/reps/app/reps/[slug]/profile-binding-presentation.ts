export type ProfileBindingChannelState = "linked" | "available" | "unavailable";

export function resolveProfileBindingChannels(payload: {
  bindings: Array<{ provider: "TELEGRAM" | "MATRIX" }>;
  capabilities: { telegram: boolean; matrix: boolean };
}): {
  telegram: ProfileBindingChannelState;
  matrix: ProfileBindingChannelState;
} {
  const linkedProviders = new Set(payload.bindings.map((binding) => binding.provider));
  return {
    telegram: linkedProviders.has("TELEGRAM")
      ? "linked"
      : payload.capabilities.telegram
        ? "available"
        : "unavailable",
    matrix: linkedProviders.has("MATRIX")
      ? "linked"
      : payload.capabilities.matrix
        ? "available"
        : "unavailable",
  };
}

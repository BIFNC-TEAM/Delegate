export function deriveConversationComputeEntitlements(params: {
  conversation?:
    | {
        passUnlockedAt: Date | null;
        deepHelpUnlockedAt: Date | null;
      }
    | null
    | undefined;
  generationRuntimePolicySnapshot?: unknown;
}) {
  const passUnlocked = Boolean(params.conversation?.passUnlockedAt);
  const deepHelpUnlocked = Boolean(params.conversation?.deepHelpUnlockedAt);
  const runScopedPass = hasServerStoredServiceCreditReservation(
    params.generationRuntimePolicySnapshot,
  );
  const activePlanTier = deepHelpUnlocked
    ? "deep_help"
    : passUnlocked || runScopedPass
      ? "pass"
      : undefined;

  return {
    hasPaidEntitlement: activePlanTier !== undefined,
    activePlanTier,
  } as const;
}

export function hasServerStoredServiceCreditReservation(snapshot: unknown): boolean {
  return readServerStoredServiceCreditReservation(snapshot) !== null;
}

export function readServerStoredServiceCreditReservation(snapshot: unknown): {
  usageChargeId: string;
  tokenAmount: number;
} | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  const record = snapshot as Record<string, unknown>;
  if (record.billingMode !== "service_credit") {
    return null;
  }
  const reservation = record.walletReservation;
  if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) {
    return null;
  }
  const usageChargeId = (reservation as Record<string, unknown>).usageChargeId;
  const tokenAmount = (reservation as Record<string, unknown>).tokenAmount;
  if (
    typeof usageChargeId !== "string"
    || usageChargeId.trim().length === 0
    || typeof tokenAmount !== "number"
    || !Number.isSafeInteger(tokenAmount)
    || tokenAmount <= 0
  ) {
    return null;
  }
  return {
    usageChargeId: usageChargeId.trim(),
    tokenAmount,
  };
}

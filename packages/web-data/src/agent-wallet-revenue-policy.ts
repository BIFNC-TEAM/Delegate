export const DEFAULT_CREATOR_REVENUE_SHARE_BPS = 2000;
export const BPS_DENOMINATOR = 10_000;

export type RevenueSplitInput = {
  grossAmountCents: number;
  creatorRevenueShareBps?: number | null;
  providerCostCents?: number;
};

export type RevenueSplit = {
  grossAmountCents: number;
  creatorRevenueShareBps: number;
  creatorShareCents: number;
  platformGrossCents: number;
  providerCostCents: number;
  platformNetCents: number;
};

export function calculateAgentWalletRevenueSplit(input: RevenueSplitInput): RevenueSplit {
  assertNonNegativeInteger(input.grossAmountCents, "grossAmountCents");
  const providerCostCents = input.providerCostCents ?? 0;
  assertNonNegativeInteger(providerCostCents, "providerCostCents");
  const creatorRevenueShareBps = normalizeCreatorRevenueShareBps(
    input.creatorRevenueShareBps,
  );
  const creatorShareCents = calculateCreatorRevenueShareCents(
    input.grossAmountCents,
    creatorRevenueShareBps,
  );
  const platformGrossCents = input.grossAmountCents - creatorShareCents;

  return {
    grossAmountCents: input.grossAmountCents,
    creatorRevenueShareBps,
    creatorShareCents,
    platformGrossCents,
    providerCostCents,
    platformNetCents: Math.max(platformGrossCents - providerCostCents, 0),
  };
}

export function calculateCreatorRevenueShareCents(
  grossAmountCents: number,
  creatorRevenueShareBps: number | null | undefined = DEFAULT_CREATOR_REVENUE_SHARE_BPS,
): number {
  assertNonNegativeInteger(grossAmountCents, "grossAmountCents");
  const normalizedBps = normalizeCreatorRevenueShareBps(creatorRevenueShareBps);
  return Math.floor((grossAmountCents * normalizedBps) / BPS_DENOMINATOR);
}

export function normalizeCreatorRevenueShareBps(
  creatorRevenueShareBps: number | null | undefined,
): number {
  const normalized = creatorRevenueShareBps ?? DEFAULT_CREATOR_REVENUE_SHARE_BPS;
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > BPS_DENOMINATOR) {
    throw new Error("creatorRevenueShareBps must be an integer between 0 and 10000.");
  }
  return normalized;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

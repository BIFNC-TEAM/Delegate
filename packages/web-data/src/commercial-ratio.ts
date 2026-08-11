/**
 * Values one contiguous slice of an indivisible commercial amount by taking
 * the difference between cumulative projections. Every slice is integral,
 * divisible-price behavior is unchanged, and slices covering all units sum to
 * the original amount exactly.
 */
export function calculateCumulativeProportionalDifference(input: {
  totalAmount: number;
  totalUnits: number;
  unitsBefore: number;
  unitsDelta: number;
}): number {
  const unitsAfter = input.unitsBefore + input.unitsDelta;
  const before = projectCumulativeProportionalAmount({
    totalAmount: input.totalAmount,
    totalUnits: input.totalUnits,
    units: input.unitsBefore,
  });
  const after = projectCumulativeProportionalAmount({
    totalAmount: input.totalAmount,
    totalUnits: input.totalUnits,
    units: unitsAfter,
  });
  return after - before;
}

/**
 * Allocates a creator share through the already-rounded gross amount. This
 * nested projection guarantees that an individual creator slice can never be
 * larger than its gross slice, even when a very small price is spread across
 * many service credits.
 */
export function calculateCumulativeRevenueAllocationDifference(input: {
  grossAmount: number;
  creatorAmount: number;
  totalUnits: number;
  unitsBefore: number;
  unitsDelta: number;
}): {
  grossAmount: number;
  creatorAmount: number;
  platformAmount: number;
} {
  assertSafePositiveInteger(input.grossAmount, "grossAmount");
  assertSafeNonNegativeInteger(input.creatorAmount, "creatorAmount");
  if (input.creatorAmount > input.grossAmount) {
    throw new Error("creatorAmount cannot exceed grossAmount.");
  }
  const unitsAfter = input.unitsBefore + input.unitsDelta;
  const grossBefore = projectCumulativeProportionalAmount({
    totalAmount: input.grossAmount,
    totalUnits: input.totalUnits,
    units: input.unitsBefore,
  });
  const grossAfter = projectCumulativeProportionalAmount({
    totalAmount: input.grossAmount,
    totalUnits: input.totalUnits,
    units: unitsAfter,
  });
  const creatorBefore = projectCumulativeProportionalAmount({
    totalAmount: input.creatorAmount,
    totalUnits: input.grossAmount,
    units: grossBefore,
  });
  const creatorAfter = projectCumulativeProportionalAmount({
    totalAmount: input.creatorAmount,
    totalUnits: input.grossAmount,
    units: grossAfter,
  });
  const grossAmount = grossAfter - grossBefore;
  const creatorAmount = creatorAfter - creatorBefore;
  return {
    grossAmount,
    creatorAmount,
    platformAmount: grossAmount - creatorAmount,
  };
}

export function projectCumulativeProportionalAmount(input: {
  totalAmount: number;
  totalUnits: number;
  units: number;
}): number {
  assertSafeNonNegativeInteger(input.totalAmount, "totalAmount");
  assertSafePositiveInteger(input.totalUnits, "totalUnits");
  assertSafeNonNegativeInteger(input.units, "units");
  if (input.units > input.totalUnits) {
    throw new Error("The cumulative unit range exceeds totalUnits.");
  }
  return Number(
    (BigInt(input.totalAmount) * BigInt(input.units)) /
      BigInt(input.totalUnits),
  );
}

export function projectCompatibilityUnitPrice(input: {
  totalAmount: number;
  totalUnits: number;
}): number {
  assertSafeNonNegativeInteger(input.totalAmount, "totalAmount");
  assertSafePositiveInteger(input.totalUnits, "totalUnits");
  return Math.floor(input.totalAmount / input.totalUnits);
}

function assertSafePositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function assertSafeNonNegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

import { describe, expect, it } from "vitest";

import {
  calculateCumulativeProportionalDifference,
  calculateCumulativeRevenueAllocationDifference,
  projectCompatibilityUnitPrice,
} from "../src/commercial-ratio";

describe("commercial ratio allocation", () => {
  it("assigns indivisible remainder to the final cumulative slice", () => {
    expect(
      [0, 1, 2].map((unitsBefore) =>
        calculateCumulativeProportionalDifference({
          totalAmount: 100,
          totalUnits: 3,
          unitsBefore,
          unitsDelta: 1,
        }),
      ),
    ).toEqual([33, 33, 34]);
  });

  it("never releases more creator revenue than a tiny gross slice", () => {
    const boundary = calculateCumulativeRevenueAllocationDifference({
      grossAmount: 5,
      creatorAmount: 4,
      totalUnits: 100,
      unitsBefore: 24,
      unitsDelta: 1,
    });

    expect(boundary).toEqual({
      grossAmount: 0,
      creatorAmount: 0,
      platformAmount: 0,
    });

    const slices = Array.from({ length: 100 }, (_, unitsBefore) =>
      calculateCumulativeRevenueAllocationDifference({
        grossAmount: 5,
        creatorAmount: 4,
        totalUnits: 100,
        unitsBefore,
        unitsDelta: 1,
      }),
    );
    expect(
      slices.every(
        (slice) =>
          slice.creatorAmount >= 0 &&
          slice.creatorAmount <= slice.grossAmount &&
          slice.platformAmount >= 0,
      ),
    ).toBe(true);
    expect(
      slices.reduce((sum, slice) => sum + slice.grossAmount, 0),
    ).toBe(5);
    expect(
      slices.reduce((sum, slice) => sum + slice.creatorAmount, 0),
    ).toBe(4);
    expect(
      slices.reduce((sum, slice) => sum + slice.platformAmount, 0),
    ).toBe(1);
  });

  it("preserves divisible-price behavior and a floor compatibility projection", () => {
    expect(
      calculateCumulativeRevenueAllocationDifference({
        grossAmount: 1200,
        creatorAmount: 300,
        totalUnits: 600,
        unitsBefore: 200,
        unitsDelta: 100,
      }),
    ).toEqual({
      grossAmount: 200,
      creatorAmount: 50,
      platformAmount: 150,
    });
    expect(
      projectCompatibilityUnitPrice({
        totalAmount: 5,
        totalUnits: 100,
      }),
    ).toBe(0);
  });

  it("preserves non-negative exact totals across varied prices, units, shares, and chunking", () => {
    const grossAmounts = [1, 2, 5, 10, 37, 101, 999, 10_000];
    const unitCounts = [1, 2, 3, 7, 31, 100, 257];
    const shareBpsValues = [0, 1, 999, 2_000, 5_001, 9_999, 10_000];

    for (const grossAmount of grossAmounts) {
      for (const totalUnits of unitCounts) {
        for (const shareBps of shareBpsValues) {
          const creatorAmount = Math.floor(
            (grossAmount * shareBps) / 10_000,
          );
          const slices: Array<{
            grossAmount: number;
            creatorAmount: number;
            platformAmount: number;
          }> = [];
          let unitsBefore = 0;
          let nextChunk = 1;
          while (unitsBefore < totalUnits) {
            const unitsDelta = Math.min(
              nextChunk,
              totalUnits - unitsBefore,
            );
            slices.push(
              calculateCumulativeRevenueAllocationDifference({
                grossAmount,
                creatorAmount,
                totalUnits,
                unitsBefore,
                unitsDelta,
              }),
            );
            unitsBefore += unitsDelta;
            nextChunk = nextChunk % 5 + 1;
          }

          expect(
            slices.every(
              (slice) =>
                Number.isInteger(slice.grossAmount)
                && Number.isInteger(slice.creatorAmount)
                && Number.isInteger(slice.platformAmount)
                && slice.grossAmount >= 0
                && slice.creatorAmount >= 0
                && slice.platformAmount >= 0
                && slice.creatorAmount <= slice.grossAmount
                && slice.creatorAmount + slice.platformAmount
                  === slice.grossAmount,
            ),
          ).toBe(true);
          expect(
            slices.reduce((sum, slice) => sum + slice.grossAmount, 0),
          ).toBe(grossAmount);
          expect(
            slices.reduce((sum, slice) => sum + slice.creatorAmount, 0),
          ).toBe(creatorAmount);
          expect(
            slices.reduce((sum, slice) => sum + slice.platformAmount, 0),
          ).toBe(grossAmount - creatorAmount);
        }
      }
    }
  });
});

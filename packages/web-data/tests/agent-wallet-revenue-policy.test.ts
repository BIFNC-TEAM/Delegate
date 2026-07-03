import { describe, expect, it } from "vitest";

import {
  calculateAgentWalletRevenueSplit,
  calculateCreatorRevenueShareCents,
  DEFAULT_CREATOR_REVENUE_SHARE_BPS,
  normalizeCreatorRevenueShareBps,
} from "../src/agent-wallet-revenue-policy";

describe("agent wallet revenue policy", () => {
  it("defaults creator share to 20 percent", () => {
    expect(DEFAULT_CREATOR_REVENUE_SHARE_BPS).toBe(2000);
    expect(calculateCreatorRevenueShareCents(1000)).toBe(200);
    expect(
      calculateAgentWalletRevenueSplit({
        grossAmountCents: 1000,
      }),
    ).toMatchObject({
      creatorRevenueShareBps: 2000,
      creatorShareCents: 200,
      platformGrossCents: 800,
      providerCostCents: 0,
      platformNetCents: 800,
    });
  });

  it("supports custom creator revenue share bps", () => {
    expect(calculateCreatorRevenueShareCents(1000, 3500)).toBe(350);
    expect(
      calculateAgentWalletRevenueSplit({
        grossAmountCents: 1000,
        creatorRevenueShareBps: 3500,
        providerCostCents: 125,
      }),
    ).toMatchObject({
      creatorShareCents: 350,
      platformGrossCents: 650,
      providerCostCents: 125,
      platformNetCents: 525,
    });
  });

  it("rounds tiny amounts down to exact cents", () => {
    expect(calculateCreatorRevenueShareCents(1, 2000)).toBe(0);
    expect(calculateCreatorRevenueShareCents(9, 2000)).toBe(1);
    expect(calculateCreatorRevenueShareCents(99, 3333)).toBe(32);
  });

  it("does not let provider cost make platform net negative", () => {
    expect(
      calculateAgentWalletRevenueSplit({
        grossAmountCents: 100,
        creatorRevenueShareBps: 2000,
        providerCostCents: 1000,
      }).platformNetCents,
    ).toBe(0);
  });

  it("rejects invalid money and bps inputs", () => {
    expect(() => normalizeCreatorRevenueShareBps(-1)).toThrow("between 0 and 10000");
    expect(() => normalizeCreatorRevenueShareBps(10001)).toThrow("between 0 and 10000");
    expect(() => calculateCreatorRevenueShareCents(10.5)).toThrow("non-negative integer");
    expect(() =>
      calculateAgentWalletRevenueSplit({
        grossAmountCents: 100,
        providerCostCents: -1,
      }),
    ).toThrow("non-negative integer");
  });
});

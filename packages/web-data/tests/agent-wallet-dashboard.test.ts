import { describe, expect, it } from "vitest";

import { summarizeCreatorEarningBalances } from "../src/agent-wallet-dashboard";

describe("agent wallet dashboard", () => {
  it("summarizes creator earning balances for owner wallet view", () => {
    expect(
      summarizeCreatorEarningBalances([
        {
          pendingCents: 100,
          withdrawableCents: 80,
          frozenCents: 20,
          withdrawnCents: 0,
        },
        {
          pendingCents: 50,
          withdrawableCents: 120,
          frozenCents: 0,
          withdrawnCents: 30,
        },
      ]),
    ).toEqual({
      pendingCents: 150,
      withdrawableCents: 200,
      frozenCents: 20,
      withdrawnCents: 30,
    });
  });
});

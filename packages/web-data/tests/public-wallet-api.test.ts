import { describe, expect, it } from "vitest";

import * as webData from "../src/index";

describe("public wallet API", () => {
  it("exposes only the dual-ledger conversation usage lifecycle", () => {
    expect(webData.reserveConversationWalletUsage).toBeTypeOf("function");
    expect(webData.settleConversationWalletUsage).toBeTypeOf("function");
    expect(webData.releaseConversationWalletUsage).toBeTypeOf("function");
    expect(webData.verifyAgentUsageEntitlementReservation).toBeTypeOf(
      "function",
    );

    expect("reserveAgentUsageCredits" in webData).toBe(false);
    expect("settleAgentUsageCredits" in webData).toBe(false);
    expect("releaseAgentUsageCredits" in webData).toBe(false);
    expect("applyAgentUsageCharge" in webData).toBe(false);
  });
});

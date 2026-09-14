import { describe, expect, it } from "vitest";

import { agentRegressionCases, selectCases } from "../src/cases";

describe("Agent regression catalog", () => {
  it("contains 90 unique executable case coordinates", () => {
    expect(agentRegressionCases).toHaveLength(90);
    expect(new Set(agentRegressionCases.map((item) => item.id)).size).toBe(90);
    expect(agentRegressionCases.every((item) => item.prompt.length > 0)).toBe(true);
  });

  it("selects the required 15-case smoke set", () => {
    const smoke = selectCases({ suite: "smoke" });
    expect(smoke).toHaveLength(15);
    expect(smoke.map((item) => item.id)).toEqual(expect.arrayContaining([
      "BASIC-01", "BASIC-02", "KB-01", "KB-03", "WEB-01",
      "SKILL-02", "BOX-01", "BOX-02", "MCP-01", "MCP-05",
      "HUMAN-01", "HUMAN-03", "FLOW-01", "CHAT-04", "ARCH-03",
    ]));
  });

  it("supports exact ID filtering", () => {
    expect(selectCases({ suite: "regression", ids: ["BOX-01"] }).map((item) => item.id))
      .toEqual(["BOX-01"]);
  });
});

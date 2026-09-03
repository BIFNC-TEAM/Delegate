import { describe, expect, it } from "vitest";

import { inferTurnSourceRequirementV3 } from "../src";

const live = process.env.RUN_LIVE_SOURCE_REQUIREMENT_EVAL === "true";

describe.skipIf(!live)("live TurnPlan V3 source-requirement inference", () => {
  it.each([
    {
      text: "今天的股市情况如何",
      evidence: "current_external",
      freshness: "live",
      authority: "external_authoritative",
    },
    {
      text: "解释 CAP 定理",
      evidence: "none",
      freshness: "stable",
      authority: "general",
    },
    {
      text: "我们公司的退款政策是什么",
      evidence: "authorized_knowledge",
      freshness: "bounded",
      authority: "owner_authorized",
    },
    {
      text: "计算 1 到 500 之间所有质数的数量",
      evidence: "capability_result",
      freshness: "bounded",
      authority: "general",
    },
  ])("infers constraints for $text", async ({ text, evidence, freshness, authority }) => {
    const result = await inferTurnSourceRequirementV3({
      text,
      language: "zh",
      now: "2026-09-01T08:00:00.000Z",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.requirement.evidenceClasses).toContain(evidence);
    expect(result.requirement.freshnessClasses).toContain(freshness);
    expect(result.requirement.authorityClasses).toContain(authority);
  }, 90_000);
});

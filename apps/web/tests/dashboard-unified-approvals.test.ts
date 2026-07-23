import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const component = readFileSync(new URL("../app/dashboard/dashboard-approvals.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/dashboard/representatives/[slug]/compute/approvals/[approvalId]/route.ts", import.meta.url), "utf8");
const directSkillReviewRoute = readFileSync(new URL("../app/api/dashboard/skills/[installId]/releases/[releaseId]/route.ts", import.meta.url), "utf8");
const computeSource = readFileSync(new URL("../../../packages/web-data/src/compute.ts", import.meta.url), "utf8");

describe("unified workspace decision queue", () => {
  it("renders compute and skill update decisions in one queue", () => {
    expect(component).toContain('selected.kind === "skill_update"');
    expect(component).toContain("批准并采纳版本");
    expect(component).toContain("新增权限");
    expect(component).toContain("签名状态");
    expect(component).toContain("Registry 信任");
    expect(component).toContain("Manifest 运行要求差异");
    expect(component).toContain("版本证据摘要");
    expect(computeSource).toContain("runtimeRequirementDiff");
  });

  it("routes skill decisions through skill governance before compute resolution", () => {
    expect(route).toContain("assertOwnerCanResolveApproval");
    expect(route.indexOf("resolveWorkspaceSkillApproval")).toBeLessThan(
      route.indexOf("resolveRepresentativeComputeApproval({"),
    );
    expect(route).toContain("if (skillDecision.handled)");
    expect(computeSource).toContain("queryRepresentativeApprovals(representative.id, 100, representative.ownerId)");
    expect(computeSource).toContain('? [{ status: "asc" }, { requestedAt: "desc" }]');
  });

  it("normalizes and caps notes on both approval decision entry points", () => {
    expect(route).toContain("decisionNote.trim()");
    expect(route).toContain("decisionNote.length > 1000");
    expect(directSkillReviewRoute).toContain("body.reviewNote.trim()");
    expect(directSkillReviewRoute).toContain("reviewNote.length > 1000");
    expect(directSkillReviewRoute).toContain("...(reviewNote ? { reviewNote } : {})");
  });

  it("ignores out-of-order polling responses and exposes an honest initial loading state", () => {
    expect(component).toContain("requestSequenceRef.current !== requestId");
    expect(component).toContain("settledSlug !== activeSlug");
    expect(component).toContain("正在读取工作区审批队列");
    expect(component).toContain("aria-busy={initialLoading || loading || busy}");
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../app/dashboard/dashboard-skills.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/dashboard/dashboard-v2.css", import.meta.url), "utf8");

describe("dashboard skills workspace", () => {
  it("loads the workspace API and keeps install and binding mutations separate", () => {
    expect(source).toContain("/api/dashboard/skills?rep=");
    expect(source).toContain('method: "POST"');
    expect(source).toContain('/bindings`');
    expect(source).toContain('/releases/${encodeURIComponent(release.id)}`');
    expect(source).toContain("updateArchived");
    expect(source).toContain("updatePolicy");
    expect(source).toContain("patch_auto");
    expect(source).toContain('method: "PATCH"');
  });

  it("discards stale representative and registry responses", () => {
    expect(source).toContain("activeSlugRef.current !== representativeSlug");
    expect(source).toContain("snapshotRequestSequenceRef.current !== requestId");
    expect(source).toContain("registryRequestSequenceRef.current !== requestId");
    expect(source).toContain("controller.abort()");
  });

  it("guards editable MCP bindings against stale loads and exposes retryable loading state", () => {
    expect(source).toContain("bindingRequestSequenceRef.current !== requestId");
    expect(source).toContain("setBindingsLoadError");
    expect(source).toContain("重试加载");
    expect(source).toContain("正在读取可编辑的 MCP 连接");
    expect(source).toContain("disabled={bindingsLoading || !managed}");
    expect(source).toContain("aria-busy={bindingsLoading || saving}");
    expect(source).toContain("expectedUpdatedAt: binding.updatedAt");
    expect(source).toContain("{ expectedUpdatedAt: form.expectedUpdatedAt }");
  });

  it("states the registry trust boundary in the product surface", () => {
    expect(source).toContain("不会执行第三方代码");
    expect(source).toContain("do not execute third-party code");
    expect(source).toContain("发布新版本后才影响公开运行时");
  });

  it("exposes reviewable release history and reversible archive controls", () => {
    expect(source).toContain("版本治理");
    expect(source).toContain("采纳版本");
    expect(source).toContain("回滚到此版本");
    expect(source).toContain("归档与影响范围");
    expect(source).toContain("可信补丁自动采纳");
    expect(source).toContain("新增权限");
    expect(source).toContain("Manifest 运行要求已变化");
    expect(source).toContain("新增 Manifest 要求");
    expect(source).toContain("移除 Manifest 要求");
    expect(source).toContain("Registry 信任");
    expect(source).toContain("最近调用记录");
    expect(source).toContain("参数、命令正文和凭据不会在此披露");
  });

  it("keeps Skills, Approvals, and Audit text at the design-system micro floor", () => {
    expect(styles).toContain(".skills-metrics .dashboard-v2-metric-card > div > span");
    expect(styles).toContain(".dashboard-approval-status, .dashboard-approval-risk");
    expect(styles).toContain(".audit-skill-table td");
    expect(styles).toContain("font-size: .75rem");
  });
});

import { createElement } from "react";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
const { ComputePolicySummary } = loadPolicyModule();
import type { RepresentativeComputePolicyView } from "@delegate/web-data";

const view: RepresentativeComputePolicyView = { asOf: "2026-09-28T00:00:00Z", state: "ready", publishedVersion: { id: "version", number: 3, publishedAt: "2026-09-28T00:00:00Z" }, runtimeCeiling: {
  enabled: true, defaultPolicyMode: "allow", baseImage: "test", maxSessionMinutes: 15, autoApproveTokenLimit: 0,
  artifactRetentionDays: 14, networkMode: "full", networkAllowlist: [], filesystemMode: "workspace_only",
  capabilityModes: { exec: "allow", read: "allow", write: "ask", process: "ask", browser: "ask", mcp: "ask" },
} };
describe("published compute policy summary markup", () => {
  it("distinguishes editing ALLOW from effective ASK, version and other approval conditions", () => {
    const html = renderToStaticMarkup(createElement(ComputePolicySummary, { locale: "zh", view, draft: { ...view.runtimeCeiling!, capabilityModes: { ...view.runtimeCeiling!.capabilityModes, browser: "allow" } } }));
    expect(html).toContain("v3"); expect(html).toContain("需审批"); expect(html).toContain("页面编辑值：");
    expect(html).toContain("0 Tokens"); expect(html).toContain("MCP 绑定审批"); expect(html).toContain("旧发布版本");
  });
  it.each(["unpublished", "unavailable"] as const)("does not display allowed capabilities for %s", state => {
    const html = renderToStaticMarkup(createElement(ComputePolicySummary, { locale: "zh", view: { ...view, state, runtimeCeiling: null } }));
    expect(html).not.toContain("已启用"); expect(html).not.toContain("默认放行");
    expect(html).toContain(state === "unpublished" ? "尚未发布" : "暂时无法读取");
  });
  it("suppresses all apparent ALLOW values when execution is disabled", () => {
    const html = renderToStaticMarkup(createElement(ComputePolicySummary, { locale: "en", view: { ...view, runtimeCeiling: { ...view.runtimeCeiling!, enabled: false } } }));
    expect(html).toContain("Disabled"); expect((html.match(/<strong>Deny<\/strong>/g) ?? []).length).toBe(6);
  });
  it("distinguishes an ALLOW ceiling from unverified code execution availability", () => {
    const html = renderToStaticMarkup(createElement(ComputePolicySummary, { locale: "zh", view: { ...view, codeExecution: { available: false, profileId: null, reason: "code_execution_profile_unverified" } } }));
    expect(html).toContain("当前通用代码执行不可用"); expect(html).toContain("受限 Python 需通过会话预检"); expect(html).toContain("公开浏览器仍按单独授权运行");
  });
});

// Same TSX loader used by the existing memory-settings behavior suite: Next's
// JSX-preserve config is not a runnable transform in the default Vitest setup.
function loadPolicyModule(): typeof import("../app/dashboard/compute-policy-status") {
  const source = readFileSync(new URL("../app/dashboard/compute-policy-status.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: "compute-policy-status.tsx" }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)(createRequire(import.meta.url), loaded, loaded.exports);
  return loaded.exports as typeof import("../app/dashboard/compute-policy-status");
}

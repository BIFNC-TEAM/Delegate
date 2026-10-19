import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { AgentBehavior } from "@delegate/domain";

const source = readFileSync(new URL("../app/dashboard/agent-behavior-fields.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: "agent-behavior-fields.tsx" }).outputText;
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled)(createRequire(import.meta.url), loaded, loaded.exports);
const { AgentBehaviorFields } = loaded.exports as typeof import("../app/dashboard/agent-behavior-fields");
const policy: AgentBehavior = { version: 1, answerScope: "open_public", knowledgePolicy: "domain_only", commitmentPolicy: "authorized_terms" };
function elements(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object") return [];
  return [node, ...elements(node.props?.children)];
}

describe("independent answer policy controls", () => {
  it("shows legacy absence without silently creating defaults, and requires an explicit configuration action", () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(createElement(AgentBehaviorFields, { locale: "zh", onChange }));
    expect(html).toContain("已发布版本仍沿用旧规则"); expect(html).toContain("默认专业问题先查授权资料"); expect(html).not.toContain("<select"); expect(onChange).not.toHaveBeenCalled();
    const button = elements(AgentBehaviorFields({ locale: "zh", onChange })).find(node => node.type === "button");
    button.props.onClick();
    expect(onChange).toHaveBeenCalledWith({ version: 1, answerScope: "owner_and_domain", knowledgePolicy: "domain_first", commitmentPolicy: "information_only" });
  });
  it("updates one dimension while preserving the other independent choices", () => {
    const onChange = vi.fn(); const original = structuredClone(policy);
    const selectors = elements(AgentBehaviorFields({ locale: "en", value: policy, onChange })).filter(node => node.type === "select");
    expect(selectors).toHaveLength(3);
    selectors[1].props.onChange({ target: { value: "domain_first" } });
    expect(onChange).toHaveBeenCalledWith({ ...policy, knowledgePolicy: "domain_first" });
    expect(policy).toEqual(original);
    const html = renderToStaticMarkup(createElement(AgentBehaviorFields, { locale: "en", value: policy, onChange }));
    expect(html).toContain("Save and publish"); expect(html).toContain("Tool access, data grants and approval are separate");
  });
});

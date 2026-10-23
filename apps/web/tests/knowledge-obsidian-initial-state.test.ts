import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Match the existing component-test loader: Next's tsconfig preserves JSX.
const nodeRequire = createRequire(import.meta.url);
function loadComponent(name: string): Record<string, unknown> {
  const compiled = ts.transpileModule(readFileSync(new URL(`../app/dashboard/${name}.tsx`, import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (specifier: string) => specifier.startsWith("./knowledge-obsidian-") ? loadComponent(specifier.slice(2)) : nodeRequire(specifier),
    module, module.exports,
  );
  return module.exports;
}
const { KnowledgeObsidianSync } = loadComponent("knowledge-obsidian-sync") as typeof import("../app/dashboard/knowledge-obsidian-sync");

describe("Obsidian Sync initial presentation", () => {
  it.each([true, false])("does not display a failed connection before checking it (zh=%s)", zh => {
    const html = renderToStaticMarkup(createElement(KnowledgeObsidianSync, {
      activeSlug: "test", zh, disabled: false, onRead: () => {}, onBusyChange: () => {},
    }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).not.toContain(zh ? "重试连接检查" : "Retry connection check");
    expect(html).not.toContain('type="password"');
  });
});

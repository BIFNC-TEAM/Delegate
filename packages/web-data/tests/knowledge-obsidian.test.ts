import { describe, expect, it } from "vitest";
import { renameKnowledgeMarkdownFile, getObsidianReferences, isObsidianNotePath, nextObsidianFileName, obsidianImportSchema, parseObsidianNote, prepareObsidianNotes, resolveObsidianReference } from "../src/knowledge-obsidian";

const note = (path: string, body: string) => parseObsidianNote(`Vault/${path}`, body);

describe("Obsidian note import", () => {
  it("validates edited names against knowledge title limits and preserves the extension", () => {
    expect(renameKnowledgeMarkdownFile("说明（2）.markdown", "  新的产品说明  ")).toBe("新的产品说明.markdown");
    expect(renameKnowledgeMarkdownFile("说明.MD", "a".repeat(180))).toBe("a".repeat(180) + ".MD");
    for (const name of ["", "   ", "a".repeat(181), "a/b", "a\\b", "a\0b"]) {
      expect(() => renameKnowledgeMarkdownFile("说明.md", name)).toThrow();
    }
  });

  it("keeps YAML properties out of answer text without losing structured metadata", () => {
    const parsed = note("产品.md", "---\ntitle: 产品\naliases: [介绍, 产品说明]\ntags:\n  - 产品\n内部成本: 300\n---\n公开的产品说明。\n");
    expect(parsed.properties).toEqual({ title: "产品", aliases: ["介绍", "产品说明"], tags: ["产品"], 内部成本: 300 });
    expect(parsed.body).toBe("公开的产品说明。\n");
    expect(() => note("bad.md", "---\ntitle: [broken\n---\nbody")).toThrow();
    expect(() => note("bad.md", "---\nx: &a [1]\ny: *a\n---\nbody")).toThrow();
  });

  it("excludes settings, trash, attachments and invalid paths", () => {
    for (const path of ["Vault/.obsidian/x.md", "Vault/.trash/x.md", "Vault/photo.png", "Vault/../private.md", "/etc/x.md", "C:/Vault/x.md"]) expect(isObsidianNotePath(path)).toBe(false);
    expect(isObsidianNotePath("Vault/产品/介绍.MD")).toBe(true);
    expect(obsidianImportSchema.safeParse({ sourcePath: "Vault/a.md", properties: {}, referencedPaths: [], warnings: [], visibility: "public_material" }).success).toBe(false);
  });

  it("never expands unselected notes; only explicit selection grants access", () => {
    const root = note("产品.md", "产品详情：\n![[内部报价]]\n普通链接 [[其他笔记|更多说明]]");
    const paths = [root.path, "Vault/内部报价.md", "Vault/其他笔记.md"];
    const first = prepareObsidianNotes([root], paths)[0]!;
    expect(first.requestedPaths).toEqual(["Vault/内部报价.md", "Vault/其他笔记.md"]);
    expect(first.text).not.toContain("秘密价格：300");
    const allowed = prepareObsidianNotes([root, note("内部报价.md", "秘密价格：300")], paths)[0]!;
    expect(allowed.text).toContain("秘密价格：300");
    expect(allowed.metadata.referencedPaths).toEqual(["Vault/内部报价.md"]);
    expect(prepareObsidianNotes([root], paths)[0]!.text).not.toContain("秘密价格：300");
  });

  it("resolves relative paths before names, reports ambiguous names and preserves dotted note names", () => {
    const paths = ["Vault/A/说明.md", "Vault/B/说明.md", "Vault/版本.v1.md"];
    expect(resolveObsidianReference("Vault/A/入口.md", "说明", paths)).toEqual([paths[0]]);
    expect(resolveObsidianReference("Vault/入口.md", "说明", paths)).toEqual(paths.slice(0, 2));
    expect(resolveObsidianReference("Vault/A/入口.md", "../B/说明.md", paths)).toEqual([paths[1]]);
    const source = note("入口.md", "![[说明]] ![[版本.v1]]");
    const result = prepareObsidianNotes([source, note("版本.v1.md", "正确版本说明")], [...paths, source.path])[0]!;
    expect(result.text).toContain("正确版本说明");
    expect(result.metadata.warnings.some((warning) => warning.includes("引用重名"))).toBe(true);
  });

  it("resolves file-picker notes by name without merging same-name files or guessing directories", () => {
    const entry = parseObsidianNote("selected/entry/入口.md", "![[规则]] ![[说明]] ![[产品/说明]]");
    const rules = parseObsidianNote("selected/rules/规则.md", "文件选择器里的保修规则：三年。");
    const first = parseObsidianNote("selected/first/说明.md", "第一份同名说明，不能被另一份覆盖。");
    const second = parseObsidianNote("selected/second/说明.md", "第二份同名说明，不能被另一份覆盖。");
    const notes = [entry, rules, first, second];
    const prepared = prepareObsidianNotes(notes, notes.map(({ path }) => path));
    expect(prepared).toHaveLength(4);
    expect(prepared[0]!.text).toContain("保修规则：三年");
    expect(prepared[0]!.metadata.warnings).toEqual(expect.arrayContaining([
      "引用重名，请明确路径：说明", "找不到引用笔记：产品/说明",
    ]));
    expect(prepared[0]!.text).not.toContain("同名说明，不能");
    expect(prepared[2]!.text).toBe(first.body);
    expect(prepared[3]!.text).toBe(second.body);
  });

  it("does not parse references inside code, escaped text or comments", () => {
    const text = "```md\n![[代码示例]]\n```\n`[[内联代码]]`\n\\[[转义]]\n%%[[注释]]%%\n[[实际笔记]]";
    expect(getObsidianReferences(text).map((ref) => ref.target)).toEqual(["实际笔记"]);
    expect(prepareObsidianNotes([note("入口.md", text)], ["Vault/入口.md"])[0]!.text).toContain("```md\n![[代码示例]]\n```");
  });

  it("expands selected headings and blocks, preserving structure and limiting cycles", () => {
    const root = note("入口.md", "![[规则#售后]]\n![[规则#^promise]]\n![[循环]]");
    const rules = note("规则.md", "# 介绍\n介绍内容\n## 售后\n保修三年\n## 其他\n不应嵌入的内容\n\n指定承诺。 ^promise");
    const cycle = note("循环.md", "![[循环]]");
    const result = prepareObsidianNotes([root, rules, cycle], [root.path, rules.path, cycle.path])[0]!;
    expect(result.text).toContain("保修三年"); expect(result.text).toContain("指定承诺。");
    expect(result.text).not.toContain("不应嵌入的内容");
    expect(result.metadata.warnings.some((warning) => warning.includes("循环"))).toBe(true);
  });

  it("reports ignored attachments and missing fragments without fetching anything", () => {
    const root = note("入口.md", "![[图片.png]] ![图](https://example.com/image.png) ![[规则#不存在]]");
    const rules = note("规则.md", "# 售后\n保修三年");
    const result = prepareObsidianNotes([root, rules], [root.path, rules.path])[0]!;
    expect(result.metadata.warnings).toEqual(expect.arrayContaining(["未导入附件内容：图片.png", "找不到引用段落：Vault/规则.md#不存在", "外部图片未下载或解析。"]));
  });

  it("assigns Windows-style numbers across existing and same-batch names, including case and long names", () => {
    const names = [{ title: "说明", originalFileName: "说明.md" }, { title: "说明（2）", originalFileName: "说明（2）.md" }];
    expect(nextObsidianFileName("说明.md", names)).toBe("说明（3）.md");
    expect(nextObsidianFileName("说明（2）.md", names)).toBe("说明（3）.md");
    const fileName = nextObsidianFileName("说明.md", names);
    names.push({ title: fileName.slice(0, -3), originalFileName: fileName });
    expect(nextObsidianFileName("说明.md", names)).toBe("说明（4）.md");
    expect(nextObsidianFileName("README.md", [{ title: "readme", originalFileName: null }])).toBe("README（2）.md");
    expect(nextObsidianFileName("a".repeat(220) + ".md", []).length).toBeLessThanOrEqual(183);
  });
});

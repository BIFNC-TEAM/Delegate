import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseReferences } from "../../../packages/model-runtime/src/v2/citations";
import { PublicChatText } from "../app/reps/[slug]/public-chat-text";

const render = (text: string, ranges: Array<{ id: string; start: number; end: number }> = []) => renderToStaticMarkup(<PublicChatText text={text} ranges={ranges} representativeSlug="fixture" messageId="message" />);
const annotated = (raw: string) => {
  const parsed = parseReferences(raw, new Set(["1", "2"]));
  expect(parsed.errors).toEqual([]);
  return render(parsed.text, parsed.ranges.map((range, index) => ({ id: `range-${index}`, start: range.start, end: range.end })));
};
describe("public citation Markdown source-to-render mapping", () => {
  it("maps one range across emphasis, entities, escapes, links and inline code", () => {
    const html = annotated('前😀 <reference source="1">**结论** &amp; \\* [说明](https://example.com) `code`</reference> 后');
    expect(html).toContain("前😀"); expect(html).toContain(" 后");
    expect(html).toContain("<p>前😀 <strong><button");
    expect(html).toContain("<strong><button"); expect(html).toContain("<code>code</code>");
    expect(html.match(/data-citation-range="range-0"/g)!.length).toBeGreaterThan(2);
    expect(html).not.toContain("href="); expect(html).not.toContain("https://example.com");
    expect(html).not.toContain("reference source");
  });
  it("supports per-cell ranges and independent source reuse", () => {
    const html = annotated('| A | B |\n| - | - |\n| <reference source="1">甲</reference> | <reference source="1,2">**乙**</reference> |');
    expect(html).toContain("<table>"); expect(html).toContain('data-citation-range="range-0"'); expect(html).toContain('data-citation-range="range-1"');
  });
  it("shows tables, deletion and disabled read-only task states", () => {
    const html = render('| A | B |\n| - | - |\n| 1 | 2 |\n\n~~旧方案~~\n\n- [x] 完成\n- [ ] 未完成');
    expect(html).toContain("<table>"); expect(html).toContain("<del>旧方案</del>");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/disabled=""/g)).toHaveLength(2); expect(html).toContain('readOnly=""');
  });
  it("never executes HTML, loads model images, or navigates explicit/automatic links", () => {
    const html = render('<script>window.PWNED=true</script>\n\n![替代说明](https://remote.invalid/tracker.png)\n\n[点击](javascript:alert(1))\n\nhttps://example.com a@example.com <https://example.com>\n\n[^1]\n\n[^1]: 说明\n\n$x^2$');
    expect(html).not.toMatch(/<script|<img|src=|href=|<a\b|<math/);
    expect(html).not.toContain("PWNED"); expect(html).not.toContain("tracker.png"); expect(html).toContain("替代说明");
    expect(html).toContain("https://example.com"); expect(html).toContain("a@example.com"); expect(html).not.toContain('role="doc-noteref"');
  });
  it("keeps protocol code examples as code and disables corrupt mapping instead of highlighting different text", () => {
    expect(render('```xml\n<reference source="1">示例</reference>\n```')).not.toContain("representative-citation-text");
    const html = render("&amp; safe", [{ id: "broken", start: 0, end: 3 }]);
    expect(html).toContain("&amp; safe"); expect(html).not.toContain("representative-citation-text");
  });
  it("maps escaped pipes and quote/list continuation prefixes", () => {
    expect(annotated('| A | B |\n| - | - |\n| <reference source="1">甲\\|乙 &amp;</reference> | C |')).toContain("甲|乙 &amp;");
    const html = annotated('> <reference source="1">第一行\n> 第二行</reference>');
    expect(html).toContain("第一行"); expect(html).toContain("第二行"); expect(html).toContain('data-citation-range="range-0"');
  });
});

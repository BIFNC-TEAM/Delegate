import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { sanitizeUntrustedArtifactPayload } from "@delegate/runtime";
import { browserEvidenceExtractor } from "../src/browser-evidence";

const text = (value: string) => ({ nodeType: 3, textContent: value });
const element = (tagName: string, children: unknown[], display = "block") => ({
  nodeType: 1, tagName, childNodes: children, innerText: children.map((child:any) => child.innerText ?? child.textContent ?? "").join(" "), style: { display, visibility: "visible" }, getAttribute: () => null,
});
const extract = (children: unknown[]) => runInNewContext(browserEvidenceExtractor, {
  document: { body: element("BODY", children) }, getComputedStyle: (node: any) => node.style,
}) as string;

describe("browser evidence boundaries", () => {
  it.each(['新款', '推荐', '售罄', 'Premium'])('keeps %s inside its original heading or link, never the neighbor', label => {
    const value = extract([
      element('A', [element('SPAN', [text('Item A')], 'inline'), element('SPAN', [text(label)], 'inline')], 'inline'),
      element('A', [text('Item B')], 'inline'),
      element('H3', [element('SPAN', [text(label)], 'inline'), element('SPAN', [text('Item A')], 'inline')]),
      element('H3', [text('Item B')]),
    ]);
    const groups = value.split('\n').filter(line => /^\[(heading|link text)\] /u.test(line)).map(line => JSON.parse(line.replace(/^\[[^\]]+\] /u, '')));
    expect(groups).toEqual([`Item A ${label}`, 'Item B', `${label} Item A`, 'Item B']);
    expect(groups.filter(group => group.includes(label)).every(group => !group.includes('Item B'))).toBe(true);
  });
  it('does not invent a negative status for an unlabelled item', () => {
    expect(extract([element('H3', [text('Item B')])])).toBe('[heading] "Item B"');
  });
  it('does not publish an unfinished quoted heading at the size limit', () => {
    const value = extract([text('x'.repeat(7990)), element('H3', [text('Label Item')])]);
    expect(value).not.toContain('[heading]');
    expect(value.length).toBeLessThanOrEqual(8000);
  });
  it("preserves separate numeric DOM fields before PII sanitization, without splitting a single ambiguous text node", () => {
    const value = extract([element("H2", [text("单位净值 (2026-10-12)")]),
      element("SPAN", [text("4.0145")], "inline"), element("SPAN", [text("0.40%")], "inline"),
      element("P", [text("+86 138 0013 8000")])]);
    expect(value).toContain("4.0145\t0.40%");
    const sanitized = JSON.stringify(sanitizeUntrustedArtifactPayload({ textSnippet: value }).sanitized);
    expect(sanitized).toContain("4.0145\\t0.40%"); expect(sanitized).not.toContain("138 0013 8000");
    expect(extract([text("4.01450.40%")])).toBe("4.01450.40%");
  });
  it("retains headings, linked headlines and table boundaries without granting them authority", () => {
    const value = extract([element("H2", [text("现任经理")]),element("P", [text("张坤、彭珂")]),
      element("H2", [text("相关资讯")]),element("A", [text("张坤卸任、韩创离任")], "inline"),
      element("H2", [text("用户讨论")]),element("TABLE", [element("TR", [element("TH", [text("标题")], "table-cell"),element("TH", [text("日期")], "table-cell")], "table-row"),
        element("TR", [element("TD", [text("张琦接盘？")], "table-cell"),element("TD", [text("10-03")], "table-cell")], "table-row")], "table")]);
    expect(value).toContain('[heading] "现任经理"\n张坤、彭珂');
    expect(value).toContain('[heading] "相关资讯"\n[link text] "张坤卸任、韩创离任"');
    expect(value).toContain('[heading] "用户讨论"\n[table]\n标题\t日期\n张琦接盘？\t10-03\n[/table]');
  });
  it("omits hidden/script content and bounds extraction", () => {
    expect(extract([element("SCRIPT", [text("SECRET")]), element("DIV", [text("HIDDEN")], "none"), text("visible")])).toBe("visible");
    expect(extract([text("x".repeat(10000))])).toHaveLength(8000);
  });
  it("preserves line breaks and tabs in preformatted evidence",()=>{
    const pre=element("PRE",[text("first\nsecond\tvalue")]);
    Object.assign(pre.style,{whiteSpace:"pre"});
    expect(extract([pre])).toBe("first\nsecond\tvalue");
  });
});

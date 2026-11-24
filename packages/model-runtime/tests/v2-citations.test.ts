import { describe, expect, it } from "vitest";
import { parseReferences, readCitationAnswer } from "../src/v2/citations";
import { parseDelegateMarkdown } from "../src/markdown";

const legal = new Set(["1", "2"]);
describe("reference parsing against the final Markdown source", () => {
  it("[answer-citations-12/14/15] normalizes LF, deduplicates sources and counts UTF-16 after removing tags", () => {
    const result = parseReferences('前😀\r\n<reference source="1, 2,1">**结论😀**</reference>。', legal);
    expect(result.errors).toEqual([]);
    expect(result.text).toBe("前😀\n**结论😀**。");
    expect(result.ranges).toEqual([{ start: 4, end: 12, sourceIds: ["1", "2"] }]);
    expect(result.text.slice(4, 12)).toBe("**结论😀**");
  });
  it("[answer-citations-01/03] keeps independent ranges including repeated source use", () => {
    const result = parseReferences('<reference source="1">甲</reference> 和 <reference source="1,2">乙</reference>', legal);
    expect(result).toEqual({ text: "甲 和 乙", ranges: [{ start: 0, end: 1, sourceIds: ["1"] }, { start: 4, end: 5, sourceIds: ["1", "2"] }], errors: [] });
  });
  it.each([
    ['<Reference source="1">甲</Reference>', "invalid_tag"],
    ["<reference source='1'>甲</reference>", "invalid_tag"],
    ['<reference source="1" extra="x">甲</reference>', "invalid_tag"],
    ['<reference source="">甲</reference>', "invalid_source_list"],
    ['<reference source="1,">甲</reference>', "invalid_source_list"],
    ['<reference source="-1">甲</reference>', "invalid_source_list"],
    ['<reference source="3">甲</reference>', "unknown_source"],
    ['<reference source="1">甲', "unclosed_reference"],
    ['甲</reference>', "unexpected_close"],
    ['<reference source="1"><reference source="2">甲</reference></reference>', "nested_reference"],
    ['<reference source="1"> </reference>', "empty_reference"],
    ['<reference source="1">**甲</reference>**', "invalid_boundary"],
    ['**甲<reference source="1">乙**丙</reference>', "invalid_boundary"],
    ['<reference source="1">甲\n\n乙</reference>', "invalid_boundary"],
    ['<reference source="1">甲\n- 乙</reference>', "invalid_boundary"],
    ['<reference source="1">\n```js\ncode\n```\n</reference>', "invalid_boundary"],
    ['旧协议 [S:1]', "legacy_reference"],
    ['<reference source="1">&am</reference>p;', "invalid_boundary"],
    ['<reference source="1">\\</reference>*', "invalid_boundary"],
  ])("[answer-citations-02/04/06/07/10/13] rejects %s (%s)", (text, code) => {
    expect(parseReferences(text, legal).errors.map(error => error.code)).toContain(code);
  });
  it.each([
    '`<reference source="9">代码</reference>`',
    '```xml\n<reference source="9">代码</reference>\n```',
    '~~~xml\n<reference source="9">未闭合围栏',
    '    <reference source="9">缩进代码</reference>',
    '`[S:old]`',
  ])("[answer-citations-08/09] protects Markdown code: %s", text => {
    expect(parseReferences(text, legal)).toEqual({ text, ranges: [], errors: [] });
  });
  it("[answer-citations-11] allows standalone inline formatting, links, escaped text and task items", () => {
    for (const text of ['<reference source="1">[说明](https://example.com)</reference>', '- [x] <reference source="1">~~旧方案~~ 与新方案</reference>', '**<reference source="1">结论</reference>**']) {
      expect(parseReferences(text, legal).errors).toEqual([]);
    }
  });
  it("[answer-citations-cell-01/02] permits per-cell citations and rejects crossing cells or the whole table", () => {
    const table = '| 项目 | 说明 |\n| --- | --- |\n| A | <reference source="1,2">结论</reference> |';
    const result = parseReferences(table, legal);
    expect(result.errors).toEqual([]);
    expect(result.text.slice(result.ranges[0]!.start, result.ranges[0]!.end)).toBe("结论");
    expect(parseReferences('| 项目 | 说明 |\n| --- | --- |\n| <reference source="1">A | 结论</reference> |', legal).errors.map(e => e.code)).toContain("invalid_boundary");
    expect(parseReferences(`<reference source="1">${table.replace(/<\/?reference[^>]*>/g, "")}</reference>`, legal).errors.map(e => e.code)).toContain("invalid_boundary");
  });
  it("rejects references against an empty source set without inventing bindings", () => {
    expect(parseReferences('<reference source="1">甲</reference>', new Set()).errors.map(e => e.code)).toEqual(["unknown_source"]);
  });
  it("[answer-citations-12] rejects a tag boundary that would split a reconstructed surrogate pair", () => {
    const result = parseReferences('\uD83D<reference source="1">\uDE00</reference>', legal);
    expect(result.text).toBe("😀");
    expect(result.errors.map(e => e.code)).toContain("invalid_boundary");
  });
});

describe("shared selected Markdown extensions", () => {
  it("does not recognize angle-bracket automatic URL/email links", () => {
    expect(JSON.stringify(parseDelegateMarkdown("<https://example.com> <user@example.com>"))).not.toContain('"type":"link"');
  });
  it("never treats state-wrapper code examples as an actual clarification", () => {
    expect(readCitationAnswer('```xml\n<waiting_user>示例\n```')).toEqual({ text: '```xml\n<waiting_user>示例\n```', state: "completed" });
    expect(readCitationAnswer('已有分析\n<waiting_user>请提供参数。')).toEqual({ text: "请提供参数。", state: "waiting_user" });
    expect(readCitationAnswer('已有结论\n<partial>尚有限制。')).toEqual({ text: "已有结论\n尚有限制。", state: "partial" });
  });
  it("parses tables, delete and read-only task state without automatic links or footnotes", () => {
    const tree = parseDelegateMarkdown('| A | B |\n| - | - |\n| 1 | 2 |\n\n~~旧~~\n\n- [x] 已完成\n\nhttps://example.com a@example.com\n\n[^1]\n\n[^1]: 说明');
    const serialized = JSON.stringify(tree);
    expect(serialized).toContain('"type":"table"');
    expect(serialized).toContain('"type":"delete"');
    expect(serialized).toContain('"checked":true');
    expect(serialized).not.toContain('"type":"link"');
    expect(serialized).not.toContain('"type":"footnoteReference"');
    expect(serialized).not.toContain('"type":"footnoteDefinition"');
  });
});

describe("answer state wrapper delivery", () => {
  it.each(["answer", "partial", "waiting_user"])("removes a matched trailing %s wrapper before computing ranges", tag => {
    const answer = readCitationAnswer(`<${tag}><reference source="1">结论😀</reference></${tag}>`);
    expect(answer.text).toBe('<reference source="1">结论😀</reference>');
    expect(parseReferences(answer.text, legal)).toMatchObject({ text: "结论😀", ranges: [{ start: 0, end: 4, sourceIds: ["1"] }], errors: [] });
  });
  it("keeps literal code and unmatched closing tags", () => {
    expect(readCitationAnswer('```xml\n<partial>示例</partial>\n```').text).toBe('```xml\n<partial>示例</partial>\n```');
    expect(readCitationAnswer('<partial>示例\n```xml\n</partial>').text).toBe('示例\n```xml\n</partial>');
    expect(readCitationAnswer('正文</partial>').text).toBe('正文</partial>');
  });
});

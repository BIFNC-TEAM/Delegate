import { unified, type Plugin } from "unified";
import remarkParse from "remark-parse";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { decodeString } from "micromark-util-decode-string";

/** Browser-safe remark plugin shared by reference validation and react-markdown.
 * Deliberately omit GFM autolink literals and footnotes. Raw HTML is never run.
 */
export const delegateMarkdown: Plugin = function () {
  const data = this.data();
  // CommonMark angle-bracket autolinks are disabled too, not just GFM literals.
  (data.micromarkExtensions ??= []).push({ disable: { null: ["autolink"] } });
  (data.micromarkExtensions ??= []).push(gfmTable(), gfmStrikethrough({ singleTilde: false }), gfmTaskListItem());
  (data.fromMarkdownExtensions ??= []).push(gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown(), gfmTaskListItemFromMarkdown());
};

const parser = unified().use(remarkParse).use(delegateMarkdown).freeze();
export function parseDelegateMarkdown(text: string) { return parser.parse(text); }

export type MarkdownTextToken = { sourceStart: number; sourceEnd: number; valueStart: number; valueEnd: number };
/** Map decoded text to exact source tokens, including entities and escapes.
 * Continuation-line quote/list indentation is not visible text. Return null
 * rather than guessing if the parser's decoded value cannot be reproduced.
 */
export function mapMarkdownText(raw: string, value: string, sourceOffset: number): MarkdownTextToken[] | null {
  const tokens: MarkdownTextToken[] = [];
  const lines = raw.split("\n");
  let sourceBase = 0, valueBase = 0;
  for (const [lineIndex, line] of lines.entries()) {
    const candidates = [0];
    if (lineIndex) {
      for (let index = 0; index < line.length && /[ \t>]/u.test(line[index]!); index++) candidates.push(index + 1);
    }
    const skip = candidates.find(offset => {
      const decoded = decodeString(line.slice(offset));
      const after = valueBase + decoded.length;
      return value.startsWith(decoded, valueBase) && (lineIndex === lines.length - 1 ? after === value.length : value[after] === "\n");
    });
    if (skip === undefined) return null;
    for (let index = skip; index < line.length;) {
      let length = (line.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
      const next = line.charCodeAt(index + 1);
      if (line[index] === "\\" && ((next >= 33 && next <= 47) || (next >= 58 && next <= 64) || (next >= 91 && next <= 96) || (next >= 123 && next <= 126))) length = 2;
      if (line[index] === "&") {
        const entity = /^&(?:#[xX][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{0,31});/u.exec(line.slice(index))?.[0];
        if (entity && decodeString(entity) !== entity) length = entity.length;
      }
      const decoded = decodeString(line.slice(index, index + length));
      tokens.push({ sourceStart: sourceOffset + sourceBase + index, sourceEnd: sourceOffset + sourceBase + index + length,
        valueStart: valueBase, valueEnd: valueBase + decoded.length });
      valueBase += decoded.length; index += length;
    }
    sourceBase += line.length;
    if (lineIndex < lines.length - 1) {
      tokens.push({ sourceStart: sourceOffset + sourceBase, sourceEnd: sourceOffset + sourceBase + 1, valueStart: valueBase, valueEnd: valueBase + 1 });
      sourceBase++; valueBase++;
    }
  }
  return valueBase === value.length ? tokens : null;
}

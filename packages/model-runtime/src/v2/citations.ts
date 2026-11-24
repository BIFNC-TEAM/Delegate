import { parseDelegateMarkdown, mapMarkdownText } from "../markdown";

export type CitationRange = { start: number; end: number; sourceIds: string[] };
export type CitationErrorCode = "invalid_tag" | "invalid_source_list" | "unknown_source" | "nested_reference" | "unclosed_reference" | "unexpected_close" | "empty_reference" | "invalid_boundary" | "legacy_reference" | "tool_call_during_recovery";
export type CitationError = { code: CitationErrorCode; offset: number; offsetSpace: "draft" | "body" };
export type CitationParseResult = { text: string; ranges: CitationRange[]; errors: CitationError[] };
export type CitationDiagnostics = {
  status: "valid" | "not_cited" | "invalid";
  recoveryCount: 0 | 1;
  firstErrors: CitationError[];
  finalErrors: CitationError[];
  recovery: "not_needed" | "used" | "budget_exhausted";
};
export const CITATION_FAILURE_TEXT = "本次回答的引用校验未通过，请重试";

type Node = { type: string; value?: string; position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined; children?: Node[] | undefined };
const start = (node: Node) => node.position?.start.offset ?? -1;
const end = (node: Node) => node.position?.end.offset ?? -1;
function walk(node: Node, fn: (node: Node) => void) { fn(node); node.children?.forEach(child => walk(child, fn)); }
const splitsSurrogate = (text: string, offset: number) => offset > 0 && offset < text.length
  && /[\uD800-\uDBFF]/u.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(text[offset]!);

function codeRanges(input: string): Array<[number, number]> {
  // Preserve both length and newlines so code positions stay in source space.
  const masked = input.replace(/<\/?reference\b[^>]*(?:>|$)/gi, match => match.replace(/[^\n]/g, "x"));
  const ranges: Array<[number, number]> = [];
  walk(parseDelegateMarkdown(masked), node => {
    if (node.type === "code" || node.type === "inlineCode") ranges.push([start(node), end(node)]);
  });
  return ranges;
}

/** Strip only active answer-state wrappers, never a protocol example in code. */
export function readCitationAnswer(raw: string): { text: string; state: "completed" | "partial" | "waiting_user" } {
  const input = raw.replace(/\r\n?/g, "\n");
  const protectedRanges = codeRanges(input);
  const protectedAt = (offset: number) => protectedRanges.some(([a, b]) => offset >= a && offset < b);
  const waiting = [...input.matchAll(/(?:^|\n)<waiting_user>/g)].find(match => !protectedAt(match.index + (match[0].startsWith("\n") ? 1 : 0)));
  const stripClosing = (text: string, tag: string) => {
    const match = new RegExp(`</${tag}>(?=\\s*$)`, "u").exec(text);
    if (!match || codeRanges(text).some(([start, end]) => match.index >= start && match.index < end)) return text;
    return text.slice(0, match.index) + text.slice(match.index + match[0].length);
  };
  if (waiting) return { text: stripClosing(input.slice(waiting.index + waiting[0].length), "waiting_user").trim(), state: "waiting_user" };
  const partial = [...input.matchAll(/(?:^|\n)<partial>/g)].find(match => !protectedAt(match.index + (match[0].startsWith("\n") ? 1 : 0)));
  if (partial) return { text: stripClosing((input.slice(0, partial.index) + (partial[0].startsWith("\n") ? "\n" : "") + input.slice(partial.index + partial[0].length)).replace(/^\s+/u, ""), "partial"), state: "partial" };
  return { text: input.startsWith("<answer>") ? stripClosing(input.replace(/^<answer>\s*/u, ""), "answer") : input, state: "completed" };
}

/** Parse the final answer, never tool bodies. Offsets are LF-normalized UTF-16.
 * Invalid results retain errors but must never be delivered by callers.
 */
export function parseReferences(raw: string, legalSources: ReadonlySet<string>): CitationParseResult {
  const input = raw.replace(/\r\n?/g, "\n");
  // Mask protocol delimiters before Markdown parsing so an opening custom HTML
  // tag cannot swallow following code nodes as an HTML block. Length is kept.
  const protectedRanges = codeRanges(input);
  const isProtected = (offset: number) => protectedRanges.some(([a, b]) => offset >= a && offset < b);
  const errors: CitationError[] = [];
  const ranges: CitationRange[] = [];
  let text = "";
  let cursor = 0;
  let open: { start: number; offset: number; sourceIds: string[] } | undefined;
  const tags = /<\/?reference\b[^>]*(?:>|$)|\[S:[^\]\n]*\]/gi;
  for (const match of input.matchAll(tags)) {
    const offset = match.index;
    if (isProtected(offset)) continue;
    text += input.slice(cursor, offset);
    cursor = offset + match[0].length;
    const tag = match[0];
    if (tag.startsWith("[S:")) { errors.push({ offsetSpace: "draft", code: "legacy_reference", offset }); text += tag; continue; }
    if (tag === "</reference>") {
      if (!open) errors.push({ offsetSpace: "draft", code: "unexpected_close", offset });
      else {
        if (!text.slice(open.start).trim()) errors.push({ offsetSpace: "draft", code: "empty_reference", offset: open.offset });
        ranges.push({ start: open.start, end: text.length, sourceIds: open.sourceIds });
        open = undefined;
      }
      continue;
    }
    const source = /^<reference source="([^"]*)">$/.exec(tag);
    if (!source) { errors.push({ offsetSpace: "draft", code: "invalid_tag", offset }); continue; }
    if (open) { errors.push({ offsetSpace: "draft", code: "nested_reference", offset }); continue; }
    const values = source[1]!.split(",").map(value => value.trim());
    if (values.some(value => !/^[1-9]\d*$/.test(value))) errors.push({ offsetSpace: "draft", code: "invalid_source_list", offset });
    const ids = [...new Set(values)];
    if (ids.some(id => !legalSources.has(id))) errors.push({ offsetSpace: "draft", code: "unknown_source", offset });
    open = { start: text.length, offset, sourceIds: ids };
  }
  text += input.slice(cursor);
  if (open) errors.push({ offsetSpace: "draft", code: "unclosed_reference", offset: open.offset });

  const tree = parseDelegateMarkdown(text);
  const containers: Node[] = [];
  const formatted: Node[] = [];
  const tokenBoundaries: Array<{ sourceStart: number; sourceEnd: number }> = [];
  walk(tree, node => {
    if (["paragraph", "tableCell"].includes(node.type)) containers.push(node);
    if (["strong", "emphasis", "delete", "link", "image", "inlineCode", "code", "html"].includes(node.type)) formatted.push(node);
    if (node.type === "text" && typeof node.value === "string") tokenBoundaries.push(...(mapMarkdownText(text.slice(start(node), end(node)), node.value, start(node)) ?? []));
  });
  for (const range of ranges) {
    const container = containers.find(node => start(node) <= range.start && end(node) >= range.end);
    let invalid = !container || splitsSurrogate(text, range.start) || splitsSurrogate(text, range.end);
    if (tokenBoundaries.some(token => [range.start, range.end].some(offset => offset > token.sourceStart && offset < token.sourceEnd))) invalid = true;
    for (const node of formatted) {
      const a = start(node), b = end(node);
      if (b <= range.start || a >= range.end) continue;
      if (node.type === "code") { invalid = true; continue; }
      if (range.start <= a && range.end >= b) continue;
      // A reference may sit entirely inside a formatting node's content, but
      // cannot consume only one delimiter or half of a Markdown link target.
      const children = node.children;
      if (!children?.length || range.start < start(children[0]!) || range.end > end(children.at(-1)!)) invalid = true;
    }
    if (invalid) errors.push({ offsetSpace: "body", code: "invalid_boundary", offset: range.start });
  }
  return { text, ranges, errors };
}

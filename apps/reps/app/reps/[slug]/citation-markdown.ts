import { mapMarkdownText } from "@delegate/model-runtime/markdown";

export type CitationTextRange = { id: string; start: number; end: number };
type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } } };
const start = (node: Node) => node.position?.start.offset ?? -1;
const end = (node: Node) => node.position?.end.offset ?? -1;
const wrapper = (rangeId: string, children: Node[]): Node => ({ type: "citationText", data: { hName: "span", hProperties: { "data-citation-range": rangeId } }, children });

/** A source interval can cover multiple rendered nodes. Each wrapper retains
 * the same range ID; source offsets are never used as DOM text offsets.
 */
export function citationRangePlugin(options: { text: string; ranges: CitationTextRange[] }) {
  return (root: unknown) => {
    const bad = new Set<string>();
    const tokens = new Map<Node, NonNullable<ReturnType<typeof mapMarkdownText>>>();
    const scan = (node: Node) => {
      if (node.type === "text" && typeof node.value === "string") {
        const mapped = mapMarkdownText(options.text.slice(start(node), end(node)), node.value, start(node));
        if (mapped) tokens.set(node, mapped);
        for (const range of options.ranges) if (range.start < end(node) && range.end > start(node)) {
          if (!mapped || mapped.some(token => [range.start, range.end].some(offset => offset > token.sourceStart && offset < token.sourceEnd))) bad.add(range.id);
        }
      }
      node.children?.forEach(scan);
    };
    scan(root as Node);
    const ranges = options.ranges.filter(range => !bad.has(range.id));
    const visit = (node: Node): Node[] => {
      if (node.type === "code" || node.type === "html") return [node];
      if (node.type === "inlineCode" || node.type === "image") {
        const range = ranges.find(range => range.start <= start(node) && range.end >= end(node));
        return range ? [wrapper(range.id, [node])] : [node];
      }
      if (node.type === "text" && typeof node.value === "string") {
        const mapped = tokens.get(node);
        if (!mapped) return [node];
        const parts: Node[] = [];
        let value = "", rangeId: string | undefined;
        const flush = () => {
          if (!value) return;
          const child: Node = { type: "text", value };
          parts.push(rangeId ? wrapper(rangeId, [child]) : child);
          value = "";
        };
        for (const token of mapped) {
          const id = ranges.find(range => range.start <= token.sourceStart && range.end >= token.sourceEnd)?.id;
          if (id !== rangeId) { flush(); rangeId = id; }
          value += node.value.slice(token.valueStart, token.valueEnd);
        }
        flush();
        return parts;
      }
      if (node.children) node.children = node.children.flatMap(visit);
      return [node];
    };
    visit(root as Node);
  };
}

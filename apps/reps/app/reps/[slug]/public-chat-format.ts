export type PublicChatTextBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "unordered-list"; items: string[] }
  | { kind: "ordered-list"; items: string[] }
  | { kind: "separator" };

type PublicChatListBlock = Extract<
  PublicChatTextBlock,
  { kind: "unordered-list" | "ordered-list" }
>;

export function parsePublicChatText(value: string): PublicChatTextBlock[] {
  const blocks: PublicChatTextBlock[] = [];
  let paragraph: string[] = [];
  let list: PublicChatListBlock | null = null;
  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };
  const flushList = () => {
    if (list?.items.length) blocks.push(list);
    list = null;
  };

  for (const rawLine of value.replace(/\r\n?/gu, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "separator" });
      continue;
    }
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/u);
    if (heading?.[1]) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", text: heading[1].trim() });
      continue;
    }
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/u);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/u);
    const listKind = unordered ? "unordered-list" as const
      : ordered ? "ordered-list" as const : null;
    const item = unordered?.[1] ?? ordered?.[1];
    if (listKind && item) {
      flushParagraph();
      if (list && list.kind !== listKind) flushList();
      const activeList: PublicChatListBlock = list ?? {
        kind: listKind,
        items: [],
      };
      activeList.items.push(item.trim());
      list = activeList;
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

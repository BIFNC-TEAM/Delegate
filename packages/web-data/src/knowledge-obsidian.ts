export { KNOWLEDGE_TITLE_MAX_LENGTH, renameKnowledgeMarkdownFile } from "./knowledge-filenames";
import { parseDocument } from "yaml";
import { z } from "zod";

export const MAX_OBSIDIAN_NOTES = 1_000;
export const MAX_OBSIDIAN_CHARACTERS = 400_000;
export const MAX_OBSIDIAN_SELECTION_BYTES = 40 * 1024 * 1024;

const sourcePathSchema = z.string().min(1).max(1024).refine((path) =>
  !path.includes("\\") && !path.startsWith("/") && !path.includes(":") &&
  !path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")),
"无效的笔记相对路径。",
);

// Only descriptive import metadata crosses the upload boundary, never permissions.
export const obsidianImportSchema = z.object({
  sourcePath: sourcePathSchema,
  properties: z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 64_000, "笔记属性过长。"),
  referencedPaths: z.array(sourcePathSchema).max(MAX_OBSIDIAN_NOTES),
  warnings: z.array(z.string().max(2048)).max(100),
  publishSource: z.object({
    siteName: z.string().max(512),
    sourceUrl: z.url().max(2048).refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }),
    originalPath: sourcePathSchema,
    importedAt: z.iso.datetime(),
  }).strict().optional(),
}).strict();

export type ObsidianImportMetadata = z.infer<typeof obsidianImportSchema>;
export type ObsidianNote = { path: string; body: string; properties: Record<string, unknown> };
export type ObsidianReference = { target: string; label: string; embedded: boolean; fragment: string; start: number; end: number };
export type PreparedObsidianNote = { path: string; fileName: string; text: string; metadata: ObsidianImportMetadata; requestedPaths: string[] };

export function isObsidianNotePath(path: string): boolean {
  return sourcePathSchema.safeParse(path).success && /\.(md|markdown)$/i.test(path) &&
    !path.split("/").some((part) => ["node_modules", "$recycle.bin"].includes(part.toLowerCase()));
}

export function parseObsidianNote(path: string, source: string): ObsidianNote {
  if (!isObsidianNotePath(path)) throw new Error("请选择 Markdown 笔记。");
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (text.length > MAX_OBSIDIAN_CHARACTERS) throw new Error(`${path}：正文超过 400,000 字符，请拆分后导入。`);
  if (!text.startsWith("---\n")) return { path, body: text, properties: {} };
  const header = text.match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)(?:\n|$)/);
  if (!header) throw new Error(`${path}：笔记属性缺少结束标记 ---。`);
  if (header[1]!.length > 64_000) throw new Error(`${path}：笔记属性过长。`);
  const document = parseDocument(header[1]!, { schema: "core", uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error(`${path}：笔记属性格式无效，请检查 YAML。`);
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (value !== null && (typeof value !== "object" || Array.isArray(value))) throw new Error(`${path}：笔记属性必须是键值信息。`);
  // JSON round trip excludes YAML runtime objects; properties never become answer text.
  const properties = JSON.parse(JSON.stringify(value ?? {})) as Record<string, unknown>;
  return { path, body: text.slice(header[0].length), properties };
}

// Mask code/comments without changing offsets. Example links in code are not imports.
function referenceText(text: string): string {
  const mask = (value: string) => value.replace(/[^\n]/g, " ");
  return text.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)/g, mask)
    .replace(/(`+)[^\n]*?\1|%%[\s\S]*?%%|<!--[\s\S]*?-->/g, mask);
}

export function getObsidianReferences(text: string): ObsidianReference[] {
  const visible = referenceText(text);
  const references: ObsidianReference[] = [];
  const pattern = /(!?)\[\[([^\]\n]+)\]\]|(!?)\[([^\]\n]*)\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g;
  for (const match of visible.matchAll(pattern)) {
    if (match.index > 0 && visible[match.index - 1] === "\\") continue;
    const wiki = match[2] !== undefined;
    const [rawTarget, alias] = wiki ? match[2]!.split("|") : [match[5]!.replace(/^<|>$/g, ""), match[4]];
    let target = rawTarget!.trim();
    try { target = decodeURIComponent(target); } catch { /* Keep literal filenames. */ }
    if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith("//")) continue;
    const hash = target.indexOf("#");
    references.push({ target: hash < 0 ? target : target.slice(0, hash), fragment: hash < 0 ? "" : target.slice(hash + 1),
      label: alias || target, embedded: Boolean(wiki ? match[1] : match[3]), start: match.index, end: match.index + match[0].length });
  }
  return references;
}

function normalizeRelativePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

export function resolveObsidianReference(from: string, target: string, availablePaths: readonly string[]): string[] {
  if (!target) return [from];
  const withoutExtension = (value: string) => value.replace(/\.(md|markdown)$/i, "").normalize("NFC");
  const root = from.split("/")[0]!;
  const relative = normalizeRelativePath(`${from.slice(0, from.lastIndexOf("/"))}/${target}`);
  const rooted = normalizeRelativePath(`${root}/${target.replace(/^\//, "")}`);
  for (const candidate of [relative, rooted]) {
    const matches = availablePaths.filter((path) => path.startsWith(`${root}/`) && withoutExtension(path) === withoutExtension(candidate));
    if (matches.length) return matches;
  }
  const suffix = `/${withoutExtension(target)}`;
  return availablePaths.filter((path) => path.startsWith(`${root}/`) && withoutExtension(path).endsWith(suffix));
}

function fragmentText(body: string, fragment: string): string | null {
  if (!fragment) return body;
  const lines = body.split("\n");
  if (fragment.startsWith("^")) {
    const end = lines.findIndex((line) => line.trimEnd().endsWith(fragment));
    if (end < 0) return null;
    let start = end;
    while (start > 0 && lines[start - 1]?.trim()) start -= 1;
    return lines.slice(start, end + 1).join("\n").replace(/\s*\^[\w-]+\s*$/, "");
  }
  const visible = referenceText(body).split("\n");
  const start = visible.findIndex((line) => line.match(/^#{1,6}\s+(.+?)\s*#*$/)?.[1]?.trim() === fragment.trim());
  if (start < 0) return null;
  const level = lines[start]!.match(/^#+/)![0].length;
  let end = start + 1;
  while (end < lines.length && !new RegExp(`^#{1,${level}}\\s`).test(visible[end]!)) end += 1;
  return lines.slice(start, end).join("\n");
}

export function prepareObsidianNotes(notes: readonly ObsidianNote[], availablePaths: readonly string[]): PreparedObsidianNote[] {
  const selected = new Map(notes.map((note) => [note.path, note]));
  let totalCharacters = 0;
  return notes.map((note) => {
    const warnings = new Set<string>();
    const requestedPaths = new Set<string>();
    const referencedPaths = new Set<string>();
    function render(path: string, fragment = "", stack: string[] = []): string {
      const key = `${path}#${fragment}`;
      if (stack.includes(key) || stack.length >= 12) { warnings.add(`循环或过深的嵌入引用：${path}`); return `[未展开嵌入：${path}]`; }
      const source = selected.get(path)!;
      const body = fragmentText(source.body, fragment);
      if (body === null) { warnings.add(`找不到引用段落：${key}`); return `[未找到段落：${key}]`; }
      const references = getObsidianReferences(body);
      let result = "";
      let cursor = 0;
      for (const ref of references) {
        result += body.slice(cursor, ref.start);
        cursor = ref.end;
        const extension = ref.target.split("/").pop()?.match(/\.[^.]+$/)?.[0];
        const matches = resolveObsidianReference(path, ref.target, availablePaths);
        const attachment = !matches.length && extension && !/^\.(md|markdown)$/i.test(extension);
        if (attachment) {
          if (ref.embedded) warnings.add(`未导入附件内容：${ref.target}`);
          result += ref.embedded ? `[附件未导入：${ref.label}]` : body.slice(ref.start, ref.end);
          continue;
        }
        const target = matches.length === 1 ? matches[0] : undefined;
        if (!target) {
          warnings.add(`${matches.length ? "引用重名，请明确路径" : "找不到引用笔记"}：${ref.target || path}`);
          result += ref.embedded ? `[引用未导入：${ref.label}]` : body.slice(ref.start, ref.end);
        } else if (!selected.has(target)) {
          requestedPaths.add(target);
          warnings.add(`未获允许，未导入引用内容：${target}`);
          result += ref.embedded ? `[引用未导入：${ref.label}]` : body.slice(ref.start, ref.end);
        } else {
          referencedPaths.add(target);
          result += ref.embedded ? `\n${render(target, ref.fragment, [...stack, key])}\n` : body.slice(ref.start, ref.end);
        }
        if (result.length > MAX_OBSIDIAN_CHARACTERS) throw new Error(`${note.path}：展开引用后正文超过 400,000 字符。`);
      }
      return result + body.slice(cursor);
    }
    const text = render(note.path);
    if (/```\s*(dataview|dataviewjs|tasks)\b/i.test(text)) warnings.add("动态插件查询不会执行，请将所需结果转为静态文本。");
    if (/!\[[^\]]*\]\(https?:/i.test(text) || /<img\b/i.test(text)) warnings.add("外部图片未下载或解析。");
    if (text.length > MAX_OBSIDIAN_CHARACTERS) throw new Error(`${note.path}：正文超过 400,000 字符。`);
    totalCharacters += text.length;
    if (totalCharacters > MAX_OBSIDIAN_SELECTION_BYTES) throw new Error("展开引用后的正文总量过大，请减少所选笔记并分批导入。");
    return { path: note.path, fileName: note.path.split("/").pop()!, text, requestedPaths: [...requestedPaths],
      metadata: obsidianImportSchema.parse({ sourcePath: note.path, properties: note.properties, referencedPaths: [...referencedPaths], warnings: [...warnings].slice(0, 100) }) };
  });
}

export type KnowledgeName = { title: string; originalFileName: string | null };

export function nextObsidianFileName(requested: string, occupied: readonly KnowledgeName[]): string {
  const extension = requested.match(/\.(md|markdown)$/i)?.[0] ?? ".md";
  const base = requested.replace(/\.(md|markdown)$/i, "").trim().slice(0, 180) || "Untitled";
  const normalize = (value: string) => value.normalize("NFC").trim().toLowerCase();
  const titles = new Set(occupied.map((item) => normalize(item.title)));
  const files = new Set(occupied.flatMap((item) => item.originalFileName ? [normalize(item.originalFileName)] : []));
  if (!titles.has(normalize(base)) && !files.has(normalize(base + extension))) return base + extension;
  const numbered = base.match(/^(.*?)[（(](\d+)[）)]$/);
  const stemBase = numbered?.[1]?.trimEnd() || base;
  const first = numbered ? Math.max(2, Number(numbered[2]) + 1) : 2;
  for (let copy = first; copy < first + 100_000; copy += 1) {
    const suffix = `（${copy}）`;
    const stem = `${stemBase.slice(0, 180 - suffix.length)}${suffix}`;
    if (!titles.has(normalize(stem)) && !files.has(normalize(stem + extension))) return stem + extension;
  }
  throw new Error("同名文件数量过多，无法分配名称。");
}

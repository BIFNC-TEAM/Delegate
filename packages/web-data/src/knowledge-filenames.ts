import { z } from "zod";

export const KNOWLEDGE_TITLE_MAX_LENGTH = 180;
export const knowledgeTitleSchema = z.string().trim().min(1).max(KNOWLEDGE_TITLE_MAX_LENGTH);
export const knowledgeOriginalFileNameSchema = z.string().trim().max(260);

export function renameKnowledgeMarkdownFile(original: string, name: string): string {
  const parsed = knowledgeTitleSchema.safeParse(name);
  if (!parsed.success) throw new Error("名称不能为空，且不能超过 180 个字符。");
  if (/[\\/\u0000-\u001f]/.test(parsed.data)) throw new Error("名称不能包含路径分隔符或控制字符。");
  const extension = original.match(/\.(md|markdown)$/i)?.[0];
  if (!extension) throw new Error("仅支持 Markdown 笔记，不能修改文件后缀。");
  return knowledgeOriginalFileNameSchema.parse(parsed.data + extension);
}

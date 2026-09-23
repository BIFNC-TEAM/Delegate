import { z } from "zod";

export const MAX_KNOWLEDGE_CAPTURE_CHARACTERS = 400_000;
export const MAX_KNOWLEDGE_CAPTURE_BYTES = 3 * 1024 * 1024;

// A browser snapshot is user-supplied text, never a server-side fetch request.
export const knowledgeCaptureUrlSchema = z.string().trim().max(2_048).url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "仅支持不含账号信息的 HTTP/HTTPS 来源网址。");

export function isKnowledgeVerificationPage(title: string): boolean {
  return /^(?:百度安全验证|安全验证|访问验证|人机验证|请先登录|登录|login|sign in|just a moment(?:\.{3})?|access denied|verify you are human)[\s!！…]*$/iu.test(title.trim());
}

export const knowledgeBrowserCaptureSchema = z.object({
  format: z.literal("delegate-web-capture"),
  version: z.literal(1),
  sourceUrl: knowledgeCaptureUrlSchema,
  title: z.string().trim().min(1).max(180).refine((value) => !isKnowledgeVerificationPage(value), "请先在来源页面完成登录或安全验证，再采集正文。"),
  text: z.string().trim().min(20, "采集正文不足 20 个字符，请完成验证并等待页面加载后重试。").max(MAX_KNOWLEDGE_CAPTURE_CHARACTERS),
  capturedAt: z.iso.datetime(),
}).strict();

export type KnowledgeBrowserCapture = z.infer<typeof knowledgeBrowserCaptureSchema>;

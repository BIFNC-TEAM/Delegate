import type { z } from "zod";
import type { FaqSourceStatus } from "./types";
import { faqSourceSchema } from "./types";

export function prepareFaqSources(sources: Array<z.infer<typeof faqSourceSchema>>) {
  let remaining = 8000;
  const statuses: FaqSourceStatus[] = [];
  const used: Array<z.infer<typeof faqSourceSchema>> = [];
  for (const item of sources) {
    const text = item.text.trim();
    if (!text) {
      statuses.push({ id: item.id, status: "skipped", reason: "正文为空" });
      continue;
    }
    if (!remaining) {
      statuses.push({ id: item.id, status: "unused", reason: "正文预算已用完" });
      continue;
    }
    const chars = Array.from(text);
    const n = Math.min(remaining, chars.length);
    remaining -= n;
    used.push({ ...item, text: chars.slice(0, n).join("") });
    statuses.push({ id: item.id, status: n < chars.length ? "partial" : "complete", ...(n < chars.length ? { reason: "正文超过预算" } : {}) });
  }
  const warning = statuses.some(s => s.status === "partial" || s.status === "unused") ? "资料较长，问答内容只根据前面的部分生成。" : undefined;
  return { used, base: { sources: statuses, ...(warning ? { warning } : {}) } };
}

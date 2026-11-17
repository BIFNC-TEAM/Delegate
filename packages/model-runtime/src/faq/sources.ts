import type { z } from "zod";
import type { FaqSourceStatus } from "./types";
import { faqSourceSchema } from "./types";

export function prepareFaqSources(sources: Array<z.infer<typeof faqSourceSchema>>, perSourceLimit?: number) {
  if (perSourceLimit !== undefined && (!Number.isSafeInteger(perSourceLimit) || perSourceLimit <= 0)) throw new RangeError("perSourceLimit must be a positive safe integer");
  let remaining = perSourceLimit === undefined ? 8000 : perSourceLimit * sources.length;
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
    const limit = Math.min(remaining, perSourceLimit ?? remaining);
    // A code point uses at most two UTF-16 units; bound allocation before expansion.
    const chars = Array.from(text.slice(0, limit * 2));
    const n = Math.min(limit, chars.length);
    const truncated = n < chars.length || text.length > limit * 2;
    remaining -= n;
    used.push({ ...item, text: chars.slice(0, n).join("") });
    statuses.push({ id: item.id, status: truncated ? "partial" : "complete", ...(truncated ? { reason: "正文超过预算" } : {}) });
  }
  const warning = statuses.some(s => s.status === "partial" || s.status === "unused") ? "资料较长，问答内容只根据前面的部分生成。" : undefined;
  return { used, base: { sources: statuses, ...(warning ? { warning } : {}) } };
}

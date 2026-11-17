import { z } from "zod";
import { resolveModelRuntimeEnv, resolveProviderAttemptOrder } from "../config";
import { faqSuggestionSchema, faqSuggestionsInputSchema } from "./types";
import type { FaqAttempt, FaqResult, FaqSuggestion, FaqSuggestionsInput } from "./types";
import { prepareFaqSources } from "./sources";
import { buildFaqPrompt } from "./prompt";
import { callProvider, classifyFailure } from "./provider";

/** Internal only: the caller must authorize all data and its disclosure to model providers. */
export async function generateFaqSuggestions(
  faqSuggestionsInput: FaqSuggestionsInput,
  options: { perSourceLimit?: number; requireSourceCitation?: boolean } = {},
): Promise<FaqResult> {
  const result = (status: FaqResult["status"], extra: Partial<FaqResult> = {}): FaqResult => ({
    status,
    suggestions: [],
    sources: [],
    attempts: [],
    returnedCount: 0,
    filteredCount: 0,
    truncatedCount: 0,
    ...extra,
  });
  const parsed = faqSuggestionsInputSchema.safeParse(faqSuggestionsInput);
  if (!parsed.success) {
    return result("invalid_input", { reason: "输入结构、数量或资料标识无效（标识不可重复或使用 representative）。" });
  }
  const { used, base } = prepareFaqSources(parsed.data.sources, options.perSourceLimit);
  if (!used.length) {
    return result("no_usable_sources", base);
  }
  const env = resolveModelRuntimeEnv();
  const providers = resolveProviderAttemptOrder(env);
  if (env.state !== "ready" || !providers.length) {
    return result("model_failure", { ...base, reason: "模型未配置或不可用。" });
  }
  const prompt = buildFaqPrompt(parsed.data, used, options);
  const attempts: FaqAttempt[] = [];
  for (const provider of providers) {
    attempts.push({ provider, model: env[provider].model });
    try {
      const response = await callProvider(provider, { ...env, maxOutputTokens: Math.max(env.maxOutputTokens, 2048) }, prompt);
      if (response.completion.status !== "complete") {
        return result("invalid_output", { ...base, attempts, reason: "模型响应不完整。" });
      }
      let json: unknown;
      try {
        json = JSON.parse(unwrapJsonFence(response.replyText));
      } catch {
        return result("invalid_output", { ...base, attempts, reason: "模型输出不是有效 JSON。" });
      }
      const envelope = z.object({ suggestions: z.array(z.unknown()).max(100) }).safeParse(normalizeProviderKeys(json));
      if (!envelope.success) {
        return result("invalid_output", { ...base, attempts, reason: "模型输出结构无效。" });
      }
      const validIds = new Set(["representative", ...used.map(s => s.id)]);
      const candidates = envelope.data.suggestions;
      const valid = candidates.flatMap((item) => {
        const candidate = faqSuggestionSchema.safeParse(item);
        if (!candidate.success || !candidate.data.sourceIds.every((id) => validIds.has(id)) || (options.requireSourceCitation && !candidate.data.sourceIds.some((id) => used.some((source) => source.id === id)))) {
          return [];
        }
        return [candidate.data];
      });
      const suggestions = valid.slice(0, parsed.data.count);
      const counts = {
        returnedCount: suggestions.length,
        filteredCount: candidates.length - valid.length,
        truncatedCount: valid.length - suggestions.length,
      };
      if (!candidates.length) {
        return result("insufficient_material", { ...base, attempts, ...counts, reason: "资料不足以生成有依据的建议。" });
      }
      if (!suggestions.length) {
        return result("no_valid_suggestions", { ...base, attempts, ...counts, reason: "所有候选建议的结构或出处均未通过检查。" });
      }
      return result("success", { ...base, attempts, ...counts, suggestions });
    } catch (error) {
      const kind = classifyFailure(error);
      const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined;
      Object.assign(attempts[attempts.length - 1]!, { kind, ...(status === undefined ? {} : { status }) });
      const reason = kind === "invalid_output" ? "供应商返回无效或空响应。" : kind === "timeout" ? "模型请求超时。" : kind === "retryable" ? "供应商暂时不可用。" : "模型请求失败。";
      if (kind === "invalid_output") return result("invalid_output", { ...base, attempts, reason });
      if (kind === "non_retryable" || provider === providers.at(-1)) return result(kind === "timeout" ? "timeout" : "model_failure", { ...base, attempts, reason });
    }
  }
  return result("model_failure", { ...base, attempts });
}
function unwrapJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}
function normalizeProviderKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeProviderKeys);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [
    key.startsWith("/") && ["suggestions", "question", "answer", "sourceIds"].includes(key.slice(1)) && !(key.slice(1) in record) ? key.slice(1) : key,
    normalizeProviderKeys(item),
  ]));
}
export function decideFaqSuggestion(item: FaqSuggestion, accepted: boolean) {
  if (!accepted) return { accepted: false as const };
  const parsed = faqSuggestionSchema.safeParse(item);
  if (!parsed.success) return { accepted: false as const, status: "invalid_input" as const, reason: "建议结构无效。" };
  return { accepted: true as const, faq: { question: parsed.data.question, answer: parsed.data.answer, sourceIds: [...parsed.data.sourceIds] } };
}

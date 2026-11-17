import { resolveModelRuntimeEnv, resolveProviderAttemptOrder } from "../config";
import { callProvider, classifyFailure } from "../faq/provider";
import { serviceContentInputSchema } from "./types";
import type { ServiceContentInput, ServiceContentResult } from "./types";
import { buildServiceContentPrompt } from "./prompt";

/** Caller must authenticate the Owner before disclosing input to a provider. No persistence or tools. */
export async function generateServiceContentSuggestion(input: ServiceContentInput): Promise<ServiceContentResult> {
  const attempts: ServiceContentResult["attempts"] = [];
  const result = (status: ServiceContentResult["status"], message?: string, serviceContent = "", truncated = false): ServiceContentResult =>
    ({ status, serviceContent, truncated, ...(message ? { message } : {}), attempts });
  const parsed = serviceContentInputSchema.safeParse(input);
  if (!parsed.success) return result("invalid_input", "输入无效。");
  const data = parsed.data;
  if (!data.workFields.length && !data.serviceContent) return result("insufficient_input", "请填写工作方向或服务内容。");
  const env = resolveModelRuntimeEnv();
  const providers = resolveProviderAttemptOrder(env);
  if (env.state !== "ready" || !providers.length) return result("model_failure", "模型未配置或不可用。");
  const prompt = buildServiceContentPrompt(data);
  for (let generation = 0; generation < 2; generation++) {
    for (const provider of providers) {
      const attempt: ServiceContentResult["attempts"][number] = { provider, model: env[provider].model };
      attempts.push(attempt);
      try {
        const response = await callProvider(provider, env, prompt, true);
        if (response.completion.status !== "complete" || typeof response.replyText !== "string") return result("model_failure", "模型响应无效或不完整。");
        const text = response.replyText.trim();
        if (!text) break;
        const points = Array.from(text);
        return result("success", points.length > 500 ? "建议已截断，请审核后采纳。" : undefined, points.slice(0, 500).join(""), points.length > 500);
      } catch (error) {
        const kind = classifyFailure(error);
        attempt.kind = kind;
        if (kind === "invalid_output" || kind === "non_retryable" || provider === providers.at(-1)) {
          return result(kind === "timeout" ? "timeout" : "model_failure", kind === "timeout" ? "模型请求超时，请重试。" : "模型生成失败，请重试。");
        }
      }
    }
  }
  return result("empty_suggestion", "未生成建议，请重试或补充信息。");
}

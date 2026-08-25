import OpenAI from "openai";

import { calculateModelUsageCost } from "./pricing";
import type {
  ModelRuntimeEnv,
  ModelTextCompletion,
  ModelUsageSnapshot,
  RepresentativeReplyPrompt,
} from "./types";

export async function generateBailianResponse(params: {
  env: ModelRuntimeEnv;
  prompt: RepresentativeReplyPrompt;
}): Promise<{
  replyText: string;
  usage?: ModelUsageSnapshot;
  completion: ModelTextCompletion;
}> {
  if (params.env.state !== "ready" || !params.env.bailian.apiKey) {
    throw new Error(`Bailian runtime is not ready: ${params.env.state}.`);
  }

  const client = new OpenAI({
    apiKey: params.env.bailian.apiKey,
    baseURL:
      params.env.bailian.baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    timeout: params.env.timeoutMs,
    maxRetries: 0,
  });

  const response = await client.chat.completions.create({
    model: params.env.bailian.model,
    messages: [
      { role: "system", content: params.prompt.instructions },
      { role: "user", content: params.prompt.input },
    ],
    ...(params.prompt.strictJsonSchema
      ? {
          response_format: {
            type: "json_schema" as const,
            json_schema: {
              name: params.prompt.strictJsonSchema.name,
              ...(params.prompt.strictJsonSchema.description
                ? { description: params.prompt.strictJsonSchema.description }
                : {}),
              schema: params.prompt.strictJsonSchema.schema,
              strict: true,
            },
          },
        }
      : {
          max_tokens: params.env.maxOutputTokens,
          ...(params.prompt.responseFormat === "json_object"
            ? { response_format: { type: "json_object" as const } }
            : {}),
        }),
  });

  const replyText = response.choices[0]?.message.content?.trim();
  if (!replyText) {
    throw new Error("Bailian Chat Completions returned no text output.");
  }

  const usage = response.usage
    ? (() => {
        const baseUsage = {
          provider: "bailian" as const,
          model: params.env.bailian.model,
          ...(typeof response.id === "string" ? { responseId: response.id } : {}),
          ...(typeof response.usage.prompt_tokens === "number"
            ? { inputTokens: response.usage.prompt_tokens }
            : {}),
          ...(typeof response.usage.completion_tokens === "number"
            ? { outputTokens: response.usage.completion_tokens }
            : {}),
          ...(typeof response.usage.total_tokens === "number"
            ? { totalTokens: response.usage.total_tokens }
            : {}),
        };
        const pricedUsage = calculateModelUsageCost({
          pricing: params.env.bailian.pricing,
          usage: {
            ...(typeof baseUsage.inputTokens === "number"
              ? { inputTokens: baseUsage.inputTokens }
              : {}),
            ...(typeof baseUsage.outputTokens === "number"
              ? { outputTokens: baseUsage.outputTokens }
              : {}),
            ...(typeof baseUsage.totalTokens === "number"
              ? { totalTokens: baseUsage.totalTokens }
              : {}),
          },
        });

        return {
          ...baseUsage,
          costCents: pricedUsage.costCents,
          estimatedCostUsd: pricedUsage.estimatedCostUsd,
        };
      })()
    : undefined;

  return {
    replyText,
    ...(usage ? { usage } : {}),
    completion: response.choices[0]?.finish_reason === "stop"
      ? { status: "complete" }
      : {
          status: "incomplete",
          reason: response.choices[0]?.finish_reason ?? "unknown",
        },
  };
}

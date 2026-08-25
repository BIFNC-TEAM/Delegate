import Anthropic from "@anthropic-ai/sdk";

import { calculateModelUsageCost } from "./pricing";
import type {
  ModelRuntimeEnv,
  ModelTextCompletion,
  ModelUsageSnapshot,
  RepresentativeReplyPrompt,
} from "./types";

export async function generateAnthropicResponse(params: {
  env: ModelRuntimeEnv;
  prompt: RepresentativeReplyPrompt;
}): Promise<{
  replyText: string;
  usage?: ModelUsageSnapshot;
  completion: ModelTextCompletion;
}> {
  if (params.prompt.strictJsonSchema) {
    throw new Error("Anthropic adapter does not support Delegate strict JSON Schema planning.");
  }
  if (params.env.state !== "ready" || !params.env.anthropic.apiKey) {
    throw new Error(`Anthropic runtime is not ready: ${params.env.state}.`);
  }

  const client = new Anthropic({
    apiKey: params.env.anthropic.apiKey,
    ...(params.env.anthropic.baseUrl ? { baseURL: params.env.anthropic.baseUrl } : {}),
    timeout: params.env.timeoutMs,
    // Keep the configured timeout as a real end-to-end budget. Provider
    // fallback is coordinated by the model runtime instead of the SDK.
    maxRetries: 0,
  });

  const response = await client.messages.create({
    model: params.env.anthropic.model,
    max_tokens: params.env.maxOutputTokens,
    system: params.prompt.instructions,
    messages: [
      {
        role: "user",
        content: params.prompt.input,
      },
    ],
  });

  const replyText = extractMessageText(response);
  if (!replyText) {
    throw new Error("Anthropic Messages returned no text output.");
  }

  const usageBase = {
    provider: "anthropic" as const,
    model: params.env.anthropic.model,
    ...(typeof response.id === "string" ? { responseId: response.id } : {}),
    ...(typeof response.usage?.input_tokens === "number"
      ? { inputTokens: response.usage.input_tokens }
      : {}),
    ...(typeof response.usage?.output_tokens === "number"
      ? { outputTokens: response.usage.output_tokens }
      : {}),
  };
  const totalTokens =
    (usageBase.inputTokens ?? 0) + (usageBase.outputTokens ?? 0);
  const usageWithCost = calculateModelUsageCost({
    pricing: params.env.anthropic.pricing,
    usage: {
      ...(typeof usageBase.inputTokens === "number" ? { inputTokens: usageBase.inputTokens } : {}),
      ...(typeof usageBase.outputTokens === "number"
        ? { outputTokens: usageBase.outputTokens }
        : {}),
      totalTokens,
    },
  });

  return {
    replyText,
    completion: response.stop_reason === "end_turn"
      || response.stop_reason === "stop_sequence"
      ? { status: "complete" }
      : { status: "incomplete", reason: response.stop_reason ?? "unknown" },
    usage: {
      ...usageBase,
      totalTokens,
      costCents: usageWithCost.costCents,
      estimatedCostUsd: usageWithCost.estimatedCostUsd,
    },
  };
}

function extractMessageText(response: {
  content?: Array<{
    type: string;
    text?: string;
  }>;
}): string {
  const chunks: string[] = [];
  for (const part of response.content ?? []) {
    if (
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.trim()
    ) {
      chunks.push(part.text.trim());
    }
  }

  return chunks.join("\n\n").trim();
}

import { calculateModelUsageCost } from "./pricing";
import type {
  ModelRuntimeEnv,
  ModelTextCompletion,
  ModelUsageSnapshot,
  RepresentativeReplyPrompt,
} from "./types";

/**
 * AGICTO exposes an OpenAI-compatible HTTP request shape, but remains a
 * distinct provider for transport, configuration, telemetry, and billing.
 * This adapter calls AGICTO directly and never constructs an OpenAI client.
 */
export async function generateAgictoResponse(params: {
  env: ModelRuntimeEnv;
  prompt: RepresentativeReplyPrompt;
}): Promise<{
  replyText: string;
  usage?: ModelUsageSnapshot;
  completion: ModelTextCompletion;
}> {
  if (params.env.state !== "ready" || !params.env.agicto.apiKey) {
    throw new Error(`AGICTO runtime is not ready: ${params.env.state}.`);
  }

  const baseUrl = params.env.agicto.baseUrl ?? "https://api.agicto.cn/v1";
  const endpoint = new URL(
    "chat/completions",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );
  const httpResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.env.agicto.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: params.env.agicto.model,
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
    }),
    signal: AbortSignal.timeout(params.env.timeoutMs),
  });
  const response = await readAgictoResponse(httpResponse);

  const providerError = readAgictoProviderError(response);
  if (providerError) {
    throw new Error(
      `AGICTO API error${providerError.code ? ` (${providerError.code})` : ""}: ${providerError.message}`,
    );
  }
  if (!httpResponse.ok) {
    throw new Error(`AGICTO API request failed with HTTP ${httpResponse.status}.`);
  }

  const choice = response.choices?.[0];
  const replyText = choice?.message?.content?.trim();
  if (!replyText) {
    throw new Error("AGICTO Chat Completions returned no text output.");
  }

  const usage = response.usage
    ? (() => {
        const baseUsage = {
          provider: "agicto" as const,
          model: params.env.agicto.model,
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
          pricing: params.env.agicto.pricing,
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
    completion: choice?.finish_reason === "stop"
      ? { status: "complete" }
      : {
          status: "incomplete",
          reason: choice?.finish_reason ?? "unknown",
        },
  };
}

type AgictoResponse = {
  id?: string;
  error?: unknown;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

async function readAgictoResponse(response: Response): Promise<AgictoResponse> {
  const raw = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`AGICTO API returned non-JSON HTTP ${response.status} content.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AGICTO API returned an invalid response envelope.");
  }
  return value as AgictoResponse;
}

function readAgictoProviderError(value: unknown) {
  if (!value || typeof value !== "object" || !("error" in value)) return null;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const message = "message" in error && typeof error.message === "string"
    ? normalizeProviderDiagnostic(error.message)
    : "AGICTO returned an unsuccessful response.";
  const code = "code" in error && typeof error.code === "string"
    ? normalizeProviderDiagnostic(error.code)
    : null;
  return { message, code };
}

function normalizeProviderDiagnostic(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

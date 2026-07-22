import { generateAnthropicResponse } from "./anthropic";
import { generateBailianResponse } from "./bailian";
import { assembleRepresentativeReplyPrompt } from "./context";
import { resolveModelRuntimeEnv, resolveProviderAttemptOrder } from "./config";
import { generateOpenAIResponse } from "./openai";
import {
  buildNaturalLanguageComputePrompt,
  inferDeterministicNaturalLanguageComputePlan,
  isNaturalLanguageComputePlanGrounded,
  parseNaturalLanguageComputePlan,
} from "./compute-planner";
import type {
  ModelProvider,
  NaturalLanguageComputePlannerResult,
  RepresentativeReplyInput,
  RepresentativeReplyResult,
} from "./types";

export * from "./config";
export * from "./context";
export * from "./pricing";
export * from "./types";

export async function planNaturalLanguageComputeRequest(params: {
  userText: string;
}): Promise<NaturalLanguageComputePlannerResult> {
  const deterministic = inferDeterministicNaturalLanguageComputePlan(params.userText);
  const env = resolveModelRuntimeEnv();
  if (env.state !== "ready") {
    return deterministic
      ? { ok: true, plan: deterministic, source: "deterministic" }
      : { ok: false, reason: `Model runtime unavailable: ${env.state}.`, state: env.state };
  }

  const attemptOrder = resolveProviderAttemptOrder(env);
  if (!attemptOrder.length) {
    return deterministic
      ? { ok: true, plan: deterministic, source: "deterministic" }
      : { ok: false, reason: "Model runtime has no credentialed providers available.", state: "missing_credentials" };
  }

  const prompt = buildNaturalLanguageComputePrompt(params.userText);
  const failures: string[] = [];
  for (const provider of attemptOrder) {
    try {
      const response = await generateProviderResponse(provider, env, prompt);
      const plan = parseNaturalLanguageComputePlan(response.replyText);
      return {
        ok: true,
        plan: plan && isNaturalLanguageComputePlanGrounded(plan, params.userText) ? plan : null,
        source: "model",
        provider,
        model: resolveProviderModel(provider, env),
      };
    } catch (error) {
      failures.push(`${provider}: ${error instanceof Error ? error.message : "Compute planning failed."}`);
    }
  }

  return deterministic
    ? { ok: true, plan: deterministic, source: "deterministic" }
    : { ok: false, reason: failures.join(" | "), state: "ready" };
}

export async function generateRepresentativeReply(
  params: RepresentativeReplyInput,
): Promise<RepresentativeReplyResult> {
  if (!params.subagent.allowedConversationSteps.includes(params.plan.nextStep)) {
    return {
      ok: false,
      reason: `Subagent ${params.subagent.id} cannot handle conversation step ${params.plan.nextStep}.`,
      state: "invalid_subagent_route",
    };
  }

  const env = resolveModelRuntimeEnv();
  const maxInputTokens = Math.min(
    env.maxInputTokens,
    params.subagent.budgetHints.maxInputTokens,
  );
  const assembled = assembleRepresentativeReplyPrompt(params, {
    maxInputTokens,
  });
  if (env.state !== "ready") {
    return {
      ok: false,
      reason: `Model runtime unavailable: ${env.state}.`,
      state: env.state,
      contextTrace: assembled.trace,
      provider: env.provider,
      ...(env.provider === "openai"
        ? { model: env.openai.model }
        : env.provider === "bailian"
          ? { model: env.bailian.model }
          : env.provider === "anthropic"
            ? { model: env.anthropic.model }
            : {}),
    };
  }

  const attemptOrder = resolveProviderAttemptOrder(env);
  if (!attemptOrder.length) {
    return {
      ok: false,
      reason: "Model runtime has no credentialed providers available.",
      state: "missing_credentials",
      contextTrace: assembled.trace,
      provider: env.provider,
    };
  }

  const failures: string[] = [];
  for (const provider of attemptOrder) {
    try {
      const response = await generateProviderResponse(provider, env, assembled.prompt);

      return {
        ok: true,
        replyText: response.replyText,
        provider,
        model: resolveProviderModel(provider, env),
        contextTrace: assembled.trace,
        ...(response.usage ? { usage: response.usage } : {}),
      };
    } catch (error) {
      failures.push(
        `${provider}: ${error instanceof Error ? error.message : "Model generation failed."}`,
      );
    }
  }

  return {
    ok: false,
    reason: failures.join(" | "),
    state: "ready",
    contextTrace: assembled.trace,
    provider: env.provider,
    ...(env.provider === "openai"
      ? { model: env.openai.model }
      : env.provider === "bailian"
        ? { model: env.bailian.model }
        : env.provider === "anthropic"
          ? { model: env.anthropic.model }
          : {}),
  };
}

async function generateProviderResponse(
  provider: ModelProvider,
  env: ReturnType<typeof resolveModelRuntimeEnv>,
  prompt: ReturnType<typeof assembleRepresentativeReplyPrompt>["prompt"],
) {
  if (provider === "openai") {
    return generateOpenAIResponse({ env, prompt });
  }

  if (provider === "bailian") {
    return generateBailianResponse({ env, prompt });
  }

  return generateAnthropicResponse({ env, prompt });
}

function resolveProviderModel(
  provider: ModelProvider,
  env: ReturnType<typeof resolveModelRuntimeEnv>,
): string {
  if (provider === "openai") {
    return env.openai.model;
  }

  return provider === "bailian" ? env.bailian.model : env.anthropic.model;
}

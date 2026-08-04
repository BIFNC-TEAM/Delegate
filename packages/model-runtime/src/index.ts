import { generateAnthropicResponse } from "./anthropic";
import { generateBailianResponse } from "./bailian";
import {
  parseMemoryCitationsFromReply,
  prepareMemoryCitationPrompt,
} from "./citations";
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
export * from "./citations";
export * from "./pricing";
export * from "./types";

export async function planNaturalLanguageComputeRequest(params: {
  userText: string;
  maxSteps?: number;
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

  const prompt = buildNaturalLanguageComputePrompt(params.userText, params.maxSteps);
  const failures: string[] = [];
  for (const provider of attemptOrder) {
    try {
      const response = await generateProviderResponse(provider, env, prompt);
      const plan = parseNaturalLanguageComputePlan(response.replyText);
      const preferredPlan = plan?.kind === "clarification" && deterministic?.kind === "execution"
        ? deterministic
        : plan;
      const groundedPlan = preferredPlan && isNaturalLanguageComputePlanGrounded(preferredPlan, params.userText)
        ? preferredPlan
        : null;
      if (!groundedPlan && deterministic) {
        return { ok: true, plan: deterministic, source: "deterministic" };
      }
      return {
        ok: true,
        plan: groundedPlan,
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
      citedMemoryUseItemIds: [],
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
      citedMemoryUseItemIds: [],
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
      citedMemoryUseItemIds: [],
      contextTrace: assembled.trace,
      provider: env.provider,
    };
  }

  const failures: string[] = [];
  for (const provider of attemptOrder) {
    try {
      const preparedCitationPrompt = prepareMemoryCitationPrompt({
        prompt: assembled.prompt,
        selectedMemoryUseItemIds: assembled.trace.selectedMemoryUseItemIds,
      });
      const response = await generateProviderResponse(
        provider,
        env,
        preparedCitationPrompt.prompt,
      );
      const parsedReply = parseMemoryCitationsFromReply({
        replyText: response.replyText,
        protocol: preparedCitationPrompt.protocol,
      });
      if (!parsedReply.replyText) {
        failures.push(`${provider}: Model generation returned only citation control data.`);
        continue;
      }
      const policyViolation = detectRepresentativeReplyPolicyViolation(
        parsedReply.replyText,
        params.plan,
      );
      if (policyViolation) {
        failures.push(`${provider}: ${policyViolation}`);
        continue;
      }

      return {
        ok: true,
        replyText: parsedReply.replyText,
        citedMemoryUseItemIds: parsedReply.citedMemoryUseItemIds,
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
    citedMemoryUseItemIds: [],
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

export function detectRepresentativeReplyPolicyViolation(
  replyText: string,
  plan: RepresentativeReplyInput["plan"],
) {
  if (plan.nextStep !== "answer") return null;
  if (
    /(?:任务|请求).{0,24}(?:已提交|已经提交|自动提交)|(?:已|正在)?等待.{0,12}审批|approval.{0,20}(?:submitted|pending)/i.test(replyText)
  ) {
    return "Answer-lane reply invented a task or approval state.";
  }
  if (
    !plan.suggestedPlan &&
    /\b(?:Pass|Deep Help|Sponsor)\b|\d+\s*Stars|(?:付费|解锁).{0,16}(?:计划|套餐|能力|功能)|升级.{0,12}(?:计划|套餐)/i.test(replyText)
  ) {
    return "Answer-lane reply invented or exposed an unauthorized paid offer.";
  }
  return null;
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

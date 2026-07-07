import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  nativeComputerUsePreflightResponseSchema,
  type BrowserTransportKind,
  type NativeComputerProvider,
  type NativeComputerProviderSnapshot,
  type NativeComputerUsePreflightSnapshot,
} from "@delegate/compute-protocol";

import type { NativeBrowserAction, PlaywrightBrowseArtifactPayload } from "./browser";
import { computeBrokerConfig } from "./config";
import { prisma } from "./prisma";

type NativeComputerTransportKind = Extract<
  BrowserTransportKind,
  "openai_computer" | "claude_computer_use" | "opencode_computer_use"
>;
type NativeComputerActionTransportKind = Extract<
  BrowserTransportKind,
  "openai_computer" | "claude_computer_use"
>;

type BrowserSessionPreflightRecord = {
  id: string;
  computeSessionId: string;
  transportKind: string;
  currentUrl: string | null;
  currentTitle: string | null;
  lastNavigationAt: Date | null;
  latestNavigation:
    | {
        id: string;
        requestedUrl: string;
        finalUrl: string | null;
        textSnippet: string | null;
        screenshotArtifactId: string | null;
        jsonArtifactId: string | null;
      }
    | null
    | undefined;
};

export type NativeComputerPendingSafetyCheck = {
  id: string;
  code?: string | null;
  message?: string | null;
};

export type NativeComputerLoopTrace = {
  provider: NativeComputerProvider;
  model: string;
  allowMutations: boolean;
  maxSteps: number;
  task: string;
  startedAt: string;
  completedAt?: string;
  status: "completed" | "failed";
  finalText?: string | null;
  failureReason?: string;
  usage?: NativeComputerUsageSummary;
  steps: Array<{
    index: number;
    providerResponseId?: string;
    providerMessageId?: string;
    callId?: string;
    toolUseId?: string;
    pendingSafetyChecks?: NativeComputerPendingSafetyCheck[];
    actions: Array<{
      type: NativeBrowserAction["type"];
      summary: string;
    }>;
    resultingUrl?: string;
    pageTitle?: string;
    textSnippet?: string;
  }>;
};

export type NativeComputerUsageSummary = {
  provider: NativeComputerProvider;
  model: string;
  responseIds: string[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  providerCostCents: number;
};

export type NativeComputerLoopResult = {
  provider: NativeComputerProvider;
  model: string;
  transportKind: NativeComputerTransportKind;
  finalText: string | null;
  trace: NativeComputerLoopTrace;
  capture: PlaywrightBrowseArtifactPayload | null;
  usage: NativeComputerUsageSummary;
  wallMs: number;
};

export async function getNativeComputerUsePreflight(
  sessionId?: string | null,
): Promise<{ preflight: NativeComputerUsePreflightSnapshot }> {
  const providerReadiness = getNativeComputerProviderReadiness();
  if (!sessionId) {
    return nativeComputerUsePreflightResponseSchema.parse({
      preflight: deriveNativeComputerUsePreflight({
        sessionId: null,
        browserSession: null,
        providerReadiness,
      }),
    });
  }

  const browserSession = await prisma.browserSession.findUnique({
    where: {
      computeSessionId: sessionId,
    },
    include: {
      navigations: {
        orderBy: [{ createdAt: "desc" }],
        take: 1,
      },
    },
  });

  return nativeComputerUsePreflightResponseSchema.parse({
    preflight: deriveNativeComputerUsePreflight({
      sessionId,
      browserSession: browserSession
        ? {
            id: browserSession.id,
            computeSessionId: browserSession.computeSessionId,
            transportKind: browserSession.transportKind.toLowerCase(),
            currentUrl: browserSession.currentUrl,
            currentTitle: browserSession.currentTitle,
            lastNavigationAt: browserSession.lastNavigationAt,
            latestNavigation: browserSession.navigations[0]
              ? {
                  id: browserSession.navigations[0].id,
                  requestedUrl: browserSession.navigations[0].requestedUrl,
                  finalUrl: browserSession.navigations[0].finalUrl,
                  textSnippet: browserSession.navigations[0].textSnippet,
                  screenshotArtifactId: browserSession.navigations[0].screenshotArtifactId,
                  jsonArtifactId: browserSession.navigations[0].jsonArtifactId,
                }
              : null,
          }
        : null,
      providerReadiness,
    }),
  });
}

export function deriveNativeComputerUsePreflight(params: {
  sessionId?: string | null;
  browserSession?: BrowserSessionPreflightRecord | null;
  providerReadiness: NativeComputerProviderSnapshot[];
}): NativeComputerUsePreflightSnapshot {
  const browserSession = params.browserSession ?? null;
  const readyProviders = params.providerReadiness.filter((provider) => provider.status === "ready");
  const preferredProvider = readyProviders[0]?.provider ?? null;
  const targetTransportKind = preferredProvider
    ? mapProviderToTransportKind(preferredProvider)
    : null;

  if (!browserSession) {
    return {
      state: "no_browser_session",
      sessionId: params.sessionId ?? null,
      browserSessionId: null,
      preferredProvider,
      targetTransportKind,
      requiresApprovalForMutations: true,
      supportsSessionReuse: true,
      providerReadiness: params.providerReadiness,
      nextStep:
        "Run a governed browser step first so Delegate has a retained screenshot and page state for native computer-use handoff.",
    };
  }

  const latestNavigation = browserSession.latestNavigation ?? null;
  if (!latestNavigation?.screenshotArtifactId) {
    return {
      state: "missing_screenshot",
      sessionId: browserSession.computeSessionId,
      browserSessionId: browserSession.id,
      browserTransportKind: normalizeBrowserTransportKind(browserSession.transportKind),
      preferredProvider,
      targetTransportKind,
      ...(browserSession.currentUrl ? { currentUrl: browserSession.currentUrl } : {}),
      ...(browserSession.currentTitle ? { currentTitle: browserSession.currentTitle } : {}),
      ...(latestNavigation?.id ? { latestNavigationId: latestNavigation.id } : {}),
      ...(browserSession.lastNavigationAt
        ? { latestNavigationAt: browserSession.lastNavigationAt.toISOString() }
        : {}),
      ...(latestNavigation?.requestedUrl ? { latestRequestedUrl: latestNavigation.requestedUrl } : {}),
      ...(latestNavigation?.finalUrl ? { latestFinalUrl: latestNavigation.finalUrl } : {}),
      ...(latestNavigation?.textSnippet ? { latestTextSnippet: latestNavigation.textSnippet } : {}),
      ...(latestNavigation?.jsonArtifactId ? { latestJsonArtifactId: latestNavigation.jsonArtifactId } : {}),
      requiresApprovalForMutations: true,
      supportsSessionReuse: true,
      providerReadiness: params.providerReadiness,
      nextStep:
        "Capture a fresh governed screenshot artifact in this browser session before handing off to a native computer-use provider.",
    };
  }

  if (!readyProviders.length) {
    return {
      state: "no_ready_providers",
      sessionId: browserSession.computeSessionId,
      browserSessionId: browserSession.id,
      browserTransportKind: normalizeBrowserTransportKind(browserSession.transportKind),
      preferredProvider: null,
      targetTransportKind: null,
      ...(browserSession.currentUrl ? { currentUrl: browserSession.currentUrl } : {}),
      ...(browserSession.currentTitle ? { currentTitle: browserSession.currentTitle } : {}),
      ...(latestNavigation.id ? { latestNavigationId: latestNavigation.id } : {}),
      ...(browserSession.lastNavigationAt
        ? { latestNavigationAt: browserSession.lastNavigationAt.toISOString() }
        : {}),
      latestRequestedUrl: latestNavigation.requestedUrl,
      ...(latestNavigation.finalUrl ? { latestFinalUrl: latestNavigation.finalUrl } : {}),
      ...(latestNavigation.textSnippet ? { latestTextSnippet: latestNavigation.textSnippet } : {}),
      latestScreenshotArtifactId: latestNavigation.screenshotArtifactId,
      ...(latestNavigation.jsonArtifactId ? { latestJsonArtifactId: latestNavigation.jsonArtifactId } : {}),
      requiresApprovalForMutations: true,
      supportsSessionReuse: true,
      providerReadiness: params.providerReadiness,
      nextStep:
        "Configure at least one native computer-use provider model and credentials before enabling the next browser lane.",
    };
  }

  return {
    state: "ready",
    sessionId: browserSession.computeSessionId,
    browserSessionId: browserSession.id,
    browserTransportKind: normalizeBrowserTransportKind(browserSession.transportKind),
    preferredProvider,
    targetTransportKind,
    ...(browserSession.currentUrl ? { currentUrl: browserSession.currentUrl } : {}),
    ...(browserSession.currentTitle ? { currentTitle: browserSession.currentTitle } : {}),
    latestNavigationId: latestNavigation.id,
    ...(browserSession.lastNavigationAt
      ? { latestNavigationAt: browserSession.lastNavigationAt.toISOString() }
      : {}),
    latestRequestedUrl: latestNavigation.requestedUrl,
    ...(latestNavigation.finalUrl ? { latestFinalUrl: latestNavigation.finalUrl } : {}),
    ...(latestNavigation.textSnippet ? { latestTextSnippet: latestNavigation.textSnippet } : {}),
    latestScreenshotArtifactId: latestNavigation.screenshotArtifactId,
    ...(latestNavigation.jsonArtifactId ? { latestJsonArtifactId: latestNavigation.jsonArtifactId } : {}),
    requiresApprovalForMutations: true,
    supportsSessionReuse: true,
    providerReadiness: params.providerReadiness,
    nextStep:
      "This browser session now has the retained screenshot, page summary, and provider readiness needed for a future native computer-use loop.",
  };
}

export async function executeNativeComputerUseLoop(params: {
  provider?: NativeComputerProvider;
  task: string;
  maxSteps: number;
  allowMutations: boolean;
  currentUrl?: string | null | undefined;
  currentTitle?: string | null | undefined;
  textSnippet?: string | null | undefined;
  screenshotBase64: string;
  screenshotMimeType: "image/png" | "image/jpeg";
  executeActionBatch: (params: {
    transportKind: NativeComputerActionTransportKind;
    actions: NativeBrowserAction[];
    currentUrl?: string | null | undefined;
  }) => Promise<PlaywrightBrowseArtifactPayload>;
  executeOpenCodeComputerUse?: (params: {
    providerConfig: ReadyNativeProviderConfig;
    task: string;
    maxSteps: number;
    allowMutations: boolean;
    currentUrl?: string | null | undefined;
    currentTitle?: string | null | undefined;
    textSnippet?: string | null | undefined;
    screenshotBase64: string;
    screenshotMimeType: "image/png" | "image/jpeg";
  }) => Promise<{
    capture: PlaywrightBrowseArtifactPayload;
    stdout: string;
    stderr: string;
  }>;
}): Promise<NativeComputerLoopResult> {
  const providerReadiness = getNativeComputerProviderReadiness();
  const provider = resolveRequestedProvider(params.provider, providerReadiness);
  const providerConfig = resolveReadyProviderConfig(provider, providerReadiness);
  const startedAt = new Date();

  if (provider === "openai") {
    return runOpenAiNativeLoop({
      ...params,
      providerConfig,
      startedAt,
    });
  }

  if (provider === "opencode") {
    return runOpenCodeNativeLoop({
      ...params,
      providerConfig,
      startedAt,
    });
  }

  return runAnthropicNativeLoop({
    ...params,
    providerConfig,
    startedAt,
  });
}

export function getNativeComputerProviderReadiness(
  env: NodeJS.ProcessEnv = process.env,
): NativeComputerProviderSnapshot[] {
  return [
    buildProviderReadiness({
      provider: "openai",
      enabled: parseBoolean(
        env.COMPUTE_NATIVE_OPENAI_ENABLED,
        computeBrokerConfig.nativeComputerUse.openai.enabled,
      ),
      ...(() => {
        const model =
          normalizeOptionalString(env.COMPUTE_NATIVE_OPENAI_MODEL) ??
          computeBrokerConfig.nativeComputerUse.openai.model;
        return model ? { model } : {};
      })(),
      hasCredentials: Boolean(normalizeOptionalString(env.OPENAI_API_KEY)),
    }),
    buildProviderReadiness({
      provider: "anthropic",
      enabled: parseBoolean(
        env.COMPUTE_NATIVE_ANTHROPIC_ENABLED,
        computeBrokerConfig.nativeComputerUse.anthropic.enabled,
      ),
      ...(() => {
        const model =
          normalizeOptionalString(env.COMPUTE_NATIVE_ANTHROPIC_MODEL) ??
          computeBrokerConfig.nativeComputerUse.anthropic.model;
        return model ? { model } : {};
      })(),
      hasCredentials: Boolean(normalizeOptionalString(env.ANTHROPIC_API_KEY)),
    }),
    buildOpenCodeProviderReadiness({
      enabled: parseBoolean(
        env.COMPUTE_NATIVE_OPENCODE_ENABLED,
        computeBrokerConfig.nativeComputerUse.opencode.enabled,
      ),
      command:
        normalizeOptionalString(env.COMPUTE_NATIVE_OPENCODE_COMMAND) ??
        computeBrokerConfig.nativeComputerUse.opencode.command,
      model:
        normalizeOptionalString(env.COMPUTE_NATIVE_OPENCODE_MODEL) ??
        computeBrokerConfig.nativeComputerUse.opencode.model ??
        "opencode/default",
      sandboxProvider:
        normalizeOptionalString(env.SANDBOX_PROVIDER) ?? computeBrokerConfig.sandboxProvider,
      hasDaytonaCredentials: Boolean(
        normalizeOptionalString(env.DAYTONA_API_KEY) ?? computeBrokerConfig.daytona.apiKey,
      ),
    }),
  ];
}

export function hasMutatingNativeActions(actions: NativeBrowserAction[]): boolean {
  return actions.some((action) =>
    action.type === "click" ||
    action.type === "double_click" ||
    action.type === "drag" ||
    action.type === "keypress" ||
    action.type === "type",
  );
}

export function summarizeNativeActions(actions: NativeBrowserAction[]) {
  return actions.map((action) => ({
    type: action.type,
    summary: summarizeNativeAction(action),
  }));
}

async function runOpenAiNativeLoop(params: {
  providerConfig: ReadyNativeProviderConfig;
  task: string;
  maxSteps: number;
  allowMutations: boolean;
  currentUrl?: string | null | undefined;
  currentTitle?: string | null | undefined;
  textSnippet?: string | null | undefined;
  screenshotBase64: string;
  screenshotMimeType: "image/png" | "image/jpeg";
  executeActionBatch: (params: {
    transportKind: "openai_computer";
    actions: NativeBrowserAction[];
    currentUrl?: string | null | undefined;
  }) => Promise<PlaywrightBrowseArtifactPayload>;
  startedAt: Date;
}): Promise<NativeComputerLoopResult> {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    ...(computeBrokerConfig.nativeComputerUse.openai.baseUrl
      ? { baseURL: computeBrokerConfig.nativeComputerUse.openai.baseUrl }
      : {}),
    timeout: computeBrokerConfig.mcpTimeoutMs,
  });
  const usage = createUsageAccumulator("openai", params.providerConfig.model);
  const trace: NativeComputerLoopTrace = {
    provider: "openai",
    model: params.providerConfig.model,
    allowMutations: params.allowMutations,
    maxSteps: params.maxSteps,
    task: params.task,
    startedAt: params.startedAt.toISOString(),
    status: "failed",
    steps: [],
  };

  let capture: PlaywrightBrowseArtifactPayload | null = null;
  let finalText: string | null = null;
  let previousResponseId: string | undefined;
  let currentUrl = params.currentUrl ?? null;
  let currentTitle = params.currentTitle ?? null;
  let currentTextSnippet = params.textSnippet ?? null;
  let currentScreenshotBase64 = params.screenshotBase64;
  let currentScreenshotMimeType = params.screenshotMimeType;
  let lastCallId: string | null = null;
  let lastSafetyChecks: NativeComputerPendingSafetyCheck[] = [];

  for (let index = 0; index < params.maxSteps; index += 1) {
    const response = await client.responses.create(
      previousResponseId
        ? ({
            model: params.providerConfig.model,
            previous_response_id: previousResponseId,
            max_output_tokens: computeBrokerConfig.nativeComputerUse.maxOutputTokens,
            tools: [buildOpenAiComputerTool()],
            input: [
              {
                type: "computer_call_output",
                call_id: lastCallId,
                output: {
                  type: "computer_screenshot",
                  image_url: toDataUrl(currentScreenshotMimeType, currentScreenshotBase64),
                },
                ...(lastSafetyChecks.length
                  ? {
                      acknowledged_safety_checks: lastSafetyChecks.map((check) => ({ id: check.id })),
                    }
                  : {}),
              },
            ],
          } as never)
        : ({
            model: params.providerConfig.model,
            max_output_tokens: computeBrokerConfig.nativeComputerUse.maxOutputTokens,
            tools: [buildOpenAiComputerTool()],
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: buildNativeTaskPrompt({
                      task: params.task,
                      currentUrl,
                      currentTitle,
                      textSnippet: currentTextSnippet,
                      allowMutations: params.allowMutations,
                    }),
                  },
                  {
                    type: "input_image",
                    image_url: toDataUrl(currentScreenshotMimeType, currentScreenshotBase64),
                  },
                ],
              },
            ],
          } as never),
    );

    accumulateOpenAiUsage(usage, response, params.providerConfig.costCentsPerStep);

    const computerCalls = extractOpenAiComputerCalls(response);
    const text = extractOpenAiResponseText(response);

    if (!computerCalls.length) {
      finalText = text || "Native browser loop completed without further computer actions.";
      break;
    }

    const currentCall = computerCalls[0]!;
    const actions = currentCall.actions;
    if (hasMutatingNativeActions(actions) && !params.allowMutations) {
      throw new Error("native_browser_mutation_requires_approval");
    }

    capture = await params.executeActionBatch({
      transportKind: "openai_computer",
      actions,
      currentUrl,
    });
    currentUrl = capture.finalUrl;
    currentTitle = capture.title;
    currentTextSnippet = capture.textSnippet;
    currentScreenshotBase64 = capture.screenshotBase64;
    currentScreenshotMimeType = capture.screenshotMimeType;
    previousResponseId = response.id;
    lastCallId = currentCall.callId;
    lastSafetyChecks = currentCall.pendingSafetyChecks;

    trace.steps.push({
      index: index + 1,
      providerResponseId: response.id,
      callId: currentCall.callId,
      pendingSafetyChecks: currentCall.pendingSafetyChecks,
      actions: summarizeNativeActions(actions),
      resultingUrl: capture.finalUrl,
      pageTitle: capture.title,
      textSnippet: capture.textSnippet,
    });
  }

  trace.status = "completed";
  trace.completedAt = new Date().toISOString();
  trace.finalText = finalText;
  trace.usage = finalizeUsage(usage);

  return {
    provider: "openai",
    model: params.providerConfig.model,
    transportKind: "openai_computer",
    finalText,
    trace,
    capture,
    usage: finalizeUsage(usage),
    wallMs: Math.max(1, Date.now() - params.startedAt.getTime()),
  };
}

async function runAnthropicNativeLoop(params: {
  providerConfig: ReadyNativeProviderConfig;
  task: string;
  maxSteps: number;
  allowMutations: boolean;
  currentUrl?: string | null | undefined;
  currentTitle?: string | null | undefined;
  textSnippet?: string | null | undefined;
  screenshotBase64: string;
  screenshotMimeType: "image/png" | "image/jpeg";
  executeActionBatch: (params: {
    transportKind: "claude_computer_use";
    actions: NativeBrowserAction[];
    currentUrl?: string | null | undefined;
  }) => Promise<PlaywrightBrowseArtifactPayload>;
  startedAt: Date;
}): Promise<NativeComputerLoopResult> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    ...(computeBrokerConfig.nativeComputerUse.anthropic.baseUrl
      ? { baseURL: computeBrokerConfig.nativeComputerUse.anthropic.baseUrl }
      : {}),
    timeout: computeBrokerConfig.mcpTimeoutMs,
  });
  const usage = createUsageAccumulator("anthropic", params.providerConfig.model);
  const trace: NativeComputerLoopTrace = {
    provider: "anthropic",
    model: params.providerConfig.model,
    allowMutations: params.allowMutations,
    maxSteps: params.maxSteps,
    task: params.task,
    startedAt: params.startedAt.toISOString(),
    status: "failed",
    steps: [],
  };

  let capture: PlaywrightBrowseArtifactPayload | null = null;
  let finalText: string | null = null;
  let currentUrl = params.currentUrl ?? null;
  let currentTitle = params.currentTitle ?? null;
  let currentTextSnippet = params.textSnippet ?? null;
  let currentScreenshotBase64 = params.screenshotBase64;
  let currentScreenshotMimeType = params.screenshotMimeType;

  const messages: Array<Record<string, unknown>> = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: buildNativeTaskPrompt({
            task: params.task,
            currentUrl,
            currentTitle,
            textSnippet: currentTextSnippet,
            allowMutations: params.allowMutations,
          }),
        },
        buildAnthropicImageBlock(currentScreenshotBase64, currentScreenshotMimeType),
      ],
    },
  ];

  for (let index = 0; index < params.maxSteps; index += 1) {
    const response = await client.beta.messages.create({
      betas: ["computer-use-2025-01-24"],
      model: params.providerConfig.model,
      max_tokens: computeBrokerConfig.nativeComputerUse.maxOutputTokens,
      messages: messages as never,
      tools: [
        {
          name: "computer",
          type: "computer_20250124",
          display_width_px: 1440,
          display_height_px: 960,
        },
      ],
    } as never);

    accumulateAnthropicUsage(usage, response, params.providerConfig.costCentsPerStep);

    const text = extractAnthropicResponseText(response);
    const toolUse = Array.isArray(response.content)
      ? ((response.content as any[]).find(
          (block) => block?.type === "tool_use" && block?.name === "computer",
        ) as any | null)
      : null;

    if (!toolUse) {
      finalText = text || "Native browser loop completed without further computer actions.";
      break;
    }

    const actions = normalizeAnthropicToolUseInput(toolUse.input);
    if (!actions.length) {
      throw new Error("anthropic_native_browser_actions_missing");
    }

    if (hasMutatingNativeActions(actions) && !params.allowMutations) {
      throw new Error("native_browser_mutation_requires_approval");
    }

    capture = await params.executeActionBatch({
      transportKind: "claude_computer_use",
      actions,
      currentUrl,
    });
    currentUrl = capture.finalUrl;
    currentTitle = capture.title;
    currentTextSnippet = capture.textSnippet;
    currentScreenshotBase64 = capture.screenshotBase64;
    currentScreenshotMimeType = capture.screenshotMimeType;

    trace.steps.push({
      index: index + 1,
      providerMessageId: response.id,
      toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
      actions: summarizeNativeActions(actions),
      resultingUrl: capture.finalUrl,
      pageTitle: capture.title,
      textSnippet: capture.textSnippet,
    });

    messages.push({
      role: "assistant",
      content: response.content,
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: [
            buildAnthropicImageBlock(currentScreenshotBase64, currentScreenshotMimeType),
            {
              type: "text",
              text: buildAnthropicToolResultText({
                currentUrl,
                currentTitle,
                textSnippet: currentTextSnippet,
              }),
            },
          ],
        },
      ],
    });
  }

  trace.status = "completed";
  trace.completedAt = new Date().toISOString();
  trace.finalText = finalText;
  trace.usage = finalizeUsage(usage);

  return {
    provider: "anthropic",
    model: params.providerConfig.model,
    transportKind: "claude_computer_use",
    finalText,
    trace,
    capture,
    usage: finalizeUsage(usage),
    wallMs: Math.max(1, Date.now() - params.startedAt.getTime()),
  };
}

async function runOpenCodeNativeLoop(params: {
  providerConfig: ReadyNativeProviderConfig;
  task: string;
  maxSteps: number;
  allowMutations: boolean;
  currentUrl?: string | null | undefined;
  currentTitle?: string | null | undefined;
  textSnippet?: string | null | undefined;
  screenshotBase64: string;
  screenshotMimeType: "image/png" | "image/jpeg";
  executeOpenCodeComputerUse?: (params: {
    providerConfig: ReadyNativeProviderConfig;
    task: string;
    maxSteps: number;
    allowMutations: boolean;
    currentUrl?: string | null | undefined;
    currentTitle?: string | null | undefined;
    textSnippet?: string | null | undefined;
    screenshotBase64: string;
    screenshotMimeType: "image/png" | "image/jpeg";
  }) => Promise<{
    capture: PlaywrightBrowseArtifactPayload;
    stdout: string;
    stderr: string;
  }>;
  startedAt: Date;
}): Promise<NativeComputerLoopResult> {
  if (!params.executeOpenCodeComputerUse) {
    throw new Error("opencode_sandbox_executor_missing");
  }

  const usage = createUsageAccumulator("opencode", params.providerConfig.model);
  const trace: NativeComputerLoopTrace = {
    provider: "opencode",
    model: params.providerConfig.model,
    allowMutations: params.allowMutations,
    maxSteps: params.maxSteps,
    task: params.task,
    startedAt: params.startedAt.toISOString(),
    status: "failed",
    steps: [],
  };

  const result = await params.executeOpenCodeComputerUse({
    providerConfig: params.providerConfig,
    task: params.task,
    maxSteps: params.maxSteps,
    allowMutations: params.allowMutations,
    currentUrl: params.currentUrl,
    currentTitle: params.currentTitle,
    textSnippet: params.textSnippet,
    screenshotBase64: params.screenshotBase64,
    screenshotMimeType: params.screenshotMimeType,
  });

  usage.providerCostCents += params.providerConfig.costCentsPerStep;
  const finalText = "OpenCode completed the browser task inside the Daytona sandbox.";
  trace.status = "completed";
  trace.completedAt = new Date().toISOString();
  trace.finalText = finalText;
  trace.usage = finalizeUsage(usage);
  trace.steps.push({
    index: 1,
    providerResponseId: "opencode-cli",
    actions: result.capture.executedActions?.length
      ? result.capture.executedActions
      : [
          {
            type: "screenshot",
            summary: "Captured the browser state after the OpenCode sandbox run.",
          },
        ],
    resultingUrl: result.capture.finalUrl,
    pageTitle: result.capture.title,
    textSnippet: result.capture.textSnippet,
  });

  return {
    provider: "opencode",
    model: params.providerConfig.model,
    transportKind: "opencode_computer_use",
    finalText,
    trace,
    capture: result.capture,
    usage: finalizeUsage(usage),
    wallMs: Date.now() - params.startedAt.getTime(),
  };
}

type ReadyNativeProviderConfig = {
  provider: NativeComputerProvider;
  model: string;
  transportKind: NativeComputerTransportKind;
  costCentsPerStep: number;
  command?: string;
};

type NativeUsageAccumulator = {
  provider: NativeComputerProvider;
  model: string;
  responseIds: string[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  providerCostCents: number;
};

function resolveRequestedProvider(
  requestedProvider: NativeComputerProvider | undefined,
  readiness: NativeComputerProviderSnapshot[],
): NativeComputerProvider {
  if (requestedProvider) {
    return requestedProvider;
  }

  const readyProvider = readiness.find((provider) => provider.status === "ready");
  if (!readyProvider) {
    throw new Error("native_provider_not_ready");
  }

  return readyProvider.provider;
}

function resolveReadyProviderConfig(
  provider: NativeComputerProvider,
  readiness: NativeComputerProviderSnapshot[],
): ReadyNativeProviderConfig {
  const ready = readiness.find((entry) => entry.provider === provider);
  if (!ready || ready.status !== "ready" || !ready.model) {
    throw new Error("native_provider_not_ready");
  }

  return {
    provider,
    model: ready.model,
    transportKind: mapProviderToTransportKind(provider),
    costCentsPerStep:
      provider === "openai"
        ? computeBrokerConfig.nativeComputerUse.openai.costCentsPerStep
        : provider === "anthropic"
          ? computeBrokerConfig.nativeComputerUse.anthropic.costCentsPerStep
          : computeBrokerConfig.nativeComputerUse.opencode.costCentsPerStep,
    ...(provider === "opencode"
      ? { command: computeBrokerConfig.nativeComputerUse.opencode.command }
      : {}),
  };
}

function createUsageAccumulator(
  provider: NativeComputerProvider,
  model: string,
): NativeUsageAccumulator {
  return {
    provider,
    model,
    responseIds: [],
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    providerCostCents: 0,
  };
}

function finalizeUsage(value: NativeUsageAccumulator): NativeComputerUsageSummary {
  return {
    provider: value.provider,
    model: value.model,
    responseIds: value.responseIds,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    providerCostCents: value.providerCostCents,
  };
}

function accumulateOpenAiUsage(
  accumulator: NativeUsageAccumulator,
  response: any,
  costCentsPerStep: number,
) {
  if (typeof response?.id === "string") {
    accumulator.responseIds.push(response.id);
  }

  if (typeof response?.usage?.input_tokens === "number") {
    accumulator.inputTokens += response.usage.input_tokens;
  }
  if (typeof response?.usage?.output_tokens === "number") {
    accumulator.outputTokens += response.usage.output_tokens;
  }
  if (typeof response?.usage?.total_tokens === "number") {
    accumulator.totalTokens += response.usage.total_tokens;
  } else {
    accumulator.totalTokens +=
      (typeof response?.usage?.input_tokens === "number" ? response.usage.input_tokens : 0) +
      (typeof response?.usage?.output_tokens === "number" ? response.usage.output_tokens : 0);
  }
  accumulator.providerCostCents += costCentsPerStep;
}

function accumulateAnthropicUsage(
  accumulator: NativeUsageAccumulator,
  response: any,
  costCentsPerStep: number,
) {
  if (typeof response?.id === "string") {
    accumulator.responseIds.push(response.id);
  }

  if (typeof response?.usage?.input_tokens === "number") {
    accumulator.inputTokens += response.usage.input_tokens;
  }
  if (typeof response?.usage?.output_tokens === "number") {
    accumulator.outputTokens += response.usage.output_tokens;
  }
  accumulator.totalTokens +=
    (typeof response?.usage?.input_tokens === "number" ? response.usage.input_tokens : 0) +
    (typeof response?.usage?.output_tokens === "number" ? response.usage.output_tokens : 0);
  accumulator.providerCostCents += costCentsPerStep;
}

function buildOpenAiComputerTool() {
  return {
    type: "computer_use_preview",
    display_width: 1440,
    display_height: 960,
    environment: "browser",
  };
}

function extractOpenAiComputerCalls(response: any): Array<{
  callId: string;
  actions: NativeBrowserAction[];
  pendingSafetyChecks: NativeComputerPendingSafetyCheck[];
}> {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output
    .filter((item: any) => item?.type === "computer_call" && typeof item?.call_id === "string")
    .map((item: any) => ({
      callId: item.call_id,
      actions: normalizeOpenAiActions(item.actions ?? (item.action ? [item.action] : [])),
      pendingSafetyChecks: Array.isArray(item.pending_safety_checks)
        ? item.pending_safety_checks
            .filter((check: any) => typeof check?.id === "string")
            .map((check: any) => ({
              id: check.id,
              ...(typeof check.code === "string" ? { code: check.code } : {}),
              ...(typeof check.message === "string" ? { message: check.message } : {}),
            }))
        : [],
    }));
}

function extractOpenAiResponseText(response: any): string {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const chunks: string[] = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (part?.type === "output_text" && typeof part.text === "string" && part.text.trim()) {
        chunks.push(part.text.trim());
      }
    }
  }

  return chunks.join("\n\n").trim();
}

function extractAnthropicResponseText(response: any): string {
  const chunks: string[] = [];
  for (const block of Array.isArray(response?.content) ? response.content : []) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      chunks.push(block.text.trim());
    }
  }
  return chunks.join("\n\n").trim();
}

function normalizeOpenAiActions(input: unknown): NativeBrowserAction[] {
  const values = Array.isArray(input) ? input : [];
  return values
    .map((value) => normalizeOpenAiAction(value))
    .filter((value): value is NativeBrowserAction => Boolean(value));
}

function normalizeOpenAiAction(value: unknown): NativeBrowserAction | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const action = value as Record<string, unknown>;
  switch (action.type) {
    case "click": {
      const result: Extract<NativeBrowserAction, { type: "click" }> = {
        type: "click",
      };
      const button = normalizeMouseButton(action.button);
      if (button) {
        result.button = button;
      }
      if (typeof action.x === "number") {
        result.x = action.x;
      }
      if (typeof action.y === "number") {
        result.y = action.y;
      }
      return result;
    }
    case "double_click":
      return {
        type: "double_click",
        ...(typeof action.x === "number" ? { x: action.x } : {}),
        ...(typeof action.y === "number" ? { y: action.y } : {}),
      };
    case "drag":
      return {
        type: "drag",
        path: Array.isArray(action.path)
          ? action.path
              .map((point) => normalizeCoordinate(point))
              .filter((point): point is { x: number; y: number } => Boolean(point))
          : [],
      };
    case "keypress":
      return {
        type: "keypress",
        keys: Array.isArray(action.keys)
          ? action.keys.filter((key): key is string => typeof key === "string")
          : [],
      };
    case "move":
      if (typeof action.x !== "number" || typeof action.y !== "number") {
        return null;
      }
      return {
        type: "move",
        x: action.x,
        y: action.y,
      };
    case "screenshot":
      return { type: "screenshot" };
    case "scroll":
      return {
        type: "scroll",
        scroll_x: typeof action.scroll_x === "number" ? action.scroll_x : 0,
        scroll_y: typeof action.scroll_y === "number" ? action.scroll_y : 0,
        ...(typeof action.x === "number" ? { x: action.x } : {}),
        ...(typeof action.y === "number" ? { y: action.y } : {}),
      };
    case "type":
      if (typeof action.text !== "string") {
        return null;
      }
      return {
        type: "type",
        text: action.text,
      };
    case "wait":
      return { type: "wait" };
    default:
      return null;
  }
}

function normalizeAnthropicToolUseInput(input: unknown): NativeBrowserAction[] {
  if (!input || typeof input !== "object") {
    return [];
  }

  const payload = input as Record<string, unknown>;
  const action = typeof payload.action === "string" ? payload.action : "";
  const coordinate = normalizeCoordinate(payload.coordinate ?? payload.coordinates);

  switch (action) {
    case "screenshot":
      return [{ type: "screenshot" }];
    case "mouse_move":
      return coordinate ? [{ type: "move", ...coordinate }] : [];
    case "left_click":
      return [{ type: "click", button: "left", ...(coordinate ?? {}) }];
    case "right_click":
      return [{ type: "click", button: "right", ...(coordinate ?? {}) }];
    case "middle_click":
      return [{ type: "click", button: "middle", ...(coordinate ?? {}) }];
    case "double_click":
      return [{ type: "double_click", ...(coordinate ?? {}) }];
    case "left_click_drag": {
      const path = normalizeCoordinatePath(payload.path ?? payload.drag_path);
      if (path.length) {
        return [{ type: "drag", path }];
      }
      const start = normalizeCoordinate(payload.start_coordinate);
      const end = normalizeCoordinate(payload.end_coordinate);
      return start && end ? [{ type: "drag", path: [start, end] }] : [];
    }
    case "key":
    case "keypress":
      return [
        {
          type: "keypress",
          keys: normalizeAnthropicKeys(payload.text ?? payload.keys),
        },
      ];
    case "type":
      return typeof payload.text === "string"
        ? [
            {
              type: "type",
              text: payload.text,
            },
          ]
        : [];
    case "scroll": {
      const amount =
        typeof payload.scroll_amount === "number"
          ? payload.scroll_amount
          : typeof payload.delta_y === "number"
            ? Math.abs(payload.delta_y)
            : 480;
      const direction =
        typeof payload.scroll_direction === "string" ? payload.scroll_direction.toLowerCase() : "down";
      const signedAmount =
        direction === "up" || direction === "left" ? -Math.abs(amount) : Math.abs(amount);
      return [
        {
          type: "scroll",
          scroll_x:
            direction === "left" || direction === "right"
              ? signedAmount
              : typeof payload.delta_x === "number"
                ? payload.delta_x
                : 0,
          scroll_y:
            direction === "up" || direction === "down"
              ? signedAmount
              : typeof payload.delta_y === "number"
                ? payload.delta_y
                : 0,
          ...(coordinate ?? {}),
        },
      ];
    }
    case "wait":
      return [
        {
          type: "wait",
          ...(typeof payload.duration_ms === "number" ? { durationMs: payload.duration_ms } : {}),
        },
      ];
    default:
      return [];
  }
}

function normalizeCoordinate(value: unknown): { x: number; y: number } | null {
  if (Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    return { x: value[0], y: value[1] };
  }

  if (
    value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).x === "number" &&
    typeof (value as Record<string, unknown>).y === "number"
  ) {
    const record = value as Record<string, unknown>;
    return {
      x: record.x as number,
      y: record.y as number,
    };
  }

  return null;
}

function normalizeCoordinatePath(value: unknown): Array<{ x: number; y: number }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeCoordinate(entry))
    .filter((entry): entry is { x: number; y: number } => Boolean(entry));
}

function normalizeAnthropicKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value === "string") {
    return value
      .split("+")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

function buildAnthropicImageBlock(
  base64: string,
  mimeType: "image/png" | "image/jpeg",
) {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mimeType,
      data: base64,
    },
  };
}

function buildAnthropicToolResultText(params: {
  currentUrl?: string | null;
  currentTitle?: string | null;
  textSnippet?: string | null;
}) {
  return [
    params.currentTitle ? `Title: ${params.currentTitle}` : null,
    params.currentUrl ? `URL: ${params.currentUrl}` : null,
    params.textSnippet ? `Snippet: ${params.textSnippet}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildNativeTaskPrompt(params: {
  task: string;
  currentUrl?: string | null;
  currentTitle?: string | null;
  textSnippet?: string | null;
  allowMutations: boolean;
}) {
  return [
    "You are operating Delegate's governed native browser lane.",
    params.allowMutations
      ? "Mutating browser actions have already been explicitly approved for this run."
      : "Do not attempt mutating actions. Only inspect, scroll, wait, or request screenshots unless a safe final answer is possible.",
    "Prefer the smallest next action that moves the task forward.",
    params.currentTitle ? `Current page title: ${params.currentTitle}` : null,
    params.currentUrl ? `Current page URL: ${params.currentUrl}` : null,
    params.textSnippet ? `Latest visible text snippet: ${params.textSnippet}` : null,
    `Task: ${params.task}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildProviderReadiness(params: {
  provider: "openai" | "anthropic";
  enabled: boolean;
  model?: string;
  hasCredentials: boolean;
}): NativeComputerProviderSnapshot {
  if (!params.enabled) {
    return {
      provider: params.provider,
      enabled: false,
      status: "disabled",
      transportKind: mapProviderToTransportKind(params.provider),
      ...(params.model ? { model: params.model } : {}),
      reason: "provider_disabled",
    };
  }

  if (!params.model) {
    return {
      provider: params.provider,
      enabled: true,
      status: "missing_model",
      transportKind: mapProviderToTransportKind(params.provider),
      reason: "native_model_not_configured",
    };
  }

  if (!params.hasCredentials) {
    return {
      provider: params.provider,
      enabled: true,
      status: "missing_credentials",
      model: params.model,
      transportKind: mapProviderToTransportKind(params.provider),
      reason: "provider_credentials_missing",
    };
  }

  return {
    provider: params.provider,
    enabled: true,
    status: "ready",
    model: params.model,
    transportKind: mapProviderToTransportKind(params.provider),
    reason: null,
  };
}

function buildOpenCodeProviderReadiness(params: {
  enabled: boolean;
  command: string;
  model: string;
  sandboxProvider: string;
  hasDaytonaCredentials: boolean;
}): NativeComputerProviderSnapshot {
  if (!params.enabled) {
    return {
      provider: "opencode",
      enabled: false,
      status: "disabled",
      transportKind: "opencode_computer_use",
      model: params.model,
      reason: "provider_disabled",
    };
  }

  if (params.sandboxProvider !== "daytona" || !params.hasDaytonaCredentials) {
    return {
      provider: "opencode",
      enabled: true,
      status: "missing_sandbox",
      transportKind: "opencode_computer_use",
      model: params.model,
      reason: "daytona_sandbox_required",
    };
  }

  return {
    provider: "opencode",
    enabled: true,
    status: "ready",
    transportKind: "opencode_computer_use",
    model: params.model,
    reason: null,
  };
}

export function mapProviderToTransportKind(provider: NativeComputerProvider): NativeComputerTransportKind {
  if (provider === "openai") {
    return "openai_computer";
  }
  if (provider === "anthropic") {
    return "claude_computer_use";
  }
  return "opencode_computer_use";
}

export function normalizeBrowserTransportKind(value: string): BrowserTransportKind {
  if (value === "OPENAI_COMPUTER" || value === "openai_computer") {
    return "openai_computer";
  }
  if (value === "CLAUDE_COMPUTER_USE" || value === "claude_computer_use") {
    return "claude_computer_use";
  }
  if (value === "OPENCODE_COMPUTER_USE" || value === "opencode_computer_use") {
    return "opencode_computer_use";
  }
  return "playwright";
}

function summarizeNativeAction(action: NativeBrowserAction): string {
  switch (action.type) {
    case "click":
      return `${action.button ?? "left"} click${typeof action.x === "number" && typeof action.y === "number" ? ` @ ${action.x},${action.y}` : ""}`;
    case "double_click":
      return `double click${typeof action.x === "number" && typeof action.y === "number" ? ` @ ${action.x},${action.y}` : ""}`;
    case "drag":
      return `drag ${action.path.length} points`;
    case "keypress":
      return action.keys.join("+");
    case "move":
      return `move @ ${action.x},${action.y}`;
    case "scroll":
      return `scroll ${action.scroll_x},${action.scroll_y}`;
    case "type":
      return `type "${action.text.slice(0, 64)}"`;
    case "wait":
      return `wait ${action.durationMs ?? 1000}ms`;
    case "screenshot":
    default:
      return "capture screenshot";
  }
}

function normalizeMouseButton(
  value: unknown,
): "left" | "right" | "middle" | "wheel" | "back" | "forward" | undefined {
  switch (value) {
    case "left":
    case "right":
    case "wheel":
    case "back":
    case "forward":
      return value;
    case "middle":
      return "middle";
    default:
      return undefined;
  }
}

function toDataUrl(mimeType: string, base64: string) {
  return `data:${mimeType};base64,${base64}`;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

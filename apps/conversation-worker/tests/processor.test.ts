import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generalModelAnswerSourceStatement:
    "来源说明：本回答未引用已授权知识或记忆，内容由通用模型生成。",
  privateChannelSourceVerificationUnavailableStatement:
    "来源说明：暂时无法核验本次回答是否引用了已授权知识或记忆。为避免发送未经核验的内容，本次回答已被隐藏，请稍后重新提问。",
  generateRepresentativeReply: vi.fn(),
  generateManagedDocument: vi.fn(),
  buildRecentConversationRecallReply: vi.fn(),
  planTurnV2: vi.fn(),
  planTurnV3: vi.fn(),
  composeTurnV3: vi.fn(),
  buildCapabilityCatalogV3: vi.fn(),
  validateJsonSchemaValue: vi.fn(),
  validateComposedMessageDraftV3: vi.fn(),
  resolveComposerSourceGoalOutcomesV3: vi.fn(),
  compileCapabilityAction: vi.fn(),
  hasMatchedExecutableSkill: vi.fn(),
  isConversationCancellationRequest: vi.fn(),
  hasPersistedTelegramBotConnections: vi.fn(),
  isDeterministicContactMemoryDeleteCommand: vi.fn(),
  planNaturalLanguageComputeRequest: vi.fn(),
  renderFailClosedReplyPreview: vi.fn(),
  renderGroundedKnowledgeFallbackWithTrace: vi.fn(),
  claimNextOperatorMessageWorkItem: vi.fn(),
  claimNextConversationMessageDeliveryWorkItem: vi.fn(),
  claimNextGenerationWorkItem: vi.fn(),
  completeConversationMessageDelivery: vi.fn(),
  completeConversationTurnPlan: vi.fn(),
  completeReadyConversationTurnPlanForGenerationRun: vi.fn(),
  completeInlineGenerationRun: vi.fn(),
  createConversationPlan: vi.fn(),
  createManagedConversationDocumentArtifact: vi.fn(),
  prepareManagedConversationDocumentArtifact: vi.fn(),
  readStructuredCollectorState: vi.fn(),
  shouldStartStructuredCollector: vi.fn(),
  beginStructuredCollector: vi.fn(),
  advanceStructuredCollector: vi.fn(),
  formatStructuredCollectorPrompt: vi.fn(),
  formatStructuredCollectorSummary: vi.fn(),
  getRepresentativeRuntimeSetupSnapshot: vi.fn(),
  getRepresentativeRuntimeAuthoritySnapshot: vi.fn(),
  buildRepresentativeRuntimeProfile: vi.fn(),
  loadGenerationRecentTurns: vi.fn(),
  loadLatestConversationTurnPlanRevision: vi.fn(),
  loadReplayableConversationTurnPlan: vi.fn(),
  loadReplayableConversationTurnPlanV3: vi.fn(),
  persistConversationTurnPlanV3: vi.fn(),
  persistConversationTurnPlannerFailureV3: vi.fn(),
  loadV3GovernedCompositionContext: vi.fn(),
  prepareV3InlineAction: vi.fn(),
  markV3InlineActionCallStarted: vi.fn(),
  completeV3InlineAction: vi.fn(),
  loadConversationOperationalContext: vi.fn(),
  probeRepresentativeKnowledgeMetadata: vi.fn(),
  recallRepresentativeContext: vi.fn(),
  markGenerationDeliveryComplete: vi.fn(),
  prepareGenerationMessageChannelDelivery: vi.fn(),
  persistConversationTurnPlan: vi.fn(),
  persistConversationTurnPlannerFailure: vi.fn(),
  recordConversationPlanActionAuthorization: vi.fn(),
  recordConversationMessageProviderAcceptance: vi.fn(),
  recordGenerationMessageProviderAcceptance: vi.fn(),
  recordOperatorMessageProviderAcceptance: vi.fn(),
  completeConversationIntake: vi.fn(),
  setConversationCollectorState: vi.fn(),
  updateGenerationTurnExecutionProgress: vi.fn(),
  clearConversationCollectorState: vi.fn(),
  parseComputeDirective: vi.fn(),
  shouldConsiderNaturalLanguageCompute: vi.fn(),
  buildComputeRequestsFromDelegationPlan: vi.fn(),
  buildCapabilityCatalog: vi.fn(),
  turnEnvelopeParse: vi.fn(),
  validateTurnPlanV2: vi.fn(),
  readPersistedDelegationStepRequest: vi.fn(),
  resolveDeterministicContactMemorySharingCommand: vi.fn(),
  resolveGovernedPublicMaterialDeliveries: vi.fn(),
  createAudienceComputeSession: vi.fn(),
  createComputeDelegationTask: vi.fn(),
  findConversationCancelableDelegationTask: vi.fn(),
  applyRepresentativeDelegationTaskAction: vi.fn(),
  resolveRepresentativeComputeApproval: vi.fn(),
  createClarifyingDelegationTask: vi.fn(),
  continueClarifyingDelegationTask: vi.fn(),
  completeOperatorMessageDelivery: vi.fn(),
  deferOperatorMessageDelivery: vi.fn(),
  deferConversationMessageDelivery: vi.fn(),
  findConversationClarifyingDelegationTask: vi.fn(),
  executeAudienceTool: vi.fn(),
  finalizeComputeDelegationTask: vi.fn(),
  failGenerationRun: vi.fn(),
  failConversationTurnPlan: vi.fn(),
  failActiveV3InlinePlanExecution: vi.fn(),
  failV3InlinePlanExecution: vi.fn(),
  renewGenerationWorkItemLease: vi.fn(),
  retryGenerationDelivery: vi.fn(),
  markDelegationTaskAwaitingApproval: vi.fn(),
  markDelegationTaskRunning: vi.fn(),
  waitGenerationRunForComputeApproval: vi.fn(),
  assertConversationChannelDeliveryAvailable: vi.fn(),
  admitGenerationMessageProviderDelivery: vi.fn(),
  authorizeGenerationRunFreeUsage: vi.fn(),
  reserveGenerationConversationWalletUsage: vi.fn(),
  renderPrivateChannelGenerationDeliveryText: vi.fn(),
  releaseConversationEntitlement: vi.fn(),
  retryOperatorMessageDelivery: vi.fn(),
  retryConversationMessageDelivery: vi.fn(),
  resolveTelegramBotRuntimeCredential: vi.fn(),
  withActiveTelegramRepresentativeChannelFence: vi.fn(),
  withGenerationMessageProviderDeliveryFence: vi.fn(),
  sendMatrixRepresentativeMessage: vi.fn(),
}));

vi.mock("@delegate/model-runtime", () => ({
  buildCapabilityDiscoveryDocumentV3: (input: Record<string, unknown>) => ({
    ...input,
    discoveryHash: `sha256:${"d".repeat(64)}`,
  }),
  generateManagedDocument: mocks.generateManagedDocument,
  generateRepresentativeReply: mocks.generateRepresentativeReply,
  planTurnV2: mocks.planTurnV2,
  planTurnV3: mocks.planTurnV3,
  composeTurnV3: mocks.composeTurnV3,
  planNaturalLanguageComputeRequest: mocks.planNaturalLanguageComputeRequest,
  renderGroundedKnowledgeFallbackWithTrace:
    mocks.renderGroundedKnowledgeFallbackWithTrace,
}));

vi.mock("@delegate/runtime", () => ({
  authorizeConversationAction: () => ({
    decision: "allow",
    reason: "Built-in conversation action is allowed in the worker test fixture.",
  }),
  buildComputeRequestsFromDelegationPlan: mocks.buildComputeRequestsFromDelegationPlan,
  buildRecentConversationRecallReply: mocks.buildRecentConversationRecallReply,
  buildCapabilityCatalog: mocks.buildCapabilityCatalog,
  buildCapabilityCatalogV3: mocks.buildCapabilityCatalogV3,
  buildCapabilityAvailabilitySnapshotV3: ({ catalog, observedAt, capabilities }: {
    catalog: { catalogHash: string };
    observedAt: string;
    capabilities: unknown[];
  }) => ({
    catalogHash: catalog.catalogHash,
    observedAt,
    capabilities,
  }),
  capabilityDefinitionV3Schema: {
    safeParse: (value: unknown) => value && typeof value === "object"
      ? { success: true, data: value }
      : { success: false },
  },
  CAPABILITY_CANONICALIZATION_VERSION_V3: "delegate-capability-v1",
  derivePlannerCapabilitySchema: (schema: Record<string, unknown>) => schema,
  deriveTurnConstraintsFromMessage: (text: string) => ({
    scope: "turn",
    toolPolicy: text.includes("不要使用任何工具") ? "forbidden" : "auto",
    source: text.includes("不要使用任何工具")
      ? "explicit_user_instruction"
      : "default",
    sourcePointers: text.includes("不要使用任何工具")
      ? ["/currentMessage/text"]
      : [],
  }),
  stableSha256: () => `sha256:${"a".repeat(64)}`,
  createCapabilityCompilerRegistryFromPublicationsV3: () => ({
    compile: mocks.compileCapabilityAction,
  }),
  resolveGoalOutcomesV3: vi.fn(() => []),
  resolveComposerSourceGoalOutcomesV3:
    mocks.resolveComposerSourceGoalOutcomesV3,
  validateComposedMessageDraftV3: mocks.validateComposedMessageDraftV3,
  composedMessageDraftV3Schema: { safeParse: vi.fn(() => ({ success: false })) },
  advanceStructuredCollector: mocks.advanceStructuredCollector,
  beginStructuredCollector: mocks.beginStructuredCollector,
  createConversationPlan: mocks.createConversationPlan,
  formatStructuredCollectorPrompt: mocks.formatStructuredCollectorPrompt,
  formatStructuredCollectorSummary: mocks.formatStructuredCollectorSummary,
  hasMatchedExecutableSkill: mocks.hasMatchedExecutableSkill,
  isConversationCancellationRequest: mocks.isConversationCancellationRequest,
  parseComputeDirective: mocks.parseComputeDirective,
  renderFailClosedReplyPreview: mocks.renderFailClosedReplyPreview,
  renderReplyPreview: () => "fallback",
  readPersistedDelegationStepRequest: mocks.readPersistedDelegationStepRequest,
  readStructuredCollectorState: mocks.readStructuredCollectorState,
  resolveComputeSubagent: () => ({ id: "compute-agent" }),
  resolveConversationSubagent: () => ({ id: "public", allowedConversationDispositions: ["answer"] }),
  shouldStartStructuredCollector: mocks.shouldStartStructuredCollector,
  shouldConsiderNaturalLanguageCompute: mocks.shouldConsiderNaturalLanguageCompute,
  turnEnvelopeSchema: { parse: mocks.turnEnvelopeParse },
  validateJsonSchemaValue: mocks.validateJsonSchemaValue,
  validateTurnPlanV2: mocks.validateTurnPlanV2,
  validateTurnPlanV3: vi.fn(({ plan }) => ({ ok: true, plan })),
}));

vi.mock("@delegate/web-data", () => ({
  buildMcpToolCapabilityPublicationV3: ({ binding, tool }: {
    binding: { id: string; slug: string };
    tool: {
      exactToolName: string;
      bindingRevision: number;
      description?: string;
      inputSchema: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      toolSchemaHash: string;
      bindingDefinitionHash: string;
    };
  }) => {
    const key = `mcp.${binding.slug}.${tool.exactToolName}`;
    return {
      definition: {
        key,
        version: String(tool.bindingRevision),
        description: tool.description ?? `Call ${tool.exactToolName}`,
        executor: "mcp",
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema ?? {
          type: "object",
          properties: { result: {} },
          required: ["result"],
          additionalProperties: false,
        },
        effect: { boundary: "external", mutation: "write", reversibility: "unknown" },
        idempotency: "non_idempotent",
        supportedChannels: ["web", "matrix", "telegram"],
        requiredIdentityScopes: [],
        requiredDataScopes: [],
        tags: [binding.slug, tool.exactToolName],
        semantics: {
          operations: ["read", "search"],
          evidenceClasses: ["capability_result"],
          freshnessClasses: ["bounded"],
          authorityClasses: ["external_authoritative"],
          domains: ["repository"],
          aliases: [binding.slug, tool.exactToolName],
        },
        canonicalizationVersion: "delegate-capability-v1",
        mcpToolSchemaHash: tool.toolSchemaHash,
        bindingDefinitionHash: tool.bindingDefinitionHash,
        definitionHash: `sha256:${"a".repeat(64)}`,
      },
      availability: {
        capabilityKey: key,
        capabilityVersion: String(tool.bindingRevision),
        definitionHash: `sha256:${"a".repeat(64)}`,
        healthState: "ready",
        checkedAt: "2026-08-25T00:00:00.000Z",
      },
      target: {
        executor: "mcp",
        bindingId: binding.id,
        bindingRevision: tool.bindingRevision,
        toolName: tool.exactToolName,
      },
      searchDocument: `${tool.description ?? ""} ${tool.exactToolName}`,
      discoveryTextTrust: "third_party_untrusted",
    };
  },
  buildWorkspaceSkillCapabilityPublicationV3: ({ skill, release }: {
    skill: { slug: string };
    release: {
      id: string;
      version: string;
      displayName: string;
      summary: string;
      capabilityTags: string[];
    };
  }) => {
    const key = `skill.${skill.slug}`;
    return {
      definition: {
        key,
        version: release.version,
        description: `${release.displayName}: ${release.summary}`,
        executor: "skill",
        inputSchema: {
          type: "object",
          properties: { request: { type: "string" } },
          required: ["request"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { result: {} },
          required: ["result"],
          additionalProperties: false,
        },
        effect: { boundary: "external", mutation: "write", reversibility: "unknown" },
        idempotency: "non_idempotent",
        supportedChannels: ["web", "matrix", "telegram"],
        requiredIdentityScopes: [],
        requiredDataScopes: [],
        tags: release.capabilityTags,
        semantics: {
          operations: [], evidenceClasses: ["capability_result"],
          freshnessClasses: ["stable"], authorityClasses: ["owner_authorized"],
          domains: release.capabilityTags, aliases: [skill.slug],
        },
        canonicalizationVersion: "delegate-capability-v1",
        definitionHash: `sha256:${"a".repeat(64)}`,
      },
      availability: {
        capabilityKey: key,
        capabilityVersion: release.version,
        definitionHash: `sha256:${"a".repeat(64)}`,
        healthState: "unavailable",
        checkedAt: "1970-01-01T00:00:00.000Z",
        failureCode: "skill_runner_unavailable",
      },
      target: { executor: "skill", skillSlug: skill.slug, releaseId: release.id },
      searchDocument: `${release.displayName} ${release.summary} ${release.capabilityTags.join(" ")}`,
      discoveryTextTrust: "owner_configured",
    };
  },
  assertConversationChannelDeliveryAvailable: mocks.assertConversationChannelDeliveryAvailable,
  admitGenerationMessageProviderDelivery:
    mocks.admitGenerationMessageProviderDelivery,
  authorizeGenerationRunFreeUsage: mocks.authorizeGenerationRunFreeUsage,
  buildRepresentativeRuntimeProfile: mocks.buildRepresentativeRuntimeProfile,
  claimNextOperatorMessageWorkItem: mocks.claimNextOperatorMessageWorkItem,
  claimNextConversationMessageDeliveryWorkItem:
    mocks.claimNextConversationMessageDeliveryWorkItem,
  claimNextGenerationWorkItem: mocks.claimNextGenerationWorkItem,
  completeConversationMessageDelivery:
    mocks.completeConversationMessageDelivery,
  completeConversationTurnPlan: mocks.completeConversationTurnPlan,
  completeReadyConversationTurnPlanForGenerationRun:
    mocks.completeReadyConversationTurnPlanForGenerationRun,
  completeOperatorMessageDelivery: mocks.completeOperatorMessageDelivery,
  completeConversationIntake: mocks.completeConversationIntake,
  completeInlineGenerationRun: mocks.completeInlineGenerationRun,
  createManagedConversationDocumentArtifact:
    mocks.createManagedConversationDocumentArtifact,
  prepareManagedConversationDocumentArtifact:
    mocks.prepareManagedConversationDocumentArtifact,
  createAudienceComputeSession: mocks.createAudienceComputeSession,
  createComputeDelegationTask: mocks.createComputeDelegationTask,
  findConversationCancelableDelegationTask:
    mocks.findConversationCancelableDelegationTask,
  applyRepresentativeDelegationTaskAction:
    mocks.applyRepresentativeDelegationTaskAction,
  resolveRepresentativeComputeApproval:
    mocks.resolveRepresentativeComputeApproval,
  createClarifyingDelegationTask: mocks.createClarifyingDelegationTask,
  continueClarifyingDelegationTask: mocks.continueClarifyingDelegationTask,
  deferGenerationRunForHuman: vi.fn(),
  deferOperatorMessageDelivery: mocks.deferOperatorMessageDelivery,
  deferConversationMessageDelivery: mocks.deferConversationMessageDelivery,
  setConversationCollectorState: mocks.setConversationCollectorState,
  updateGenerationTurnExecutionProgress:
    mocks.updateGenerationTurnExecutionProgress,
  clearConversationCollectorState: mocks.clearConversationCollectorState,
  executeAudienceTool: mocks.executeAudienceTool,
  finalizeComputeDelegationTask: mocks.finalizeComputeDelegationTask,
  findConversationClarifyingDelegationTask: mocks.findConversationClarifyingDelegationTask,
  failGenerationRun: mocks.failGenerationRun,
  failConversationTurnPlan: mocks.failConversationTurnPlan,
  failActiveV3InlinePlanExecution: mocks.failActiveV3InlinePlanExecution,
  failV3InlinePlanExecution: mocks.failV3InlinePlanExecution,
  GENERATION_WORK_LEASE_DURATION_MS: 3_000,
  GenerationMemoryDeliveryBlockedError:
    class GenerationMemoryDeliveryBlockedError extends Error {
      readonly code = "generation_memory_delivery_source_revoked";
    },
  GenerationPlanDeliverySupersededError:
    class GenerationPlanDeliverySupersededError extends Error {
      readonly code = "turn_plan_superseded_before_delivery";
    },
  GenerationWorkLeaseLostError: class GenerationWorkLeaseLostError extends Error {
    readonly code = "generation_work_lease_lost";
  },
  getRepresentativeRuntimeSetupSnapshot: mocks.getRepresentativeRuntimeSetupSnapshot,
  getRepresentativeRuntimeAuthoritySnapshot:
    mocks.getRepresentativeRuntimeAuthoritySnapshot,
  hasPersistedTelegramBotConnections:
    mocks.hasPersistedTelegramBotConnections,
  isDeterministicContactMemoryDeleteCommand:
    mocks.isDeterministicContactMemoryDeleteCommand,
  loadGenerationRecentTurns: mocks.loadGenerationRecentTurns,
  loadLatestConversationTurnPlanRevision:
    mocks.loadLatestConversationTurnPlanRevision,
  loadReplayableConversationTurnPlan:
    mocks.loadReplayableConversationTurnPlan,
  loadReplayableConversationTurnPlanV3:
    mocks.loadReplayableConversationTurnPlanV3,
  persistConversationTurnPlanV3: mocks.persistConversationTurnPlanV3,
  persistConversationTurnPlannerFailureV3:
    mocks.persistConversationTurnPlannerFailureV3,
  loadV3GovernedCompositionContext:
    mocks.loadV3GovernedCompositionContext,
  prepareV3InlineAction: mocks.prepareV3InlineAction,
  markV3InlineActionCallStarted: mocks.markV3InlineActionCallStarted,
  completeV3InlineAction: mocks.completeV3InlineAction,
  loadConversationOperationalContext: mocks.loadConversationOperationalContext,
  markGenerationDeliveryComplete: mocks.markGenerationDeliveryComplete,
  markDelegationTaskAwaitingApproval: mocks.markDelegationTaskAwaitingApproval,
  markDelegationTaskRunning: mocks.markDelegationTaskRunning,
  prepareGenerationMessageChannelDelivery:
    mocks.prepareGenerationMessageChannelDelivery,
  persistConversationTurnPlan: mocks.persistConversationTurnPlan,
  persistConversationTurnPlannerFailure:
    mocks.persistConversationTurnPlannerFailure,
  recordConversationPlanActionAuthorization:
    mocks.recordConversationPlanActionAuthorization,
  recordConversationMessageProviderAcceptance:
    mocks.recordConversationMessageProviderAcceptance,
  recordGenerationMessageProviderAcceptance:
    mocks.recordGenerationMessageProviderAcceptance,
  recordOperatorMessageProviderAcceptance:
    mocks.recordOperatorMessageProviderAcceptance,
  generalModelAnswerSourceStatement:
    mocks.generalModelAnswerSourceStatement,
  privateChannelSourceVerificationUnavailableStatement:
    mocks.privateChannelSourceVerificationUnavailableStatement,
  probeRepresentativeKnowledgeMetadata:
    mocks.probeRepresentativeKnowledgeMetadata,
  recallRepresentativeContext: mocks.recallRepresentativeContext,
  resolveDeterministicContactMemorySharingCommand:
    mocks.resolveDeterministicContactMemorySharingCommand,
  resolveGovernedPublicMaterialDeliveries:
    mocks.resolveGovernedPublicMaterialDeliveries,
  releaseConversationEntitlement: mocks.releaseConversationEntitlement,
  reserveGenerationConversationWalletUsage:
    mocks.reserveGenerationConversationWalletUsage,
  renderPrivateChannelGenerationDeliveryText:
    mocks.renderPrivateChannelGenerationDeliveryText,
  renewGenerationWorkItemLease: mocks.renewGenerationWorkItemLease,
  retryGenerationDelivery: mocks.retryGenerationDelivery,
  retryOperatorMessageDelivery: mocks.retryOperatorMessageDelivery,
  retryConversationMessageDelivery: mocks.retryConversationMessageDelivery,
  resolveTelegramBotRuntimeCredential:
    mocks.resolveTelegramBotRuntimeCredential,
  withActiveTelegramRepresentativeChannelFence:
    mocks.withActiveTelegramRepresentativeChannelFence,
  withGenerationMessageProviderDeliveryFence:
    mocks.withGenerationMessageProviderDeliveryFence,
  isGenerationWorkLeaseLostError: (error: unknown) =>
    error instanceof Error
    && "code" in error
    && error.code === "generation_work_lease_lost",
  isGenerationMemoryDeliveryBlockedError: (error: unknown) =>
    error instanceof Error
    && "code" in error
    && error.code === "generation_memory_delivery_source_revoked",
  isGenerationPlanDeliverySupersededError: (error: unknown) =>
    error instanceof Error
    && "code" in error
    && error.code === "turn_plan_superseded_before_delivery",
  waitGenerationRunForComputeApproval: mocks.waitGenerationRunForComputeApproval,
}));

vi.mock("../src/matrix-outbound", () => ({
  sendMatrixRepresentativeMessage: mocks.sendMatrixRepresentativeMessage,
}));

import { GenerationWorkLeaseLostError } from "@delegate/web-data";

import {
  buildRepresentativeDescriptionOutput,
  buildV3GovernedComposerEvidence,
  processNextConversationWork,
  renderPolicyBlockedDelegationMessage,
  renderTurnPlanV3PlanningFailureMessage,
  resolveStableGeneralFallbackActivationStatus,
} from "../src/processor";

describe("conversation worker knowledge recall", () => {
  it("explains paid MCP policy denial without presenting it as an unknown system error", () => {
    expect(renderPolicyBlockedDelegationMessage("managed_plan_tier_required"))
      .toContain("需要已购买的 Pass 服务额度");
    expect(renderPolicyBlockedDelegationMessage("unclassified_policy_denial"))
      .toBe("委托任务被安全策略拒绝，未执行。");
    expect(resolveStableGeneralFallbackActivationStatus("plan_tier_required"))
      .toBe("entitlement_denied");
    expect(resolveStableGeneralFallbackActivationStatus("unclassified_policy_denial"))
      .toBeUndefined();
  });

  it("distinguishes Planner timeout from capability compilation failure", () => {
    expect(renderTurnPlanV3PlanningFailureMessage({
      code: "provider_failed",
      reason: "The operation was aborted due to timeout",
    })).toContain("规划服务本轮超时或调用失败");
    expect(renderTurnPlanV3PlanningFailureMessage({
      code: "plan_invalid",
    })).toContain("未通过能力、参数、证据或依赖校验");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateJsonSchemaValue.mockReturnValue([]);
    mocks.resolveComposerSourceGoalOutcomesV3.mockImplementation(({ plan }: {
      plan: { goals: Array<{ id: string }> };
    }) => plan.goals.map((goal) => ({
      goalId: goal.id,
      status: "succeeded",
    })));
    mocks.validateComposedMessageDraftV3.mockImplementation(({ draft }) => ({
      ok: true,
      draft,
    }));
    mocks.claimNextOperatorMessageWorkItem.mockResolvedValue(null);
    mocks.claimNextConversationMessageDeliveryWorkItem.mockResolvedValue(null);
    mocks.parseComputeDirective.mockReturnValue({ kind: "none" });
    mocks.hasMatchedExecutableSkill.mockReturnValue(false);
    mocks.resolveGovernedPublicMaterialDeliveries.mockResolvedValue([]);
    mocks.isConversationCancellationRequest.mockReturnValue(false);
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(false);
    mocks.readPersistedDelegationStepRequest.mockReturnValue(null);
    mocks.readStructuredCollectorState.mockReturnValue(null);
    mocks.loadConversationOperationalContext.mockResolvedValue(null);
    mocks.loadLatestConversationTurnPlanRevision.mockResolvedValue(null);
    mocks.loadReplayableConversationTurnPlan.mockResolvedValue(null);
    mocks.loadReplayableConversationTurnPlanV3.mockResolvedValue(null);
    mocks.loadV3GovernedCompositionContext.mockResolvedValue(null);
    mocks.shouldStartStructuredCollector.mockReturnValue(false);
    mocks.resolveDeterministicContactMemorySharingCommand.mockReturnValue(null);
    mocks.findConversationClarifyingDelegationTask.mockResolvedValue(null);
    mocks.findConversationCancelableDelegationTask.mockResolvedValue({ status: "none" });
    mocks.planNaturalLanguageComputeRequest.mockResolvedValue({ ok: true, plan: null, source: "model" });
    mocks.planTurnV2.mockResolvedValue({
      ok: false,
      code: "runtime_unavailable",
      reason: "disabled in test",
    });
    mocks.buildCapabilityCatalog.mockReturnValue({
      protocolVersion: 1,
      capabilities: [],
      catalogHash: `sha256:${"0".repeat(64)}`,
    });
    mocks.buildRecentConversationRecallReply.mockImplementation((input: {
      requestText: string;
      recentTurns: Array<{ direction: string; messageText: string }>;
    }) => {
      if (!/上面说了什么|刚才说了什么|上一条/.test(input.requestText)) {
        return null;
      }
      const latest = [...input.recentTurns]
        .reverse()
        .find((turn) => turn.direction === "inbound" && turn.messageText.trim());
      return {
        matched: true,
        found: Boolean(latest),
        replyText: latest
          ? `你刚才说的是：\n\n“${latest.messageText.trim()}”`
          : "我在本次对话中没有找到可回顾的上一条访客消息。",
      };
    });
    mocks.turnEnvelopeParse.mockImplementation((value) => value);
    mocks.validateTurnPlanV2.mockImplementation(({ plan }) => ({
      ok: true,
      plan,
    }));
    mocks.getRepresentativeRuntimeAuthoritySnapshot.mockResolvedValue(null);
    mocks.persistConversationTurnPlan.mockResolvedValue({ id: "turn-plan-1" });
    mocks.persistConversationTurnPlannerFailure.mockResolvedValue({
      id: "turn-plan-failure-1",
    });
    mocks.recordConversationPlanActionAuthorization.mockResolvedValue({
      id: "authorization-1",
    });
    mocks.generateManagedDocument.mockResolvedValue({
      ok: false,
      code: "runtime_unavailable",
      reason: "disabled in test",
      state: "disabled",
    });
    mocks.createManagedConversationDocumentArtifact.mockResolvedValue({
      artifact: { id: "managed-artifact-1" },
      fileName: "document.md",
      mimeType: "text/markdown; charset=utf-8",
      sizeBytes: 100,
      sha256: "a".repeat(64),
      downloadUrl: "/reps/sktone/chat/artifacts/managed-artifact-1/download",
    });
    mocks.prepareManagedConversationDocumentArtifact.mockResolvedValue({
      status: "claimed",
      claim: {
        planActionId: "plan-action-document",
        generationRunId: "run-1",
        argumentsHash: "c".repeat(64),
        claimToken: "d".repeat(64),
        artifactId: "managed-artifact-1",
        objectKey:
          "managed-documents/rep-1/conversation-1/managed-artifact-1.md",
        format: "markdown",
      },
    });
    mocks.completeConversationTurnPlan.mockResolvedValue(true);
    mocks.completeReadyConversationTurnPlanForGenerationRun.mockResolvedValue(false);
    mocks.failConversationTurnPlan.mockResolvedValue(true);
    mocks.markV3InlineActionCallStarted.mockResolvedValue({
      id: "inline-attempt",
      attemptPhase: "CALL_STARTED",
    });
    mocks.failActiveV3InlinePlanExecution.mockResolvedValue(null);
    mocks.failV3InlinePlanExecution.mockResolvedValue({
      attemptsClosed: 1,
      actionsFailed: 1,
      planFailed: true,
      memoryRunsFailed: 0,
    });
    mocks.finalizeComputeDelegationTask.mockResolvedValue({ hasMoreSteps: false });
    mocks.assertConversationChannelDeliveryAvailable.mockResolvedValue(undefined);
    mocks.admitGenerationMessageProviderDelivery.mockResolvedValue(true);
    mocks.authorizeGenerationRunFreeUsage.mockResolvedValue(true);
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(null);
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(null);
    mocks.renderPrivateChannelGenerationDeliveryText.mockImplementation(
      async ({ text }: { text: string }) => text,
    );
    mocks.releaseConversationEntitlement.mockResolvedValue(undefined);
    mocks.renewGenerationWorkItemLease.mockResolvedValue(true);
    mocks.deferOperatorMessageDelivery.mockResolvedValue(true);
    mocks.deferConversationMessageDelivery.mockResolvedValue(true);
    mocks.prepareGenerationMessageChannelDelivery.mockResolvedValue({
      conversationState: "WAITING_USER",
      leaseExpiresAt: new Date("2026-07-24T08:05:00.000Z"),
      deliveryAdmission: {
        attemptNumber: 1,
        leaseToken: "delivery-lease-1",
      },
    });
    mocks.retryGenerationDelivery.mockResolvedValue(undefined);
    mocks.retryOperatorMessageDelivery.mockResolvedValue(undefined);
    mocks.retryConversationMessageDelivery.mockResolvedValue(true);
    mocks.completeConversationMessageDelivery.mockResolvedValue(true);
    mocks.completeOperatorMessageDelivery.mockResolvedValue(true);
    mocks.recordConversationMessageProviderAcceptance.mockResolvedValue(true);
    mocks.recordGenerationMessageProviderAcceptance.mockResolvedValue(true);
    mocks.recordOperatorMessageProviderAcceptance.mockResolvedValue(true);
    mocks.resolveTelegramBotRuntimeCredential.mockResolvedValue(null);
    mocks.withActiveTelegramRepresentativeChannelFence.mockImplementation(
      async (_input, operation) => ({
        executed: true,
        value: await operation({}),
      }),
    );
    mocks.withGenerationMessageProviderDeliveryFence.mockImplementation(
      async (_tx, _input, operation) => ({
        executed: true,
        value: await operation(),
      }),
    );
    mocks.hasPersistedTelegramBotConnections.mockResolvedValue(false);
    mocks.isDeterministicContactMemoryDeleteCommand.mockImplementation(
      (text: string | null) => [
        "/delete_memory",
        "/forget",
        "delete my memory",
        "forget my memory",
        "删除我的记忆",
      ].includes(text?.trim().toLocaleLowerCase() ?? ""),
    );
    mocks.sendMatrixRepresentativeMessage.mockResolvedValue("$matrix-event-1");
    mocks.createComputeDelegationTask.mockResolvedValue({
      task: { id: "task-1" },
      step: { id: "task-step-1" },
    });
    mocks.completeConversationIntake.mockResolvedValue({
      serviceRequestId: "service-request-1",
      intakeSubmissionId: "intake-1",
      leadId: "lead-1",
      skipped: null,
    });
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-1",
      leaseAttempt: 1,
      runId: "run-1",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-1",
      contactId: "contact-1",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-1",
      userText: "佩奇当老师时发生了什么？",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      skillPacks: [],
      knowledgePackRevision: 1,
      knowledgePack: {
        identitySummary: "Test representative",
        faq: [{
          title: "课程安排",
          kind: "faq",
          summary: "介绍课程时间和报名方式",
        }],
        materials: [],
        policies: [],
      },
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });
    mocks.createConversationPlan.mockReturnValue({
      goal: "get_information",
      intent: "faq",
      audienceRole: "other",
      disposition: "answer",
      actions: [{ id: "answer_public_information:faq", kind: "answer_public_information", status: "planned", sideEffect: "none" }],
      reasons: ["Public answer."],
      responseOutline: ["Answer from authorized public information."],
    });
    mocks.renderFailClosedReplyPreview.mockReturnValue("SAFE FAIL-CLOSED REPLY");
    mocks.loadGenerationRecentTurns.mockResolvedValue([]);
    mocks.probeRepresentativeKnowledgeMetadata.mockResolvedValue({
      status: "miss",
      candidateCount: 0,
      matchedTopics: [],
      probeRevision: "knowledge-probe:version-1:test",
    });
    mocks.recallRepresentativeContext.mockResolvedValue({
      items: [{
        uri: "viking://resources/delegate/reps/sktone/knowledge/asset-1.md/asset-1.md",
        contextType: "resource",
        layer: "L2",
        score: 0.91,
        abstract: "佩奇临时代课并带大家画恐龙。",
        memoryUseItemId: "memory-use-item-1",
        internalSource: {
          sourceKind: "PUBLIC_KNOWLEDGE",
          memoryUseItemId: "memory-use-item-1",
        },
      }],
      citations: [],
      memoryUseRunId: "memory-use-run-1",
    });
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: true,
      replyText: "佩奇临时代课，和同学们一起完成了一幅有想象力的恐龙画。",
      provider: "openai",
      model: "test-model",
      citedMemoryUseItemIds: ["memory-use-item-1"],
      contextTrace: {
        selectedMemoryUseItemIds: ["memory-use-item-1"],
      },
    });
    mocks.renderGroundedKnowledgeFallbackWithTrace.mockReturnValue({
      replyText: "根据已发布的知识资料：佩奇临时代课并带大家画恐龙。",
      selectedRecallUris: [
        "viking://resources/delegate/reps/sktone/knowledge/asset-1.md/asset-1.md",
      ],
    });
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-1" } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("completes a queued Web task-status message without calling a provider", async () => {
    mocks.claimNextConversationMessageDeliveryWorkItem.mockResolvedValueOnce({
      outboxId: "outbox-task-status-web",
      leaseAttempt: 1,
      messageId: "message-task-status-web",
      conversationId: "conversation-task-status-web",
      text: "任务已完成。",
      senderType: "SYSTEM",
      senderName: "Delegate",
      deliveryKind: "delegation_task_status",
      channel: "web",
    });

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "message-task-status-web",
      status: "completed",
    });
    expect(mocks.completeConversationMessageDelivery).toHaveBeenCalledWith({
      outboxId: "outbox-task-status-web",
      leaseAttempt: 1,
      messageId: "message-task-status-web",
    });
    expect(mocks.claimNextGenerationWorkItem).not.toHaveBeenCalled();
    expect(mocks.sendMatrixRepresentativeMessage).not.toHaveBeenCalled();
  });

  it("delivers a queued Matrix task-status message as the representative", async () => {
    mocks.claimNextConversationMessageDeliveryWorkItem.mockResolvedValueOnce({
      outboxId: "outbox-task-status-matrix",
      leaseAttempt: 2,
      messageId: "message-task-status-matrix",
      conversationId: "conversation-task-status-matrix",
      text: "任务已完成。",
      senderType: "SYSTEM",
      senderName: "Delegate",
      deliveryKind: "delegation_task_status",
      channel: "matrix",
      externalConversationId: "!room:example.test",
      matrixSenderUserId: "@rep:example.test",
      matrixEndpointLifecycleRevision: 4,
    });
    mocks.sendMatrixRepresentativeMessage.mockResolvedValueOnce("$task-status");

    await expect(
      processNextConversationWork({
        port: 4040,
        pollMs: 500,
        matrixHomeserverUrl: "https://matrix.example.test",
        matrixApplicationServiceToken: "as-token",
      }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "message-task-status-matrix",
      status: "completed",
    });
    expect(mocks.sendMatrixRepresentativeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-task-status-matrix",
        roomId: "!room:example.test",
        senderUserId: "@rep:example.test",
        senderMode: "ai",
        deliveryId: "conversation-message-message-task-status-matrix",
        text: "任务已完成。",
      }),
    );
    expect(mocks.assertConversationChannelDeliveryAvailable).toHaveBeenCalledWith({
      conversationId: "conversation-task-status-matrix",
      channel: "matrix",
      senderMode: "system",
      allowNeedsHumanDelivery: true,
    });
    expect(mocks.completeConversationMessageDelivery).toHaveBeenCalledWith({
      outboxId: "outbox-task-status-matrix",
      leaseAttempt: 2,
      messageId: "message-task-status-matrix",
      externalMessageId: "$task-status",
    });
  });

  it("dead-letters an unknown Telegram task-status outcome without automatic retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
      connectionId: "111111111",
      botId: "111111111",
      username: "bot_a",
      displayName: "Bot A",
      token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
      credentialRevision: 1,
    });
    mocks.claimNextConversationMessageDeliveryWorkItem.mockResolvedValueOnce({
      outboxId: "outbox-task-status-telegram",
      leaseAttempt: 1,
      messageId: "message-task-status-telegram",
      conversationId: "conversation-task-status-telegram",
      text: "任务已完成。",
      senderType: "SYSTEM",
      senderName: "Delegate",
      deliveryKind: "delegation_task_status",
      channel: "telegram",
      externalConversationId: "123456",
      telegramConnectionId: "111111111",
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
    })).resolves.toMatchObject({
      processed: true,
      runId: "message-task-status-telegram",
      status: "failed",
      error: expect.stringContaining("outcome is unknown"),
    });

    expect(mocks.retryConversationMessageDelivery).toHaveBeenCalledWith({
      outboxId: "outbox-task-status-telegram",
      leaseAttempt: 1,
      messageId: "message-task-status-telegram",
      errorMessage: expect.stringContaining("outcome is unknown"),
      providerOutcomeUnknown: true,
      providerOutcomeCode: "telegram_provider_outcome_unknown",
    });
  });

  it("keeps explicit Telegram provider rejection on the normal retry path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ ok: false, description: "rate limited" }),
    }));
    mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
      connectionId: "111111111",
      botId: "111111111",
      username: "bot_a",
      displayName: "Bot A",
      token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
      credentialRevision: 1,
    });
    mocks.claimNextConversationMessageDeliveryWorkItem.mockResolvedValueOnce({
      outboxId: "outbox-task-status-rejected",
      leaseAttempt: 1,
      messageId: "message-task-status-rejected",
      conversationId: "conversation-task-status-rejected",
      text: "任务已完成。",
      senderType: "SYSTEM",
      senderName: "Delegate",
      deliveryKind: "delegation_task_status",
      channel: "telegram",
      externalConversationId: "123456",
      telegramConnectionId: "111111111",
    });

    await processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
    });

    expect(mocks.retryConversationMessageDelivery).toHaveBeenCalledWith({
      outboxId: "outbox-task-status-rejected",
      leaseAttempt: 1,
      messageId: "message-task-status-rejected",
      errorMessage: "rate limited",
    });
  });

  it("persists a strict V2 plan in shadow mode before the legacy turn completes", async () => {
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValueOnce({
      id: "rep-1",
      skillPacks: [],
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    const shadowPlan = {
      protocolVersion: 2,
      planId: "turn-plan-run-1-1",
      objective: "回答问题",
      mode: "respond",
      goals: [{ id: "goal-1", description: "回答问题", priority: 100 }],
      deliverables: [],
      uncertainties: [],
      questions: [],
      actions: [],
    };
    mocks.planTurnV2.mockResolvedValueOnce({
      ok: true,
      plan: shadowPlan,
      selectedCapabilities: [],
      provider: "openai",
      model: "planner-model",
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "shadow",
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-1",
      status: "completed",
    });

    expect(mocks.planTurnV2).toHaveBeenCalledWith(expect.objectContaining({
      planId: "turn-plan-run-1-1",
      envelope: expect.objectContaining({
        currentMessage: expect.objectContaining({ id: "message-1" }),
      }),
    }));
    expect(mocks.persistConversationTurnPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        generationRunId: "run-1",
        plan: shadowPlan,
        plannerProvider: "openai",
        plannerModel: "planner-model",
        shadowMode: true,
      }),
    );
  });

  it("allocates a new immutable plan revision after a persisted planner failure", async () => {
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValueOnce({
      id: "rep-1",
      skillPacks: [],
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.loadLatestConversationTurnPlanRevision.mockResolvedValueOnce({
      revision: 1,
      status: "FAILED",
    });
    const revisedPlan = {
      protocolVersion: 2,
      planId: "turn-plan-run-1-2",
      objective: "回答问题",
      mode: "respond",
      goals: [{ id: "goal-1", description: "回答问题", priority: 100 }],
      deliverables: [],
      uncertainties: [],
      questions: [],
      actions: [],
    };
    mocks.planTurnV2.mockResolvedValueOnce({
      ok: true,
      plan: revisedPlan,
      selectedCapabilities: [],
      provider: "openai",
      model: "planner-model",
    });

    await processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "shadow",
    });

    expect(mocks.planTurnV2).toHaveBeenCalledWith(expect.objectContaining({
      planId: "turn-plan-run-1-2",
    }));
    expect(mocks.persistConversationTurnPlan).toHaveBeenCalledWith(
      expect.objectContaining({ plan: revisedPlan, shadowMode: true }),
    );
  });

  it("executes a platform-managed document without entering Compute approval", async () => {
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValueOnce({
      id: "rep-1",
      skillPacks: [],
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        artifactRetentionDays: 30,
      },
    });
    const definitionHash = `sha256:${"b".repeat(64)}`;
    const plan = {
      protocolVersion: 2,
      planId: "turn-plan-run-1-1",
      objective: "生成地理学习教程文件",
      mode: "execute",
      goals: [
        { id: "goal-1", description: "生成教程", priority: 100 },
        { id: "goal-2", description: "组织基础地理知识", priority: 90 },
        { id: "goal-3", description: "以文件形式交付", priority: 80 },
      ],
      deliverables: [{
        id: "deliverable-1",
        kind: "artifact",
        format: "markdown",
        producedByActionIds: ["action-document"],
        completionCriteria: ["返回可下载文档"],
      }],
      uncertainties: [],
      questions: [],
      actions: [{
        id: "action-document",
        capability: {
          key: "artifact.generate_document",
          version: "1",
          definitionHash,
        },
        arguments: {
          topic: "地理学习教程",
          audience: "通用学习者",
          format: "markdown",
        },
        argumentProvenance: {},
        dependsOn: [],
        expectedOutputSchema: {},
        completionCriteria: ["正文非空"],
        onFailure: "stop",
      }],
    };
    mocks.planTurnV2.mockResolvedValueOnce({
      ok: true,
      plan,
      selectedCapabilities: [],
      provider: "openai",
      model: "planner-model",
    });
    mocks.persistConversationTurnPlan.mockResolvedValueOnce({
      id: plan.planId,
      shadowMode: false,
      actions: [{ id: "plan-action-document", actionKey: "action-document" }],
    });
    mocks.generateManagedDocument.mockImplementationOnce(
      async (input: { onProgress?: (progress: unknown) => Promise<void> }) => {
        await input.onProgress?.({ stage: "generating", part: 1, maxParts: 3 });
        await input.onProgress?.({ stage: "validating", part: 1, maxParts: 3 });
        return {
          ok: true,
          title: "地理学习教程",
          content: "# 地理学习教程\n\n这是完整且可直接使用的教程正文。",
          requestedFormat: "markdown",
          sourceFormat: "markdown",
          provider: "openai",
          model: "document-model",
          usage: null,
        };
      },
    );
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValueOnce(true);

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "active_low_risk",
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-1",
      status: "completed",
    });

    expect(mocks.recordConversationPlanActionAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        planActionId: "plan-action-document",
        decision: "allow",
      }),
    );
    expect(mocks.persistConversationTurnPlan).toHaveBeenCalledWith(
      expect.objectContaining({ plan, shadowMode: false }),
    );
    expect(mocks.generateManagedDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "地理学习教程",
        format: "markdown",
      }),
    );
    expect(mocks.createManagedConversationDocumentArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        planActionId: "plan-action-document",
        content: expect.stringContaining("完整且可直接使用"),
      }),
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "turn_plan_v2_managed_document",
        runtimeOutcome: { mode: "model" },
        attachments: [expect.objectContaining({
          artifactId: "managed-artifact-1",
          fileName: "document.md",
        })],
      }),
    );
    expect(mocks.completeConversationTurnPlan).toHaveBeenCalledWith({
      planId: plan.planId,
      output: expect.objectContaining({ artifactId: "managed-artifact-1" }),
    });
    expect(
      mocks.updateGenerationTurnExecutionProgress.mock.calls.map(
        ([input]) => input.stage,
      ),
    ).toEqual([
      "planning",
      "authorizing",
      "generating",
      "validating",
      "saving",
      "delivering",
    ]);
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
    expect(mocks.waitGenerationRunForComputeApproval).not.toHaveBeenCalled();
    expect(mocks.planNaturalLanguageComputeRequest).not.toHaveBeenCalled();
  });

  it("does not generate a managed document without service entitlement", async () => {
    const plan = managedDocumentPlanFixture();
    mocks.claimNextGenerationWorkItem.mockResolvedValueOnce({
      outboxId: "outbox-document-payment",
      leaseAttempt: 1,
      runId: "run-document-payment",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-document-payment",
      contactId: "contact-document-payment",
      audienceIdentityId: "audience-document-payment",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-document-payment",
      userText: "请生成 Markdown 地理学习教程文件",
      channel: "web",
      usage: { freeRepliesUsed: 4, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValueOnce({
      id: "rep-1",
      skillPacks: [],
      compute: { enabled: true, baseImage: "debian:bookworm-slim", artifactRetentionDays: 30 },
    });
    mocks.planTurnV2.mockResolvedValueOnce({
      ok: true,
      plan,
      selectedCapabilities: [],
      provider: "openai",
      model: "planner-model",
    });
    mocks.persistConversationTurnPlan.mockResolvedValueOnce({
      id: plan.planId,
      shadowMode: false,
      actions: [{ id: "plan-action-document-payment", actionKey: "action-document" }],
    });
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValueOnce(null);

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "active_low_risk",
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-document-payment",
      status: "completed",
    });

    expect(mocks.recordConversationPlanActionAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "deny" }),
    );
    expect(mocks.generateManagedDocument).not.toHaveBeenCalled();
    expect(mocks.createManagedConversationDocumentArtifact).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "turn_plan_v2_document_payment_required",
        countUsage: false,
      }),
    );
  });

  it("reuses a succeeded managed document action after a worker crash", async () => {
    const plan = managedDocumentPlanFixture();
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValueOnce({
      id: "rep-1",
      skillPacks: [],
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        artifactRetentionDays: 30,
      },
    });
    mocks.loadReplayableConversationTurnPlan.mockResolvedValueOnce({
      id: plan.planId,
      planSnapshot: plan,
      plannerProvider: "openai",
      plannerModel: "planner-model",
      status: "EXECUTING",
      shadowMode: false,
      actions: [{ id: "plan-action-document", actionKey: "action-document" }],
    });
    mocks.prepareManagedConversationDocumentArtifact.mockResolvedValueOnce({
      status: "succeeded",
      result: {
        artifact: { id: "managed-artifact-1" },
        fileName: "document.md",
        mimeType: "text/markdown; charset=utf-8",
        sizeBytes: 100,
        sha256: "a".repeat(64),
        downloadUrl:
          "/reps/sktone/chat/artifacts/managed-artifact-1/download",
      },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "active_low_risk",
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-1",
      status: "completed",
    });

    expect(mocks.planTurnV2).not.toHaveBeenCalled();
    expect(mocks.generateManagedDocument).not.toHaveBeenCalled();
    expect(mocks.createManagedConversationDocumentArtifact).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "turn_plan_v2_managed_document",
        attachments: [expect.objectContaining({
          artifactId: "managed-artifact-1",
        })],
      }),
    );
  });

  it("never promotes a replayed shadow document plan into Fast Lane", async () => {
    const plan = managedDocumentPlanFixture();
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValueOnce({
      id: "rep-1",
      skillPacks: [],
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.loadReplayableConversationTurnPlan.mockResolvedValueOnce({
      id: plan.planId,
      planSnapshot: plan,
      plannerProvider: "openai",
      plannerModel: "planner-model",
      status: "VALIDATED",
      shadowMode: true,
      actions: [{ id: "plan-action-document", actionKey: "action-document" }],
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "active_low_risk",
    })).resolves.toMatchObject({ processed: true, runId: "run-1" });

    expect(mocks.planTurnV2).not.toHaveBeenCalled();
    expect(mocks.prepareManagedConversationDocumentArtifact).not.toHaveBeenCalled();
    expect(mocks.generateManagedDocument).not.toHaveBeenCalled();
    expect(mocks.createManagedConversationDocumentArtifact).not.toHaveBeenCalled();
  });

  it("does not ignore an unparsed visitor attachment when generating a document", async () => {
    const plan = managedDocumentPlanFixture();
    mocks.claimNextGenerationWorkItem.mockResolvedValueOnce({
      outboxId: "outbox-document-attachment",
      leaseAttempt: 1,
      runId: "run-document-attachment",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-document-attachment",
      contactId: "contact-document-attachment",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-document-attachment",
      userText: "请根据附件生成 Markdown 地理学习教程文件",
      inputAttachments: [{
        id: "attachment-1",
        fileName: "source.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
      }],
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValueOnce({
      id: "rep-1",
      skillPacks: [],
      compute: { enabled: true, baseImage: "debian:bookworm-slim", artifactRetentionDays: 30 },
    });
    mocks.planTurnV2.mockResolvedValueOnce({
      ok: true,
      plan,
      selectedCapabilities: [],
      provider: "openai",
      model: "planner-model",
    });
    mocks.persistConversationTurnPlan.mockResolvedValueOnce({
      id: plan.planId,
      shadowMode: true,
      actions: [{ id: "plan-action-document-attachment", actionKey: "action-document" }],
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "active_low_risk",
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-document-attachment",
      status: "waiting_input",
    });

    expect(mocks.persistConversationTurnPlan).toHaveBeenCalledWith(
      expect.objectContaining({ shadowMode: true }),
    );
    expect(mocks.generateManagedDocument).not.toHaveBeenCalled();
    expect(mocks.createManagedConversationDocumentArtifact).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "turn_plan_v2_document_attachment_context_required",
        countUsage: false,
      }),
    );
  });

  it("delivers a managed document to Matrix with a verified absolute download link", async () => {
    const plan = managedDocumentPlanFixture();
    mocks.claimNextGenerationWorkItem.mockResolvedValueOnce({
      outboxId: "outbox-document-matrix",
      leaseAttempt: 1,
      runId: "run-document-matrix",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-document-matrix",
      contactId: "contact-document-matrix",
      audienceIdentityId: "audience-document-matrix",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-document-matrix",
      userText: "请生成 Markdown 地理学习教程文件",
      channel: "matrix",
      externalConversationId: "!room:example.test",
      matrixSenderUserId: "@rep:example.test",
      matrixEndpointLifecycleRevision: 2,
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValueOnce({
      id: "rep-1",
      skillPacks: [],
      compute: { enabled: true, baseImage: "debian:bookworm-slim", artifactRetentionDays: 30 },
    });
    mocks.planTurnV2.mockResolvedValueOnce({
      ok: true,
      plan,
      selectedCapabilities: [],
      provider: "openai",
      model: "planner-model",
    });
    mocks.persistConversationTurnPlan.mockResolvedValueOnce({
      id: plan.planId,
      shadowMode: false,
      actions: [{ id: "plan-action-document-matrix", actionKey: "action-document" }],
    });
    mocks.generateManagedDocument.mockResolvedValueOnce({
      ok: true,
      title: "地理学习教程",
      content: "# 地理学习教程\n\n完整教程正文。",
      requestedFormat: "markdown",
      sourceFormat: "markdown",
      provider: "openai",
      model: "document-model",
      usage: null,
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "active_low_risk",
      representativePublicOrigin: "https://representatives.example.test",
      matrixHomeserverUrl: "https://matrix.example.test",
      matrixApplicationServiceToken: "matrix-application-service-token",
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-document-matrix",
      status: "completed",
    });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeOutcome: { mode: "model" },
        attachments: [expect.objectContaining({
          url: "https://representatives.example.test/reps/sktone/chat/artifacts/managed-artifact-1/download",
        })],
      }),
    );
    expect(mocks.sendMatrixRepresentativeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "https://representatives.example.test/reps/sktone/chat/artifacts/managed-artifact-1/download",
        ),
      }),
    );
  });

  it("delivers an actionable managed-document failure on Matrix", async () => {
    const plan = managedDocumentPlanFixture();
    mocks.claimNextGenerationWorkItem.mockResolvedValueOnce({
      outboxId: "outbox-document-matrix-failed",
      leaseAttempt: 1,
      runId: "run-document-matrix-failed",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-document-matrix-failed",
      contactId: "contact-document-matrix-failed",
      audienceIdentityId: "audience-document-matrix-failed",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-document-matrix-failed",
      userText: "请生成 Markdown 地理学习教程文件",
      channel: "matrix",
      externalConversationId: "!room:example.test",
      matrixSenderUserId: "@rep:example.test",
      matrixEndpointLifecycleRevision: 2,
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValueOnce({
      id: "rep-1",
      skillPacks: [],
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        artifactRetentionDays: 30,
      },
    });
    mocks.planTurnV2.mockResolvedValueOnce({
      ok: true,
      plan,
      selectedCapabilities: [],
      provider: "openai",
      model: "planner-model",
    });
    mocks.persistConversationTurnPlan.mockResolvedValueOnce({
      id: plan.planId,
      shadowMode: false,
      actions: [{
        id: "plan-action-document-matrix-failed",
        actionKey: "action-document",
      }],
    });
    mocks.generateManagedDocument.mockResolvedValueOnce({
      ok: false,
      code: "invalid_document_content",
      reason: "max_output_tokens",
      state: "ready",
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "active_low_risk",
      representativePublicOrigin: "https://representatives.example.test",
      matrixHomeserverUrl: "https://matrix.example.test",
      matrixApplicationServiceToken: "matrix-application-service-token",
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-document-matrix-failed",
      status: "completed",
    });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "turn_plan_v2_document_failed",
        runtimeOutcome: {
          mode: "fallback",
          fallbackStrategy: "deterministic_preview",
          modelRuntimeState: "ready",
          fallbackReason: "provider_failed",
        },
        countUsage: false,
      }),
    );
    expect(mocks.createManagedConversationDocumentArtifact).not.toHaveBeenCalled();
    expect(mocks.sendMatrixRepresentativeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("文档生成服务暂时不可用"),
      }),
    );
  });

  it("keeps unsupported V2 plans observational in active-low-risk mode", async () => {
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValueOnce({
      id: "rep-1",
      skillPacks: [],
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    const answerPlan = {
      protocolVersion: 2,
      planId: "turn-plan-run-1-1",
      objective: "回答地理问题",
      mode: "respond",
      goals: [{ id: "goal-1", description: "回答地理问题", priority: 100 }],
      deliverables: [],
      uncertainties: [],
      questions: [],
      actions: [],
    };
    mocks.planTurnV2.mockResolvedValueOnce({
      ok: true,
      plan: answerPlan,
      selectedCapabilities: [],
      provider: "openai",
      model: "planner-model",
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "active_low_risk",
    })).resolves.toMatchObject({ processed: true, runId: "run-1" });

    expect(mocks.persistConversationTurnPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: answerPlan,
        shadowMode: true,
      }),
    );
    expect(mocks.completeConversationTurnPlan).not.toHaveBeenCalledWith(
      expect.objectContaining({ planId: answerPlan.planId }),
    );
  });

  it.each([
    {
      name: "clarification mode with an action",
      mutate: (plan: any) => {
        plan.mode = "clarify";
        plan.questions = [{
          field: "topic",
          question: "请补充主题。",
          requiredForActionIds: ["action-document"],
        }];
      },
    },
    {
      name: "a blocking question",
      mutate: (plan: any) => {
        plan.questions = [{
          field: "audience",
          question: "教程面向谁？",
          requiredForActionIds: ["action-document"],
        }];
      },
    },
    {
      name: "a blocking uncertainty",
      mutate: (plan: any) => {
        plan.uncertainties = [{
          field: "source material",
          reason: "Required source material is unavailable.",
          blocksActionIds: ["action-document"],
        }];
      },
    },
    {
      name: "a second deliverable",
      mutate: (plan: any) => {
        plan.deliverables.push({
          id: "deliverable-answer",
          kind: "message",
          format: null,
          producedByActionIds: [],
          completionCriteria: ["回答附加问题"],
        });
      },
    },
    {
      name: "a mismatched artifact format",
      mutate: (plan: any) => {
        plan.deliverables[0].format = "pdf";
      },
    },
  ])("keeps $name out of the managed-document Fast Lane", async ({ mutate }) => {
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValueOnce({
      id: "rep-1",
      skillPacks: [],
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    const plan = managedDocumentPlanFixture();
    mutate(plan);
    mocks.planTurnV2.mockResolvedValueOnce({
      ok: true,
      plan,
      selectedCapabilities: [],
      provider: "openai",
      model: "planner-model",
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "active_low_risk",
    })).resolves.toMatchObject({ processed: true, runId: "run-1" });

    expect(mocks.persistConversationTurnPlan).toHaveBeenCalledWith(
      expect.objectContaining({ plan, shadowMode: true }),
    );
    expect(mocks.generateManagedDocument).not.toHaveBeenCalled();
    expect(mocks.createManagedConversationDocumentArtifact).not.toHaveBeenCalled();
    expect(mocks.completeConversationTurnPlan).not.toHaveBeenCalled();
    expect(mocks.prepareGenerationMessageChannelDelivery).not.toHaveBeenCalled();
  });

  it("never downgrades an ineligible managed-document plan into legacy Compute", async () => {
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValueOnce({
      id: "rep-1",
      skillPacks: [],
      compute: { enabled: true, baseImage: "debian:bookworm-slim" },
    });
    const plan: any = managedDocumentPlanFixture();
    plan.deliverables.push({
      id: "deliverable-extra",
      kind: "message",
      format: null,
      producedByActionIds: [],
      completionCriteria: ["返回额外消息"],
    });
    mocks.planTurnV2.mockResolvedValueOnce({
      ok: true,
      plan,
      selectedCapabilities: [],
      provider: "agicto",
      model: "qwen-plus",
    });
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValueOnce(true);

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "active_low_risk",
    })).resolves.toMatchObject({ processed: true, runId: "run-1" });

    expect(mocks.persistConversationTurnPlan).toHaveBeenCalledWith(
      expect.objectContaining({ plan, shadowMode: true }),
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        replyText: expect.stringContaining("不会降级为 Compute 写文件或创建审批"),
      }),
    );
    expect(mocks.planNaturalLanguageComputeRequest).not.toHaveBeenCalled();
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
    expect(mocks.waitGenerationRunForComputeApproval).not.toHaveBeenCalled();
  });

  it("recalls the latest audience message in the current episode without model or billing", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValueOnce({
      outboxId: "outbox-recent-recall",
      leaseAttempt: 1,
      runId: "run-recent-recall",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-recent-recall",
      contactId: "contact-recent-recall",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-recent-recall",
      userText: "我上面说了什么，你还记得吗",
      channel: "web",
      usage: { freeRepliesUsed: 3, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.loadGenerationRecentTurns.mockResolvedValue([
      { direction: "inbound", messageText: "更早的消息" },
      { direction: "inbound", messageText: "请给我规划一个中学地理学习计划" },
    ]);

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "shadow",
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-recent-recall",
      status: "completed",
    });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-recent-recall",
        intent: "conversation_recent_recall",
        countUsage: false,
        replyText: expect.stringContaining("请给我规划一个中学地理学习计划"),
      }),
    );
    expect(mocks.recallRepresentativeContext).not.toHaveBeenCalled();
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
  });

  it("declares recent turns untrusted and does not claim private channels support attachments", async () => {
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValueOnce({
      id: "rep-1",
      skillPacks: [],
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.claimNextGenerationWorkItem.mockResolvedValueOnce({
      outboxId: "outbox-matrix-envelope",
      leaseAttempt: 1,
      runId: "run-matrix-envelope",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-matrix-envelope",
      contactId: "contact-matrix-envelope",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-matrix-envelope",
      userText: "继续刚才的话题",
      channel: "matrix",
      externalConversationId: "!room:example.test",
      matrixSenderUserId: "@rep:example.test",
      matrixEndpointLifecycleRevision: 3,
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.loadGenerationRecentTurns.mockResolvedValueOnce([{
      direction: "inbound",
      messageText: "之前的用户消息",
    }]);

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "shadow",
      matrixHomeserverUrl: "https://matrix.example.test",
      matrixApplicationServiceToken: "as-token",
    })).resolves.toMatchObject({ processed: true, runId: "run-matrix-envelope" });

    expect(mocks.planTurnV2).toHaveBeenCalledWith(expect.objectContaining({
      envelope: expect.objectContaining({
        channel: { kind: "matrix", supportsAttachments: false },
        authority: { identityScopes: [], dataScopes: [] },
        recentTurns: [expect.objectContaining({
          text: "之前的用户消息",
          trustClass: "untrusted_conversation_data",
        })],
      }),
    }));
  });

  it("answers an exact status command deterministically without billing or model generation", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValueOnce({
      outboxId: "outbox-status",
      leaseAttempt: 1,
      runId: "run-status",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-status",
      contactId: "contact-status",
      audienceIdentityId: "audience-status",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-status",
      userText: "/status",
      channel: "web",
      usage: { freeRepliesUsed: 99, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.loadConversationOperationalContext.mockResolvedValueOnce({
      conversationState: "WAITING_APPROVAL",
      latestTask: {
        kind: "COMPUTE",
        status: "AWAITING_APPROVAL",
        nextActionBy: "OWNER",
      },
      pendingApproval: { requestedActionSummary: "发送邮件" },
      serviceEntitlement: { available: true, remainingUnits: 2 },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      runId: "run-status",
      status: "completed",
    });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      intent: "conversation_status",
      countUsage: false,
      replyText: expect.stringContaining("待审批动作：发送邮件"),
    }));
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
    expect(mocks.authorizeGenerationRunFreeUsage).not.toHaveBeenCalled();
  });

  it.each([
    {
      channel: "matrix" as const,
      command: "删除我的记忆",
      channelName: "Matrix",
      externalConversationId: "!memory-room:example.test",
      matrixSenderUserId: "@delegate:example.test",
    },
    {
      channel: "telegram" as const,
      command: "/forget",
      channelName: "Telegram",
      externalConversationId: "123456",
      telegramConnectionId: "111111111",
    },
  ])(
    "confirms an exact $channel Contact Memory deletion without recall, model, or billing",
    async (fixture) => {
      const confirmation =
        `已完成：当前数字代表与当前 ${fixture.channelName} 渠道下的联系人记忆已立即停止召回，后台将异步清理对应长期记忆。代表经验和其他渠道的联系人记忆不受影响。`;
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_id: 90212 },
        }),
      });
      vi.stubGlobal("fetch", fetchMock);
      if (fixture.channel === "telegram") {
        mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
          connectionId: "111111111",
          botId: "111111111",
          username: "bot_a",
          displayName: "Bot A",
          token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
          credentialRevision: 1,
        });
      }
      mocks.claimNextGenerationWorkItem.mockResolvedValue({
        outboxId: `outbox-delete-${fixture.channel}`,
        leaseAttempt: 1,
        runId: `run-delete-${fixture.channel}`,
        representativeVersionId: "version-1",
        representativeSlug: "sktone",
        representativeName: "SKTone",
        conversationId: `conversation-delete-${fixture.channel}`,
        contactId: `contact-delete-${fixture.channel}`,
        controlState: "AI_ACTIVE",
        inputMessageId: `message-delete-${fixture.channel}`,
        userText: fixture.command,
        channel: fixture.channel,
        externalConversationId: fixture.externalConversationId,
        ...(fixture.channel === "matrix"
          ? {
              matrixSenderUserId: fixture.matrixSenderUserId,
              matrixEndpointLifecycleRevision: 7,
            }
          : { telegramConnectionId: fixture.telegramConnectionId }),
        usage: {
          freeRepliesUsed: 99,
          passUnlocked: false,
          deepHelpUnlocked: false,
        },
      });

      await expect(processNextConversationWork({
        port: 4040,
        pollMs: 500,
        telegramConversationPlatformMode: "worker",
        matrixHomeserverUrl: "https://matrix.example.test",
        matrixApplicationServiceToken: "as-token",
      })).resolves.toMatchObject({
        processed: true,
        runId: `run-delete-${fixture.channel}`,
        status: "completed",
      });

      expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith({
        conversationId: `conversation-delete-${fixture.channel}`,
        runId: `run-delete-${fixture.channel}`,
        outboxId: `outbox-delete-${fixture.channel}`,
        leaseAttempt: 1,
        replyText: confirmation,
        senderDisplayName: "SKTone",
        intent: "contact_memory_delete_confirmation",
        completeOutbox: false,
        countUsage: false,
        runtimeOutcome: {
          mode: "fallback",
          fallbackStrategy: "deterministic_preview",
          modelRuntimeState: "disabled",
          fallbackReason: "policy_fallback",
        },
      });
      expect(mocks.getRepresentativeRuntimeSetupSnapshot).not.toHaveBeenCalled();
      expect(mocks.loadGenerationRecentTurns).not.toHaveBeenCalled();
      expect(mocks.recallRepresentativeContext).not.toHaveBeenCalled();
      expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
      expect(mocks.authorizeGenerationRunFreeUsage).not.toHaveBeenCalled();
      expect(mocks.renderPrivateChannelGenerationDeliveryText).not.toHaveBeenCalled();

      if (fixture.channel === "matrix") {
        expect(mocks.sendMatrixRepresentativeMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId: "conversation-delete-matrix",
            roomId: fixture.externalConversationId,
            senderUserId: fixture.matrixSenderUserId,
            generationRunId: "run-delete-matrix",
            text: confirmation,
          }),
        );
        expect(fetchMock).not.toHaveBeenCalled();
      } else {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining(
            "/bot111111111:AAAAAAAAAAAAAAAAAAAAAAAA/sendMessage",
          ),
          expect.objectContaining({
            body: JSON.stringify({
              chat_id: fixture.externalConversationId,
              text: confirmation,
            }),
          }),
        );
      }
    },
  );

  it("passes recalled knowledge to the model and persists its citation", async () => {
    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.recallRepresentativeContext).toHaveBeenCalledWith({
      representativeSlug: "sktone",
      conversationId: "conversation-1",
      contactId: "contact-1",
      sourceChannel: "web",
      generationRunId: "run-1",
      queryText: "佩奇当老师时发生了什么？",
    });
    expect(mocks.generateRepresentativeReply).toHaveBeenCalledWith(expect.objectContaining({
      recalled: [expect.objectContaining({ abstract: "佩奇临时代课并带大家画恐龙。" })],
    }));
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      memoryUse: {
        runId: "memory-use-run-1",
        outcome: "completed",
        injectedItemIds: ["memory-use-item-1"],
        citedItemIds: ["memory-use-item-1"],
      },
      runtimeOutcome: {
        mode: "model",
      },
    }));
  });

  it("revalidates public materials at send time and emits only governed links", async () => {
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      slug: "sktone",
      contract: { freeReplyLimit: 4 },
      knowledgePack: {
        materials: [{
          id: "legacy-material",
          title: "旧资料",
          summary: "配置快照中的旧链接不得直接发送。",
          kind: "download",
          url: "https://legacy.example.test/old.pdf",
        }],
      },
    });
    mocks.createConversationPlan.mockReturnValue({
      goal: "provide_information",
      intent: "public_material",
      audienceRole: "other",
      disposition: "answer",
      actions: [
        { id: "answer_public_information:material", kind: "answer_public_information", status: "planned", sideEffect: "none" },
        { id: "deliver_public_material:material", kind: "deliver_public_material", status: "planned", sideEffect: "none" },
      ],
      reasons: ["The user requested a published material."],
      responseOutline: ["Answer and provide the governed material."],
    });
    mocks.resolveGovernedPublicMaterialDeliveries.mockResolvedValue([{
      id: "asset-1",
      title: "公开指南",
      summary: "已发布版本",
      processingVersion: 9,
      url: "/reps/sktone/materials/asset-1/download?token=signed",
    }]);

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.resolveGovernedPublicMaterialDeliveries).toHaveBeenCalledWith({
      representativeId: "rep-1",
      representativeSlug: "sktone",
      queryText: "佩奇当老师时发生了什么？",
      businessLabels: [],
      requestedOutcomes: [],
      legacyMaterials: [expect.objectContaining({ id: "legacy-material" })],
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      replyText: expect.stringContaining(
        "/reps/sktone/materials/asset-1/download?token=signed",
      ),
      turnTrace: expect.objectContaining({
        actions: expect.arrayContaining([
          expect.objectContaining({
            kind: "deliver_public_material",
            execution: expect.objectContaining({ status: "completed" }),
          }),
        ]),
      }),
    }));
    const completionInput = mocks.completeInlineGenerationRun.mock.calls.at(-1)?.[0];
    expect(completionInput.replyText).not.toContain("legacy.example.test");
  });

  it("finishes an active collector with one atomic intake completion", async () => {
    const completedCollector = {
      kind: "service_request",
      intent: "refund",
      stepIndex: 4,
      sourceChannel: "private_chat",
      startedAt: "2026-08-14T00:00:00.000Z",
      answers: {
        contact: "Ada · ada@example.test",
        goal: "Request a refund review",
        context: "Order order-1",
        timeline: "This week",
      },
    };
    mocks.readStructuredCollectorState.mockReturnValue({
      ...completedCollector,
      stepIndex: 3,
      answers: {
        contact: completedCollector.answers.contact,
        goal: completedCollector.answers.goal,
        context: completedCollector.answers.context,
      },
    });
    mocks.advanceStructuredCollector.mockReturnValue({
      completed: true,
      state: completedCollector,
    });
    mocks.formatStructuredCollectorSummary.mockReturnValue(
      "联系人：Ada · ada@example.test\n目标：Request a refund review",
    );

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.completeConversationIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-1",
        inputMessageId: "message-1",
        intent: "refund",
        collectorKind: "service_request",
      }),
    );
    expect(mocks.clearConversationCollectorState).not.toHaveBeenCalled();
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
    expect(mocks.recallRepresentativeContext).not.toHaveBeenCalled();
  });

  it("persists the next collector step without creating a service request", async () => {
    const nextCollector = {
      kind: "service_request",
      intent: "refund",
      stepIndex: 2,
      sourceChannel: "private_chat",
      startedAt: "2026-08-14T00:00:00.000Z",
      answers: { contact: "Ada", goal: "Refund review" },
    };
    mocks.readStructuredCollectorState.mockReturnValue({
      ...nextCollector,
      stepIndex: 1,
      answers: { contact: "Ada" },
    });
    mocks.advanceStructuredCollector.mockReturnValue({
      completed: false,
      state: nextCollector,
    });
    mocks.formatStructuredCollectorPrompt.mockReturnValue("第 3/4 步 · 背景与约束");

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "waiting_input",
    });

    expect(mocks.setConversationCollectorState).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      collectorState: nextCollector,
    });
    expect(mocks.completeConversationIntake).not.toHaveBeenCalled();
    expect(mocks.clearConversationCollectorState).not.toHaveBeenCalled();
  });

  it("completes the generation run when the user cancels an active collector", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-cancel",
      leaseAttempt: 1,
      runId: "run-cancel",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-cancel",
      contactId: "contact-1",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-cancel",
      userText: "取消",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.readStructuredCollectorState.mockReturnValue({
      kind: "service_request",
      intent: "refund",
      stepIndex: 2,
      sourceChannel: "private_chat",
      startedAt: "2026-08-14T00:00:00.000Z",
      answers: { contact: "Ada", goal: "Refund review" },
    });

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "run-cancel",
      status: "completed",
    });

    expect(mocks.clearConversationCollectorState).toHaveBeenCalledWith({
      conversationId: "conversation-cancel",
    });
    expect(mocks.advanceStructuredCollector).not.toHaveBeenCalled();
    expect(mocks.completeConversationIntake).not.toHaveBeenCalled();
  });

  it("lets the audience reject its pending approval with an idempotent cancel command", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-cancel-task",
      leaseAttempt: 1,
      runId: "run-cancel-task",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-cancel-task",
      contactId: "contact-1",
      audienceIdentityId: "audience-1",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-cancel-task",
      userText: "取消当前任务",
      channel: "web",
      usage: { freeRepliesUsed: 4, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.isConversationCancellationRequest.mockReturnValue(true);
    mocks.findConversationCancelableDelegationTask.mockResolvedValue({
      status: "cancelable",
      taskId: "task-1",
      pendingApprovalId: "approval-1",
    });
    mocks.createConversationPlan.mockReturnValue({
      goal: "perform_action",
      intent: "unknown",
      disposition: "answer",
      actions: [{
        id: "cancel_pending_action:unknown",
        kind: "cancel_pending_action",
        status: "planned",
        sideEffect: "internal_record",
      }],
      reasons: ["Cancellation requested."],
      responseOutline: [],
    });

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "run-cancel-task",
      status: "completed",
    });

    expect(mocks.resolveRepresentativeComputeApproval).toHaveBeenCalledWith({
      representativeSlug: "sktone",
      approvalId: "approval-1",
      resolution: "rejected",
      resolvedBy: "audience-1",
      decisionNote: expect.stringContaining("audience canceled"),
    });
    expect(mocks.applyRepresentativeDelegationTaskAction).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        countUsage: false,
        replyText: expect.stringContaining("已取消当前待处理任务"),
      }),
    );
  });

  it("records only the ledger item actually injected and cited by the model", async () => {
    const firstUri = "viking://resources/delegate/reps/sktone/knowledge/asset-1.md/asset-1.md";
    const secondUri = "viking://resources/delegate/reps/sktone/knowledge/asset-2.md/asset-2.md";
    mocks.recallRepresentativeContext.mockResolvedValue({
      items: [
        {
          uri: firstUri,
          contextType: "resource",
          layer: "L2",
          score: 0.95,
          abstract: "First searched candidate.",
          memoryUseItemId: "memory-use-item-1",
          internalSource: { sourceKind: "PUBLIC_KNOWLEDGE", memoryUseItemId: "memory-use-item-1" },
        },
        {
          uri: secondUri,
          contextType: "resource",
          layer: "L2",
          score: 0.9,
          abstract: "Second injected candidate.",
          memoryUseItemId: "memory-use-item-2",
          internalSource: { sourceKind: "PUBLIC_KNOWLEDGE", memoryUseItemId: "memory-use-item-2" },
        },
      ],
      citations: [],
      memoryUseRunId: "memory-use-run-1",
    });
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: true,
      replyText: "Answer grounded in the injected source.",
      provider: "openai",
      model: "test-model",
      citedMemoryUseItemIds: ["memory-use-item-2"],
      contextTrace: { selectedMemoryUseItemIds: ["memory-use-item-2"] },
    });

    await processNextConversationWork({ port: 4040, pollMs: 500 });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryUse: {
          runId: "memory-use-run-1",
          outcome: "completed",
          injectedItemIds: ["memory-use-item-2"],
          citedItemIds: ["memory-use-item-2"],
        },
      }),
    );
  });

  it("drops public recall items that are not bound to a generation UseRun", async () => {
    mocks.recallRepresentativeContext.mockResolvedValue({
      items: [{
        uri: "viking://resources/delegate/reps/sktone/versions/version-1/faq/index.md",
        contextType: "resource",
        layer: "L2",
        score: 0.95,
        abstract: "Orphaned public fact that must not reach the model.",
        memoryUseItemId: "orphaned-memory-use-item",
        internalSource: {
          sourceKind: "PUBLIC_KNOWLEDGE",
          memoryUseItemId: "orphaned-memory-use-item",
        },
      }],
      citations: [],
    });
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: true,
      replyText: "Answer without orphaned knowledge.",
      provider: "openai",
      model: "test-model",
      citedMemoryUseItemIds: [],
      contextTrace: { selectedMemoryUseItemIds: [] },
    });

    await processNextConversationWork({ port: 4040, pollMs: 500 });

    expect(mocks.generateRepresentativeReply).toHaveBeenCalledWith(
      expect.objectContaining({ recalled: [] }),
    );
    const completion = mocks.completeInlineGenerationRun.mock.calls[0]?.[0];
    expect(completion).not.toHaveProperty("memoryUse");
    expect(JSON.stringify(completion)).not.toContain("Orphaned public fact");
  });

  it("persists no citation when the token budget drops the recall segment", async () => {
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: true,
      replyText: "Answer without recalled context.",
      provider: "openai",
      model: "test-model",
      citedMemoryUseItemIds: [],
      contextTrace: { selectedMemoryUseItemIds: [] },
    });

    await processNextConversationWork({ port: 4040, pollMs: 500 });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      memoryUse: {
        runId: "memory-use-run-1",
        outcome: "completed",
        injectedItemIds: [],
        citedItemIds: [],
      },
    }));
  });

  it("does not use or cite recalled knowledge when model generation fails", async () => {
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: false,
      reason: "provider timed out with secret upstream details",
      state: "ready",
      citedMemoryUseItemIds: [],
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.renderGroundedKnowledgeFallbackWithTrace).not.toHaveBeenCalled();
    expect(mocks.renderFailClosedReplyPreview).toHaveBeenCalledWith(
      expect.any(Object),
      "佩奇当老师时发生了什么？",
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      replyText: "SAFE FAIL-CLOSED REPLY",
      memoryUse: {
        runId: "memory-use-run-1",
        outcome: "generation_failed",
      },
      runtimeOutcome: {
        mode: "fallback",
        fallbackStrategy: "deterministic_preview",
        modelRuntimeState: "ready",
        fallbackReason: "provider_failed",
      },
    }));
    expect(
      JSON.stringify(mocks.completeInlineGenerationRun.mock.calls[0]?.[0]),
    ).not.toContain("secret upstream details");
    expect(
      JSON.stringify(mocks.completeInlineGenerationRun.mock.calls[0]?.[0]),
    ).not.toContain("佩奇临时代课并带大家画恐龙");
    expect(mocks.completeInlineGenerationRun.mock.calls[0]?.[0]?.memoryUse).not.toHaveProperty(
      "injectedItemIds",
    );
    expect(mocks.completeInlineGenerationRun.mock.calls[0]?.[0]?.memoryUse).not.toHaveProperty(
      "citedItemIds",
    );
  });

  it("never attributes a fail-closed fallback to searched, injected, cited, or displayed sources", async () => {
    const firstUri = "viking://resources/delegate/reps/sktone/knowledge/asset-1.md/asset-1.md";
    const secondUri = "viking://resources/delegate/reps/sktone/knowledge/asset-2.md/asset-2.md";
    mocks.recallRepresentativeContext.mockResolvedValue({
      items: [
        {
          uri: firstUri,
          contextType: "resource",
          layer: "L2",
          score: 0.91,
          abstract: "Relevant fallback fact.",
          memoryUseItemId: "memory-use-item-1",
          internalSource: { sourceKind: "PUBLIC_KNOWLEDGE", memoryUseItemId: "memory-use-item-1" },
        },
        {
          uri: secondUri,
          contextType: "resource",
          layer: "L2",
          score: 0.99,
          abstract: "Unrelated searched fact.",
          memoryUseItemId: "memory-use-item-2",
          internalSource: { sourceKind: "PUBLIC_KNOWLEDGE", memoryUseItemId: "memory-use-item-2" },
        },
      ],
      citations: [],
      memoryUseRunId: "memory-use-run-1",
    });
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: false,
      reason: "provider unavailable",
      state: "ready",
      citedMemoryUseItemIds: [],
    });
    mocks.renderGroundedKnowledgeFallbackWithTrace.mockReturnValue({
      replyText: "Relevant fallback fact.",
      selectedRecallUris: [firstUri],
    });

    await processNextConversationWork({ port: 4040, pollMs: 500 });

    expect(mocks.renderGroundedKnowledgeFallbackWithTrace).not.toHaveBeenCalled();
    const completion = mocks.completeInlineGenerationRun.mock.calls[0]?.[0];
    expect(completion).toEqual(expect.objectContaining({
      replyText: "SAFE FAIL-CLOSED REPLY",
      memoryUse: {
        runId: "memory-use-run-1",
        outcome: "generation_failed",
      },
    }));
    expect(completion?.memoryUse).not.toHaveProperty("injectedItemIds");
    expect(completion?.memoryUse).not.toHaveProperty("citedItemIds");
    expect(completion).not.toHaveProperty("citations");
    expect(JSON.stringify(completion)).not.toContain("Relevant fallback fact.");
    expect(JSON.stringify(completion)).not.toContain("Unrelated searched fact.");
  });

  it("never echoes or cites contact memory through provider-failure fallback", async () => {
    mocks.recallRepresentativeContext.mockResolvedValue({
      items: [{
        uri: "viking://user/memories/delegate/memory-ns/contacts/contact-1/channels/web/memories/memory-1/versions/version-1.md",
        contextType: "memory",
        layer: "L2",
        score: 0.99,
        abstract: "Private unrelated preference.",
        content: "Private unrelated preference.",
        memoryUseItemId: "memory-use-contact-1",
        internalSource: {
          sourceKind: "CONTACT_MEMORY",
          memoryVersionId: "memory-version-1",
          projectionItemId: "projection-1",
          contentHash: "sha256-memory",
          memoryUseItemId: "memory-use-contact-1",
        },
      }],
      citations: [],
      memoryUseRunId: "memory-use-run-1",
    });
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: false,
      reason: "provider unavailable",
      state: "ready",
      citedMemoryUseItemIds: [],
    });
    mocks.renderGroundedKnowledgeFallbackWithTrace.mockReturnValue(null);

    await processNextConversationWork({ port: 4040, pollMs: 500 });

    const completion = mocks.completeInlineGenerationRun.mock.calls[0]?.[0];
    expect(completion).not.toHaveProperty("citations");
    expect(completion).toHaveProperty("memoryUse", {
      runId: "memory-use-run-1",
      outcome: "generation_failed",
    });
    expect(JSON.stringify(completion)).not.toContain("Private unrelated preference");
  });

  it("records a sanitized deterministic fallback when the model is unavailable", async () => {
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: false,
      reason: "missing key sk-do-not-persist",
      state: "missing_credentials",
    });
    mocks.renderGroundedKnowledgeFallbackWithTrace.mockReturnValue(null);

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        replyText: "SAFE FAIL-CLOSED REPLY",
        runtimeOutcome: {
          mode: "fallback",
          fallbackStrategy: "deterministic_preview",
          modelRuntimeState: "missing_credentials",
          fallbackReason: "model_unavailable",
        },
      }),
    );
    expect(
      JSON.stringify(mocks.completeInlineGenerationRun.mock.calls[0]?.[0]),
    ).not.toContain("sk-do-not-persist");
  });

  it("does not send a completed memory-backed answer after deletion fences its delivery retry", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const blocked = Object.assign(
      new Error("Generation delivery was canceled because an injected source is no longer authorized."),
      { code: "generation_memory_delivery_source_revoked" },
    );
    mocks.prepareGenerationMessageChannelDelivery.mockRejectedValueOnce(blocked);
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-memory-delivery-retry",
      leaseAttempt: 2,
      runId: "run-memory-delivery-retry",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-telegram-memory",
      contactId: "contact-telegram-memory",
      controlState: "WAITING_USER",
      inputMessageId: "message-inbound-memory",
      userText: "original inbound",
      channel: "telegram",
      externalConversationId: "123456",
      telegramConnectionId: "111111111",
      deliveryOnly: true,
      outputMessageId: "message-output-memory",
      outputText: "persisted personalized answer that must stay hidden",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
      telegramRequestTimeoutMs: 8_000,
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-memory-delivery-retry",
      status: "canceled",
    });

    expect(mocks.prepareGenerationMessageChannelDelivery).toHaveBeenCalledWith({
      conversationId: "conversation-telegram-memory",
      runId: "run-memory-delivery-retry",
      outboxId: "outbox-memory-delivery-retry",
      leaseAttempt: 2,
      outputMessageId: "message-output-memory",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.renderPrivateChannelGenerationDeliveryText).not.toHaveBeenCalled();
    expect(mocks.markGenerationDeliveryComplete).not.toHaveBeenCalled();
    expect(mocks.retryGenerationDelivery).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("retries only persisted delivery for a completed Telegram generation", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: { message_id: 90210 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.renderPrivateChannelGenerationDeliveryText.mockResolvedValueOnce(
      "persisted reply\n\n——\n来源说明：本回答未引用已授权知识或记忆，内容由通用模型生成。",
    );
    mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
      connectionId: "connection-a",
      botId: "111111111",
      username: "bot_a",
      displayName: "Bot A",
      token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
      credentialRevision: 1,
    });
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-delivery-retry",
      leaseAttempt: 2,
      runId: "run-delivery-retry",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-telegram",
      contactId: "contact-telegram",
      controlState: "WAITING_USER",
      inputMessageId: "message-inbound",
      userText: "original inbound",
      channel: "telegram",
      externalConversationId: "123456",
      telegramConnectionId: "111111111",
      deliveryOnly: true,
      outputMessageId: "message-output",
      outputText: "persisted reply",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });
    mocks.completeReadyConversationTurnPlanForGenerationRun.mockRejectedValueOnce(
      new Error("plan repair unavailable"),
    );

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramBotToken: "222222222:BBBBBBBBBBBBBBBBBBBBBBBB",
      telegramConversationPlatformMode: "worker",
      telegramRequestTimeoutMs: 8_000,
    })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.claimNextGenerationWorkItem).toHaveBeenCalledWith({
      telegramWorkerEnabled: true,
    });
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).not.toHaveBeenCalled();
    expect(
      mocks.resolveTelegramBotRuntimeCredential,
    ).toHaveBeenCalledWith({ connectionId: "111111111" });
    expect(
      mocks.withActiveTelegramRepresentativeChannelFence,
    ).toHaveBeenCalledWith(
      {
        conversationId: "conversation-telegram",
        expectedConnectionId: "111111111",
      },
      expect.any(Function),
    );
    expect(
      mocks.withGenerationMessageProviderDeliveryFence,
    ).toHaveBeenCalledWith(
      expect.anything(),
      {
        conversationId: "conversation-telegram",
        runId: "run-delivery-retry",
        outboxId: "outbox-delivery-retry",
        leaseAttempt: 2,
        outputMessageId: "message-output",
        deliveryAdmission: {
          attemptNumber: 1,
          leaseToken: "delivery-lease-1",
        },
      },
      expect.any(Function),
    );
    expect(mocks.admitGenerationMessageProviderDelivery).toHaveBeenCalledWith({
      conversationId: "conversation-telegram",
      runId: "run-delivery-retry",
      outboxId: "outbox-delivery-retry",
      leaseAttempt: 2,
      outputMessageId: "message-output",
      deliveryAdmission: {
        attemptNumber: 1,
        leaseToken: "delivery-lease-1",
      },
    });
    expect(
      mocks.admitGenerationMessageProviderDelivery.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.withGenerationMessageProviderDeliveryFence.mock
        .invocationCallOrder[0]!,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/bot111111111:AAAAAAAAAAAAAAAAAAAAAAAA/sendMessage",
      ),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        body: JSON.stringify({
          chat_id: "123456",
          text:
            "persisted reply\n\n——\n来源说明：本回答未引用已授权知识或记忆，内容由通用模型生成。",
        }),
      }),
    );
    expect(
      mocks.renderPrivateChannelGenerationDeliveryText,
    ).toHaveBeenCalledWith({
      generationRunId: "run-delivery-retry",
      outputMessageId: "message-output",
      text: "persisted reply",
    });
    expect(
      mocks.prepareGenerationMessageChannelDelivery,
    ).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-telegram",
      runId: "run-delivery-retry",
      outboxId: "outbox-delivery-retry",
      leaseAttempt: 2,
      outputMessageId: "message-output",
    }));
    expect(mocks.markGenerationDeliveryComplete).toHaveBeenCalledWith({
      runId: "run-delivery-retry",
      outboxId: "outbox-delivery-retry",
      leaseAttempt: 2,
      outputMessageId: "message-output",
      deliveryAdmission: {
        attemptNumber: 1,
        leaseToken: "delivery-lease-1",
      },
      externalMessageId: "90210",
    });
    expect(
      mocks.completeReadyConversationTurnPlanForGenerationRun,
    ).toHaveBeenCalledWith("run-delivery-retry");
    expect(mocks.retryGenerationDelivery).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "Delivered generation plan repair failed.",
      expect.any(Error),
    );
    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });

  it("uses the same persisted source footer boundary for Matrix delivery", async () => {
    mocks.renderPrivateChannelGenerationDeliveryText.mockResolvedValueOnce(
      "persisted Matrix reply\n\n——\n来源：代表经验",
    );
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-matrix-delivery",
      leaseAttempt: 1,
      runId: "run-matrix-delivery",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-matrix",
      contactId: "contact-matrix",
      controlState: "WAITING_USER",
      inputMessageId: "message-inbound-matrix",
      userText: "original inbound",
      channel: "matrix",
      externalConversationId: "!room:example.test",
      matrixSenderUserId: "@delegate:example.test",
      matrixEndpointLifecycleRevision: 7,
      deliveryOnly: true,
      outputMessageId: "message-output-matrix",
      outputText: "persisted Matrix reply",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      matrixHomeserverUrl: "https://matrix.example.test",
      matrixApplicationServiceToken: "as-token",
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-matrix-delivery",
      status: "completed",
    });

    expect(
      mocks.renderPrivateChannelGenerationDeliveryText,
    ).toHaveBeenCalledWith({
      generationRunId: "run-matrix-delivery",
      outputMessageId: "message-output-matrix",
      text: "persisted Matrix reply",
    });
    expect(mocks.sendMatrixRepresentativeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-matrix",
        roomId: "!room:example.test",
        generationRunId: "run-matrix-delivery",
        generationDelivery: {
          runId: "run-matrix-delivery",
          outboxId: "outbox-matrix-delivery",
          leaseAttempt: 1,
          outputMessageId: "message-output-matrix",
          deliveryAdmission: {
            attemptNumber: 1,
            leaseToken: "delivery-lease-1",
          },
        },
        text: "persisted Matrix reply\n\n——\n来源：代表经验",
      }),
    );
    expect(mocks.admitGenerationMessageProviderDelivery).toHaveBeenCalledWith({
      conversationId: "conversation-matrix",
      runId: "run-matrix-delivery",
      outboxId: "outbox-matrix-delivery",
      leaseAttempt: 1,
      outputMessageId: "message-output-matrix",
      deliveryAdmission: {
        attemptNumber: 1,
        leaseToken: "delivery-lease-1",
      },
    });
    expect(
      mocks.admitGenerationMessageProviderDelivery.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.sendMatrixRepresentativeMessage.mock.invocationCallOrder[0]!,
    );
    expect(mocks.markGenerationDeliveryComplete).toHaveBeenCalledWith({
      runId: "run-matrix-delivery",
      outboxId: "outbox-matrix-delivery",
      leaseAttempt: 1,
      outputMessageId: "message-output-matrix",
      deliveryAdmission: {
        attemptNumber: 1,
        leaseToken: "delivery-lease-1",
      },
      externalMessageId: "$matrix-event-1",
    });
  });

  it("never automatically resends a Matrix delivery whose provider outcome is unknown", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-matrix-unknown",
      leaseAttempt: 1,
      runId: "run-matrix-unknown",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-matrix-unknown",
      contactId: "contact-matrix",
      controlState: "WAITING_USER",
      inputMessageId: "message-inbound-matrix",
      userText: "original inbound",
      channel: "matrix",
      externalConversationId: "!room:example.test",
      matrixSenderUserId: "@delegate:example.test",
      matrixEndpointLifecycleRevision: 7,
      deliveryOnly: true,
      outputMessageId: "message-output-matrix-unknown",
      outputText: "persisted Matrix reply",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });
    mocks.sendMatrixRepresentativeMessage.mockRejectedValueOnce(
      Object.assign(new Error("Matrix outcome unknown"), {
        code: "matrix_provider_outcome_unknown",
      }),
    );

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      matrixHomeserverUrl: "https://matrix.example.test",
      matrixApplicationServiceToken: "as-token",
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-matrix-unknown",
      status: "failed",
    });

    expect(mocks.retryGenerationDelivery).toHaveBeenCalledWith({
      runId: "run-matrix-unknown",
      outboxId: "outbox-matrix-unknown",
      leaseAttempt: 1,
      outputMessageId: "message-output-matrix-unknown",
      errorMessage: "Matrix outcome unknown",
      providerOutcomeUnknown: true,
      providerOutcomeCode: "matrix_provider_outcome_unknown",
    });
    expect(mocks.markGenerationDeliveryComplete).not.toHaveBeenCalled();
  });

  it.each(["matrix", "telegram"] as const)(
    "sends only a fixed fail-closed notice when %s source verification throws",
    async (channel) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_id: 90211 },
        }),
      });
      vi.stubGlobal("fetch", fetchMock);
      mocks.renderPrivateChannelGenerationDeliveryText.mockRejectedValueOnce(
        new Error("source verification unavailable"),
      );
      if (channel === "telegram") {
        mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
          connectionId: "connection-a",
          botId: "111111111",
          username: "bot_a",
          displayName: "Bot A",
          token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
          credentialRevision: 1,
        });
      }
      mocks.claimNextGenerationWorkItem.mockResolvedValue({
        outboxId: `outbox-${channel}-source-failure`,
        leaseAttempt: 1,
        runId: `run-${channel}-source-failure`,
        representativeVersionId: "version-1",
        representativeSlug: "sktone",
        representativeName: "SKTone",
        conversationId: `conversation-${channel}-source-failure`,
        contactId: `contact-${channel}`,
        controlState: "WAITING_USER",
        inputMessageId: `message-inbound-${channel}`,
        userText: "original inbound",
        channel,
        externalConversationId: channel === "matrix"
          ? "!room:example.test"
          : "123456",
        ...(channel === "matrix"
          ? {
              matrixSenderUserId: "@delegate:example.test",
              matrixEndpointLifecycleRevision: 7,
            }
          : { telegramConnectionId: "connection-a" }),
        deliveryOnly: true,
        outputMessageId: `message-output-${channel}`,
        outputText: "UNVERIFIED ANSWER MUST NOT BE SENT",
        usage: {
          freeRepliesUsed: 4,
          passUnlocked: true,
          deepHelpUnlocked: false,
        },
      });

      await expect(processNextConversationWork({
        port: 4040,
        pollMs: 500,
        matrixHomeserverUrl: "https://matrix.example.test",
        matrixApplicationServiceToken: "as-token",
        telegramConversationPlatformMode: "worker",
        telegramRequestTimeoutMs: 8_000,
      })).resolves.toMatchObject({
        processed: true,
        status: "completed",
      });

      if (channel === "matrix") {
        expect(mocks.sendMatrixRepresentativeMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            text: mocks.privateChannelSourceVerificationUnavailableStatement,
          }),
        );
      } else {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: JSON.stringify({
              chat_id: "123456",
              text: mocks.privateChannelSourceVerificationUnavailableStatement,
            }),
          }),
        );
      }
      expect(JSON.stringify([
        ...mocks.sendMatrixRepresentativeMessage.mock.calls,
        ...fetchMock.mock.calls,
      ])).not.toContain("UNVERIFIED ANSWER MUST NOT BE SENT");
      expect(mocks.retryGenerationDelivery).not.toHaveBeenCalled();
      expect(mocks.markGenerationDeliveryComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: `run-${channel}-source-failure`,
          outputMessageId: `message-output-${channel}`,
        }),
      );
      vi.unstubAllGlobals();
    },
  );

  it("does not call Telegram after the final assignment-epoch fence closes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.withActiveTelegramRepresentativeChannelFence
      .mockResolvedValueOnce({
        executed: false,
        reason: "telegram_channel_not_active",
      });
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-old-telegram-epoch",
      leaseAttempt: 2,
      runId: "run-old-telegram-epoch",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-old-telegram-epoch",
      contactId: "contact-telegram",
      controlState: "WAITING_USER",
      inputMessageId: "message-inbound",
      userText: "original inbound",
      channel: "telegram",
      externalConversationId: "123456",
      telegramConnectionId: "111111111",
      deliveryOnly: true,
      outputMessageId: "message-output",
      outputText: "stale reply",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
      telegramRequestTimeoutMs: 8_000,
    })).resolves.toMatchObject({
      processed: true,
      status: "failed",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      mocks.resolveTelegramBotRuntimeCredential,
    ).not.toHaveBeenCalled();
    expect(mocks.retryGenerationDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-old-telegram-epoch",
        outputMessageId: "message-output",
        errorMessage:
          "Telegram channel assignment changed before outbound delivery.",
      }),
    );
    expect(
      mocks.markGenerationDeliveryComplete,
    ).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not call Telegram after the provider memory fence cancels delivery", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
      connectionId: "111111111",
      botId: "111111111",
      username: "bot_a",
      displayName: "Bot A",
      token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
      credentialRevision: 1,
    });
    mocks.withGenerationMessageProviderDeliveryFence.mockResolvedValueOnce({
      executed: false,
      reason: "memory_delivery_source_revoked",
    });
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-forgotten-telegram",
      leaseAttempt: 3,
      runId: "run-forgotten-telegram",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-forgotten-telegram",
      contactId: "contact-telegram",
      controlState: "WAITING_USER",
      inputMessageId: "message-inbound",
      userText: "original inbound",
      channel: "telegram",
      externalConversationId: "123456",
      telegramConnectionId: "111111111",
      deliveryOnly: true,
      outputMessageId: "message-output",
      outputText: "stale personalized reply",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
      telegramRequestTimeoutMs: 8_000,
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-forgotten-telegram",
      status: "canceled",
    });

    expect(
      mocks.withGenerationMessageProviderDeliveryFence,
    ).toHaveBeenCalledWith(
      expect.anything(),
      {
        conversationId: "conversation-forgotten-telegram",
        runId: "run-forgotten-telegram",
        outboxId: "outbox-forgotten-telegram",
        leaseAttempt: 3,
        outputMessageId: "message-output",
        deliveryAdmission: {
          attemptNumber: 1,
          leaseToken: "delivery-lease-1",
        },
      },
      expect.any(Function),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.markGenerationDeliveryComplete).not.toHaveBeenCalled();
    expect(mocks.retryGenerationDelivery).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("never falls back to the legacy token when a managed Bot credential is unavailable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.hasPersistedTelegramBotConnections.mockResolvedValueOnce(true);
    mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce(null);
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-managed-credential-unavailable",
      leaseAttempt: 1,
      runId: "run-managed-credential-unavailable",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-managed-credential-unavailable",
      contactId: "contact-managed-credential-unavailable",
      controlState: "WAITING_USER",
      inputMessageId: "message-inbound",
      userText: "original inbound",
      channel: "telegram",
      externalConversationId: "123456",
      telegramConnectionId: "111111111",
      deliveryOnly: true,
      outputMessageId: "message-output",
      outputText: "persisted reply",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramBotToken: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
      telegramConversationPlatformMode: "worker",
      telegramRequestTimeoutMs: 8_000,
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-managed-credential-unavailable",
      status: "failed",
      error:
        "Telegram Bot credential is unavailable for this conversation.",
    });

    expect(
      mocks.resolveTelegramBotRuntimeCredential,
    ).toHaveBeenCalledWith({ connectionId: "111111111" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.retryGenerationDelivery).toHaveBeenCalledWith({
      runId: "run-managed-credential-unavailable",
      outboxId: "outbox-managed-credential-unavailable",
      leaseAttempt: 1,
      outputMessageId: "message-output",
      errorMessage:
        "Telegram Bot credential is unavailable for this conversation.",
    });
    vi.unstubAllGlobals();
  });

  it.each([
    {
      failure: "network timeout",
      fetchProvider: () => Promise.reject(new Error("timeout")),
    },
    {
      failure: "accepted response without a message id",
      fetchProvider: () => Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: {} }),
      }),
    },
  ])("dead-letters an unknown Telegram generation outcome after $failure", async ({
    fetchProvider,
  }) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(fetchProvider));
    mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
      connectionId: "111111111",
      botId: "111111111",
      username: "bot_a",
      displayName: "Bot A",
      token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
      credentialRevision: 1,
    });
    mocks.claimNextGenerationWorkItem.mockResolvedValueOnce({
      outboxId: "outbox-telegram-unknown",
      leaseAttempt: 1,
      runId: "run-telegram-unknown",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-telegram-unknown",
      contactId: "contact-telegram",
      controlState: "WAITING_USER",
      inputMessageId: "message-inbound",
      userText: "original inbound",
      channel: "telegram",
      externalConversationId: "123456",
      telegramConnectionId: "111111111",
      deliveryOnly: true,
      outputMessageId: "message-output",
      outputText: "persisted reply",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-telegram-unknown",
      status: "failed",
      error: expect.stringContaining("outcome is unknown"),
    });

    expect(mocks.retryGenerationDelivery).toHaveBeenCalledWith({
      runId: "run-telegram-unknown",
      outboxId: "outbox-telegram-unknown",
      leaseAttempt: 1,
      outputMessageId: "message-output",
      errorMessage: expect.stringContaining("outcome is unknown"),
      providerOutcomeUnknown: true,
      providerOutcomeCode: "telegram_provider_outcome_unknown",
    });
  });

  it("recovers a terminal Telegram delegation without rerunning setup, model, or compute", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: { message_id: 90211 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const attachments = [{
      fileName: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 42,
      artifactId: "artifact-recovery",
      url: "/reps/sktone/chat/artifacts/artifact-recovery/download",
    }];
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-terminal-recovery",
      leaseAttempt: 2,
      runId: "run-terminal-recovery",
      delegationTaskId: "task-terminal-recovery",
      delegationTaskStepId: "step-terminal-recovery",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-terminal-recovery",
      contactId: "contact-terminal-recovery",
      controlState: "AI_QUEUED",
      inputMessageId: "message-terminal-recovery",
      userText: "生成一份报告",
      channel: "telegram",
      externalConversationId: "654321",
      telegramConnectionId: "111111111",
      delegationTerminalRecovery: {
        taskStatus: "COMPLETED",
        stepStatus: "COMPLETED",
        attachments,
      },
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });
    mocks.completeInlineGenerationRun.mockResolvedValueOnce({
      message: { id: "message-terminal-recovery-output" },
    });

    try {
      await expect(processNextConversationWork({
        port: 4040,
        pollMs: 500,
        telegramBotToken: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
        telegramConversationPlatformMode: "worker",
        telegramRequestTimeoutMs: 8_000,
      })).resolves.toMatchObject({
        processed: true,
        runId: "run-terminal-recovery",
        status: "completed",
      });

      expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith({
        conversationId: "conversation-terminal-recovery",
        runId: "run-terminal-recovery",
        outboxId: "outbox-terminal-recovery",
        leaseAttempt: 2,
        replyText: expect.stringContaining("委托任务已在隔离沙盒中执行完成"),
        senderDisplayName: "SKTone",
        intent: "delegation_terminal_recovery",
        completeOutbox: false,
        countUsage: false,
        keepConversationQueued: false,
        attachments,
      });
      expect(
        mocks.prepareGenerationMessageChannelDelivery,
      ).toHaveBeenCalledWith({
        conversationId: "conversation-terminal-recovery",
        runId: "run-terminal-recovery",
        outboxId: "outbox-terminal-recovery",
        leaseAttempt: 2,
        outputMessageId: "message-terminal-recovery-output",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/sendMessage"),
        expect.objectContaining({
          body: expect.stringContaining("report.txt"),
        }),
      );
      expect(fetchMock.mock.calls[0]?.[1]?.body).toContain(
        "\"chat_id\":\"654321\"",
      );
      expect(mocks.markGenerationDeliveryComplete).toHaveBeenCalledWith({
        runId: "run-terminal-recovery",
        outboxId: "outbox-terminal-recovery",
        leaseAttempt: 2,
        outputMessageId: "message-terminal-recovery-output",
        deliveryAdmission: {
          attemptNumber: 1,
          leaseToken: "delivery-lease-1",
        },
        externalMessageId: "90211",
      });
      expect(mocks.getRepresentativeRuntimeSetupSnapshot).not.toHaveBeenCalled();
      expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
      expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
      expect(mocks.executeAudienceTool).not.toHaveBeenCalled();
      expect(mocks.finalizeComputeDelegationTask).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the conversation queued when recovering a completed step with more work", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-step-recovery",
      leaseAttempt: 3,
      runId: "run-step-recovery",
      delegationTaskId: "task-step-recovery",
      delegationTaskStepId: "step-step-recovery",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-step-recovery",
      contactId: "contact-step-recovery",
      controlState: "AI_QUEUED",
      inputMessageId: "message-step-recovery",
      userText: "继续执行下一步",
      channel: "web",
      delegationTerminalRecovery: {
        taskStatus: "READY",
        stepStatus: "COMPLETED",
        attachments: [],
      },
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });
    mocks.completeInlineGenerationRun.mockResolvedValueOnce({
      message: { id: "message-step-recovery-output" },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-step-recovery",
      status: "step_completed",
    });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith({
      conversationId: "conversation-step-recovery",
      runId: "run-step-recovery",
      outboxId: "outbox-step-recovery",
      leaseAttempt: 3,
      replyText: expect.stringContaining("后续步骤已进入执行队列"),
      senderDisplayName: "SKTone",
      intent: "delegation_terminal_recovery",
      completeOutbox: false,
      countUsage: false,
      keepConversationQueued: true,
    });
    expect(
      mocks.prepareGenerationMessageChannelDelivery,
    ).toHaveBeenCalledWith({
      conversationId: "conversation-step-recovery",
      runId: "run-step-recovery",
      outboxId: "outbox-step-recovery",
      leaseAttempt: 3,
      outputMessageId: "message-step-recovery-output",
    });
    expect(mocks.markGenerationDeliveryComplete).toHaveBeenCalledWith({
      runId: "run-step-recovery",
      outboxId: "outbox-step-recovery",
      leaseAttempt: 3,
      outputMessageId: "message-step-recovery-output",
      deliveryAdmission: {
        attemptNumber: 1,
        leaseToken: "delivery-lease-1",
      },
    });
    expect(mocks.getRepresentativeRuntimeSetupSnapshot).not.toHaveBeenCalled();
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
    expect(mocks.executeAudienceTool).not.toHaveBeenCalled();
    expect(mocks.finalizeComputeDelegationTask).not.toHaveBeenCalled();
  });

  it("does not claim Telegram generation ownership outside worker mode", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue(null);

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "shadow",
    })).resolves.toEqual({ processed: false });

    expect(mocks.claimNextGenerationWorkItem).toHaveBeenCalledWith({
      telegramWorkerEnabled: false,
    });
    expect(mocks.claimNextOperatorMessageWorkItem).toHaveBeenCalledWith({
      telegramWorkerEnabled: false,
    });
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
    expect(
      mocks.prepareGenerationMessageChannelDelivery,
    ).not.toHaveBeenCalled();
  });

  it("defers an operator message paused by channel policy without consuming retries", async () => {
    mocks.claimNextOperatorMessageWorkItem.mockResolvedValue({
      outboxId: "operator-outbox-paused",
      messageId: "operator-message-paused",
      conversationId: "conversation-paused",
      text: "operator reply",
      operatorName: "Owner",
      channel: "telegram",
      externalConversationId: "123456",
    });
    const paused = Object.assign(
      new Error("Channel is unavailable: channel_paused."),
      {
        name: "ChannelUnavailableError",
        code: "channel_paused",
      },
    );
    mocks.assertConversationChannelDeliveryAvailable.mockRejectedValue(paused);

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
      telegramBotToken: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
    })).resolves.toMatchObject({
      processed: true,
      runId: "operator-message-paused",
      status: "deferred",
    });

    expect(mocks.deferOperatorMessageDelivery).toHaveBeenCalledWith({
      outboxId: "operator-outbox-paused",
      leaseAttempt: 1,
      messageId: "operator-message-paused",
      reason: "channel_paused",
    });
    expect(mocks.retryOperatorMessageDelivery).not.toHaveBeenCalled();
    expect(mocks.claimNextGenerationWorkItem).not.toHaveBeenCalled();
  });

  it("dead-letters an unknown Telegram operator outcome without automatic retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
      connectionId: "111111111",
      botId: "111111111",
      username: "bot_a",
      displayName: "Bot A",
      token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
      credentialRevision: 1,
    });
    mocks.claimNextOperatorMessageWorkItem.mockResolvedValueOnce({
      outboxId: "operator-outbox-unknown",
      messageId: "operator-message-unknown",
      conversationId: "conversation-operator-unknown",
      text: "operator reply",
      operatorName: "Owner",
      channel: "telegram",
      externalConversationId: "123456",
      telegramConnectionId: "111111111",
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
    })).resolves.toMatchObject({
      processed: true,
      runId: "operator-message-unknown",
      status: "failed",
      error: expect.stringContaining("outcome is unknown"),
    });

    expect(mocks.retryOperatorMessageDelivery).toHaveBeenCalledWith({
      outboxId: "operator-outbox-unknown",
      leaseAttempt: 1,
      messageId: "operator-message-unknown",
      errorMessage: expect.stringContaining("outcome is unknown"),
      providerOutcomeUnknown: true,
      providerOutcomeCode: "telegram_provider_outcome_unknown",
    });
  });

  it("delivers an operator reply with the conversation's Telegram Bot credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: { message_id: 90212 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
      connectionId: "connection-a",
      botId: "111111111",
      username: "bot_a",
      displayName: "Bot A",
      token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
      credentialRevision: 1,
    });
    mocks.claimNextOperatorMessageWorkItem.mockResolvedValue({
      outboxId: "operator-outbox-telegram-a",
      messageId: "operator-message-telegram-a",
      conversationId: "conversation-telegram-a",
      text: "operator reply",
      operatorName: "Owner",
      channel: "telegram",
      externalConversationId: "123456",
      telegramConnectionId: "connection-a",
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
      telegramBotToken: "222222222:BBBBBBBBBBBBBBBBBBBBBBBB",
      telegramRequestTimeoutMs: 8_000,
    })).resolves.toMatchObject({
      processed: true,
      runId: "operator-message-telegram-a",
      status: "completed",
    });

    expect(
      mocks.resolveTelegramBotRuntimeCredential,
    ).toHaveBeenCalledWith({ connectionId: "connection-a" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/bot111111111:AAAAAAAAAAAAAAAAAAAAAAAA/sendMessage",
      ),
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123456",
          text: "Owner: operator reply",
        }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining(
        "/bot222222222:BBBBBBBBBBBBBBBBBBBBBBBB/sendMessage",
      ),
      expect.anything(),
    );
    expect(mocks.completeOperatorMessageDelivery).toHaveBeenCalledWith({
      outboxId: "operator-outbox-telegram-a",
      leaseAttempt: 1,
      messageId: "operator-message-telegram-a",
      externalMessageId: "90212",
    });
    expect(mocks.claimNextGenerationWorkItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("honors a pinned FREE run even if the mutable setup limit is exhausted", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-free-policy",
      leaseAttempt: 1,
      runId: "run-free-policy",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-free-policy",
      contactId: "contact-free-policy",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-free-policy",
      userText: "继续免费回答",
      channel: "web",
      accessMode: "FREE",
      effectiveFreeReplyLimit: null,
      usage: {
        freeRepliesUsed: 40,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 1 },
    });

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.authorizeGenerationRunFreeUsage).not.toHaveBeenCalled();
    expect(mocks.createConversationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: {
          freeRepliesUsed: 40,
          passUnlocked: true,
          deepHelpUnlocked: false,
        },
      }),
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({ countUsage: true }),
    );
  });

  it("uses the pinned CREDITS_ONLY policy after setup changes", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-credits-policy",
      leaseAttempt: 1,
      runId: "run-credits-policy",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-credits-policy",
      contactId: "contact-credits-policy",
      audienceIdentityId: "audience-credits-policy",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-credits-policy",
      userText: "第一条也需要额度",
      channel: "web",
      accessMode: "CREDITS_ONLY",
      effectiveFreeReplyLimit: 0,
      usage: {
        freeRepliesUsed: 0,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 100 },
    });
    mocks.createConversationPlan.mockImplementation((input: {
      representative: { contract: { freeReplyLimit: number } };
      usage: {
        freeRepliesUsed: number;
        passUnlocked: boolean;
        deepHelpUnlocked: boolean;
      };
    }) => ({
      intent: "faq",
      disposition:
        input.usage.freeRepliesUsed
          >= input.representative.contract.freeReplyLimit
        && !input.usage.passUnlocked
          ? "payment_required"
          : "answer",
    }));

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.authorizeGenerationRunFreeUsage).not.toHaveBeenCalled();
    expect(mocks.reserveGenerationConversationWalletUsage).toHaveBeenCalledWith({
      runId: "run-credits-policy",
      outboxId: "outbox-credits-policy",
      leaseAttempt: 1,
      audienceIdentityId: "audience-credits-policy",
      representativeId: "rep-1",
      tokenAmount: 1,
    });
    expect(mocks.createConversationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        representative: expect.objectContaining({
          contract: { freeReplyLimit: 0 },
        }),
        usage: {
          freeRepliesUsed: 0,
          passUnlocked: false,
          deepHelpUnlocked: false,
        },
      }),
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({ countUsage: false }),
    );
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      channel: "matrix" as const,
      externalConversationId: "!paid-room:example.test",
      matrixSenderUserId: "@delegate:example.test",
      matrixEndpointLifecycleRevision: 4,
    },
    {
      channel: "telegram" as const,
      externalConversationId: "987654321",
      telegramConnectionId: "111111111",
    },
  ])(
    "reserves a current service-package credit for $channel",
    async (fixture) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 731 } }),
      });
      vi.stubGlobal("fetch", fetchMock);
      if (fixture.channel === "telegram") {
        mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
          connectionId: "111111111",
          botId: "111111111",
          username: "paid_bot",
          displayName: "Paid Bot",
          token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
          credentialRevision: 1,
        });
      }
      mocks.claimNextGenerationWorkItem.mockResolvedValue({
        outboxId: `outbox-package-${fixture.channel}`,
        leaseAttempt: 1,
        runId: `run-package-${fixture.channel}`,
        representativeVersionId: "version-1",
        representativeSlug: "sktone",
        representativeName: "SKTone",
        conversationId: `conversation-package-${fixture.channel}`,
        contactId: `contact-package-${fixture.channel}`,
        audienceIdentityId: "audience-package-1",
        controlState: "AI_ACTIVE",
        inputMessageId: `message-package-${fixture.channel}`,
        userText: "使用我购买的服务套餐继续回答",
        channel: fixture.channel,
        accessMode: "CREDITS_ONLY",
        effectiveFreeReplyLimit: 0,
        externalConversationId: fixture.externalConversationId,
        ...(fixture.channel === "matrix"
          ? {
              matrixSenderUserId: fixture.matrixSenderUserId,
              matrixEndpointLifecycleRevision:
                fixture.matrixEndpointLifecycleRevision,
            }
          : { telegramConnectionId: fixture.telegramConnectionId }),
        usage: {
          freeRepliesUsed: 0,
          passUnlocked: false,
          deepHelpUnlocked: false,
        },
      });
      mocks.reserveGenerationConversationWalletUsage.mockResolvedValueOnce({
        usageChargeId: `usage-package-${fixture.channel}`,
        tokenAmount: 1,
      });

      const result = await processNextConversationWork({
        port: 4040,
        pollMs: 500,
        telegramConversationPlatformMode: "worker",
        matrixHomeserverUrl: "https://matrix.example.test",
        matrixApplicationServiceToken: "as-token",
      });
      expect(result).toEqual({
        processed: true,
        runId: `run-package-${fixture.channel}`,
        status: "completed",
      });

      expect(
        mocks.reserveGenerationConversationWalletUsage,
      ).toHaveBeenCalledWith({
        runId: `run-package-${fixture.channel}`,
        outboxId: `outbox-package-${fixture.channel}`,
        leaseAttempt: 1,
        audienceIdentityId: "audience-package-1",
        representativeId: "rep-1",
        tokenAmount: 1,
      });
      expect(mocks.createConversationPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          usage: expect.objectContaining({ passUnlocked: true }),
        }),
      );
      expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
        expect.objectContaining({ countUsage: true }),
      );
    },
  );

  it.each([
    {
      channel: "matrix" as const,
      externalConversationId: "!empty-room:example.test",
      matrixSenderUserId: "@delegate:example.test",
      matrixEndpointLifecycleRevision: 5,
    },
    {
      channel: "telegram" as const,
      externalConversationId: "123123123",
      telegramConnectionId: "111111111",
    },
  ])(
    "sends a current service-package payment prompt when $channel has no balance",
    async (fixture) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 732 } }),
      }));
      if (fixture.channel === "telegram") {
        mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
          connectionId: "111111111",
          botId: "111111111",
          token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
        });
      }
      mocks.claimNextGenerationWorkItem.mockResolvedValue({
        outboxId: `outbox-empty-${fixture.channel}`,
        leaseAttempt: 1,
        runId: `run-empty-${fixture.channel}`,
        representativeVersionId: "version-1",
        representativeSlug: "sktone",
        representativeName: "SKTone",
        conversationId: `conversation-empty-${fixture.channel}`,
        contactId: `contact-empty-${fixture.channel}`,
        audienceIdentityId: "audience-empty-1",
        controlState: "AI_ACTIVE",
        inputMessageId: `message-empty-${fixture.channel}`,
        userText: "继续回答",
        channel: fixture.channel,
        accessMode: "CREDITS_ONLY",
        effectiveFreeReplyLimit: 0,
        externalConversationId: fixture.externalConversationId,
        ...(fixture.channel === "matrix"
          ? {
              matrixSenderUserId: fixture.matrixSenderUserId,
              matrixEndpointLifecycleRevision:
                fixture.matrixEndpointLifecycleRevision,
            }
          : { telegramConnectionId: fixture.telegramConnectionId }),
        usage: {
          freeRepliesUsed: 0,
          passUnlocked: false,
          deepHelpUnlocked: false,
        },
      });
      mocks.createConversationPlan.mockReturnValue({
        intent: "faq",
        disposition: "payment_required",
      });

      await expect(processNextConversationWork({
        port: 4040,
        pollMs: 500,
        telegramConversationPlatformMode: "worker",
        matrixHomeserverUrl: "https://matrix.example.test",
        matrixApplicationServiceToken: "as-token",
      })).resolves.toMatchObject({
        processed: true,
        status: "completed",
      });

      expect(
        mocks.reserveGenerationConversationWalletUsage,
      ).toHaveBeenCalledTimes(1);
      expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
      expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
        expect.objectContaining({
          replyText: expect.stringContaining("充值或购买服务套餐"),
          countUsage: false,
        }),
      );
    },
  );

  it("reserves and atomically consumes a service-package credit after free replies are exhausted", async () => {
    const reservation = {
      usageChargeId: "usage-charge-1",
      tokenAmount: 1,
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-1",
      leaseAttempt: 1,
      runId: "run-1",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-1",
      contactId: "contact-1",
      audienceIdentityId: "audience-1",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-1",
      userText: "继续回答",
      channel: "web",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(reservation);

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.reserveGenerationConversationWalletUsage).toHaveBeenCalledWith({
      runId: "run-1",
      outboxId: "outbox-1",
      leaseAttempt: 1,
      audienceIdentityId: "audience-1",
      representativeId: "rep-1",
      tokenAmount: 1,
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        countUsage: true,
      }),
    );
  });

  it("reserves a service-package credit when another channel run claims the last free slot", async () => {
    const reservation = {
      usageChargeId: "usage-charge-free-race",
      tokenAmount: 1,
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-1",
      leaseAttempt: 1,
      runId: "run-1",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-1",
      contactId: "contact-1",
      audienceIdentityId: "audience-1",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-1",
      userText: "继续回答",
      channel: "web",
      usage: {
        freeRepliesUsed: 3,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });
    mocks.authorizeGenerationRunFreeUsage.mockResolvedValue(false);
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(
      reservation,
    );

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.authorizeGenerationRunFreeUsage).toHaveBeenCalledWith({
      runId: "run-1",
      outboxId: "outbox-1",
      leaseAttempt: 1,
      freeReplyLimit: 4,
    });
    expect(mocks.reserveGenerationConversationWalletUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        audienceIdentityId: "audience-1",
        tokenAmount: 1,
      }),
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        countUsage: true,
      }),
    );
  });

  it("offers a paid unlock without model generation when the last free slot was claimed elsewhere", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-free-race",
      leaseAttempt: 1,
      runId: "run-free-race",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-free-race",
      contactId: "contact-free-race",
      audienceIdentityId: "audience-free-race",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-free-race",
      userText: "继续回答",
      channel: "web",
      usage: {
        freeRepliesUsed: 3,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });
    mocks.authorizeGenerationRunFreeUsage.mockResolvedValue(false);
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(null);
    mocks.createConversationPlan.mockImplementation((input: {
      usage: {
        freeRepliesUsed: number;
        passUnlocked: boolean;
        deepHelpUnlocked: boolean;
      };
    }) => ({
      intent: "faq",
      disposition:
        input.usage.freeRepliesUsed >= 4
        && !input.usage.passUnlocked
        && !input.usage.deepHelpUnlocked
          ? "payment_required"
          : "answer",
    }));

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.createConversationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: {
          freeRepliesUsed: 4,
          passUnlocked: false,
          deepHelpUnlocked: false,
        },
      }),
    );
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        countUsage: false,
        intent: "faq",
      }),
    );
  });

  it("blocks an over-limit natural-language compute request before invoking the planner", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-over-limit-planner",
      leaseAttempt: 1,
      runId: "run-over-limit-planner",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-over-limit-planner",
      contactId: "contact-over-limit-planner",
      audienceIdentityId: "audience-over-limit-planner",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-over-limit-planner",
      userText: "帮我生成一份报告文件",
      channel: "web",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(true);

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.reserveGenerationConversationWalletUsage).toHaveBeenCalledWith({
      runId: "run-over-limit-planner",
      outboxId: "outbox-over-limit-planner",
      leaseAttempt: 1,
      audienceIdentityId: "audience-over-limit-planner",
      representativeId: "rep-1",
      tokenAmount: 1,
    });
    expect(mocks.planNaturalLanguageComputeRequest).not.toHaveBeenCalled();
    expect(mocks.createClarifyingDelegationTask).not.toHaveBeenCalled();
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        countUsage: false,
        intent: "delegation_payment_required",
        replyText: expect.stringContaining("免费额度已用完"),
      }),
    );
  });

  it("stops before generation when fenced service-credit reservation loses its lease", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-stale-reserve",
      leaseAttempt: 1,
      runId: "run-stale-reserve",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-stale-reserve",
      contactId: "contact-stale-reserve",
      audienceIdentityId: "audience-stale-reserve",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-stale-reserve",
      userText: "继续回答",
      channel: "web",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });
    mocks.reserveGenerationConversationWalletUsage.mockRejectedValue(
      new GenerationWorkLeaseLostError("outbox-stale-reserve", 1),
    );

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "run-stale-reserve",
      status: "lease_lost",
    });

    expect(mocks.reserveGenerationConversationWalletUsage).toHaveBeenCalledWith({
      runId: "run-stale-reserve",
      outboxId: "outbox-stale-reserve",
      leaseAttempt: 1,
      audienceIdentityId: "audience-stale-reserve",
      representativeId: "rep-1",
      tokenAmount: 1,
    });
    expect(mocks.completeInlineGenerationRun).not.toHaveBeenCalled();
    expect(mocks.failGenerationRun).not.toHaveBeenCalled();
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
  });

  it("leaves a reserved service credit for fenced terminal cleanup when generation fails", async () => {
    const reservation = {
      usageChargeId: "usage-terminal-1",
      tokenAmount: 1,
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-terminal-entitlement",
      leaseAttempt: 1,
      runId: "run-terminal-entitlement",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-terminal-entitlement",
      contactId: "contact-terminal-entitlement",
      audienceIdentityId: "audience-terminal-1",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-terminal-entitlement",
      userText: "继续回答",
      channel: "web",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(reservation);
    mocks.generateRepresentativeReply.mockRejectedValue(new Error("model upstream unavailable"));

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "run-terminal-entitlement",
      status: "failed",
    });

    expect(mocks.releaseConversationEntitlement).not.toHaveBeenCalled();
    expect(mocks.failGenerationRun).toHaveBeenCalledWith({
      conversationId: "conversation-terminal-entitlement",
      runId: "run-terminal-entitlement",
      outboxId: "outbox-terminal-entitlement",
      leaseAttempt: 1,
      errorCode: "conversation_worker_failed",
      errorMessage: "model upstream unavailable",
    });
    expect(mocks.completeInlineGenerationRun).not.toHaveBeenCalled();
  });

  it("preserves a persisted service-credit reservation through a countUsage=false terminal reply", async () => {
    const reservation = {
      usageChargeId: "usage-correctable-1",
      tokenAmount: 1,
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-correctable-entitlement",
      leaseAttempt: 1,
      runId: "run-correctable-entitlement",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-correctable-entitlement",
      contactId: "contact-correctable-entitlement",
      audienceIdentityId: "audience-correctable-1",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-correctable-entitlement",
      userText: "继续回答",
      channel: "web",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(reservation);
    mocks.generateRepresentativeReply.mockRejectedValue(
      new Error("path_outside_allowed_workspace"),
    );
    mocks.completeInlineGenerationRun.mockResolvedValue({
      message: { id: "reply-correctable-entitlement" },
    });

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "run-correctable-entitlement",
      status: "completed",
    });

    expect(mocks.releaseConversationEntitlement).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-correctable-entitlement",
        countUsage: false,
      }),
    );
    expect(mocks.failGenerationRun).not.toHaveBeenCalled();
  });

  it("does not double-reserve unified entitlement when wallet credit already owns billing", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-wallet",
      leaseAttempt: 1,
      runId: "run-wallet",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-wallet",
      contactId: "contact-wallet",
      audienceIdentityId: "audience-1",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-wallet",
      userText: "继续回答",
      channel: "web",
      walletReservation: {
        usageChargeId: "usage-charge-1",
        tokenAmount: 1,
      },
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.createConversationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({ passUnlocked: true }),
      }),
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.not.objectContaining({
        entitlementReservation: expect.anything(),
      }),
    );
  });

  it("does not fall back to legacy unlock flags once unified entitlements are authoritative", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-legacy",
      runId: "run-legacy",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-legacy",
      contactId: "contact-legacy",
      audienceIdentityId: "audience-1",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-legacy",
      userText: "继续回答",
      channel: "web",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: true,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });

    await processNextConversationWork({ port: 4040, pollMs: 500 });

    expect(mocks.createConversationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: {
          freeRepliesUsed: 4,
          passUnlocked: false,
          deepHelpUnlocked: false,
        },
      }),
    );
  });

  it.each(["web", "matrix", "telegram"] as const)(
    "moves an explicit %s compute request into the approval waiting state",
    async (channel) => {
    const telegramFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 741 } }),
    });
    vi.stubGlobal("fetch", telegramFetch);
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-2",
      leaseAttempt: 1,
      runId: "run-2",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-2",
      contactId: "contact-2",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-2",
      userText: "/compute write notes/demo.txt ::: hello",
      channel,
      ...(channel === "matrix"
        ? {
            externalConversationId: "!compute-approval:example.test",
            matrixSenderUserId: "@delegate:example.test",
            matrixEndpointLifecycleRevision: 3,
          }
        : channel === "telegram"
          ? {
              externalConversationId: "123456",
              telegramConnectionId: "111111111",
            }
          : {}),
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.parseComputeDirective.mockReturnValue({
      kind: "request",
      request: {
        capability: "write",
        path: "notes/demo.txt",
        content: "hello",
        hasPaidEntitlement: false,
        browserMode: "deterministic",
        maxSteps: 1,
        allowMutations: false,
        displayTarget: "notes/demo.txt",
      },
    });
    mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-1" } });
    mocks.executeAudienceTool.mockResolvedValue({
      outcome: "pending_approval",
      approvalRequest: {
        id: "approval-1",
        requestedActionSummary: "Write notes/demo.txt",
        riskSummary: "Workspace mutation",
      },
      artifacts: [],
    });
    mocks.waitGenerationRunForComputeApproval.mockResolvedValue({
      run: { status: "WAITING_APPROVAL" },
      message: { id: "pending-message", text: "等待 Owner 审批。" },
    });
    if (channel === "telegram") {
      mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
        connectionId: "111111111",
        botId: "111111111",
        token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
      });
    }

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
      matrixHomeserverUrl: "https://matrix.example.test",
      matrixApplicationServiceToken: "as-token",
    })).resolves.toMatchObject({
      processed: true,
      status: "waiting_approval",
    });
    expect(mocks.createAudienceComputeSession).toHaveBeenCalledWith(expect.objectContaining({
      generationRunId: "run-2",
      conversationId: "conversation-2",
      generationWorkLease: {
        outboxId: "outbox-2",
        leaseAttempt: 1,
      },
      delegationTaskId: "task-1",
      delegationTaskStepId: "task-step-1",
    }));
    expect(mocks.executeAudienceTool).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        generationWorkLease: {
          outboxId: "outbox-2",
          leaseAttempt: 1,
        },
      }),
    );
    expect(mocks.markDelegationTaskRunning).toHaveBeenCalledWith("task-1", "task-step-1");
    expect(mocks.markDelegationTaskAwaitingApproval).toHaveBeenCalledWith({
      taskId: "task-1",
      stepId: "task-step-1",
      approvalId: "approval-1",
    });
    expect(mocks.finalizeComputeDelegationTask).not.toHaveBeenCalled();
    expect(mocks.waitGenerationRunForComputeApproval).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-2",
      approvalId: "approval-1",
      replyText: expect.stringContaining("操作：写入文件：demo.txt"),
    }));
    expect(mocks.prepareGenerationMessageChannelDelivery).toHaveBeenCalledWith({
      conversationId: "conversation-2",
      runId: "run-2",
      outboxId: "outbox-2",
      leaseAttempt: 1,
      outputMessageId: "pending-message",
    });
    if (channel === "matrix") {
      expect(mocks.sendMatrixRepresentativeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: "!compute-approval:example.test",
          text: "等待 Owner 审批。",
        }),
      );
    } else if (channel === "telegram") {
      expect(telegramFetch).toHaveBeenCalledWith(
        expect.stringContaining("/sendMessage"),
        expect.objectContaining({
          body: expect.stringContaining("等待 Owner 审批。"),
        }),
      );
    }
    },
  );

  it("routes natural language through the sole active V3 planner into a typed MCP approval", async () => {
    const definitionHash = `sha256:${"b".repeat(64)}`;
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-v3",
      leaseAttempt: 1,
      runId: "run-v3",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-v3",
      contactId: "contact-v3",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-v3",
      userText: "查询 DeepWiki 中这个仓库的最新说明",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: true, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      name: "SKTone",
      tone: "direct",
      languages: ["zh"],
      skillPacks: [],
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
        capabilityModes: {
          exec: "deny",
          read: "allow",
          write: "ask",
          process: "deny",
          browser: "deny",
          mcp: "ask",
        },
      },
      delegation: {
        enabled: true,
        naturalLanguageEnabled: true,
        explicitComputeEnabled: true,
        maxSteps: 5,
        maxEstimatedTokens: 10_000,
        knowledgeScope: "user_input_only",
      },
    });
    mocks.getRepresentativeRuntimeAuthoritySnapshot.mockResolvedValue({
      representativeVersionId: "version-1",
      compute: {
        enabled: true,
        capabilityModes: {
          exec: "deny",
          read: "allow",
          write: "ask",
          process: "deny",
          browser: "deny",
          mcp: "ask",
        },
      },
      delegation: { enabled: true },
      mcpBindings: [{
        id: "binding-1",
        slug: "deepwiki",
        allowedToolNames: ["ask_question"],
        defaultToolName: "ask_question",
        enabled: true,
        approvalRequired: true,
        estimatedTokensPerCall: 100,
        maxRetries: 0,
        retryBackoffMs: 1_000,
        serverUrl: "https://mcp.example.test",
        transportKind: "streamable_http",
        toolDefinitions: [{
          exactToolName: "ask_question",
          inputSchema: {
            type: "object",
            properties: { question: { type: "string" } },
            required: ["question"],
            additionalProperties: false,
          },
          outputSchema: null,
          toolSchemaHash: `sha256:${"c".repeat(64)}`,
          bindingDefinitionHash: `sha256:${"d".repeat(64)}`,
          bindingRevision: 3,
          canonicalizationVersion: "delegate-capability-v1",
        }],
      }],
    });
    mocks.buildCapabilityCatalog.mockReturnValue({
      protocolVersion: 1,
      catalogHash: `sha256:${"0".repeat(64)}`,
      capabilities: [{
        key: "mcp.deepwiki.ask_question",
        version: "1",
        description: "Ask DeepWiki",
        executor: "mcp",
        inputSchema: {
          type: "object",
          properties: { request: { type: "string" } },
          required: ["request"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { result: { type: "string" } },
          required: ["result"],
          additionalProperties: false,
        },
        effect: "external_reversible",
        idempotency: "requires_key",
        supportedChannels: ["web"],
        requiredIdentityScopes: [],
        requiredDataScopes: [],
        tags: ["deepwiki"],
        definitionHash,
      }],
    });
    mocks.buildCapabilityCatalogV3.mockImplementation((drafts) => ({
      protocolVersion: 2,
      canonicalizationVersion: "delegate-capability-v1",
      catalogHash: `sha256:${"e".repeat(64)}`,
      capabilities: drafts.map((draft: Record<string, unknown>) => ({
        ...draft,
        definitionHash,
      })),
    }));
    mocks.planTurnV3.mockImplementation(async ({ catalog, scopeKey, planId }) => {
      const mcp = catalog.capabilities.find((item: { key: string }) =>
        item.key === "mcp.deepwiki.ask_question");
      const compose = catalog.capabilities.find((item: { key: string }) =>
        item.key === "response.compose");
      return {
        ok: true,
        provider: "openai",
        model: "planner-test",
        selectedCapabilities: [mcp, compose],
        proposal: { protocolVersion: 3, objective: "Lookup and answer" },
        plan: {
          protocolVersion: 3,
          planId,
          scopeKey,
          revision: 1,
          envelopeHash: `sha256:${"f".repeat(64)}`,
          capabilityCatalogHash: catalog.catalogHash,
          validationPolicyVersion: "turn-plan-v3-policy.1",
          objective: "Lookup and answer",
          goals: [{
            id: "goal-1",
            objective: "查询仓库",
            sourcePointers: ["/currentMessage/text"],
            strategy: "capability",
            operation: "search",
            semanticConfidence: 0.98,
            generalEligibility: "not_allowed",
            actionIds: ["lookup", "compose"],
            deliverableIds: [],
            evidenceRequirement: {
              kind: "current_external",
              freshness: "live",
              allowedSourceKinds: ["mcp"],
              citationRequired: true,
              minimumEvidenceCount: 1,
            },
            failurePolicy: { strategy: "stop", reasonCode: "lookup_failed" },
          }],
          actions: [{
            id: "lookup",
            capability: {
              key: mcp.key,
              version: mcp.version,
              definitionHash: mcp.definitionHash,
            },
            arguments: { question: "查询仓库" },
            argumentProvenance: {
              question: { source: "user_message", pointer: "/currentMessage/text" },
            },
            dependencies: [],
            activation: { mode: "primary" },
            expectedOutputSchema: mcp.outputSchema,
            completionCriteria: ["Tool result verified"],
            failurePolicy: { strategy: "stop", publicMessageCode: "lookup_failed" },
          }, {
            id: "compose",
            capability: {
              key: compose.key,
              version: compose.version,
              definitionHash: compose.definitionHash,
            },
            arguments: {},
            argumentProvenance: {},
            dependencies: [{
              actionId: "lookup",
              allowedStatuses: ["succeeded", "failed", "reconciliation_required"],
            }],
            activation: { mode: "primary" },
            expectedOutputSchema: compose.outputSchema,
            completionCriteria: ["Response verified"],
            failurePolicy: { strategy: "stop", publicMessageCode: "compose_failed" },
          }],
          deliverables: [],
          decisionTrace: ["live_tool_required"],
        },
      };
    });
    mocks.persistConversationTurnPlanV3.mockResolvedValue({
      id: "turn-plan-v3-run-v3-1",
      revision: 1,
      executionEpoch: 1,
      generationRunId: "run-v3",
      actions: [
        { id: "plan-action-lookup", actionKey: "lookup" },
        { id: "plan-action-compose", actionKey: "compose" },
      ],
    });
    mocks.compileCapabilityAction.mockReturnValue({
      planId: "turn-plan-v3-run-v3-1",
      planRevision: 1,
      executionEpoch: 1,
      actionId: "plan-action-lookup",
      generationRunId: "run-v3",
      capabilityKey: "mcp.deepwiki.ask_question",
      capabilityVersion: "1",
      capabilityDefinitionHash: definitionHash,
      argumentsHash: `sha256:${"1".repeat(64)}`,
      idempotencyKey: "turn-plan:lookup",
      executor: "mcp",
      bindingId: "binding-1",
      bindingRevision: 3,
      toolName: "ask_question",
      expectedToolSchemaHash: `sha256:${"c".repeat(64)}`,
      expectedBindingDefinitionHash: `sha256:${"d".repeat(64)}`,
      toolArguments: { question: "查询仓库" },
    });
    mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-v3" } });
    mocks.executeAudienceTool.mockResolvedValue({
      outcome: "pending_approval",
      approvalRequest: {
        id: "approval-v3",
        requestedActionSummary: "Ask DeepWiki",
        riskSummary: "External tool call",
      },
      artifacts: [],
    });
    mocks.waitGenerationRunForComputeApproval.mockResolvedValue({
      run: { status: "WAITING_APPROVAL" },
      message: { id: "pending-v3", text: "等待 Owner 审批。" },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "disabled",
      turnPlannerV3Mode: "active_governed",
    })).resolves.toMatchObject({ processed: true, status: "waiting_approval" });

    expect(mocks.planTurnV2).not.toHaveBeenCalled();
    expect(mocks.planNaturalLanguageComputeRequest).not.toHaveBeenCalled();
    expect(mocks.planTurnV3).toHaveBeenCalledOnce();
    expect(mocks.planTurnV3).toHaveBeenCalledWith(expect.objectContaining({
      envelope: expect.objectContaining({
        planningDefaults: expect.objectContaining({
          knowledgePolicy: "prefer_authorized",
        }),
      }),
    }));
    expect(mocks.createComputeDelegationTask).toHaveBeenCalledWith(
      expect.objectContaining({
        planSteps: [expect.objectContaining({
          planActionId: "plan-action-lookup",
          actionKey: "lookup",
          executionRequest: expect.objectContaining({
            executor: "mcp",
            bindingRevision: 3,
          }),
        })],
      }),
    );
    expect(mocks.executeAudienceTool).toHaveBeenCalledWith(
      "session-v3",
      expect.objectContaining({
        capability: "mcp",
        bindingId: "binding-1",
        toolName: "ask_question",
      }),
    );
  });

  it("executes Knowledge before its dependent MCP action and composes both verified results", async () => {
    configureMixedKnowledgeMcpV3({ knowledge: "hit" });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "disabled",
      turnPlannerV3Mode: "active_governed",
    })).resolves.toMatchObject({ processed: true, status: "completed" });

    expect(mocks.completeV3InlineAction).toHaveBeenCalledWith(
      expect.objectContaining({
        executionAttemptId: "attempt-knowledge-mixed",
        evidenceBindings: [expect.objectContaining({
          evidenceClass: "authorized_knowledge",
          evidenceId: "memory-item-mixed",
        })],
      }),
    );
    expect(mocks.createComputeDelegationTask).toHaveBeenCalledWith(
      expect.objectContaining({
        planSteps: [expect.objectContaining({
          actionKey: "lookup",
          dependsOnStepIndexes: [],
        })],
      }),
    );
    expect(
      mocks.completeV3InlineAction.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.createComputeDelegationTask.mock.invocationCallOrder[0]!);
    expect(mocks.composeTurnV3).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.arrayContaining([
        expect.objectContaining({
          evidenceClass: "authorized_knowledge",
          evidenceId: "memory-item-mixed",
        }),
        expect.objectContaining({
          evidenceClass: "tool_output",
          evidenceId: "result-mcp-mixed",
        }),
      ]),
    }));
  });

  it("resumes only response.compose after a final approved V3 tool step", async () => {
    const { item, initializeResumePlan } = configureMixedKnowledgeMcpV3({
      knowledge: "hit",
    });
    await initializeResumePlan();
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      ...item,
      contextSnapshot: {
        source: "v3_governed_composer_resume",
        delegationTaskId: "task-v3-mixed",
        planId: "turn-plan-v3-mixed",
      },
    });
    mocks.prepareV3InlineAction.mockReset().mockResolvedValue({
      attempt: {
        id: "attempt-compose-resume",
        status: "RUNNING",
        executionLeaseToken: "inline-lease-compose-resume",
      },
    });

    const resumeResult = await processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "disabled",
      turnPlannerV3Mode: "active_governed",
    });
    expect(resumeResult.error).toBeUndefined();
    expect(resumeResult).toMatchObject({ processed: true, status: "completed" });

    expect(mocks.planTurnV3).not.toHaveBeenCalled();
    expect(mocks.createComputeDelegationTask).not.toHaveBeenCalled();
    expect(mocks.executeAudienceTool).not.toHaveBeenCalled();
    expect(mocks.composeTurnV3).toHaveBeenCalledOnce();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "turn_plan_v3_governed_composer_resume",
        countUsage: false,
        replyText: "Combined verified answer.",
      }),
    );
    expect(mocks.prepareGenerationMessageChannelDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        planActionId: "plan-action-compose",
        outputMessageId: "reply-v3-mixed",
      }),
    );
  });

  it("continues from a verified Knowledge miss to MCP success with transparent disclosure", async () => {
    configureMixedKnowledgeMcpV3({ knowledge: "miss" });
    mocks.composeTurnV3.mockResolvedValue({
      ok: true,
      provider: "agicto",
      model: "composer-test",
      draft: {
        segments: [{
          kind: "claim",
          goalId: "goal-knowledge",
          text: "General fallback answer.",
          sourceClass: "stable_general",
          evidenceRefs: [],
        }, {
          kind: "claim",
          goalId: "goal-tool",
          text: "Verified tool answer.",
          sourceClass: "tool_output",
          evidenceRefs: ["result-mcp-mixed"],
        }],
      },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "disabled",
      turnPlannerV3Mode: "active_governed",
    })).resolves.toMatchObject({ processed: true, status: "completed" });

    expect(mocks.createComputeDelegationTask).toHaveBeenCalledOnce();
    expect(mocks.composeTurnV3).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeFallbacks: [{
        goalId: "goal-knowledge",
        status: "not_found",
      }],
      evidence: [expect.objectContaining({
        evidenceClass: "tool_output",
        evidenceId: "result-mcp-mixed",
      })],
    }));
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        replyText: expect.stringContaining(
          "本回答未引用已授权知识或记忆，内容由通用模型生成。\n\nGeneral fallback answer.\n\nVerified tool answer.",
        ),
      }),
    );
    const replyText = mocks.completeInlineGenerationRun.mock.calls.at(-1)?.[0]
      .replyText as string;
    expect(replyText.match(/说明：/gu)).toHaveLength(1);
  });

  it("does not create or invoke a dependent external action after inline source failure", async () => {
    configureMixedKnowledgeMcpV3({ knowledge: "hit" });
    mocks.failActiveV3InlinePlanExecution.mockResolvedValueOnce({
      attemptsClosed: 1,
      actionsFailed: 1,
      planFailed: true,
      memoryRunsFailed: 1,
    });
    mocks.recallRepresentativeContext.mockRejectedValueOnce(
      new Error("knowledge_provider_unavailable"),
    );

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "disabled",
      turnPlannerV3Mode: "active_governed",
    })).resolves.toMatchObject({ processed: true, status: "completed" });

    expect(mocks.failActiveV3InlinePlanExecution).toHaveBeenCalledWith({
      planId: "turn-plan-v3-mixed",
      generationWorkLease: { outboxId: "outbox-v3-mixed", leaseAttempt: 1 },
      reasonCode: "knowledge_provider_unavailable",
    });
    expect(mocks.createComputeDelegationTask).not.toHaveBeenCalled();
    expect(mocks.executeAudienceTool).not.toHaveBeenCalled();
  });

  it("elevates transactional evidence only from bindings or immutable transactional semantics", () => {
    const transactionalDefinition = mixedMcpDefinition({
      evidenceClasses: ["transactional_authority"],
      authorityClasses: ["transactional"],
    });
    const ordinaryDefinition = mixedMcpDefinition({
      evidenceClasses: ["capability_result"],
      authorityClasses: ["external_authoritative"],
      definitionHash: `sha256:${"9".repeat(64)}`,
    });
    const evidence = buildV3GovernedComposerEvidence({
      sourceActions: [{
        actionKey: "transactional",
        capabilityKey: transactionalDefinition.key,
        capabilityDefinitionHash: transactionalDefinition.definitionHash,
        actionResults: [{
          id: "transaction-result",
          semanticOutcome: "succeeded",
          output: { balance: 10 },
          evidenceBindings: [],
        }],
      }, {
        actionKey: "ordinary",
        capabilityKey: ordinaryDefinition.key,
        capabilityDefinitionHash: ordinaryDefinition.definitionHash,
        actionResults: [{
          id: "ordinary-result",
          semanticOutcome: "succeeded",
          output: { text: "not transactional" },
          evidenceBindings: [],
        }],
      }],
      plannerProposalSnapshot: {
        candidateSnapshot: {
          candidates: [
            { definition: transactionalDefinition },
            { definition: ordinaryDefinition },
          ],
        },
      },
    });

    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidenceId: "transaction-result",
        evidenceClass: "transactional_authority",
      }),
      expect.objectContaining({
        evidenceId: "ordinary-result",
        evidenceClass: "tool_output",
      }),
    ]));
    const unsafeTransactionalEvidence = buildV3GovernedComposerEvidence({
      sourceActions: [{
        actionKey: "ordinary",
        capabilityKey: ordinaryDefinition.key,
        capabilityDefinitionHash: ordinaryDefinition.definitionHash,
        actionResults: [{
          id: "ordinary-result",
          semanticOutcome: "succeeded",
          output: { text: "not transactional" },
          evidenceBindings: [],
        }],
      }],
      plannerProposalSnapshot: {
        candidateSnapshot: {
          candidates: [{ definition: ordinaryDefinition }],
        },
      },
      plan: {
        goals: [{
          id: "transaction-goal",
          objective: "Read a transactional fact",
          sourcePointers: ["/currentMessage/text"],
          strategy: "capability",
          operation: "read",
          semanticConfidence: 1,
          generalEligibility: "not_allowed",
          actionIds: ["ordinary"],
          deliverableIds: [],
          evidenceRequirement: {
            kind: "transactional_authority",
            freshness: "live",
            allowedSourceKinds: ["transactional_authority"],
            citationRequired: true,
            minimumEvidenceCount: 1,
          },
          failurePolicy: { strategy: "stop", reasonCode: "authority_missing" },
        }],
      },
    });
    expect(unsafeTransactionalEvidence).toEqual([]);
  });

  it("persists a non-authoritative V3 validation failure and never falls back to a model answer", async () => {
    mocks.buildCapabilityCatalogV3.mockReturnValue({
      protocolVersion: 2,
      canonicalizationVersion: "delegate-capability-v1",
      catalogHash: `sha256:${"e".repeat(64)}`,
      capabilities: [],
    });
    mocks.planTurnV3.mockResolvedValue({
      ok: false,
      code: "plan_invalid",
      reason: "Evidence requirement has no compatible action.",
      issues: [{ code: "evidence_unsatisfied", path: "/goals/0" }],
      proposal: { protocolVersion: 3, objective: "unsafe proposal" },
      provider: "openai",
      model: "planner-test",
    });
    mocks.persistConversationTurnPlannerFailureV3.mockResolvedValue({
      id: "turn-plan-v3-failure",
      status: "FAILED",
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "disabled",
      turnPlannerV3Mode: "active_readonly",
    })).resolves.toMatchObject({ processed: true, status: "completed" });

    expect(mocks.persistConversationTurnPlannerFailureV3).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "plan_invalid",
        plannerProposalSnapshot: expect.objectContaining({
          proposal: {
            protocolVersion: 3,
            objective: "unsafe proposal",
          },
          knowledgeProbe: expect.any(Object),
        }),
      }),
    );
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
    expect(mocks.executeAudienceTool).not.toHaveBeenCalled();
  });

  it("fails active V3 closed when planning throws before a plan can be persisted", async () => {
    mocks.planTurnV3.mockRejectedValueOnce(
      new Error("catalog_definition_registration_failed"),
    );

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "disabled",
      turnPlannerV3Mode: "active_governed",
    })).resolves.toMatchObject({ processed: true, status: "completed" });

    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
    expect(mocks.planNaturalLanguageComputeRequest).not.toHaveBeenCalled();
    expect(mocks.executeAudienceTool).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        replyText: expect.stringContaining("没有降级为未经验证的模型回答"),
        countUsage: false,
      }),
    );
  });

  it("executes a compose-only stable general plan in active governed mode", async () => {
    const definitionHash = `sha256:${"b".repeat(64)}`;
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-v3-general",
      leaseAttempt: 1,
      runId: "run-v3-general",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-v3-general",
      contactId: "contact-v3-general",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-v3-general",
      userText: "请用三句话解释 CAP 定理，不要使用任何工具。",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: true, deepHelpUnlocked: false },
    });
    mocks.buildCapabilityCatalogV3.mockImplementation((drafts) => ({
      protocolVersion: 2,
      canonicalizationVersion: "delegate-capability-v1",
      catalogHash: `sha256:${"e".repeat(64)}`,
      capabilities: drafts.map((draft: Record<string, unknown>) => ({
        ...draft,
        definitionHash,
      })),
    }));
    mocks.planTurnV3.mockImplementation(async ({ catalog, scopeKey, planId }) => {
      const compose = catalog.capabilities.find((item: { key: string }) =>
        item.key === "response.compose");
      return {
        ok: true,
        provider: "openai",
        model: "planner-test",
        selectedCapabilities: [compose],
        proposal: { protocolVersion: 3, objective: "Explain CAP" },
        plan: {
          protocolVersion: 3,
          planId,
          scopeKey,
          revision: 1,
          envelopeHash: `sha256:${"f".repeat(64)}`,
          capabilityCatalogHash: catalog.catalogHash,
          validationPolicyVersion: "turn-plan-v3-policy.1",
          objective: "Explain CAP without tools",
          goals: [{
            id: "goal-1",
            objective: "Explain CAP",
            sourcePointers: ["/currentMessage/text"],
            strategy: "general",
            operation: "explain",
            semanticConfidence: 0.98,
            generalEligibility: "allowed",
            actionIds: ["compose"],
            deliverableIds: [],
            evidenceRequirement: {
              kind: "none",
              freshness: "stable",
              allowedSourceKinds: [],
              citationRequired: false,
              minimumEvidenceCount: 0,
            },
            failurePolicy: { strategy: "stop", reasonCode: "compose_failed" },
          }],
          actions: [{
            id: "compose",
            capability: {
              key: compose.key,
              version: compose.version,
              definitionHash: compose.definitionHash,
            },
            arguments: {},
            argumentProvenance: {},
            dependencies: [],
            activation: { mode: "primary" },
            expectedOutputSchema: compose.outputSchema,
            completionCriteria: ["Three stable-general sentences"],
            failurePolicy: { strategy: "stop", publicMessageCode: "compose_failed" },
          }],
          deliverables: [],
          decisionTrace: ["stable_general_no_tools"],
        },
      };
    });
    mocks.persistConversationTurnPlanV3.mockResolvedValue({
      id: "turn-plan-v3-run-v3-general-1",
      revision: 1,
      executionEpoch: 1,
      generationRunId: "run-v3-general",
      actions: [{ id: "plan-action-compose", actionKey: "compose" }],
    });
    mocks.recordConversationPlanActionAuthorization.mockResolvedValue({
      id: "authorization-general",
      sequence: 3,
    });
    mocks.prepareV3InlineAction.mockResolvedValue({
      attempt: { id: "attempt-compose", status: "RUNNING", executionLeaseToken: "inline-lease-compose" },
    });
    mocks.composeTurnV3.mockResolvedValue({
      ok: true,
      provider: "bailian",
      model: "qwen-plus",
      draft: {
        segments: [{
          kind: "claim",
          goalId: "goal-self",
          text: "CAP 表示一致性、可用性和分区容错性不能在网络分区时同时全部保证。",
          sourceClass: "stable_general",
          evidenceRefs: [],
        }],
      },
    });
    mocks.completeV3InlineAction.mockResolvedValue({ id: "result-compose" });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "disabled",
      turnPlannerV3Mode: "active_governed",
    })).resolves.toMatchObject({ processed: true, status: "completed" });

    expect(mocks.composeTurnV3).toHaveBeenCalledOnce();
    expect(mocks.composeTurnV3).toHaveBeenCalledWith(expect.objectContaining({
      responseLanguage: "zh",
      taskInput: {
        text: "请用三句话解释 CAP 定理，不要使用任何工具。",
        language: "zh",
      },
      actionResults: [],
      evidence: [],
    }));
    expect(mocks.createComputeDelegationTask).not.toHaveBeenCalled();
    expect(mocks.executeAudienceTool).not.toHaveBeenCalled();
    expect(mocks.completeConversationTurnPlan).toHaveBeenCalledWith({
      planId: "turn-plan-v3-run-v3-general-1",
    });
    expect(
      mocks.completeConversationTurnPlan.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      mocks.completeInlineGenerationRun.mock.invocationCallOrder[0]!,
    );
  });

  it("closes the V3 execution lifecycle before delivering a composer failure notice", async () => {
    const definitionHash = `sha256:${"b".repeat(64)}`;
    const composeDefinition = {
      key: "response.compose",
      version: "1.0.0",
      definitionHash,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { segments: { type: "array" } },
        required: ["segments"],
        additionalProperties: false,
      },
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-v3-compose-failed",
      leaseAttempt: 1,
      runId: "run-v3-compose-failed",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-v3-compose-failed",
      contactId: "contact-v3-compose-failed",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-v3-compose-failed",
      userText: "解释 CAP 定理",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: true, deepHelpUnlocked: false },
    });
    mocks.buildCapabilityCatalogV3.mockReturnValue({
      protocolVersion: 2,
      canonicalizationVersion: "delegate-capability-v1",
      catalogHash: `sha256:${"e".repeat(64)}`,
      capabilities: [composeDefinition],
    });
    mocks.planTurnV3.mockResolvedValue({
      ok: true,
      provider: "agicto",
      model: "planner-test",
      selectedCapabilities: [composeDefinition],
      proposal: { protocolVersion: 3, objective: "Explain CAP" },
      plan: {
        protocolVersion: 3,
        planId: "turn-plan-v3-run-v3-compose-failed-1",
        scopeKey: "generation:conversation-v3-compose-failed:message-v3-compose-failed",
        revision: 1,
        envelopeHash: `sha256:${"f".repeat(64)}`,
        capabilityCatalogHash: `sha256:${"e".repeat(64)}`,
        validationPolicyVersion: "turn-plan-v3-policy.1",
        objective: "Explain CAP",
        goals: [{
          id: "goal-1",
          objective: "Explain CAP",
          sourcePointers: ["/currentMessage/text"],
          strategy: "general",
          operation: "explain",
          semanticConfidence: 0.98,
          generalEligibility: "allowed",
          actionIds: ["compose"],
          deliverableIds: [],
          evidenceRequirement: {
            kind: "none",
            freshness: "stable",
            allowedSourceKinds: [],
            citationRequired: false,
            minimumEvidenceCount: 0,
          },
          failurePolicy: { strategy: "stop", reasonCode: "compose_failed" },
        }],
        actions: [{
          id: "compose",
          capability: {
            key: composeDefinition.key,
            version: composeDefinition.version,
            definitionHash,
          },
          arguments: {},
          argumentProvenance: {},
          dependencies: [],
          activation: { mode: "primary" },
          expectedOutputSchema: composeDefinition.outputSchema,
          completionCriteria: ["Return an answer"],
          failurePolicy: { strategy: "stop", publicMessageCode: "compose_failed" },
        }],
        deliverables: [],
        decisionTrace: ["stable_general"],
      },
    });
    mocks.persistConversationTurnPlanV3.mockResolvedValue({
      id: "turn-plan-v3-run-v3-compose-failed-1",
      revision: 1,
      executionEpoch: 1,
      generationRunId: "run-v3-compose-failed",
      actions: [{ id: "plan-action-compose-failed", actionKey: "compose" }],
    });
    mocks.recordConversationPlanActionAuthorization.mockResolvedValue({
      id: "authorization-compose-failed",
      sequence: 3,
    });
    mocks.prepareV3InlineAction.mockResolvedValue({
      attempt: { id: "attempt-compose-failed", status: "RUNNING", executionLeaseToken: "inline-lease-compose-failed" },
    });
    mocks.composeTurnV3.mockResolvedValue({
      ok: false,
      reason: "No provider produced a validated evidence-bound draft.",
      diagnostics: [{
        provider: "agicto",
        model: "composer-model",
        stage: "evidence_validation",
        issueCodes: ["evidence_ref_unknown_or_class_mismatch"],
      }],
    });
    mocks.failActiveV3InlinePlanExecution.mockResolvedValue({
      attemptsClosed: 1,
      actionsFailed: 1,
      planFailed: true,
      memoryRunsFailed: 0,
    });
    mocks.completeInlineGenerationRun.mockResolvedValue({
      message: { id: "system-failure-message", text: "严格只读计划未能完成。" },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "disabled",
      turnPlannerV3Mode: "active_governed",
    })).resolves.toMatchObject({ processed: true, status: "completed" });

    expect(mocks.failActiveV3InlinePlanExecution).toHaveBeenCalledWith({
      planId: "turn-plan-v3-run-v3-compose-failed-1",
      generationWorkLease: {
        outboxId: "outbox-v3-compose-failed",
        leaseAttempt: 1,
      },
      reasonCode:
        "No provider produced a validated evidence-bound draft. diagnostics=agicto/composer-model:evidence_validation:evidence_ref_unknown_or_class_mismatch",
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "delegation_failed",
        countUsage: false,
        evidenceIndependentSystemFailure: {
          failureCode: "delegation_failed",
        },
      }),
    );
    expect(mocks.completeConversationTurnPlan).not.toHaveBeenCalled();
  });

  it("describes the representative from Owner profile, authorized knowledge, and user-facing outcomes", async () => {
    const definitionHash = `sha256:${"b".repeat(64)}`;
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-v3-capabilities",
      leaseAttempt: 1,
      runId: "run-v3-capabilities",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-v3-capabilities",
      contactId: "contact-v3-capabilities",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-v3-capabilities",
      userText: "你会什么",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: true, deepHelpUnlocked: false },
    });
    mocks.buildCapabilityCatalogV3.mockImplementation((drafts) => ({
      protocolVersion: 2,
      canonicalizationVersion: "delegate-capability-v1",
      catalogHash: `sha256:${"e".repeat(64)}`,
      capabilities: drafts.map((draft: Record<string, unknown>) => ({
        ...draft,
        definitionHash,
      })),
    }));
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      ownerName: "周老师",
      name: "地理代表—周行知",
      tagline: "用 Owner 发布的资料讲清地理知识",
      tone: "清晰、耐心",
      languages: ["zh"],
      humanInLoop: true,
      handoffAccessMode: "PACKAGE_REQUIRED",
      handoffPrompt: "请简要描述需要周老师确认的事项。",
      skillPacks: [],
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.planTurnV3.mockImplementation(async ({ catalog, scopeKey, planId }) => {
      const describe = catalog.capabilities.find((item: { key: string }) =>
        item.key === "representative.describe_self");
      const compose = catalog.capabilities.find((item: { key: string }) =>
        item.key === "response.compose");
      return {
        ok: true,
        provider: "agicto",
        model: "qwen-plus",
        selectedCapabilities: [describe, compose],
        proposal: { protocolVersion: 3, objective: "Describe capabilities" },
        plan: {
          protocolVersion: 3,
          planId,
          scopeKey,
          revision: 1,
          envelopeHash: `sha256:${"f".repeat(64)}`,
          capabilityCatalogHash: catalog.catalogHash,
          validationPolicyVersion: "turn-plan-v3-policy.1",
          objective: "Describe the representative from published Owner context",
          goals: [{
            id: "goal-1",
            objective: "Answer what the representative can do",
            sourcePointers: ["/currentMessage/text"],
            strategy: "capability",
            operation: "answer",
            semanticConfidence: 0.98,
            generalEligibility: "not_allowed",
            actionIds: ["describe", "compose"],
            deliverableIds: [],
            evidenceRequirement: {
              kind: "capability_result",
              freshness: "bounded",
              allowedSourceKinds: ["capability_catalog"],
              citationRequired: true,
              minimumEvidenceCount: 1,
            },
            failurePolicy: { strategy: "stop", reasonCode: "capabilities_unavailable" },
          }],
          actions: [{
            id: "describe",
            capability: {
              key: describe.key,
              version: describe.version,
              definitionHash: describe.definitionHash,
            },
            arguments: {},
            argumentProvenance: {},
            dependencies: [],
            activation: { mode: "primary" },
            expectedOutputSchema: describe.outputSchema,
            completionCriteria: ["Published capabilities returned"],
            failurePolicy: { strategy: "stop", publicMessageCode: "capabilities_unavailable" },
          }, {
            id: "compose",
            capability: {
              key: compose.key,
              version: compose.version,
              definitionHash: compose.definitionHash,
            },
            arguments: {},
            argumentProvenance: {},
            dependencies: [{
              actionId: "describe",
              allowedStatuses: ["succeeded"],
            }],
            activation: { mode: "primary" },
            expectedOutputSchema: compose.outputSchema,
            completionCriteria: ["Evidence-bound response returned"],
            failurePolicy: { strategy: "stop", publicMessageCode: "compose_failed" },
          }],
          deliverables: [],
          decisionTrace: ["owner_profile_and_knowledge_are_authoritative"],
        },
      };
    });
    mocks.persistConversationTurnPlanV3.mockResolvedValue({
      id: "turn-plan-v3-run-v3-capabilities-1",
      revision: 1,
      executionEpoch: 1,
      generationRunId: "run-v3-capabilities",
      actions: [
        { id: "plan-action-describe", actionKey: "describe" },
        { id: "plan-action-compose", actionKey: "compose" },
      ],
    });
    mocks.recordConversationPlanActionAuthorization.mockResolvedValue({
      id: "authorization-capabilities",
      sequence: 3,
    });
    mocks.prepareV3InlineAction
      .mockResolvedValueOnce({ attempt: { id: "attempt-describe", status: "RUNNING", executionLeaseToken: "inline-lease-describe" } })
      .mockResolvedValueOnce({ attempt: { id: "attempt-compose", status: "RUNNING", executionLeaseToken: "inline-lease-compose" } });
    mocks.completeV3InlineAction.mockResolvedValue({ id: "result-capabilities" });
    mocks.composeTurnV3.mockResolvedValue({
      ok: true,
      provider: "agicto",
      model: "qwen-plus",
      draft: {
        segments: [{
          kind: "claim",
          goalId: "goal-1",
          text: "我是周老师的地理数字代表，会依据周老师发布的资料帮助你学习地理。",
          sourceClass: "tool_output",
          evidenceRefs: ["representative-profile:turn-plan-v3-run-v3-capabilities-1"],
        }],
      },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "disabled",
      turnPlannerV3Mode: "active_governed",
    })).resolves.toMatchObject({ processed: true, status: "completed" });

    expect(mocks.composeTurnV3).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.arrayContaining([expect.objectContaining({
        evidenceId: "representative-profile:turn-plan-v3-run-v3-capabilities-1",
        evidenceClass: "tool_output",
      }), expect.objectContaining({
        evidenceClass: "authorized_knowledge",
      })]),
    }));
    const plannerCatalog = mocks.planTurnV3.mock.calls[0]?.[0].catalog;
    const describeDefinition = plannerCatalog.capabilities.find(
      (capability: { key: string }) =>
        capability.key === "representative.describe_self",
    );
    expect(describeDefinition).toMatchObject({
      version: "2",
      outputSchema: expect.objectContaining({
        required: expect.arrayContaining(["humanConfirmation"]),
      }),
      successContract: expect.objectContaining({
        schema: expect.objectContaining({
          required: expect.arrayContaining(["humanConfirmation"]),
        }),
      }),
    });
    expect(mocks.completeV3InlineAction).toHaveBeenCalledWith(
      expect.objectContaining({
        executionAttemptId: "attempt-describe",
        rawOutput: expect.objectContaining({
          capabilityOutcomes: expect.not.arrayContaining([
            expect.stringContaining("representative.describe_self"),
          ]),
          humanConfirmation: {
            enabled: true,
            handoffAccessMode: "PACKAGE_REQUIRED",
            handoffPrompt: "请简要描述需要周老师确认的事项。",
            userFacingStatements: [
              expect.stringContaining("需要真人作出承诺、审批或承担责任"),
              expect.stringContaining("需满足相应服务权益"),
            ],
          },
        }),
      }),
    );
    expect(mocks.executeAudienceTool).not.toHaveBeenCalled();
    expect(mocks.createComputeDelegationTask).not.toHaveBeenCalled();
  });

  it("publishes a fail-closed human-confirmation boundary and omits unavailable capabilities", () => {
    const output = buildRepresentativeDescriptionOutput({
      setup: {
        name: "地理代表—周行知",
        ownerName: "周老师",
        tagline: "讲清地理知识",
        tone: "清晰",
        languages: ["zh"],
        humanInLoop: false,
        handoffAccessMode: "FREE",
        handoffPrompt: "这条未启用的提示不应对用户暴露。",
      } as never,
      capabilities: [{
        key: "knowledge.retrieve_authorized",
        description: "Authorized knowledge",
        executor: "knowledge",
        definitionHash: `sha256:${"1".repeat(64)}`,
      }, {
        key: "mcp.private.internal_tool_key",
        description: "Internal third-party tool description",
        executor: "mcp",
        definitionHash: `sha256:${"2".repeat(64)}`,
      }],
      availability: [{
        definitionHash: `sha256:${"1".repeat(64)}`,
        healthState: "degraded",
      }, {
        definitionHash: `sha256:${"2".repeat(64)}`,
        healthState: "unavailable",
      }],
      knowledgeStatus: "not_found",
      knowledgeItems: [],
    });

    expect(output.capabilityOutcomes).toEqual([
      "依据 Owner 发布并授权的知识资料回答相关问题",
    ]);
    expect(output.capabilityOutcomes.join(" ")).not.toContain(
      "mcp.private.internal_tool_key",
    );
    expect(output.humanConfirmation).toMatchObject({
      enabled: false,
      handoffAccessMode: "FREE",
      handoffPrompt: "",
      userFacingStatements: [
        expect.stringContaining("必须由真人确认"),
        expect.stringContaining("当前未启用真人接管"),
      ],
    });
  });

  it("revalidates and reuses the pinned representative-description result on replay", async () => {
    const definitionHash = `sha256:${"7".repeat(64)}`;
    let catalogCapabilities: Array<Record<string, any>> = [];
    const replayedDescription = {
      profile: {
        representativeName: "地理代表—周行知",
        ownerName: "周老师",
        tagline: "讲清地理知识",
        tone: "清晰",
        languages: ["zh"],
      },
      capabilityOutcomes: ["依据 Owner 发布并授权的知识资料回答相关问题"],
      humanConfirmation: {
        enabled: true,
        handoffAccessMode: "FREE",
        handoffPrompt: "请描述需要周老师确认的事项。",
        userFacingStatements: [
          "需要真人承诺、审批或承担责任的事项必须由真人确认。",
          "当前已启用真人接管。",
        ],
      },
      knowledgeStatus: "not_found",
      knowledgeEvidenceRefs: [],
      knowledgeItems: [],
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-v3-description-replay",
      leaseAttempt: 2,
      runId: "run-v3-description-replay",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "地理代表—周行知",
      conversationId: "conversation-v3-description-replay",
      contactId: "contact-v3-description-replay",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-v3-description-replay",
      userText: "哪些事需要真人确认？",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: true, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      ownerName: "周老师",
      name: "地理代表—周行知",
      tagline: "讲清地理知识",
      tone: "清晰",
      languages: ["zh"],
      humanInLoop: true,
      handoffAccessMode: "FREE",
      handoffPrompt: "请描述需要周老师确认的事项。",
      skillPacks: [],
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildCapabilityCatalogV3.mockImplementation((drafts) => {
      catalogCapabilities = drafts.map((draft: Record<string, unknown>) => ({
        ...draft,
        definitionHash,
      }));
      return {
        protocolVersion: 2,
        canonicalizationVersion: "delegate-capability-v1",
        catalogHash: `sha256:${"8".repeat(64)}`,
        capabilities: catalogCapabilities,
      };
    });
    mocks.loadReplayableConversationTurnPlanV3.mockImplementation(async () => {
      const describe = catalogCapabilities.find((item) =>
        item.key === "representative.describe_self")!;
      const compose = catalogCapabilities.find((item) =>
        item.key === "response.compose")!;
      const planSnapshot = {
        protocolVersion: 3,
        planId: "turn-plan-v3-description-replay",
        scopeKey: {
          kind: "generation_turn",
          conversationId: "conversation-v3-description-replay",
          inputMessageId: "message-v3-description-replay",
        },
        revision: 1,
        envelopeHash: `sha256:${"9".repeat(64)}`,
        capabilityCatalogHash: `sha256:${"8".repeat(64)}`,
        validationPolicyVersion: "turn-plan-v3-policy.3",
        objective: "Describe the representative's human-confirmation boundary",
        goals: [{
          id: "goal-self",
          objective: "Describe the representative's human-confirmation boundary",
          sourcePointers: ["/currentMessage/text"],
          strategy: "capability",
          operation: "answer",
          semanticConfidence: 0.99,
          generalEligibility: "not_allowed",
          actionIds: ["describe", "compose"],
          deliverableIds: [],
          evidenceRequirement: {
            kind: "capability_result",
            freshness: "bounded",
            allowedSourceKinds: ["capability_result"],
            citationRequired: true,
            minimumEvidenceCount: 1,
          },
          failurePolicy: { strategy: "stop", reasonCode: "description_failed" },
        }],
        actions: [{
          id: "describe",
          capability: {
            key: describe.key,
            version: describe.version,
            definitionHash: describe.definitionHash,
          },
          arguments: {},
          argumentProvenance: {},
          dependencies: [],
          activation: { mode: "primary" },
          expectedOutputSchema: describe.outputSchema,
          completionCriteria: ["Pinned description available"],
          failurePolicy: { strategy: "stop", publicMessageCode: "description_failed" },
        }, {
          id: "compose",
          capability: {
            key: compose.key,
            version: compose.version,
            definitionHash: compose.definitionHash,
          },
          arguments: {},
          argumentProvenance: {},
          dependencies: [{ actionId: "describe", allowedStatuses: ["succeeded"] }],
          activation: { mode: "primary" },
          expectedOutputSchema: compose.outputSchema,
          completionCriteria: ["Response composed"],
          failurePolicy: { strategy: "stop", publicMessageCode: "compose_failed" },
        }],
        deliverables: [],
        decisionTrace: ["replay_pinned_description"],
      };
      return {
        id: "turn-plan-v3-description-replay",
        revision: 1,
        executionEpoch: 1,
        generationRunId: "run-v3-description-replay",
        plannerProvider: "persisted",
        plannerModel: "persisted",
        planSnapshot,
        actions: [
          { id: "plan-action-description-replay", actionKey: "describe" },
          { id: "plan-action-compose-replay", actionKey: "compose" },
        ],
      };
    });
    mocks.recordConversationPlanActionAuthorization.mockResolvedValue({ sequence: 3 });
    mocks.prepareV3InlineAction
      .mockResolvedValueOnce({
        attempt: {
          id: "attempt-description-replay",
          status: "SUCCEEDED",
          responseSnapshot: replayedDescription,
        },
      })
      .mockResolvedValueOnce({
        attempt: {
          id: "attempt-compose-after-replay",
          status: "RUNNING",
          executionLeaseToken: "lease-compose-after-replay",
        },
      });
    mocks.composeTurnV3.mockResolvedValue({
      ok: true,
      provider: "agicto",
      model: "qwen-plus",
      draft: {
        segments: [{
          kind: "claim",
          goalId: "goal-self",
          text: "需要真人承诺或审批的事项必须由真人确认。",
          sourceClass: "tool_output",
          evidenceRefs: ["representative-profile:turn-plan-v3-description-replay"],
        }],
      },
    });
    mocks.completeV3InlineAction.mockResolvedValue({ actionStatus: "SUCCEEDED" });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "disabled",
      turnPlannerV3Mode: "active_governed",
    })).resolves.toMatchObject({ processed: true, status: "completed" });

    expect(mocks.validateJsonSchemaValue).toHaveBeenCalledWith(
      replayedDescription,
      expect.objectContaining({
        required: expect.arrayContaining(["humanConfirmation"]),
      }),
      "/replayedActionResult",
    );
    expect(mocks.recallRepresentativeContext).not.toHaveBeenCalled();
    expect(mocks.composeTurnV3).toHaveBeenCalledWith(expect.objectContaining({
      actionResults: [expect.objectContaining({
        actionId: "describe",
        semanticOutcome: "succeeded",
      })],
      evidence: [expect.objectContaining({
        evidenceClass: "tool_output",
        content: replayedDescription,
      })],
    }));
  });

  it("falls back transparently to stable general knowledge after an authorized knowledge miss", async () => {
    const definitionHash = `sha256:${"b".repeat(64)}`;
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-v3-knowledge-miss",
      leaseAttempt: 1,
      runId: "run-v3-knowledge-miss",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-v3-knowledge-miss",
      contactId: "contact-v3-knowledge-miss",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-v3-knowledge-miss",
      userText: "你知道等温线吗",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: true, deepHelpUnlocked: false },
    });
    mocks.recallRepresentativeContext.mockResolvedValue({
      items: [],
      citations: [],
      memoryUseRunId: "memory-use-run-miss",
    });
    mocks.buildCapabilityCatalogV3.mockImplementation((drafts) => ({
      protocolVersion: 2,
      canonicalizationVersion: "delegate-capability-v1",
      catalogHash: `sha256:${"e".repeat(64)}`,
      capabilities: drafts.map((draft: Record<string, unknown>) => ({
        ...draft,
        definitionHash,
      })),
    }));
    mocks.planTurnV3.mockImplementation(async ({ catalog, scopeKey, planId }) => {
      const knowledge = catalog.capabilities.find((item: { key: string }) =>
        item.key === "knowledge.retrieve_authorized");
      const compose = catalog.capabilities.find((item: { key: string }) =>
        item.key === "response.compose");
      return {
        ok: true,
        provider: "agicto",
        model: "qwen-plus",
        selectedCapabilities: [knowledge, compose],
        proposal: { protocolVersion: 3, objective: "Answer knowledge-first" },
        plan: {
          protocolVersion: 3,
          planId,
          scopeKey,
          revision: 1,
          envelopeHash: `sha256:${"f".repeat(64)}`,
          capabilityCatalogHash: catalog.catalogHash,
          validationPolicyVersion: "turn-plan-v3-policy.1",
          objective: "Answer after authorized knowledge lookup",
          goals: [{
            id: "goal-1",
            objective: "Explain isotherms",
            sourcePointers: ["/currentMessage/text"],
            strategy: "knowledge",
            operation: "answer",
            semanticConfidence: 0.95,
            generalEligibility: "allowed",
            actionIds: ["retrieve", "compose"],
            deliverableIds: [],
            evidenceRequirement: {
              kind: "knowledge_preferred",
              freshness: "bounded",
              allowedSourceKinds: ["authorized_knowledge"],
              citationRequired: false,
              minimumEvidenceCount: 0,
            },
            evidenceFallbackPolicy: {
              kind: "authorized_knowledge_miss_to_stable_general",
              policySource: "server_planning_default",
              activationStatuses: ["not_found", "unavailable"],
              authorityBoundary: "non_owner_specific_stable_general",
              disclosureRequired: true,
            },
            sourceAuthorityBoundary: {
              classification: "stable_general_allowed",
              policySource: "server_authority_policy",
              policyVersion: "delegate.source-authority.v1",
              reasonCodes: ["no_owner_authority_signal"],
            },
            failurePolicy: { strategy: "stop", reasonCode: "knowledge_unavailable" },
          }],
          actions: [{
            id: "retrieve",
            capability: {
              key: knowledge.key,
              version: knowledge.version,
              definitionHash: knowledge.definitionHash,
            },
            arguments: { question: "你知道等温线吗" },
            argumentProvenance: {
              question: { source: "user_message", pointer: "/currentMessage/text" },
            },
            dependencies: [],
            activation: { mode: "primary" },
            expectedOutputSchema: knowledge.outputSchema,
            completionCriteria: ["Knowledge lookup reaches a verified outcome"],
            failurePolicy: { strategy: "stop", publicMessageCode: "knowledge_unavailable" },
          }, {
            id: "compose",
            capability: {
              key: compose.key,
              version: compose.version,
              definitionHash: compose.definitionHash,
            },
            arguments: {},
            argumentProvenance: {},
            dependencies: [{ actionId: "retrieve", allowedStatuses: ["succeeded"] }],
            activation: { mode: "primary" },
            expectedOutputSchema: compose.outputSchema,
            completionCriteria: ["Transparent response returned"],
            failurePolicy: { strategy: "stop", publicMessageCode: "compose_failed" },
          }],
          deliverables: [],
          decisionTrace: ["knowledge_preferred_then_stable_general"],
        },
      };
    });
    mocks.persistConversationTurnPlanV3.mockResolvedValue({
      id: "turn-plan-v3-run-v3-knowledge-miss-1",
      revision: 1,
      executionEpoch: 1,
      generationRunId: "run-v3-knowledge-miss",
      actions: [
        { id: "plan-action-retrieve", actionKey: "retrieve" },
        { id: "plan-action-compose", actionKey: "compose" },
      ],
    });
    mocks.recordConversationPlanActionAuthorization.mockResolvedValue({
      id: "authorization-knowledge-miss",
      sequence: 3,
    });
    mocks.prepareV3InlineAction
      .mockResolvedValueOnce({ attempt: { id: "attempt-retrieve", status: "RUNNING", executionLeaseToken: "inline-lease-retrieve" } })
      .mockResolvedValueOnce({ attempt: { id: "attempt-compose", status: "RUNNING", executionLeaseToken: "inline-lease-compose" } });
    mocks.completeV3InlineAction.mockResolvedValue({ id: "result-knowledge-miss" });
    mocks.composeTurnV3.mockResolvedValue({
      ok: true,
      provider: "agicto",
      model: "qwen-plus",
      draft: {
        segments: [{
          kind: "claim",
          goalId: "goal-1",
          text: "等温线是地图上连接气温相同地点的曲线。",
          sourceClass: "stable_general",
          evidenceRefs: [],
        }],
      },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "disabled",
      turnPlannerV3Mode: "active_governed",
    })).resolves.toMatchObject({ processed: true, status: "completed" });

    expect(mocks.composeTurnV3).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeFallbacks: [{ goalId: "goal-1", status: "not_found" }],
      evidence: [],
    }));
    expect(mocks.planTurnV3).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeProbe: expect.objectContaining({
        status: "miss",
        candidateCount: 0,
        probeRevision: "knowledge-probe:version-1:test",
      }),
    }));
    expect(mocks.probeRepresentativeKnowledgeMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        representativeVersionId: "version-1",
        conversationId: "conversation-v3-knowledge-miss",
        contactId: "contact-v3-knowledge-miss",
        sourceChannel: "web",
        allowedSourceKinds: ["PUBLIC_KNOWLEDGE"],
      }),
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        replyText: expect.stringContaining(
          "本回答未引用已授权知识或记忆，内容由通用模型生成",
        ),
      }),
    );
    expect(mocks.executeAudienceTool).not.toHaveBeenCalled();
  });

  it("keeps a system-managed document path out of the public approval message", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-generated-document",
      runId: "run-generated-document",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-generated-document",
      contactId: "contact-generated-document",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-generated-document",
      userText: "生成面向管理层的季度销售报告",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(true);
    const naturalPlan = {
      kind: "execution" as const,
      summary: "生成季度销售报告",
      steps: [{
        capability: "write" as const,
        path: "outputs/report-abcd1234.md",
        content: "# 季度销售报告",
        summary: "生成季度销售报告",
      }],
    };
    mocks.planNaturalLanguageComputeRequest.mockResolvedValue({ ok: true, plan: naturalPlan, source: "model" });
    mocks.buildComputeRequestsFromDelegationPlan.mockReturnValue([{
      capability: "write",
      path: "outputs/report-abcd1234.md",
      content: "# 季度销售报告",
      displayTarget: "生成季度销售报告",
      hasPaidEntitlement: false,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    }]);
    mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-generated-document" } });
    mocks.executeAudienceTool.mockResolvedValue({
      outcome: "pending_approval",
      approvalRequest: {
        id: "approval-generated-document",
        requestedActionSummary: 'Write to "/workspace/outputs/report-abcd1234.md".',
        riskSummary: "Workspace mutation",
      },
      artifacts: [],
    });
    mocks.waitGenerationRunForComputeApproval.mockResolvedValue({
      run: { status: "WAITING_APPROVAL" },
      message: { id: "pending-generated-document" },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "waiting_approval",
    });

    expect(mocks.waitGenerationRunForComputeApproval).toHaveBeenCalledWith(expect.objectContaining({
      replyText: expect.stringContaining("操作：生成并保存文档"),
    }));
    expect(mocks.waitGenerationRunForComputeApproval.mock.calls[0]?.[0]?.replyText).not.toContain("/workspace/");
  });

  it("returns compute help without creating a sandbox session", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-help",
      runId: "run-help",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-help",
      contactId: "contact-help",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-help",
      userText: "/compute",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.parseComputeDirective.mockReturnValue({
      kind: "help",
      examples: "/compute pwd",
    });
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-help" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
    expect(mocks.createComputeDelegationTask).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      countUsage: false,
      intent: "compute_help",
    }));
  });

  it("routes a high-confidence natural-language task through the compute planner", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-natural",
      runId: "run-natural",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-natural",
      contactId: "contact-natural",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-natural",
      userText: "把 browser QA 保存到 notes/qa.txt",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(true);
    const naturalStep = {
      capability: "write" as const,
      path: "notes/qa.txt",
      content: "browser QA",
      summary: "生成 notes/qa.txt",
    };
    const request = {
      ...naturalStep,
      displayTarget: naturalStep.summary,
      hasPaidEntitlement: true,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    };
    const naturalPlan = { kind: "execution" as const, summary: "生成并保存文件", steps: [naturalStep] };
    mocks.planNaturalLanguageComputeRequest.mockResolvedValue({ ok: true, plan: naturalPlan, source: "model" });
    mocks.buildComputeRequestsFromDelegationPlan.mockReturnValue([request]);
    mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-natural" } });
    mocks.executeAudienceTool.mockResolvedValue({
      outcome: "completed",
      artifacts: [{
        id: "artifact-natural",
        kind: "file",
        objectKey: "result/file",
        mimeType: "text/plain; charset=utf-8",
        sizeBytes: 10,
        summary: "/workspace/notes/qa.txt: browser QA",
      }],
      billing: { computeCostCents: 4 },
    });
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-natural" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.planNaturalLanguageComputeRequest).toHaveBeenCalledWith({
      userText: "把 browser QA 保存到 notes/qa.txt",
      maxSteps: 5,
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ fileName: "qa.txt", artifactId: "artifact-natural" })],
      countUsage: true,
      replyText: expect.stringContaining("已生成文件：qa.txt"),
    }));
    expect(mocks.executeAudienceTool).toHaveBeenCalledWith(
      "session-natural",
      expect.objectContaining({
        hasPaidEntitlement: false,
      }),
    );
    expect(mocks.completeInlineGenerationRun.mock.calls[0]?.[0]?.replyText).not.toContain("/workspace/");
    expect(mocks.completeInlineGenerationRun.mock.calls[0]?.[0]?.replyText).not.toContain("browser QA");
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      outcome: "completed",
      artifacts: [expect.objectContaining({ id: "artifact-natural" })],
    }));
  });

  it("uses a verified V2 compute.write action to open the governed detailed planner without keywords", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-v2-write",
      leaseAttempt: 1,
      runId: "run-v2-write",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-v2-write",
      contactId: "contact-v2-write",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-v2-write",
      userText: "按刚才确认的内容处理一下",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      skillPacks: [],
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(false);
    const v2Plan = v2ComputePlanFixture("write");
    mocks.planTurnV2.mockResolvedValueOnce({
      ok: true,
      plan: v2Plan,
      selectedCapabilities: [],
      provider: "openai",
      model: "planner-model",
    });
    const detailedStep = {
      capability: "write" as const,
      path: "notes/confirmed.txt",
      content: "confirmed content",
      summary: "保存已确认内容",
    };
    mocks.planNaturalLanguageComputeRequest.mockResolvedValueOnce({
      ok: true,
      plan: {
        kind: "execution",
        summary: "保存已确认内容",
        steps: [detailedStep],
      },
      source: "model",
    });
    mocks.buildComputeRequestsFromDelegationPlan.mockReturnValueOnce([{
      ...detailedStep,
      displayTarget: detailedStep.summary,
      hasPaidEntitlement: false,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    }]);
    mocks.createAudienceComputeSession.mockResolvedValueOnce({
      session: { id: "session-v2-write" },
    });
    mocks.executeAudienceTool.mockResolvedValueOnce({
      outcome: "completed",
      artifacts: [],
      billing: { computeCostCents: 4 },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "active_low_risk",
    })).resolves.toMatchObject({ processed: true, status: "completed" });

    // V2 opens the governed planner directly; the legacy keyword gate remains
    // a compatibility fallback and is not consulted for this turn.
    expect(mocks.shouldConsiderNaturalLanguageCompute).not.toHaveBeenCalled();
    expect(mocks.planNaturalLanguageComputeRequest).toHaveBeenCalledWith({
      userText: "按刚才确认的内容处理一下",
      maxSteps: 5,
    });
    expect(mocks.persistConversationTurnPlan).toHaveBeenCalledWith(
      expect.objectContaining({ plan: v2Plan, shadowMode: true }),
    );
    expect(mocks.createComputeDelegationTask).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "write" }),
    );
  });

  it("fails closed before task creation when V2 and detailed planner capabilities mismatch", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-v2-mismatch",
      leaseAttempt: 1,
      runId: "run-v2-mismatch",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-v2-mismatch",
      contactId: "contact-v2-mismatch",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-v2-mismatch",
      userText: "按刚才确认的内容处理一下",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      skillPacks: [],
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(false);
    mocks.planTurnV2.mockResolvedValueOnce({
      ok: true,
      plan: v2ComputePlanFixture("write"),
      selectedCapabilities: [],
      provider: "openai",
      model: "planner-model",
    });
    const mismatchedStep = {
      capability: "browser" as const,
      url: "https://example.com",
      summary: "打开网页",
    };
    mocks.planNaturalLanguageComputeRequest.mockResolvedValueOnce({
      ok: true,
      plan: {
        kind: "execution",
        summary: "打开网页",
        steps: [mismatchedStep],
      },
      source: "model",
    });
    mocks.buildComputeRequestsFromDelegationPlan.mockReturnValueOnce([{
      ...mismatchedStep,
      displayTarget: mismatchedStep.summary,
      hasPaidEntitlement: false,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    }]);

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      turnPlannerV2Mode: "active_low_risk",
    })).resolves.toMatchObject({ processed: true, status: "completed" });

    expect(mocks.planNaturalLanguageComputeRequest).toHaveBeenCalledOnce();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "delegation_failed",
        countUsage: false,
        replyText: expect.stringContaining("能力不一致"),
      }),
    );
    expect(mocks.createComputeDelegationTask).not.toHaveBeenCalled();
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
    expect(mocks.executeAudienceTool).not.toHaveBeenCalled();
    expect(mocks.waitGenerationRunForComputeApproval).not.toHaveBeenCalled();
  });

  it("marks a failed compute result as non-billable", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-compute-failed",
      runId: "run-compute-failed",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-compute-failed",
      contactId: "contact-compute-failed",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-compute-failed",
      userText: "/compute process npm test",
      channel: "web",
      usage: { freeRepliesUsed: 3, passUnlocked: true, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.parseComputeDirective.mockReturnValue({
      kind: "request",
      request: {
        capability: "process",
        command: "npm test",
        displayTarget: "npm test",
        hasPaidEntitlement: true,
        browserMode: "deterministic",
        maxSteps: 1,
        allowMutations: false,
      },
    });
    mocks.createAudienceComputeSession.mockResolvedValue({
      session: { id: "session-compute-failed" },
    });
    mocks.executeAudienceTool.mockResolvedValue({
      outcome: "failed",
      artifacts: [],
      billing: { computeCostCents: 4 },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.executeAudienceTool).toHaveBeenCalledWith(
      "session-compute-failed",
      expect.objectContaining({
        hasPaidEntitlement: false,
      }),
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      countUsage: false,
      replyText: expect.stringContaining("未能完成"),
    }));
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      outcome: "failed",
    }));
  });

  it("keeps natural-language requests as ordinary chat when task triggering is disabled", async () => {
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(true);
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      delegation: {
        enabled: true,
        naturalLanguageEnabled: false,
        explicitComputeEnabled: true,
        maxSteps: 5,
        maxEstimatedTokens: 0,
        knowledgeScope: "user_input_only",
      },
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.planNaturalLanguageComputeRequest).not.toHaveBeenCalled();
    expect(mocks.generateRepresentativeReply).toHaveBeenCalled();
  });

  it("explains that the advanced command is unavailable when /compute is disabled", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-command-disabled",
      runId: "run-command-disabled",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-command-disabled",
      contactId: "contact-command-disabled",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-command-disabled",
      userText: "/compute",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.parseComputeDirective.mockReturnValue({ kind: "help", examples: "/compute pwd" });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      delegation: {
        enabled: true,
        naturalLanguageEnabled: true,
        explicitComputeEnabled: false,
        maxSteps: 5,
        maxEstimatedTokens: 0,
        knowledgeScope: "user_input_only",
      },
      compute: { enabled: true, baseImage: "debian:bookworm-slim" },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      replyText: expect.stringContaining("未开放高级 /compute 命令"),
    }));
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
  });

  it("blocks a denied capability before creating a sandbox session", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-denied",
      runId: "run-denied",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-denied",
      contactId: "contact-denied",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-denied",
      userText: "/compute write notes/denied.txt ::: blocked",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.parseComputeDirective.mockReturnValue({
      kind: "request",
      request: {
        capability: "write",
        path: "notes/denied.txt",
        content: "blocked",
        displayTarget: "notes/denied.txt",
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      delegation: {
        enabled: true,
        naturalLanguageEnabled: true,
        explicitComputeEnabled: true,
        maxSteps: 5,
        maxEstimatedTokens: 0,
        knowledgeScope: "user_input_only",
      },
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
        capabilityModes: {
          exec: "ask",
          read: "allow",
          write: "deny",
          process: "ask",
          browser: "ask",
          mcp: "ask",
        },
      },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      countUsage: false,
      replyText: expect.stringContaining("策略禁止写入工作区文件"),
    }));
    expect(mocks.createComputeDelegationTask).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      outcome: "blocked",
      failureReason: "Representative policy denies write.",
    }));
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
  });

  it("keeps delegation planning isolated from the unaudited recall path", async () => {
    mocks.recallRepresentativeContext.mockResolvedValue({
      items: [
        {
          uri: "viking://resources/delegate/reps/sktone/knowledge/asset-1.md/asset-1.md",
          contextType: "resource",
          layer: "L2",
          score: 0.91,
          abstract: "佩奇临时代课并带大家画恐龙。",
          internalSource: { sourceKind: "PUBLIC_KNOWLEDGE" },
        },
        {
          uri: "viking://user/memories/delegate/memory-ns/contacts/contact-1/channels/web/memories/memory-1/versions/version-1.md",
          contextType: "memory",
          layer: "L2",
          score: 0.99,
          abstract: "PRIVATE CONTACT MEMORY MUST NOT ENTER DELEGATION",
          content: "PRIVATE CONTACT MEMORY MUST NOT ENTER DELEGATION",
          internalSource: {
            sourceKind: "CONTACT_MEMORY",
            memoryVersionId: "memory-version-1",
            projectionItemId: "projection-1",
            contentHash: "sha256-memory",
          },
        },
      ],
      citations: [{
        knowledgeAssetId: "asset-1",
        title: "佩奇当老师",
        excerpt: "佩奇临时代课并带大家画恐龙。",
        score: 0.91,
      }],
    });
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(true);
    mocks.planNaturalLanguageComputeRequest.mockResolvedValue({
      ok: true,
      source: "model",
      plan: {
        kind: "execution",
        summary: "生成公开资料摘要",
        steps: [{
          capability: "write",
          summary: "生成公开资料摘要",
          path: "outputs/public-summary.md",
          content: "# 摘要",
        }],
      },
    });
    mocks.buildComputeRequestsFromDelegationPlan.mockReturnValue([{
      capability: "write",
      displayTarget: "生成公开资料摘要",
      path: "outputs/public-summary.md",
      content: "# 摘要",
      estimatedTokens: 5,
    }]);
    mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-public-knowledge" } });
    mocks.executeAudienceTool.mockResolvedValue({ outcome: "completed", artifacts: [] });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      delegation: {
        enabled: true,
        naturalLanguageEnabled: true,
        explicitComputeEnabled: true,
        maxSteps: 3,
        maxEstimatedTokens: 0,
        knowledgeScope: "public_knowledge",
      },
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.planNaturalLanguageComputeRequest).toHaveBeenCalledWith({
      userText: "佩奇当老师时发生了什么？",
      maxSteps: 3,
    });
    expect(mocks.planNaturalLanguageComputeRequest.mock.calls[0]?.[0]?.userText).not.toContain(
      "PRIVATE CONTACT MEMORY",
    );
    expect(mocks.recallRepresentativeContext).not.toHaveBeenCalled();
    expect(mocks.createComputeDelegationTask.mock.calls[0]?.[0]).not.toHaveProperty(
      "authorizedKnowledge",
    );
  });

  it("stops a task whose estimate exceeds the representative token limit", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-cost",
      runId: "run-cost",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-cost",
      contactId: "contact-cost",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-cost",
      userText: "/compute write notes/cost.txt ::: expensive",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.parseComputeDirective.mockReturnValue({
      kind: "request",
      request: {
        capability: "write",
        path: "notes/cost.txt",
        content: "expensive",
        displayTarget: "notes/cost.txt",
        estimatedTokens: 12,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      delegation: {
        enabled: true,
        naturalLanguageEnabled: true,
        explicitComputeEnabled: true,
        maxSteps: 5,
        maxEstimatedTokens: 5,
        knowledgeScope: "user_input_only",
      },
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      countUsage: false,
      replyText: expect.stringContaining("超过该代表设置的 5 Token 上限"),
    }));
    expect(mocks.createComputeDelegationTask).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      outcome: "blocked",
      failureReason: expect.stringContaining("Estimated token usage 12"),
    }));
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
  });

  it("records a blocked task when the plan exceeds the representative step limit", async () => {
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(true);
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      delegation: {
        enabled: true,
        naturalLanguageEnabled: true,
        explicitComputeEnabled: true,
        maxSteps: 1,
        maxEstimatedTokens: 0,
        knowledgeScope: "user_input_only",
      },
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.planNaturalLanguageComputeRequest.mockResolvedValue({
      ok: true,
      source: "model",
      plan: {
        kind: "execution",
        summary: "生成两份文件",
        steps: [
          { capability: "write", summary: "生成第一份", path: "outputs/one.md", content: "one" },
          { capability: "write", summary: "生成第二份", path: "outputs/two.md", content: "two" },
        ],
      },
    });
    mocks.buildComputeRequestsFromDelegationPlan.mockReturnValue([
      { capability: "write", displayTarget: "生成第一份", path: "outputs/one.md", content: "one" },
      { capability: "write", displayTarget: "生成第二份", path: "outputs/two.md", content: "two" },
    ]);

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.createComputeDelegationTask).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      outcome: "blocked",
      failureReason: expect.stringContaining("Planned step count 2"),
    }));
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      countUsage: false,
      replyText: expect.stringContaining("超过该代表允许的 1 步上限"),
    }));
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
  });

  it("creates a clarifying task instead of inventing missing execution inputs", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-clarify",
      runId: "run-clarify",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-clarify",
      contactId: "contact-clarify",
      audienceIdentityId: "audience-clarify",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-clarify",
      userText: "帮我生成一个报告文件",
      channel: "web",
      usage: { freeRepliesUsed: 4, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(true);
    const clarificationReservation = {
      usageChargeId: "usage-clarify",
      tokenAmount: 1,
    };
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(
      clarificationReservation,
    );
    mocks.planNaturalLanguageComputeRequest.mockResolvedValue({
      ok: true,
      source: "deterministic",
      plan: {
        kind: "clarification",
        summary: "生成报告文件",
        question: "请补充目标路径和完整内容。",
        missingFields: ["path", "content"],
      },
    });
    mocks.createClarifyingDelegationTask.mockResolvedValue({ task: { id: "task-clarify" }, step: { id: "step-clarify" } });
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-clarify" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "waiting_input",
    });
    expect(mocks.createClarifyingDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      objective: "帮我生成一个报告文件",
      missingFields: ["path", "content"],
    }));
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        countUsage: false,
      }),
    );
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
  });

  it("keeps the conversation queued while a multi-step task schedules its next step", async () => {
    const request = {
      capability: "write",
      path: "notes/p1.txt",
      content: "P1",
      displayTarget: "写入 notes/p1.txt",
      hasPaidEntitlement: false,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-multi",
      runId: "run-multi",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-multi",
      contactId: "contact-multi",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-multi",
      userText: "/compute write notes/p1.txt ::: P1",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: true, baseImage: "debian:bookworm-slim", maxSessionMinutes: 15, networkMode: "no_network", filesystemMode: "workspace_only" },
    });
    mocks.parseComputeDirective.mockReturnValue({ kind: "request", request });
    mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-multi" } });
    mocks.executeAudienceTool.mockResolvedValue({ outcome: "completed", artifacts: [] });
    mocks.finalizeComputeDelegationTask.mockResolvedValue({ hasMoreSteps: true });
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-multi" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "step_completed",
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      keepConversationQueued: true,
    }));
  });

  it("executes a persisted next step on the existing task instead of creating another task", async () => {
    const request = {
      capability: "read",
      path: "notes/p1.txt",
      displayTarget: "读取 notes/p1.txt",
      hasPaidEntitlement: false,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-next-step",
      leaseAttempt: 4,
      runId: "run-next-step",
      delegationTaskId: "task-existing",
      delegationTaskStepId: "step-existing-2",
      contextSnapshot: { source: "delegation_plan_step", request },
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-next-step",
      contactId: "contact-next-step",
      controlState: "AI_QUEUED",
      inputMessageId: "message-original",
      userText: "生成并检查报告",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: true, baseImage: "debian:bookworm-slim", maxSessionMinutes: 15, networkMode: "no_network", filesystemMode: "workspace_only" },
    });
    mocks.readPersistedDelegationStepRequest.mockReturnValue(request);
    mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-next-step" } });
    mocks.executeAudienceTool.mockResolvedValue({ outcome: "completed", artifacts: [] });
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-next-step" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.createComputeDelegationTask).not.toHaveBeenCalled();
    expect(mocks.createAudienceComputeSession).toHaveBeenCalledWith(expect.objectContaining({
      delegationTaskId: "task-existing",
      delegationTaskStepId: "step-existing-2",
    }));
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-existing",
      stepId: "step-existing-2",
      generationRunId: "run-next-step",
      outboxId: "outbox-next-step",
      leaseAttempt: 4,
    }));
  });

  it("blocks the existing delegated step if Compute is disabled before it starts", async () => {
    const request = {
      capability: "read",
      path: "notes/p1.txt",
      displayTarget: "读取 notes/p1.txt",
      hasPaidEntitlement: false,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-disabled-step",
      runId: "run-disabled-step",
      delegationTaskId: "task-disabled",
      delegationTaskStepId: "step-disabled-2",
      contextSnapshot: { request },
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-disabled-step",
      contactId: "contact-disabled-step",
      controlState: "AI_QUEUED",
      inputMessageId: "message-original",
      userText: "生成并检查报告",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.readPersistedDelegationStepRequest.mockReturnValue(request);
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-disabled-step" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-disabled",
      stepId: "step-disabled-2",
      generationRunId: "run-disabled-step",
      outcome: "blocked",
    }));
  });

  it("marks a delegated task failed when the compute session cannot be created", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-failed",
      runId: "run-failed",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-failed",
      contactId: "contact-failed",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-failed",
      userText: "/compute read notes/missing.txt",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.parseComputeDirective.mockReturnValue({
      kind: "request",
      request: {
        capability: "read",
        path: "notes/missing.txt",
        hasPaidEntitlement: false,
        browserMode: "deterministic",
        maxSteps: 1,
        allowMutations: false,
        displayTarget: "notes/missing.txt",
      },
    });
    mocks.createAudienceComputeSession.mockRejectedValue(new Error("broker unavailable"));

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "failed",
      error: "broker unavailable",
    });
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith({
      taskId: "task-1",
      stepId: "task-step-1",
      generationRunId: "run-failed",
      outcome: "failed",
      failureReason: "broker unavailable",
    });
  });

  it("blocks an MCP request before task creation when the pinned version has no grant", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-mcp-unpublished",
      leaseAttempt: 1,
      runId: "run-mcp-unpublished",
      representativeVersionId: "version-old",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-mcp-unpublished",
      contactId: "contact-mcp-unpublished",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-mcp-unpublished",
      userText: "/compute mcp deepwiki ask_question ::: {\"repoName\":\"BIFNC-TEAM/Delegate\",\"question\":\"用途？\"}",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "full",
        filesystemMode: "workspace_only",
      },
    });
    mocks.parseComputeDirective.mockReturnValue({
      kind: "request",
      request: {
        capability: "mcp",
        bindingSlug: "deepwiki",
        toolName: "ask_question",
        toolArguments: {
          repoName: "BIFNC-TEAM/Delegate",
          question: "用途？",
        },
        estimatedTokens: 1_300,
        hasPaidEntitlement: false,
        browserMode: "deterministic",
        maxSteps: 1,
        allowMutations: false,
        displayTarget: "deepwiki:ask_question",
      },
    });
    mocks.getRepresentativeRuntimeAuthoritySnapshot.mockResolvedValue({
      representativeVersionId: "version-old",
      mcpBindings: [],
    });
    mocks.completeInlineGenerationRun.mockResolvedValue({
      message: { id: "reply-mcp-unpublished" },
    });

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.createComputeDelegationTask).not.toHaveBeenCalled();
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        replyText: expect.stringContaining("当前会话固定的代表版本尚未包含这个 MCP 连接"),
        countUsage: false,
      }),
    );
  });

  it("leaves an already in-flight delegated execution for lease recovery", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-execution-in-progress",
      leaseAttempt: 7,
      runId: "run-execution-in-progress",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-execution-in-progress",
      contactId: "contact-execution-in-progress",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-execution-in-progress",
      userText: "/compute read notes/report.txt",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.parseComputeDirective.mockReturnValue({
      kind: "request",
      request: {
        capability: "read",
        path: "notes/report.txt",
        hasPaidEntitlement: false,
        browserMode: "deterministic",
        maxSteps: 1,
        allowMutations: false,
        displayTarget: "notes/report.txt",
      },
    });
    mocks.createAudienceComputeSession.mockResolvedValue({
      session: { id: "session-execution-in-progress" },
    });
    mocks.executeAudienceTool.mockRejectedValue(Object.assign(
      new Error("This delegated execution is still in progress."),
      { code: "generation_execution_in_progress" },
    ));

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "run-execution-in-progress",
      status: "execution_in_progress",
    });

    expect(mocks.finalizeComputeDelegationTask).not.toHaveBeenCalled();
    expect(mocks.failGenerationRun).not.toHaveBeenCalled();
    expect(mocks.retryGenerationDelivery).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).not.toHaveBeenCalled();
    expect(mocks.markGenerationDeliveryComplete).not.toHaveBeenCalled();

    mocks.executeAudienceTool.mockRejectedValue(Object.assign(
      new Error("A newer recovery attempt owns this execution."),
      { code: "compute_execution_claim_lost" },
    ));
    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "run-execution-in-progress",
      status: "lease_lost",
    });
    expect(mocks.finalizeComputeDelegationTask).not.toHaveBeenCalled();
    expect(mocks.failGenerationRun).not.toHaveBeenCalled();
    expect(mocks.retryGenerationDelivery).not.toHaveBeenCalled();
  });

  it("returns a terminal task error instead of retrying a user-correctable sandbox path", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-invalid-path",
      runId: "run-invalid-path",
      delegationTaskId: "task-invalid-path",
      delegationTaskStepId: "step-invalid-path",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-invalid-path",
      contactId: "contact-invalid-path",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-invalid-path",
      userText: "路径 /AL，内容 佩奇爱上学",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.parseComputeDirective.mockReturnValue({
      kind: "request",
      request: {
        capability: "write",
        path: "/AL",
        content: "佩奇爱上学",
        hasPaidEntitlement: false,
        browserMode: "deterministic",
        maxSteps: 1,
        allowMutations: false,
        displayTarget: "写入文件",
      },
    });
    mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-invalid-path" } });
    mocks.executeAudienceTool.mockRejectedValue(new Error("path_outside_allowed_workspace"));
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-invalid-path" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      intent: "delegation_failed",
      countUsage: false,
      replyText: expect.stringContaining("无需提供沙盒路径"),
    }));
    expect(mocks.failGenerationRun).not.toHaveBeenCalled();
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
  });

  it("never downgrades a bound delegation retry into an ordinary knowledge answer", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-delegation-retry",
      runId: "run-delegation-retry",
      delegationTaskId: "task-failed",
      delegationTaskStepId: "step-failed",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-delegation-retry",
      contactId: "contact-delegation-retry",
      controlState: "FAILED",
      inputMessageId: "message-delegation-retry",
      userText: "路径 /AL，内容 佩奇爱上学",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-delegation-retry" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      intent: "delegation_failed",
      countUsage: false,
    }));
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-failed",
      stepId: "step-failed",
      generationRunId: "run-delegation-retry",
      outcome: "failed",
    }));
    expect(mocks.recallRepresentativeContext).not.toHaveBeenCalled();
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
  });

  it("stops attempt A after lease loss and lets reclaimed attempt B commit", async () => {
    vi.useFakeTimers();
    const baseItem = {
      runId: "run-reclaimed",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-reclaimed",
      contactId: "contact-reclaimed",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-reclaimed",
      userText: "请回答",
      channel: "web",
      usage: {
        freeRepliesUsed: 0,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    };
    mocks.claimNextGenerationWorkItem
      .mockResolvedValueOnce({
        ...baseItem,
        outboxId: "outbox-reclaimed",
        leaseAttempt: 1,
      })
      .mockResolvedValueOnce({
        ...baseItem,
        outboxId: "outbox-reclaimed",
        leaseAttempt: 2,
      });
    mocks.renewGenerationWorkItemLease
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    let releaseAttemptA!: (value: {
      ok: true;
      replyText: string;
      provider: "openai";
      model: string;
      contextTrace: { selectedRecallUris: string[] };
    }) => void;
    mocks.generateRepresentativeReply.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseAttemptA = resolve;
      }),
    );

    const attemptA = processNextConversationWork({ port: 4040, pollMs: 500 });
    await vi.waitFor(() => {
      expect(mocks.generateRepresentativeReply).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    releaseAttemptA({
      ok: true,
      replyText: "attempt A stale reply",
      provider: "openai",
      model: "test-model",
      contextTrace: { selectedRecallUris: [] },
    });

    await expect(attemptA).resolves.toMatchObject({
      processed: true,
      runId: "run-reclaimed",
      status: "lease_lost",
    });
    expect(mocks.completeInlineGenerationRun).not.toHaveBeenCalled();
    expect(mocks.failGenerationRun).not.toHaveBeenCalled();
    expect(mocks.retryGenerationDelivery).not.toHaveBeenCalled();

    mocks.generateRepresentativeReply.mockResolvedValueOnce({
      ok: true,
      replyText: "attempt B authoritative reply",
      provider: "openai",
      model: "test-model",
      contextTrace: { selectedRecallUris: [] },
    });
    mocks.completeInlineGenerationRun.mockResolvedValueOnce({
      message: { id: "reply-reclaimed" },
    });

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "run-reclaimed",
      status: "completed",
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-reclaimed",
        outboxId: "outbox-reclaimed",
        leaseAttempt: 2,
        replyText: "attempt B authoritative reply",
      }),
    );
    expect(
      mocks.prepareGenerationMessageChannelDelivery,
    ).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-reclaimed",
      outboxId: "outbox-reclaimed",
      leaseAttempt: 2,
      outputMessageId: "reply-reclaimed",
    }));
    expect(mocks.markGenerationDeliveryComplete).toHaveBeenCalledWith({
      runId: "run-reclaimed",
      outboxId: "outbox-reclaimed",
      leaseAttempt: 2,
      outputMessageId: "reply-reclaimed",
      deliveryAdmission: {
        attemptNumber: 1,
        leaseToken: "delivery-lease-1",
      },
    });
  });
});

function managedDocumentPlanFixture() {
  return {
    protocolVersion: 2,
    planId: "turn-plan-run-1-1",
    objective: "生成地理学习教程文件",
    mode: "execute",
    goals: [{ id: "goal-1", description: "生成教程", priority: 100 }],
    deliverables: [{
      id: "deliverable-1",
      kind: "artifact",
      format: "markdown",
      producedByActionIds: ["action-document"],
      completionCriteria: ["返回可下载文档"],
    }],
    uncertainties: [],
    questions: [],
    actions: [{
      id: "action-document",
      capability: {
        key: "artifact.generate_document",
        version: "1",
        definitionHash: `sha256:${"b".repeat(64)}`,
      },
      arguments: { topic: "地理学习教程", format: "markdown" },
      argumentProvenance: {},
      dependsOn: [],
      expectedOutputSchema: {},
      completionCriteria: ["正文非空"],
      onFailure: "stop",
    }],
  };
}

function configureMixedKnowledgeMcpV3(input: { knowledge: "hit" | "miss" }) {
  const definitionHash = `sha256:${"b".repeat(64)}`;
  const item = {
    outboxId: "outbox-v3-mixed",
    leaseAttempt: 1,
    runId: "run-v3-mixed",
    representativeVersionId: "version-1",
    representativeSlug: "sktone",
    representativeName: "SKTone",
    conversationId: "conversation-v3-mixed",
    contactId: "contact-v3-mixed",
    controlState: "AI_ACTIVE",
    inputMessageId: "message-v3-mixed",
    userText: "结合我的授权资料和外部工具查询后回答",
    channel: "web",
    usage: { freeRepliesUsed: 0, passUnlocked: true, deepHelpUnlocked: false },
  };
  const setup = {
    id: "rep-1",
    name: "SKTone",
    ownerName: "Owner",
    tagline: "Representative",
    tone: "direct",
    languages: ["zh"],
    skillPacks: [],
    knowledgePackRevision: 1,
    knowledgePack: {
      identitySummary: "Test representative",
      faq: [],
      materials: [],
      policies: [],
    },
    compute: {
      enabled: true,
      baseImage: "debian:bookworm-slim",
      maxSessionMinutes: 15,
      artifactRetentionDays: 14,
      networkMode: "no_network",
      filesystemMode: "workspace_only",
      capabilityModes: {
        exec: "deny",
        read: "allow",
        write: "ask",
        process: "deny",
        browser: "deny",
        mcp: "allow",
      },
    },
    delegation: {
      enabled: true,
      naturalLanguageEnabled: true,
      explicitComputeEnabled: true,
      maxSteps: 5,
      maxEstimatedTokens: 10_000,
      knowledgeScope: "user_input_only",
    },
  };
  const authority = {
    representativeVersionId: "version-1",
    compute: setup.compute,
    delegation: setup.delegation,
    mcpBindings: [{
      id: "binding-1",
      slug: "deepwiki",
      allowedToolNames: ["ask_question"],
      defaultToolName: "ask_question",
      enabled: true,
      approvalRequired: false,
      estimatedTokensPerCall: 100,
      maxRetries: 0,
      retryBackoffMs: 1_000,
      serverUrl: "https://mcp.example.test",
      transportKind: "streamable_http",
      toolDefinitions: [{
        exactToolName: "ask_question",
        description: "Search external documentation.",
        inputSchema: {
          type: "object",
          properties: { question: { type: "string" } },
          required: ["question"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { result: {} },
          required: ["result"],
          additionalProperties: false,
        },
        toolSchemaHash: `sha256:${"c".repeat(64)}`,
        bindingDefinitionHash: `sha256:${"d".repeat(64)}`,
        bindingRevision: 3,
        canonicalizationVersion: "delegate-capability-v1",
      }],
    }],
  };
  let plan: Record<string, any>;
  let mcpDefinition: Record<string, any> = {
    ...mixedMcpDefinition({
      evidenceClasses: ["capability_result"],
      authorityClasses: ["external_authoritative"],
      definitionHash: `sha256:${"c".repeat(64)}`,
    }),
    key: "mcp.deepwiki.ask_question",
  };
  let knowledgeDefinition: Record<string, any> = {
    key: "knowledge.retrieve_authorized",
    version: "1",
    executor: "knowledge",
    definitionHash: `sha256:${"a".repeat(64)}`,
    semantics: {
      evidenceClasses: ["authorized_knowledge"],
      authorityClasses: ["owner_authorized"],
      freshnessClasses: ["bounded"],
      operations: ["search"],
      domains: ["owner knowledge"],
      aliases: [],
    },
  };
  mocks.claimNextGenerationWorkItem.mockResolvedValue(item);
  mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue(setup);
  mocks.getRepresentativeRuntimeAuthoritySnapshot.mockResolvedValue(authority);
  mocks.buildCapabilityCatalogV3.mockImplementation((drafts) => ({
    protocolVersion: 2,
    canonicalizationVersion: "delegate-capability-v1",
    catalogHash: `sha256:${"e".repeat(64)}`,
    capabilities: drafts.map((draft: Record<string, unknown>) => ({
      ...draft,
      definitionHash: draft["key"] === "knowledge.retrieve_authorized"
        ? `sha256:${"a".repeat(64)}`
        : draft["key"] === "mcp.deepwiki.ask_question"
          ? `sha256:${"c".repeat(64)}`
          : definitionHash,
    })),
  }));
  mocks.planTurnV3.mockImplementation(async ({ catalog, scopeKey, planId }) => {
    const knowledge = catalog.capabilities.find((candidate: { key: string }) =>
      candidate.key === "knowledge.retrieve_authorized");
    knowledgeDefinition = knowledge;
    const mcp = catalog.capabilities.find((candidate: { key: string }) =>
      candidate.key === "mcp.deepwiki.ask_question");
    const compose = catalog.capabilities.find((candidate: { key: string }) =>
      candidate.key === "response.compose");
    mcpDefinition = mcp;
    plan = {
      protocolVersion: 3,
      planId: "turn-plan-v3-mixed",
      scopeKey,
      revision: 1,
      envelopeHash: `sha256:${"f".repeat(64)}`,
      capabilityCatalogHash: catalog.catalogHash,
      validationPolicyVersion: "turn-plan-v3-policy.2",
      objective: "Use knowledge and an external capability",
      goals: [{
        id: "goal-knowledge",
        objective: "Check Owner knowledge",
        sourcePointers: ["/currentMessage/text"],
        strategy: "knowledge",
        operation: "search",
        semanticConfidence: 0.95,
        generalEligibility: "allowed",
        actionIds: ["knowledge", "compose"],
        deliverableIds: [],
        evidenceRequirement: {
          kind: "knowledge_preferred",
          freshness: "bounded",
          allowedSourceKinds: ["authorized_knowledge"],
          citationRequired: false,
          minimumEvidenceCount: 0,
        },
        evidenceFallbackPolicy: {
          kind: "authorized_knowledge_miss_to_stable_general",
          policySource: "server_planning_default",
          activationStatuses: ["not_found", "unavailable"],
          authorityBoundary: "non_owner_specific_stable_general",
          disclosureRequired: true,
        },
        sourceAuthorityBoundary: {
          classification: "stable_general_allowed",
          policySource: "server_authority_policy",
          policyVersion: "delegate.source-authority.v1",
          reasonCodes: ["no_owner_authority_signal"],
        },
        failurePolicy: { strategy: "stop", reasonCode: "knowledge_failed" },
      }, {
        id: "goal-tool",
        objective: "Use external evidence",
        sourcePointers: ["/currentMessage/text"],
        strategy: "capability",
        operation: "search",
        semanticConfidence: 0.95,
        generalEligibility: "not_allowed",
        actionIds: ["lookup", "compose"],
        deliverableIds: [],
        evidenceRequirement: {
          kind: "capability_result",
          freshness: "bounded",
          allowedSourceKinds: ["mcp"],
          citationRequired: true,
          minimumEvidenceCount: 1,
        },
        failurePolicy: { strategy: "stop", reasonCode: "tool_failed" },
      }],
      actions: [{
        id: "knowledge",
        capability: {
          key: knowledge.key,
          version: knowledge.version,
          definitionHash: knowledge.definitionHash,
        },
        arguments: { question: item.userText },
        argumentProvenance: {
          question: { source: "user_message", pointer: "/currentMessage/text" },
        },
        dependencies: [],
        activation: { mode: "primary" },
        expectedOutputSchema: knowledge.outputSchema,
        completionCriteria: ["Knowledge probe verified"],
        failurePolicy: { strategy: "stop", publicMessageCode: "knowledge_failed" },
      }, {
        id: "lookup",
        capability: {
          key: mcp.key,
          version: mcp.version,
          definitionHash: mcp.definitionHash,
        },
        arguments: { question: item.userText },
        argumentProvenance: {
          question: { source: "user_message", pointer: "/currentMessage/text" },
        },
        dependencies: [{ actionId: "knowledge", allowedStatuses: ["succeeded"] }],
        activation: { mode: "primary" },
        expectedOutputSchema: mcp.outputSchema,
        completionCriteria: ["Tool result verified"],
        failurePolicy: { strategy: "stop", publicMessageCode: "tool_failed" },
      }, {
        id: "compose",
        capability: {
          key: compose.key,
          version: compose.version,
          definitionHash: compose.definitionHash,
        },
        arguments: {},
        argumentProvenance: {},
        dependencies: [{
          actionId: "knowledge",
          allowedStatuses: ["succeeded"],
        }, {
          actionId: "lookup",
          allowedStatuses: ["succeeded", "failed", "reconciliation_required"],
        }],
        activation: { mode: "primary" },
        expectedOutputSchema: compose.outputSchema,
        completionCriteria: ["Response verified"],
        failurePolicy: { strategy: "stop", publicMessageCode: "compose_failed" },
      }],
      deliverables: [],
      decisionTrace: ["mixed_knowledge_and_capability"],
    };
    return {
      ok: true,
      provider: "agicto",
      model: "planner-test",
      selectedCapabilities: [knowledge, mcp, compose],
      proposal: { protocolVersion: 3, objective: plan.objective },
      plan,
    };
  });
  mocks.persistConversationTurnPlanV3.mockImplementation(async () => ({
    id: "turn-plan-v3-mixed",
    revision: 1,
    executionEpoch: 1,
    generationRunId: item.runId,
    actions: [{ id: "plan-action-knowledge", actionKey: "knowledge" }, {
      id: "plan-action-lookup",
      actionKey: "lookup",
    }, { id: "plan-action-compose", actionKey: "compose" }],
  }));
  mocks.recordConversationPlanActionAuthorization.mockResolvedValue({ sequence: 3 });
  mocks.prepareV3InlineAction
    .mockResolvedValueOnce({ attempt: { id: "attempt-knowledge-mixed", status: "RUNNING", executionLeaseToken: "inline-lease-knowledge-mixed" } })
    .mockResolvedValueOnce({ attempt: { id: "attempt-compose-mixed", status: "RUNNING", executionLeaseToken: "inline-lease-compose-mixed" } });
  mocks.completeV3InlineAction.mockResolvedValue({
    actionStatus: "SUCCEEDED",
    verified: { semanticOutcome: "succeeded" },
  });
  const knowledgeItems = input.knowledge === "hit"
    ? [{
        memoryUseItemId: "memory-item-mixed",
        abstract: "Owner-authorized knowledge.",
        internalSource: { publicResourceKey: "knowledge/topic.md" },
      }]
    : [];
  mocks.recallRepresentativeContext.mockResolvedValue({
    items: knowledgeItems,
    citations: [],
    memoryUseRunId: "memory-run-mixed",
  });
  mocks.compileCapabilityAction.mockImplementation(({ definition }) => ({
    planId: "turn-plan-v3-mixed",
    planRevision: 1,
    executionEpoch: 1,
    actionId: "plan-action-lookup",
    generationRunId: item.runId,
    capabilityKey: definition.key,
    capabilityVersion: definition.version,
    capabilityDefinitionHash: definition.definitionHash,
    argumentsHash: `sha256:${"1".repeat(64)}`,
    idempotencyKey: "turn-plan:mixed:lookup",
    executor: "mcp",
    bindingId: "binding-1",
    bindingRevision: 3,
    toolName: "ask_question",
    expectedToolSchemaHash: `sha256:${"c".repeat(64)}`,
    expectedBindingDefinitionHash: `sha256:${"d".repeat(64)}`,
    toolArguments: { question: item.userText },
  }));
  mocks.createComputeDelegationTask.mockResolvedValue({
    task: { id: "task-v3-mixed" },
    step: { id: "task-step-v3-mixed" },
  });
  mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-v3-mixed" } });
  mocks.executeAudienceTool.mockResolvedValue({
    outcome: "completed",
    execution: {
      semanticOutcome: "succeeded",
      transportOutcome: "response_received",
    },
    artifacts: [],
  });
  mocks.finalizeComputeDelegationTask.mockResolvedValue({ hasMoreSteps: false });
  mocks.loadV3GovernedCompositionContext.mockImplementation(async () => {
    const knowledgeOutput = {
      status: input.knowledge === "hit" ? "found" : "not_found",
      evidenceRefs: knowledgeItems.map((entry) => entry.memoryUseItemId),
      items: knowledgeItems.map((entry) => ({
        evidenceId: entry.memoryUseItemId,
        content: entry.abstract,
      })),
    };
    return {
      plan: {
        id: "turn-plan-v3-mixed",
        executionEpoch: 1,
        plannerProvider: "agicto",
        plannerModel: "planner-test",
        plannerProposalSnapshot: {
          capabilityDefinitions: [knowledgeDefinition, mcpDefinition],
          candidateSnapshot: { candidates: [{ definition: mcpDefinition }] },
        },
        actions: [{
          id: "plan-action-knowledge",
          actionKey: "knowledge",
          capabilityKey: "knowledge.retrieve_authorized",
          capabilityDefinitionHash: knowledgeDefinition.definitionHash,
          status: "SUCCEEDED",
          actionResults: [{
            id: "result-knowledge-mixed",
            semanticOutcome: "succeeded",
            transportOutcome: "response_received",
            output: knowledgeOutput,
            failure: null,
            evidenceBindings: knowledgeItems.map((entry) => ({
              evidenceId: entry.memoryUseItemId,
              evidenceClass: "authorized_knowledge",
            })),
          }],
        }, {
          id: "plan-action-lookup",
          actionKey: "lookup",
          capabilityKey: mcpDefinition.key,
          capabilityDefinitionHash: mcpDefinition.definitionHash,
          status: "SUCCEEDED",
          actionResults: [{
            id: "result-mcp-mixed",
            semanticOutcome: "succeeded",
            transportOutcome: "response_received",
            output: { result: "Verified external result." },
            failure: null,
            evidenceBindings: [],
          }],
        }, {
          id: "plan-action-compose",
          actionKey: "compose",
          capabilityKey: "response.compose",
          capabilityDefinitionHash: definitionHash,
          status: "READY",
          actionResults: [],
        }],
      },
      parsedPlan: plan,
      composeDefinition: plan.actions[2],
      composeAction: { id: "plan-action-compose", actionKey: "compose" },
    };
  });
  mocks.composeTurnV3.mockResolvedValue({
    ok: true,
    provider: "agicto",
    model: "composer-test",
    draft: {
      segments: [{
        kind: "claim",
        goalId: "goal-tool",
        text: "Combined verified answer.",
        sourceClass: "tool_output",
        evidenceRefs: ["result-mcp-mixed"],
      }],
    },
  });
  mocks.completeInlineGenerationRun.mockResolvedValue({
    message: { id: "reply-v3-mixed", text: "Combined verified answer." },
  });
  return {
    item,
    async initializeResumePlan() {
      await mocks.planTurnV3({
        catalog: {
          capabilities: [{
            ...knowledgeDefinition,
            outputSchema: {
              type: "object",
              properties: {},
              additionalProperties: true,
            },
          }, mcpDefinition, {
            key: "response.compose",
            version: "1",
            definitionHash,
            outputSchema: {
              type: "object",
              properties: { segments: { type: "array" } },
              required: ["segments"],
            },
          }],
        },
        scopeKey: {
          kind: "generation_turn",
          conversationId: item.conversationId,
          inputMessageId: item.inputMessageId,
        },
        planId: "turn-plan-v3-mixed",
      });
      mocks.planTurnV3.mockClear();
    },
  };
}

function mixedMcpDefinition(input: {
  evidenceClasses: string[];
  authorityClasses: string[];
  definitionHash?: string;
}) {
  return {
    key: input.definitionHash ? "mcp.external.ordinary" : "mcp.external.transactional",
    version: "1",
    description: "External capability.",
    executor: "mcp",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { result: {} },
      required: ["result"],
      additionalProperties: false,
    },
    effect: { boundary: "external", mutation: "write", reversibility: "unknown" },
    idempotency: "non_idempotent",
    supportedChannels: ["web"],
    requiredIdentityScopes: [],
    requiredDataScopes: [],
    tags: [],
    semantics: {
      operations: ["read"],
      evidenceClasses: input.evidenceClasses,
      freshnessClasses: ["live"],
      authorityClasses: input.authorityClasses,
      domains: [],
      aliases: [],
    },
    canonicalizationVersion: "delegate-capability-v1",
    mcpToolSchemaHash: `sha256:${"7".repeat(64)}`,
    bindingDefinitionHash: `sha256:${"8".repeat(64)}`,
    definitionHash: input.definitionHash ?? `sha256:${"6".repeat(64)}`,
  };
}

function v2ComputePlanFixture(
  capability: "exec" | "read" | "write" | "process" | "browser",
) {
  const actionId = `action-compute-${capability}`;
  return {
    protocolVersion: 2,
    planId: `turn-plan-compute-${capability}`,
    objective: "执行受治理的详细任务",
    mode: "execute",
    goals: [{ id: "goal-compute", description: "执行任务", priority: 100 }],
    deliverables: [{
      id: "deliverable-compute",
      kind: "external_result",
      format: null,
      producedByActionIds: [actionId],
      completionCriteria: ["详细执行结果已验证"],
    }],
    uncertainties: [],
    questions: [],
    actions: [{
      id: actionId,
      capability: {
        key: `compute.${capability}`,
        version: "1",
        definitionHash: `sha256:${"c".repeat(64)}`,
      },
      arguments: { request: "按刚才确认的内容处理一下" },
      argumentProvenance: {
        request: { source: "user_message", pointer: "/currentMessage/text" },
      },
      dependsOn: [],
      expectedOutputSchema: {},
      completionCriteria: ["详细规划器与 V2 能力一致"],
      onFailure: "stop",
    }],
  };
}

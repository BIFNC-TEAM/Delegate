import {
  generateManagedDocument,
  generateRepresentativeReply,
  composeTurnV3,
  buildCapabilityDiscoveryDocumentV3,
  planTurnV2,
  planTurnV3,
  planNaturalLanguageComputeRequest,
  type ModelRuntimeState,
} from "@delegate/model-runtime";
import {
  buildComputeRequestsFromDelegationPlan,
  buildCapabilityCatalog,
  buildCapabilityCatalogV3,
  buildCapabilityAvailabilitySnapshotV3,
  capabilityDefinitionV3Schema,
  CAPABILITY_CANONICALIZATION_VERSION_V3,
  advanceStructuredCollector,
  beginStructuredCollector,
  authorizeConversationAction,
  buildRecentConversationRecallReply,
  createConversationPlan,
  createCapabilityCompilerRegistryFromPublicationsV3,
  deriveTurnConstraintsFromMessage,
  formatStructuredCollectorPrompt,
  formatStructuredCollectorSummary,
  hasMatchedExecutableSkill,
  isConversationCancellationRequest,
  parseComputeDirective,
  renderFailClosedReplyPreview,
  renderReplyPreview,
  readStructuredCollectorState,
  readPersistedDelegationStepRequest,
  resolveComputeSubagent,
  resolveConversationSubagent,
  shouldStartStructuredCollector,
  shouldConsiderNaturalLanguageCompute,
  stableSha256,
  resolveComposerSourceGoalOutcomesV3,
  turnEnvelopeSchema,
  validateJsonSchemaValue,
  validateComposedMessageDraftV3,
  validateTurnPlanV2,
  validateTurnPlanV3,
  type CapabilityDescriptorDraft,
  type ParsedComputeRequest,
  type ConversationActionExecutionResult,
  type ConversationPlan,
  type ConversationTurnTrace,
  type PlannedConversationAction,
  type StructuredCollectorState,
  type TurnPlanV2,
  type ComposedMessageDraftV3,
  type CapabilityExecutionRequest,
  type CapabilityPublicationV3,
  type PlanActionV3,
  type TurnPlanV3,
  type ComposerEvidenceReferenceV3,
  type KnowledgeFallbackActivationV3,
} from "@delegate/runtime";
import {
  buildMcpToolCapabilityPublicationV3,
  admitGenerationMessageProviderDelivery,
  buildRepresentativeRuntimeProfile,
  assertConversationChannelDeliveryAvailable,
  authorizeGenerationRunFreeUsage,
  authorizeGenerationRunMcpNoCharge,
  claimNextConversationMessageDeliveryWorkItem,
  claimNextOperatorMessageWorkItem,
  claimNextGenerationWorkItem,
  completeConversationMessageDelivery,
  completeOperatorMessageDelivery,
  completeConversationIntake,
  completeConversationTurnPlan,
  completeReadyConversationTurnPlanForGenerationRun,
  completeInlineGenerationRun,
  contactMemorySharingConsentContractVersion,
  ContactMemorySharingError,
  createComputeDelegationTask,
  createManagedConversationDocumentArtifact,
  prepareManagedConversationDocumentArtifact,
  createClarifyingDelegationTask,
  createAudienceComputeSession,
  clearConversationCollectorState,
  createContactMemorySharingChallenge,
  deferOperatorMessageDelivery,
  deferConversationMessageDelivery,
  deferGenerationRunForHuman,
  executeAudienceTool,
  failGenerationRun,
  failConversationTurnPlan,
  failActiveV3InlinePlanExecution,
  failV3InlinePlanExecution,
  getRepresentativeRuntimeSetupSnapshot,
  getRepresentativeRuntimeAuthoritySnapshot,
  grantContactMemorySharingConsent,
  hasPersistedTelegramBotConnections,
  isDeterministicContactMemoryDeleteCommand,
  matrixServerNameFromUserId,
  loadGenerationRecentTurns,
  loadV3GovernedCompositionContext,
  loadLatestConversationTurnPlanRevision,
  loadReplayableConversationTurnPlan,
  loadReplayableConversationTurnPlanV3,
  loadConversationOperationalContext,
  markGenerationDeliveryComplete,
  markDelegationTaskAwaitingApproval,
  markDelegationTaskRunning,
  GENERATION_WORK_LEASE_DURATION_MS,
  GenerationMemoryDeliveryBlockedError,
  GenerationPlanDeliverySupersededError,
  GenerationWorkLeaseLostError,
  finalizeComputeDelegationTask,
  findConversationCancelableDelegationTask,
  findConversationClarifyingDelegationTask,
  isGenerationMemoryDeliveryBlockedError,
  isGenerationPlanDeliverySupersededError,
  isGenerationWorkLeaseLostError,
  continueClarifyingDelegationTask,
  probeRepresentativeKnowledgeMetadata,
  recallRepresentativeContext,
  applyRepresentativeDelegationTaskAction,
  prepareGenerationMessageChannelDelivery,
  prepareV3InlineAction,
  markV3InlineActionCallStarted,
  completeV3InlineAction,
  recordConversationMessageProviderAcceptance,
  recordGenerationMessageProviderAcceptance,
  recordOperatorMessageProviderAcceptance,
  persistConversationTurnPlan,
  persistConversationTurnPlanV3,
  persistConversationTurnPlannerFailure,
  persistConversationTurnPlannerFailureV3,
  recordConversationPlanActionAuthorization,
  generalModelAnswerSourceStatement,
  privateChannelSourceVerificationUnavailableStatement,
  readContactMemorySharingChallengeToken,
  resolveGovernedPublicMaterialDeliveries,
  reserveGenerationConversationWalletUsage,
  renderPrivateChannelGenerationDeliveryText,
  renewGenerationWorkItemLease,
  resolveDeterministicContactMemorySharingCommand,
  resolveRepresentativeComputeApproval,
  revokeContactMemorySharingConsent,
  retryGenerationDelivery,
  retryConversationMessageDelivery,
  retryOperatorMessageDelivery,
  setConversationCollectorState,
  updateGenerationTurnExecutionProgress,
  resolveTelegramBotRuntimeCredential,
  withActiveTelegramRepresentativeChannelFence,
  withGenerationMessageProviderDeliveryFence,
  waitGenerationRunForComputeApproval,
  type AuthorizedDelegationKnowledge,
  type ConversationEntitlementReservation,
  type GenerationMessageDeliveryAdmission,
  type GenerationRuntimeOutcome,
} from "@delegate/web-data";

import {
  resolveTurnPlannerRunPolicy,
  type ConversationWorkerConfig,
} from "./config";
import {
  isComputeExecutionClaimLostError,
  isComputeGenerationExecutionInProgressError,
} from "./compute-client";
import { sendMatrixRepresentativeMessage } from "./matrix-outbound";

function resolveFallbackReason(
  state: ModelRuntimeState,
): Extract<GenerationRuntimeOutcome, { mode: "fallback" }>["fallbackReason"] {
  if (
    state === "disabled"
    || state === "missing_credentials"
    || state === "unsupported_provider"
  ) {
    return "model_unavailable";
  }
  if (state === "invalid_subagent_route") {
    return "policy_fallback";
  }
  return "provider_failed";
}

function isCollectorCancelMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === "取消" || normalized === "cancel" || normalized === "stop";
}

function isV2ActiveLowRisk(config: ConversationWorkerConfig) {
  const v3Mode = config.turnPlannerV3Mode ?? "disabled";
  return (config.turnPlannerV2Mode ?? "disabled") === "active_low_risk"
    && (v3Mode === "disabled" || v3Mode === "shadow");
}

const turnPlannerPromptVersion = "turn-planner.v2.strict.1";

async function buildTurnPlanningContext(input: {
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  activeCollector: StructuredCollectorState | null;
}) {
  const [authority, recentTurns, operationalContext] = await Promise.all([
    getRepresentativeRuntimeAuthoritySnapshot(
      input.item.representativeSlug,
      input.item.representativeVersionId,
    ),
    loadGenerationRecentTurns({
      representativeId: input.setup.id,
      conversationId: input.item.conversationId,
      beforeMessageId: input.item.inputMessageId,
    }),
    loadConversationOperationalContext({
      representativeId: input.setup.id,
      conversationId: input.item.conversationId,
      ...(input.item.audienceIdentityId
        ? { audienceIdentityId: input.item.audienceIdentityId }
        : {}),
    }),
  ]);
  const catalog = buildCapabilityCatalog({
    skills: buildSkillCapabilityDrafts(input.setup.skillPacks),
    mcp: buildMcpCapabilityDrafts(authority?.mcpBindings ?? []),
    compute: buildComputeCapabilityDrafts(authority?.compute),
  });
  const envelope = turnEnvelopeSchema.parse({
    currentMessage: {
      id: input.item.inputMessageId,
      text: input.item.userText,
      language: /\p{Script=Han}/u.test(input.item.userText) ? "zh" : "en",
    },
    attachments: (input.item.inputAttachments ?? []).map((attachment) => ({
      ...attachment,
      trustClass: "untrusted_user_input" as const,
    })),
    recentTurns: recentTurns.map((turn, index) => ({
      id: "id" in turn && typeof turn.id === "string"
        ? turn.id
        : `recent-${index + 1}`,
      direction: turn.direction,
      text: turn.messageText,
      createdAt: "createdAt" in turn && typeof turn.createdAt === "string"
        ? turn.createdAt
        : new Date(0).toISOString(),
      trustClass: "untrusted_conversation_data" as const,
    })),
    conversationSummary: null,
    activeCollector: input.activeCollector,
    activeTask: operationalContext?.latestTask ?? null,
    pendingApproval: operationalContext?.pendingApproval ?? null,
    activeHandoff: operationalContext?.activeHandoff ?? null,
    actorIdentity: {
      contactId: input.item.contactId,
      audienceIdentityId: input.item.audienceIdentityId ?? null,
      sourceSenderId: input.item.sourceSenderId ?? null,
    },
    authority: { identityScopes: [], dataScopes: [] },
    channel: {
      kind: input.item.channel,
      supportsAttachments: input.item.channel === "web",
    },
    representativeVersion: {
      representativeId: input.setup.id,
      version: input.item.representativeVersionId ?? "unversioned",
    },
    serviceState: operationalContext?.serviceEntitlement ?? {
      available: input.item.usage.passUnlocked,
      remainingUnits: input.item.usage.passUnlocked ? 1 : 0,
    },
    planningDefaults: {
      managedDocumentFormat: "markdown" as const,
      knowledgePolicy: "prefer_authorized" as const,
    },
    authorizedContext: [],
    turnConstraints: deriveTurnConstraintsFromMessage(input.item.userText),
    capabilitySnapshot: catalog,
  });
  return { authority, catalog, envelope };
}

async function runTurnPlannerV2Shadow(input: {
  config: ConversationWorkerConfig;
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  activeCollector: StructuredCollectorState | null;
  planningContext?: Awaited<ReturnType<typeof buildTurnPlanningContext>>;
}) {
  const rolloutMode = input.config.turnPlannerV2Mode ?? "disabled";
  if (rolloutMode === "disabled") return null;
  const { catalog, envelope } = input.planningContext
    ?? await buildTurnPlanningContext(input);
  const replay = await loadReplayableConversationTurnPlan({
    generationRunId: input.item.runId,
    inputMessageId: input.item.inputMessageId,
  });
  if (replay) {
    const validated = validateTurnPlanV2({
      plan: replay.planSnapshot,
      catalog,
      envelope,
      expectedPlanId: replay.id,
    });
    if (!validated.ok) {
      await failConversationTurnPlan({
        planId: replay.id,
        reason:
          `persisted_plan_revalidation_failed:${validated.issues.map((issue) => issue.code).join(",")}`,
      });
      throw new Error(
        `Persisted TurnPlan replay no longer validates: ${validated.issues.map((issue) => issue.code).join(",")}`,
      );
    }
    const referencedCoordinates = new Set(
      validated.plan.actions.map((action) =>
        `${action.capability.key}@${action.capability.version}`),
    );
    return {
      result: {
        ok: true as const,
        plan: validated.plan,
        selectedCapabilities: catalog.capabilities.filter((capability) =>
          referencedCoordinates.has(`${capability.key}@${capability.version}`)),
        provider: replay.plannerProvider ?? "persisted",
        model: replay.plannerModel ?? "persisted",
      },
      persistedPlan: replay,
      envelope,
      catalog,
      active: replay.shadowMode === false,
    };
  }
  const latestRevision = await loadLatestConversationTurnPlanRevision({
    conversationId: input.item.conversationId,
    inputMessageId: input.item.inputMessageId,
  });
  const planId =
    `turn-plan-${input.item.runId}-${(latestRevision?.revision ?? 0) + 1}`;
  const result = await planTurnV2({ envelope, planId });
  if (result.ok) {
    const activatesManagedDocumentFastLane =
      rolloutMode === "active_low_risk"
      && isEligibleManagedDocumentTurnPlan(result.plan)
      && envelope.attachments.length === 0
      && (
        input.item.channel === "web"
        || (
          Boolean(input.config.representativePublicOrigin)
          && Boolean(input.item.audienceIdentityId)
        )
      );
    const persistedPlan = await persistConversationTurnPlan({
      representativeId: input.setup.id,
      representativeVersionId: input.item.representativeVersionId,
      conversationId: input.item.conversationId,
      generationRunId: input.item.runId,
      inputMessageId: input.item.inputMessageId,
      ...(input.item.delegationTaskId
        ? { delegationTaskId: input.item.delegationTaskId }
        : {}),
      envelope,
      catalog,
      plan: result.plan,
      plannerProvider: result.provider,
      plannerModel: result.model,
      promptVersion: turnPlannerPromptVersion,
      generationWorkLease: {
        outboxId: input.item.outboxId,
        leaseAttempt: input.item.leaseAttempt,
      },
      // `active_low_risk` authorizes only the managed-document lane today.
      // Every other V2 plan remains observational until it has its own
      // executor, authorization and migration gate; otherwise an unexecuted
      // plan would be persisted as product-active truth.
      shadowMode: !activatesManagedDocumentFastLane,
    });
    return {
      result,
      persistedPlan,
      envelope,
      catalog,
      active: persistedPlan.shadowMode === false,
    };
  } else {
    const persistedPlan = await persistConversationTurnPlannerFailure({
      planId,
      representativeId: input.setup.id,
      representativeVersionId: input.item.representativeVersionId,
      conversationId: input.item.conversationId,
      generationRunId: input.item.runId,
      inputMessageId: input.item.inputMessageId,
      envelope,
      catalog,
      ...(result.provider ? { plannerProvider: result.provider } : {}),
      ...(result.model ? { plannerModel: result.model } : {}),
      promptVersion: turnPlannerPromptVersion,
      generationWorkLease: {
        outboxId: input.item.outboxId,
        leaseAttempt: input.item.leaseAttempt,
      },
      code: result.code,
      reason: result.reason,
      ...(result.issues ? { issues: result.issues } : {}),
      // Planner failures never become active execution truth. The established
      // lane remains authoritative and the failure is retained for rollout
      // metrics and replay.
      shadowMode: true,
    });
    return {
      result,
      persistedPlan,
      envelope,
      catalog,
      active: false,
    };
  }
}

async function runTurnPlannerV3(input: {
  config: ConversationWorkerConfig;
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  planningContext: Awaited<ReturnType<typeof buildTurnPlanningContext>>;
  plannedV2?: NonNullable<Awaited<ReturnType<typeof runTurnPlannerV2Shadow>>>;
}) {
  const rolloutMode = input.config.turnPlannerV3Mode ?? "disabled";
  if (rolloutMode === "disabled") return null;
  const authority = input.planningContext.authority;
  const mcpPublications = (authority?.mcpBindings ?? []).flatMap((binding) =>
    (binding.toolDefinitions ?? []).map((tool) =>
      buildMcpToolCapabilityPublicationV3({ binding, tool })));
  // Installed Skill metadata is not an execution grant. A Skill is added to
  // this list only when Runtime Authority can provide its immutable release
  // pin, trust decision and an actual Runner publication. Until that path is
  // wired, omitting it is safer and more truthful than fabricating a release
  // from the mutable Representative setup DTO.
  const publications: CapabilityPublicationV3[] = [...mcpPublications];
  const discoveryDocuments = publications.map((publication) =>
    buildCapabilityDiscoveryDocumentV3({
      definitionHash: publication.definition.definitionHash,
      searchDocument: publication.searchDocument,
      trust: publication.discoveryTextTrust === "server_defined"
        ? "server_owned"
        : publication.discoveryTextTrust === "owner_configured"
          ? "owner_configured"
          : "third_party_untrusted",
    }));
  const governedCatalogEnabled = rolloutMode !== "active_readonly";
  const compatibilityDefinitions = input.planningContext.catalog.capabilities
    .filter((definition) =>
      governedCatalogEnabled
      && (
        definition.key === "artifact.generate_document"
      )
      && !definition.key.startsWith("compute."))
    .map((definition) => {
      const executor = definition.executor === "builtin"
        && definition.key.startsWith("knowledge.")
          ? "knowledge" as const
          : definition.executor;
      const effect = definition.effect === "read_only"
        ? { boundary: "internal" as const, mutation: "none" as const, reversibility: "not_applicable" as const }
        : definition.effect === "internal_write"
          ? { boundary: "internal" as const, mutation: "write" as const, reversibility: "not_applicable" as const }
          : {
              boundary: "external" as const,
              mutation: "write" as const,
              reversibility: definition.effect === "external_reversible"
                ? "reversible" as const
                : "irreversible" as const,
            };
      return {
        key: definition.key,
        version: definition.version,
        description: definition.description,
        executor,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        effect,
        idempotency: definition.idempotency,
        ...(definition.key === "artifact.generate_document"
          ? {
              successContract: {
                kind: "success_schema" as const,
                schema: definition.outputSchema,
              },
            }
          : {}),
        supportedChannels: definition.supportedChannels,
        requiredIdentityScopes: definition.requiredIdentityScopes,
        requiredDataScopes: definition.requiredDataScopes,
        tags: definition.tags,
        semantics: {
          operations: ["create" as const],
          evidenceClasses: ["capability_result" as const],
          // The document body is stable, but the artifact coordinate is a
          // newly produced capability result for this turn. Publishing both
          // classes keeps retrieval semantics descriptive while allowing the
          // bounded ActionResult contract required by TurnPlan V3.
          freshnessClasses: ["stable" as const, "bounded" as const],
          authorityClasses: ["general" as const],
          domains: definition.tags,
          aliases: [definition.key, ...definition.tags],
        },
        canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
      };
    });
  const catalog = buildCapabilityCatalogV3([
    ...compatibilityDefinitions,
    ...publications.map((publication) => publication.definition),
    ...(governedCatalogEnabled
      ? buildV3ComputeCapabilityDefinitions(authority?.compute)
      : []),
    {
      key: "representative.describe_self",
      version: "2",
      description: "Describe the current digital representative from the Owner's published profile, relevant authorized knowledge, user-facing capability outcomes, and the server-governed human-confirmation boundary. 回答自我介绍、代表谁、会什么、能做什么、擅长什么、哪些事需要真人确认以及如何申请人工接管。",
      executor: "builtin",
      inputSchema: closedObjectSchema({}, []),
      outputSchema: buildRepresentativeDescriptionOutputSchema(),
      effect: { boundary: "internal", mutation: "none", reversibility: "not_applicable" },
      idempotency: "naturally_idempotent",
      successContract: {
        kind: "success_schema",
        schema: buildRepresentativeDescriptionOutputSchema(),
      },
      supportedChannels: ["web", "matrix", "telegram"],
      requiredIdentityScopes: [],
      requiredDataScopes: [],
      tags: ["self introduction", "owner", "capabilities", "human confirmation", "handoff", "自我介绍", "代表谁", "能力", "会什么", "能做什么", "擅长什么", "真人确认", "转人工", "人工接管"],
      semantics: {
        operations: ["answer", "read", "explain"],
        evidenceClasses: ["capability_result", "authorized_knowledge"],
        freshnessClasses: ["stable", "bounded"],
        authorityClasses: ["owner_authorized"],
        domains: ["representative identity", "owner profile", "capabilities", "human confirmation", "human handoff"],
        aliases: ["自我介绍", "代表谁", "会什么", "能做什么", "擅长什么", "哪些事需要真人确认", "如何转人工", "人工接管"],
      },
      canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
    },
    {
      key: "knowledge.retrieve_authorized",
      version: "1",
      description: "Retrieve authorized knowledge evidence for the current goal.",
      executor: "knowledge",
      inputSchema: closedObjectSchema({ question: { type: "string" } }, ["question"]),
      outputSchema: closedObjectSchema({
        status: {
          type: "string",
          enum: ["found", "not_found", "unavailable"],
        },
        evidenceRefs: { type: "array", items: { type: "string" } },
        items: { type: "array", items: { type: "object" } },
      }, ["status", "evidenceRefs", "items"]),
      effect: { boundary: "internal", mutation: "none", reversibility: "not_applicable" },
      idempotency: "naturally_idempotent",
      successContract: {
        kind: "status_predicate",
        pointer: "/status",
        operator: "in",
        value: ["found", "not_found", "unavailable"],
      },
      supportedChannels: ["web", "matrix", "telegram"],
      requiredIdentityScopes: [],
      requiredDataScopes: [],
      tags: ["knowledge", "evidence", "知识"],
      semantics: {
        operations: ["answer", "read", "search", "explain"],
        evidenceClasses: ["authorized_knowledge"],
        freshnessClasses: ["stable", "bounded"],
        authorityClasses: ["owner_authorized"],
        domains: ["published knowledge", "owner knowledge"],
        aliases: ["知识库", "资料", "文档", "owner knowledge"],
      },
      canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
    },
    {
      key: "response.compose",
      version: "1",
      description: "Compose one evidence-bound response from verified action results.",
      executor: "builtin",
      inputSchema: closedObjectSchema({}, []),
      outputSchema: closedObjectSchema({
        segments: { type: "array", items: { type: "object" }, minItems: 1 },
      }, ["segments"]),
      effect: { boundary: "internal", mutation: "none", reversibility: "not_applicable" },
      idempotency: "naturally_idempotent",
      successContract: {
        kind: "success_schema",
        schema: closedObjectSchema({
          segments: { type: "array", items: { type: "object" }, minItems: 1 },
        }, ["segments"]),
      },
      supportedChannels: ["web", "matrix", "telegram"],
      requiredIdentityScopes: [],
      requiredDataScopes: [],
      tags: ["response", "compose", "回答"],
      semantics: {
        operations: ["answer", "explain", "deliver"],
        evidenceClasses: [
          "none",
          "authorized_knowledge",
          "capability_result",
          "current_external",
          "transactional_authority",
        ],
        freshnessClasses: ["stable", "bounded", "live"],
        authorityClasses: [
          "general",
          "owner_authorized",
          "external_authoritative",
          "transactional",
        ],
        domains: ["response composition"],
        aliases: ["回答", "总结", "compose"],
      },
      canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
    },
  ]);
  const availabilityByDefinitionHash = new Map(
    publications.map((publication) => [
      publication.definition.definitionHash,
      publication.availability,
    ] as const),
  );
  const availabilityObservedAt = new Date().toISOString();
  const availabilitySnapshot = buildCapabilityAvailabilitySnapshotV3({
    catalog,
    observedAt: availabilityObservedAt,
    capabilities: catalog.capabilities.map((definition) =>
      availabilityByDefinitionHash.get(definition.definitionHash) ?? {
        capabilityKey: definition.key,
        capabilityVersion: definition.version,
        definitionHash: definition.definitionHash,
        healthState: "ready" as const,
        checkedAt: availabilityObservedAt,
        runtimeRevision: "conversation-worker:inline-v3.2",
      }),
  });
  const replay = await loadReplayableConversationTurnPlanV3({
    generationRunId: input.item.runId,
    inputMessageId: input.item.inputMessageId,
  });
  if (replay) {
    const validated = validateTurnPlanV3({
      plan: replay.planSnapshot,
      catalog,
      envelope: input.planningContext.envelope,
      expectedPlanId: replay.id,
    });
    if (!validated.ok) {
      await failConversationTurnPlan({
        planId: replay.id,
        reason: `persisted_v3_plan_revalidation_failed:${validated.issues
          .map((issue) => issue.code).join(",")}`,
      });
      // Protocol upgrades may make an older persisted plan unreadable. Keep
      // the failure inside the V3 authority lane so active mode fails closed;
      // throwing here would leave the caller with no V3 result and could let
      // an established legacy answer path run for the same turn.
      return {
        result: {
          ok: false as const,
          code: "plan_invalid" as const,
          reason: "Persisted TurnPlan V3 no longer validates against its pinned catalog.",
          issues: validated.issues,
          provider: replay.plannerProvider ?? "persisted",
          model: replay.plannerModel ?? "persisted",
        },
        persistedPlan: replay,
        catalog,
        availabilitySnapshot,
        publications,
        rolloutMode,
        authority,
      };
    }
    const referencedCoordinates = new Set(validated.plan.actions.map((action) =>
      `${action.capability.key}@${action.capability.version}`));
    return {
      result: {
        ok: true as const,
        plan: validated.plan,
        selectedCapabilities: catalog.capabilities.filter((definition) =>
          referencedCoordinates.has(`${definition.key}@${definition.version}`)),
        provider: replay.plannerProvider ?? "persisted",
        model: replay.plannerModel ?? "persisted",
        proposal: null,
      },
      persistedPlan: replay,
      catalog,
      availabilitySnapshot,
      publications,
      rolloutMode,
      authority,
    };
  }
  const latest = await loadLatestConversationTurnPlanRevision({
    conversationId: input.item.conversationId,
    inputMessageId: input.item.inputMessageId,
  });
  const revision = (latest?.revision ?? 0) + 1;
  const scopeKey = {
    kind: "generation_turn" as const,
    conversationId: input.item.conversationId,
    inputMessageId: input.item.inputMessageId,
  };
  const planId = `turn-plan-v3-${input.item.runId}-${revision}`;
  const knowledgeProbe = input.item.representativeVersionId
    ? await probeRepresentativeKnowledgeMetadata({
        representativeSlug: input.item.representativeSlug,
        representativeVersionId: input.item.representativeVersionId,
        conversationId: input.item.conversationId,
        contactId: input.item.contactId,
        sourceChannel: input.item.channel,
        queryText: input.item.userText,
        allowedSourceKinds: ["PUBLIC_KNOWLEDGE"],
      }).catch(() => ({
        status: "unavailable" as const,
        candidateCount: 0,
        matchedTopics: [],
        probeRevision: `knowledge-probe:${input.item.representativeVersionId}:unavailable`,
      }))
    : {
        status: "denied" as const,
        candidateCount: 0,
        matchedTopics: [],
        probeRevision: "knowledge-probe:unpinned",
      };
  const result = await planTurnV3({
    envelope: input.planningContext.envelope,
    catalog,
    availabilitySnapshot,
    availabilityReferenceTime: availabilityObservedAt,
    discoveryDocuments,
    knowledgeProbe,
    scopeKey,
    revision,
    planId,
  });
  if (!result.ok) {
    console.error("TurnPlan V3 shadow planning failed.", result);
    const plannerFailureAuditSnapshot = {
      proposal: typeof result.proposal === "undefined" ? null : result.proposal,
      candidateSnapshot: result.candidateSnapshotAudit ?? null,
      knowledgeProbe,
    };
    await persistConversationTurnPlannerFailureV3({
      planId,
      revision,
      scopeKey,
      representativeId: input.setup.id,
      representativeVersionId: input.item.representativeVersionId,
      conversationId: input.item.conversationId,
      generationRunId: input.item.runId,
      inputMessageId: input.item.inputMessageId,
      envelope: input.planningContext.envelope,
      catalog,
      ...(result.provider ? { plannerProvider: result.provider } : {}),
      ...(result.model ? { plannerModel: result.model } : {}),
      promptVersion: "turn-planner.v3.generic-arbiter.3",
      validationPolicyVersion: "turn-plan-v3-policy.3",
      code: result.code,
      reason: result.reason,
      ...(result.issues ? { issues: result.issues } : {}),
      ...(result.candidateSnapshotAudit || typeof result.proposal !== "undefined"
        ? {
            plannerProposalHash: stableSha256(plannerFailureAuditSnapshot),
            plannerProposalSnapshot: plannerFailureAuditSnapshot,
          }
        : {}),
      generationWorkLease: {
        outboxId: input.item.outboxId,
        leaseAttempt: input.item.leaseAttempt,
      },
    });
    return {
      result,
      persistedPlan: null,
      catalog,
      availabilitySnapshot,
      publications,
      rolloutMode,
      authority,
    };
  }
  const referencedDefinitionHashes = new Set(
    result.plan.actions.map((action) => action.capability.definitionHash),
  );
  const plannerAuditSnapshot = result.candidateSnapshot
    ? {
        proposal: result.proposal,
        candidateSnapshot: result.candidateSnapshot,
        // Composer recovery needs the exact immutable semantics that justified
        // evidence classification. Coordinates alone are insufficient for
        // transactional/current authority.
        capabilityDefinitions: result.selectedCapabilities.filter((definition) =>
          referencedDefinitionHashes.has(definition.definitionHash)),
        knowledgeProbe,
      }
    : result.proposal;
  const persistedPlan = await persistConversationTurnPlanV3({
    representativeId: input.setup.id,
    representativeVersionId: input.item.representativeVersionId,
    conversationId: input.item.conversationId,
    generationRunId: input.item.runId,
    inputMessageId: input.item.inputMessageId,
    ...(input.item.delegationTaskId
      ? { delegationTaskId: input.item.delegationTaskId }
      : {}),
    envelope: input.planningContext.envelope,
    catalog,
    plan: result.plan,
    plannerProvider: result.provider,
    plannerModel: result.model,
    promptVersion: "turn-planner.v3.generic-arbiter.3",
    plannerProposalHash: stableSha256(plannerAuditSnapshot),
    plannerProposalSnapshot: plannerAuditSnapshot,
    shadowComparison: {
      v2PlanId: input.plannedV2?.result.ok
        ? input.plannedV2.result.plan.planId
        : null,
      v2Mode: input.plannedV2?.result.ok
        ? input.plannedV2.result.plan.mode
        : input.plannedV2 ? "planner_failure" : "not_run",
      v2ActionCoordinates: input.plannedV2?.result.ok
        ? input.plannedV2.result.plan.actions.map((action) =>
            `${action.capability.key}@${action.capability.version}`)
        : [],
      v3ActionCoordinates: result.plan.actions.map((action) =>
        `${action.capability.key}@${action.capability.version}`),
      goalCountDelta: result.plan.goals.length
        - (input.plannedV2?.result.ok ? input.plannedV2.result.plan.goals.length : 0),
    },
    shadowMode: rolloutMode === "shadow",
    generationWorkLease: {
      outboxId: input.item.outboxId,
      leaseAttempt: input.item.leaseAttempt,
    },
  });
  return {
    result,
    persistedPlan,
    catalog,
    availabilitySnapshot,
    publications,
    rolloutMode,
    authority,
  };
}

function buildV3ComputeCapabilityDefinitions(
  compute: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeAuthoritySnapshot>>>["compute"] | undefined,
) {
  if (!compute?.enabled) return [];
  return (["exec", "read", "write", "process", "browser"] as const)
    .filter((capability) => compute.capabilityModes[capability] !== "deny")
    .map((capability) => {
      const inputSchema = capability === "read"
        ? closedObjectSchema({ path: { type: "string" } }, ["path"])
        : capability === "write"
          ? closedObjectSchema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"])
          : capability === "browser"
            ? closedObjectSchema({ url: { type: "string" } }, ["url"])
            : closedObjectSchema({ command: { type: "string" } }, ["command"]);
      return {
        key: `compute.${capability}`,
        version: "1",
        description: `Execute the governed ${capability} capability in an isolated Compute session.`,
        executor: "compute" as const,
        inputSchema,
        outputSchema: closedObjectSchema({
          exitCode: { type: "number" },
          artifactRefs: { type: "array", items: { type: "string" } },
        }, ["exitCode", "artifactRefs"]),
        effect: capability === "read"
          ? { boundary: "internal" as const, mutation: "none" as const, reversibility: "not_applicable" as const }
          : { boundary: "internal" as const, mutation: "write" as const, reversibility: "not_applicable" as const },
        idempotency: capability === "read"
          ? "naturally_idempotent" as const
          : "requires_key" as const,
        successContract: {
          kind: "status_predicate" as const,
          pointer: "/exitCode",
          operator: "equals" as const,
          value: 0,
        },
        supportedChannels: ["web", "matrix", "telegram"],
        requiredIdentityScopes: [],
        requiredDataScopes: [],
        tags: ["compute", capability],
        semantics: {
          operations: capability === "browser" || capability === "read"
            ? ["read" as const, "search" as const]
            : capability === "write"
              ? ["create" as const, "mutate" as const]
              : ["create" as const],
          evidenceClasses: ["capability_result" as const],
          freshnessClasses: capability === "browser"
            ? ["live" as const]
            : ["bounded" as const],
          authorityClasses: capability === "browser"
            ? ["external_authoritative" as const]
            : ["general" as const],
          domains: ["compute", capability],
          aliases: ["compute", capability],
        },
        canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
      };
    });
}

type GovernedV3Action = {
  actionKey: string;
  planActionId: string;
  request: ParsedComputeRequest;
  executionRequest: CapabilityExecutionRequest;
  dependsOnActionIds: string[];
};

function compileGovernedActionsFromV3(
  planned: NonNullable<Awaited<ReturnType<typeof runTurnPlannerV3>>>,
  succeededInlineActionKeys: ReadonlySet<string> = new Set(),
): GovernedV3Action[] | null {
  if (!planned.result.ok || !planned.persistedPlan) return null;
  const persistedByActionKey = new Map(
    planned.persistedPlan.actions.map((action: { actionKey: string; id: string }) =>
      [action.actionKey, action.id] as const),
  );
  const definitionByCoordinate = new Map(
    planned.catalog.capabilities.map((definition) =>
      [`${definition.key}@${definition.version}`, definition] as const),
  );
  const registry = createCapabilityCompilerRegistryFromPublicationsV3(
    planned.publications,
  );
  const compiled: GovernedV3Action[] = [];
  for (const action of planned.result.plan.actions) {
    if (action.capability.key === "response.compose") continue;
    if (isV3InlineSourceCapability(action.capability.key)) continue;
    const planActionId = persistedByActionKey.get(action.id);
    const definition = definitionByCoordinate.get(
      `${action.capability.key}@${action.capability.version}`,
    );
    if (!planActionId || !definition) return null;
    let executionRequest: CapabilityExecutionRequest;
    try {
      executionRequest = registry.compile({
        planId: planned.persistedPlan.id,
        planRevision: planned.persistedPlan.revision,
        executionEpoch: planned.persistedPlan.executionEpoch,
        generationRunId: planned.persistedPlan.generationRunId ?? "",
        planActionId,
        action,
        definition,
      });
    } catch (error) {
      console.error("TurnPlan V3 capability compilation failed.", error);
      return null;
    }
    if (executionRequest.executor === "compute") {
      const dependencies = resolveGovernedExternalDependencies(
        action,
        succeededInlineActionKeys,
      );
      if (!dependencies) return null;
      compiled.push({
        actionKey: action.id,
        planActionId,
        executionRequest,
        dependsOnActionIds: dependencies,
        request: {
          capability: executionRequest.capability,
          subagentId: executionRequest.capability === "browser" ? "browser-agent" : "compute-agent",
          ...executionRequest.payload,
          displayTarget: action.id,
          estimatedTokens: 1_000,
          hasPaidEntitlement: false,
          browserMode: "deterministic",
          maxSteps: 1,
          allowMutations: false,
        } as ParsedComputeRequest,
      });
      continue;
    }
    if (executionRequest.executor === "mcp") {
      const binding = planned.authority?.mcpBindings.find((candidate) =>
        candidate.id === executionRequest.bindingId);
      if (!binding) return null;
      const dependencies = resolveGovernedExternalDependencies(
        action,
        succeededInlineActionKeys,
      );
      if (!dependencies) return null;
      compiled.push({
        actionKey: action.id,
        planActionId,
        executionRequest,
        dependsOnActionIds: dependencies,
        request: {
          capability: "mcp",
          subagentId: "compute-agent",
          bindingId: executionRequest.bindingId,
          toolName: executionRequest.toolName,
          toolArguments: executionRequest.toolArguments,
          displayTarget: action.id,
          estimatedTokens: binding.estimatedTokensPerCall,
          hasPaidEntitlement: false,
          browserMode: "deterministic",
          maxSteps: 1,
          allowMutations: false,
        } as ParsedComputeRequest,
      });
      continue;
    }
    return null;
  }
  const externalActionKeys = new Set(compiled.map((action) => action.actionKey));
  if (compiled.some((action) =>
    action.dependsOnActionIds.some((dependency) =>
      !externalActionKeys.has(dependency)))) {
    return null;
  }
  return compiled.length ? compiled : null;
}

function resolveGovernedExternalDependencies(
  action: PlanActionV3,
  succeededInlineActionKeys: ReadonlySet<string>,
) {
  const dependencies: string[] = [];
  for (const dependency of action.dependencies) {
    if (succeededInlineActionKeys.has(dependency.actionId)) {
      if (!dependency.allowedStatuses.includes("succeeded")) return null;
      continue;
    }
    dependencies.push(dependency.actionId);
  }
  if (action.activation.mode === "on_failure") {
    if (succeededInlineActionKeys.has(action.activation.sourceActionId)) {
      return null;
    }
    dependencies.push(action.activation.sourceActionId);
  }
  return [...new Set(dependencies)];
}

function isV3InlineSourceCapability(capabilityKey: string) {
  return capabilityKey === "knowledge.retrieve_authorized"
    || capabilityKey === "representative.describe_self";
}

function assertV3ReplayedActionOutput(input: {
  actionId: string;
  output: unknown;
  expectedOutputSchema: Record<string, unknown>;
}) {
  const problems = validateJsonSchemaValue(
    input.output,
    input.expectedOutputSchema,
    "/replayedActionResult",
  );
  if (problems.length) {
    throw new Error(
      `Replayed V3 action ${input.actionId} output is invalid: ${problems
        .map((problem) => `${problem.path}:${problem.message}`)
        .join(",")}`,
    );
  }
}

async function executeV3GovernedInlineSourceActions(input: {
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  planned: NonNullable<Awaited<ReturnType<typeof runTurnPlannerV3>>>;
  leaseGuard: ReturnType<typeof startGenerationLeaseHeartbeat>;
}) {
  if (
    input.planned.rolloutMode !== "active_governed"
    || !input.planned.result.ok
    || !input.planned.persistedPlan
  ) return { succeededActionKeys: new Set<string>() };
  const plan = input.planned.result.plan;
  const hasExternalAction = plan.actions.some((action) =>
    action.capability.key !== "response.compose"
    && !isV3InlineSourceCapability(action.capability.key));
  if (!hasExternalAction) return { succeededActionKeys: new Set<string>() };

  const persistedByKey = new Map(
    input.planned.persistedPlan.actions.map((action: { actionKey: string; id: string }) =>
      [action.actionKey, action] as const),
  );
  const definitionByCoordinate = new Map(
    input.planned.catalog.capabilities.map((definition) => [
      `${definition.key}@${definition.version}`,
      definition,
    ] as const),
  );
  const succeededActionKeys = new Set<string>();
  const pending = plan.actions.filter((action) =>
    isV3InlineSourceCapability(action.capability.key));

  let progressed = true;
  while (pending.length && progressed) {
    progressed = false;
    for (let index = 0; index < pending.length;) {
      const action = pending[index]!;
      const dependenciesReady = action.dependencies.every((dependency) =>
        succeededActionKeys.has(dependency.actionId)
        && dependency.allowedStatuses.includes("succeeded"));
      if (action.dependencies.length && !dependenciesReady) {
        index += 1;
        continue;
      }
      const persisted = persistedByKey.get(action.id);
      const definition = definitionByCoordinate.get(
        `${action.capability.key}@${action.capability.version}`,
      );
      if (!persisted || !definition) {
        throw new Error(`V3 inline source ${action.id} lost its persisted definition.`);
      }
      let authorizationVersion = 0;
      for (const phase of ["initial", "post_approval", "pre_execution"] as const) {
        const decision = await recordConversationPlanActionAuthorization({
          planActionId: persisted.id,
          phase,
          decision: "allow",
          reason: "Inline source action is read-only and remains within the pinned V3 evidence boundary.",
          policyVersion: "turn-plan-v3-inline-source.1",
        });
        authorizationVersion = decision.sequence;
      }
      const prepared = await prepareV3InlineAction({
        planActionId: persisted.id,
        expectedAuthorizationVersion: authorizationVersion,
        executor: action.capability.key === "knowledge.retrieve_authorized"
          ? "knowledge"
          : "builtin",
        billingAdmission: {
          decision: "not_billable",
          reasonCode: "generation_run_owns_conversation_billing",
        },
        generationWorkLease: {
          outboxId: input.item.outboxId,
          leaseAttempt: input.item.leaseAttempt,
        },
      });
      await input.leaseGuard.confirmOwned();
      if (prepared.attempt.status === "SUCCEEDED") {
        assertV3ReplayedActionOutput({
          actionId: action.id,
          output: prepared.attempt.responseSnapshot,
          expectedOutputSchema: action.expectedOutputSchema,
        });
      }
      if (prepared.attempt.status !== "SUCCEEDED") {
        const executionLeaseToken = prepared.attempt.executionLeaseToken;
        if (!executionLeaseToken) {
          throw new Error(`V3 inline source ${action.id} lost its execution lease.`);
        }
        await markV3InlineActionCallStarted({
          executionAttemptId: prepared.attempt.id,
          expectedExecutionLeaseToken: executionLeaseToken,
        });
        if (action.capability.key === "knowledge.retrieve_authorized") {
          const recalled = await recallRepresentativeContext({
            representativeSlug: input.item.representativeSlug,
            conversationId: input.item.conversationId,
            contactId: input.item.contactId,
            sourceChannel: input.item.channel,
            generationRunId: input.item.runId,
            queryText: String(action.arguments["question"] ?? input.item.userText),
          });
          const items = recalled.memoryUseRunId
            ? recalled.items.map((item) => ({
                evidenceId: item.memoryUseItemId,
                content: item.abstract,
              }))
            : [];
          const output = {
            status: items.length
              ? "found" as const
              : recalled.memoryUseRunId
                ? "not_found" as const
                : "unavailable" as const,
            evidenceRefs: items.map((item) => item.evidenceId),
            items,
          };
          const completed = await completeV3InlineAction({
            executionAttemptId: prepared.attempt.id,
            expectedExecutionLeaseToken: executionLeaseToken,
            transportOutcome: "response_received",
            rawOutput: output,
            expectedOutputSchema: action.expectedOutputSchema,
            ...(definition.successContract
              ? { successContract: definition.successContract }
              : {}),
            evidenceBindings: items.map((item) => ({
              evidenceId: item.evidenceId,
              evidenceClass: "authorized_knowledge",
              sourceActionId: action.id,
              memoryUseItemId: item.evidenceId,
              ...(recalled.memoryUseRunId
                ? { memoryUseRunId: recalled.memoryUseRunId }
                : {}),
            })),
          });
          if (
            "actionStatus" in completed
            && completed.actionStatus !== "SUCCEEDED"
          ) {
            throw new Error(`V3 inline knowledge source ${action.id} failed verification.`);
          }
        } else {
          const recalled = await recallRepresentativeContext({
            representativeSlug: input.item.representativeSlug,
            conversationId: input.item.conversationId,
            contactId: input.item.contactId,
            sourceChannel: input.item.channel,
            generationRunId: input.item.runId,
            queryText: input.item.userText,
          });
          const knowledgeItems = recalled.items
            .filter((item) =>
              item.internalSource.publicResourceKey !== "identity/profile.md")
            .map((item) => ({
              evidenceId: item.memoryUseItemId,
              content: item.abstract,
            }));
          const output = buildRepresentativeDescriptionOutput({
            setup: input.setup,
            capabilities: input.planned.catalog.capabilities,
            availability: input.planned.availabilitySnapshot.capabilities,
            knowledgeStatus: knowledgeItems.length
              ? "found" as const
              : recalled.memoryUseRunId
                ? "not_found" as const
                : "unavailable" as const,
            knowledgeItems,
          });
          const profileEvidenceId =
            `representative-profile:${input.planned.result.plan.planId}`;
          const completed = await completeV3InlineAction({
            executionAttemptId: prepared.attempt.id,
            expectedExecutionLeaseToken: executionLeaseToken,
            transportOutcome: "response_received",
            rawOutput: output,
            expectedOutputSchema: action.expectedOutputSchema,
            ...(definition.successContract
              ? { successContract: definition.successContract }
              : {}),
            evidenceBindings: [{
              evidenceId: profileEvidenceId,
              evidenceClass: "tool_output",
              sourceActionId: action.id,
            }, ...knowledgeItems.map((item) => ({
              evidenceId: item.evidenceId,
              evidenceClass: "authorized_knowledge",
              sourceActionId: action.id,
              memoryUseItemId: item.evidenceId,
              ...(recalled.memoryUseRunId
                ? { memoryUseRunId: recalled.memoryUseRunId }
                : {}),
            }))],
          });
          if (
            "actionStatus" in completed
            && completed.actionStatus !== "SUCCEEDED"
          ) {
            throw new Error(`V3 inline representative source ${action.id} failed verification.`);
          }
        }
      }
      succeededActionKeys.add(action.id);
      pending.splice(index, 1);
      progressed = true;
    }
  }
  return { succeededActionKeys };
}

async function executeV3ReadonlyPlan(input: {
  config: ConversationWorkerConfig;
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  planned: NonNullable<Awaited<ReturnType<typeof runTurnPlannerV3>>>;
  leaseGuard: ReturnType<typeof startGenerationLeaseHeartbeat>;
  continuationAuthorized: boolean;
  entitlementReservation?: ConversationEntitlementReservation | null;
}) {
  if (
    input.planned.rolloutMode !== "active_readonly"
      && input.planned.rolloutMode !== "active_governed"
  ) return null;
  if (
    !input.planned.result.ok
    || !input.planned.persistedPlan
  ) return null;
  const allowed = new Set([
    "representative.describe_self",
    "knowledge.retrieve_authorized",
    "response.compose",
  ]);
  if (input.planned.result.plan.actions.some((action) => !allowed.has(action.capability.key))) {
    return null;
  }
  const persistedByKey = new Map(
    input.planned.persistedPlan.actions.map((action: { actionKey: string; id: string }) =>
      [action.actionKey, action]),
  );
  const resultByActionId = new Map<string, unknown>();
  const evidence: Array<ComposerEvidenceReferenceV3 & {
    content: unknown;
    memoryUseItemId?: string;
  }> = [];
  let memoryUseRunId: string | undefined;
  let composerProvider: string | undefined;
  let composerModel: string | undefined;
  let composerPlanActionId: string | undefined;
  const knowledgeFallbacks: KnowledgeFallbackActivationV3[] = [];
  let finalText = "";
  const citedEvidenceIds = new Set<string>();
  for (const action of input.planned.result.plan.actions) {
    const persisted = persistedByKey.get(action.id);
    if (!persisted) throw new Error(`V3 persisted action ${action.id} is missing.`);
    if (action.capability.key === "response.compose") {
      composerPlanActionId = persisted.id;
    }
    let authorizationVersion = 0;
    for (const phase of ["initial", "post_approval", "pre_execution"] as const) {
      const decision = await recordConversationPlanActionAuthorization({
        planActionId: persisted.id,
        phase,
        decision: "allow",
        reason: "V3 read-only action is within the published capability and evidence boundary.",
        policyVersion: "turn-plan-v3-readonly.1",
      });
      authorizationVersion = decision.sequence;
    }
    const prepared = await prepareV3InlineAction({
      planActionId: persisted.id,
      expectedAuthorizationVersion: authorizationVersion,
      executor: action.capability.key === "knowledge.retrieve_authorized"
        ? "knowledge"
        : "builtin",
      billingAdmission: {
        decision: "not_billable",
        reasonCode: "generation_run_owns_conversation_billing",
      },
      generationWorkLease: {
        outboxId: input.item.outboxId,
        leaseAttempt: input.item.leaseAttempt,
      },
    });
    await input.leaseGuard.confirmOwned();
    const definition = input.planned.catalog.capabilities.find((candidate) =>
      candidate.key === action.capability.key
      && candidate.version === action.capability.version)!;
    const actionGoalIds = input.planned.result.plan.goals
      .filter((goal) => goal.actionIds.includes(action.id))
      .map((goal) => goal.id);
    const sourceKinds = composerSourceKindsForCapabilityV3(
      definition,
      action.capability.key === "knowledge.retrieve_authorized"
        ? "authorized_knowledge"
        : "tool_output",
    );
    if (prepared.attempt.status === "SUCCEEDED") {
      assertV3ReplayedActionOutput({
        actionId: action.id,
        output: prepared.attempt.responseSnapshot,
        expectedOutputSchema: action.expectedOutputSchema,
      });
      if (action.capability.key === "knowledge.retrieve_authorized") {
        const output = prepared.attempt.responseSnapshot;
        if (!output || typeof output !== "object" || Array.isArray(output)) {
          throw new Error("Replayed V3 knowledge result is invalid.");
        }
        const items = Array.isArray((output as Record<string, unknown>)["items"])
          ? (output as Record<string, unknown>)["items"] as Array<Record<string, unknown>>
          : [];
        for (const item of items) {
          if (typeof item["evidenceId"] !== "string") continue;
          evidence.push({
            evidenceId: item["evidenceId"],
            evidenceClass: "authorized_knowledge",
            content: item["content"],
            memoryUseItemId: item["evidenceId"],
            goalIds: actionGoalIds,
            sourceActionId: action.id,
            sourceKinds,
          });
        }
        const status = (output as Record<string, unknown>)["status"];
        if (status === "not_found" || status === "unavailable") {
          recordKnowledgeFallbackActivationsV3({
            plan: input.planned.result.plan,
            actionId: action.id,
            status,
            target: knowledgeFallbacks,
          });
        }
        resultByActionId.set(action.id, output);
      } else if (action.capability.key === "representative.describe_self") {
        const output = prepared.attempt.responseSnapshot;
        if (!output || typeof output !== "object" || Array.isArray(output)) {
          throw new Error("Replayed V3 representative description result is invalid.");
        }
        const outputRecord = output as Record<string, unknown>;
        const knowledgeItems = Array.isArray(outputRecord["knowledgeItems"])
          ? outputRecord["knowledgeItems"] as Array<Record<string, unknown>>
          : [];
        for (const item of knowledgeItems) {
          if (typeof item["evidenceId"] !== "string") continue;
          evidence.push({
            evidenceId: item["evidenceId"],
            evidenceClass: "authorized_knowledge",
            content: item["content"],
            memoryUseItemId: item["evidenceId"],
            goalIds: actionGoalIds,
            sourceActionId: action.id,
            sourceKinds: composerSourceKindsForCapabilityV3(
              definition,
              "authorized_knowledge",
            ),
          });
        }
        evidence.push({
          evidenceId: `representative-profile:${input.planned.result.plan.planId}`,
          evidenceClass: "tool_output",
          content: output,
          goalIds: actionGoalIds,
          sourceActionId: action.id,
          sourceKinds,
        });
        resultByActionId.set(action.id, output);
      } else {
        const replayActionResults = [...resultByActionId.keys()].map((actionId) => ({
          actionId,
          transportOutcome: "response_received",
          semanticOutcome: "succeeded",
        }));
        const draft = validateComposedMessageDraftV3({
          draft: prepared.attempt.responseSnapshot,
          plan: input.planned.result.plan,
          evidence: evidence.map(({ content: _content, ...item }) => item),
          actionResults: replayActionResults,
          goalOutcomes: resolveComposerSourceGoalOutcomesV3({
            plan: input.planned.result.plan,
            executionEpoch: input.planned.persistedPlan.executionEpoch,
            stateVersion: authorizationVersion,
            actionOutcomes: input.planned.result.plan.actions.map((candidate) => ({
              actionId: candidate.id,
              status: resultByActionId.has(candidate.id)
                ? "succeeded" as const
                : "pending" as const,
            })),
          }),
          ...(knowledgeFallbacks.length ? { knowledgeFallbacks } : {}),
        });
        if (!draft.ok) {
          throw new Error("Replayed V3 composer result is invalid.");
        }
        finalText = renderComposedV3Draft(draft.draft, {
          fallbackDisclosures: buildKnowledgeFallbackDisclosureMap(
            knowledgeFallbacks,
          ),
        });
        resultByActionId.set(action.id, draft.draft);
      }
      continue;
    }
    const executionLeaseToken = prepared.attempt.executionLeaseToken;
    if (!executionLeaseToken) {
      throw new Error(`V3 inline action ${action.id} lost its execution lease.`);
    }
    await markV3InlineActionCallStarted({
      executionAttemptId: prepared.attempt.id,
      expectedExecutionLeaseToken: executionLeaseToken,
    });
    if (action.capability.key === "knowledge.retrieve_authorized") {
      const recalled = await recallRepresentativeContext({
        representativeSlug: input.item.representativeSlug,
        conversationId: input.item.conversationId,
        contactId: input.item.contactId,
        sourceChannel: input.item.channel,
        generationRunId: input.item.runId,
        queryText: String(action.arguments["question"] ?? input.item.userText),
      });
      memoryUseRunId = recalled.memoryUseRunId;
      const items = recalled.memoryUseRunId
        ? recalled.items.map((item) => ({
            evidenceId: item.memoryUseItemId,
            content: item.abstract,
          }))
        : [];
      for (const item of items) {
        evidence.push({
          evidenceId: item.evidenceId,
          evidenceClass: "authorized_knowledge",
          content: item.content,
          memoryUseItemId: item.evidenceId,
          goalIds: actionGoalIds,
          sourceActionId: action.id,
          sourceKinds,
        });
      }
      const status = items.length
        ? "found" as const
        : recalled.memoryUseRunId
          ? "not_found" as const
          : "unavailable" as const;
      const output = {
        status,
        evidenceRefs: items.map((item) => item.evidenceId),
        items,
      };
      await completeV3InlineAction({
        executionAttemptId: prepared.attempt.id,
        expectedExecutionLeaseToken: executionLeaseToken,
        transportOutcome: "response_received",
        rawOutput: output,
        expectedOutputSchema: action.expectedOutputSchema,
        ...(definition.successContract ? { successContract: definition.successContract } : {}),
        evidenceBindings: evidence.filter((item) =>
          item.sourceActionId === action.id),
      });
      resultByActionId.set(action.id, output);
      if (status !== "found") {
        recordKnowledgeFallbackActivationsV3({
          plan: input.planned.result.plan,
          actionId: action.id,
          status,
          target: knowledgeFallbacks,
        });
      }
    } else if (action.capability.key === "representative.describe_self") {
      const recalled = await recallRepresentativeContext({
        representativeSlug: input.item.representativeSlug,
        conversationId: input.item.conversationId,
        contactId: input.item.contactId,
        sourceChannel: input.item.channel,
        generationRunId: input.item.runId,
        queryText: input.item.userText,
      });
      memoryUseRunId = recalled.memoryUseRunId;
      const knowledgeItems = recalled.items
        // Identity is sourced from the pinned Representative profile below;
        // aggregate identity documents are never allowed to override or mix it.
        .filter((item) =>
          item.internalSource.publicResourceKey !== "identity/profile.md")
        .map((item) => ({
        evidenceId: item.memoryUseItemId,
        content: item.abstract,
        }));
      for (const item of knowledgeItems) {
        evidence.push({
          evidenceId: item.evidenceId,
          evidenceClass: "authorized_knowledge",
          content: item.content,
          memoryUseItemId: item.evidenceId,
          goalIds: actionGoalIds,
          sourceActionId: action.id,
          sourceKinds: composerSourceKindsForCapabilityV3(
            definition,
            "authorized_knowledge",
          ),
        });
      }
      const output = buildRepresentativeDescriptionOutput({
        setup: input.setup,
        capabilities: input.planned.catalog.capabilities,
        availability: input.planned.availabilitySnapshot.capabilities,
        knowledgeStatus: knowledgeItems.length
          ? "found" as const
          : recalled.memoryUseRunId
            ? "not_found" as const
            : "unavailable" as const,
        knowledgeItems,
      });
      const profileEvidence = {
        evidenceId: `representative-profile:${input.planned.result.plan.planId}`,
        evidenceClass: "tool_output" as const,
        content: output,
        goalIds: actionGoalIds,
        sourceActionId: action.id,
        sourceKinds,
      };
      evidence.push(profileEvidence);
      await completeV3InlineAction({
        executionAttemptId: prepared.attempt.id,
        expectedExecutionLeaseToken: executionLeaseToken,
        transportOutcome: "response_received",
        rawOutput: output,
        expectedOutputSchema: action.expectedOutputSchema,
        ...(definition.successContract ? { successContract: definition.successContract } : {}),
        evidenceBindings: [{
          evidenceId: profileEvidence.evidenceId,
          evidenceClass: profileEvidence.evidenceClass,
          sourceActionId: action.id,
        }, ...knowledgeItems.map((item) => ({
          evidenceId: item.evidenceId,
          evidenceClass: "authorized_knowledge" as const,
          sourceActionId: action.id,
          goalIds: actionGoalIds,
          sourceKinds: composerSourceKindsForCapabilityV3(
            definition,
            "authorized_knowledge",
          ),
        }))],
      });
      resultByActionId.set(action.id, output);
    } else {
      const actionOutcomes = input.planned.result.plan.actions.map((candidate) => ({
        actionId: candidate.id,
        status: resultByActionId.has(candidate.id) ? "succeeded" as const : "pending" as const,
      }));
      const composed = await composeTurnV3({
        plan: input.planned.result.plan,
        taskInput: {
          text: input.item.userText,
          language: /\p{Script=Han}/u.test(input.item.userText) ? "zh" : "en",
        },
        responseLanguage: /\p{Script=Han}/u.test(input.item.userText) ? "zh" : "en",
        actionResults: [...resultByActionId.keys()].map((actionId) => ({
          actionId,
          transportOutcome: "response_received",
          semanticOutcome: "succeeded",
        })),
        evidence,
        goalOutcomes: resolveComposerSourceGoalOutcomesV3({
          plan: input.planned.result.plan,
          executionEpoch: input.planned.persistedPlan.executionEpoch,
          stateVersion: authorizationVersion,
          actionOutcomes,
        }),
        ...(knowledgeFallbacks.length ? { knowledgeFallbacks } : {}),
        representativeStyle: buildRepresentativeResponseStyle(input.setup),
      });
      if (!composed.ok) throw new Error(formatV3ComposerFailure(composed));
      composerProvider = composed.provider;
      composerModel = composed.model;
      for (const segment of composed.draft.segments) {
        if (segment.kind === "claim") {
          segment.evidenceRefs.forEach((evidenceId) => citedEvidenceIds.add(evidenceId));
        } else if (segment.kind === "inference") {
          segment.inferenceFromRefs.forEach((evidenceId) => citedEvidenceIds.add(evidenceId));
        }
      }
      finalText = renderComposedV3Draft(composed.draft, {
        fallbackDisclosures: buildKnowledgeFallbackDisclosureMap(
          knowledgeFallbacks,
        ),
      });
      await completeV3InlineAction({
        executionAttemptId: prepared.attempt.id,
        expectedExecutionLeaseToken: executionLeaseToken,
        transportOutcome: "response_received",
        rawOutput: composed.draft,
        expectedOutputSchema: action.expectedOutputSchema,
        ...(definition.successContract ? { successContract: definition.successContract } : {}),
        evidenceBindings: evidence,
      });
      resultByActionId.set(action.id, composed.draft);
    }
  }
  if (!finalText) throw new Error("V3 read-only plan produced no composed response.");
  // All ActionResults are already verified at this point. Complete the plan
  // before the GenerationRun so a crash can never publish COMPLETED while the
  // authoritative plan remains EXECUTING. Replay accepts completed plans.
  await completeConversationTurnPlan({ planId: input.planned.result.plan.planId });
  const completed = await completeInlineGenerationRun({
    conversationId: input.item.conversationId,
    runId: input.item.runId,
    outboxId: input.item.outboxId,
    leaseAttempt: input.item.leaseAttempt,
    replyText: finalText,
    senderDisplayName: input.item.representativeName,
    intent: "turn_plan_v3_readonly",
    ...(composerProvider ? { provider: composerProvider as "agicto" | "openai" | "bailian" | "anthropic" } : {}),
    ...(composerModel ? { model: composerModel } : {}),
    runtimeOutcome: { mode: "model" },
    countUsage: input.continuationAuthorized,
    completeOutbox: false,
    ...(input.entitlementReservation
      ? { entitlementReservation: input.entitlementReservation }
      : {}),
    ...(memoryUseRunId
      ? {
          memoryUse: {
            runId: memoryUseRunId,
            outcome: "completed" as const,
            injectedItemIds: evidence.flatMap((item) =>
              item.memoryUseItemId ? [item.memoryUseItemId] : []),
            citedItemIds: evidence
              .filter((item) =>
                Boolean(item.memoryUseItemId)
                && citedEvidenceIds.has(item.evidenceId))
              .flatMap((item) => item.memoryUseItemId ? [item.memoryUseItemId] : []),
          },
        }
      : {}),
  });
  await deliverGenerationOutput({
    config: input.config,
    item: input.item,
    text: finalText,
    outputMessageId: completed.message.id,
    ...(composerPlanActionId ? { planActionId: composerPlanActionId } : {}),
  });
  return { processed: true as const, runId: input.item.runId, status: "completed" as const };
}

type GovernedComposerEvidence = ComposerEvidenceReferenceV3 & {
  content: unknown;
};

function composerSourceKindsForCapabilityV3(
  definition: {
    key: string;
    executor: string;
    semantics?: {
      evidenceClasses: string[];
      authorityClasses: string[];
    };
  },
  evidenceClass: ComposerEvidenceReferenceV3["evidenceClass"],
) {
  return [...new Set([
    evidenceClass,
    ...(evidenceClass === "tool_output" ? ["capability_result"] : []),
    definition.executor,
    definition.key,
    ...(definition.semantics?.evidenceClasses ?? []),
    ...(definition.semantics?.authorityClasses ?? []),
  ])];
}

function recordKnowledgeFallbackActivationsV3(input: {
  plan: TurnPlanV3;
  actionId: string;
  status: "not_found" | "unavailable";
  target: KnowledgeFallbackActivationV3[];
}) {
  for (const goal of input.plan.goals) {
    if (
      !goal.actionIds.includes(input.actionId)
      || goal.evidenceFallbackPolicy?.kind
        !== "authorized_knowledge_miss_to_stable_general"
      || goal.sourceAuthorityBoundary?.classification
        !== "stable_general_allowed"
      || !goal.evidenceFallbackPolicy.activationStatuses.includes(input.status)
    ) continue;
    if (!input.target.some((item) => item.goalId === goal.id)) {
      input.target.push({ goalId: goal.id, status: input.status });
    }
  }
}

function recordCapabilityFallbackActivationsV3(input: {
  plan: TurnPlanV3;
  status: KnowledgeFallbackActivationV3["status"];
  target: KnowledgeFallbackActivationV3[];
}) {
  for (const goal of input.plan.goals) {
    const policy = goal.evidenceFallbackPolicy;
    if (
      policy?.kind !== "capability_unexecuted_to_stable_general"
      || goal.sourceAuthorityBoundary?.classification
        !== "stable_general_allowed"
      || !(policy.activationStatuses as readonly string[]).includes(input.status)
    ) continue;
    if (!input.target.some((item) => item.goalId === goal.id)) {
      input.target.push({ goalId: goal.id, status: input.status });
    }
  }
}

export function buildV3GovernedComposerEvidence(input: {
  sourceActions: Array<{
    id?: string;
    actionKey: string;
    capabilityKey: string;
    capabilityDefinitionHash: string;
    actionResults: Array<{
      id: string;
      semanticOutcome: string;
      output: unknown;
      evidenceBindings: unknown;
    }>;
  }>;
  plannerProposalSnapshot: unknown;
  plan?: Pick<TurnPlanV3, "goals">;
}) {
  const definitions = readPinnedCapabilityDefinitionsV3(
    input.plannerProposalSnapshot,
  );
  const evidence: GovernedComposerEvidence[] = [];
  const seen = new Set<string>();
  const push = (item: GovernedComposerEvidence) => {
    const key = `${item.evidenceClass}\u0000${item.evidenceId}`;
    if (!seen.has(key)) {
      seen.add(key);
      evidence.push(item);
    }
  };
  for (const action of input.sourceActions) {
    const result = action.actionResults[0];
    if (!result || result.output === null) continue;
    if (
      result.semanticOutcome !== "succeeded"
      && result.semanticOutcome !== "partial"
    ) continue;
    const actionGoalIds = (input.plan?.goals ?? [])
      .filter((goal) => goal.actionIds.includes(action.actionKey))
      .map((goal) => goal.id);
    const requiredEvidenceKinds = new Set(
      (input.plan?.goals ?? []).flatMap((goal) =>
        goal.actionIds.includes(action.actionKey)
          ? [goal.evidenceRequirement.kind]
          : []),
    );
    const requiresTransactional = requiredEvidenceKinds.has(
      "transactional_authority",
    );
    const requiresCurrentExternal = requiredEvidenceKinds.has(
      "current_external",
    );
    const definition = definitions.get(normalizeStoredSha256(
      action.capabilityDefinitionHash,
    ));
    const isLiveExternalAuthority = Boolean(
      definition
      && definition.key === action.capabilityKey
      && definition.semantics.freshnessClasses.includes("live")
      && definition.semantics.authorityClasses.some((authority) =>
        authority === "external_authoritative" || authority === "transactional"),
    );
    const bindings = readV3EvidenceBindings(result.evidenceBindings);
    if (bindings.length) {
      for (const binding of bindings) {
        if (
          (binding.sourceActionId
            && binding.sourceActionId !== action.actionKey
            && binding.sourceActionId !== action.id)
          || (binding.actionResultId && binding.actionResultId !== result.id)
        ) continue;
        const evidenceClass = binding.evidenceClass;
        if (
          evidenceClass !== "authorized_knowledge"
          && evidenceClass !== "tool_output"
          && evidenceClass !== "transactional_authority"
        ) continue;
        if (requiresTransactional && evidenceClass !== "transactional_authority") {
          continue;
        }
        if (
          requiresCurrentExternal
          && evidenceClass === "tool_output"
          && !isLiveExternalAuthority
        ) continue;
        const content = evidenceClass === "authorized_knowledge"
          ? findKnowledgeEvidenceContent(result.output, binding.evidenceId)
          : result.output;
        if (typeof content === "undefined") continue;
        if (!definition || definition.key !== action.capabilityKey) continue;
        push({
          evidenceId: binding.evidenceId,
          evidenceClass,
          content,
          goalIds: actionGoalIds,
          sourceActionId: action.actionKey,
          actionResultId: result.id,
          sourceKinds: composerSourceKindsForCapabilityV3(
            definition,
            evidenceClass,
          ),
        });
      }
      continue;
    }
    if (!definition || definition.key !== action.capabilityKey) continue;
    const semantics = definition.semantics;
    if (
      semantics.evidenceClasses.includes("transactional_authority")
      && semantics.authorityClasses.includes("transactional")
    ) {
      push({
        evidenceId: result.id,
        evidenceClass: "transactional_authority",
        content: result.output,
        goalIds: actionGoalIds,
        sourceActionId: action.actionKey,
        actionResultId: result.id,
        sourceKinds: composerSourceKindsForCapabilityV3(
          definition,
          "transactional_authority",
        ),
      });
      continue;
    }
    if (requiresTransactional) continue;
    if (requiresCurrentExternal) {
      if (isLiveExternalAuthority) {
        push({
          evidenceId: result.id,
          evidenceClass: "tool_output",
          content: result.output,
          goalIds: actionGoalIds,
          sourceActionId: action.actionKey,
          actionResultId: result.id,
          sourceKinds: composerSourceKindsForCapabilityV3(
            definition,
            "tool_output",
          ),
        });
      }
      continue;
    }
    if (
      semantics.evidenceClasses.includes("current_external")
      && semantics.freshnessClasses.includes("live")
      && semantics.authorityClasses.some((authority) =>
        authority === "external_authoritative" || authority === "transactional")
    ) {
      push({
        evidenceId: result.id,
        evidenceClass: "tool_output",
        content: result.output,
        goalIds: actionGoalIds,
        sourceActionId: action.actionKey,
        actionResultId: result.id,
        sourceKinds: composerSourceKindsForCapabilityV3(
          definition,
          "tool_output",
        ),
      });
      continue;
    }
    if (semantics.evidenceClasses.includes("capability_result")) {
      push({
        evidenceId: result.id,
        evidenceClass: "tool_output",
        content: result.output,
        goalIds: actionGoalIds,
        sourceActionId: action.actionKey,
        actionResultId: result.id,
        sourceKinds: composerSourceKindsForCapabilityV3(
          definition,
          "tool_output",
        ),
      });
    }
  }
  return evidence;
}

function readPinnedCapabilityDefinitionsV3(value: unknown) {
  const definitions = new Map<
    string,
    ReturnType<typeof capabilityDefinitionV3Schema.parse>
  >();
  const root = readV3Object(value);
  const candidateSnapshot = readV3Object(root?.["candidateSnapshot"]);
  const candidates = Array.isArray(candidateSnapshot?.["candidates"])
    ? candidateSnapshot!["candidates"] as unknown[]
    : [];
  const persistedDefinitions = Array.isArray(root?.["capabilityDefinitions"])
    ? root!["capabilityDefinitions"] as unknown[]
    : [];
  for (const candidate of [...persistedDefinitions, ...candidates]) {
    const parsed = capabilityDefinitionV3Schema.safeParse(
      readV3Object(candidate)?.["definition"] ?? candidate,
    );
    if (!parsed.success) continue;
    definitions.set(parsed.data.definitionHash, parsed.data);
  }
  return definitions;
}

function readV3EvidenceBindings(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = readV3Object(item);
    const evidenceId = record?.["evidenceId"];
    const evidenceClass = record?.["evidenceClass"];
    const sourceActionId = record?.["sourceActionId"];
    const actionResultId = record?.["actionResultId"];
    return typeof evidenceId === "string" && typeof evidenceClass === "string"
      ? [{
          evidenceId,
          evidenceClass,
          ...(typeof sourceActionId === "string" ? { sourceActionId } : {}),
          ...(typeof actionResultId === "string" ? { actionResultId } : {}),
        }]
      : [];
  });
}

function findKnowledgeEvidenceContent(output: unknown, evidenceId: string) {
  const record = readV3Object(output);
  const items = Array.isArray(record?.["items"])
    ? record!["items"] as unknown[]
    : Array.isArray(record?.["knowledgeItems"])
      ? record!["knowledgeItems"] as unknown[]
      : [];
  const item = items.map(readV3Object).find((candidate) =>
    candidate?.["evidenceId"] === evidenceId);
  return item?.["content"];
}

function readV3Object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readV3GovernedComposerResumeTaskId(value: unknown) {
  const context = readV3Object(value);
  return context?.["source"] === "v3_governed_composer_resume"
    && typeof context["delegationTaskId"] === "string"
    ? context["delegationTaskId"]
    : null;
}

function normalizeStoredSha256(value: string) {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

async function executeV3GovernedComposer(input: {
  delegationTaskId: string;
  leaseGuard: ReturnType<typeof startGenerationLeaseHeartbeat>;
  taskInput: { text: string; language: string };
  generationWorkLease: {
    outboxId: string;
    leaseAttempt: number;
  };
  fallbackActivationStatus?: KnowledgeFallbackActivationV3["status"];
  representativeStyle: {
    representativeName: string;
    tone: string;
  };
}) {
  const context = await loadV3GovernedCompositionContext({
    delegationTaskId: input.delegationTaskId,
  });
  if (!context) return null;
  const terminalStatuses = new Set([
    "SUCCEEDED",
    "SKIPPED",
    "FAILED",
    "CANCELED",
    "RECONCILIATION_REQUIRED",
  ]);
  const sourceActions = context.plan.actions.filter((action) =>
    action.id !== context.composeAction.id);
  if (sourceActions.some((action) => !terminalStatuses.has(action.status))) {
    return null;
  }
  const actionKeyById = new Map(
    context.plan.actions.map((action) => [action.id, action.actionKey] as const),
  );
  const actionResults = sourceActions.flatMap((action) =>
    action.actionResults[0]
      ? [{
          actionId: action.actionKey,
          actionResultId: action.actionResults[0].id,
          transportOutcome: action.actionResults[0].transportOutcome,
          semanticOutcome: action.actionResults[0].semanticOutcome,
        }]
      : []);
  const evidence = buildV3GovernedComposerEvidence({
    sourceActions,
    plannerProposalSnapshot: context.plan.plannerProposalSnapshot,
    plan: context.parsedPlan,
  });
  const knowledgeFallbacks: KnowledgeFallbackActivationV3[] = [];
  if (input.fallbackActivationStatus) {
    recordCapabilityFallbackActivationsV3({
      plan: context.parsedPlan,
      status: input.fallbackActivationStatus,
      target: knowledgeFallbacks,
    });
  }
  for (const action of sourceActions) {
    if (action.capabilityKey !== "knowledge.retrieve_authorized") continue;
    const status = readV3Object(action.actionResults[0]?.output)?.["status"];
    if (status !== "not_found" && status !== "unavailable") continue;
    recordKnowledgeFallbackActivationsV3({
      plan: context.parsedPlan,
      actionId: action.actionKey,
      status,
      target: knowledgeFallbacks,
    });
  }
  const actionOutcomes = sourceActions.map((action) => ({
    actionId: action.actionKey,
    status: action.status === "SUCCEEDED"
      ? "succeeded" as const
      : action.status === "RECONCILIATION_REQUIRED"
        ? "reconciliation_required" as const
      : action.status === "CANCELED"
          ? "canceled" as const
          : action.status === "SKIPPED"
            ? "skipped" as const
          : "failed" as const,
  }));
  let authorizationVersion = 0;
  for (const phase of ["initial", "pre_execution"] as const) {
    const decision = await recordConversationPlanActionAuthorization({
      planActionId: context.composeAction.id,
      phase,
      decision: "allow",
      reason: "response.compose reads only verified ActionResult records from the current fenced plan.",
      policyVersion: "turn-plan-v3-composer.1",
    });
    authorizationVersion = decision.sequence;
  }
  const prepared = await prepareV3InlineAction({
    planActionId: context.composeAction.id,
    expectedAuthorizationVersion: authorizationVersion,
    executor: "builtin",
    billingAdmission: {
      decision: "not_billable",
      reasonCode: "generation_run_owns_conversation_billing",
    },
    generationWorkLease: input.generationWorkLease,
  });
  if (prepared.attempt.status === "SUCCEEDED") {
    const replayed = validateComposedMessageDraftV3({
      draft: prepared.attempt.responseSnapshot,
      plan: context.parsedPlan,
      evidence: evidence.map(({ content: _content, ...item }) => item),
      actionResults,
      goalOutcomes: resolveComposerSourceGoalOutcomesV3({
        plan: context.parsedPlan,
        executionEpoch: context.plan.executionEpoch,
        stateVersion: authorizationVersion,
        actionOutcomes,
      }),
      ...(knowledgeFallbacks.length ? { knowledgeFallbacks } : {}),
    });
    if (!replayed.ok) {
      throw new Error("Replayed V3 governed composer result is invalid.");
    }
    if (knowledgeFallbacks.some((fallback) =>
      fallback.status !== "not_found" && fallback.status !== "unavailable")) {
      await failConversationTurnPlan({
        planId: context.plan.id,
        reason: "primary_capability_unexecuted_stable_general_fallback_delivered",
      });
    } else if (sourceActions.every((action) =>
      action.status === "SUCCEEDED" || action.status === "SKIPPED")) {
      await completeConversationTurnPlan({ planId: context.plan.id });
    }
    return {
      text: renderComposedV3Draft(replayed.draft, {
        fallbackDisclosures: buildKnowledgeFallbackDisclosureMap(
          knowledgeFallbacks,
        ),
      }),
      provider: context.plan.plannerProvider ?? "persisted",
      model: context.plan.plannerModel ?? "persisted",
      citedEvidenceIds: replayed.draft.segments.flatMap((segment) =>
        segment.kind === "claim"
          ? segment.evidenceRefs
          : segment.kind === "inference"
            ? segment.inferenceFromRefs
            : []),
      sourceActionKeys: sourceActions.map((action) => action.actionKey),
      fallbackActivated: knowledgeFallbacks.length > 0,
    };
  }
  await input.leaseGuard.confirmOwned();
  const executionLeaseToken = prepared.attempt.executionLeaseToken;
  if (!executionLeaseToken) {
    throw new Error("V3 governed composer lost its execution lease.");
  }
  await markV3InlineActionCallStarted({
    executionAttemptId: prepared.attempt.id,
    expectedExecutionLeaseToken: executionLeaseToken,
  });
  const closeComposerFailure = async (error: unknown): Promise<never> => {
    await failV3InlinePlanExecution({
      executionAttemptId: prepared.attempt.id,
      expectedExecutionLeaseToken: executionLeaseToken,
      reasonCode: error instanceof Error
        ? error.message
        : "v3_governed_composer_failed",
    });
    throw error;
  };
  const composed = await composeTurnV3({
    plan: context.parsedPlan,
    taskInput: input.taskInput,
    responseLanguage: context.plan.language ?? undefined,
    actionResults,
    evidence,
    goalOutcomes: resolveComposerSourceGoalOutcomesV3({
      plan: context.parsedPlan,
      executionEpoch: context.plan.executionEpoch,
      stateVersion: authorizationVersion,
      actionOutcomes,
    }),
    ...(knowledgeFallbacks.length ? { knowledgeFallbacks } : {}),
    representativeStyle: input.representativeStyle,
  }).catch(closeComposerFailure);
  if (!composed.ok) {
    const compositionFailure = formatV3ComposerFailure(composed);
    await completeV3InlineAction({
      executionAttemptId: prepared.attempt.id,
      expectedExecutionLeaseToken: executionLeaseToken,
      transportOutcome: "transport_failed",
      expectedOutputSchema: context.composeDefinition.expectedOutputSchema,
    }).catch(closeComposerFailure);
    await failConversationTurnPlan({
      planId: context.plan.id,
      actionId: context.composeAction.id,
      reason: compositionFailure,
    });
    return null;
  }
  await completeV3InlineAction({
    executionAttemptId: prepared.attempt.id,
    expectedExecutionLeaseToken: executionLeaseToken,
    transportOutcome: "response_received",
    rawOutput: composed.draft,
    expectedOutputSchema: context.composeDefinition.expectedOutputSchema,
    evidenceBindings: evidence,
  }).catch(closeComposerFailure);
  if (knowledgeFallbacks.some((fallback) =>
    fallback.status !== "not_found" && fallback.status !== "unavailable")) {
    await failConversationTurnPlan({
      planId: context.plan.id,
      reason: "primary_capability_unexecuted_stable_general_fallback_delivered",
    });
  } else if (sourceActions.every((action) =>
    action.status === "SUCCEEDED" || action.status === "SKIPPED")) {
    await completeConversationTurnPlan({ planId: context.plan.id });
  }
  const rendered = renderComposedV3Draft(composed.draft, {
    fallbackDisclosures: buildKnowledgeFallbackDisclosureMap(
      knowledgeFallbacks,
    ),
  });
  return {
    text: rendered,
    provider: composed.provider,
    model: composed.model,
    citedEvidenceIds: composed.draft.segments.flatMap((segment) =>
      segment.kind === "claim"
        ? segment.evidenceRefs
        : segment.kind === "inference"
          ? segment.inferenceFromRefs
          : []),
    sourceActionKeys: sourceActions.map((action) =>
      actionKeyById.get(action.id) ?? action.actionKey),
    planActionId: context.composeAction.id,
    fallbackActivated: knowledgeFallbacks.length > 0,
  };
}

async function executeV3PreExecutionStableGeneralFallback(input: {
  config: ConversationWorkerConfig;
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
  planned: NonNullable<Awaited<ReturnType<typeof runTurnPlannerV3>>>;
  leaseGuard: ReturnType<typeof startGenerationLeaseHeartbeat>;
  continuationAuthorized: boolean;
  activationStatus: KnowledgeFallbackActivationV3["status"];
  entitlementReservation?: ConversationEntitlementReservation | null;
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
}) {
  if (!input.planned.result.ok || !input.planned.persistedPlan) return null;
  const plan = input.planned.result.plan;
  const fallbacks: KnowledgeFallbackActivationV3[] = [];
  recordCapabilityFallbackActivationsV3({
    plan,
    status: input.activationStatus,
    target: fallbacks,
  });
  if (
    fallbacks.length !== plan.goals.length
    || plan.goals.some((goal) =>
      goal.operation === "create"
      || goal.operation === "mutate"
      || goal.operation === "deliver"
      || goal.operation === "control")
  ) return null;
  const composerAction = plan.actions.find((action) =>
    action.capability.key === "response.compose");
  const persistedComposer = composerAction
    ? input.planned.persistedPlan.actions.find((action: { actionKey: string }) =>
        action.actionKey === composerAction.id)
    : null;
  if (!composerAction || !persistedComposer) return null;
  let authorizationVersion = 0;
  for (const phase of ["initial", "pre_execution"] as const) {
    const decision = await recordConversationPlanActionAuthorization({
      planActionId: persistedComposer.id,
      phase,
      decision: "allow",
      reason: "The server-owned stable-general fallback is evidence-free and the external action was confirmed unexecuted.",
      policyVersion: "turn-plan-v3-stable-fallback.1",
    });
    authorizationVersion = decision.sequence;
  }
  const prepared = await prepareV3InlineAction({
    planActionId: persistedComposer.id,
    expectedAuthorizationVersion: authorizationVersion,
    executor: "builtin",
    billingAdmission: {
      decision: "not_billable",
      reasonCode: "generation_run_owns_conversation_billing",
    },
    generationWorkLease: {
      outboxId: input.item.outboxId,
      leaseAttempt: input.item.leaseAttempt,
    },
  });
  const goalOutcomes = plan.goals.map((goal) => ({
    goalId: goal.id,
    status: "failed" as const,
  }));
  let draft: ComposedMessageDraftV3;
  let provider: "agicto" | "openai" | "bailian" | "anthropic" | undefined;
  let model: string | undefined;
  if (prepared.attempt.status === "SUCCEEDED") {
    const replayed = validateComposedMessageDraftV3({
      draft: prepared.attempt.responseSnapshot,
      plan,
      evidence: [],
      actionResults: [],
      goalOutcomes,
      knowledgeFallbacks: fallbacks,
    });
    if (!replayed.ok) return null;
    draft = replayed.draft;
  } else {
    const executionLeaseToken = prepared.attempt.executionLeaseToken;
    if (!executionLeaseToken) return null;
    await markV3InlineActionCallStarted({
      executionAttemptId: prepared.attempt.id,
      expectedExecutionLeaseToken: executionLeaseToken,
    });
    const composed = await composeTurnV3({
      plan,
      taskInput: {
        text: input.item.userText,
        language: /\p{Script=Han}/u.test(input.item.userText) ? "zh" : "en",
      },
      responseLanguage: /\p{Script=Han}/u.test(input.item.userText) ? "zh" : "en",
      actionResults: [],
      evidence: [],
      goalOutcomes,
      knowledgeFallbacks: fallbacks,
      representativeStyle: buildRepresentativeResponseStyle(input.setup),
    });
    if (!composed.ok) return null;
    draft = composed.draft;
    provider = composed.provider as typeof provider;
    model = composed.model;
    await completeV3InlineAction({
      executionAttemptId: prepared.attempt.id,
      expectedExecutionLeaseToken: executionLeaseToken,
      transportOutcome: "response_received",
      rawOutput: draft,
      expectedOutputSchema: composerAction.expectedOutputSchema,
      evidenceBindings: [],
    });
  }
  await failConversationTurnPlan({
    planId: plan.planId,
    reason: `primary_capability_${input.activationStatus}_stable_general_fallback_delivered`,
  });
  const finalText = renderComposedV3Draft(draft, {
    fallbackDisclosures: buildKnowledgeFallbackDisclosureMap(fallbacks),
  });
  const completed = await completeInlineGenerationRun({
    conversationId: input.item.conversationId,
    runId: input.item.runId,
    outboxId: input.item.outboxId,
    leaseAttempt: input.item.leaseAttempt,
    replyText: finalText,
    senderDisplayName: input.item.representativeName,
    intent: "turn_plan_v3_stable_general_fallback",
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    runtimeOutcome: { mode: "model" },
    countUsage: input.continuationAuthorized,
    completeOutbox: false,
    ...(input.entitlementReservation
      ? { entitlementReservation: input.entitlementReservation }
      : {}),
  });
  await input.leaseGuard.confirmOwned();
  await deliverGenerationOutput({
    config: input.config,
    item: input.item,
    text: completed.message.text ?? finalText,
    outputMessageId: completed.message.id,
    planActionId: persistedComposer.id,
  });
  return {
    processed: true as const,
    runId: input.item.runId,
    status: "completed" as const,
  };
}

async function executeV3ManagedDocumentPlan(input: {
  config: ConversationWorkerConfig;
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  planned: NonNullable<Awaited<ReturnType<typeof runTurnPlannerV3>>>;
  leaseGuard: ReturnType<typeof startGenerationLeaseHeartbeat>;
  continuationAuthorized: boolean;
  entitlementReservation?: ConversationEntitlementReservation | null;
}) {
  if (
    input.planned.rolloutMode !== "active_governed"
    || !input.planned.result.ok
    || !input.planned.persistedPlan
  ) return null;
  const artifactAction = input.planned.result.plan.actions.find((action) =>
    action.capability.key === "artifact.generate_document");
  if (!artifactAction) return null;
  const composerAction = input.planned.result.plan.actions.find((action) =>
    action.capability.key === "response.compose");
  if (
    !composerAction
    || input.planned.result.plan.actions.length !== 2
    || input.planned.result.plan.actions.some((action) =>
      action.id !== artifactAction.id && action.id !== composerAction.id)
  ) {
    throw new Error("V3 managed document plan mixes unsupported capability actions.");
  }
  if (input.planned.result.plan.envelopeHash.length === 0) {
    throw new Error("V3 managed document plan envelope fence is missing.");
  }
  if (input.planned.result.plan.actions.some((action) =>
    action.id === composerAction.id
    && !action.dependencies.some((dependency) =>
      dependency.actionId === artifactAction.id))) {
    throw new Error("V3 managed document composer is not dependent on the artifact action.");
  }
  if (input.planned.result.plan.scopeKey.kind !== "generation_turn") {
    throw new Error("V3 managed document plan has an unsupported execution scope.");
  }
  const persistedByKey = new Map(
    input.planned.persistedPlan.actions.map((action: { actionKey: string; id: string }) =>
      [action.actionKey, action] as const),
  );
  const persistedArtifact = persistedByKey.get(artifactAction.id);
  const persistedComposer = persistedByKey.get(composerAction.id);
  if (!persistedArtifact || !persistedComposer) {
    throw new Error("V3 managed document persistence lost an action coordinate.");
  }
  const topic = artifactAction.arguments["topic"];
  const audience = artifactAction.arguments["audience"];
  const requestedFormat = artifactAction.arguments["format"];
  const format = requestedFormat === "markdown" || requestedFormat === "txt"
    ? requestedFormat
    : "markdown";
  if (typeof topic !== "string" || !topic.trim()) {
    throw new Error("V3 managed document topic is missing.");
  }
  if (!input.continuationAuthorized) {
    await recordConversationPlanActionAuthorization({
      planActionId: persistedArtifact.id,
      phase: "initial",
      decision: "deny",
      reason: "No free or purchased service entitlement is available for this document run.",
      policyVersion: "turn-plan-v3-managed-document.1",
    });
    await failConversationTurnPlan({
      planId: input.planned.persistedPlan.id,
      actionId: persistedArtifact.id,
      reason: "service_entitlement_required",
    });
    return completeTerminalDelegationFailure(
      input.config,
      input.item,
      "当前没有可用的免费或已购服务额度，因此没有生成文件。补充服务额度后可以重新发送同一请求。",
      input.entitlementReservation ?? undefined,
    );
  }
  let artifactAuthorizationVersion = 0;
  for (const phase of ["initial", "pre_execution"] as const) {
    const decision = await recordConversationPlanActionAuthorization({
      planActionId: persistedArtifact.id,
      phase,
      decision: "allow",
      reason: "Platform-managed document generation is an internal, CAS-bound artifact write.",
      policyVersion: "turn-plan-v3-managed-document.1",
    });
    artifactAuthorizationVersion = decision.sequence;
  }
  const attempt = await prepareV3InlineAction({
    planActionId: persistedArtifact.id,
    expectedAuthorizationVersion: artifactAuthorizationVersion,
    executor: "builtin",
    billingAdmission: {
      decision: "not_billable",
      reasonCode: "generation_run_owns_conversation_billing",
    },
    generationWorkLease: {
      outboxId: input.item.outboxId,
      leaseAttempt: input.item.leaseAttempt,
    },
  });
  await input.leaseGuard.confirmOwned();
  const artifactExecutionLeaseToken = attempt.attempt.executionLeaseToken;
  if (attempt.attempt.status !== "SUCCEEDED") {
    if (!artifactExecutionLeaseToken) {
      throw new Error("V3 managed document action lost its execution lease.");
    }
    await markV3InlineActionCallStarted({
      executionAttemptId: attempt.attempt.id,
      expectedExecutionLeaseToken: artifactExecutionLeaseToken,
    });
  }
  const preparedArtifact = await prepareManagedConversationDocumentArtifact({
    representativeId: input.setup.id,
    representativeSlug: input.item.representativeSlug,
    conversationId: input.item.conversationId,
    generationRunId: input.item.runId,
    planActionId: persistedArtifact.id,
    generationWorkLease: {
      outboxId: input.item.outboxId,
      leaseAttempt: input.item.leaseAttempt,
    },
  });
  let documentProvider: string | undefined;
  let documentModel: string | undefined;
  const managedArtifact = preparedArtifact.status === "succeeded"
    ? preparedArtifact.result
    : await (async () => {
        await input.leaseGuard.confirmOwned();
        const generation = await generateManagedDocument({
          userText: input.item.userText,
          topic,
          ...(typeof audience === "string" && audience.trim() ? { audience } : {}),
          format,
          authorizedContext: [],
        });
        if (!generation.ok) {
          throw new Error(generation.reason);
        }
        documentProvider = generation.provider;
        documentModel = generation.model;
        await input.leaseGuard.confirmOwned();
        return createManagedConversationDocumentArtifact({
          representativeId: input.setup.id,
          representativeSlug: input.item.representativeSlug,
          contactId: input.item.contactId,
          conversationId: input.item.conversationId,
          generationRunId: input.item.runId,
          planActionId: persistedArtifact.id,
          claim: preparedArtifact.claim,
          generationWorkLease: {
            outboxId: input.item.outboxId,
            leaseAttempt: input.item.leaseAttempt,
          },
          title: generation.title,
          format: generation.sourceFormat,
          content: generation.content,
          retentionDays: input.setup.compute.artifactRetentionDays,
        });
      })();
  const artifactResult = await completeV3InlineAction({
    executionAttemptId: attempt.attempt.id,
    expectedExecutionLeaseToken:
      artifactExecutionLeaseToken ?? "completed-inline-attempt",
    transportOutcome: "response_received",
    rawOutput: {
      artifactId: managedArtifact.artifact.id,
      fileName: managedArtifact.fileName,
    },
    expectedOutputSchema: artifactAction.expectedOutputSchema,
    artifactRefs: [managedArtifact.artifact.id],
  });
  const artifactDefinition = input.planned.catalog.capabilities.find((candidate) =>
    candidate.key === artifactAction.capability.key
    && candidate.version === artifactAction.capability.version);
  if (!artifactDefinition) {
    throw new Error("V3 managed document capability definition is missing.");
  }
  const evidence = [{
    evidenceId: artifactResult.result.id,
    evidenceClass: "tool_output" as const,
    content: artifactResult.verified.sanitizedOutput,
    goalIds: input.planned.result.plan.goals
      .filter((goal) => goal.actionIds.includes(artifactAction.id))
      .map((goal) => goal.id),
    sourceActionId: artifactAction.id,
    actionResultId: artifactResult.result.id,
    sourceKinds: composerSourceKindsForCapabilityV3(
      artifactDefinition,
      "tool_output",
    ),
  }];
  let composerAuthorizationVersion = 0;
  for (const phase of ["initial", "pre_execution"] as const) {
    const decision = await recordConversationPlanActionAuthorization({
      planActionId: persistedComposer.id,
      phase,
      decision: "allow",
      reason: "response.compose reads the verified managed artifact result only.",
      policyVersion: "turn-plan-v3-composer.1",
    });
    composerAuthorizationVersion = decision.sequence;
  }
  const composerAttempt = await prepareV3InlineAction({
    planActionId: persistedComposer.id,
    expectedAuthorizationVersion: composerAuthorizationVersion,
    executor: "builtin",
    billingAdmission: {
      decision: "not_billable",
      reasonCode: "generation_run_owns_conversation_billing",
    },
    generationWorkLease: {
      outboxId: input.item.outboxId,
      leaseAttempt: input.item.leaseAttempt,
    },
  });
  let replyText: string;
  let composerProvider: string | undefined;
  let composerModel: string | undefined;
  const replayedDraft = composerAttempt.attempt.status === "SUCCEEDED"
    ? validateComposedMessageDraftV3({
        draft: composerAttempt.attempt.responseSnapshot,
        plan: input.planned.result.plan,
        evidence: evidence.map(({ content: _content, ...item }) => item),
        actionResults: [{
          actionId: artifactAction.id,
          actionResultId: artifactResult.result.id,
          transportOutcome: artifactResult.verified.transportOutcome,
          semanticOutcome: artifactResult.verified.semanticOutcome,
        }],
        goalOutcomes: resolveComposerSourceGoalOutcomesV3({
          plan: input.planned.result.plan,
          executionEpoch: input.planned.persistedPlan.executionEpoch,
          stateVersion: composerAuthorizationVersion,
          actionOutcomes: [{ actionId: artifactAction.id, status: "succeeded" }],
        }),
      })
    : null;
  if (composerAttempt.attempt.status === "SUCCEEDED" && !replayedDraft?.ok) {
    throw new Error("Replayed V3 managed document composer result is invalid.");
  }
  if (replayedDraft?.ok) {
    replyText = renderComposedV3Draft(replayedDraft.draft);
    await completeConversationTurnPlan({ planId: input.planned.persistedPlan.id });
  } else {
    await input.leaseGuard.confirmOwned();
    const composerExecutionLeaseToken = composerAttempt.attempt.executionLeaseToken;
    if (!composerExecutionLeaseToken) {
      throw new Error("V3 managed document composer lost its execution lease.");
    }
    await markV3InlineActionCallStarted({
      executionAttemptId: composerAttempt.attempt.id,
      expectedExecutionLeaseToken: composerExecutionLeaseToken,
    });
    const composed = await composeTurnV3({
      plan: input.planned.result.plan,
      taskInput: {
        text: input.item.userText,
        language: /\p{Script=Han}/u.test(input.item.userText) ? "zh" : "en",
      },
      responseLanguage: /\p{Script=Han}/u.test(input.item.userText) ? "zh" : "en",
      actionResults: [{
        actionId: artifactAction.id,
        actionResultId: artifactResult.result.id,
        transportOutcome: artifactResult.verified.transportOutcome,
        semanticOutcome: artifactResult.verified.semanticOutcome,
      }],
      evidence,
      goalOutcomes: resolveComposerSourceGoalOutcomesV3({
        plan: input.planned.result.plan,
        executionEpoch: input.planned.persistedPlan.executionEpoch,
        stateVersion: composerAuthorizationVersion,
        actionOutcomes: [{ actionId: artifactAction.id, status: "succeeded" }],
      }),
      representativeStyle: buildRepresentativeResponseStyle(input.setup),
    });
    if (composed.ok) {
    await completeV3InlineAction({
      executionAttemptId: composerAttempt.attempt.id,
      expectedExecutionLeaseToken: composerExecutionLeaseToken,
      transportOutcome: "response_received",
      rawOutput: composed.draft,
      expectedOutputSchema: composerAction.expectedOutputSchema,
      evidenceBindings: evidence,
    });
    replyText = renderComposedV3Draft(composed.draft);
    composerProvider = composed.provider;
    composerModel = composed.model;
    await completeConversationTurnPlan({ planId: input.planned.persistedPlan.id });
    } else {
      const compositionFailure = formatV3ComposerFailure(composed);
      await completeV3InlineAction({
        executionAttemptId: composerAttempt.attempt.id,
        expectedExecutionLeaseToken: composerExecutionLeaseToken,
        transportOutcome: "transport_failed",
        expectedOutputSchema: composerAction.expectedOutputSchema,
      });
      await failConversationTurnPlan({
        planId: input.planned.persistedPlan.id,
        actionId: persistedComposer.id,
        reason: compositionFailure,
      });
      replyText = `文档已安全生成，但最终响应编排失败。文件仍可下载：${managedArtifact.fileName}`;
    }
  }
  const downloadUrl = resolveManagedArtifactDownloadUrl(
    input.config,
    managedArtifact.downloadUrl,
    input.item.channel,
  );
  if (input.item.channel !== "web") {
    replyText = `${replyText}\n\n下载：${downloadUrl}`;
  }
  const completed = await completeInlineGenerationRun({
    conversationId: input.item.conversationId,
    runId: input.item.runId,
    outboxId: input.item.outboxId,
    leaseAttempt: input.item.leaseAttempt,
    replyText,
    senderDisplayName: input.item.representativeName,
    intent: "turn_plan_v3_managed_document",
    ...(composerProvider
      ? { provider: composerProvider as "agicto" | "openai" | "bailian" | "anthropic" }
      : documentProvider
        ? { provider: documentProvider as "agicto" | "openai" | "bailian" | "anthropic" }
        : {}),
    ...(composerModel
      ? { model: composerModel }
      : documentModel
        ? { model: documentModel }
        : {}),
    runtimeOutcome: { mode: "model" },
    attachments: [{
      fileName: managedArtifact.fileName,
      mimeType: managedArtifact.mimeType,
      sizeBytes: managedArtifact.sizeBytes,
      artifactId: managedArtifact.artifact.id,
      url: downloadUrl,
    }],
    countUsage: input.continuationAuthorized,
    completeOutbox: false,
    ...(input.entitlementReservation
      ? { entitlementReservation: input.entitlementReservation }
      : {}),
  });
  await deliverGenerationOutput({
    config: input.config,
    item: input.item,
    text: replyText,
    outputMessageId: completed.message.id,
    planActionId: persistedComposer.id,
  });
  return { processed: true as const, runId: input.item.runId, status: "completed" as const };
}

function formatV3ComposerFailure(input: {
  reason: string;
  diagnostics?: Array<{
    provider: string;
    model: string;
    stage: string;
    issueCodes: string[];
  }>;
}) {
  const diagnostics = input.diagnostics?.slice(0, 8).map((item) =>
    `${item.provider}/${item.model}:${item.stage}:${item.issueCodes.slice(0, 8).join("+")}`);
  return diagnostics?.length
    ? `${input.reason} diagnostics=${diagnostics.join(",")}`.slice(0, 2_000)
    : input.reason;
}

export function renderComposedV3Draft(
  draft: ComposedMessageDraftV3,
  options?: { fallbackDisclosures?: Map<string, string> },
) {
  const disclosedGoals = new Set<string>();
  return draft.segments.flatMap((segment) => {
    const rendered = segment.kind === "claim"
      ? segment.text
      : segment.kind === "inference"
        ? segment.text
        : (() => {
            switch (segment.statusCode) {
              case "goal_succeeded": return "相关目标已完成。";
              case "goal_partial": return "相关目标仅部分完成。";
              case "goal_failed": return "相关目标未能完成。";
              case "goal_waiting": return "相关目标仍在等待。";
              case "goal_reconciliation_required": return "相关目标需要核对外部结果。";
            }
          })();
    const disclosure = segment.kind !== "status"
      && !disclosedGoals.has(segment.goalId)
      ? options?.fallbackDisclosures?.get(segment.goalId)
      : undefined;
    if (disclosure) disclosedGoals.add(segment.goalId);
    return [disclosure, rendered].filter((item): item is string => Boolean(item));
  }).join("\n\n");
}

function buildRepresentativeResponseStyle(input: {
  name: string;
  tone: string;
}) {
  return {
    representativeName: input.name,
    tone: input.tone,
  };
}

function isActiveManagedDocumentPlan(
  planned: Awaited<ReturnType<typeof runTurnPlannerV2Shadow>>,
  config: ConversationWorkerConfig,
) {
  return Boolean(
    planned?.result.ok
    && planned.active
    && isEligibleManagedDocumentTurnPlan(planned.result.plan)
    && planned.envelope.attachments.length === 0
    && (
      planned.envelope.channel.kind === "web"
      || (
        Boolean(config.representativePublicOrigin)
        && typeof planned.envelope.actorIdentity["audienceIdentityId"] === "string"
        && Boolean(planned.envelope.actorIdentity["audienceIdentityId"])
      )
    )
  );
}

function isManagedDocumentPlanBlockedByUnusableAttachments(
  planned: Awaited<ReturnType<typeof runTurnPlannerV2Shadow>>,
) {
  return Boolean(
    planned?.result.ok
    && isEligibleManagedDocumentTurnPlan(planned.result.plan)
    && planned.envelope.attachments.length > 0
    && planned.envelope.authorizedContext.length === 0
  );
}

type V2DetailedPlannerConstraint = {
  families: Set<"compute" | "mcp" | "skill">;
  orderedComputeCapabilities: Array<
    "exec" | "read" | "write" | "process" | "browser"
  >;
  mcpActionCount: number;
};

function resolveV2DetailedPlannerConstraint(
  planned: Awaited<ReturnType<typeof runTurnPlannerV2Shadow>>,
): V2DetailedPlannerConstraint | null {
  if (!planned?.result.ok) return null;
  const families = new Set<"compute" | "mcp" | "skill">();
  const orderedComputeCapabilities: Array<
    "exec" | "read" | "write" | "process" | "browser"
  > = [];
  let mcpActionCount = 0;
  for (const action of planned.result.plan.actions) {
    if (action.capability.key.startsWith("compute.")) {
      families.add("compute");
      const capability = action.capability.key.slice("compute.".length);
      if (
        capability === "exec"
        || capability === "read"
        || capability === "write"
        || capability === "process"
        || capability === "browser"
      ) {
        orderedComputeCapabilities.push(capability);
      }
    } else if (action.capability.key.startsWith("mcp.")) {
      families.add("mcp");
      mcpActionCount += 1;
    } else if (action.capability.key.startsWith("skill.")) {
      families.add("skill");
    }
  }
  return families.size
    ? { families, orderedComputeCapabilities, mcpActionCount }
    : null;
}

function detailedPlannerMatchesV2Constraint(
  constraint: V2DetailedPlannerConstraint,
  requests: ParsedComputeRequest[],
) {
  if (!requests.length || constraint.families.size !== 1) return false;
  const [family] = constraint.families;
  if (family === "compute") {
    return requests.length === constraint.orderedComputeCapabilities.length
      && requests.every((request, index) =>
        request.capability !== "mcp"
        && request.capability
          === constraint.orderedComputeCapabilities[index]);
  }
  if (family === "mcp") {
    return requests.length === constraint.mcpActionCount
      && requests.every((request) => request.capability === "mcp");
  }
  // The legacy detailed planner does not yet emit a governed Skill request.
  return false;
}

function isEligibleManagedDocumentTurnPlan(plan: TurnPlanV2) {
  if (
    plan.mode !== "execute"
    || plan.actions.length !== 1
    || plan.deliverables.length !== 1
  ) {
    return false;
  }
  const action = plan.actions[0];
  const deliverable = plan.deliverables[0];
  if (
    !action
    || !deliverable
    || action.capability.key !== "artifact.generate_document"
    || deliverable.kind !== "artifact"
    || deliverable.producedByActionIds.length !== 1
    || deliverable.producedByActionIds[0] !== action.id
  ) {
    return false;
  }
  if (
    plan.questions.some((question) =>
      question.requiredForActionIds.includes(action.id))
    || plan.uncertainties.some((uncertainty) =>
      uncertainty.blocksActionIds.includes(action.id))
  ) {
    return false;
  }
  const format = action.arguments["format"];
  const resolvedFormat = typeof format === "undefined" ? "markdown" : format;
  return (
    resolvedFormat === "markdown"
    || resolvedFormat === "txt"
  ) && (
    deliverable.format === null
    || deliverable.format === resolvedFormat
  );
}

function hasManagedDocumentAction(plan: TurnPlanV2) {
  return plan.actions.some(
    (action) => action.capability.key === "artifact.generate_document",
  );
}

function buildSkillCapabilityDrafts(
  skillPacks: Array<{
    slug: string;
    displayName: string;
    summary: string;
    version?: string | undefined;
    capabilityTags: string[];
    executesCode: boolean;
    enabled: boolean;
  }>,
): CapabilityDescriptorDraft[] {
  return skillPacks.filter((pack) => pack.enabled).map((pack) => ({
    key: `skill.${normalizeCapabilitySegment(pack.slug)}`,
    version: pack.version ?? "1",
    description: `${pack.displayName}: ${pack.summary}`,
    inputSchema: closedObjectSchema({ request: { type: "string" } }, ["request"]),
    outputSchema: closedObjectSchema({ result: { type: "string" } }, ["result"]),
    effect: pack.executesCode ? "external_reversible" : "read_only",
    executor: "skill",
    idempotency: pack.executesCode ? "requires_key" : "naturally_idempotent",
    supportedChannels: ["web", "matrix", "telegram"],
    requiredIdentityScopes: [],
    requiredDataScopes: [],
    tags: [pack.displayName, ...pack.capabilityTags],
  }));
}

function buildRepresentativeCapabilityOutcomes(
  capabilities: Array<{
    key: string;
    description: string;
    executor: "builtin" | "knowledge" | "mcp" | "compute" | "skill";
  }>,
) {
  const outcomes = new Set<string>();
  for (const capability of capabilities) {
    if (
      capability.key === "response.compose"
      || capability.key === "representative.describe_self"
    ) continue;
    if (capability.executor === "knowledge") {
      outcomes.add("依据 Owner 发布并授权的知识资料回答相关问题");
    } else if (capability.key === "artifact.generate_document") {
      outcomes.add("生成报告、教程、指南和清单等结构化文档");
    } else if (capability.executor === "compute") {
      outcomes.add("在受控环境中完成资料处理、计算、文件和浏览任务");
    } else if (capability.executor === "mcp") {
      outcomes.add("在需要时使用已发布且经过治理的外部工具获取或处理信息");
    } else if (capability.executor === "skill") {
      outcomes.add(capability.description);
    }
  }
  return outcomes.size
    ? [...outcomes]
    : ["根据 Owner 发布的代表资料进行对话和答疑"];
}

function buildRepresentativeHumanConfirmation(
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>,
) {
  const enabled = setup.humanInLoop === true;
  const handoffAccessMode = setup.handoffAccessMode === "FREE"
    ? "FREE" as const
    : "PACKAGE_REQUIRED" as const;
  const configuredPrompt = typeof setup.handoffPrompt === "string"
    ? setup.handoffPrompt.trim()
    : "";
  const handoffPrompt = enabled
    ? configuredPrompt || "请简要描述需要真人确认或接手的事项。"
    : "";
  const governanceBoundary =
    "数字代表只能在 Owner 已发布的能力与授权范围内工作；需要真人作出承诺、审批或承担责任的事项，必须由真人确认。";
  const handoffState = !enabled
    ? "当前未启用真人接管；数字代表不会承诺或假定真人将接手。"
    : handoffAccessMode === "FREE"
      ? "当前已启用真人接管，可按提示直接提出申请；是否接手及后续安排以真人确认为准。"
      : "当前已启用真人接管，但申请前需满足相应服务权益；是否接手及后续安排以真人确认为准。";
  return {
    enabled,
    handoffAccessMode,
    handoffPrompt,
    userFacingStatements: [governanceBoundary, handoffState],
  };
}

export function buildRepresentativeDescriptionOutput(input: {
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  capabilities: Array<{
    key: string;
    description: string;
    executor: "builtin" | "knowledge" | "mcp" | "compute" | "skill";
    definitionHash: string;
  }>;
  availability: Array<{
    definitionHash: string;
    healthState: "ready" | "degraded" | "unavailable";
  }>;
  knowledgeStatus: "found" | "not_found" | "unavailable";
  knowledgeItems: Array<{ evidenceId: string; content: string }>;
}) {
  const advertisedDefinitionHashes = new Set(
    input.availability
      .filter((item) =>
        item.healthState === "ready" || item.healthState === "degraded")
      .map((item) => item.definitionHash),
  );
  return {
    profile: {
      representativeName: input.setup.name,
      ownerName: input.setup.ownerName,
      tagline: input.setup.tagline,
      tone: input.setup.tone,
      languages: input.setup.languages,
    },
    capabilityOutcomes: buildRepresentativeCapabilityOutcomes(
      input.capabilities.filter((capability) =>
        advertisedDefinitionHashes.has(capability.definitionHash)),
    ),
    humanConfirmation: buildRepresentativeHumanConfirmation(input.setup),
    knowledgeStatus: input.knowledgeStatus,
    knowledgeEvidenceRefs: input.knowledgeItems.map((item) => item.evidenceId),
    knowledgeItems: input.knowledgeItems,
  };
}

function renderKnowledgeFallbackDisclosure(
  status: KnowledgeFallbackActivationV3["status"],
) {
  return status === "not_found" || status === "unavailable"
    ? generalModelAnswerSourceStatement
    : "";
}

function buildKnowledgeFallbackDisclosureMap(
  fallbacks: KnowledgeFallbackActivationV3[],
) {
  return new Map(fallbacks.map((fallback) => [
    fallback.goalId,
    renderKnowledgeFallbackDisclosure(fallback.status),
  ]));
}

function buildMcpCapabilityDrafts(
  bindings: Array<{
    slug: string;
    allowedToolNames: string[];
    defaultToolName: string | null;
    approvalRequired: boolean;
  }>,
): CapabilityDescriptorDraft[] {
  return bindings.flatMap((binding) => {
    const names = binding.allowedToolNames.length
      ? binding.allowedToolNames
      : binding.defaultToolName ? [binding.defaultToolName] : [];
    return names.map((toolName) => ({
      key: `mcp.${normalizeCapabilitySegment(binding.slug)}.${normalizeCapabilitySegment(toolName)}`,
      version: "1",
      description: `Call ${toolName} on the published MCP binding ${binding.slug}.`,
      inputSchema: closedObjectSchema({ request: { type: "string" } }, ["request"]),
      outputSchema: closedObjectSchema({ result: { type: "string" } }, ["result"]),
      effect: binding.approvalRequired
        ? "external_reversible" as const
        : "read_only" as const,
      executor: "mcp" as const,
      idempotency: binding.approvalRequired
        ? "requires_key" as const
        : "naturally_idempotent" as const,
      supportedChannels: ["web", "matrix", "telegram"],
      requiredIdentityScopes: [],
      requiredDataScopes: [],
      tags: [binding.slug, toolName],
    }));
  });
}

function buildComputeCapabilityDrafts(
  compute: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeAuthoritySnapshot>>>["compute"] | undefined,
): CapabilityDescriptorDraft[] {
  if (!compute?.enabled) return [];
  return (["exec", "read", "write", "process", "browser"] as const)
    .filter((capability) => compute.capabilityModes[capability] !== "deny")
    .map((capability) => ({
      key: `compute.${capability}`,
      version: "1",
      description: `Use the governed isolated Compute ${capability} capability.`,
      inputSchema: closedObjectSchema({ request: { type: "string" } }, ["request"]),
      outputSchema: closedObjectSchema({ result: { type: "string" } }, ["result"]),
      effect: capability === "read" || capability === "browser"
        ? "read_only" as const
        : "internal_write" as const,
      executor: "compute" as const,
      idempotency: capability === "read"
        ? "naturally_idempotent" as const
        : "requires_key" as const,
      supportedChannels: ["web", "matrix", "telegram"],
      requiredIdentityScopes: [],
      requiredDataScopes: [],
      tags: ["compute", capability],
    }));
}

function closedObjectSchema(
  properties: Record<string, unknown>,
  required: string[],
) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function buildRepresentativeDescriptionOutputSchema() {
  return closedObjectSchema({
    profile: closedObjectSchema({
      representativeName: { type: "string", minLength: 1 },
      ownerName: { type: "string" },
      tagline: { type: "string" },
      tone: { type: "string" },
      languages: { type: "array", items: { type: "string" } },
    }, ["representativeName", "ownerName", "tagline", "tone", "languages"]),
    capabilityOutcomes: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
    },
    humanConfirmation: closedObjectSchema({
      enabled: { type: "boolean" },
      handoffAccessMode: {
        type: "string",
        enum: ["FREE", "PACKAGE_REQUIRED"],
      },
      handoffPrompt: { type: "string" },
      userFacingStatements: {
        type: "array",
        minItems: 2,
        items: { type: "string", minLength: 1 },
      },
    }, ["enabled", "handoffAccessMode", "handoffPrompt", "userFacingStatements"]),
    knowledgeStatus: {
      type: "string",
      enum: ["found", "not_found", "unavailable"],
    },
    knowledgeEvidenceRefs: { type: "array", items: { type: "string" } },
    knowledgeItems: {
      type: "array",
      items: closedObjectSchema({
        evidenceId: { type: "string" },
        content: { type: "string" },
      }, ["evidenceId", "content"]),
    },
  }, [
    "profile",
    "capabilityOutcomes",
    "humanConfirmation",
    "knowledgeStatus",
    "knowledgeEvidenceRefs",
    "knowledgeItems",
  ]);
}

function normalizeCapabilitySegment(value: string) {
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized || "capability";
}

function isConversationStatusCommand(text: string): boolean {
  const normalized = text.trim().replace(/\s+/gu, " ").toLowerCase();
  return normalized === "/status"
    || normalized === "!status"
    || normalized === "查询当前状态"
    || normalized === "查看当前状态";
}

function renderConversationOperationalStatus(
  context: Awaited<ReturnType<typeof loadConversationOperationalContext>>,
): string {
  if (!context) return "当前无法读取会话状态，请稍后重试。";
  const lines = [`会话状态：${context.conversationState}`];
  if (context.activeCollector) {
    lines.push("需求采集：等待你继续描述需求；发送“取消”可以结束本次采集。");
  }
  if (context.latestTask) {
    lines.push(
      `最近任务：${context.latestTask.status}（下一步：${context.latestTask.nextActionBy}）`,
    );
  }
  if (context.pendingApproval) {
    lines.push(`待审批动作：${context.pendingApproval.requestedActionSummary}`);
  }
  if (context.activeHandoff) {
    lines.push(`人工接手：${context.activeHandoff.status}`);
  }
  if (context.serviceEntitlement) {
    lines.push(`可用服务额度：${context.serviceEntitlement.remainingUnits}`);
  }
  if (lines.length === 1) lines.push("当前没有进行中的需求、审批或人工接手。");
  return lines.join("\n");
}

type PublicMaterialDelivery = {
  id: string;
  title: string;
  summary: string;
  url: string;
  processingVersion: number;
};

function buildConversationTurnTrace(
  plan: ConversationPlan,
  resolveExecution: (
    action: PlannedConversationAction,
  ) => ConversationActionExecutionResult,
  resolveAuthorization: (
    action: PlannedConversationAction,
  ) => ConversationTurnTrace["actions"][number]["authorization"] =
    authorizeConversationAction,
): ConversationTurnTrace {
  const intentResult = plan.intentResult ?? {
    primaryGoal: plan.goal,
    primaryIntent: plan.intent,
    businessLabels: [plan.intent],
    requestedOutcomes: [],
    entities: {},
    missingFields: [],
    confidence: 1,
    safetySignals: [],
  };
  const billingDecision = plan.billingDecision ?? {
    decision: plan.disposition === "payment_required"
      ? "payment_required" as const
      : plan.disposition === "handoff" || plan.disposition === "refuse"
        ? "no_charge" as const
        : "allow_free" as const,
    billable: !["payment_required", "handoff", "refuse"].includes(plan.disposition),
    reason: "Compatibility decision for a pre-protocol conversation plan.",
  };
  return {
    version: 1,
    plan: {
      goal: plan.goal,
      intent: plan.intent,
      businessLabels: intentResult.businessLabels,
      requestedOutcomes: intentResult.requestedOutcomes,
      disposition: plan.disposition,
      replyGoal: plan.replyGoal ?? "Produce the policy-selected conversation result.",
      reasons: plan.reasons ?? [],
    },
    billing: billingDecision,
    actions: (plan.actions ?? []).map((action) => ({
      id: action.id,
      kind: action.kind,
      authorization: resolveAuthorization(action),
      execution: resolveExecution(action),
    })),
  };
}

function isConversationPlanBillable(plan: ConversationPlan): boolean {
  return plan.billingDecision?.billable
    ?? !["payment_required", "handoff", "refuse"].includes(plan.disposition);
}

function buildCollectorTurnTrace(input: {
  state: StructuredCollectorState;
  continuationAuthorized: boolean;
  canceled: boolean;
  completed: boolean;
  serviceRequestId?: string | null;
}): ConversationTurnTrace {
  const billing = !input.continuationAuthorized || input.canceled
    ? {
        decision: "no_charge" as const,
        billable: false,
        reason: input.canceled
          ? "Canceled intake does not consume conversation usage."
          : "The intake is paused until service entitlement is available.",
      }
    : {
        decision: "allow_entitlement" as const,
        billable: true,
        reason: "The current conversation authorization permits intake continuation.",
      };
  const collectStatus: ConversationActionExecutionResult["status"] = input.canceled
    ? "denied"
    : input.completed
      ? "completed"
      : "waiting_input";
  const serviceStatus: ConversationActionExecutionResult["status"] = input.canceled
    ? "denied"
    : input.completed && input.serviceRequestId
      ? "completed"
      : "deferred";
  return {
    version: 1,
    plan: {
      goal: "provide_information",
      intent: input.state.intent,
      businessLabels: [input.state.intent],
      requestedOutcomes: ["create_service_request"],
      disposition: "collect",
      replyGoal: "继续收集一段需求描述并在完成后创建服务请求。",
      reasons: ["An existing request-description intake is active."],
    },
    billing,
    actions: [
      {
        id: `collect_request_description:${input.state.intent}`,
        kind: "collect_request_description",
        authorization: {
          decision: "allow",
          reason: "The user is continuing an existing request-description intake.",
        },
        execution: {
          actionId: `collect_request_description:${input.state.intent}`,
          status: collectStatus,
          summary: input.canceled
            ? "The user canceled request collection."
            : input.completed
              ? "The request description was collected."
              : "The intake is waiting for the request description.",
        },
      },
      {
        id: `create_service_request:${input.state.intent}`,
        kind: "create_service_request",
        authorization: {
          decision: "allow",
          reason: "Creating an internal service request grants no external authority.",
        },
        execution: {
          actionId: `create_service_request:${input.state.intent}`,
          status: serviceStatus,
          summary: input.serviceRequestId
            ? "The internal service request was created."
            : "Service-request creation remains deferred.",
          ...(input.serviceRequestId
            ? { output: { serviceRequestId: input.serviceRequestId } }
            : {}),
        },
      },
    ],
  };
}

async function selectPublicMaterialDeliveries(
  representative: ReturnType<typeof buildRepresentativeRuntimeProfile>,
  plan: ConversationPlan,
  userText: string,
): Promise<PublicMaterialDelivery[]> {
  if (!(plan.actions ?? []).some((action) => action.kind === "deliver_public_material")) {
    return [];
  }
  return resolveGovernedPublicMaterialDeliveries({
    representativeId: representative.id,
    representativeSlug: representative.slug,
    queryText: userText,
    businessLabels: plan.intentResult?.businessLabels ?? [],
    requestedOutcomes: plan.intentResult?.requestedOutcomes ?? [],
    legacyMaterials: representative.knowledgePack.materials,
  });
}

function renderPublicMaterialDeliveries(materials: PublicMaterialDelivery[]): string {
  if (!materials.length) {
    return "当前发布版本没有可直接发送的公开资料链接。";
  }
  return [
    "公开资料",
    ...materials.map((material) =>
      `${material.title}\n${material.summary}\n${material.url}`
    ),
  ].join("\n\n");
}

export async function processNextConversationWork(config: ConversationWorkerConfig) {
  const telegramWorkerEnabled =
    config.telegramConversationPlatformMode === "worker";
  const operatorItem = await claimNextOperatorMessageWorkItem({
    telegramWorkerEnabled,
    ...(config.outboxProcessingLeaseMs
      ? { processingLeaseMs: config.outboxProcessingLeaseMs }
      : {}),
  });
  if (operatorItem) {
    const operatorLeaseAttempt = Number.isSafeInteger(operatorItem.leaseAttempt)
      ? operatorItem.leaseAttempt
      : 1;
    try {
      await assertConversationChannelDeliveryAvailable({
        conversationId: operatorItem.conversationId,
        channel: operatorItem.channel,
        senderMode: "operator",
      });
      let externalMessageId: string | undefined;
      if (operatorItem.channel === "matrix") {
        if (!operatorItem.matrixSenderUserId) {
          throw new Error(
            "Matrix representative transport user is missing for Operator delivery.",
          );
        }
        if (!operatorItem.matrixEndpointLifecycleRevision) {
          throw new Error(
            "Matrix operator delivery is missing its channel lifecycle fence.",
          );
        }
        externalMessageId = await sendMatrixRepresentativeMessage({
          config,
          conversationId: operatorItem.conversationId,
          roomId: operatorItem.externalConversationId,
          senderUserId: operatorItem.matrixSenderUserId,
          expectedEndpointLifecycleRevision:
            operatorItem.matrixEndpointLifecycleRevision,
          deliveryId: `operator-${operatorItem.messageId}`,
          senderMode: "human_operator",
          text: `${operatorItem.operatorName.trim().slice(0, 80) || "Operator"}: ${operatorItem.text}`,
        });
      } else {
        externalMessageId = await sendTelegramOperatorMessage({
          config,
          conversationId: operatorItem.conversationId,
          chatId: operatorItem.externalConversationId,
          ...(operatorItem.telegramConnectionId
            ? { connectionId: operatorItem.telegramConnectionId }
            : {}),
          operatorName: operatorItem.operatorName,
          text: operatorItem.text,
        });
      }
      if (externalMessageId) {
        await recordOperatorMessageProviderAcceptance({
          outboxId: operatorItem.outboxId,
          leaseAttempt: operatorLeaseAttempt,
          messageId: operatorItem.messageId,
          externalMessageId,
        });
      }
      const completed = await completeOperatorMessageDelivery({
        outboxId: operatorItem.outboxId,
        leaseAttempt: operatorLeaseAttempt,
        messageId: operatorItem.messageId,
        ...(externalMessageId ? { externalMessageId } : {}),
      });
      if (!completed) {
        return {
          processed: true as const,
          runId: operatorItem.messageId,
          status: externalMessageId
            ? "accepted_pending_reconciliation" as const
            : "lease_lost" as const,
        };
      }
      return { processed: true as const, runId: operatorItem.messageId, status: "completed" as const };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Operator message delivery failed.";
      if (isRecoverableOperatorPause(error)) {
        await deferOperatorMessageDelivery({
          outboxId: operatorItem.outboxId,
          leaseAttempt: operatorLeaseAttempt,
          messageId: operatorItem.messageId,
          reason: error.code,
        });
        return {
          processed: true as const,
          runId: operatorItem.messageId,
          status: "deferred" as const,
        };
      }
      await retryOperatorMessageDelivery({
        outboxId: operatorItem.outboxId,
        leaseAttempt: operatorLeaseAttempt,
        messageId: operatorItem.messageId,
        errorMessage,
        ...buildProviderOutcomeUnknownRetry(error),
      });
      return { processed: true as const, runId: operatorItem.messageId, status: "failed" as const, error: errorMessage };
    }
  }

  const conversationMessageItem =
    await claimNextConversationMessageDeliveryWorkItem({
      telegramWorkerEnabled,
      ...(config.outboxProcessingLeaseMs
        ? { processingLeaseMs: config.outboxProcessingLeaseMs }
        : {}),
    });
  if (conversationMessageItem) {
    try {
      const systemDelivery =
        conversationMessageItem.deliveryKind === "delegation_task_status"
        || conversationMessageItem.deliveryKind === "system_notification";
      await assertConversationChannelDeliveryAvailable({
        conversationId: conversationMessageItem.conversationId,
        channel: conversationMessageItem.channel,
        senderMode: systemDelivery ? "system" : "ai",
        allowNeedsHumanDelivery: systemDelivery,
      });
      let externalMessageId: string | undefined;
      if (conversationMessageItem.channel === "matrix") {
        if (
          !conversationMessageItem.externalConversationId
          || !conversationMessageItem.matrixSenderUserId
          || !conversationMessageItem.matrixEndpointLifecycleRevision
        ) {
          throw new Error(
            "Matrix conversation-message delivery is missing its room, sender, or lifecycle fence.",
          );
        }
        externalMessageId = await sendMatrixRepresentativeMessage({
          config,
          conversationId: conversationMessageItem.conversationId,
          roomId: conversationMessageItem.externalConversationId,
          senderUserId: conversationMessageItem.matrixSenderUserId,
          expectedEndpointLifecycleRevision:
            conversationMessageItem.matrixEndpointLifecycleRevision,
          deliveryId: `conversation-message-${conversationMessageItem.messageId}`,
          senderMode: "ai",
          text: conversationMessageItem.text,
        });
      } else if (conversationMessageItem.channel === "telegram") {
        if (config.telegramConversationPlatformMode !== "worker") {
          throw new Error(
            "Telegram conversation worker is not the active delivery owner.",
          );
        }
        if (!conversationMessageItem.externalConversationId) {
          throw new Error(
            "Telegram conversation-message delivery is missing its chat binding.",
          );
        }
        externalMessageId = await sendTelegramMessage({
          config,
          conversationId: conversationMessageItem.conversationId,
          chatId: conversationMessageItem.externalConversationId,
          ...(conversationMessageItem.telegramConnectionId
            ? { connectionId: conversationMessageItem.telegramConnectionId }
            : {}),
          text: conversationMessageItem.text,
        });
      }
      if (externalMessageId) {
        await recordConversationMessageProviderAcceptance({
          outboxId: conversationMessageItem.outboxId,
          leaseAttempt: conversationMessageItem.leaseAttempt,
          messageId: conversationMessageItem.messageId,
          externalMessageId,
        });
      }
      const completed = await completeConversationMessageDelivery({
        outboxId: conversationMessageItem.outboxId,
        leaseAttempt: conversationMessageItem.leaseAttempt,
        messageId: conversationMessageItem.messageId,
        ...(externalMessageId ? { externalMessageId } : {}),
      });
      if (!completed) {
        return {
          processed: true as const,
          runId: conversationMessageItem.messageId,
          status: externalMessageId
            ? "accepted_pending_reconciliation" as const
            : "lease_lost" as const,
        };
      }
      return {
        processed: true as const,
        runId: conversationMessageItem.messageId,
        status: "completed" as const,
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : "Conversation message delivery failed.";
      if (isRecoverableOperatorPause(error)) {
        await deferConversationMessageDelivery({
          outboxId: conversationMessageItem.outboxId,
          leaseAttempt: conversationMessageItem.leaseAttempt,
          messageId: conversationMessageItem.messageId,
          reason: error.code,
        });
        return {
          processed: true as const,
          runId: conversationMessageItem.messageId,
          status: "deferred" as const,
        };
      }
      await retryConversationMessageDelivery({
        outboxId: conversationMessageItem.outboxId,
        leaseAttempt: conversationMessageItem.leaseAttempt,
        messageId: conversationMessageItem.messageId,
        errorMessage,
        ...buildProviderOutcomeUnknownRetry(error),
      });
      return {
        processed: true as const,
        runId: conversationMessageItem.messageId,
        status: "failed" as const,
        error: errorMessage,
      };
    }
  }

  const item = await claimNextGenerationWorkItem({
    telegramWorkerEnabled,
    ...(config.outboxProcessingLeaseMs
      ? { processingLeaseMs: config.outboxProcessingLeaseMs }
      : {}),
  });
  if (!item) return { processed: false as const };

  const leaseGuard = startGenerationLeaseHeartbeat(item);
  const workLease = {
    outboxId: item.outboxId,
    leaseAttempt: item.leaseAttempt,
  };

  if (item.deliveryOnly) {
    try {
      leaseGuard.assertOwned();
      if (!item.outputMessageId || !item.outputText) {
        const errorMessage =
          "Completed generation is missing its persisted delivery output.";
        await retryGenerationDelivery({
          runId: item.runId,
          ...workLease,
          ...(item.outputMessageId
            ? { outputMessageId: item.outputMessageId }
            : {}),
          errorMessage,
        });
        return {
          processed: true as const,
          runId: item.runId,
          status: "failed" as const,
          error: errorMessage,
        };
      }
      await deliverGenerationOutput({
        config,
        item,
        text: item.outputText,
        outputMessageId: item.outputMessageId,
        ...(item.deliveryPlanActionId
          ? { planActionId: item.deliveryPlanActionId }
          : {}),
      });
      try {
        await completeReadyConversationTurnPlanForGenerationRun(item.runId);
      } catch (error) {
        // Provider acceptance is already durable at this point. A plan-repair
        // failure must never send the same external message again.
        console.error("Delivered generation plan repair failed.", error);
      }
      leaseGuard.assertOwned();
      return {
        processed: true as const,
        runId: item.runId,
        status: "completed" as const,
      };
    } catch (error) {
      if (
        isGenerationMemoryDeliveryBlockedError(error)
        || isGenerationPlanDeliverySupersededError(error)
      ) {
        return {
          processed: true as const,
          runId: item.runId,
          status: "canceled" as const,
        };
      }
      if (isProviderAcceptancePendingCommit(error)) {
        return {
          processed: true as const,
          runId: item.runId,
          status: "accepted_pending_reconciliation" as const,
        };
      }
      if (
        leaseGuard.isLost()
        || isGenerationWorkLeaseLostError(error)
        || isConversationHumanControlError(error)
      ) {
        return {
          processed: true as const,
          runId: item.runId,
          status: "lease_lost" as const,
        };
      }
      const errorMessage =
        error instanceof Error ? error.message : "Conversation delivery retry failed.";
      try {
        await retryGenerationDelivery({
          runId: item.runId,
          ...workLease,
          ...(item.outputMessageId
            ? { outputMessageId: item.outputMessageId }
            : {}),
          errorMessage,
          ...buildProviderOutcomeUnknownRetry(error),
        });
      } catch (commitError) {
        if (
          leaseGuard.isLost()
          || isGenerationWorkLeaseLostError(commitError)
        ) {
          return {
            processed: true as const,
            runId: item.runId,
            status: "lease_lost" as const,
          };
        }
        throw commitError;
      }
      return {
        processed: true as const,
        runId: item.runId,
        status: "failed" as const,
        error: errorMessage,
      };
    } finally {
      leaseGuard.stop();
    }
  }

  let outputMessageId: string | undefined;
  let entitlementReservation: ConversationEntitlementReservation | null = null;
  try {
    leaseGuard.assertOwned();
    if (item.controlState === "HUMAN_ACTIVE" || item.controlState === "NEEDS_HUMAN") {
      await deferGenerationRunForHuman({
        runId: item.runId,
        ...workLease,
      });
      return { processed: true as const, runId: item.runId, status: "waiting_human" as const };
    }

    const governedComposerResumeTaskId =
      readV3GovernedComposerResumeTaskId(item.contextSnapshot);
    if (governedComposerResumeTaskId) {
      if ((config.turnPlannerV3Mode ?? "disabled") !== "active_governed") {
        throw new Error("V3 governed Composer resume requires active_governed mode.");
      }
      const resumeSetup = await getRepresentativeRuntimeSetupSnapshot(
        item.representativeSlug,
        item.representativeVersionId,
      );
      if (!resumeSetup) {
        throw new Error("V3 governed Composer resume lost its representative style snapshot.");
      }
      const governedComposition = await executeV3GovernedComposer({
        delegationTaskId: governedComposerResumeTaskId,
        leaseGuard,
        taskInput: {
          text: item.userText,
          language: /\p{Script=Han}/u.test(item.userText) ? "zh" : "en",
        },
        generationWorkLease: workLease,
        representativeStyle: buildRepresentativeResponseStyle(resumeSetup),
      });
      if (!governedComposition) {
        throw new Error("V3 governed Composer resume has no terminal source results.");
      }
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText: governedComposition.text,
        senderDisplayName: item.representativeName,
        intent: "turn_plan_v3_governed_composer_resume",
        provider: governedComposition.provider as
          | "agicto"
          | "openai"
          | "bailian"
          | "anthropic",
        model: governedComposition.model,
        countUsage: false,
        completeOutbox: false,
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({
        config,
        item,
        text: completed.message.text ?? governedComposition.text,
        outputMessageId,
        ...(governedComposition.planActionId
          ? { planActionId: governedComposition.planActionId }
          : {}),
      });
      return {
        processed: true as const,
        runId: item.runId,
        status: "completed" as const,
      };
    }

    if (
      (item.channel === "matrix" || item.channel === "telegram")
      && isDeterministicContactMemoryDeleteCommand(item.userText)
    ) {
      const replyText = renderContactMemoryDeleteConfirmation(item.channel);
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
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
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({
        config,
        item,
        text: replyText,
        outputMessageId,
      });
      leaseGuard.assertOwned();
      return {
        processed: true as const,
        runId: item.runId,
        status: "completed" as const,
      };
    }

    const sharingCommand = item.channel === "matrix"
      ? resolveDeterministicContactMemorySharingCommand(item.userText)
      : null;
    if (sharingCommand) {
      let replyText: string;
      if (!item.audienceIdentityId) {
        replyText = renderContactMemorySharingFailure(
          "contact_memory_sharing_identity_ineligible",
        );
      } else if (sharingCommand === "INVALID_CONFIRM") {
        replyText = renderContactMemorySharingFailure(
          "contact_memory_sharing_challenge_invalid",
        );
      } else {
        try {
          if (sharingCommand === "REVOKE") {
            const revoked = await revokeContactMemorySharingConsent({
              representativeSlug: item.representativeSlug,
              audienceIdentityId: item.audienceIdentityId,
              sourceChannel: "MATRIX",
            });
            replyText = revoked.changed
              ? "已立即停止当前数字代表的跨渠道联系人记忆召回；共享记忆的远端投影已进入可重试清理队列。各渠道原始会话和渠道内记忆不受影响。"
              : "当前没有有效的跨渠道联系人记忆授权；系统已再次确认共享召回处于关闭状态。";
          } else {
            if (
              !item.sourceSenderId
              || !item.privateChannelConnectionId
            ) {
              throw new ContactMemorySharingError(
                "contact_memory_sharing_source_unverified",
                "Matrix source coordinates are missing.",
                403,
              );
            }
            const sourceEvidence = {
              sourceChannel: "MATRIX" as const,
              providerSubject: item.sourceSenderId,
              issuer: matrixServerNameFromUserId(item.sourceSenderId),
              connectionId: item.privateChannelConnectionId,
            };
            if (sharingCommand === "DISCLOSE") {
              const challenge = await createContactMemorySharingChallenge({
                representativeSlug: item.representativeSlug,
                audienceIdentityId: item.audienceIdentityId,
                disclosureContractVersion:
                  contactMemorySharingConsentContractVersion,
                sourceEventKey: `matrix:${item.inputMessageId}`,
                ...sourceEvidence,
              });
              replyText = renderContactMemorySharingDisclosure(
                challenge.challengeToken,
              );
            } else {
              const challengeToken = readContactMemorySharingChallengeToken(
                item.userText.trim().replace(/\s+/gu, " ").slice(
                  "!memory_share ".length,
                ),
              );
              if (!challengeToken) {
                throw new ContactMemorySharingError(
                  "contact_memory_sharing_challenge_invalid",
                  "Matrix memory-sharing challenge token is missing.",
                  409,
                );
              }
              const granted = await grantContactMemorySharingConsent({
                representativeSlug: item.representativeSlug,
                audienceIdentityId: item.audienceIdentityId,
                challengeToken,
                sourceEventKey: `matrix:${item.inputMessageId}`,
                ...sourceEvidence,
              });
              replyText = granted.active
                ? "已允许当前数字代表在已验证为同一 Delegate 用户的 Web、Matrix 和 Telegram 私聊之间使用联系人记忆。"
                : renderContactMemorySharingFailure(
                    "contact_memory_sharing_conflict",
                  );
            }
          }
        } catch (error) {
          if (!(error instanceof ContactMemorySharingError)) throw error;
          replyText = renderContactMemorySharingFailure(error.code);
        }
      }
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: `contact_memory_sharing_${sharingCommand.toLowerCase()}`,
        completeOutbox: false,
        countUsage: false,
        runtimeOutcome: {
          mode: "fallback",
          fallbackStrategy: "deterministic_preview",
          modelRuntimeState: "disabled",
          fallbackReason: "policy_fallback",
        },
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({
        config,
        item,
        text: replyText,
        outputMessageId,
      });
      leaseGuard.assertOwned();
      return {
        processed: true as const,
        runId: item.runId,
        status: "completed" as const,
      };
    }

    if (item.delegationTerminalRecovery) {
      const recovery = renderDelegationTerminalRecovery(
        item.delegationTerminalRecovery,
      );
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText: recovery.text,
        senderDisplayName: item.representativeName,
        intent: "delegation_terminal_recovery",
        completeOutbox: false,
        countUsage: false,
        keepConversationQueued: recovery.keepConversationQueued,
        ...(item.delegationTerminalRecovery.attachments.length
          ? { attachments: item.delegationTerminalRecovery.attachments }
          : {}),
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({
        config,
        item,
        text: recovery.text,
        outputMessageId,
      });
      leaseGuard.assertOwned();
      return {
        processed: true as const,
        runId: item.runId,
        status: recovery.keepConversationQueued
          ? "step_completed" as const
          : "completed" as const,
      };
    }

    const setup = await getRepresentativeRuntimeSetupSnapshot(
      item.representativeSlug,
      item.representativeVersionId,
    );
    leaseGuard.assertOwned();
    if (!setup) throw new Error(`Representative ${item.representativeSlug} was not found.`);
    if (isConversationStatusCommand(item.userText)) {
      const operationalContext = await loadConversationOperationalContext({
        representativeId: setup.id,
        conversationId: item.conversationId,
        ...(item.audienceIdentityId
          ? { audienceIdentityId: item.audienceIdentityId }
          : {}),
      });
      const replyText = renderConversationOperationalStatus(operationalContext);
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: "conversation_status",
        countUsage: false,
        completeOutbox: false,
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({ config, item, text: replyText, outputMessageId });
      leaseGuard.assertOwned();
      return { processed: true as const, runId: item.runId, status: "completed" as const };
    }
    const delegationConfig = resolveDelegationConfig(setup);
    const representative = buildRepresentativeRuntimeProfile(setup);
    // Commerce policy is pinned on GenerationRun at ingress. Do not recompute
    // it from the mutable representative setup after the worker lease begins.
    const unlimitedFreeAccess = item.accessMode === "FREE";
    const pinnedTrialLimit =
      typeof item.effectiveFreeReplyLimit === "number"
      && Number.isSafeInteger(item.effectiveFreeReplyLimit)
      && item.effectiveFreeReplyLimit >= 0
        ? item.effectiveFreeReplyLimit
        : null;
    const effectiveFreeReplyLimit = item.accessMode === "CREDITS_ONLY"
      ? 0
      : item.accessMode === "TRIAL_THEN_CREDITS"
        && pinnedTrialLimit !== null
        ? pinnedTrialLimit
        : representative.contract.freeReplyLimit;
    const policyPinnedRepresentative = item.accessMode === "FREE"
      ? representative
      : {
          ...representative,
          contract: {
            ...representative.contract,
            freeReplyLimit: effectiveFreeReplyLimit,
          },
        };
    const matchedExecutableSkill = hasMatchedExecutableSkill(
      item.userText,
      policyPinnedRepresentative,
    );
    const requiresPaidContinuation = (freeRepliesUsed: number) =>
      !unlimitedFreeAccess
      && freeRepliesUsed >= effectiveFreeReplyLimit;
    let walletReservation = item.walletReservation ?? null;
    const reservePaidContinuation = async () => {
      if (
        !item.audienceIdentityId
        || walletReservation
        || entitlementReservation
      ) {
        return { walletReservation, entitlementReservation };
      }

      // Resolve the canonical audience wallet under the generation lease when
      // ingress did not already pin one. Legacy fixed-tier entitlements are
      // intentionally not consulted on any channel.
      const nextWalletReservation =
        await reserveGenerationConversationWalletUsage({
          runId: item.runId,
          ...workLease,
          audienceIdentityId: item.audienceIdentityId,
          representativeId: setup.id,
          tokenAmount: 1,
        });
      return {
        walletReservation: nextWalletReservation,
        entitlementReservation,
      };
    };

    const persistedRequest = readPersistedDelegationStepRequest(
      item.contextSnapshot && typeof item.contextSnapshot === "object"
        ? (item.contextSnapshot as Record<string, unknown>).request
        : null,
    );
    const plannerRunPolicy = resolveTurnPlannerRunPolicy({
      turnPlannerV2Mode: config.turnPlannerV2Mode,
      turnPlannerV3Mode: config.turnPlannerV3Mode,
      hasPersistedDelegationRequest: Boolean(persistedRequest),
    });
    const activeCollector = readStructuredCollectorState(item.collectorState);
    if (isConversationCancellationRequest(item.userText) && !activeCollector) {
      const cancelPlan = createConversationPlan({
        text: item.userText,
        channel: "private_chat",
        representative: policyPinnedRepresentative,
        usage: item.usage,
      });
      const candidate = await findConversationCancelableDelegationTask({
        representativeId: setup.id,
        conversationId: item.conversationId,
        contactId: item.contactId,
        ...(item.audienceIdentityId
          ? { audienceIdentityId: item.audienceIdentityId }
          : {}),
      });
      let replyText: string;
      let executionStatus: ConversationActionExecutionResult["status"];
      let executionSummary: string;
      if (candidate.status === "cancelable") {
        if (candidate.pendingApprovalId) {
          await resolveRepresentativeComputeApproval({
            representativeSlug: item.representativeSlug,
            approvalId: candidate.pendingApprovalId,
            resolution: "rejected",
            resolvedBy: item.audienceIdentityId || item.contactId,
            decisionNote: "The audience canceled the pending action from its originating conversation.",
          });
        } else {
          await applyRepresentativeDelegationTaskAction({
            representativeSlug: item.representativeSlug,
            taskId: candidate.taskId,
            action: "cancel",
            actorId: item.audienceIdentityId || item.contactId,
            actorType: "audience",
          });
        }
        replyText = "已取消当前待处理任务；尚未消费的服务额度会按原支付边界释放。审批和审计记录会保留。";
        executionStatus = "completed";
        executionSummary = "The audience canceled the scoped pending task.";
      } else if (candidate.status === "already_canceled") {
        replyText = "当前任务已经取消，无需重复操作。";
        executionStatus = "completed";
        executionSummary = "The scoped task was already canceled; the command was idempotent.";
      } else if (candidate.status === "in_flight") {
        replyText = "当前任务已经开始执行，无法安全地声明为已取消。系统不会启动新的步骤；如已产生外部结果，将按审计记录处理。";
        executionStatus = "denied";
        executionSummary = "The task was already running and could not be safely canceled.";
      } else {
        replyText = "当前会话没有可取消的待处理任务。";
        executionStatus = "completed";
        executionSummary = "No scoped pending task was found.";
      }
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: "delegation_cancel",
        turnTrace: buildConversationTurnTrace(cancelPlan, (action) => ({
          actionId: action.id,
          status: executionStatus,
          summary: executionSummary,
          ...(candidate.status === "none"
            ? {}
            : { output: { taskId: candidate.taskId } }),
        })),
        countUsage: false,
        completeOutbox: false,
        ...(entitlementReservation ? { entitlementReservation } : {}),
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({ config, item, text: replyText, outputMessageId });
      leaseGuard.assertOwned();
      return { processed: true as const, runId: item.runId, status: "completed" as const };
    }
    const clarifyingTask = !persistedRequest && !activeCollector
      ? await findConversationClarifyingDelegationTask({
          representativeId: setup.id,
          contactId: item.contactId,
          conversationId: item.conversationId,
        })
      : null;
    const computeDirective = !persistedRequest && !clarifyingTask && !activeCollector
      ? parseComputeDirective(item.userText)
      : { kind: "none" as const };
    if (
      computeDirective.kind !== "none" &&
      (!delegationConfig.enabled || !delegationConfig.explicitComputeEnabled)
    ) {
      const replyText = !delegationConfig.enabled
        ? "这个代表当前不接受委托任务。你仍然可以继续普通问答。"
        : "这个代表未开放高级 /compute 命令。请直接用自然语言描述目标；系统会在需要执行能力时自动创建任务。";
      return completeTerminalDelegationFailure(config, item, replyText);
    }
    if (computeDirective.kind === "help" || computeDirective.kind === "invalid") {
      const replyText = computeDirective.kind === "invalid"
        ? `${computeDirective.message}\n\n可用示例：\n${computeDirective.examples}`
        : [
            setup.compute.enabled
              ? "这个代表已启用隔离计算。你也可以直接用自然语言描述需要生成文件、运行命令或浏览网页的任务。"
              : "这个代表当前没有启用隔离计算。",
            `高级命令示例：\n${computeDirective.examples}`,
          ].join("\n\n");
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: "compute_help",
        countUsage: false,
        completeOutbox: false,
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({ config, item, text: replyText, outputMessageId });
      return { processed: true as const, runId: item.runId, status: "completed" as const };
    }

    let turnPlanV2Result: Awaited<ReturnType<typeof runTurnPlannerV2Shadow>> = null;
    let turnPlanV3Result: Awaited<ReturnType<typeof runTurnPlannerV3>> = null;
    let succeededV3InlineActionKeys = new Set<string>();
    let planningContext: Awaited<ReturnType<typeof buildTurnPlanningContext>> | null = null;
    if (
      isV2ActiveLowRisk(config)
      && !activeCollector
    ) {
      try {
        await leaseGuard.confirmOwned();
        planningContext = await buildTurnPlanningContext({
          item,
          setup,
          activeCollector,
        });
        turnPlanV2Result = await runTurnPlannerV2Shadow({
          config,
          item,
          setup,
          activeCollector,
          planningContext,
        });
        if (turnPlanV2Result?.active && turnPlanV2Result.result.ok) {
          await updateGenerationTurnExecutionProgress({
            runId: item.runId,
            ...workLease,
            stage: "planning",
          });
        }
        await leaseGuard.confirmOwned();
      } catch (error) {
        console.error("TurnPlan V2 active low-risk planning failed.", error);
        throw error;
      }
    }

    let parsedRequests: ParsedComputeRequest[] = persistedRequest
      ? [persistedRequest]
      : computeDirective.kind === "request" ? [computeDirective.request] : [];
    let mcpNoCharge = item.usageExemptReason === "mcp";
    let planSummary = parsedRequests[0]?.displayTarget || "";
    let planSteps: Array<{
      summary: string;
      request: ParsedComputeRequest;
      dependsOnStepIndexes?: number[];
      planActionId?: string;
      actionKey?: string;
      executionRequest?: CapabilityExecutionRequest;
    }> | undefined;
    let governedV3Actions: GovernedV3Action[] | undefined;
    let authorizedKnowledge: AuthorizedDelegationKnowledge[] = [];
    let delegationOverride: { task: { id: string }; step: { id: string } } | undefined =
      item.delegationTaskId && item.delegationTaskStepId
        ? { task: { id: item.delegationTaskId }, step: { id: item.delegationTaskStepId } }
        : undefined;
    const v2DetailedPlannerConstraint =
      isV2ActiveLowRisk(config)
        ? resolveV2DetailedPlannerConstraint(turnPlanV2Result)
        : null;
    if (
      v2DetailedPlannerConstraint
      && (
        !setup.compute.enabled
        || !delegationConfig.enabled
        || !delegationConfig.naturalLanguageEnabled
      )
    ) {
      return completeTerminalDelegationFailure(
        config,
        item,
        "严格委托计划请求了当前未开放的执行能力，系统已停止本次任务。",
      );
    }
    if (
      !parsedRequests.length &&
      plannerRunPolicy.allowLegacyDetailedPlanner &&
      !isActiveManagedDocumentPlan(turnPlanV2Result, config) &&
      !(
        turnPlanV2Result?.result.ok
        && hasManagedDocumentAction(turnPlanV2Result.result.plan)
      ) &&
      setup.compute.enabled &&
      delegationConfig.enabled &&
      (
        Boolean(clarifyingTask) ||
        (
          delegationConfig.naturalLanguageEnabled &&
          (
            Boolean(v2DetailedPlannerConstraint)
            ||
            matchedExecutableSkill
            || shouldConsiderNaturalLanguageCompute(item.userText)
          )
        )
      )
    ) {
      const taskInput = clarifyingTask
        ? `原始任务：${clarifyingTask.objective}\n待补充：${clarifyingTask.blockingReason || "执行输入"}\n用户补充：${item.userText}`
        : item.userText;
      const plannerContext = await buildDelegationPlannerInput({
        setup,
        item,
        taskInput,
      });
      authorizedKnowledge = plannerContext.authorizedKnowledge;
      const planned = await planNaturalLanguageComputeRequest({
        userText: plannerContext.text,
        maxSteps: delegationConfig.maxSteps,
      });
      leaseGuard.assertOwned();
      if (planned.ok && planned.plan) {
        if (planned.plan.kind === "clarification") {
          const clarificationPlan = createConversationPlan({
            text: item.userText,
            channel: "private_chat",
            representative: policyPinnedRepresentative,
            usage: { ...item.usage, passUnlocked: true },
            proposedAction: {
              target: "compute:clarification",
              input: {
                source: "current_user_message",
                question: planned.plan.question,
                missingFields: planned.plan.missingFields,
              },
              requiredCapabilities: ["compute.plan"],
            },
          });
          clarificationPlan.billingDecision = {
            decision: "no_charge",
            billable: false,
            reason: "A planner clarification does not execute or complete a service step.",
          };
          if (clarifyingTask) {
            await continueClarifyingDelegationTask({
              taskId: clarifyingTask.id,
              generationRunId: item.runId,
              inputMessageId: item.inputMessageId,
              contactId: item.contactId,
              question: planned.plan.question,
              missingFields: planned.plan.missingFields,
              authorizedKnowledge,
            });
          } else {
            await createClarifyingDelegationTask({
              representativeId: setup.id,
              representativeSlug: item.representativeSlug,
              representativeVersionId: item.representativeVersionId,
              contactId: item.contactId,
              conversationId: item.conversationId,
              ...(item.episodeId ? { episodeId: item.episodeId } : {}),
              generationRunId: item.runId,
              inputMessageId: item.inputMessageId,
              objective: item.userText,
              summary: planned.plan.summary,
              question: planned.plan.question,
              missingFields: planned.plan.missingFields,
              authorizedKnowledge,
              maxDurationMinutes: setup.compute.maxSessionMinutes,
              networkMode: setup.compute.networkMode.toUpperCase() as "NO_NETWORK" | "ALLOWLIST" | "FULL",
              filesystemMode: setup.compute.filesystemMode.toUpperCase() as "WORKSPACE_ONLY" | "READ_ONLY_WORKSPACE" | "EPHEMERAL_FULL",
            });
          }
          const completed = await completeInlineGenerationRun({
            conversationId: item.conversationId,
            runId: item.runId,
            ...workLease,
            replyText: planned.plan.question,
            senderDisplayName: item.representativeName,
            intent: "delegation_clarification",
            turnTrace: buildConversationTurnTrace(
              clarificationPlan,
              (action) => ({
                actionId: action.id,
                status: "waiting_input",
                summary: "The governed Compute request is waiting for required input.",
              }),
              () => ({
                decision: "allow",
                reason: "Clarifying the requested tool input has no external side effect.",
              }),
            ),
            countUsage: false,
            completeOutbox: false,
            ...(entitlementReservation ? { entitlementReservation } : {}),
          });
          outputMessageId = completed.message.id;
          await deliverGenerationOutput({
            config,
            item,
            text: planned.plan.question,
            outputMessageId,
          });
          return { processed: true as const, runId: item.runId, status: "waiting_input" as const };
        }
        const detailedRequests = buildComputeRequestsFromDelegationPlan(planned.plan);
        if (
          v2DetailedPlannerConstraint
          && !detailedPlannerMatchesV2Constraint(
            v2DetailedPlannerConstraint,
            detailedRequests,
          )
        ) {
          return completeTerminalDelegationFailure(
            config,
            item,
            "严格委托计划与详细执行计划的能力不一致，系统已停止本次任务，未创建任务或审批。",
            entitlementReservation ?? undefined,
          );
        }
        parsedRequests = detailedRequests;
        planSummary = planned.plan.summary;
        planSteps = planned.plan.steps.map((step, index) => ({
          summary: step.summary,
          request: parsedRequests[index]!,
        }));
        if (parsedRequests.length !== planned.plan.steps.length) {
          throw new Error("Delegation planner produced an incomplete execution step.");
        }
        if (clarifyingTask) {
          const resumed = await continueClarifyingDelegationTask({
            taskId: clarifyingTask.id,
            generationRunId: item.runId,
            inputMessageId: item.inputMessageId,
            contactId: item.contactId,
            planSummary,
            planSteps,
            authorizedKnowledge,
          });
          if (!resumed.ready) throw new Error("Clarifying delegation task did not become ready.");
          delegationOverride = { task: { id: resumed.taskId }, step: { id: resumed.step.id } };
        }
      } else if (v2DetailedPlannerConstraint) {
        return completeTerminalDelegationFailure(
          config,
          item,
          "详细执行计划未能验证严格委托目标，系统已停止本次任务，未创建任务或审批。",
          entitlementReservation ?? undefined,
        );
      }
    }
    if (
      !parsedRequests.length &&
      item.delegationTaskId &&
      item.delegationTaskStepId &&
      !clarifyingTask
    ) {
      return completeTerminalDelegationFailure(
        config,
        item,
        "此前的委托任务未能继续执行，系统已停止本次任务，并且不会把它改成普通问答。请重新描述目标；文件位置将由系统自动管理。",
      );
    }

    let paidContinuationRequired = requiresPaidContinuation(
      item.usage.freeRepliesUsed,
    );
    if (
      !unlimitedFreeAccess
      && !walletReservation
      && !paidContinuationRequired
    ) {
      const freeAuthorized = await authorizeGenerationRunFreeUsage({
        runId: item.runId,
        ...workLease,
        freeReplyLimit: effectiveFreeReplyLimit,
      });
      paidContinuationRequired = !freeAuthorized;
    }
    if (
      item.audienceIdentityId
      && paidContinuationRequired
      && !walletReservation
      && !entitlementReservation
    ) {
      ({ walletReservation, entitlementReservation } =
        await reservePaidContinuation());
    }
    let effectiveUsage = entitlementReservation
      ? {
          ...item.usage,
          passUnlocked: true,
          deepHelpUnlocked: item.usage.deepHelpUnlocked,
        }
      : walletReservation
        ? {
            ...item.usage,
            passUnlocked: true,
          }
        : unlimitedFreeAccess
          ? {
              ...item.usage,
              // The legacy planner understands unlimited access through an
              // unlocked continuation flag; no service credit is consumed.
              passUnlocked: true,
            }
          : paidContinuationRequired && !walletReservation
            ? {
                ...item.usage,
                freeRepliesUsed: Math.max(
                  item.usage.freeRepliesUsed,
                  effectiveFreeReplyLimit,
                ),
                passUnlocked: false,
                deepHelpUnlocked: false,
              }
            : item.usage;
    let continuationAuthorized =
      !paidContinuationRequired
      || Boolean(walletReservation || entitlementReservation);

    const directHandoffPlan = createConversationPlan({
      text: item.userText,
      channel: "private_chat",
      representative: policyPinnedRepresentative,
      usage: effectiveUsage,
    });
    if (directHandoffPlan.disposition === "handoff") {
      const replyText = [
        "已提交人工接管请求，正在等待负责人处理。",
        "你可以继续补充背景；是否接手和后续安排以真人确认为准。",
      ].join("\n\n");
      const turnTrace = buildConversationTurnTrace(
        directHandoffPlan,
        (action) => {
          const authorization = authorizeConversationAction(action);
          if (authorization.decision === "deny") {
            return {
              actionId: action.id,
              status: "denied",
              summary: authorization.reason,
            };
          }
          if (authorization.decision === "ask") {
            return {
              actionId: action.id,
              status: "waiting_approval",
              summary: authorization.reason,
            };
          }
          if (action.kind === "collect_request_description") {
            return {
              actionId: action.id,
              status: "completed",
              summary: "The current user message is the minimum handoff description.",
              output: { description: item.userText.slice(0, 600) },
            };
          }
          if (action.kind === "request_human_handoff") {
            return {
              actionId: action.id,
              status: "deferred",
              summary:
                "Human-handoff eligibility and request creation are finalized atomically with the reply.",
            };
          }
          return {
            actionId: action.id,
            status: "deferred",
            summary: "The action is not part of the deterministic handoff path.",
          };
        },
      );
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: "handoff",
        turnTrace,
        completeOutbox: false,
        countUsage: false,
        humanHandoff: {
          reason: "The audience explicitly requested human takeover.",
          summary: item.userText.slice(0, 600),
          kind: directHandoffPlan.intent,
          priority: 80,
          source: item.channel,
        },
        runtimeOutcome: {
          mode: "fallback",
          fallbackStrategy: "deterministic_preview",
          modelRuntimeState: "disabled",
          fallbackReason: "policy_fallback",
        },
        ...(entitlementReservation ? { entitlementReservation } : {}),
      });
      outputMessageId = completed.message.id;
      const deliveredText = completed.message.text ?? replyText;
      await deliverGenerationOutput({
        config,
        item,
        text: deliveredText,
        outputMessageId,
      });
      leaseGuard.assertOwned();
      return {
        processed: true as const,
        runId: item.runId,
        status: "waiting_human" as const,
      };
    }

    if (activeCollector) {
      const canceled = isCollectorCancelMessage(item.userText);
      let replyText: string;
      let completedCollector = false;
      let completedState = activeCollector;
      let completedServiceRequestId: string | null = null;

      if (!continuationAuthorized) {
        replyText = "当前可用服务额度不足。补充额度后可以从当前采集步骤继续，不需要重新开始。";
      } else if (canceled) {
        await clearConversationCollectorState({ conversationId: item.conversationId });
        replyText = "已取消本次需求采集，没有创建服务请求。";
      } else {
        const advanced = advanceStructuredCollector(activeCollector, item.userText);
        completedState = advanced.state ?? activeCollector;
        completedCollector = advanced.completed;
        if (advanced.completed) {
          const summary = formatStructuredCollectorSummary(completedState);
          const completedIntake = await completeConversationIntake({
            representativeId: setup.id,
            representativeVersionId: item.representativeVersionId,
            contactId: item.contactId,
            conversationId: item.conversationId,
            ...(item.episodeId ? { episodeId: item.episodeId } : {}),
            inputMessageId: item.inputMessageId,
            intent: completedState.intent,
            collectorKind: completedState.kind,
            sourceChannel: item.channel,
            summary,
            objective: summary,
            desiredOutcome: "Owner review and a clear next-step response.",
            priority: 60,
            recommendedNextStep: "owner_service_request_review",
            payload: {
              collectorKind: completedState.kind,
              sourceChannel: completedState.sourceChannel,
              suggestedPlan: completedState.suggestedPlan ?? null,
              startedAt: completedState.startedAt,
              completedAt: new Date().toISOString(),
              answers: completedState.answers,
              summary,
            },
          });
          completedServiceRequestId = completedIntake.serviceRequestId;
          replyText = completedIntake.serviceRequestId
            ? `需求已整理并创建服务请求。\n\n${summary}\n\n如需补充联系人、预算或时间等信息，真人接手后会继续询问。后续工具调用和外部操作仍会分别检查权限。`
            : `需求已整理。\n\n${summary}\n\n当前会话已进入人工处理状态，因此没有重复创建服务请求。`;
        } else {
          await setConversationCollectorState({
            conversationId: item.conversationId,
            collectorState: completedState,
          });
          replyText = formatStructuredCollectorPrompt(completedState);
        }
      }

      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: completedCollector ? "intake_completed" : canceled ? "intake_canceled" : "intake_collecting",
        turnTrace: buildCollectorTurnTrace({
          state: completedState,
          continuationAuthorized,
          canceled,
          completed: completedCollector,
          serviceRequestId: completedServiceRequestId,
        }),
        completeOutbox: false,
        countUsage: continuationAuthorized && !canceled,
        ...(entitlementReservation ? { entitlementReservation } : {}),
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({ config, item, text: replyText, outputMessageId });
      leaseGuard.assertOwned();
      return {
        processed: true as const,
        runId: item.runId,
        status: completedCollector || canceled
          ? "completed" as const
          : "waiting_input" as const,
      };
    }

    if (
      !turnPlanV2Result
      && plannerRunPolicy.runV2Planner
    ) {
      try {
        await leaseGuard.confirmOwned();
        planningContext ??= await buildTurnPlanningContext({
          item,
          setup,
          activeCollector,
        });
        turnPlanV2Result = await runTurnPlannerV2Shadow({
          config,
          item,
          setup,
          activeCollector,
          planningContext,
        });
        await leaseGuard.confirmOwned();
      } catch (error) {
        if (leaseGuard.isLost() || isGenerationWorkLeaseLostError(error)) {
          throw error;
        }
        // Shadow planning is an observability and migration surface. Provider
        // or persistence failures may not take down the established lane.
        console.error("TurnPlan V2 shadow planning failed.", error);
      }
    }

    if (
      plannerRunPolicy.runV3Planner
    ) {
      try {
        await leaseGuard.confirmOwned();
        planningContext ??= await buildTurnPlanningContext({
          item,
          setup,
          activeCollector,
        });
        turnPlanV3Result = await runTurnPlannerV3({
          config,
          item,
          setup,
          planningContext,
          ...(turnPlanV2Result ? { plannedV2: turnPlanV2Result } : {}),
        });
        await leaseGuard.confirmOwned();
      } catch (error) {
        if (leaseGuard.isLost() || isGenerationWorkLeaseLostError(error)) {
          throw error;
        }
        console.error("TurnPlan V3 planning or persistence failed.", error);
        const v3Mode = config.turnPlannerV3Mode ?? "disabled";
        if (v3Mode === "active_readonly" || v3Mode === "active_governed") {
          return completeTerminalDelegationFailure(
            config,
            item,
            "本轮计划未能通过严格验证，系统没有执行工具，也没有降级为未经验证的模型回答。请稍后重试。",
            entitlementReservation ?? undefined,
          );
        }
      }
    }

    if (
      turnPlanV3Result
      && (config.turnPlannerV3Mode ?? "disabled") === "active_governed"
      && turnPlanV3Result.result.ok
    ) {
      try {
        const inlineSources = await executeV3GovernedInlineSourceActions({
          item,
          setup,
          planned: turnPlanV3Result,
          leaseGuard,
        });
        succeededV3InlineActionKeys = inlineSources.succeededActionKeys;
      } catch (error) {
        if (leaseGuard.isLost() || isGenerationWorkLeaseLostError(error)) throw error;
        console.error("TurnPlan V3 governed inline source execution failed.", error);
        const closed = await failActiveV3InlinePlanExecution({
          planId: turnPlanV3Result.result.plan.planId,
          generationWorkLease: workLease,
          reasonCode: error instanceof Error
            ? error.message
            : "v3_governed_inline_source_failed",
        });
        if (!closed) {
          await failConversationTurnPlan({
            planId: turnPlanV3Result.result.plan.planId,
            reason: error instanceof Error
              ? error.message
              : "v3_governed_inline_source_failed",
          });
        }
        return completeTerminalDelegationFailure(
          config,
          item,
          "严格 V3 计划的授权知识或内置来源未能完成，因此依赖它的外部工具没有启动。请稍后重试。",
          entitlementReservation ?? undefined,
        );
      }
    }

    if (
      turnPlanV3Result
      && (
        (config.turnPlannerV3Mode ?? "disabled") === "active_readonly"
        || (config.turnPlannerV3Mode ?? "disabled") === "active_governed"
      )
    ) {
      try {
        const executed = await executeV3ReadonlyPlan({
          config,
          item,
          setup,
          planned: turnPlanV3Result,
          leaseGuard,
          continuationAuthorized,
          entitlementReservation,
        });
        if (executed) return executed;
        if ((config.turnPlannerV3Mode ?? "disabled") === "active_readonly") {
          return completeTerminalDelegationFailure(
            config,
            item,
            "严格 V3 只读计划包含尚未激活的能力，系统未执行，也未回落到旧回答路径。",
            entitlementReservation ?? undefined,
          );
        }
      } catch (error) {
        if (leaseGuard.isLost() || isGenerationWorkLeaseLostError(error)) throw error;
        console.error("TurnPlan V3 read-only execution failed.", error);
        if (turnPlanV3Result.result.ok) {
          const closed = await failActiveV3InlinePlanExecution({
            planId: turnPlanV3Result.result.plan.planId,
            generationWorkLease: workLease,
            reasonCode: error instanceof Error
              ? error.message
              : "v3_readonly_execution_failed",
          });
          if (!closed) {
            await failConversationTurnPlan({
              planId: turnPlanV3Result.result.plan.planId,
              reason: error instanceof Error
                ? error.message
                : "v3_readonly_execution_failed",
            });
          }
        }
        return completeTerminalDelegationFailure(
          config,
          item,
          "严格只读计划未能完成，系统没有降级为未经证据支持的回答。请稍后重试。",
          entitlementReservation ?? undefined,
        );
      }
    }

    if (
      turnPlanV3Result
      && (config.turnPlannerV3Mode ?? "disabled") === "active_governed"
      && turnPlanV3Result.result.ok
      && turnPlanV3Result.result.plan.actions.some((action) =>
        action.capability.key === "artifact.generate_document")
    ) {
      if ((turnPlanV2Result?.envelope.attachments.length ?? 0) > 0) {
        return completeTerminalDelegationFailure(
          config,
          item,
          "附件已经安全保存，但 V3 文档执行器尚未获得附件内容提取与授权证据，因此没有忽略附件生成无关文件。",
          entitlementReservation ?? undefined,
        );
      }
      try {
        const executed = await executeV3ManagedDocumentPlan({
          config,
          item,
          setup,
          planned: turnPlanV3Result,
          leaseGuard,
          continuationAuthorized,
          entitlementReservation,
        });
        if (executed) return executed;
      } catch (error) {
        if (leaseGuard.isLost() || isGenerationWorkLeaseLostError(error)) throw error;
        console.error("TurnPlan V3 managed document execution failed.", error);
        const reason = error instanceof Error
          ? error.message
          : "v3_managed_document_execution_failed";
        const closed = await failActiveV3InlinePlanExecution({
          planId: turnPlanV3Result.result.plan.planId,
          generationWorkLease: workLease,
          reasonCode: reason,
        });
        if (!closed) {
          await failConversationTurnPlan({
            planId: turnPlanV3Result.result.plan.planId,
            reason,
          });
        }
        return completeTerminalDelegationFailure(
          config,
          item,
          "严格 V3 文档计划未能完成；系统没有回落到旧文档写路径。请稍后重试。",
          entitlementReservation ?? undefined,
        );
      }
    }

    if (turnPlanV3Result && (config.turnPlannerV3Mode ?? "disabled") === "active_governed") {
      if (!turnPlanV3Result.result.ok) {
        return completeTerminalDelegationFailure(
          config,
          item,
          renderTurnPlanV3PlanningFailureMessage(turnPlanV3Result.result),
          entitlementReservation ?? undefined,
        );
      }
      const governedActions = compileGovernedActionsFromV3(
        turnPlanV3Result,
        succeededV3InlineActionKeys,
      );
      if (!governedActions) {
        const stableFallback = await executeV3PreExecutionStableGeneralFallback({
          config,
          item,
          planned: turnPlanV3Result,
          leaseGuard,
          continuationAuthorized,
          activationStatus: "compiler_unavailable",
          entitlementReservation,
          setup,
        });
        if (stableFallback) return stableFallback;
        return completeTerminalDelegationFailure(
          config,
          item,
          "严格 V3 计划无法编译为当前已发布的受治理能力，系统未执行工具，也未降级为模型猜测。",
          entitlementReservation ?? undefined,
        );
      }
      governedV3Actions = governedActions;
      parsedRequests = governedActions.map((action) => action.request);
      planSummary = turnPlanV3Result.result.ok
        ? turnPlanV3Result.result.plan.objective
        : "";
      const indexByActionKey = new Map(
        governedActions.map((action, index) => [action.actionKey, index] as const),
      );
      planSteps = governedActions.map((action) => ({
        summary: action.actionKey,
        request: action.request,
        planActionId: action.planActionId,
        actionKey: action.actionKey,
        executionRequest: action.executionRequest,
        dependsOnStepIndexes: action.dependsOnActionIds.map((dependencyActionId) => {
          const dependencyIndex = indexByActionKey.get(dependencyActionId);
          if (typeof dependencyIndex !== "number") {
            throw new Error(
              `V3 governed dependency ${dependencyActionId} is not an executable tool action.`,
            );
          }
          return dependencyIndex;
        }),
      }));
    }

    const selectedMcpOnlyPlan = parsedRequests.length > 0
      && parsedRequests.every((request) => request.capability === "mcp")
      && (
        item.usageExemptReason === "mcp"
        || !item.delegationTaskId
      );
    if (selectedMcpOnlyPlan) {
      await authorizeGenerationRunMcpNoCharge({
        runId: item.runId,
        ...workLease,
      });
      mcpNoCharge = true;
      walletReservation = null;
      entitlementReservation = null;
      paidContinuationRequired = false;
      continuationAuthorized = true;
      // The legacy ConversationPlan contract has no no-charge execution bit.
      // Unlock only its response lane; Broker authorization still comes from
      // the server-owned `usageExemptReason=mcp` GenerationRun snapshot.
      effectiveUsage = {
        ...item.usage,
        passUnlocked: true,
      };
    }

    if (
      isV2ActiveLowRisk(config)
      && isManagedDocumentPlanBlockedByUnusableAttachments(turnPlanV2Result)
    ) {
      const replyText =
        "附件已经安全保存，但当前文档生成通道尚未完成附件内容提取与授权校验，因此不会忽略附件生成一份无关文件。请先用文字说明需要基于附件完成的内容，或等待附件解析能力启用。";
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: "turn_plan_v2_document_attachment_context_required",
        runtimeOutcome: {
          mode: "fallback",
          fallbackStrategy: "deterministic_preview",
          modelRuntimeState: "ready",
          fallbackReason: "policy_fallback",
        },
        countUsage: false,
        completeOutbox: false,
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({ config, item, text: replyText, outputMessageId });
      return {
        processed: true as const,
        runId: item.runId,
        status: "waiting_input" as const,
      };
    }

    if (
      isV2ActiveLowRisk(config)
      && turnPlanV2Result?.result.ok
      && isActiveManagedDocumentPlan(turnPlanV2Result, config)
    ) {
      const artifactAction = turnPlanV2Result.result.plan.actions.length === 1
        ? turnPlanV2Result.result.plan.actions[0]
        : undefined;
      const persistedActions = "actions" in turnPlanV2Result.persistedPlan
        ? turnPlanV2Result.persistedPlan.actions
        : [];
      const persistedAction = artifactAction
        ? persistedActions.find(
            (action: { actionKey: string }) => action.actionKey === artifactAction.id,
          )
        : undefined;
      const topic = artifactAction?.arguments["topic"];
      const audience = artifactAction?.arguments["audience"];
      const requestedFormat = artifactAction?.arguments["format"];
      const format = requestedFormat === "markdown" || requestedFormat === "txt"
        ? requestedFormat
        : turnPlanV2Result.envelope.planningDefaults?.managedDocumentFormat;
      if (
        artifactAction?.capability.key === "artifact.generate_document"
        && persistedAction
        && typeof topic === "string"
        && (format === "markdown" || format === "txt")
      ) {
        await updateGenerationTurnExecutionProgress({
          runId: item.runId,
          ...workLease,
          stage: "authorizing",
        });
        if (!continuationAuthorized) {
          await recordConversationPlanActionAuthorization({
            planActionId: persistedAction.id,
            phase: "initial",
            decision: "deny",
            reason: "No free or purchased service entitlement is available for this document run.",
            policySnapshot: {
              protocolVersion: 2,
              capabilityKey: artifactAction.capability.key,
              capabilityDefinitionHash: artifactAction.capability.definitionHash,
              serviceEntitlementAvailable: false,
            },
          });
          await failConversationTurnPlan({
            planId: turnPlanV2Result.result.plan.planId,
            actionId: persistedAction.id,
            reason: "service_entitlement_required",
          });
          const replyText =
            "当前没有可用的免费或已购服务额度，因此没有生成文件。补充服务额度后可以重新发送同一请求。";
          const completed = await completeInlineGenerationRun({
            conversationId: item.conversationId,
            runId: item.runId,
            ...workLease,
            replyText,
            senderDisplayName: item.representativeName,
            intent: "turn_plan_v2_document_payment_required",
            runtimeOutcome: {
              mode: "fallback",
              fallbackStrategy: "deterministic_preview",
              modelRuntimeState: "ready",
              fallbackReason: "policy_fallback",
            },
            countUsage: false,
            completeOutbox: false,
          });
          outputMessageId = completed.message.id;
          await deliverGenerationOutput({
            config,
            item,
            text: replyText,
            outputMessageId,
          });
          return {
            processed: true as const,
            runId: item.runId,
            status: "completed" as const,
          };
        }
        await recordConversationPlanActionAuthorization({
          planActionId: persistedAction.id,
          phase: "initial",
          decision: "allow",
          reason:
            "Platform-managed document generation is an internal write with no external side effect.",
          policySnapshot: {
            protocolVersion: 2,
            capabilityKey: artifactAction.capability.key,
            capabilityDefinitionHash: artifactAction.capability.definitionHash,
            effect: "internal_write",
          },
        });
        await leaseGuard.confirmOwned();
        const preparedArtifact =
          await prepareManagedConversationDocumentArtifact({
            representativeId: setup.id,
            representativeSlug: item.representativeSlug,
            conversationId: item.conversationId,
            generationRunId: item.runId,
            planActionId: persistedAction.id,
            generationWorkLease: workLease,
          });
        await leaseGuard.confirmOwned();
        let generated: Extract<
          Awaited<ReturnType<typeof generateManagedDocument>>,
          { ok: true }
        > | null = null;
        let managedArtifact = preparedArtifact.status === "succeeded"
          ? preparedArtifact.result
          : null;
        if (!managedArtifact) {
          if (preparedArtifact.status !== "claimed") {
            throw new Error("Managed document action was not claimed for execution.");
          }
          const generation = await generateManagedDocument({
            userText: item.userText,
            topic,
            ...(typeof audience === "string" && audience.trim()
              ? { audience }
              : {}),
            format,
            authorizedContext: turnPlanV2Result.envelope.authorizedContext,
            onProgress: async (progress) => {
              await updateGenerationTurnExecutionProgress({
                runId: item.runId,
                ...workLease,
                stage: progress.stage,
                part: progress.part,
                maxParts: progress.maxParts,
              });
            },
          });
          await leaseGuard.confirmOwned();
          if (!generation.ok) {
            await failConversationTurnPlan({
              planId: turnPlanV2Result.result.plan.planId,
              actionId: persistedAction.id,
              reason: generation.reason,
            });
            const replyText =
              "文档生成服务暂时不可用，因此没有创建或发送空文件。请稍后重试。";
            const completed = await completeInlineGenerationRun({
              conversationId: item.conversationId,
              runId: item.runId,
              ...workLease,
              replyText,
              senderDisplayName: item.representativeName,
              intent: "turn_plan_v2_document_failed",
              runtimeOutcome: {
                mode: "fallback",
                fallbackStrategy: "deterministic_preview",
                modelRuntimeState: "ready",
                fallbackReason: "provider_failed",
              },
              countUsage: false,
              completeOutbox: false,
              ...(entitlementReservation ? { entitlementReservation } : {}),
            });
            outputMessageId = completed.message.id;
            await deliverGenerationOutput({
              config,
              item,
              text: replyText,
              outputMessageId,
            });
            return {
              processed: true as const,
              runId: item.runId,
              status: "completed" as const,
            };
          }
          generated = generation;
          await updateGenerationTurnExecutionProgress({
            runId: item.runId,
            ...workLease,
            stage: "saving",
          });
          managedArtifact =
            await createManagedConversationDocumentArtifact({
              representativeId: setup.id,
              representativeSlug: item.representativeSlug,
              contactId: item.contactId,
              conversationId: item.conversationId,
              generationRunId: item.runId,
              planActionId: persistedAction.id,
              claim: preparedArtifact.claim,
              generationWorkLease: workLease,
              title: generated.title,
              format: generated.sourceFormat,
              content: generated.content,
              retentionDays: setup.compute.artifactRetentionDays,
            });
          await leaseGuard.confirmOwned();
        }
        const downloadUrl = resolveManagedArtifactDownloadUrl(
          config,
          managedArtifact.downloadUrl,
          item.channel,
        );
        const replyText = item.channel === "web"
          ? `已生成文档：${managedArtifact.fileName}`
          : `已生成文档：${managedArtifact.fileName}\n\n下载：${downloadUrl}`;
        await updateGenerationTurnExecutionProgress({
          runId: item.runId,
          ...workLease,
          stage: "delivering",
        });
        const completed = await completeInlineGenerationRun({
          conversationId: item.conversationId,
          runId: item.runId,
          ...workLease,
          replyText,
          senderDisplayName: item.representativeName,
          intent: "turn_plan_v2_managed_document",
          ...(generated
            ? { provider: generated.provider, model: generated.model }
            : {}),
          runtimeOutcome: { mode: "model" },
          ...(generated?.usage?.inputTokens !== undefined
            ? { inputTokens: generated.usage.inputTokens }
            : {}),
          ...(generated?.usage?.outputTokens !== undefined
            ? { outputTokens: generated.usage.outputTokens }
            : {}),
          ...(generated?.usage?.costCents !== undefined
            ? { costCents: generated.usage.costCents }
            : {}),
          attachments: [{
            fileName: managedArtifact.fileName,
            mimeType: managedArtifact.mimeType,
            sizeBytes: managedArtifact.sizeBytes,
            artifactId: managedArtifact.artifact.id,
            url: downloadUrl,
          }],
          countUsage: continuationAuthorized,
          completeOutbox: false,
          ...(entitlementReservation ? { entitlementReservation } : {}),
        });
        await completeConversationTurnPlan({
          planId: turnPlanV2Result.result.plan.planId,
          output: {
            artifactId: managedArtifact.artifact.id,
            fileName: managedArtifact.fileName,
            sha256: managedArtifact.sha256,
          },
        });
        outputMessageId = completed.message.id;
        await deliverGenerationOutput({
          config,
          item,
          text: replyText,
          outputMessageId,
        });
        return {
          processed: true as const,
          runId: item.runId,
          status: "completed" as const,
        };
      }
    }

    if (
      isV2ActiveLowRisk(config)
      && turnPlanV2Result?.result.ok
      && hasManagedDocumentAction(turnPlanV2Result.result.plan)
    ) {
      return completeTerminalDelegationFailure(
        config,
        item,
        "严格文档计划未满足托管文档执行边界，系统已停止本次任务，且不会降级为 Compute 写文件或创建审批。请重新描述一个明确的文档交付目标。",
        entitlementReservation ?? undefined,
      );
    }

    const primaryComputeRequest = parsedRequests[0];
    const plan = createConversationPlan({
      text: item.userText,
      channel: "private_chat",
      representative: policyPinnedRepresentative,
      usage: effectiveUsage,
      ...(primaryComputeRequest
        ? {
            proposedAction: {
              target: `compute:${primaryComputeRequest.capability}`,
              input: {
                source: "current_user_message",
                capability: primaryComputeRequest.capability,
                displayTarget: primaryComputeRequest.displayTarget,
              },
              requiredCapabilities: [primaryComputeRequest.capability],
              ...(primaryComputeRequest.estimatedTokens !== undefined
                ? { estimatedTokens: primaryComputeRequest.estimatedTokens }
                : {}),
            },
          }
        : {}),
    });

    if (
      parsedRequests.length
      && paidContinuationRequired
      && !walletReservation
      && !entitlementReservation
    ) {
      return completeTerminalDelegationFailure(
        config,
        item,
        "免费额度已用完，当前没有可预占的服务权益。请先充值或购买服务额度后再执行委托任务。",
      );
    }

    if (parsedRequests.length) {
      let computeReply = await processConversationComputeRequest({
        item,
        setup,
        leaseGuard,
        parsed: parsedRequests[0]!,
        ...(planSteps ? { planSteps } : {}),
        ...(planSummary ? { planSummary } : {}),
        ...(governedV3Actions ? { governedV3Actions } : {}),
        ...(authorizedKnowledge.length ? { authorizedKnowledge } : {}),
        ...(delegationOverride ? { delegation: delegationOverride } : {}),
      });

      if (computeReply.approvalId) {
        const waiting = await waitGenerationRunForComputeApproval({
          conversationId: item.conversationId,
          runId: item.runId,
          ...workLease,
          approvalId: computeReply.approvalId,
          replyText: computeReply.text,
          senderDisplayName: item.representativeName,
          turnTrace: buildConversationTurnTrace(
            {
              ...plan,
              billingDecision: {
                decision: "no_charge",
                billable: false,
                reason: "Waiting for approval does not consume conversation usage.",
              },
            },
            (action) => ({
              actionId: action.id,
              status: "waiting_approval",
              summary: "The tool action is blocked pending Owner approval.",
              output: { approvalId: computeReply.approvalId! },
            }),
            () => ({
              decision: "ask",
              reason: "The Compute policy requires Owner approval before execution.",
            }),
          ),
        });
        outputMessageId = waiting.message.id;
        await deliverGenerationOutput({
          config,
          item,
          text: waiting.message.text ?? computeReply.text,
          outputMessageId,
        });
        return {
          processed: true as const,
          runId: item.runId,
          status: waiting.run.status === "WAITING_APPROVAL"
            ? "waiting_approval" as const
            : "completed" as const,
        };
      }

      const governedComposition =
        (config.turnPlannerV3Mode ?? "disabled") === "active_governed"
        && !computeReply.hasMoreSteps
        && computeReply.delegationTaskId
          ? await executeV3GovernedComposer({
              delegationTaskId: computeReply.delegationTaskId,
              leaseGuard,
              taskInput: {
                text: item.userText,
                language: /\p{Script=Han}/u.test(item.userText) ? "zh" : "en",
              },
              generationWorkLease: workLease,
              representativeStyle: buildRepresentativeResponseStyle(setup),
              ...(computeReply.fallbackActivationStatus
                ? {
                    fallbackActivationStatus:
                      computeReply.fallbackActivationStatus,
                  }
                : {}),
            })
          : null;
      if (governedComposition) {
        computeReply = { ...computeReply, text: governedComposition.text };
      }

      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText: computeReply.text,
        senderDisplayName: item.representativeName,
        intent: governedComposition?.fallbackActivated
          ? "turn_plan_v3_stable_general_fallback"
          : "compute",
        ...(governedComposition?.provider
          ? { provider: governedComposition.provider as "agicto" | "openai" | "bailian" | "anthropic" }
          : {}),
        ...(governedComposition?.model ? { model: governedComposition.model } : {}),
        turnTrace: buildConversationTurnTrace(
          {
            ...plan,
            billingDecision: mcpNoCharge
              ? {
                  decision: "no_charge",
                  billable: false,
                  reason: "MCP-only delegated answers do not consume conversation service usage.",
                }
              : computeReply.billable && !persistedRequest
              ? {
                  decision: "allow_entitlement",
                  billable: true,
                  reason: "A governed Compute service step completed successfully.",
                }
              : {
                  decision: "no_charge",
                  billable: false,
                  reason: "The Compute step did not produce a newly billable completion.",
                },
          },
          (action) => ({
            actionId: action.id,
            status: computeReply.billable ? "completed" : "failed",
            summary: computeReply.billable
              ? "The governed Compute action completed."
              : "The governed Compute action did not complete a billable service step.",
            ...(computeReply.attachments?.length
              ? { output: { attachments: computeReply.attachments } }
              : {}),
          }),
          () => ({
            decision: "allow",
            reason: "The Compute broker authorized the executed capability.",
          }),
        ),
        ...(computeReply.attachments?.length ? { attachments: computeReply.attachments } : {}),
        completeOutbox: false,
        countUsage: mcpNoCharge
          ? false
          : governedComposition?.fallbackActivated
          ? continuationAuthorized
          : computeReply.billable && !persistedRequest,
        keepConversationQueued: computeReply.hasMoreSteps,
        ...(entitlementReservation ? { entitlementReservation } : {}),
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({
        config,
        item,
        text: completed.message.text ?? computeReply.text,
        outputMessageId,
        ...(governedComposition?.planActionId
          ? { planActionId: governedComposition.planActionId }
          : {}),
      });
      return {
        processed: true as const,
        runId: item.runId,
        status: computeReply.hasMoreSteps ? "step_completed" as const : "completed" as const,
      };
    }

    if ((plan.actions ?? []).some((action) => action.kind === "execute_tool")) {
      const replyText = "当前请求匹配到执行能力，但系统无法形成完整且安全的执行计划，因此没有调用工具。请补充希望完成的结果和必要输入后重试。";
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: "compute_planning_failed",
        turnTrace: buildConversationTurnTrace(plan, (action) => ({
          actionId: action.id,
          status: "failed",
          summary: "No complete governed execution plan was produced; no tool was called.",
        })),
        countUsage: false,
        completeOutbox: false,
        ...(entitlementReservation ? { entitlementReservation } : {}),
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({ config, item, text: replyText, outputMessageId });
      leaseGuard.assertOwned();
      return { processed: true as const, runId: item.runId, status: "completed" as const };
    }

    const subagent = resolveConversationSubagent(plan);
    if (plan.disposition === "collect" && shouldStartStructuredCollector(plan)) {
      const publicMaterials = await selectPublicMaterialDeliveries(
        policyPinnedRepresentative,
        plan,
        item.userText,
      );
      const collector = beginStructuredCollector({
        plan,
        channel: "private_chat",
      });
      await setConversationCollectorState({
        conversationId: item.conversationId,
        collectorState: collector,
      });
      const replyText = [
        publicMaterials.length || (plan.actions ?? []).some((action) => action.kind === "deliver_public_material")
          ? renderPublicMaterialDeliveries(publicMaterials)
          : null,
        formatStructuredCollectorPrompt(collector),
        "如需中止，请发送“取消”。",
      ].filter(Boolean).join("\n\n");
      const turnTrace = buildConversationTurnTrace(plan, (action) => {
        if (action.kind === "deliver_public_material") {
          return {
            actionId: action.id,
            status: publicMaterials.length ? "completed" : "deferred",
            summary: publicMaterials.length
              ? "Published public-material links were added to the reply."
              : "No published public-material URL was available.",
            ...(publicMaterials.length
              ? { output: { materials: publicMaterials } }
              : {}),
          };
        }
        return {
          actionId: action.id,
          status: action.kind === "collect_request_description"
            ? "waiting_input"
            : "deferred",
          summary: action.kind === "collect_request_description"
            ? "The conversation is waiting for one request description."
            : "Service-request creation is deferred until intake completes.",
        };
      });
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: plan.intent,
        turnTrace,
        completeOutbox: false,
        countUsage: isConversationPlanBillable(plan) && continuationAuthorized,
        ...(entitlementReservation ? { entitlementReservation } : {}),
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({ config, item, text: replyText, outputMessageId });
      leaseGuard.assertOwned();
      return { processed: true as const, runId: item.runId, status: "waiting_input" as const };
    }
    const operationalContext = plan.disposition === "answer"
      ? await loadConversationOperationalContext({
          representativeId: setup.id,
          conversationId: item.conversationId,
          ...(item.audienceIdentityId
            ? { audienceIdentityId: item.audienceIdentityId }
            : {}),
        })
      : null;
    const recentTurns = await loadGenerationRecentTurns({
      representativeId: setup.id,
      conversationId: item.conversationId,
      beforeMessageId: item.inputMessageId,
    });
    const recentRecall = plan.disposition === "answer"
      ? buildRecentConversationRecallReply({
          requestText: item.userText,
          recentTurns,
        })
      : null;
    if (recentRecall) {
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText: recentRecall.replyText,
        senderDisplayName: item.representativeName,
        intent: "conversation_recent_recall",
        turnTrace: buildConversationTurnTrace(
          {
            ...plan,
            billingDecision: {
              decision: "no_charge",
              billable: false,
              reason: "Reading the current episode's audience-authored history is not a billable service completion.",
            },
          },
          (action) => ({
            actionId: action.id,
            status: "completed",
            summary: recentRecall.found
              ? "The latest audience-authored message in the current episode was returned."
              : "No eligible prior audience-authored message exists in the current episode.",
          }),
          () => ({
            decision: "allow",
            reason: "The read is limited to the current conversation episode and current audience's own messages.",
          }),
        ),
        countUsage: false,
        completeOutbox: false,
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({
        config,
        item,
        text: recentRecall.replyText,
        outputMessageId,
      });
      return {
        processed: true as const,
        runId: item.runId,
        status: "completed" as const,
      };
    }
    const recalled = plan.disposition === "answer"
      ? await recallRepresentativeContext({
          representativeSlug: item.representativeSlug,
          conversationId: item.conversationId,
          contactId: item.contactId,
          sourceChannel: item.channel,
          generationRunId: item.runId,
          queryText: item.userText,
        })
      : { items: [], memoryUseRunId: undefined };
    // A source item without its generation-scoped UseRun cannot be finalized
    // into injection/citation truth. Never let such an orphan reach the model.
    const ledgerBackedRecalledItems = recalled.memoryUseRunId
      ? recalled.items
      : [];

    let replyText =
      plan.disposition === "payment_required"
      && paidContinuationRequired
      && !walletReservation
      && !entitlementReservation
        ? "当前可用服务额度不足，请前往这个数字代表的公开页面充值或购买服务套餐后再继续。"
        : plan.disposition === "answer"
          ? renderFailClosedReplyPreview(policyPinnedRepresentative, item.userText)
          : renderReplyPreview(policyPinnedRepresentative, plan);
    let runtime: { provider?: "agicto" | "openai" | "bailian" | "anthropic"; model?: string; inputTokens?: number; outputTokens?: number; costCents?: number } = {};
    let runtimeOutcome: GenerationRuntimeOutcome | undefined;
    let memoryUse:
      | {
          runId: string;
          outcome: "completed";
          injectedItemIds: string[];
          citedItemIds: string[];
        }
      | {
          runId: string;
          outcome: "generation_failed";
        }
      | undefined;
    if (plan.disposition === "answer") {
      const generated = await generateRepresentativeReply({
        representative: policyPinnedRepresentative,
        plan,
        subagent,
        userText: item.userText,
        recalled: ledgerBackedRecalledItems,
        recentTurns,
        collectorState: null,
        operationalContext,
      });
      leaseGuard.assertOwned();
      if (generated.ok) {
        replyText = generated.replyText;
        runtimeOutcome = { mode: "model" };
        if (recalled.memoryUseRunId) {
          memoryUse = {
            runId: recalled.memoryUseRunId,
            outcome: "completed",
            injectedItemIds: generated.contextTrace.selectedMemoryUseItemIds,
            citedItemIds: generated.citedMemoryUseItemIds,
          };
        }
        runtime = {
          provider: generated.provider,
          model: generated.model,
          ...(generated.usage?.inputTokens !== undefined ? { inputTokens: generated.usage.inputTokens } : {}),
          ...(generated.usage?.outputTokens !== undefined ? { outputTokens: generated.usage.outputTokens } : {}),
          ...(generated.usage?.costCents !== undefined ? { costCents: generated.usage.costCents } : {}),
        };
      } else {
        runtimeOutcome = {
          mode: "fallback",
          fallbackStrategy: "deterministic_preview",
          modelRuntimeState: generated.state,
          fallbackReason: resolveFallbackReason(generated.state),
        };
        if (recalled.memoryUseRunId) {
          memoryUse = {
            runId: recalled.memoryUseRunId,
            outcome: "generation_failed",
          };
        }
      }
    }

    const publicMaterials = await selectPublicMaterialDeliveries(
      policyPinnedRepresentative,
      plan,
      item.userText,
    );
    if ((plan.actions ?? []).some((action) => action.kind === "deliver_public_material")) {
      replyText = [
        replyText,
        renderPublicMaterialDeliveries(publicMaterials),
      ].filter(Boolean).join("\n\n");
    }
    const turnTrace = buildConversationTurnTrace(plan, (action) => {
      const authorization = authorizeConversationAction(action);
      if (authorization.decision === "deny") {
        return {
          actionId: action.id,
          status: "denied",
          summary: authorization.reason,
        };
      }
      if (authorization.decision === "ask") {
        return {
          actionId: action.id,
          status: "waiting_approval",
          summary: authorization.reason,
        };
      }
      if (action.kind === "deliver_public_material") {
        return {
          actionId: action.id,
          status: publicMaterials.length ? "completed" : "deferred",
          summary: publicMaterials.length
            ? "Published public-material links were added to the reply."
            : "No published public-material URL was available.",
          ...(publicMaterials.length
            ? { output: { materials: publicMaterials } }
            : {}),
        };
      }
      if (action.kind === "answer_public_information") {
        return {
          actionId: action.id,
          status: "completed",
          summary: runtimeOutcome?.mode === "fallback"
            ? "A fail-closed answer was produced without unsupported factual claims."
            : "A grounded public answer was produced.",
        };
      }
      if (action.kind === "request_human_handoff") {
        return {
          actionId: action.id,
          status: "deferred",
          summary: "Human-handoff access and request creation are pending the atomic completion transaction.",
        };
      }
      if (action.kind === "refuse_unsafe_request") {
        return {
          actionId: action.id,
          status: "completed",
          summary: "The unsafe request was refused with a safe alternative.",
        };
      }
      return {
        actionId: action.id,
        status: "deferred",
        summary: "The action was not eligible for inline execution.",
      };
    });
    const requestHandoff = plan.disposition === "handoff";
    const completed = await completeInlineGenerationRun({
      conversationId: item.conversationId,
      runId: item.runId,
      ...workLease,
      replyText,
      senderDisplayName: item.representativeName,
      intent: plan.intent,
      turnTrace,
      completeOutbox: false,
      countUsage: isConversationPlanBillable(plan) && continuationAuthorized,
      ...(requestHandoff
        ? {
            humanHandoff: {
              reason: "AI requested human follow-up",
              summary: item.userText.slice(0, 600),
              kind: plan.intent,
              priority: 80,
              source: item.channel,
            },
          }
        : {}),
      ...(entitlementReservation ? { entitlementReservation } : {}),
      ...(memoryUse ? { memoryUse } : {}),
      ...(runtimeOutcome ? { runtimeOutcome } : {}),
      ...runtime,
    });
    outputMessageId = completed.message.id;

    leaseGuard.assertOwned();
    await deliverGenerationOutput({
      config,
      item,
      text: completed.message.text ?? replyText,
      outputMessageId,
    });
    leaseGuard.assertOwned();
    return { processed: true as const, runId: item.runId, status: "completed" as const };
  } catch (error) {
    if (
      isGenerationMemoryDeliveryBlockedError(error)
      || isGenerationPlanDeliverySupersededError(error)
    ) {
      return {
        processed: true as const,
        runId: item.runId,
        status: "canceled" as const,
      };
    }
    if (isProviderAcceptancePendingCommit(error)) {
      return {
        processed: true as const,
        runId: item.runId,
        status: "accepted_pending_reconciliation" as const,
      };
    }
    if (isComputeGenerationExecutionInProgressError(error)) {
      return {
        processed: true as const,
        runId: item.runId,
        status: "execution_in_progress" as const,
      };
    }
    if (
      leaseGuard.isLost()
      || isGenerationWorkLeaseLostError(error)
      || isComputeGenerationLeaseLostError(error)
      || isComputeExecutionClaimLostError(error)
      || isConversationHumanControlError(error)
    ) {
      return {
        processed: true as const,
        runId: item.runId,
        status: "lease_lost" as const,
      };
    }
    const errorMessage = error instanceof Error ? error.message : "Conversation processing failed.";
    const userFacingFailure = renderUserCorrectableDelegationFailure(errorMessage);
    try {
      if (!outputMessageId && userFacingFailure) {
        return await completeTerminalDelegationFailure(
          config,
          item,
          userFacingFailure,
          entitlementReservation ?? undefined,
        );
      }
      if (outputMessageId) {
        await retryGenerationDelivery({
          runId: item.runId,
          ...workLease,
          outputMessageId,
          errorMessage,
          ...buildProviderOutcomeUnknownRetry(error),
        });
      } else {
        await failGenerationRun({
          conversationId: item.conversationId,
          runId: item.runId,
          ...workLease,
          errorCode: "conversation_worker_failed",
          errorMessage,
        });
      }
    } catch (commitError) {
      if (leaseGuard.isLost() || isGenerationWorkLeaseLostError(commitError)) {
        return {
          processed: true as const,
          runId: item.runId,
          status: "lease_lost" as const,
        };
      }
      throw commitError;
    }
    return { processed: true as const, runId: item.runId, status: "failed" as const, error: errorMessage };
  } finally {
    leaseGuard.stop();
  }
}

function isRecoverableOperatorPause(
  error: unknown,
): error is Error & {
  code: "channel_paused" | "representative_paused" | "policy_disabled";
} {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : null;
  return (
    (error instanceof Error || ("name" in error && error.name === "ChannelUnavailableError"))
    && (
      code === "channel_paused"
      || code === "representative_paused"
      || code === "policy_disabled"
    )
  );
}

function startGenerationLeaseHeartbeat(
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>,
) {
  // Runtime guard keeps older queued fixtures/workers harmless during a
  // rolling deploy even though new claims always include the lease attempt.
  if (!Number.isSafeInteger(item.leaseAttempt)) {
    return {
      assertOwned: () => {},
      confirmOwned: async () => {},
      isLost: () => false,
      stop: () => {},
    };
  }

  let renewing = false;
  let lostError: GenerationWorkLeaseLostError | undefined;
  let stopped = false;
  let heartbeat: ReturnType<typeof setInterval>;
  const markLost = () => {
    if (lostError) return;
    lostError = new GenerationWorkLeaseLostError(
      item.outboxId,
      item.leaseAttempt,
    );
    if (heartbeat) clearInterval(heartbeat);
  };
  heartbeat = setInterval(() => {
    if (renewing || stopped || lostError) return;
    renewing = true;
    void renewGenerationWorkItemLease({
      outboxId: item.outboxId,
      leaseAttempt: item.leaseAttempt,
    })
      .then((renewed) => {
        if (!renewed) {
          markLost();
          console.warn(
            `Conversation work lease was lost for generation run ${item.runId}.`,
          );
        }
      })
      .catch((error) => {
        markLost();
        console.error(
          `Conversation work lease renewal failed for generation run ${item.runId}.`,
          error,
        );
      })
      .finally(() => {
        renewing = false;
      });
  }, Math.max(1_000, Math.floor(GENERATION_WORK_LEASE_DURATION_MS / 3)));
  heartbeat.unref?.();

  return {
    assertOwned() {
      if (lostError) throw lostError;
    },
    async confirmOwned() {
      if (lostError) throw lostError;
      let renewed: boolean;
      try {
        renewed = await renewGenerationWorkItemLease({
          outboxId: item.outboxId,
          leaseAttempt: item.leaseAttempt,
        });
      } catch (error) {
        markLost();
        throw error;
      }
      if (!renewed) {
        markLost();
        throw lostError;
      }
    },
    isLost() {
      return Boolean(lostError);
    },
    stop() {
      stopped = true;
      clearInterval(heartbeat);
    },
  };
}

async function buildDelegationPlannerInput(input: {
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
  taskInput: string;
}) {
  // Delegation planning is a separate model invocation and does not yet share
  // the answer UseRun. Until it has its own auditable usage ledger, fail closed
  // to caller input instead of silently injecting OpenViking recall.
  return {
    text: input.taskInput,
    authorizedKnowledge: [],
  };
}

function resolveDelegationConfig(
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>,
) {
  return (setup as typeof setup & { delegation?: typeof setup.delegation }).delegation ?? {
    enabled: true,
    naturalLanguageEnabled: true,
    explicitComputeEnabled: true,
    maxSteps: 5,
    maxEstimatedTokens: 0,
    knowledgeScope: "user_input_only" as const,
  };
}

function resolveCapabilityModes(
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>,
) {
  return (setup.compute as typeof setup.compute & {
    capabilityModes?: typeof setup.compute.capabilityModes;
  }).capabilityModes ?? {
    exec: "ask" as const,
    read: "allow" as const,
    write: "ask" as const,
    process: "ask" as const,
    browser: "ask" as const,
    mcp: "ask" as const,
  };
}

function renderDelegationTerminalRecovery(
  input: NonNullable<
    NonNullable<
      Awaited<ReturnType<typeof claimNextGenerationWorkItem>>
    >["delegationTerminalRecovery"]
  >,
) {
  const artifactSummary = input.attachments.length
    ? input.attachments
      .map((attachment) => `已生成文件：${attachment.fileName}`)
      .join("\n")
    : "没有生成可展示的结果文件。";
  const keepConversationQueued =
    input.taskStatus === "READY" && input.stepStatus === "COMPLETED";

  if (keepConversationQueued) {
    return {
      text: `委托任务当前步骤已完成，后续步骤已进入执行队列。\n\n${artifactSummary}`,
      keepConversationQueued,
    };
  }
  if (
    input.taskStatus === "COMPLETED"
    && input.stepStatus === "COMPLETED"
  ) {
    return {
      text: `委托任务已在隔离沙盒中执行完成。\n\n${artifactSummary}`,
      keepConversationQueued,
    };
  }
  if (input.stepStatus === "BLOCKED") {
    return {
      text: "委托任务被安全策略拒绝，未执行。",
      keepConversationQueued,
    };
  }
  if (input.taskStatus === "WAITING_FOR_OWNER") {
    return {
      text: "委托任务的外部操作结果需要代表所有者核对，确认前不会自动重试。",
      keepConversationQueued,
    };
  }
  if (
    input.taskStatus === "CANCELED"
    || input.taskStatus === "EXPIRED"
    || input.stepStatus === "CANCELED"
    || input.stepStatus === "SKIPPED"
  ) {
    return {
      text: "委托任务已取消或过期，系统不会继续执行。",
      keepConversationQueued,
    };
  }
  return {
    text: `委托任务已停止，未能完成。\n\n${artifactSummary}`,
    keepConversationQueued,
  };
}

async function completeTerminalDelegationFailure(
  _config: ConversationWorkerConfig,
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>,
  replyText: string,
  entitlementReservation?: ConversationEntitlementReservation,
) {
  if (item.delegationTaskId && item.delegationTaskStepId) {
    await finalizeComputeDelegationTask({
      taskId: item.delegationTaskId,
      stepId: item.delegationTaskStepId,
      generationRunId: item.runId,
      ...delegationLeaseFence(item),
      outcome: "failed",
      failureReason: replyText,
    });
  }
  await completeInlineGenerationRun({
    conversationId: item.conversationId,
    runId: item.runId,
    outboxId: item.outboxId,
    leaseAttempt: item.leaseAttempt,
    replyText,
    senderDisplayName: item.representativeName,
    intent: "delegation_failed",
    evidenceIndependentSystemFailure: {
      failureCode: "delegation_failed",
    },
    countUsage: false,
    completeOutbox: false,
    ...(entitlementReservation ? { entitlementReservation } : {}),
  });
  return { processed: true as const, runId: item.runId, status: "completed" as const };
}

function renderUserCorrectableDelegationFailure(errorMessage: string) {
  if (errorMessage.includes("path_outside_allowed_workspace")) {
    return "委托任务未能执行：输出位置不符合沙盒安全规则。系统已停止本次任务；普通用户无需提供沙盒路径，请重新描述希望生成的内容，文件位置将由系统自动管理。";
  }
  return null;
}

export function renderPolicyBlockedDelegationMessage(reasonCode?: string | null) {
  if (
    reasonCode === "managed_plan_tier_required"
    || reasonCode === "plan_tier_required"
    || reasonCode === "managed_paid_plan_required"
    || reasonCode === "paid_plan_required"
  ) {
    return "该外部工具需要已购买的 Pass 服务额度，当前会话未获得对应权益，因此系统没有执行。请先购买对应服务，或联系代表所有者确认服务策略。";
  }
  return "委托任务被安全策略拒绝，未执行。";
}

export function renderTurnPlanV3PlanningFailureMessage(result: {
  code: string;
  reason?: string;
}) {
  switch (result.code) {
    case "provider_failed":
      return "规划服务本轮超时或调用失败，因此系统没有执行实时工具，也没有用通用模型猜测。请稍后重试。";
    case "runtime_unavailable":
      return "规划服务当前不可用，因此系统没有执行工具，也没有用通用模型猜测。请稍后重试。";
    case "strict_schema_unsupported":
      return "当前规划模型不支持受治理计划所需的严格结构化输出，因此系统没有执行工具。";
    case "proposal_invalid":
      return "规划模型返回的结构不符合受治理计划协议，因此系统没有执行工具。请重新提交请求。";
    case "plan_invalid":
      return "本轮计划未通过能力、参数、证据或依赖校验，因此系统没有执行工具，也没有用模型猜测。";
    default:
      return "本轮未能生成可安全执行的受治理计划，因此系统没有执行工具，也没有用模型猜测。";
  }
}

export function resolveStableGeneralFallbackActivationStatus(
  reasonCode?: string | null,
): KnowledgeFallbackActivationV3["status"] | undefined {
  return reasonCode === "managed_plan_tier_required"
    || reasonCode === "plan_tier_required"
    || reasonCode === "managed_paid_plan_required"
    || reasonCode === "paid_plan_required"
      ? "entitlement_denied"
      : undefined;
}

async function processConversationComputeRequest(input: {
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  leaseGuard: ReturnType<typeof startGenerationLeaseHeartbeat>;
  parsed: ParsedComputeRequest;
  planSummary?: string;
  planSteps?: Array<{
    summary: string;
    request: ParsedComputeRequest;
    dependsOnStepIndexes?: number[];
    planActionId?: string;
    actionKey?: string;
    executionRequest?: CapabilityExecutionRequest;
  }>;
  governedV3Actions?: GovernedV3Action[];
  authorizedKnowledge?: AuthorizedDelegationKnowledge[];
  delegation?: { task: { id: string }; step: { id: string } };
}): Promise<{
  text: string;
  billable: boolean;
  hasMoreSteps: boolean;
  approvalId?: string;
  delegationTaskId?: string;
  fallbackActivationStatus?: KnowledgeFallbackActivationV3["status"];
  attachments?: Array<{
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    artifactId: string;
    url: string;
  }>;
}> {
  await input.leaseGuard.confirmOwned();
  const delegationConfig = resolveDelegationConfig(input.setup);
  if (!input.setup.compute.enabled || !delegationConfig.enabled) {
    if (input.delegation) {
      input.leaseGuard.assertOwned();
      await finalizeComputeDelegationTask({
        taskId: input.delegation.task.id,
        stepId: input.delegation.step.id,
        generationRunId: input.item.runId,
        ...delegationLeaseFence(input.item),
        outcome: "blocked",
        failureReason: "Delegated execution was disabled before this step could start.",
      });
      input.leaseGuard.assertOwned();
    }
    return {
      text: input.setup.compute.enabled
        ? "这个代表当前不接受委托任务。"
        : "这个代表当前没有启用 Compute。请联系代表所有者在 Dashboard 中启用后再试。",
      billable: false,
      hasMoreSteps: false,
    };
  }

  if (input.parsed.capability === "mcp") {
    const authority = await getRepresentativeRuntimeAuthoritySnapshot(
      input.item.representativeSlug,
      input.item.representativeVersionId,
    );
    const grant = authority?.mcpBindings.find((binding) =>
      (
        input.parsed.bindingId
          ? binding.id === input.parsed.bindingId
          : binding.slug === input.parsed.bindingSlug
      )
      && (
        !input.parsed.toolName
        || !binding.allowedToolNames.length
        || binding.allowedToolNames.includes(input.parsed.toolName)
      ),
    );
    if (!grant) {
      if (input.delegation) {
        await finalizeComputeDelegationTask({
          taskId: input.delegation.task.id,
          stepId: input.delegation.step.id,
          generationRunId: input.item.runId,
          ...delegationLeaseFence(input.item),
          outcome: "blocked",
          failureReason:
            "The pinned representative version does not grant the requested MCP binding and tool.",
        });
      }
      return {
        text:
          "当前会话固定的代表版本尚未包含这个 MCP 连接或工具。若 Owner 已发布包含该连接的新版本，请在上一轮结束后重新发送同一请求；系统会从新的会话阶段使用最新发布版本。",
        billable: false,
        hasMoreSteps: false,
      };
    }
  }

  await input.leaseGuard.confirmOwned();
  const delegation = input.delegation ?? await createComputeDelegationTask({
    representativeId: input.setup.id,
    representativeSlug: input.item.representativeSlug,
    representativeVersionId: input.item.representativeVersionId,
    contactId: input.item.contactId,
    conversationId: input.item.conversationId,
    ...(input.item.episodeId ? { episodeId: input.item.episodeId } : {}),
    generationRunId: input.item.runId,
    inputMessageId: input.item.inputMessageId,
    objective: input.item.userText,
    actionSummary: input.parsed.displayTarget,
    request: input.parsed,
    ...(input.planSummary ? { planSummary: input.planSummary } : {}),
    ...(input.planSteps ? { planSteps: input.planSteps } : {}),
    capability: input.parsed.capability,
    maxDurationMinutes: input.setup.compute.maxSessionMinutes,
    maxEstimatedTokens: delegationConfig.maxEstimatedTokens,
    ...(input.authorizedKnowledge?.length ? { authorizedKnowledge: input.authorizedKnowledge } : {}),
    networkMode: input.setup.compute.networkMode.toUpperCase() as "NO_NETWORK" | "ALLOWLIST" | "FULL",
    filesystemMode: input.setup.compute.filesystemMode.toUpperCase() as "WORKSPACE_ONLY" | "READ_ONLY_WORKSPACE" | "EPHEMERAL_FULL",
  });
  input.leaseGuard.assertOwned();
  if (!delegation.step) throw new Error("Delegation task is missing its compute step.");
  const delegationStepId = delegation.step.id;

  const blockDelegation = async (failureReason: string, text: string) => {
    input.leaseGuard.assertOwned();
    await finalizeComputeDelegationTask({
      taskId: delegation.task.id,
      stepId: delegationStepId,
      generationRunId: input.item.runId,
      ...delegationLeaseFence(input.item),
      outcome: "blocked",
      failureReason,
    });
    input.leaseGuard.assertOwned();
    return {
      text,
      billable: false,
      hasMoreSteps: false,
      delegationTaskId: delegation.task.id,
    };
  };

  const plannedStepCount = input.planSteps?.length ?? 1;
  if (plannedStepCount > delegationConfig.maxSteps) {
    return blockDelegation(
      `Planned step count ${plannedStepCount} exceeds representative limit ${delegationConfig.maxSteps}.`,
      `这个任务需要 ${plannedStepCount} 个执行步骤，超过该代表允许的 ${delegationConfig.maxSteps} 步上限。系统未创建沙盒，请缩小任务范围后重试。`,
    );
  }

  const estimatedTokens = (input.planSteps ?? [{ request: input.parsed }]).reduce(
    (total, step) => total + (step.request.estimatedTokens ?? 0),
    0,
  );
  if (
    delegationConfig.maxEstimatedTokens > 0 &&
    estimatedTokens > delegationConfig.maxEstimatedTokens
  ) {
    return blockDelegation(
      `Estimated token usage ${estimatedTokens} exceeds representative limit ${delegationConfig.maxEstimatedTokens}.`,
      `这个任务的预计 Token 使用量为 ${estimatedTokens}，超过该代表设置的 ${delegationConfig.maxEstimatedTokens} Token 上限。系统未创建沙盒，请缩小任务范围。`,
    );
  }

  const capabilityMode = resolveCapabilityModes(input.setup)[input.parsed.capability];
  if (capabilityMode === "deny") {
    return blockDelegation(
      `Representative policy denies ${input.parsed.capability}.`,
      `这个代表的能力策略禁止${renderCapabilityLabel(input.parsed.capability)}，系统未执行。`,
    );
  }

  const subagent = resolveComputeSubagent(input.parsed.capability);

  let result: Awaited<ReturnType<typeof executeAudienceTool>>;
  try {
    await input.leaseGuard.confirmOwned();
    const session = await createAudienceComputeSession({
      representativeId: input.setup.id,
      contactId: input.item.contactId,
      conversationId: input.item.conversationId,
      generationRunId: input.item.runId,
      generationWorkLease: {
        outboxId: input.item.outboxId,
        leaseAttempt: input.item.leaseAttempt,
      },
      delegationTaskId: delegation.task.id,
      delegationTaskStepId: delegation.step.id,
      subagentId: subagent.id,
      requestedCapabilities: [input.parsed.capability],
      reason: `${input.item.channel}:${input.parsed.capability}`,
      requestedBaseImage: input.setup.compute.baseImage,
    });
    input.leaseGuard.assertOwned();
    await markDelegationTaskRunning(delegation.task.id, delegation.step.id);
    await input.leaseGuard.confirmOwned();
    result = await executeAudienceTool(session.session.id, {
      ...input.parsed,
      subagentId: subagent.id,
      generationWorkLease: {
        outboxId: input.item.outboxId,
        leaseAttempt: input.item.leaseAttempt,
      },
      // The compute broker derives paid plan authority from its server-side
      // conversation and generation-run context. Never elevate a client payload.
      hasPaidEntitlement: false,
    });
    input.leaseGuard.assertOwned();
  } catch (error) {
    if (
      isComputeGenerationLeaseLostError(error)
      || isComputeExecutionClaimLostError(error)
      || isComputeGenerationExecutionInProgressError(error)
    ) {
      throw error;
    }
    input.leaseGuard.assertOwned();
    await finalizeComputeDelegationTask({
      taskId: delegation.task.id,
      stepId: delegation.step.id,
      generationRunId: input.item.runId,
      ...delegationLeaseFence(input.item),
      outcome: "failed",
      failureReason: error instanceof Error ? error.message : "Compute execution failed.",
    });
    input.leaseGuard.assertOwned();
    throw error;
  }

  if (result.outcome === "pending_approval") {
    if (!result.approvalRequest) throw new Error("Compute approval response is missing.");
    input.leaseGuard.assertOwned();
    await markDelegationTaskAwaitingApproval({
      taskId: delegation.task.id,
      stepId: delegation.step.id,
      approvalId: result.approvalRequest.id,
    });
    input.leaseGuard.assertOwned();
    return {
      approvalId: result.approvalRequest.id,
      delegationTaskId: delegation.task.id,
      billable: false,
      hasMoreSteps: false,
      text: [
        `委托任务已提交，正在等待代表所有者审批。`,
        `操作：${renderPublicComputeAction(input.parsed)}`,
        `风险：${result.approvalRequest.riskSummary}`,
        "审批通过后会在此对话中自动返回执行结果。",
      ].join("\n\n"),
    };
  }

  const attachments = result.artifacts.map((artifact) => ({
    fileName: resolvePublicArtifactFileName(artifact, input.parsed),
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    artifactId: artifact.id,
    url: `/reps/${input.item.representativeSlug}/chat/artifacts/${artifact.id}/download`,
  }));
  const artifactSummary = attachments.length
    ? attachments.map((attachment) => `已生成文件：${attachment.fileName}`).join("\n")
    : "没有生成可展示的结果文件。";

  const v3SemanticOutcome = result.execution?.semanticOutcome;
  const v3TransportOutcome = result.execution?.transportOutcome;

  await input.leaseGuard.confirmOwned();
  const finalization = await finalizeComputeDelegationTask({
    taskId: delegation.task.id,
    stepId: delegation.step.id,
    generationRunId: input.item.runId,
    ...delegationLeaseFence(input.item),
    outcome: result.outcome === "blocked"
      ? "blocked"
      : result.outcome === "failed"
        || v3SemanticOutcome === "failed"
        || v3SemanticOutcome === "unknown"
        || v3SemanticOutcome === "partial"
        ? "failed"
        : "completed",
    artifacts: result.artifacts,
    ...(v3SemanticOutcome === "unknown"
      ? {
          failureReason: v3TransportOutcome === "outcome_unknown"
            ? "外部调用结果未知，已进入人工对账；系统不会自动重试。"
            : "外部工具已返回，但缺少可靠的业务成功判定，系统不会宣称目标完成。",
        }
      : v3SemanticOutcome === "failed"
        ? { failureReason: "工具传输已结束，但业务成功条件未满足。" }
        : {}),
  });
  await input.leaseGuard.confirmOwned();

  if (result.outcome === "blocked") {
    const fallbackActivationStatus =
      resolveStableGeneralFallbackActivationStatus(result.blockReasonCode);
    return {
      text: renderPolicyBlockedDelegationMessage(result.blockReasonCode),
      billable: false,
      hasMoreSteps: false,
      delegationTaskId: delegation.task.id,
      ...(fallbackActivationStatus ? { fallbackActivationStatus } : {}),
    };
  }
  if (result.outcome === "failed") {
    return {
      text: `委托任务已执行，但未能完成。\n\n${artifactSummary}`,
      billable: false,
      hasMoreSteps: false,
      delegationTaskId: delegation.task.id,
      ...(attachments.length ? { attachments } : {}),
    };
  }
  if (v3SemanticOutcome === "unknown" || v3SemanticOutcome === "partial") {
    return {
      text: v3TransportOutcome === "outcome_unknown"
        ? `外部操作的最终结果无法确认，任务已进入人工对账；系统不会自动重试，也不会宣称完成。\n\n${artifactSummary}`
        : `工具已返回数据，但当前没有可靠的业务成功判定，因此目标尚未被标记为完成。系统已保留结果供核对。\n\n${artifactSummary}`,
      billable: false,
      hasMoreSteps: false,
      delegationTaskId: delegation.task.id,
      ...(attachments.length ? { attachments } : {}),
    };
  }
  if (v3SemanticOutcome === "failed") {
    return {
      text: `工具调用已结束，但业务成功条件未满足，因此任务没有被标记为完成。\n\n${artifactSummary}`,
      billable: false,
      hasMoreSteps: false,
      delegationTaskId: delegation.task.id,
      ...(attachments.length ? { attachments } : {}),
    };
  }
  return {
    text: finalization?.hasMoreSteps
      ? `委托任务当前步骤已完成，后续步骤已进入执行队列。\n\n${artifactSummary}`
      : `委托任务已在隔离沙盒中执行完成。\n\n${artifactSummary}`,
    billable: true,
    hasMoreSteps: Boolean(finalization?.hasMoreSteps),
    delegationTaskId: delegation.task.id,
    ...(attachments.length ? { attachments } : {}),
  };
}

function delegationLeaseFence(
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>,
) {
  return Number.isSafeInteger(item.leaseAttempt)
    ? {
        outboxId: item.outboxId,
        leaseAttempt: item.leaseAttempt,
      }
    : {};
}

function resolvePublicArtifactFileName(
  artifact: { id: string; kind: string; mimeType: string },
  request: ParsedComputeRequest,
) {
  if (artifact.kind === "file" && request.path) {
    return request.path.split("/").pop() || "result.txt";
  }
  const extension = artifact.mimeType.includes("json")
    ? "json"
    : artifact.mimeType.includes("csv")
      ? "csv"
      : artifact.mimeType.includes("png")
        ? "png"
        : artifact.mimeType.includes("jpeg")
          ? "jpg"
          : "txt";
  return `${artifact.kind}-${artifact.id}.${extension}`;
}

function renderPublicComputeAction(request: ParsedComputeRequest) {
  if (request.capability === "write") {
    if (/^outputs\/report-[a-f0-9]{8}\.md$/i.test(request.path || "")) {
      return "生成并保存文档";
    }
    return `写入文件：${request.path?.split("/").pop() || "系统管理的文件"}`;
  }
  if (request.capability === "read") {
    return `读取文件：${request.path?.split("/").pop() || "系统管理的文件"}`;
  }
  if (request.capability === "browser") return "访问用户提供的公开网页";
  if (request.capability === "mcp") return "调用已授权的外部工具";
  return "在隔离沙盒中运行用户提供的命令";
}

function renderCapabilityLabel(capability: ParsedComputeRequest["capability"]) {
  switch (capability) {
    case "read":
      return "读取工作区文件";
    case "write":
      return "写入工作区文件";
    case "browser":
      return "访问网页";
    case "mcp":
      return "调用外部工具";
    case "process":
      return "运行长期进程";
    case "exec":
    default:
      return "运行命令";
  }
}

async function sendTelegramOperatorMessage(input: {
  config: ConversationWorkerConfig;
  conversationId: string;
  chatId: string;
  connectionId?: string;
  operatorName: string;
  text: string;
}) {
  if (input.config.telegramConversationPlatformMode !== "worker") {
    throw new Error("Telegram conversation worker is not the active delivery owner.");
  }
  return sendTelegramMessage({
    config: input.config,
    conversationId: input.conversationId,
    chatId: input.chatId,
    ...(input.connectionId
      ? { connectionId: input.connectionId }
      : {}),
    text: `${input.operatorName}: ${input.text}`,
  });
}

async function sendTelegramRepresentativeMessage(input: {
  config: ConversationWorkerConfig;
  conversationId: string;
  chatId: string;
  connectionId?: string;
  generationDelivery: {
    runId: string;
    outboxId: string;
    leaseAttempt: number;
    outputMessageId: string;
    deliveryAdmission: GenerationMessageDeliveryAdmission;
  };
  text: string;
}) {
  return sendTelegramMessage(input);
}

async function sendTelegramMessage(input: {
  config: ConversationWorkerConfig;
  conversationId: string;
  chatId: string;
  connectionId?: string;
  generationDelivery?: {
    runId: string;
    outboxId: string;
    leaseAttempt: number;
    outputMessageId: string;
    deliveryAdmission: GenerationMessageDeliveryAdmission;
  };
  text: string;
}) {
  const configuredConnectionId = input.connectionId?.trim();
  if (!configuredConnectionId) {
    throw new Error(
      "Telegram Bot connection is missing for this conversation.",
    );
  }
  const fencedDelivery =
    await withActiveTelegramRepresentativeChannelFence(
      {
        conversationId: input.conversationId,
        expectedConnectionId: configuredConnectionId,
      },
      async (tx) => {
        const credential = await resolveTelegramBotRuntimeCredential({
          connectionId: configuredConnectionId,
        });
        const hasPersistedConnections = credential
          ? true
          : await hasPersistedTelegramBotConnections();
        const token =
          credential?.token
          || (!hasPersistedConnections
            ? input.config.telegramBotToken
            : undefined);
        if (!token) {
          throw new Error(
            "Telegram Bot credential is unavailable for this conversation.",
          );
        }
        const tokenBotId = token.match(/^([1-9]\d*):/)?.[1];
        const expectedBotId =
          credential?.botId || configuredConnectionId;
        if (
          !tokenBotId
          || (expectedBotId && tokenBotId !== expectedBotId)
        ) {
          throw new Error(
            "Telegram Bot credential does not match the conversation connection.",
          );
        }
        const send = async () => {
          let response: Response;
          try {
            response = await fetch(
              `https://api.telegram.org/bot${token}/sendMessage`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id: input.chatId,
                  text: input.text,
                }),
                signal: AbortSignal.timeout(
                  input.config.telegramRequestTimeoutMs ?? 15_000,
                ),
              },
            );
          } catch (error) {
            throw new TelegramProviderOutcomeUnknownError(error);
          }
          let payload: {
              ok?: boolean;
              result?: { message_id?: number };
              description?: string;
            };
          try {
            payload = await response.json() as typeof payload;
          } catch (error) {
            if (response.ok) {
              throw new TelegramProviderOutcomeUnknownError(error);
            }
            throw new Error(
              `Telegram delivery failed with an unreadable provider response (${response.status}).`,
            );
          }
          if (!response.ok || !payload.ok) {
            throw new Error(
              payload.description
              || `Telegram operator delivery failed (${response.status}).`,
            );
          }
          if (!payload.result?.message_id) {
            throw new TelegramProviderOutcomeUnknownError(
              new Error("Telegram accepted the request without returning a message id."),
            );
          }
          return String(payload.result.message_id);
        };
        if (!input.generationDelivery) {
          return { executed: true as const, value: await send() };
        }
        return withGenerationMessageProviderDeliveryFence(
          tx,
          {
            conversationId: input.conversationId,
            ...input.generationDelivery,
          },
          send,
        );
      },
    );
  if (!fencedDelivery.executed) {
    throw new Error(
      "Telegram channel assignment changed before outbound delivery.",
    );
  }
  const providerDelivery = fencedDelivery.value;
  if (!providerDelivery.executed) {
    // The transaction above committed the terminal cancel/dead-letter writes.
    if (
      providerDelivery.reason === "turn_plan_superseded_before_delivery"
    ) {
      throw new GenerationPlanDeliverySupersededError();
    }
    throw new GenerationMemoryDeliveryBlockedError();
  }
  return providerDelivery.value;
}

async function deliverGenerationOutput(input: {
  config: ConversationWorkerConfig;
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
  text: string;
  outputMessageId: string;
  planActionId?: string;
}) {
  const deliveryPreparation = await prepareGenerationMessageChannelDelivery({
    conversationId: input.item.conversationId,
    runId: input.item.runId,
    outboxId: input.item.outboxId,
    leaseAttempt: input.item.leaseAttempt,
    outputMessageId: input.outputMessageId,
    ...(input.planActionId ? { planActionId: input.planActionId } : {}),
  });
  await assertConversationChannelDeliveryAvailable({
    conversationId: input.item.conversationId,
    channel: input.item.channel,
    senderMode: "ai",
    allowNeedsHumanDelivery:
      deliveryPreparation.allowNeedsHumanDelivery,
  });
  let deliveryText = input.text;
  const isContactMemoryDeleteConfirmation =
    (input.item.channel === "matrix" || input.item.channel === "telegram")
    && isDeterministicContactMemoryDeleteCommand(input.item.userText);
  if (
    (input.item.channel === "matrix" || input.item.channel === "telegram")
    && !isContactMemoryDeleteConfirmation
  ) {
    try {
      deliveryText = await renderPrivateChannelGenerationDeliveryText({
        generationRunId: input.item.runId,
        outputMessageId: input.outputMessageId,
        text: input.text,
      });
    } catch {
      deliveryText = privateChannelSourceVerificationUnavailableStatement;
    }
  }
  let externalMessageId: string | undefined;
  const providerDeliveryFence = {
    runId: input.item.runId,
    outboxId: input.item.outboxId,
    leaseAttempt: input.item.leaseAttempt,
    outputMessageId: input.outputMessageId,
    deliveryAdmission: deliveryPreparation.deliveryAdmission,
  };
  if (input.item.channel === "matrix" || input.item.channel === "telegram") {
    await admitGenerationMessageProviderDelivery({
      conversationId: input.item.conversationId,
      ...providerDeliveryFence,
    });
  }
  if (input.item.channel === "matrix") {
    if (!input.item.externalConversationId || !input.item.matrixSenderUserId) {
      throw new Error("Matrix room or representative virtual user is missing.");
    }
    if (!input.item.matrixEndpointLifecycleRevision) {
      throw new Error(
        "Matrix generation delivery is missing its channel lifecycle fence.",
      );
    }
    externalMessageId = await sendMatrixRepresentativeMessage({
      config: input.config,
      conversationId: input.item.conversationId,
      roomId: input.item.externalConversationId,
      senderUserId: input.item.matrixSenderUserId,
      expectedEndpointLifecycleRevision:
        input.item.matrixEndpointLifecycleRevision,
      deliveryId: input.item.runId,
      senderMode: "ai",
      generationRunId: input.item.runId,
      generationDelivery: providerDeliveryFence,
      text: deliveryText,
    });
  } else if (input.item.channel === "telegram") {
    if (input.config.telegramConversationPlatformMode !== "worker") {
      throw new Error("Telegram conversation worker is not the active delivery owner.");
    }
    if (!input.item.externalConversationId) {
      throw new Error("Telegram chat binding is missing.");
    }
    externalMessageId = await sendTelegramRepresentativeMessage({
      config: input.config,
      conversationId: input.item.conversationId,
      chatId: input.item.externalConversationId,
      ...(input.item.telegramConnectionId
        ? { connectionId: input.item.telegramConnectionId }
        : {}),
      generationDelivery: providerDeliveryFence,
      text: deliveryText,
    });
  }
  if (externalMessageId) {
    await recordGenerationMessageProviderAcceptance({
      runId: input.item.runId,
      outboxId: input.item.outboxId,
      leaseAttempt: input.item.leaseAttempt,
      outputMessageId: input.outputMessageId,
      externalMessageId,
      deliveryAdmission: deliveryPreparation.deliveryAdmission,
    });
  }
  try {
    await markGenerationDeliveryComplete({
      runId: input.item.runId,
      outboxId: input.item.outboxId,
      leaseAttempt: input.item.leaseAttempt,
      outputMessageId: input.outputMessageId,
      deliveryAdmission: deliveryPreparation.deliveryAdmission,
      ...(externalMessageId ? { externalMessageId } : {}),
    });
  } catch (error) {
    if (externalMessageId) {
      throw new ProviderAcceptancePendingCommitError(error);
    }
    throw error;
  }
  return externalMessageId;
}

function resolveManagedArtifactDownloadUrl(
  config: ConversationWorkerConfig,
  downloadUrl: string,
  channel: "web" | "matrix" | "telegram",
) {
  if (channel === "web") return downloadUrl;
  if (!config.representativePublicOrigin) {
    throw new Error(
      "NEXT_PUBLIC_REPRESENTATIVE_URL is required for cross-channel artifact delivery.",
    );
  }
  return new URL(downloadUrl, `${config.representativePublicOrigin}/`).toString();
}

function renderContactMemoryDeleteConfirmation(
  channel: "matrix" | "telegram",
) {
  const channelName = channel === "matrix" ? "Matrix" : "Telegram";
  return `已完成：当前数字代表与当前 ${channelName} 渠道下的联系人记忆已立即停止召回，后台将异步清理对应长期记忆。代表经验和其他渠道的联系人记忆不受影响。`;
}

function renderContactMemorySharingDisclosure(challengeToken?: string) {
  return [
    "跨渠道联系人记忆只会共享给当前数字代表，并且只在已验证为同一 Delegate 用户的 Web、Matrix、Telegram 私聊之间使用。",
    "系统不会把原始聊天、付款或余额、凭据、Owner 私有备注、Compute 原始产物写入长期记忆；每次召回仍会检查当前身份、策略和渠道授权。",
    "你可以随时发送 !memory_unshare，立即停止共享记忆召回并异步清理远端投影；各渠道原始会话和渠道内记忆不受影响。",
    challengeToken
      ? `如果你同意，请在 10 分钟内发送：!memory_share confirm ${challengeToken}`
      : "请重新发送 !memory_share 获取一次性确认令牌。",
  ].join("\n\n");
}

function renderContactMemorySharingFailure(
  code: ContactMemorySharingError["code"],
) {
  if (code === "contact_memory_sharing_policy_disabled") {
    return "当前暂不提供联系人长期记忆能力，因此跨渠道授权未生效。";
  }
  if (code === "contact_memory_sharing_contract_mismatch") {
    return `${renderContactMemorySharingDisclosure()}\n\n披露内容已经更新，请重新获取一次性确认令牌。`;
  }
  if (
    code === "contact_memory_sharing_challenge_invalid"
    || code === "contact_memory_sharing_challenge_expired"
    || code === "contact_memory_sharing_challenge_consumed"
  ) {
    return "一次性确认令牌缺失、无效、已过期或已使用。请重新发送 !memory_share 阅读说明并获取新令牌。";
  }
  if (
    code === "contact_memory_sharing_identity_ineligible"
    || code === "contact_memory_sharing_source_unverified"
  ) {
    return "授权未生效：请先在当前代表的 Web 页面登录并把这个 Matrix 账号绑定到同一个 Delegate 用户。";
  }
  if (code === "contact_memory_sharing_representative_not_found") {
    return "当前数字代表已不可用，跨渠道联系人记忆授权未变更。";
  }
  return "跨渠道联系人记忆状态刚刚发生变化，请重试命令。";
}

class TelegramProviderOutcomeUnknownError extends Error {
  readonly code = "telegram_provider_outcome_unknown";

  constructor(cause: unknown) {
    super(
      "Telegram provider outcome is unknown; automatic retry is disabled to prevent duplicate delivery.",
      { cause },
    );
    this.name = "TelegramProviderOutcomeUnknownError";
  }
}

class ProviderAcceptancePendingCommitError extends Error {
  readonly code = "provider_acceptance_pending_commit";

  constructor(cause: unknown) {
    super(
      "Provider acceptance is durable, but the current work lease could not finalize delivery.",
      { cause },
    );
    this.name = "ProviderAcceptancePendingCommitError";
  }
}

function isProviderAcceptancePendingCommit(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "provider_acceptance_pending_commit",
  );
}

function buildProviderOutcomeUnknownRetry(error: unknown):
  | Record<string, never>
  | {
      providerOutcomeUnknown: true;
      providerOutcomeCode:
        | "telegram_provider_outcome_unknown"
        | "matrix_provider_outcome_unknown";
    } {
  if (!error || typeof error !== "object" || !("code" in error)) return {};
  if (
    error.code !== "telegram_provider_outcome_unknown"
    && error.code !== "matrix_provider_outcome_unknown"
  ) return {};
  return {
    providerOutcomeUnknown: true,
    providerOutcomeCode: error.code,
  };
}

function isConversationHumanControlError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return error.code === "CONVERSATION_HUMAN_ACTIVE";
}

function isComputeGenerationLeaseLostError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "generation_work_lease_lost",
  );
}

import { z } from "zod";

import {
  assertSupportedCapabilitySchema,
  canonicalJson,
  isDirectUserMessageArgumentGrounded,
  planArgumentProvenanceSchema,
  stableSha256,
  validateJsonSchemaValue,
  type TurnEnvelope,
} from "./turn-planning";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifierSchema = z.string().trim().min(1).max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const capabilityKeySchema = z.string().trim().min(3).max(200)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/);

export const CAPABILITY_CANONICALIZATION_VERSION_V3 = "delegate-capability-v1" as const;
export const MIN_GENERAL_SEMANTIC_CONFIDENCE_V3 = 0.8;
export const MAX_CAPABILITY_DEFINITION_BYTES_V3 = 64 * 1_024;
export const MAX_CAPABILITY_CATALOG_BYTES_V3 = 2 * 1_024 * 1_024;

export const capabilityEffectV3Schema = z.object({
  boundary: z.enum(["internal", "external"]),
  mutation: z.enum(["none", "write"]),
  reversibility: z.enum([
    "not_applicable",
    "reversible",
    "irreversible",
    "unknown",
  ]),
}).strict().superRefine((effect, context) => {
  if (
    (effect.boundary === "internal" || effect.mutation === "none")
    && effect.reversibility !== "not_applicable"
  ) {
    context.addIssue({
      code: "custom",
      path: ["reversibility"],
      message: "Only an external write may declare reversible, irreversible, or unknown reversibility.",
    });
  }
  if (
    effect.boundary === "external"
    && effect.mutation === "write"
    && effect.reversibility === "not_applicable"
  ) {
    context.addIssue({
      code: "custom",
      path: ["reversibility"],
      message: "An external write must declare its reversibility or use unknown.",
    });
  }
});

export const successContractV3Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("success_schema"),
    schema: jsonObjectSchema,
  }).strict(),
  z.object({
    kind: z.literal("status_predicate"),
    pointer: z.string().min(1).max(1_000).regex(/^\//),
    operator: z.enum(["equals", "in"]),
    value: z.unknown(),
  }).strict(),
  z.object({
    kind: z.literal("server_evaluator"),
    evaluatorId: boundedText(160),
    evaluatorVersion: boundedText(80),
  }).strict(),
  z.object({
    kind: z.literal("manual_confirmation"),
  }).strict(),
]).superRefine((contract, context) => {
  if (
    contract.kind === "status_predicate"
    && contract.operator === "in"
    && !Array.isArray(contract.value)
  ) {
    context.addIssue({
      code: "custom",
      path: ["value"],
      message: "The in operator requires an array predicate value.",
    });
  }
});

export const capabilityOperationV3Schema = z.enum([
  "answer",
  "read",
  "search",
  "explain",
  "create",
  "mutate",
  "deliver",
  "control",
]);

export const capabilityEvidenceClassV3Schema = z.enum([
  "none",
  "authorized_knowledge",
  "capability_result",
  "current_external",
  "transactional_authority",
]);

export const capabilityFreshnessClassV3Schema = z.enum([
  "stable",
  "bounded",
  "live",
]);

export const capabilityAuthorityClassV3Schema = z.enum([
  "general",
  "owner_authorized",
  "external_authoritative",
  "transactional",
]);

/**
 * Semantic capability metadata is part of the immutable definition. Empty
 * dimensions mean "not classified yet" and are deliberately accepted for
 * adapters publishing legacy definitions. They are not interpreted as a
 * positive capability claim and receive no semantic-retrieval credit.
 */
export const capabilitySemanticsV3Schema = z.object({
  operations: z.array(capabilityOperationV3Schema).max(16),
  evidenceClasses: z.array(capabilityEvidenceClassV3Schema).max(16),
  freshnessClasses: z.array(capabilityFreshnessClassV3Schema).max(8),
  authorityClasses: z.array(capabilityAuthorityClassV3Schema).max(8),
  domains: z.array(boundedText(160)).max(64),
  aliases: z.array(boundedText(160)).max(128),
}).strict();

export const EMPTY_CAPABILITY_SEMANTICS_V3 = Object.freeze({
  operations: [] as Array<z.infer<typeof capabilityOperationV3Schema>>,
  evidenceClasses: [] as Array<z.infer<typeof capabilityEvidenceClassV3Schema>>,
  freshnessClasses: [] as Array<z.infer<typeof capabilityFreshnessClassV3Schema>>,
  authorityClasses: [] as Array<z.infer<typeof capabilityAuthorityClassV3Schema>>,
  domains: [] as string[],
  aliases: [] as string[],
});

export const capabilitySemanticRequirementV3Schema = z.object({
  operations: z.array(capabilityOperationV3Schema).max(16).default([]),
  evidenceClasses: z.array(capabilityEvidenceClassV3Schema).max(16).default([]),
  freshnessClasses: z.array(capabilityFreshnessClassV3Schema).max(8).default([]),
  authorityClasses: z.array(capabilityAuthorityClassV3Schema).max(8).default([]),
}).strict();

export const capabilityDefinitionDraftV3Schema = z.object({
  key: capabilityKeySchema,
  version: boundedText(80),
  description: boundedText(2_000),
  executor: z.enum(["builtin", "knowledge", "mcp", "compute", "skill"]),
  inputSchema: jsonObjectSchema,
  outputSchema: jsonObjectSchema,
  effect: capabilityEffectV3Schema,
  idempotency: z.enum([
    "naturally_idempotent",
    "requires_key",
    "non_idempotent",
  ]),
  successContract: successContractV3Schema.optional(),
  supportedChannels: z.array(boundedText(80)).max(32),
  requiredIdentityScopes: z.array(boundedText(160)).max(64),
  requiredDataScopes: z.array(boundedText(160)).max(64),
  tags: z.array(boundedText(120)).max(64),
  semantics: capabilitySemanticsV3Schema.optional(),
  canonicalizationVersion: z.literal(CAPABILITY_CANONICALIZATION_VERSION_V3),
  mcpToolSchemaHash: hashSchema.optional(),
  bindingDefinitionHash: hashSchema.optional(),
}).strict().superRefine((definition, context) => {
  const hasMcpCoordinates = Boolean(
    definition.mcpToolSchemaHash || definition.bindingDefinitionHash,
  );
  if (definition.executor === "mcp") {
    if (!definition.mcpToolSchemaHash) {
      context.addIssue({
        code: "custom",
        path: ["mcpToolSchemaHash"],
        message: "An MCP capability requires the published tool schema hash.",
      });
    }
    if (!definition.bindingDefinitionHash) {
      context.addIssue({
        code: "custom",
        path: ["bindingDefinitionHash"],
        message: "An MCP capability requires the published binding definition hash.",
      });
    }
  } else if (hasMcpCoordinates) {
    context.addIssue({
      code: "custom",
      path: ["executor"],
      message: "Only an MCP capability may carry MCP schema or binding hashes.",
    });
  }
});

export const capabilityDefinitionV3Schema = capabilityDefinitionDraftV3Schema.safeExtend({
  semantics: capabilitySemanticsV3Schema,
  definitionHash: hashSchema,
}).strict().superRefine((definition, context) => {
  const { definitionHash, ...draft } = definition;
  if (definitionHash !== stableSha256(draft)) {
    context.addIssue({
      code: "custom",
      path: ["definitionHash"],
      message: "Capability definition hash does not match its canonical immutable definition.",
    });
  }
});

export const capabilityAvailabilityV3Schema = z.object({
  capabilityKey: capabilityKeySchema,
  capabilityVersion: boundedText(80),
  definitionHash: hashSchema,
  healthState: z.enum(["ready", "degraded", "unavailable"]),
  checkedAt: z.string().datetime({ offset: true }),
  credentialVersion: boundedText(160).optional(),
  runtimeRevision: boundedText(160).optional(),
  failureCode: z.string().trim().min(1).max(160)
    .regex(/^[a-z][a-z0-9_]*$/).optional(),
}).strict();

export const capabilityCatalogV3Schema = z.object({
  protocolVersion: z.literal(2),
  canonicalizationVersion: z.literal(CAPABILITY_CANONICALIZATION_VERSION_V3),
  capabilities: z.array(capabilityDefinitionV3Schema),
  catalogHash: hashSchema,
}).strict().superRefine((catalog, context) => {
  const sorted = [...catalog.capabilities].sort(compareCapabilityDefinitions);
  const seen = new Set<string>();
  for (const [index, definition] of catalog.capabilities.entries()) {
    const coordinate = capabilityCoordinate(definition.key, definition.version);
    if (seen.has(coordinate)) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", index],
        message: `Capability catalog contains duplicate coordinate ${coordinate}.`,
      });
    }
    seen.add(coordinate);
    if (
      definition.key !== sorted[index]?.key
      || definition.version !== sorted[index]?.version
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", index],
        message: "Capability catalog must use canonical key and version ordering.",
      });
    }
  }
  if (catalog.catalogHash !== stableSha256({
    canonicalizationVersion: catalog.canonicalizationVersion,
    capabilities: sorted,
  })) {
    context.addIssue({
      code: "custom",
      path: ["catalogHash"],
      message: "Capability catalog hash does not match its canonical definitions.",
    });
  }
});

export const capabilityAvailabilitySnapshotV3Schema = z.object({
  catalogHash: hashSchema,
  observedAt: z.string().datetime({ offset: true }),
  capabilities: z.array(capabilityAvailabilityV3Schema),
}).strict().superRefine((snapshot, context) => {
  const seen = new Set<string>();
  for (const [index, availability] of snapshot.capabilities.entries()) {
    const coordinate = capabilityCoordinate(
      availability.capabilityKey,
      availability.capabilityVersion,
    );
    if (seen.has(coordinate)) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", index],
        message: `Availability snapshot contains duplicate coordinate ${coordinate}.`,
      });
    }
    seen.add(coordinate);
  }
});

export const planScopeKeyV3Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("generation_turn"),
    conversationId: boundedText(200),
    inputMessageId: boundedText(200),
  }).strict(),
  z.object({
    kind: z.literal("delegation_task"),
    delegationTaskId: boundedText(200),
  }).strict(),
  z.object({
    kind: z.literal("collector"),
    conversationId: boundedText(200),
    collectorId: boundedText(200),
  }).strict(),
]);

export const evidenceRequirementV3Schema = z.object({
  kind: z.enum([
    "none",
    "authorized_knowledge",
    "knowledge_preferred",
    "capability_result",
    "current_external",
    "transactional_authority",
  ]),
  freshness: z.enum(["stable", "bounded", "live"]),
  allowedSourceKinds: z.array(boundedText(120)).max(32),
  citationRequired: z.boolean(),
  minimumEvidenceCount: z.number().int().min(0).max(100),
}).strict().superRefine((requirement, context) => {
  if (requirement.kind === "none") {
    if (requirement.citationRequired || requirement.minimumEvidenceCount !== 0) {
      context.addIssue({
        code: "custom",
        message: "An evidence-free goal cannot require citations or evidence items.",
      });
    }
  } else if (
    requirement.kind !== "knowledge_preferred"
    && requirement.minimumEvidenceCount < 1
  ) {
    context.addIssue({
      code: "custom",
      path: ["minimumEvidenceCount"],
      message: "An evidence-bound goal requires at least one evidence item.",
    });
  }
  if (
    (requirement.kind === "current_external"
      || requirement.kind === "transactional_authority")
    && requirement.freshness !== "live"
  ) {
    context.addIssue({
      code: "custom",
      path: ["freshness"],
      message: "External-current and transactional evidence must be live.",
    });
  }
});

export const actionResultStatusV3Schema = z.enum([
  "succeeded",
  "failed",
  "partial",
  "skipped",
  "canceled",
  "reconciliation_required",
]);

export const actionDependencyV3Schema = z.object({
  actionId: identifierSchema,
  allowedStatuses: z.array(actionResultStatusV3Schema).min(1).max(6),
  allowedFailureCodes: z.array(
    z.string().trim().min(1).max(160).regex(/^[a-z][a-z0-9_]*$/),
  ).max(32).optional(),
}).strict();

export const actionActivationV3Schema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("primary") }).strict(),
  z.object({
    mode: z.literal("on_failure"),
    sourceActionId: identifierSchema,
    allowedFailureCodes: z.array(
      z.string().trim().min(1).max(160).regex(/^[a-z][a-z0-9_]*$/),
    ).min(1).max(32),
    fallbackGroupKey: identifierSchema,
    priority: z.number().int().min(0).max(10_000),
  }).strict(),
]);

export const actionFailurePolicyV3Schema = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("stop"),
    publicMessageCode: boundedText(160),
  }).strict(),
  z.object({
    strategy: z.literal("clarify"),
    requiredFields: z.array(boundedText(200)).min(1).max(32),
  }).strict(),
  z.object({
    strategy: z.literal("handoff"),
    reasonCode: boundedText(160),
  }).strict(),
  z.object({
    strategy: z.literal("try_planned_alternatives"),
    alternativeActionIds: z.array(identifierSchema).min(1).max(16),
    terminalStrategy: z.enum(["stop", "clarify", "handoff"]),
  }).strict(),
]);

export const goalFailurePolicyV3Schema = z.object({
  strategy: z.enum(["stop", "clarify", "handoff", "continue_partial"]),
  reasonCode: boundedText(160),
}).strict();

/**
 * Evidence fallback is server-owned Plan policy. A Planner proposal may ask for
 * knowledge, but it cannot authorize replacing Owner evidence with model
 * knowledge. Missing policy therefore means `none` for persisted V3 plans.
 */
export const goalEvidenceFallbackPolicyV3Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({
    kind: z.literal("authorized_knowledge_miss_to_stable_general"),
    policySource: z.literal("server_planning_default"),
    activationStatuses: z.tuple([
      z.literal("not_found"),
      z.literal("unavailable"),
    ]),
    authorityBoundary: z.literal("non_owner_specific_stable_general"),
    disclosureRequired: z.literal(true),
  }).strict(),
  z.object({
    kind: z.literal("capability_unexecuted_to_stable_general"),
    policySource: z.literal("server_planning_default"),
    activationStatuses: z.array(z.enum([
      "planner_unavailable",
      "capability_unavailable",
      "compiler_unavailable",
      "entitlement_denied",
      "confirmed_not_sent",
    ])).min(1).max(5),
    authorityBoundary: z.literal("non_owner_specific_stable_general"),
    disclosureRequired: z.literal(true),
  }).strict(),
]);

export const goalSourceAuthorityBoundaryV3Schema = z.object({
  classification: z.enum([
    "stable_general_allowed",
    "owner_authority_required",
  ]),
  policySource: z.literal("server_authority_policy"),
  policyVersion: boundedText(160),
  reasonCodes: z.array(
    z.string().trim().min(1).max(160).regex(/^[a-z][a-z0-9_]*$/),
  ).min(1).max(32),
}).strict();

export const goalSourceSpanV3Schema = z.object({
  pointer: z.literal("/currentMessage/text"),
  startOffset: z.number().int().min(0).max(12_000),
  endOffset: z.number().int().min(1).max(12_000),
  quote: z.string().min(1).max(12_000),
}).strict().superRefine((span, context) => {
  if (span.endOffset <= span.startOffset) {
    context.addIssue({
      code: "custom",
      path: ["endOffset"],
      message: "Goal source span must have positive length.",
    });
  }
});

export const goalPlanV3Schema = z.object({
  id: identifierSchema,
  objective: boundedText(2_000),
  sourcePointers: z.array(z.string().min(1).max(1_000).regex(/^\//)).min(1).max(32),
  sourceSpan: goalSourceSpanV3Schema.optional(),
  strategy: z.enum(["general", "knowledge", "capability", "control"]),
  operation: capabilityOperationV3Schema,
  semanticConfidence: z.number().min(0).max(1),
  generalEligibility: z.enum(["allowed", "not_allowed", "uncertain"]),
  actionIds: z.array(identifierSchema).max(32),
  deliverableIds: z.array(identifierSchema).max(32),
  evidenceRequirement: evidenceRequirementV3Schema,
  // Optional only for replay compatibility. Runtime interpretation is
  // fail-closed: an absent policy is identical to { kind: "none" }.
  evidenceFallbackPolicy: goalEvidenceFallbackPolicyV3Schema.optional(),
  // Optional only for replay compatibility. Missing boundary never grants a
  // stable-general fallback.
  sourceAuthorityBoundary: goalSourceAuthorityBoundaryV3Schema.optional(),
  failurePolicy: goalFailurePolicyV3Schema,
}).strict();

export const planActionV3Schema = z.object({
  id: identifierSchema,
  capability: z.object({
    key: capabilityKeySchema,
    version: boundedText(80),
    definitionHash: hashSchema,
  }).strict(),
  arguments: jsonObjectSchema,
  argumentProvenance: z.record(z.string(), planArgumentProvenanceSchema),
  dependencies: z.array(actionDependencyV3Schema).max(32),
  activation: actionActivationV3Schema,
  expectedOutputSchema: jsonObjectSchema,
  completionCriteria: z.array(boundedText(1_000)).min(1).max(32),
  failurePolicy: actionFailurePolicyV3Schema,
}).strict();

export const planDeliverableV3Schema = z.object({
  id: identifierSchema,
  kind: z.enum([
    "message",
    "artifact",
    "public_material",
    "service_request",
    "external_result",
  ]),
  format: z.string().trim().max(120).nullable(),
  producedByActionIds: z.array(identifierSchema).max(32),
  completionCriteria: z.array(boundedText(1_000)).min(1).max(32),
}).strict();

export const turnPlanV3Schema = z.object({
  protocolVersion: z.literal(3),
  planId: boundedText(240),
  scopeKey: planScopeKeyV3Schema,
  revision: z.number().int().positive(),
  envelopeHash: hashSchema,
  capabilityCatalogHash: hashSchema,
  capabilityCandidateSnapshotHash: hashSchema.optional(),
  validationPolicyVersion: boundedText(80),
  objective: boundedText(2_000),
  goals: z.array(goalPlanV3Schema).min(1).max(32),
  actions: z.array(planActionV3Schema).max(64),
  deliverables: z.array(planDeliverableV3Schema).max(32),
  decisionTrace: z.array(
    z.string().trim().min(1).max(160).regex(/^[a-z][a-z0-9_]*$/),
  ).max(64),
}).strict();

export type CapabilityEffectV3 = z.infer<typeof capabilityEffectV3Schema>;

/**
 * Effect ceilings form a partial order, not a string/ordinal enum. Internal
 * writes and external effects are intentionally incomparable, and an unknown
 * external write is never covered by an earlier approval.
 */
export function isEffectWithinApprovalCeiling(
  requested: CapabilityEffectV3,
  approvedMaximum: CapabilityEffectV3,
) {
  const requestedEffect = capabilityEffectV3Schema.parse(requested);
  const ceiling = capabilityEffectV3Schema.parse(approvedMaximum);
  if (
    requestedEffect.boundary === "external"
    && requestedEffect.mutation === "write"
    && requestedEffect.reversibility === "unknown"
  ) {
    return false;
  }
  if (requestedEffect.boundary !== ceiling.boundary) return false;
  if (requestedEffect.boundary === "internal") {
    return requestedEffect.mutation === "none"
      || ceiling.mutation === "write";
  }
  if (requestedEffect.mutation === "none") return true;
  if (ceiling.mutation !== "write" || ceiling.reversibility === "unknown") {
    return false;
  }
  if (requestedEffect.reversibility === "reversible") {
    return ceiling.reversibility === "reversible"
      || ceiling.reversibility === "irreversible";
  }
  return requestedEffect.reversibility === "irreversible"
    && ceiling.reversibility === "irreversible";
}
export type SuccessContractV3 = z.infer<typeof successContractV3Schema>;
export type CapabilityOperationV3 = z.infer<typeof capabilityOperationV3Schema>;
export type CapabilityEvidenceClassV3 = z.infer<typeof capabilityEvidenceClassV3Schema>;
export type CapabilityFreshnessClassV3 = z.infer<typeof capabilityFreshnessClassV3Schema>;
export type CapabilityAuthorityClassV3 = z.infer<typeof capabilityAuthorityClassV3Schema>;
export type CapabilitySemanticsV3 = z.infer<typeof capabilitySemanticsV3Schema>;
export type CapabilitySemanticRequirementV3 = z.infer<
  typeof capabilitySemanticRequirementV3Schema
>;
export type CapabilityDefinitionDraftV3 = z.infer<typeof capabilityDefinitionDraftV3Schema>;
export type CapabilityDefinitionV3 = z.infer<typeof capabilityDefinitionV3Schema>;
export type CapabilityAvailabilityV3 = z.infer<typeof capabilityAvailabilityV3Schema>;
export type CapabilityCatalogV3 = z.infer<typeof capabilityCatalogV3Schema>;
export type CapabilityAvailabilitySnapshotV3 = z.infer<typeof capabilityAvailabilitySnapshotV3Schema>;
export type PlanScopeKeyV3 = z.infer<typeof planScopeKeyV3Schema>;
export type EvidenceRequirementV3 = z.infer<typeof evidenceRequirementV3Schema>;
export type PlanActionV3 = z.infer<typeof planActionV3Schema>;
export type TurnPlanV3 = z.infer<typeof turnPlanV3Schema>;

export type TurnPlanV3ValidationIssue = {
  code:
    | "schema_invalid"
    | "plan_id_mismatch"
    | "catalog_hash_mismatch"
    | "candidate_snapshot_hash_mismatch"
    | "id_duplicate"
    | "reference_unknown"
    | "action_unowned"
    | "capability_unknown"
    | "capability_definition_mismatch"
    | "capability_channel_unsupported"
    | "identity_scope_missing"
    | "data_scope_missing"
    | "arguments_invalid"
    | "output_schema_mismatch"
    | "dependency_cycle"
    | "activation_invalid"
    | "failure_policy_invalid"
    | "goal_source_invalid"
    | "provenance_invalid"
    | "composer_invalid"
    | "turn_constraint_invalid"
    | "evidence_unsatisfied";
  path: string;
  message: string;
};

export type TurnPlanV3ValidationResult =
  | { ok: true; plan: TurnPlanV3 }
  | { ok: false; issues: TurnPlanV3ValidationIssue[] };

export type CapabilitySemanticsCompatibilityV3 = {
  compatible: boolean;
  mismatches: Array<
    "operations" | "evidenceClasses" | "freshnessClasses" | "authorityClasses"
  >;
  unclassified: Array<
    "operations" | "evidenceClasses" | "freshnessClasses" | "authorityClasses"
  >;
};

/**
 * Performs generic contract compatibility only. An unclassified legacy
 * dimension is allowed through for backwards compatibility, but is surfaced
 * so callers can rank it below an explicitly compatible definition.
 */
export function evaluateCapabilitySemanticsCompatibilityV3(
  semanticsInput: CapabilitySemanticsV3,
  requirementInput: Partial<CapabilitySemanticRequirementV3>,
): CapabilitySemanticsCompatibilityV3 {
  const semantics = capabilitySemanticsV3Schema.parse(semanticsInput);
  const requirement = capabilitySemanticRequirementV3Schema.parse(requirementInput);
  const mismatches: CapabilitySemanticsCompatibilityV3["mismatches"] = [];
  const unclassified: CapabilitySemanticsCompatibilityV3["unclassified"] = [];
  const check = (
    dimension: CapabilitySemanticsCompatibilityV3["mismatches"][number],
    declared: string[],
    required: string[],
    satisfies: (declaredValue: string, requiredValue: string) => boolean,
  ) => {
    if (!required.length) return;
    if (!declared.length) {
      unclassified.push(dimension);
      if (requiresExplicitCapabilitySemanticsV3(dimension, required)) {
        mismatches.push(dimension);
      }
      return;
    }
    if (!declared.some((declaredValue) =>
      required.some((requiredValue) => satisfies(declaredValue, requiredValue)))) {
      mismatches.push(dimension);
    }
  };
  check(
    "operations",
    semantics.operations,
    requirement.operations,
    (declared, required) => declared === required,
  );
  check(
    "evidenceClasses",
    semantics.evidenceClasses,
    requirement.evidenceClasses,
    (declared, required) => declared === required,
  );
  check(
    "freshnessClasses",
    semantics.freshnessClasses,
    requirement.freshnessClasses,
    freshnessClassSatisfies,
  );
  check(
    "authorityClasses",
    semantics.authorityClasses,
    requirement.authorityClasses,
    authorityClassSatisfies,
  );
  return {
    compatible: mismatches.length === 0,
    mismatches,
    unclassified,
  };
}

function requiresExplicitCapabilitySemanticsV3(
  dimension: CapabilitySemanticsCompatibilityV3["mismatches"][number],
  required: string[],
) {
  if (dimension === "operations") {
    return required.some((value) =>
      value === "create"
      || value === "mutate"
      || value === "deliver"
      || value === "control");
  }
  if (dimension === "evidenceClasses") {
    return required.some((value) =>
      value === "authorized_knowledge"
      || value === "current_external"
      || value === "transactional_authority");
  }
  if (dimension === "freshnessClasses") return required.includes("live");
  return required.some((value) => value !== "general");
}

export function registerCapabilityDefinitionV3(
  input: CapabilityDefinitionDraftV3,
): CapabilityDefinitionV3 {
  const draft = capabilityDefinitionDraftV3Schema.parse({
    ...input,
    supportedChannels: normalizeStringSet(input.supportedChannels),
    requiredIdentityScopes: normalizeStringSet(input.requiredIdentityScopes),
    requiredDataScopes: normalizeStringSet(input.requiredDataScopes),
    tags: normalizeStringSet(input.tags),
    semantics: normalizeCapabilitySemanticsV3(
      input.semantics ?? EMPTY_CAPABILITY_SEMANTICS_V3,
    ),
  });
  assertSupportedCapabilitySchema(draft.inputSchema, `${draft.key} input`, true);
  assertSupportedCapabilitySchema(draft.outputSchema, `${draft.key} output`, false);
  if (draft.successContract?.kind === "success_schema") {
    assertSupportedCapabilitySchema(
      draft.successContract.schema,
      `${draft.key} success`,
      false,
    );
  }
  const definitionBytes = canonicalByteLengthV3(draft);
  if (definitionBytes > MAX_CAPABILITY_DEFINITION_BYTES_V3) {
    throw new Error(
      `Capability ${draft.key} definition exceeds ${MAX_CAPABILITY_DEFINITION_BYTES_V3} bytes.`,
    );
  }
  return capabilityDefinitionV3Schema.parse({
    ...draft,
    definitionHash: stableSha256(draft),
  });
}

export function buildCapabilityCatalogV3(
  inputs: Array<CapabilityDefinitionDraftV3 | CapabilityDefinitionV3>,
): CapabilityCatalogV3 {
  const capabilities = inputs.map((input) =>
    "definitionHash" in input
      ? capabilityDefinitionV3Schema.parse(input)
      : registerCapabilityDefinitionV3(input))
    .sort(compareCapabilityDefinitions);
  const coordinates = new Set<string>();
  for (const definition of capabilities) {
    const coordinate = capabilityCoordinate(definition.key, definition.version);
    if (coordinates.has(coordinate)) {
      throw new Error(`Capability catalog contains duplicate coordinate ${coordinate}.`);
    }
    coordinates.add(coordinate);
  }
  const canonicalizationVersion = CAPABILITY_CANONICALIZATION_VERSION_V3;
  const catalogBytes = canonicalByteLengthV3({ canonicalizationVersion, capabilities });
  if (catalogBytes > MAX_CAPABILITY_CATALOG_BYTES_V3) {
    throw new Error(
      `Capability catalog exceeds ${MAX_CAPABILITY_CATALOG_BYTES_V3} bytes.`,
    );
  }
  return capabilityCatalogV3Schema.parse({
    protocolVersion: 2,
    canonicalizationVersion,
    capabilities,
    catalogHash: stableSha256({ canonicalizationVersion, capabilities }),
  });
}

export function buildCapabilityAvailabilitySnapshotV3(input: {
  catalog: CapabilityCatalogV3;
  observedAt: string;
  capabilities: CapabilityAvailabilityV3[];
}): CapabilityAvailabilitySnapshotV3 {
  const definitionByCoordinate = new Map(
    input.catalog.capabilities.map((definition) => [
      capabilityCoordinate(definition.key, definition.version),
      definition,
    ]),
  );
  for (const availability of input.capabilities) {
    const definition = definitionByCoordinate.get(capabilityCoordinate(
      availability.capabilityKey,
      availability.capabilityVersion,
    ));
    if (!definition || definition.definitionHash !== availability.definitionHash) {
      throw new Error(
        `Availability references an unknown or changed capability ${availability.capabilityKey}@${availability.capabilityVersion}.`,
      );
    }
  }
  return capabilityAvailabilitySnapshotV3Schema.parse({
    catalogHash: input.catalog.catalogHash,
    observedAt: input.observedAt,
    capabilities: [...input.capabilities].sort((left, right) =>
      compareCanonicalText(
        capabilityCoordinate(left.capabilityKey, left.capabilityVersion),
        capabilityCoordinate(right.capabilityKey, right.capabilityVersion),
      )),
  });
}

export function validateTurnPlanV3(input: {
  plan: unknown;
  catalog: CapabilityCatalogV3;
  envelope?: TurnEnvelope;
  expectedPlanId?: string;
  expectedCandidateSnapshotHash?: string;
}): TurnPlanV3ValidationResult {
  const parsed = turnPlanV3Schema.safeParse(input.plan);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "schema_invalid" as const,
        path: jsonPath(issue.path),
        message: issue.message,
      })),
    };
  }
  const plan = parsed.data;
  const issues: TurnPlanV3ValidationIssue[] = [];
  if (input.expectedPlanId && plan.planId !== input.expectedPlanId) {
    issues.push({
      code: "plan_id_mismatch",
      path: "/planId",
      message: "Planner changed the server-assigned plan id.",
    });
  }
  if (plan.capabilityCatalogHash !== input.catalog.catalogHash) {
    issues.push({
      code: "catalog_hash_mismatch",
      path: "/capabilityCatalogHash",
      message: "Plan capability catalog hash does not match the fixed catalog.",
    });
  }
  if (
    input.expectedCandidateSnapshotHash
    && plan.capabilityCandidateSnapshotHash !== input.expectedCandidateSnapshotHash
  ) {
    issues.push({
      code: "candidate_snapshot_hash_mismatch",
      path: "/capabilityCandidateSnapshotHash",
      message: "Plan candidate snapshot hash does not match the fixed discovery snapshot.",
    });
  }

  reportDuplicateIds(plan.goals.map((goal) => goal.id), "/goals", issues);
  reportDuplicateIds(plan.actions.map((action) => action.id), "/actions", issues);
  reportDuplicateIds(
    plan.deliverables.map((deliverable) => deliverable.id),
    "/deliverables",
    issues,
  );

  const actionById = new Map(plan.actions.map((action) => [action.id, action]));
  const deliverableIds = new Set(plan.deliverables.map((deliverable) => deliverable.id));
  const capabilityByCoordinate = new Map(
    input.catalog.capabilities.map((definition) => [
      capabilityCoordinate(definition.key, definition.version),
      definition,
    ]),
  );
  if (input.envelope) {
    const toolPolicy = input.envelope.turnConstraints.toolPolicy;
    const nonComposerActions = plan.actions.filter((action) =>
      action.capability.key !== "response.compose");
    const publishedNonComposerActions = nonComposerActions.filter((action) =>
      capabilityByCoordinate.has(capabilityCoordinate(
        action.capability.key,
        action.capability.version,
      )));
    if (
      (toolPolicy === "forbidden" || toolPolicy === "conflict")
      && nonComposerActions.length > 0
    ) {
      issues.push({
        code: "turn_constraint_invalid",
        path: "/actions",
        message: `Turn tool policy ${toolPolicy} does not permit non-composer capability actions.`,
      });
    }
    if (
      toolPolicy === "required"
      && publishedNonComposerActions.length === 0
      && plan.goals.some((goal) => goal.strategy !== "control")
    ) {
      issues.push({
        code: "turn_constraint_invalid",
        path: "/actions",
        message: "Turn tool policy required needs at least one published non-composer capability action.",
      });
    }
    if (
      toolPolicy === "conflict"
      && plan.goals.some((goal) => goal.strategy !== "control")
    ) {
      issues.push({
        code: "turn_constraint_invalid",
        path: "/goals",
        message: "Conflicting tool instructions require a control goal before any execution.",
      });
    }
  }
  if (input.catalog.capabilities.some((definition) =>
    definition.key === "response.compose")) {
    const composers = plan.actions.filter((action) =>
      action.capability.key === "response.compose");
    if (composers.length !== 1) {
      issues.push({
        code: "composer_invalid",
        path: "/actions",
        message: "A V3 turn with response.compose available must contain exactly one composer action.",
      });
    } else {
      const composer = composers[0]!;
      const dependencies = new Set(
        composer.dependencies.map((dependency) => dependency.actionId),
      );
      if (composer.activation.mode !== "primary") {
        issues.push({
          code: "composer_invalid",
          path: `/actions/${plan.actions.indexOf(composer)}/activation`,
          message: "response.compose must be a primary action.",
        });
      }
      for (const source of plan.actions.filter((action) =>
        action.id !== composer.id && action.activation.mode === "primary")) {
        if (!dependencies.has(source.id)) {
          issues.push({
            code: "composer_invalid",
            path: `/actions/${plan.actions.indexOf(composer)}/dependencies`,
            message: `response.compose must depend on primary action ${source.id}.`,
          });
        }
      }
    }
  }

  const seenGoalSpanCoordinates = new Set<string>();
  const resolvedGoalSpans: Array<{ startOffset: number; endOffset: number }> = [];
  for (const [goalIndex, goal] of plan.goals.entries()) {
    if (
      plan.goals.length > 1
      && !goal.sourceSpan
    ) {
      issues.push({
        code: "goal_source_invalid",
        path: `/goals/${goalIndex}/sourceSpan`,
        message: "Every non-control Goal in a multi-Goal Plan requires an exact current-message source span.",
      });
    }
    if (goal.sourceSpan && input.envelope) {
      const currentText = input.envelope.currentMessage.text;
      if (
        currentText.slice(
          goal.sourceSpan.startOffset,
          goal.sourceSpan.endOffset,
        ) !== goal.sourceSpan.quote
      ) {
        issues.push({
          code: "goal_source_invalid",
          path: `/goals/${goalIndex}/sourceSpan`,
          message: "Goal source span does not resolve to its exact current-message quote.",
        });
      }
    }
    if (goal.sourceSpan) {
      const coordinate = `${goal.sourceSpan.startOffset}:${goal.sourceSpan.endOffset}`;
      if (plan.goals.length > 1 && seenGoalSpanCoordinates.has(coordinate)) {
        issues.push({
          code: "goal_source_invalid",
          path: `/goals/${goalIndex}/sourceSpan`,
          message: "Independent Goals cannot reuse the same current-message source span.",
        });
      }
      seenGoalSpanCoordinates.add(coordinate);
      resolvedGoalSpans.push(goal.sourceSpan);
    }
    if (
      goal.evidenceFallbackPolicy?.kind
        === "authorized_knowledge_miss_to_stable_general"
      && (
        goal.evidenceRequirement.kind !== "knowledge_preferred"
        || goal.evidenceRequirement.freshness === "live"
        || goal.generalEligibility !== "allowed"
        || (goal.operation !== "answer" && goal.operation !== "explain")
        || goal.sourceAuthorityBoundary?.classification
          !== "stable_general_allowed"
      )
    ) {
      issues.push({
        code: "evidence_unsatisfied",
        path: `/goals/${goalIndex}/evidenceFallbackPolicy`,
        message: "Stable-general fallback is valid only for a server-authorized, non-live knowledge-preferred answer/explain goal.",
      });
    }
    if (
      goal.evidenceFallbackPolicy?.kind
        === "capability_unexecuted_to_stable_general"
      && (
        (goal.evidenceRequirement.kind !== "capability_result"
          && goal.evidenceRequirement.kind !== "current_external")
        || goal.generalEligibility !== "not_allowed"
        || (goal.operation !== "answer"
          && goal.operation !== "explain"
          && goal.operation !== "read"
          && goal.operation !== "search")
        || goal.sourceAuthorityBoundary?.classification
          !== "stable_general_allowed"
      )
    ) {
      issues.push({
        code: "evidence_unsatisfied",
        path: `/goals/${goalIndex}/evidenceFallbackPolicy`,
        message: "Capability fallback is valid only for a server-authorized, non-transactional public answer whose tool has not executed.",
      });
    }
    if (
      goal.generalEligibility === "uncertain"
      && (goal.strategy !== "control" || goal.operation !== "control")
    ) {
      issues.push({
        code: "evidence_unsatisfied",
        path: `/goals/${goalIndex}/generalEligibility`,
        message: "Uncertain general eligibility requires a control clarification goal.",
      });
    }
    if (
      goal.strategy === "general"
      && (
        goal.generalEligibility !== "allowed"
        || goal.semanticConfidence < MIN_GENERAL_SEMANTIC_CONFIDENCE_V3
        || (goal.operation !== "answer" && goal.operation !== "explain")
        || goal.evidenceRequirement.kind !== "none"
        || goal.evidenceRequirement.freshness !== "stable"
      )
    ) {
      issues.push({
        code: "evidence_unsatisfied",
        path: `/goals/${goalIndex}`,
        message: "General strategy does not satisfy the stable high-confidence eligibility contract.",
      });
    }
    if (input.envelope) {
      for (const [pointerIndex, pointer] of goal.sourcePointers.entries()) {
        if (typeof resolveJsonPointer(input.envelope, parseJsonPointer(pointer)) === "undefined") {
          issues.push({
            code: "goal_source_invalid",
            path: `/goals/${goalIndex}/sourcePointers/${pointerIndex}`,
            message: "Goal source pointer does not resolve in the supplied turn envelope.",
          });
        }
      }
    }
    for (const actionId of goal.actionIds) {
      if (!actionById.has(actionId)) {
        issues.push({
          code: "reference_unknown",
          path: `/goals/${goalIndex}/actionIds`,
          message: `Goal references unknown action ${actionId}.`,
        });
      }
    }
    for (const deliverableId of goal.deliverableIds) {
      if (!deliverableIds.has(deliverableId)) {
        issues.push({
          code: "reference_unknown",
          path: `/goals/${goalIndex}/deliverableIds`,
          message: `Goal references unknown deliverable ${deliverableId}.`,
        });
      }
    }
    const evidenceDefinitions = goal.actionIds.flatMap((actionId) => {
      const action = actionById.get(actionId);
      if (!action || action.capability.key === "response.compose") return [];
      const definition = capabilityByCoordinate.get(capabilityCoordinate(
        action.capability.key,
        action.capability.version,
      ));
      return definition ? [definition] : [];
    });
    const semanticRequirement = semanticRequirementForGoalPlanV3(goal);
    const evidenceSatisfied = goal.evidenceRequirement.kind === "none"
      || evidenceDefinitions.some((definition) =>
        evaluateCapabilitySemanticsCompatibilityV3(
          definition.semantics,
          semanticRequirement,
        ).compatible);
    if (!evidenceSatisfied) {
      issues.push({
        code: "evidence_unsatisfied",
        path: `/goals/${goalIndex}/evidenceRequirement`,
        message: `Goal evidence requirement ${goal.evidenceRequirement.kind} has no compatible evidence-producing action.`,
      });
    }
    for (const actionId of goal.actionIds) {
      const action = actionById.get(actionId);
      if (!action || action.capability.key === "response.compose") continue;
      const definition = capabilityByCoordinate.get(capabilityCoordinate(
        action.capability.key,
        action.capability.version,
      ));
      if (
        definition?.semantics.operations.length
        && !definition.semantics.operations.includes(goal.operation)
      ) {
        issues.push({
          code: "evidence_unsatisfied",
          path: `/goals/${goalIndex}/operation`,
          message: `Goal operation ${goal.operation} is not supported by action ${actionId}.`,
        });
      }
    }
  }

  if (
    input.envelope
    && plan.goals.length > 1
    && hasUncoveredGoalSourceText(
      input.envelope.currentMessage.text,
      resolvedGoalSpans,
    )
  ) {
    issues.push({
      code: "goal_source_invalid",
      path: "/goals",
      message: "Multi-Goal source spans must cover the substantive current-message text.",
    });
  }

  const goalOwnedActionIds = new Set(plan.goals.flatMap((goal) => goal.actionIds));
  for (const [actionIndex, action] of plan.actions.entries()) {
    if (
      action.capability.key !== "response.compose"
      && !goalOwnedActionIds.has(action.id)
    ) {
      issues.push({
        code: "action_unowned",
        path: `/actions/${actionIndex}`,
        message: `Non-composer action ${action.id} is not owned by any goal.`,
      });
    }
  }

  for (const [actionIndex, action] of plan.actions.entries()) {
    const path = `/actions/${actionIndex}`;
    const definition = capabilityByCoordinate.get(capabilityCoordinate(
      action.capability.key,
      action.capability.version,
    ));
    if (!definition) {
      issues.push({
        code: "capability_unknown",
        path: `${path}/capability`,
        message: "Action references a capability outside the fixed catalog.",
      });
    } else {
      if (definition.definitionHash !== action.capability.definitionHash) {
        issues.push({
          code: "capability_definition_mismatch",
          path: `${path}/capability/definitionHash`,
          message: "Action capability definition hash does not match the catalog.",
        });
      }
      if (input.envelope) {
        if (!definition.supportedChannels.includes(input.envelope.channel.kind)) {
          issues.push({
            code: "capability_channel_unsupported",
            path: `${path}/capability`,
            message: `Capability is not supported on channel ${input.envelope.channel.kind}.`,
          });
        }
        for (const scope of definition.requiredIdentityScopes) {
          if (!input.envelope.authority?.identityScopes.includes(scope)) {
            issues.push({
              code: "identity_scope_missing",
              path: `${path}/capability`,
              message: `Capability requires missing identity scope ${scope}.`,
            });
          }
        }
        for (const scope of definition.requiredDataScopes) {
          if (!input.envelope.authority?.dataScopes.includes(scope)) {
            issues.push({
              code: "data_scope_missing",
              path: `${path}/capability`,
              message: `Capability requires missing data scope ${scope}.`,
            });
          }
        }
      }
      if (canonicalJson(definition.outputSchema) !== canonicalJson(action.expectedOutputSchema)) {
        issues.push({
          code: "output_schema_mismatch",
          path: `${path}/expectedOutputSchema`,
          message: "Expected output schema must equal the immutable capability output schema.",
        });
      }
      for (const problem of validateJsonSchemaValue(
        action.arguments,
        definition.inputSchema,
        `${path}/arguments`,
      )) {
        issues.push({ code: "arguments_invalid", ...problem });
      }
    }

    for (const dependency of action.dependencies) {
      if (!actionById.has(dependency.actionId)) {
        issues.push({
          code: "reference_unknown",
          path: `${path}/dependencies`,
          message: `Action references unknown dependency ${dependency.actionId}.`,
        });
      }
      if (
        definition?.effect.boundary === "external"
        && definition.effect.mutation === "write"
        && dependency.allowedStatuses.some((status) => status !== "succeeded")
      ) {
        issues.push({
          code: "failure_policy_invalid",
          path: `${path}/dependencies`,
          message: "An external write may proceed only after successful dependencies.",
        });
      }
      if (dependency.actionId === action.id) {
        issues.push({
          code: "dependency_cycle",
          path: `${path}/dependencies`,
          message: "Action cannot depend on itself.",
        });
      }
    }

    if (action.activation.mode === "on_failure") {
      const source = actionById.get(action.activation.sourceActionId);
      if (!source || source.id === action.id) {
        issues.push({
          code: "activation_invalid",
          path: `${path}/activation/sourceActionId`,
          message: "Failure activation must reference another action in the plan.",
        });
      } else if (
        source.failurePolicy.strategy !== "try_planned_alternatives"
        || !source.failurePolicy.alternativeActionIds.includes(action.id)
      ) {
        issues.push({
          code: "activation_invalid",
          path: `${path}/activation`,
          message: "A fallback action must be explicitly listed by its source Action failure policy.",
        });
      }
    }
    if (action.failurePolicy.strategy === "try_planned_alternatives") {
      for (const alternativeActionId of action.failurePolicy.alternativeActionIds) {
        const alternative = actionById.get(alternativeActionId);
        if (
          !alternative
          || alternative.id === action.id
          || alternative.activation.mode !== "on_failure"
          || alternative.activation.sourceActionId !== action.id
        ) {
          issues.push({
            code: "failure_policy_invalid",
            path: `${path}/failurePolicy/alternativeActionIds`,
            message: `Alternative ${alternativeActionId} must be an on-failure action sourced from ${action.id}.`,
          });
        }
      }
    }
    validateProvenance({
      action,
      actionIndex,
      actionById,
      ...(input.envelope ? { envelope: input.envelope } : {}),
      issues,
    });
  }

  const fallbackPriorities = new Map<string, Map<number, string>>();
  for (const [actionIndex, action] of plan.actions.entries()) {
    if (action.activation.mode !== "on_failure") continue;
    const groupCoordinate = [
      action.activation.sourceActionId,
      action.activation.fallbackGroupKey,
    ].join(":");
    const priorities = fallbackPriorities.get(groupCoordinate) ?? new Map();
    const existing = priorities.get(action.activation.priority);
    if (existing) {
      issues.push({
        code: "activation_invalid",
        path: `/actions/${actionIndex}/activation/priority`,
        message: `Fallback priority duplicates ${existing} in group ${action.activation.fallbackGroupKey}.`,
      });
    } else {
      priorities.set(action.activation.priority, action.id);
      fallbackPriorities.set(groupCoordinate, priorities);
    }
  }

  for (const [deliverableIndex, deliverable] of plan.deliverables.entries()) {
    for (const actionId of deliverable.producedByActionIds) {
      if (!actionById.has(actionId)) {
        issues.push({
          code: "reference_unknown",
          path: `/deliverables/${deliverableIndex}/producedByActionIds`,
          message: `Deliverable references unknown action ${actionId}.`,
        });
      }
    }
  }

  if (containsDependencyCycleV3(plan.actions)) {
    issues.push({
      code: "dependency_cycle",
      path: "/actions",
      message: "Plan action dependencies and failure activations must be acyclic.",
    });
  }
  return issues.length ? { ok: false, issues } : { ok: true, plan };
}

function validateProvenance(input: {
  action: PlanActionV3;
  actionIndex: number;
  actionById: Map<string, PlanActionV3>;
  envelope?: TurnEnvelope;
  issues: TurnPlanV3ValidationIssue[];
}) {
  const path = `/actions/${input.actionIndex}/argumentProvenance`;
  const argumentKeys = Object.keys(input.action.arguments);
  const provenanceKeys = Object.keys(input.action.argumentProvenance);
  for (const argumentKey of argumentKeys) {
    if (!(argumentKey in input.action.argumentProvenance)) {
      input.issues.push({
        code: "provenance_invalid",
        path: `${path}/${escapeJsonPointer(argumentKey)}`,
        message: `Argument ${argumentKey} has no provenance.`,
      });
    }
  }
  for (const provenanceKey of provenanceKeys) {
    if (!(provenanceKey in input.action.arguments)) {
      input.issues.push({
        code: "provenance_invalid",
        path: `${path}/${escapeJsonPointer(provenanceKey)}`,
        message: `Provenance ${provenanceKey} does not correspond to an argument.`,
      });
      continue;
    }
    const provenance = input.action.argumentProvenance[provenanceKey];
    if (!provenance) continue;
    if (provenance.source === "previous_action_output") {
      const segments = parseJsonPointer(provenance.pointer);
      const sourceActionId = segments[0] === "actions" ? segments[1] : undefined;
      if (
        !sourceActionId
        || segments[2] !== "output"
        || !input.actionById.has(sourceActionId)
        || !input.action.dependencies.some((dependency) =>
          dependency.actionId === sourceActionId)
      ) {
        input.issues.push({
          code: "provenance_invalid",
          path: `${path}/${escapeJsonPointer(provenanceKey)}`,
          message: "Previous-action provenance must reference a declared dependency output.",
        });
      }
      continue;
    }
    if (!input.envelope) continue;
    const allowedRoots = {
      user_message: ["currentMessage"],
      attachment: ["attachments"],
      trusted_context: ["conversationSummary", "authorizedContext"],
      server_state: [
        "activeCollector",
        "activeTask",
        "pendingApproval",
        "activeHandoff",
        "actorIdentity",
        "authority",
        "channel",
        "representativeVersion",
        "serviceState",
        "planningDefaults",
      ],
    } as const;
    const segments = parseJsonPointer(provenance.pointer);
    const root = segments[0];
    if (!root || !(allowedRoots[provenance.source] as readonly string[]).includes(root)) {
      input.issues.push({
        code: "provenance_invalid",
        path: `${path}/${escapeJsonPointer(provenanceKey)}`,
        message: `Pointer is outside the allowed ${provenance.source} context.`,
      });
      continue;
    }
    const resolved = resolveJsonPointer(input.envelope, segments);
    if (typeof resolved === "undefined") {
      input.issues.push({
        code: "provenance_invalid",
        path: `${path}/${escapeJsonPointer(provenanceKey)}`,
        message: "Pointer does not resolve in the supplied turn envelope.",
      });
      continue;
    }
    if (
      provenance.source === "user_message"
      && (
        provenance.pointer !== "/currentMessage/text"
        || !isDirectUserMessageArgumentGrounded(
          input.action.arguments[provenanceKey],
          resolved,
        )
      )
    ) {
      input.issues.push({
        code: "provenance_invalid",
        path: `${path}/${escapeJsonPointer(provenanceKey)}`,
        message: "User-message provenance must be directly grounded in the current message text.",
      });
    }
    if (
      provenance.source === "server_state"
      && canonicalJson(input.action.arguments[provenanceKey]) !== canonicalJson(resolved)
    ) {
      input.issues.push({
        code: "provenance_invalid",
        path: `${path}/${escapeJsonPointer(provenanceKey)}`,
        message: "Server-state provenance must equal the cited authoritative value.",
      });
    }
  }
}

function containsDependencyCycleV3(actions: PlanActionV3[]) {
  const edges = new Map(actions.map((action) => [
    action.id,
    [
      ...action.dependencies.map((dependency) => dependency.actionId),
      ...(action.activation.mode === "on_failure"
        ? [action.activation.sourceActionId]
        : []),
    ],
  ]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (actionId: string): boolean => {
    if (visiting.has(actionId)) return true;
    if (visited.has(actionId)) return false;
    visiting.add(actionId);
    for (const dependencyId of edges.get(actionId) ?? []) {
      if (edges.has(dependencyId) && visit(dependencyId)) return true;
    }
    visiting.delete(actionId);
    visited.add(actionId);
    return false;
  };
  return actions.some((action) => visit(action.id));
}

function reportDuplicateIds(
  ids: string[],
  path: string,
  issues: TurnPlanV3ValidationIssue[],
) {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      issues.push({
        code: "id_duplicate",
        path: `${path}/${index}/id`,
        message: `Duplicate id ${id}.`,
      });
    }
    seen.add(id);
  });
}

function compareCapabilityDefinitions(
  left: Pick<CapabilityDefinitionV3, "key" | "version">,
  right: Pick<CapabilityDefinitionV3, "key" | "version">,
) {
  return compareCanonicalText(left.key, right.key)
    || compareCanonicalText(left.version, right.version);
}

function capabilityCoordinate(key: string, version: string) {
  return `${key}@${version}`;
}

function normalizeCapabilitySemanticsV3(
  semantics: CapabilitySemanticsV3,
): CapabilitySemanticsV3 {
  return capabilitySemanticsV3Schema.parse({
    operations: normalizeStringSet(semantics.operations),
    evidenceClasses: normalizeStringSet(semantics.evidenceClasses),
    freshnessClasses: normalizeStringSet(semantics.freshnessClasses),
    authorityClasses: normalizeStringSet(semantics.authorityClasses),
    domains: normalizeSemanticTextSet(semantics.domains),
    aliases: normalizeSemanticTextSet(semantics.aliases),
  });
}

function freshnessClassSatisfies(declared: string, required: string) {
  const rank: Record<string, number> = { stable: 0, bounded: 1, live: 2 };
  return (rank[declared] ?? -1) >= (rank[required] ?? Number.POSITIVE_INFINITY);
}

function authorityClassSatisfies(declared: string, required: string) {
  if (required === "general") return true;
  if (required === "external_authoritative") {
    return declared === "external_authoritative" || declared === "transactional";
  }
  return declared === required;
}

function semanticRequirementForGoalPlanV3(
  goal: z.infer<typeof goalPlanV3Schema>,
): Partial<CapabilitySemanticRequirementV3> {
  const evidenceClass = goal.evidenceRequirement.kind === "knowledge_preferred"
    ? "authorized_knowledge" as const
    : goal.evidenceRequirement.kind;
  const authorityClasses = evidenceClass === "authorized_knowledge"
    ? ["owner_authorized"] as const
    : evidenceClass === "current_external"
      ? ["external_authoritative"] as const
      : evidenceClass === "transactional_authority"
        ? ["transactional"] as const
        : evidenceClass === "none"
          ? ["general"] as const
          : [];
  return {
    operations: [goal.operation],
    evidenceClasses: [evidenceClass],
    freshnessClasses: [goal.evidenceRequirement.freshness],
    authorityClasses: [...authorityClasses],
  };
}

function normalizeStringSet(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort(compareCanonicalText);
}

function normalizeSemanticTextSet(values: string[]) {
  return normalizeStringSet(values.map((value) =>
    value.normalize("NFKC").toLocaleLowerCase()));
}

function hasUncoveredGoalSourceText(
  text: string,
  spans: Array<{ startOffset: number; endOffset: number }>,
) {
  const covered = Array.from({ length: text.length }, () => false);
  for (const span of spans) {
    for (let index = span.startOffset; index < span.endOffset; index += 1) {
      covered[index] = true;
    }
  }
  const uncovered = text.split("").filter((_character, index) => !covered[index])
    .join("")
    .normalize("NFKC")
    .replace(/(?:同时|并且|以及|然后|还有|和|与|also|and|then)/giu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
  return uncovered.length > 0;
}

function canonicalByteLengthV3(value: unknown) {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

function compareCanonicalText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function jsonPath(path: PropertyKey[]) {
  return `/${path.map((item) => escapeJsonPointer(String(item))).join("/")}`;
}

function escapeJsonPointer(value: string) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function parseJsonPointer(pointer: string) {
  if (!pointer.startsWith("/")) return [];
  return pointer.slice(1).split("/").map((segment) =>
    segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function resolveJsonPointer(value: unknown, segments: string[]) {
  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

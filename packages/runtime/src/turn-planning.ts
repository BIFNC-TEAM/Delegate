import sha256 from "fast-sha256";
import { z } from "zod";

import { defaultTurnConstraints, turnConstraintsSchema } from "./turn-constraints";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const capabilityEffectSchema = z.enum([
  "read_only",
  "internal_write",
  "external_reversible",
  "external_irreversible",
]);

export const capabilityExecutorSchema = z.enum(["builtin", "skill", "mcp", "compute"]);
export const capabilityIdempotencySchema = z.enum([
  "naturally_idempotent",
  "requires_key",
  "non_idempotent",
]);

export const capabilityDescriptorDraftSchema = z.object({
  key: z.string().trim().min(3).max(160).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/),
  version: boundedText(80),
  description: boundedText(2_000),
  inputSchema: jsonObjectSchema,
  outputSchema: jsonObjectSchema,
  effect: capabilityEffectSchema,
  executor: capabilityExecutorSchema,
  idempotency: capabilityIdempotencySchema,
  supportedChannels: z.array(boundedText(80)).max(32),
  requiredIdentityScopes: z.array(boundedText(160)).max(64),
  requiredDataScopes: z.array(boundedText(160)).max(64),
  tags: z.array(boundedText(120)).max(64),
}).strict();

export const capabilityDescriptorSchema = capabilityDescriptorDraftSchema.extend({
  definitionHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

export const capabilityCatalogSchema = z.object({
  protocolVersion: z.literal(1),
  capabilities: z.array(capabilityDescriptorSchema),
  catalogHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict().superRefine((catalog, context) => {
  const sorted = [...catalog.capabilities].sort(compareCapabilities);
  for (const [index, descriptor] of catalog.capabilities.entries()) {
    const { definitionHash, ...draft } = descriptor;
    if (definitionHash !== stableSha256(draft)) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", index, "definitionHash"],
        message: "Capability definition hash does not match its canonical definition.",
      });
    }
    if (descriptor.key !== sorted[index]?.key || descriptor.version !== sorted[index]?.version) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", index],
        message: "Capability catalog must use canonical key and version ordering.",
      });
    }
  }
  if (catalog.catalogHash !== stableSha256(sorted)) {
    context.addIssue({
      code: "custom",
      path: ["catalogHash"],
      message: "Capability catalog hash does not match the canonical catalog.",
    });
  }
});

export type CapabilityDescriptorDraft = z.infer<typeof capabilityDescriptorDraftSchema>;
export type CapabilityDescriptor = z.infer<typeof capabilityDescriptorSchema>;
export type CapabilityCatalog = z.infer<typeof capabilityCatalogSchema>;

const messageAttachmentSchema = z.object({
  id: boundedText(200),
  fileName: boundedText(500),
  mimeType: boundedText(200),
  sizeBytes: z.number().int().nonnegative(),
  trustClass: z.literal("untrusted_user_input"),
}).strict();

const safeConversationTurnSchema = z.object({
  id: boundedText(200),
  direction: z.enum(["inbound", "outbound", "system"]),
  text: z.string().max(20_000),
  createdAt: boundedText(100),
  trustClass: z.literal("untrusted_conversation_data")
    .default("untrusted_conversation_data"),
}).strict();

const authorizedContextItemSchema = z.object({
  id: boundedText(200),
  kind: z.enum(["public_knowledge", "contact_memory", "representative_experience"]),
  summary: z.string().max(10_000),
  trustClass: z.enum(["trusted_server_context", "untrusted_recalled_content"]),
}).strict();

export const turnEnvelopeSchema = z.object({
  currentMessage: z.object({
    id: boundedText(200),
    text: z.string().max(50_000),
    language: boundedText(40),
  }).strict(),
  attachments: z.array(messageAttachmentSchema).max(32),
  recentTurns: z.array(safeConversationTurnSchema).max(100),
  conversationSummary: z.string().max(30_000).nullable(),
  activeCollector: jsonObjectSchema.nullable(),
  activeTask: jsonObjectSchema.nullable(),
  pendingApproval: jsonObjectSchema.nullable(),
  activeHandoff: jsonObjectSchema.nullable(),
  actorIdentity: jsonObjectSchema,
  authority: z.object({
    identityScopes: z.array(boundedText(160)).max(128),
    dataScopes: z.array(boundedText(160)).max(128),
  }).strict().optional(),
  channel: z.object({
    kind: boundedText(80),
    supportsAttachments: z.boolean(),
  }).strict(),
  representativeVersion: z.object({
    representativeId: boundedText(200),
    version: boundedText(100),
  }).strict(),
  serviceState: jsonObjectSchema,
  planningDefaults: z.object({
    managedDocumentFormat: z.enum(["markdown", "txt"]),
    knowledgePolicy: z.enum(["prefer_authorized", "on_demand"])
      .default("on_demand"),
  }).strict().optional(),
  authorizedContext: z.array(authorizedContextItemSchema).max(200),
  turnConstraints: turnConstraintsSchema.default(defaultTurnConstraints),
  capabilitySnapshot: capabilityCatalogSchema,
}).strict();

export type TurnEnvelope = z.infer<typeof turnEnvelopeSchema>;

export const planArgumentProvenanceSchema = z.object({
  source: z.enum([
    "user_message",
    "attachment",
    "trusted_context",
    "server_state",
    "previous_action_output",
  ]),
  pointer: z.string().min(1).max(1_000).regex(/^\//),
}).strict();

export const planActionSchema = z.object({
  id: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  capability: z.object({
    key: capabilityDescriptorDraftSchema.shape.key,
    version: capabilityDescriptorDraftSchema.shape.version,
    definitionHash: capabilityDescriptorSchema.shape.definitionHash,
  }).strict(),
  arguments: jsonObjectSchema,
  argumentProvenance: z.record(z.string(), planArgumentProvenanceSchema),
  dependsOn: z.array(z.string().trim().min(1).max(160)).max(32),
  expectedOutputSchema: jsonObjectSchema,
  completionCriteria: z.array(boundedText(1_000)).min(1).max(32),
  onFailure: z.enum(["stop", "clarify", "replan", "handoff"]),
}).strict();

export const turnPlanV2Schema = z.object({
  protocolVersion: z.literal(2),
  planId: boundedText(200),
  objective: boundedText(2_000),
  mode: z.enum(["respond", "clarify", "execute", "handoff", "refuse"]),
  goals: z.array(z.object({
    id: boundedText(160),
    description: boundedText(2_000),
    priority: z.number().int().min(1).max(100),
  }).strict()).min(1).max(32),
  deliverables: z.array(z.object({
    id: boundedText(160),
    kind: z.enum([
      "message",
      "artifact",
      "public_material",
      "service_request",
      "external_result",
    ]),
    format: z.string().trim().max(120).nullable(),
    producedByActionIds: z.array(boundedText(160)).max(32),
    completionCriteria: z.array(boundedText(1_000)).min(1).max(32),
  }).strict()).max(32),
  uncertainties: z.array(z.object({
    field: boundedText(500),
    reason: boundedText(2_000),
    blocksActionIds: z.array(boundedText(160)).max(32),
  }).strict()).max(32),
  questions: z.array(z.object({
    field: boundedText(500),
    question: boundedText(2_000),
    requiredForActionIds: z.array(boundedText(160)).max(32),
  }).strict()).max(32),
  actions: z.array(planActionSchema).max(32),
}).strict();

export type PlanAction = z.infer<typeof planActionSchema>;
export type TurnPlanV2 = z.infer<typeof turnPlanV2Schema>;

export type TurnPlanValidationIssue = {
  code:
    | "schema_invalid"
    | "id_duplicate"
    | "mode_invalid"
    | "capability_unknown"
    | "capability_version_mismatch"
    | "capability_channel_unsupported"
    | "identity_scope_missing"
    | "data_scope_missing"
    | "output_schema_mismatch"
    | "arguments_invalid"
    | "dependency_unknown"
    | "dependency_cycle"
    | "deliverable_action_unknown"
    | "reference_action_unknown"
    | "provenance_missing"
    | "provenance_extra"
    | "provenance_invalid";
  path: string;
  message: string;
};

export type TurnPlanValidationResult =
  | { ok: true; plan: TurnPlanV2 }
  | { ok: false; issues: TurnPlanValidationIssue[] };

const BUILTIN_CAPABILITY_DRAFTS: CapabilityDescriptorDraft[] = [
  capability({
    key: "knowledge.answer_public",
    description: "Answer a user from authorized public knowledge without external side effects.",
    inputSchema: objectJsonSchema({ question: stringJsonSchema() }, ["question"]),
    outputSchema: objectJsonSchema({ answer: stringJsonSchema() }, ["answer"]),
    effect: "read_only",
    tags: ["知识", "公开回答", "问答"],
  }),
  capability({
    key: "material.deliver_public",
    description: "Deliver an already published public material into the current conversation.",
    inputSchema: objectJsonSchema({ materialId: stringJsonSchema() }, ["materialId"]),
    outputSchema: objectJsonSchema({ deliveredMaterialId: stringJsonSchema() }, ["deliveredMaterialId"]),
    effect: "read_only",
    tags: ["公开资料", "发送资料"],
  }),
  capability({
    key: "artifact.generate_document",
    description: "Generate a managed document artifact such as a report, tutorial, guide, lesson, plan, or checklist.",
    inputSchema: objectJsonSchema({
      topic: stringJsonSchema(),
      audience: stringJsonSchema(),
      // PDF/DOCX require a separate verified renderer capability. The source
      // generator must not claim those final formats before conversion.
      format: { type: "string", enum: ["markdown", "txt"] },
    }, ["topic"]),
    outputSchema: objectJsonSchema({ artifactId: stringJsonSchema(), fileName: stringJsonSchema() }, ["artifactId", "fileName"]),
    effect: "internal_write",
    tags: ["文档", "文件", "教程", "指南", "报告", "学习资料"],
  }),
  capability({
    key: "service_request.create",
    description: "Create an internal service request from one user-provided requirement description.",
    inputSchema: objectJsonSchema({ description: stringJsonSchema() }, ["description"]),
    outputSchema: objectJsonSchema({ serviceRequestId: stringJsonSchema() }, ["serviceRequestId"]),
    effect: "internal_write",
    idempotency: "requires_key",
    tags: ["服务请求", "需求"],
  }),
  capability({
    key: "handoff.request",
    description: "Request human handoff using the user's requirement description.",
    inputSchema: objectJsonSchema({ description: stringJsonSchema() }, ["description"]),
    outputSchema: objectJsonSchema({ handoffRequestId: stringJsonSchema() }, ["handoffRequestId"]),
    effect: "internal_write",
    idempotency: "requires_key",
    tags: ["人工", "真人", "接管", "转人工"],
  }),
  capability({
    key: "conversation.status",
    description: "Read the current conversation, task, approval, and handoff status.",
    inputSchema: objectJsonSchema({}, []),
    outputSchema: objectJsonSchema({ status: stringJsonSchema() }, ["status"]),
    effect: "read_only",
    tags: ["状态", "进度", "审批"],
  }),
  capability({
    key: "conversation.cancel",
    description: "Cancel a user-owned pending request or active task when cancellation is allowed.",
    inputSchema: objectJsonSchema({ target: stringJsonSchema() }, ["target"]),
    outputSchema: objectJsonSchema({ canceled: { type: "boolean" } }, ["canceled"]),
    effect: "internal_write",
    idempotency: "requires_key",
    tags: ["取消", "终止"],
  }),
];

export const BUILTIN_CAPABILITIES = Object.freeze(
  BUILTIN_CAPABILITY_DRAFTS.map(registerCapability),
);

export function buildCapabilityCatalog(input: {
  skills?: CapabilityDescriptorDraft[];
  mcp?: CapabilityDescriptorDraft[];
  compute?: CapabilityDescriptorDraft[];
  additional?: CapabilityDescriptorDraft[];
} = {}): CapabilityCatalog {
  const drafts = [
    ...BUILTIN_CAPABILITY_DRAFTS,
    ...(input.skills ?? []).map((item) => ({ ...item, executor: "skill" as const })),
    ...(input.mcp ?? []).map((item) => ({ ...item, executor: "mcp" as const })),
    ...(input.compute ?? []).map((item) => ({ ...item, executor: "compute" as const })),
    ...(input.additional ?? []),
  ];
  const registered = drafts.map(registerCapability);
  const coordinates = new Set<string>();
  for (const descriptor of registered) {
    const coordinate = `${descriptor.key}@${descriptor.version}`;
    if (coordinates.has(coordinate)) {
      throw new Error(`Capability catalog contains duplicate coordinate ${coordinate}.`);
    }
    coordinates.add(coordinate);
  }
  const capabilities = registered.sort(compareCapabilities);
  return capabilityCatalogSchema.parse({
    protocolVersion: 1,
    capabilities,
    catalogHash: stableSha256(capabilities),
  });
}

export function retrieveCapabilities(
  catalog: CapabilityCatalog,
  query: string,
  topK = 12,
): CapabilityDescriptor[] {
  const boundedTopK = Math.max(1, Math.min(50, Math.floor(topK)));
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenizeSearchText(normalizedQuery);
  return [...catalog.capabilities]
    .map((descriptor) => ({
      descriptor,
      score: scoreCapability(descriptor, normalizedQuery, queryTokens),
    }))
    .filter((candidate) => candidate.score > 0 || queryTokens.length === 0)
    .sort((left, right) => right.score - left.score || compareCapabilities(left.descriptor, right.descriptor))
    .slice(0, boundedTopK)
    .map((candidate) => candidate.descriptor);
}

export function validateTurnPlanV2(input: {
  plan: unknown;
  catalog: CapabilityCatalog;
  envelope?: TurnEnvelope;
  expectedPlanId?: string;
}): TurnPlanValidationResult {
  const parsed = turnPlanV2Schema.safeParse(input.plan);
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
  const issues: TurnPlanValidationIssue[] = [];
  if (input.expectedPlanId && plan.planId !== input.expectedPlanId) {
    issues.push({
      code: "schema_invalid",
      path: "/planId",
      message: "Planner changed the server-assigned plan id.",
    });
  }
  const actionById = new Map(plan.actions.map((action) => [action.id, action]));
  const capabilityByCoordinate = new Map(
    input.catalog.capabilities.map((descriptor) => [`${descriptor.key}@${descriptor.version}`, descriptor]),
  );

  reportDuplicateIds(plan.actions.map((action) => action.id), "/actions", issues);
  reportDuplicateIds(plan.goals.map((goal) => goal.id), "/goals", issues);
  reportDuplicateIds(plan.deliverables.map((deliverable) => deliverable.id), "/deliverables", issues);
  if (plan.mode === "execute" && plan.actions.length === 0) {
    issues.push({ code: "mode_invalid", path: "/mode", message: "Execute mode requires at least one action." });
  }
  if (plan.mode === "clarify" && plan.questions.length === 0) {
    issues.push({ code: "mode_invalid", path: "/questions", message: "Clarify mode requires at least one user question." });
  }
  if (plan.mode !== "execute" && plan.actions.length > 0) {
    issues.push({ code: "mode_invalid", path: "/actions", message: "Only execute mode may schedule capability actions." });
  }

  for (const [index, action] of plan.actions.entries()) {
    const path = `/actions/${index}`;
    const descriptor = capabilityByCoordinate.get(`${action.capability.key}@${action.capability.version}`);
    if (!descriptor) {
      issues.push({ code: "capability_unknown", path: `${path}/capability`, message: "Plan references a capability outside the fixed catalog snapshot." });
    } else if (descriptor.definitionHash !== action.capability.definitionHash) {
      issues.push({ code: "capability_version_mismatch", path: `${path}/capability/definitionHash`, message: "Capability definition hash does not match the catalog snapshot." });
    } else {
      if (
        !input.envelope
        || !descriptor.supportedChannels.includes(input.envelope.channel.kind)
      ) {
        issues.push({
          code: "capability_channel_unsupported",
          path: `${path}/capability`,
          message: input.envelope
            ? `Capability is not supported on channel ${input.envelope.channel.kind}.`
            : "Capability channel authorization requires a turn envelope.",
        });
      }
      const grantedIdentityScopes = input.envelope?.authority?.identityScopes;
      for (const scope of descriptor.requiredIdentityScopes) {
        if (!grantedIdentityScopes?.includes(scope)) {
          issues.push({
            code: "identity_scope_missing",
            path: `${path}/capability`,
            message: `Capability requires missing identity scope ${scope}.`,
          });
        }
      }
      const grantedDataScopes = input.envelope?.authority?.dataScopes;
      for (const scope of descriptor.requiredDataScopes) {
        if (!grantedDataScopes?.includes(scope)) {
          issues.push({
            code: "data_scope_missing",
            path: `${path}/capability`,
            message: `Capability requires missing data scope ${scope}.`,
          });
        }
      }
      if (canonicalJson(descriptor.outputSchema) !== canonicalJson(action.expectedOutputSchema)) {
        issues.push({ code: "output_schema_mismatch", path: `${path}/expectedOutputSchema`, message: "Expected output schema must come from the immutable capability definition." });
      }
      for (const problem of validateJsonSchemaValue(action.arguments, descriptor.inputSchema, `${path}/arguments`)) {
        issues.push({ code: "arguments_invalid", ...problem });
      }
    }
    for (const dependencyId of action.dependsOn) {
      if (!actionById.has(dependencyId)) {
        issues.push({ code: "dependency_unknown", path: `${path}/dependsOn`, message: `Unknown dependency ${dependencyId}.` });
      }
    }
    validateActionProvenance({
      action,
      index,
      actionById,
      ...(input.envelope ? { envelope: input.envelope } : {}),
      issues,
    });
  }

  if (containsDependencyCycle(plan.actions)) {
    issues.push({ code: "dependency_cycle", path: "/actions", message: "Plan action dependencies must form an acyclic graph." });
  }
  for (const [index, deliverable] of plan.deliverables.entries()) {
    for (const actionId of deliverable.producedByActionIds) {
      if (!actionById.has(actionId)) {
        issues.push({ code: "deliverable_action_unknown", path: `/deliverables/${index}/producedByActionIds`, message: `Deliverable references unknown action ${actionId}.` });
      }
    }
  }
  for (const [index, uncertainty] of plan.uncertainties.entries()) {
    for (const actionId of uncertainty.blocksActionIds) {
      if (!actionById.has(actionId)) {
        issues.push({ code: "reference_action_unknown", path: `/uncertainties/${index}/blocksActionIds`, message: `Uncertainty references unknown action ${actionId}.` });
      }
    }
  }
  for (const [index, question] of plan.questions.entries()) {
    for (const actionId of question.requiredForActionIds) {
      if (!actionById.has(actionId)) {
        issues.push({ code: "reference_action_unknown", path: `/questions/${index}/requiredForActionIds`, message: `Question references unknown action ${actionId}.` });
      }
    }
  }

  return issues.length ? { ok: false, issues } : { ok: true, plan };
}

function capability(input: {
  key: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  effect: z.infer<typeof capabilityEffectSchema>;
  idempotency?: z.infer<typeof capabilityIdempotencySchema>;
  tags?: string[];
}): CapabilityDescriptorDraft {
  return capabilityDescriptorDraftSchema.parse({
    ...input,
    version: "1",
    executor: "builtin",
    idempotency: input.idempotency ?? "naturally_idempotent",
    supportedChannels: ["web", "matrix", "telegram"],
    requiredIdentityScopes: [],
    requiredDataScopes: [],
    tags: input.tags ?? [],
  });
}

function registerCapability(draft: CapabilityDescriptorDraft): CapabilityDescriptor {
  const parsed = capabilityDescriptorDraftSchema.parse({
    ...draft,
    supportedChannels: normalizeStringSet(draft.supportedChannels),
    requiredIdentityScopes: normalizeStringSet(draft.requiredIdentityScopes),
    requiredDataScopes: normalizeStringSet(draft.requiredDataScopes),
    tags: normalizeStringSet(draft.tags),
  });
  assertSupportedCapabilitySchema(parsed.inputSchema, `${parsed.key} input`, true);
  assertSupportedCapabilitySchema(parsed.outputSchema, `${parsed.key} output`, false);
  return capabilityDescriptorSchema.parse({
    ...parsed,
    definitionHash: stableSha256(parsed),
  });
}

export function assertSupportedCapabilitySchema(
  schema: Record<string, unknown>,
  label: string,
  requireClosedRoot: boolean,
) {
  const visit = (current: Record<string, unknown>, path: string, closedObject: boolean) => {
    for (const key of Object.keys(current)) {
      if (!isSupportedJsonSchemaKeyword(key)) {
        throw new Error(`Capability ${label} schema uses unsupported keyword ${key} at ${path}.`);
      }
    }
    const type = current.type;
    if (typeof type !== "undefined" && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(type))) {
      throw new Error(`Capability ${label} schema has unsupported type at ${path}.`);
    }
    if (type === "object") {
      if (closedObject && current.additionalProperties !== false) {
        throw new Error(`Capability ${label} object schema must set additionalProperties=false at ${path}.`);
      }
      const properties = isRecord(current.properties) ? current.properties : {};
      const required = Array.isArray(current.required) ? current.required : [];
      if (!required.every((item) => typeof item === "string" && item in properties)) {
        throw new Error(`Capability ${label} schema has an invalid required property at ${path}.`);
      }
      for (const [key, nested] of Object.entries(properties)) {
        if (!isRecord(nested)) throw new Error(`Capability ${label} property ${key} has no schema at ${path}.`);
        visit(nested, `${path}/properties/${escapeJsonPointer(key)}`, closedObject);
      }
    }
    if (type === "array") {
      if (!isRecord(current.items)) throw new Error(`Capability ${label} array schema has no item schema at ${path}.`);
      visit(current.items, `${path}/items`, closedObject);
    }
    for (const composition of ["allOf", "anyOf"] as const) {
      if (typeof current[composition] === "undefined") continue;
      if (!Array.isArray(current[composition]) || !current[composition].every(isRecord)) {
        throw new Error(`Capability ${label} schema has invalid ${composition} at ${path}.`);
      }
      (current[composition] as Record<string, unknown>[]).forEach((nested, index) => {
        visit(nested, `${path}/${composition}/${index}`, closedObject);
      });
    }
  };
  if (requireClosedRoot && schema.type !== "object") {
    throw new Error(`Capability ${label} schema root must have type=object.`);
  }
  visit(schema, "/", requireClosedRoot);
}

/**
 * Derive the schema exposed to the structured planner without mutating the
 * source schema observed from a remote capability. MCP servers commonly omit
 * additionalProperties and attach vendor extension metadata. The registry
 * must retain and hash that source schema exactly, while the planner receives
 * a deterministic, closed argument surface.
 */
export function derivePlannerCapabilitySchema(
  schema: Record<string, unknown>,
  options: {
    closeObjects: boolean;
    dropUnsupportedOutputKeywords?: boolean;
  },
): Record<string, unknown> {
  const visit = (current: Record<string, unknown>, path: string): Record<string, unknown> => {
    const derived: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) {
      if (key.startsWith("x-") || isNonValidationJsonSchemaAnnotation(key)) continue;
      if (
        options.dropUnsupportedOutputKeywords
        && isUnsupportedProjectedOutputKeyword(key)
      ) continue;
      if (!isSupportedJsonSchemaKeyword(key)) {
        throw new Error(`Capability schema uses unsupported keyword ${key} at ${path}.`);
      }
      if (key === "properties" && isRecord(value)) {
        derived[key] = Object.fromEntries(Object.entries(value).map(([property, nested]) => {
          if (!isRecord(nested)) {
            throw new Error(`Capability property ${property} has no schema at ${path}.`);
          }
          return [property, visit(nested, `${path}/properties/${escapeJsonPointer(property)}`)];
        }));
        continue;
      }
      if (key === "items" && isRecord(value)) {
        derived[key] = visit(value, `${path}/items`);
        continue;
      }
      if ((key === "allOf" || key === "anyOf") && Array.isArray(value)) {
        if (!value.every(isRecord)) {
          throw new Error(`Capability schema has invalid ${key} at ${path}.`);
        }
        derived[key] = value.map((nested, index) =>
          visit(nested, `${path}/${key}/${index}`));
        continue;
      }
      derived[key] = value;
    }
    if (options.closeObjects && derived.type === "object") {
      derived.additionalProperties = false;
    }
    return derived;
  };
  return visit(schema, "/");
}

function isNonValidationJsonSchemaAnnotation(key: string) {
  return [
    "$schema",
    "$id",
    "$comment",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
  ].includes(key);
}

function isUnsupportedProjectedOutputKeyword(key: string) {
  // These constraints are not currently enforced by Delegate's result-schema
  // validator. They may be omitted only from executor output projections,
  // never from closed tool-input schemas. The exact remote schema remains
  // separately persisted and hash-pinned for drift detection.
  return key === "not" || key === "propertyNames";
}

function isSupportedJsonSchemaKeyword(key: string) {
  return [
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "allOf",
    "anyOf",
    "title",
    "description",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
  ].includes(key);
}

function normalizeStringSet(values: string[]) {
  return [...new Set(values)].sort(compareCanonicalText);
}

function compareCapabilities(left: CapabilityDescriptor, right: CapabilityDescriptor) {
  return compareCanonicalText(left.key, right.key)
    || compareCanonicalText(left.version, right.version);
}

function normalizeSearchText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function tokenizeSearchText(value: string) {
  const tokens = new Set(value.match(/[a-z0-9_.-]+|\p{Script=Han}/gu) ?? []);
  return [...tokens];
}

function scoreCapability(descriptor: CapabilityDescriptor, query: string, queryTokens: string[]) {
  const key = normalizeSearchText(descriptor.key);
  const haystack = normalizeSearchText([
    descriptor.key,
    descriptor.description,
    ...descriptor.tags,
  ].join(" "));
  let score = query && key === query ? 1_000 : query && key.includes(query) ? 400 : 0;
  for (const token of queryTokens) {
    if (key.includes(token)) score += 20;
    if (haystack.includes(token)) score += 4;
  }
  return score;
}

export function stableSha256(value: unknown) {
  const digest = sha256(new TextEncoder().encode(canonicalJson(value)));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

function compareCanonicalText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateActionProvenance(input: {
  action: PlanAction;
  index: number;
  actionById: Map<string, PlanAction>;
  envelope?: TurnEnvelope;
  issues: TurnPlanValidationIssue[];
}) {
  const path = `/actions/${input.index}/argumentProvenance`;
  const argumentKeys = Object.keys(input.action.arguments);
  const provenanceKeys = Object.keys(input.action.argumentProvenance);
  for (const key of argumentKeys) {
    if (!(key in input.action.argumentProvenance)) {
      input.issues.push({ code: "provenance_missing", path: `${path}/${escapeJsonPointer(key)}`, message: `Argument ${key} has no provenance.` });
    }
  }
  for (const key of provenanceKeys) {
    if (!(key in input.action.arguments)) {
      input.issues.push({ code: "provenance_extra", path: `${path}/${escapeJsonPointer(key)}`, message: `Provenance ${key} does not correspond to an argument.` });
      continue;
    }
    const provenance = input.action.argumentProvenance[key];
    if (!provenance) continue;
    const error = validateProvenancePointer(
      provenance,
      input.action.arguments[key],
      input.action,
      input.actionById,
      input.envelope,
    );
    if (error) {
      input.issues.push({ code: "provenance_invalid", path: `${path}/${escapeJsonPointer(key)}`, message: error });
    }
  }
}

function validateProvenancePointer(
  provenance: z.infer<typeof planArgumentProvenanceSchema>,
  argumentValue: unknown,
  action: PlanAction,
  actionById: Map<string, PlanAction>,
  envelope?: TurnEnvelope,
) {
  if (provenance.source === "previous_action_output") {
    const segments = parseJsonPointer(provenance.pointer);
    if (segments[0] !== "actions" || !segments[1] || segments[2] !== "output") {
      return "Previous-action provenance must use /actions/<actionId>/output pointer form.";
    }
    if (!actionById.has(segments[1]) || !action.dependsOn.includes(segments[1])) {
      return "Previous-action provenance must reference a direct action dependency.";
    }
    return null;
  }
  const allowedRoots: Record<Exclude<typeof provenance.source, "previous_action_output">, string[]> = {
    user_message: ["currentMessage"],
    attachment: ["attachments"],
    trusted_context: ["conversationSummary", "authorizedContext"],
    server_state: ["activeCollector", "activeTask", "pendingApproval", "activeHandoff", "actorIdentity", "authority", "channel", "representativeVersion", "serviceState", "planningDefaults"],
  };
  const segments = parseJsonPointer(provenance.pointer);
  if (!segments[0] || !allowedRoots[provenance.source].includes(segments[0])) {
    return `Pointer is outside the allowed ${provenance.source} context.`;
  }
  const evidence = envelope ? resolveJsonPointer(envelope, segments) : undefined;
  if (envelope && evidence === undefined) {
    return "Pointer does not resolve inside the supplied turn envelope.";
  }
  if (provenance.source === "user_message") {
    if (provenance.pointer !== "/currentMessage/text") {
      return "Direct user-message provenance must point to /currentMessage/text.";
    }
    if (!isDirectUserMessageArgumentGrounded(argumentValue, evidence)) {
      return "Argument value is not directly grounded in the cited user-message text.";
    }
  }
  if (
    provenance.source === "server_state"
    && canonicalJson(argumentValue) !== canonicalJson(evidence)
  ) {
    return "Server-state provenance must equal the cited authoritative value.";
  }
  return null;
}

export function isDirectUserMessageArgumentGrounded(
  argumentValue: unknown,
  evidence: unknown,
) {
  if (typeof evidence !== "string") return false;
  if (
    typeof argumentValue !== "string"
    && typeof argumentValue !== "number"
    && typeof argumentValue !== "boolean"
  ) {
    return false;
  }
  const normalizedArgument = normalizeEvidenceText(String(argumentValue));
  const normalizedEvidence = normalizeEvidenceText(evidence);
  return Boolean(
    normalizedArgument
    && normalizedEvidence
    && normalizedEvidence.includes(normalizedArgument)
  );
}

export function isAffirmativeManagedDocumentRequest(userText: string) {
  const normalized = userText.normalize("NFKC");
  if (
    /(?:仅供|只供)\s*(?:引用|展示|示例|分析|测试)|用于\s*(?:引用|展示|示例)|(?:不要|不得|请勿|不应)\s*(?:执行|照做|遵循)|\b(?:for\s+(?:quotation|reference|example)\s+only|do\s+not\s+(?:execute|follow|obey))\b/iu.test(
      normalized,
    )
  ) {
    return false;
  }
  const unquoted = stripQuotedText(stripFencedCode(normalized));
  if (
    /(?:忽略|无视|绕过|覆盖|泄露).{0,24}(?:系统|规则|指令|提示|安全|约束)|\b(?:ignore|bypass|override)\b.{0,32}\b(?:system|instruction|prompt|rule|safety)\b|prompt\s*injection/iu.test(
      unquoted,
    )
  ) {
    return false;
  }
  if (
    /(?:不要|别|无需|不需要|不是(?:要|让)|禁止|取消|停止|拒绝)\s*(?:再|继续|帮我|为我|替我)?\s*(?:生成|创建|撰写|编写|制作|导出|整理|提供|给我)|\b(?:do\s+not|don't|never|cancel|stop|refuse\s+to)\s+(?:generate|create|write|draft|export|provide)\b/iu.test(
      unquoted,
    )
  ) {
    return false;
  }
  if (
    /(?:如何|怎么|怎样|为什么|能否|是否可以).{0,24}(?:生成|创建|制作|导出)|(?:分析|解释|判断|识别|分类|评价|讨论|转述|引用|改写).{0,32}(?:这句话|这段话|这段(?:提示|提示词|指令|请求|内容|文本|代码)|以下(?:请求|指令|提示|提示词|内容|文本|代码)|下列(?:请求|指令|提示|内容|文本|代码)|上述(?:请求|指令|提示|内容|文本|代码))|\b(?:how\s+to)\b|\b(?:explain|analy[sz]e|classify|quote|rewrite)\b.{0,32}\b(?:this\s+)?(?:request|instruction|sentence|phrase|prompt|content|code)\b/iu.test(
      unquoted,
    )
  ) {
    return false;
  }
  return /(?:帮我|给我|为我|替我|我要|我想要|我需要|需要|生成|创建|撰写|编写|制作|导出|整理|提供).{0,120}(?:文件|文档|报告|教程|指南|教案|总结|方案|清单|表格|记录|纪要)|\b(?:generate|create|write|draft|prepare|export|provide|give\s+me)\b.{0,120}\b(?:file|document|report|tutorial|guide|lesson|summary|plan|checklist|table|record|notes)\b/iu.test(
    unquoted,
  );
}

function stripFencedCode(value: string) {
  return value.replace(/```[^\n]*(?:\n|$)[\s\S]*?(?:```|$)/gu, " ");
}

function stripQuotedText(value: string) {
  return value.replace(
    /“[^”\n]*(?:”|$)|「[^」\n]*(?:」|$)|『[^』\n]*(?:』|$)|"[^"\n]*(?:"|$)|'[^'\n]*'|`[^`\n]*(?:`|$)/gu,
    " ",
  );
}

function normalizeEvidenceText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function containsDependencyCycle(actions: PlanAction[]) {
  const graph = new Map(actions.map((action) => [action.id, action.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (graph.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return actions.some((action) => visit(action.id));
}

function reportDuplicateIds(
  ids: string[],
  path: string,
  issues: TurnPlanValidationIssue[],
) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      issues.push({ code: "id_duplicate", path, message: `Duplicate id ${id}.` });
    }
    seen.add(id);
  }
}

export function validateJsonSchemaValue(value: unknown, schema: Record<string, unknown>, path: string): Array<{ path: string; message: string }> {
  const problems: Array<{ path: string; message: string }> = [];
  if (Array.isArray(schema.allOf)) {
    for (const nested of schema.allOf) if (isRecord(nested)) problems.push(...validateJsonSchemaValue(value, nested, path));
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((nested) => isRecord(nested) && validateJsonSchemaValue(value, nested, path).length === 0)) {
    problems.push({ path, message: "Value does not match any allowed schema." });
    return problems;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => canonicalJson(candidate) === canonicalJson(value))) {
    problems.push({ path, message: "Value is outside the allowed enum." });
  }
  if ("const" in schema && canonicalJson(schema.const) !== canonicalJson(value)) {
    problems.push({ path, message: "Value does not match the required constant." });
  }
  const type = schema.type;
  if (typeof type === "string" && !matchesJsonType(value, type)) {
    problems.push({ path, message: `Expected JSON type ${type}.` });
    return problems;
  }
  if (type === "object" && isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) {
      if (!(key in value)) problems.push({ path: `${path}/${escapeJsonPointer(key)}`, message: "Required property is missing." });
    }
    for (const [key, nestedValue] of Object.entries(value)) {
      const nestedSchema = properties[key];
      if (isRecord(nestedSchema)) {
        problems.push(...validateJsonSchemaValue(nestedValue, nestedSchema, `${path}/${escapeJsonPointer(key)}`));
      } else if (schema.additionalProperties === false) {
        problems.push({ path: `${path}/${escapeJsonPointer(key)}`, message: "Additional property is not allowed." });
      }
    }
  }
  if (type === "array" && Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, index) => problems.push(...validateJsonSchemaValue(item, schema.items as Record<string, unknown>, `${path}/${index}`)));
  }
  if (type === "string" && typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) problems.push({ path, message: "String is shorter than minLength." });
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) problems.push({ path, message: "String is longer than maxLength." });
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) problems.push({ path, message: "String does not match the required pattern." });
  }
  return problems;
}

function matchesJsonType(value: unknown, type: string) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function resolveJsonPointer(root: unknown, segments: string[]): unknown {
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (isRecord(current) && segment in current) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function parseJsonPointer(pointer: string) {
  return pointer.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function escapeJsonPointer(value: string) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function jsonPath(path: PropertyKey[]) {
  return path.length ? `/${path.map((part) => escapeJsonPointer(String(part))).join("/")}` : "/";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringJsonSchema() {
  return { type: "string", minLength: 1, maxLength: 50_000 };
}

function objectJsonSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

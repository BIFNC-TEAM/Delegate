import {
  CAPABILITY_CANONICALIZATION_VERSION_V3,
  capabilitySemanticsV3Schema,
  createCapabilityPublicationV3,
  derivePlannerCapabilitySchema,
  stableSha256,
  type CapabilityDefinitionDraftV3,
  type CapabilityEffectV3,
  type CapabilityPublicationV3,
  type CapabilitySemanticsV3,
  type SuccessContractV3,
} from "@delegate/runtime";

import type { RepresentativeRuntimeMcpBindingGrant } from "./representative-setup";

const supportedConversationChannels = ["web", "matrix", "telegram"];

export type CapabilityServerPolicyV3 = {
  /** Server-controlled trust-policy coordinate, never derived from MCP text. */
  policyId: string;
  /**
   * Immutable server/Owner classification revision. Remote MCP annotations
   * never populate this field. Changing it produces a new capability version
   * and therefore forces a fresh Plan validation.
   */
  classificationVersion: string;
  effect: CapabilityEffectV3;
  idempotency: CapabilityDefinitionDraftV3["idempotency"];
  successContract?: SuccessContractV3;
  supportedChannels?: string[];
  requiredIdentityScopes?: string[];
  requiredDataScopes?: string[];
  /**
   * Reviewed, server-owned defaults for optional Tool arguments. These are
   * capability policy, never copied from untrusted remote Schema annotations.
   */
  argumentDefaults?: Record<string, unknown>;
  /**
   * Server-owned semantic classification for trusted remote tools. Remote MCP
   * descriptions, schemas, and annotations never populate this field.
   */
  semantics?: CapabilitySemanticsV3;
};

export function buildMcpToolCapabilityPublicationV3(input: {
  binding: RepresentativeRuntimeMcpBindingGrant;
  tool: NonNullable<RepresentativeRuntimeMcpBindingGrant["toolDefinitions"]>[number];
  checkedAt?: string;
}): CapabilityPublicationV3 {
  const key = [
    "mcp",
    normalizeCapabilityKeySegmentV3(input.binding.slug),
    normalizeCapabilityKeySegmentV3(input.tool.exactToolName),
  ].join(".");
  const bindingAvailability = input.binding.availability;
  const toolObservedAt = normalizeOptionalIsoDate(input.tool.observedAt);
  const bindingCheckedAt = normalizeOptionalIsoDate(
    input.checkedAt ?? bindingAvailability?.checkedAt,
  );
  const checkedAt = latestIsoDate(toolObservedAt, bindingCheckedAt);
  const schemaPinMatches = normalizeSha256(input.tool.toolSchemaHash)
    === stableSha256({
      inputSchema: input.tool.inputSchema,
      outputSchema: input.tool.outputSchema ?? null,
    });
  const observedHealthState = resolveMcpToolHealthState({
    ...input,
    toolObservedAt,
    bindingCheckedAt,
  });
  const trustedPolicy = resolveServerOwnedMcpCapabilityPolicyV3({
    serverUrl: input.binding.serverUrl,
    transportKind: input.binding.transportKind,
    toolName: input.tool.exactToolName,
    toolSchemaHash: input.tool.toolSchemaHash,
  });
  const policy = trustedPolicy ?? {
    ...unclassifiedExternalPolicy(),
    successContract: {
      kind: "server_evaluator" as const,
      evaluatorId: "mcp.generic_semantic",
      evaluatorVersion: "1",
    },
  };
  const semantics = resolveCapabilitySemantics(
    trustedPolicy?.semantics ?? input.tool.semanticMetadata,
    {
      operations: [],
      evidenceClasses: ["capability_result"],
      freshnessClasses: ["bounded"],
      authorityClasses: [],
      domains: [],
      aliases: [input.binding.slug, input.tool.exactToolName],
    },
  );
  const trustedEffectClassification = trustedPolicy
    ? classifyTrustedMcpEffectPolicy(trustedPolicy.effect)
    : "missing" as const;
  const healthState = schemaPinMatches
    && trustedPolicy
    && trustedEffectClassification === "classified"
    ? observedHealthState
    : "unavailable" as const;
  const description = buildMcpCapabilityDescription(input.binding, input.tool);
  return createCapabilityPublicationV3({
    definition: {
      key,
      version: [
        input.tool.bindingRevision,
        policy.policyId,
        policy.classificationVersion,
      ].join(":"),
      description,
      executor: "mcp",
      inputSchema: applyServerOwnedArgumentDefaultsV3(
        stripUntrustedSchemaAnnotations(
          derivePlannerCapabilitySchema(input.tool.inputSchema, {
            closeObjects: true,
          }),
        ),
        policy.argumentDefaults,
      ),
      outputSchema: input.tool.outputSchema
        ? stripUntrustedSchemaAnnotations(
          derivePlannerCapabilitySchema(input.tool.outputSchema, {
            closeObjects: false,
            dropUnsupportedOutputKeywords: true,
          }),
          )
        : closedObjectSchema({ result: {} }, ["result"]),
      effect: policy.effect,
      idempotency: policy.idempotency,
      ...(policy.successContract
        ? { successContract: policy.successContract }
        : {}),
      supportedChannels:
        policy.supportedChannels ?? supportedConversationChannels,
      requiredIdentityScopes: policy.requiredIdentityScopes ?? [],
      requiredDataScopes: policy.requiredDataScopes ?? [],
      tags: [input.binding.slug, input.tool.exactToolName],
      semantics,
      canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
      mcpToolSchemaHash: normalizeSha256(input.tool.toolSchemaHash),
      bindingDefinitionHash: normalizeSha256(
        input.tool.bindingDefinitionHash,
      ),
    },
    semantics,
    availability: {
      healthState,
      checkedAt,
      runtimeRevision: [
        input.tool.bindingRevision,
        policy.policyId,
        policy.classificationVersion,
        input.tool.observedAt ?? "unobserved",
      ].join(":"),
      ...(healthState !== "ready"
        ? {
            failureCode:
              !schemaPinMatches
                ? "mcp_tool_schema_pin_invalid"
                : !trustedPolicy
                ? "mcp_effect_policy_unclassified"
                : trustedEffectClassification === "unknown"
                  ? "mcp_effect_policy_unknown"
                  : trustedEffectClassification === "invalid"
                    ? "mcp_effect_policy_invalid"
                : (bindingAvailability?.failureCode
                  ?? (healthState === "unavailable"
                    ? "mcp_definition_unavailable"
                    : "mcp_health_degraded")),
          }
        : {}),
    },
    discoveryTextTrust: "untrusted_remote",
    target: {
      executor: "mcp",
      bindingId: input.binding.id,
      bindingRevision: input.tool.bindingRevision,
      toolName: input.tool.exactToolName,
    },
    // Remote descriptions and schema descriptions are discovery data only.
    // observedAnnotations is intentionally absent.
    searchTextParts: [
      input.binding.displayName,
      input.binding.description,
      input.tool.description,
      input.tool.inputSchema,
      input.tool.outputSchema,
      input.tool.semanticMetadata,
    ],
  });
}

function classifyTrustedMcpEffectPolicy(effect: CapabilityEffectV3) {
  if (effect.boundary !== "external") return "invalid" as const;
  if (
    effect.mutation === "write"
    && effect.reversibility === "unknown"
  ) return "unknown" as const;
  return "classified" as const;
}

/**
 * Server-owned MCP effect registry. This is deliberately a narrow allowlist:
 * a newly discovered remote tool remains unavailable until Delegate or an
 * Owner-controlled, versioned policy classifies its effect. Remote
 * descriptions/annotations are never authority for this decision.
 */
export function resolveServerOwnedMcpCapabilityPolicyV3(input: {
  serverUrl: string;
  transportKind: string;
  toolName: string;
  toolSchemaHash: string;
}): CapabilityServerPolicyV3 | null {
  const endpoint = normalizeTrustedMcpEndpoint(input.serverUrl);
  const transportKind = input.transportKind.trim().toLowerCase();
  const toolName = input.toolName.trim().toLowerCase();
  const toolSchemaHash = stripSha256(input.toolSchemaHash);
  const expectedSchemaHash = DEEPWIKI_TRUSTED_TOOL_SCHEMA_HASHES[toolName];
  if (
    endpoint === DEEPWIKI_TRUSTED_ENDPOINT
    && transportKind === "streamable_http"
    && typeof expectedSchemaHash === "string"
    && toolSchemaHash === expectedSchemaHash
  ) {
    return {
      policyId: "delegate.mcp-policy.deepwiki.public-read.v1",
      classificationVersion: "delegate.mcp-effect.deepwiki.v2",
      effect: {
        boundary: "external",
        mutation: "none",
        reversibility: "not_applicable",
      },
      idempotency: "naturally_idempotent",
      successContract: {
        kind: "server_evaluator",
        evaluatorId: "mcp.deepwiki.read_semantic",
        evaluatorVersion: "2",
      },
    };
  }
  const openMeteoPolicy = OPEN_METEO_TRUSTED_TOOL_POLICIES[toolName];
  if (
    endpoint === OPEN_METEO_TRUSTED_ENDPOINT
    && transportKind === "streamable_http"
    && openMeteoPolicy
    && toolSchemaHash === openMeteoPolicy.schemaHash
  ) {
    return {
      policyId: "delegate.mcp.openmeteo.read.v1",
      classificationVersion: "delegate.mcp.openmeteo.effect.v1",
      effect: {
        boundary: "external",
        mutation: "none",
        reversibility: "not_applicable",
      },
      idempotency: "naturally_idempotent",
      successContract: openMeteoPolicy.successContract,
      semantics: openMeteoPolicy.semantics,
      ...(openMeteoPolicy.argumentDefaults
        ? { argumentDefaults: openMeteoPolicy.argumentDefaults }
        : {}),
    };
  }
  return null;
}

const DEEPWIKI_TRUSTED_ENDPOINT = "https://mcp.deepwiki.com/mcp";
const DEEPWIKI_TRUSTED_TOOL_SCHEMA_HASHES: Readonly<Record<string, string>> = {
  ask_question:
    "5f937ca02cb792c59d6f31b22d1e09db2a6412ee27b8e180a04c0bb38a24cd24",
  read_wiki_contents:
    "3fc0be2454d2c65d3ff7a7be36bb9fb4903931cbb9bfac6042696d0caf42cb00",
  read_wiki_structure:
    "3fc0be2454d2c65d3ff7a7be36bb9fb4903931cbb9bfac6042696d0caf42cb00",
};

const OPEN_METEO_TRUSTED_ENDPOINT = "https://open-meteo.caseyjhand.com/mcp";
const OPEN_METEO_TRUSTED_TOOL_POLICIES: Readonly<Record<
  string,
  {
    schemaHash: string;
    successContract: SuccessContractV3;
    semantics: CapabilitySemanticsV3;
    argumentDefaults?: Record<string, unknown>;
  }
>> = {
  openmeteo_search_locations: {
    schemaHash:
      "af23eb22e1651a38e705d9ceeff31faca25ef327324256088ca275b8d2849968",
    successContract: {
      kind: "success_schema",
      schema: {
        type: "object",
        properties: {
          results: { type: "array", items: {} },
          count: { type: "number" },
        },
        required: ["results", "count"],
      },
    },
    semantics: {
      operations: ["search"],
      evidenceClasses: ["capability_result", "current_external"],
      freshnessClasses: ["bounded", "live"],
      authorityClasses: ["external_authoritative"],
      domains: ["geocoding", "location", "weather"],
      aliases: [
        "location search",
        "place coordinates",
        "city coordinates",
        "地点搜索",
        "城市坐标",
      ],
    },
  },
  openmeteo_get_forecast: {
    schemaHash:
      "2840c6995fddbdcfcc96c3548add6fe4fa75aa44e0768368d41a05ba826c0af0",
    successContract: {
      kind: "success_schema",
      schema: {
        type: "object",
        properties: {
          latitude: { type: "number" },
          longitude: { type: "number" },
          timezone: { type: "string" },
          record_count: { type: "number" },
          truncated: { type: "boolean" },
        },
        required: [
          "latitude",
          "longitude",
          "timezone",
          "record_count",
          "truncated",
        ],
      },
    },
    semantics: {
      operations: ["read", "search"],
      evidenceClasses: ["capability_result", "current_external"],
      freshnessClasses: ["live"],
      authorityClasses: ["external_authoritative"],
      domains: ["weather", "weather forecast", "meteorology"],
      aliases: [
        "forecast",
        "current weather",
        "temperature",
        "precipitation",
        "天气",
        "天气预报",
        "气温",
        "降雨",
      ],
    },
    argumentDefaults: {
      hourly_variables: [
        "temperature_2m",
        "apparent_temperature",
        "relative_humidity_2m",
        "precipitation_probability",
        "weather_code",
        "wind_speed_10m",
      ],
    },
  },
};

function applyServerOwnedArgumentDefaultsV3(
  schema: Record<string, unknown>,
  defaults?: Record<string, unknown>,
) {
  if (!defaults || !Object.keys(defaults).length) return schema;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("Server-owned MCP argument defaults require an object input Schema.");
  }
  const nextProperties = { ...properties as Record<string, unknown> };
  for (const [key, value] of Object.entries(defaults)) {
    const property = nextProperties[key];
    if (!property || typeof property !== "object" || Array.isArray(property)) {
      throw new Error(`Server-owned MCP argument default ${key} is outside the Tool Schema.`);
    }
    nextProperties[key] = { ...property as Record<string, unknown>, default: value };
  }
  return { ...schema, properties: nextProperties };
}

function normalizeTrustedMcpEndpoint(value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.search
      || url.hash
    ) return null;
    const pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return `${url.origin.toLowerCase()}${pathname}`;
  } catch {
    return null;
  }
}

function stripSha256(value: string) {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}

export type WorkspaceSkillReleasePublicationInput = {
  representativeLink: {
    enabled: boolean;
    installedVersion: string | null;
  };
  install: {
    status: string;
    reviewStatus: string;
    installedVersion: string | null;
  };
  skill: {
    slug: string;
    source: string;
  };
  release: {
    id: string;
    version: string;
    status: string;
    displayName: string;
    summary: string;
    capabilityTags: string[];
    executesCode: boolean;
    registryTrustEligible: boolean;
    signatureStatus: string;
  };
  publishedPin: {
    slug: string;
    source: string;
    version: string;
  };
  runner?: {
    healthState: "ready" | "degraded" | "unavailable";
    checkedAt: string;
    runtimeRevision?: string;
    failureCode?: string;
  };
  serverPolicy?: CapabilityServerPolicyV3 & {
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    semantics?: CapabilitySemanticsV3;
  };
};

/**
 * Publishes an immutable, release-pinned Skill definition. Today the public
 * runtime has no production Skill runner, so callers that omit `runner`
 * receive an explicitly unavailable publication rather than implicit code
 * execution permission.
 */
export function buildWorkspaceSkillCapabilityPublicationV3(
  input: WorkspaceSkillReleasePublicationInput,
): CapabilityPublicationV3 {
  const key = `skill.${normalizeCapabilityKeySegmentV3(input.skill.slug)}`;
  const policy = input.serverPolicy ?? unclassifiedExternalPolicy();
  const semantics = resolveCapabilitySemantics(
    input.serverPolicy?.semantics,
    {
      operations: [],
      evidenceClasses: ["capability_result"],
      freshnessClasses: ["stable"],
      authorityClasses: ["owner_authorized"],
      domains: input.release.capabilityTags,
      aliases: [
        input.skill.slug,
        input.release.displayName,
        ...input.release.capabilityTags,
      ],
    },
  );
  const trustFailure = resolveSkillPublicationFailure(input);
  const runner = input.runner ?? {
    healthState: "unavailable" as const,
    checkedAt: new Date(0).toISOString(),
    failureCode: "skill_runner_unavailable",
  };
  const healthState = trustFailure ? "unavailable" as const : runner.healthState;
  return createCapabilityPublicationV3({
    definition: {
      key,
      version: input.release.version,
      description: `${input.release.displayName}: ${input.release.summary}`
        .trim()
        .slice(0, 2_000),
      executor: "skill",
      inputSchema: input.serverPolicy?.inputSchema
        ? derivePlannerCapabilitySchema(input.serverPolicy.inputSchema, {
            closeObjects: true,
          })
        : closedObjectSchema({ request: { type: "string" } }, ["request"]),
      outputSchema: input.serverPolicy?.outputSchema
        ? derivePlannerCapabilitySchema(input.serverPolicy.outputSchema, {
            closeObjects: false,
          })
        : closedObjectSchema({ result: {} }, ["result"]),
      effect: policy.effect,
      idempotency: policy.idempotency,
      ...(policy.successContract
        ? { successContract: policy.successContract }
        : {}),
      supportedChannels:
        policy.supportedChannels ?? supportedConversationChannels,
      requiredIdentityScopes: policy.requiredIdentityScopes ?? [],
      requiredDataScopes: policy.requiredDataScopes ?? [],
      tags: [input.skill.slug, ...input.release.capabilityTags],
      semantics,
      canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
    },
    semantics,
    availability: {
      healthState,
      checkedAt: latestIsoDate(normalizeOptionalIsoDate(runner.checkedAt)),
      ...(runner.runtimeRevision
        ? { runtimeRevision: runner.runtimeRevision }
        : {}),
      ...(healthState !== "ready"
        ? {
            failureCode:
              trustFailure
              ?? runner.failureCode
              ?? "skill_runtime_degraded",
          }
        : {}),
    },
    discoveryTextTrust:
      input.skill.source.trim().toLowerCase() === "builtin"
        ? "server_defined"
        : "untrusted_remote",
    target: {
      executor: "skill",
      skillSlug: input.skill.slug,
      releaseId: input.release.id,
    },
    searchTextParts: [
      input.release.displayName,
      input.release.summary,
      input.release.capabilityTags,
    ],
  });
}

export function normalizeCapabilityKeySegmentV3(value: string) {
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 80);
  if (!normalized) {
    throw new Error("Capability coordinate contains an empty segment.");
  }
  return /^[a-z]/u.test(normalized) ? normalized : `c_${normalized}`;
}

function resolveMcpToolHealthState(input: {
  binding: RepresentativeRuntimeMcpBindingGrant;
  tool: NonNullable<RepresentativeRuntimeMcpBindingGrant["toolDefinitions"]>[number];
  toolObservedAt: string | null;
  bindingCheckedAt: string | null;
}) {
  if (
    !input.binding.enabled
    || input.binding.configRevision !== undefined
      && input.binding.configRevision !== input.tool.bindingRevision
  ) {
    return "unavailable" as const;
  }
  const bindingHealth = input.binding.availability?.healthState;
  if (bindingHealth === "unavailable") return "unavailable" as const;
  // Binding health is written with request-generation/start-time monotonicity.
  // If it says degraded, a later-started failure may have beaten this tools/list
  // completion even when wall-clock completion timestamps overlap.
  if (bindingHealth === "degraded") {
    if (
      input.toolObservedAt
      && input.bindingCheckedAt
      && Date.parse(input.toolObservedAt) > Date.parse(input.bindingCheckedAt)
    ) return "ready" as const;
    return "degraded" as const;
  }
  if (bindingHealth === "ready") return "ready" as const;
  // A successful tools/list synchronization is itself fresh availability
  // evidence when no newer monotonic binding observation exists.
  if (input.toolObservedAt) return "ready" as const;
  return bindingHealth ?? "degraded" as const;
}

function resolveSkillPublicationFailure(
  input: WorkspaceSkillReleasePublicationInput,
): string | null {
  if (!input.representativeLink.enabled) return "skill_binding_disabled";
  if (input.install.status.toUpperCase() === "ARCHIVED") {
    return "skill_install_archived";
  }
  if (
    input.install.reviewStatus.toUpperCase() !== "APPROVED"
    && input.install.status.toUpperCase() !== "UPDATE_AVAILABLE"
  ) {
    return "skill_owner_review_required";
  }
  if (input.release.status.toUpperCase() !== "INSTALLED") {
    return "skill_release_not_installed";
  }
  if (input.release.executesCode) return "skill_executable_release_blocked";
  const source = input.skill.source.trim().toUpperCase();
  const signature = input.release.signatureStatus.trim().toUpperCase();
  if (
    source === "CLAWHUB"
    && !input.release.registryTrustEligible
    && signature !== "VERIFIED"
  ) {
    return "skill_release_untrusted";
  }
  if (
    input.publishedPin.slug !== input.skill.slug
    || input.publishedPin.source.toLowerCase() !== input.skill.source.toLowerCase()
    || input.publishedPin.version !== input.release.version
    || input.representativeLink.installedVersion !== input.release.version
    || input.install.installedVersion !== input.release.version
  ) {
    return "skill_release_pin_mismatch";
  }
  return null;
}

function resolveCapabilitySemantics(
  value: unknown,
  fallback: CapabilitySemanticsV3,
): CapabilitySemanticsV3 {
  const parsed = capabilitySemanticsV3Schema.safeParse(value);
  return parsed.success ? parsed.data : capabilitySemanticsV3Schema.parse(fallback);
}

function buildMcpCapabilityDescription(
  binding: RepresentativeRuntimeMcpBindingGrant,
  tool: NonNullable<RepresentativeRuntimeMcpBindingGrant["toolDefinitions"]>[number],
) {
  // Remote descriptions are mutable and untrusted. They belong exclusively
  // to the discovery sidecar, not the immutable capability definition whose
  // hash authorizes compilation and execution.
  return `Published MCP tool ${tool.exactToolName} on ${binding.displayName ?? binding.slug}.`;
}

function unclassifiedExternalPolicy(): CapabilityServerPolicyV3 {
  return {
    policyId: "unclassified",
    classificationVersion: "unclassified",
    effect: {
      boundary: "external",
      mutation: "write",
      reversibility: "unknown",
    },
    idempotency: "non_idempotent",
  };
}

function normalizeSha256(value: string) {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function normalizeOptionalIsoDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : null;
}

function latestIsoDate(...values: Array<string | null>) {
  const latest = values.reduce((maximum, value) => {
    const timestamp = value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
    return Number.isFinite(timestamp) && timestamp > maximum ? timestamp : maximum;
  }, Number.NEGATIVE_INFINITY);
  return Number.isFinite(latest)
    ? new Date(latest).toISOString()
    : new Date(0).toISOString();
}

function stripUntrustedSchemaAnnotations(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(visit);
    if (!current || typeof current !== "object") return current;
    return Object.fromEntries(Object.entries(current as Record<string, unknown>)
      .flatMap(([key, nested]) =>
        key === "description" || key === "title"
          ? []
          : [[key, visit(nested)]]));
  };
  return visit(value) as Record<string, unknown>;
}

function closedObjectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

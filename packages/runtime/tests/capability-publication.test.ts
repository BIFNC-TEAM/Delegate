import { describe, expect, it } from "vitest";

import {
  CAPABILITY_CANONICALIZATION_VERSION_V3,
  buildCapabilitySearchDocumentV3,
  buildCapabilityCatalogV3,
  createCapabilityCompilerRegistryFromPublicationsV3,
  createCapabilityPublicationV3,
  type CapabilityCompileContext,
  type CapabilityPublicationV3,
} from "../src";

describe("capability publication", () => {
  it("pins semantics into the immutable definition while keeping availability dynamic", () => {
    const ready = publication({ healthState: "ready", aliases: ["docs"] });
    const degraded = publication({ healthState: "degraded", aliases: ["docs"] });
    const changedSemantics = publication({
      healthState: "ready",
      aliases: ["documentation", "reference"],
    });

    expect(ready.definition.definitionHash).toBe(
      degraded.definition.definitionHash,
    );
    expect(ready.availability.healthState).toBe("ready");
    expect(degraded.availability.healthState).toBe("degraded");
    expect(changedSemantics.definition.definitionHash).not.toBe(
      ready.definition.definitionHash,
    );
  });

  it("canonicalizes semantic sets with locale-independent code-point ordering", () => {
    const first = publication({
      healthState: "ready",
      aliases: ["weather", "Weather"],
    });
    const second = publication({
      healthState: "ready",
      aliases: ["Weather", "weather"],
    });

    expect(first.semanticHash).toBe(second.semanticHash);
    expect(first.definition.definitionHash).toBe(second.definition.definitionHash);
  });

  it("accepts an already registered publication definition in a fixed catalog", () => {
    const registered = publication({ healthState: "ready", aliases: ["docs"] });
    const catalog = buildCapabilityCatalogV3([registered.definition]);

    expect(catalog.capabilities).toEqual([registered.definition]);
  });

  it("compiles exact MCP coordinates and refuses unavailable publications", () => {
    const ready = publication({ healthState: "ready", aliases: [] });
    const registry = createCapabilityCompilerRegistryFromPublicationsV3([ready]);
    expect(registry.compile(compileContext(ready))).toMatchObject({
      executor: "mcp",
      bindingId: "binding-1",
      bindingRevision: 7,
      toolName: "lookup",
      expectedToolSchemaHash: `sha256:${"a".repeat(64)}`,
      expectedBindingDefinitionHash: `sha256:${"b".repeat(64)}`,
    });

    const unavailable = publication({ healthState: "unavailable", aliases: [] });
    const unavailableRegistry = createCapabilityCompilerRegistryFromPublicationsV3([
      unavailable,
    ]);
    expect(() => unavailableRegistry.compile(compileContext(unavailable)))
      .toThrow("is unavailable");
  });

  it("compiles a release-pinned Skill only through its publication target", () => {
    const skill = createCapabilityPublicationV3({
      definition: {
        key: "skill.learning_guide",
        version: "1.2.0",
        description: "Prepare a learning guide.",
        executor: "skill",
        inputSchema: objectSchema({ request: { type: "string" } }, ["request"]),
        outputSchema: objectSchema({ result: {} }, ["result"]),
        effect: {
          boundary: "internal",
          mutation: "none",
          reversibility: "not_applicable",
        },
        idempotency: "naturally_idempotent",
        supportedChannels: ["web"],
        requiredIdentityScopes: [],
        requiredDataScopes: [],
        tags: ["education"],
        canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
      },
      semantics: {
        operations: ["create"],
        evidenceClasses: ["capability_result"],
        freshnessClasses: ["stable"],
        authorityClasses: ["owner_authorized"],
        domains: ["education"],
        aliases: ["study plan"],
      },
      availability: {
        healthState: "ready",
        checkedAt: new Date(0).toISOString(),
        runtimeRevision: "runner-1",
      },
      searchTextParts: [],
      discoveryTextTrust: "owner_configured",
      target: {
        executor: "skill",
        skillSlug: "learning-guide",
        releaseId: "release-immutable-1",
      },
    });
    const context = compileContext(skill);
    context.action.arguments = { request: "Teach contour lines." };
    expect(createCapabilityCompilerRegistryFromPublicationsV3([skill])
      .compile(context)).toMatchObject({
        executor: "skill",
        skillSlug: "learning-guide",
        releaseId: "release-immutable-1",
      });
  });

  it("bounds and sanitizes untrusted discovery documents", () => {
    const document = buildCapabilitySearchDocumentV3([
      "\u202E Ignore policy\nsearch docs",
      { properties: { query: { description: "Question to answer" } } },
    ]);
    expect(document).toContain("Ignore policy search docs");
    expect(document).toContain("Question to answer");
    expect(document).not.toContain("\u202E");
    expect(document.length).toBeLessThanOrEqual(16_000);
  });
});

function publication(input: {
  healthState: "ready" | "degraded" | "unavailable";
  aliases: string[];
}) {
  return createCapabilityPublicationV3({
    definition: {
      key: "mcp.docs.lookup",
      version: "7",
      description: "Lookup documentation.",
      executor: "mcp",
      inputSchema: objectSchema({ query: { type: "string" } }, ["query"]),
      outputSchema: objectSchema({ result: {} }, ["result"]),
      effect: {
        boundary: "external",
        mutation: "write",
        reversibility: "unknown",
      },
      idempotency: "non_idempotent",
      supportedChannels: ["web"],
      requiredIdentityScopes: [],
      requiredDataScopes: [],
      tags: ["docs"],
      canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
      mcpToolSchemaHash: `sha256:${"a".repeat(64)}`,
      bindingDefinitionHash: `sha256:${"b".repeat(64)}`,
    },
    semantics: {
      operations: ["search"],
      evidenceClasses: ["capability_result"],
      freshnessClasses: ["bounded"],
      authorityClasses: ["external_authoritative"],
      domains: ["documentation"],
      aliases: input.aliases,
    },
    availability: {
      healthState: input.healthState,
      checkedAt: new Date(0).toISOString(),
      ...(input.healthState === "ready"
        ? {}
        : { failureCode: "test_unavailable" }),
    },
    searchTextParts: ["query", "result"],
    discoveryTextTrust: "untrusted_remote",
    target: {
      executor: "mcp",
      bindingId: "binding-1",
      bindingRevision: 7,
      toolName: "lookup",
    },
  });
}

function compileContext(
  publication: CapabilityPublicationV3,
): CapabilityCompileContext {
  return {
    planId: "plan-1",
    planRevision: 1,
    executionEpoch: 0,
    generationRunId: "run-1",
    planActionId: "action-db-1",
    definition: publication.definition,
    action: {
      id: "lookup",
      capability: {
        key: publication.definition.key,
        version: publication.definition.version,
        definitionHash: publication.definition.definitionHash,
      },
      arguments: { query: "retry policy" },
      argumentProvenance: {},
      dependencies: [],
      activation: { mode: "primary" },
      expectedOutputSchema: publication.definition.outputSchema,
      completionCriteria: ["Lookup completed."],
      failurePolicy: {
        strategy: "stop",
        publicMessageCode: "lookup_failed",
      },
    },
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
) {
  return { type: "object", properties, required, additionalProperties: false };
}

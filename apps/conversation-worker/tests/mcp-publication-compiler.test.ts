import { describe, expect, it, vi } from "vitest";

import {
  buildCapabilityDiscoveryDocumentV3,
  planTurnV3,
  type StrictPlannerAdapter,
} from "@delegate/model-runtime";
import {
  CAPABILITY_CANONICALIZATION_VERSION_V3,
  buildCapabilityCatalog,
  buildCapabilityAvailabilitySnapshotV3,
  buildCapabilityCatalogV3,
  createCapabilityCompilerRegistryFromPublicationsV3,
  stableSha256,
  turnEnvelopeSchema,
} from "@delegate/runtime";
import { buildMcpToolCapabilityPublicationV3 } from "@delegate/web-data";

describe("published MCP capability to compiler contract", () => {
  it.each(["repoName"] as const)(
    "materializes %s and question from the current message without a scenario router",
    async (repositoryField) => {
      const userText =
        "查询 openai/openai-python 仓库中 AsyncOpenAI 的重试机制";
      const inputSchema = {
        type: "object",
        required: [repositoryField, "question"],
        properties: {
          [repositoryField]: {
            anyOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "GitHub repository or list of repositories (max 10) in owner/repo format.",
          },
          question: {
            type: "string",
            description: "The question to ask about the repository.",
          },
        },
      };
      const outputSchema = {
        type: "object",
        required: ["result"],
        properties: { result: { type: "string" } },
        "x-fastmcp-wrap-result": true,
      };
      const toolSchemaHash =
        "5f937ca02cb792c59d6f31b22d1e09db2a6412ee27b8e180a04c0bb38a24cd24";
      const bindingDefinitionHash =
        "852197670fcb21b0d2c72fdaeb71dcace53206c3e057019fa6fabe86de6075a8";
      expect(stableSha256({ inputSchema, outputSchema })).toBe(
        `sha256:${toolSchemaHash}`,
      );
      const publication = buildMcpToolCapabilityPublicationV3({
        binding: {
          id: "cmszinyy30001r34l3le0ims1",
          slug: "deepwiki",
          displayName: "DeepWiki",
          description: "Read source repository documentation.",
          serverUrl: "https://mcp.deepwiki.com/mcp",
          transportKind: "streamable_http",
          allowedToolNames: ["ask_question"],
          defaultToolName: "ask_question",
          enabled: true,
          approvalRequired: true,
          estimatedTokensPerCall: 200,
          maxRetries: 0,
          retryBackoffMs: 1_000,
          configRevision: 1,
        },
        tool: {
          exactToolName: "ask_question",
          description:
            "Ask a question about a source-code repository and explain its implementation.",
          inputSchema,
          outputSchema,
          toolSchemaHash,
          bindingDefinitionHash,
          bindingRevision: 1,
          canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
          observedAt: "2026-08-25T03:00:00.000Z",
        },
      });
      const composer = {
        key: "response.compose",
        version: "1",
        description: "Compose a verified response.",
        executor: "builtin" as const,
        inputSchema: closedObject({}, []),
        outputSchema: closedObject({
          segments: { type: "array", items: { type: "object" } },
        }, ["segments"]),
        effect: {
          boundary: "internal" as const,
          mutation: "none" as const,
          reversibility: "not_applicable" as const,
        },
        idempotency: "naturally_idempotent" as const,
        successContract: {
          kind: "success_schema" as const,
          schema: closedObject({
            segments: { type: "array", items: { type: "object" } },
          }, ["segments"]),
        },
        supportedChannels: ["web"],
        requiredIdentityScopes: [],
        requiredDataScopes: [],
        tags: ["response"],
        semantics: {
          operations: ["answer" as const],
          evidenceClasses: ["capability_result" as const],
          freshnessClasses: ["bounded" as const],
          authorityClasses: ["general" as const],
          domains: ["response"],
          aliases: ["answer"],
        },
        canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
      };
      const catalog = buildCapabilityCatalogV3([
        publication.definition,
        composer,
      ]);
      const referenceTime = "2026-08-25T03:00:01.000Z";
      const availabilitySnapshot = buildCapabilityAvailabilitySnapshotV3({
        catalog,
        observedAt: referenceTime,
        capabilities: [publication.availability],
      });
      const discovery = buildCapabilityDiscoveryDocumentV3({
        definitionHash: publication.definition.definitionHash,
        searchDocument: publication.searchDocument,
        trust: "third_party_untrusted",
      });
      const adapter: StrictPlannerAdapter = {
        provider: "fixture",
        model: "strict-mcp-selection",
        supportsStrictStructuredOutput: true,
        generateStrictObject: vi.fn(async (request) => {
          const plannerInput = JSON.parse(request.input);
          const candidate = plannerInput.plannerCandidates.find(
            (item: { key: string }) =>
              item.key === publication.definition.key,
          );
          if (!candidate) throw new Error("Published MCP candidate missing.");
          if (!candidate.untrustedDiscoverySummary) {
            throw new Error(`Discovery summary missing: ${JSON.stringify(candidate)}`);
          }
          if (!String(candidate.untrustedDiscoverySummary.text).includes("source-code repository")) {
            throw new Error(`Unexpected discovery summary: ${JSON.stringify(candidate)}`);
          }
          if (
            candidate.version
              !== "1:delegate.mcp-policy.deepwiki.public-read.v1:delegate.mcp-effect.deepwiki.v1"
          ) {
            throw new Error(`Unexpected candidate: ${JSON.stringify(candidate)}`);
          }
          expect(candidate.key).toBe("mcp.deepwiki.ask_question");
          expect(candidate.version).toBe(
            "1:delegate.mcp-policy.deepwiki.public-read.v1:delegate.mcp-effect.deepwiki.v1",
          );
          expect(candidate.definitionHash).toBe(
            publication.definition.definitionHash,
          );
          expect(candidate.inputSchema.type).toBe("object");
          expect(candidate.inputSchema.required).toEqual([
            repositoryField,
            "question",
          ]);
          expect(candidate.inputSchema.properties[repositoryField].anyOf)
            .toEqual([
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ]);
          expect(candidate.inputSchema.properties.question.type).toBe("string");
          expect(candidate.untrustedDiscoverySummary).toMatchObject({
            contentClass: "untrusted_capability_discovery_data",
            trust: "third_party_untrusted",
            text: expect.stringContaining("source-code repository"),
          });
          return {
            protocolVersion: 3,
            objective: "Read the requested repository implementation.",
            goals: [{
              id: "repository-goal",
              objective: "Explain AsyncOpenAI retry behavior.",
              sourcePointers: ["/currentMessage/text"],
              strategy: "capability",
              operation: "search",
              semanticConfidence: 0.98,
              generalEligibility: "not_allowed",
              evidenceRequirement: {
                kind: "capability_result",
                freshness: "bounded",
                allowedSourceKinds: ["tool_output"],
                citationRequired: true,
                minimumEvidenceCount: 1,
              },
              failurePolicy: {
                strategy: "stop",
                reasonCode: "repository_lookup_failed",
              },
            }],
            capabilitySelections: [{
              id: "selected-published-tool",
              capabilityKey: publication.definition.key,
              capabilityVersion: publication.definition.version,
              goalIds: ["repository-goal"],
              // The server-owned materializer, not the model, must bind both
              // required fields from the current message.
              argumentsJson: "{}",
            }],
            decisionTrace: ["selected_from_published_capability"],
          };
        }),
      };
      const envelope = turnEnvelopeSchema.parse({
        currentMessage: { id: "message-1", text: userText, language: "zh" },
        attachments: [],
        recentTurns: [],
        conversationSummary: null,
        activeCollector: null,
        activeTask: null,
        pendingApproval: null,
        activeHandoff: null,
        actorIdentity: { contactId: "contact-1" },
        authority: { identityScopes: [], dataScopes: [] },
        channel: { kind: "web", supportsAttachments: true },
        representativeVersion: { representativeId: "rep-1", version: "v1" },
        serviceState: { available: true },
        authorizedContext: [],
        capabilitySnapshot: buildCapabilityCatalog(),
      });
      const planned = await planTurnV3({
        envelope,
        catalog,
        availabilitySnapshot,
        availabilityReferenceTime: referenceTime,
        discoveryDocuments: [discovery],
        scopeKey: {
          kind: "generation_turn",
          conversationId: "conversation-1",
          inputMessageId: "message-1",
        },
        revision: 1,
        planId: "plan-publication-compiler",
        adapter,
      });
      if (!planned.ok) {
        throw new Error(`Published MCP plan failed: ${JSON.stringify(planned)}`);
      }
      const action = planned.plan.actions.find((candidate) =>
        candidate.capability.key === publication.definition.key)!;
      expect(action.arguments).toEqual({
        [repositoryField]: "openai/openai-python",
        question: userText,
      });
      const request = createCapabilityCompilerRegistryFromPublicationsV3([
        publication,
      ]).compile({
        planId: planned.plan.planId,
        planRevision: planned.plan.revision,
        executionEpoch: 1,
        generationRunId: "run-1",
        planActionId: "plan-action-db-1",
        action,
        definition: publication.definition,
      });
      expect(request).toMatchObject({
        executor: "mcp",
        bindingId: "cmszinyy30001r34l3le0ims1",
        bindingRevision: 1,
        toolName: "ask_question",
        capabilityDefinitionHash: publication.definition.definitionHash,
        expectedToolSchemaHash: publication.definition.mcpToolSchemaHash,
        expectedBindingDefinitionHash:
          publication.definition.bindingDefinitionHash,
        toolArguments: {
          [repositoryField]: "openai/openai-python",
          question: userText,
        },
      });
      expect(publication.definition.definitionHash)
        .not.toBe(publication.definition.mcpToolSchemaHash);
      expect(publication.definition.mcpToolSchemaHash)
        .not.toBe(publication.definition.bindingDefinitionHash);
      expect(publication.definition.effect).toEqual({
        boundary: "external",
        mutation: "none",
        reversibility: "not_applicable",
      });
      expect(publication.target).toMatchObject({
        executor: "mcp",
        bindingRevision: 1,
      });
      expect(publication.availability.healthState).toBe("ready");
    },
  );
});

function closedObject(
  properties: Record<string, unknown>,
  required: string[],
) {
  return { type: "object", properties, required, additionalProperties: false };
}

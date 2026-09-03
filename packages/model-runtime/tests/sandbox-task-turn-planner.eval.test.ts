import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

import { describe, expect, it } from "vitest";

import {
  buildCapabilityAvailabilitySnapshotV3,
  buildCapabilityCatalog,
  buildCapabilityCatalogV3,
  CAPABILITY_CANONICALIZATION_VERSION_V3,
  defaultTurnConstraints,
  turnEnvelopeSchema,
  type CapabilityDefinitionDraftV3,
} from "@delegate/runtime";

import { planTurnV3 } from "../src/turn-planner-v3";

const live = process.env.RUN_LIVE_SANDBOX_TASK_EVAL === "true";
if (live) {
  try {
    loadEnvFile(resolve(import.meta.dirname, "../../../.env"));
  } catch {
    // The readiness assertion reports missing model configuration safely.
  }
}

describe.skipIf(!live)("sandbox task TurnPlan V3 live eval", () => {
  it("selects compute.exec v2 and grounds the complete instruction", async () => {
    const instruction = "请使用 Compute 工具在沙箱里计算 1 到 1000 之间质数的数量，并返回前 20 个质数。";
    const catalog = taskCatalog();
    const result = await planTurnV3({
      envelope: envelope(instruction),
      catalog,
      availabilitySnapshot: readyAvailability(catalog),
      scopeKey: {
        kind: "generation_turn",
        conversationId: "conversation-task-eval",
        inputMessageId: "message-task-eval",
      },
      revision: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          capability: expect.objectContaining({ key: "compute.task", version: "1" }),
          arguments: { instruction },
        }),
      ]));
    }
  }, 120_000);

  it("does not select compute for an explicit explanation-only request", async () => {
    const catalog = taskCatalog();
    const result = await planTurnV3({
      envelope: envelope("请解释什么是质数，不要使用任何工具。", "forbidden"),
      catalog,
      availabilitySnapshot: readyAvailability(catalog),
      scopeKey: {
        kind: "generation_turn",
        conversationId: "conversation-explain-eval",
        inputMessageId: "message-explain-eval",
      },
      revision: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.actions.some((action) => action.capability.key === "compute.task"))
        .toBe(false);
    }
  }, 120_000);
});

function taskCatalog() {
  return buildCapabilityCatalogV3([taskDraft(), composerDraft()]);
}

function taskDraft(): CapabilityDefinitionDraftV3 {
  return {
    key: "compute.task",
    version: "1",
    description: "Compile and execute one self-contained natural-language Python computation in an isolated sandbox. 自然语言触发沙箱计算。",
    executor: "compute",
    inputSchema: closedObject({ instruction: { type: "string" } }, ["instruction"]),
    outputSchema: closedObject({
      exitCode: { type: "number" },
      artifactRefs: { type: "array", items: { type: "string" } },
    }, ["exitCode", "artifactRefs"]),
    effect: { boundary: "internal", mutation: "write", reversibility: "not_applicable" },
    idempotency: "requires_key",
    supportedChannels: ["web"],
    requiredIdentityScopes: [],
    requiredDataScopes: [],
    tags: ["calculate", "analysis", "计算", "分析", "沙箱任务"],
    semantics: {
      operations: ["answer", "create"],
      evidenceClasses: ["capability_result"],
      freshnessClasses: ["bounded"],
      authorityClasses: ["general"],
      domains: ["self-contained computation"],
      aliases: ["calculate", "analyze", "计算", "分析"],
    },
    canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
  };
}

function composerDraft(): CapabilityDefinitionDraftV3 {
  return {
    key: "response.compose",
    version: "1",
    description: "Compose one evidence-bound response from verified action results.",
    executor: "builtin",
    inputSchema: closedObject({}, []),
    outputSchema: closedObject({
      segments: { type: "array", items: { type: "object" }, minItems: 1 },
    }, ["segments"]),
    effect: { boundary: "internal", mutation: "none", reversibility: "not_applicable" },
    idempotency: "naturally_idempotent",
    supportedChannels: ["web"],
    requiredIdentityScopes: [],
    requiredDataScopes: [],
    tags: ["response", "compose", "回答"],
    semantics: {
      operations: ["answer", "explain", "deliver"],
      evidenceClasses: ["none", "capability_result"],
      freshnessClasses: ["stable", "bounded"],
      authorityClasses: ["general"],
      domains: ["response composition"],
      aliases: ["回答", "总结", "compose"],
    },
    canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
  };
}

function envelope(text: string, toolPolicy: "auto" | "forbidden" = "auto") {
  return turnEnvelopeSchema.parse({
    currentMessage: { id: "message-1", text, language: "zh" },
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
    planningDefaults: { managedDocumentFormat: "markdown", knowledgePolicy: "prefer_authorized" },
    authorizedContext: [],
    turnConstraints: toolPolicy === "auto"
      ? defaultTurnConstraints
      : {
          scope: "turn",
          toolPolicy: "forbidden",
          source: "explicit_user_instruction",
          sourcePointers: ["/currentMessage/text"],
        },
    capabilitySnapshot: buildCapabilityCatalog(),
  });
}

function readyAvailability(catalog: ReturnType<typeof taskCatalog>) {
  const checkedAt = new Date().toISOString();
  return buildCapabilityAvailabilitySnapshotV3({
    catalog,
    observedAt: checkedAt,
    capabilities: catalog.capabilities.map((definition) => ({
      capabilityKey: definition.key,
      capabilityVersion: definition.version,
      definitionHash: definition.definitionHash,
      healthState: "ready" as const,
      checkedAt,
    })),
  });
}

function closedObject(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", properties, required, additionalProperties: false };
}

import { describe, expect, it } from "vitest";

import {
  CAPABILITY_CANONICALIZATION_VERSION_V3,
  buildCapabilityAvailabilitySnapshotV3,
  buildCapabilityCatalogV3,
  capabilityCatalogV3Schema,
  capabilityDefinitionV3Schema,
  evaluateCapabilitySemanticsCompatibilityV3,
  goalEvidenceFallbackPolicyV3Schema,
  isEffectWithinApprovalCeiling,
  stableSha256,
  validateTurnPlanV3,
  type CapabilityCatalogV3,
  type CapabilityDefinitionDraftV3,
  type TurnPlanV3,
} from "../src";

describe("TurnPlan V3 contract", () => {
  it("publishes normalized immutable semantics and defaults legacy drafts safely", () => {
    const legacy = buildCapabilityCatalogV3([definitionDraft()]).capabilities[0]!;
    expect(legacy.semantics).toEqual({
      operations: [],
      evidenceClasses: [],
      freshnessClasses: [],
      authorityClasses: [],
      domains: [],
      aliases: [],
    });

    const classified = buildCapabilityCatalogV3([definitionDraft({
      semantics: {
        operations: ["search", "read", "search"],
        evidenceClasses: ["current_external"],
        freshnessClasses: ["live"],
        authorityClasses: ["external_authoritative"],
        domains: [" Weather ", "weather"],
        aliases: ["forecast", "weather lookup"],
      },
    })]).capabilities[0]!;
    expect(classified.semantics).toEqual({
      operations: ["read", "search"],
      evidenceClasses: ["current_external"],
      freshnessClasses: ["live"],
      authorityClasses: ["external_authoritative"],
      domains: ["weather"],
      aliases: ["forecast", "weather lookup"],
    });
    expect(classified.definitionHash).not.toBe(legacy.definitionHash);
  });

  it("rejects oversized immutable definitions and catalogs before planning", () => {
    expect(() => buildCapabilityCatalogV3([definitionDraft({
      inputSchema: closedObjectSchema({
        query: { type: "string", description: "x".repeat(70_000) },
      }, ["query"]),
    })])).toThrow("definition exceeds");

    expect(() => buildCapabilityCatalogV3(Array.from({ length: 40 }, (_, index) =>
      definitionDraft({
        key: `tool.budget_${index}.read`,
        inputSchema: closedObjectSchema({
          query: { type: "string", description: "x".repeat(55_000) },
        }, ["query"]),
      })))).toThrow("catalog exceeds");
  });

  it("evaluates generic semantic compatibility and surfaces legacy uncertainty", () => {
    expect(evaluateCapabilitySemanticsCompatibilityV3({
      operations: ["search"],
      evidenceClasses: ["current_external"],
      freshnessClasses: ["live"],
      authorityClasses: ["external_authoritative"],
      domains: [],
      aliases: [],
    }, {
      operations: ["read", "search"],
      evidenceClasses: ["current_external"],
      freshnessClasses: ["bounded"],
      authorityClasses: ["external_authoritative"],
    })).toEqual({ compatible: true, mismatches: [], unclassified: [] });

    expect(evaluateCapabilitySemanticsCompatibilityV3({
      operations: ["search"],
      evidenceClasses: ["authorized_knowledge"],
      freshnessClasses: ["stable"],
      authorityClasses: ["owner_authorized"],
      domains: [],
      aliases: [],
    }, {
      evidenceClasses: ["transactional_authority"],
      freshnessClasses: ["live"],
      authorityClasses: ["transactional"],
    })).toMatchObject({
      compatible: false,
      mismatches: ["evidenceClasses", "freshnessClasses", "authorityClasses"],
    });

    expect(evaluateCapabilitySemanticsCompatibilityV3({
      operations: [],
      evidenceClasses: [],
      freshnessClasses: [],
      authorityClasses: [],
      domains: [],
      aliases: [],
    }, { operations: ["search"] })).toEqual({
      compatible: true,
      mismatches: [],
      unclassified: ["operations"],
    });

    expect(evaluateCapabilitySemanticsCompatibilityV3({
      operations: [],
      evidenceClasses: [],
      freshnessClasses: [],
      authorityClasses: [],
      domains: [],
      aliases: [],
    }, {
      evidenceClasses: ["transactional_authority"],
      freshnessClasses: ["live"],
      authorityClasses: ["transactional"],
    })).toMatchObject({
      compatible: false,
      mismatches: ["evidenceClasses", "freshnessClasses", "authorityClasses"],
      unclassified: ["evidenceClasses", "freshnessClasses", "authorityClasses"],
    });
  });
  it("compares approval effects as a partial order and never accepts unknown writes", () => {
    expect(isEffectWithinApprovalCeiling(
      { boundary: "internal", mutation: "none", reversibility: "not_applicable" },
      { boundary: "internal", mutation: "write", reversibility: "not_applicable" },
    )).toBe(true);
    expect(isEffectWithinApprovalCeiling(
      { boundary: "internal", mutation: "write", reversibility: "not_applicable" },
      { boundary: "external", mutation: "write", reversibility: "irreversible" },
    )).toBe(false);
    expect(isEffectWithinApprovalCeiling(
      { boundary: "external", mutation: "write", reversibility: "reversible" },
      { boundary: "external", mutation: "write", reversibility: "irreversible" },
    )).toBe(true);
    expect(isEffectWithinApprovalCeiling(
      { boundary: "external", mutation: "write", reversibility: "unknown" },
      { boundary: "external", mutation: "write", reversibility: "unknown" },
    )).toBe(false);
  });
  it("keeps dynamic availability outside immutable definition and catalog hashes", () => {
    const catalog = buildCatalog();
    const definition = catalog.capabilities[0]!;
    const ready = buildCapabilityAvailabilitySnapshotV3({
      catalog,
      observedAt: "2026-08-21T08:00:00.000Z",
      capabilities: [{
        capabilityKey: definition.key,
        capabilityVersion: definition.version,
        definitionHash: definition.definitionHash,
        healthState: "ready",
        checkedAt: "2026-08-21T08:00:00.000Z",
        runtimeRevision: "runtime-1",
      }],
    });
    const unavailable = buildCapabilityAvailabilitySnapshotV3({
      catalog,
      observedAt: "2026-08-21T08:01:00.000Z",
      capabilities: [{
        capabilityKey: definition.key,
        capabilityVersion: definition.version,
        definitionHash: definition.definitionHash,
        healthState: "unavailable",
        checkedAt: "2026-08-21T08:01:00.000Z",
        runtimeRevision: "runtime-2",
        failureCode: "provider_unavailable",
      }],
    });

    expect(ready.catalogHash).toBe(catalog.catalogHash);
    expect(unavailable.catalogHash).toBe(catalog.catalogHash);
    expect(ready.capabilities[0]?.healthState).toBe("ready");
    expect(unavailable.capabilities[0]?.healthState).toBe("unavailable");
  });

  it("requires availability to reference the exact immutable definition", () => {
    const catalog = buildCatalog();
    const definition = catalog.capabilities[0]!;
    expect(() => buildCapabilityAvailabilitySnapshotV3({
      catalog,
      observedAt: "2026-08-21T08:00:00.000Z",
      capabilities: [{
        capabilityKey: definition.key,
        capabilityVersion: definition.version,
        definitionHash: `sha256:${"f".repeat(64)}`,
        healthState: "ready",
        checkedAt: "2026-08-21T08:00:00.000Z",
      }],
    })).toThrow("unknown or changed capability");
  });

  it("separates the full capability definition hash from MCP tool and binding hashes", () => {
    const mcp = definitionDraft({
      key: "mcp.deepwiki.ask_question",
      executor: "mcp",
      mcpToolSchemaHash: `sha256:${"a".repeat(64)}`,
      bindingDefinitionHash: `sha256:${"b".repeat(64)}`,
      effect: {
        boundary: "external",
        mutation: "write",
        reversibility: "unknown",
      },
      idempotency: "non_idempotent",
    });
    const catalog = buildCapabilityCatalogV3([mcp]);
    const definition = catalog.capabilities[0]!;

    expect(definition.definitionHash).not.toBe(definition.mcpToolSchemaHash);
    expect(definition.definitionHash).not.toBe(definition.bindingDefinitionHash);
    expect(definition.mcpToolSchemaHash).toBe(`sha256:${"a".repeat(64)}`);
    expect(definition.bindingDefinitionHash).toBe(`sha256:${"b".repeat(64)}`);
  });

  it("rejects invalid effect classifications and MCP definitions without exact hashes", () => {
    expect(() => buildCapabilityCatalogV3([definitionDraft({
      effect: {
        boundary: "external",
        mutation: "write",
        reversibility: "not_applicable",
      },
    })])).toThrow("reversibility");
    expect(() => buildCapabilityCatalogV3([definitionDraft({
      key: "mcp.deepwiki.ask_question",
      executor: "mcp",
    })])).toThrow("published tool schema hash");
  });

  it("rejects tampered immutable definitions and catalogs", () => {
    const catalog = buildCatalog();
    const tamperedDefinition = structuredClone(catalog.capabilities[0]!);
    tamperedDefinition.description = "changed after publication";
    expect(capabilityDefinitionV3Schema.safeParse(tamperedDefinition).success).toBe(false);

    const tamperedCatalog = structuredClone(catalog);
    tamperedCatalog.capabilities.reverse();
    expect(capabilityCatalogV3Schema.safeParse(tamperedCatalog).success).toBe(false);
  });

  it("validates one grounded multi-goal plan with terminal-aware composition", () => {
    const catalog = buildCatalog();
    const plan = validPlan(catalog);
    expect(validateTurnPlanV3({
      plan,
      catalog,
      envelope: envelope(catalog),
      expectedPlanId: plan.planId,
    })).toEqual({ ok: true, plan });
  });

  it("enforces forbidden and required tool policies at the validated-plan boundary", () => {
    const catalog = buildCatalog();
    const forbidden = validateTurnPlanV3({
      plan: validPlan(catalog),
      catalog,
      envelope: envelope(catalog, "forbidden"),
    });
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) {
      expect(forbidden.issues.map((issue) => issue.code))
        .toContain("turn_constraint_invalid");
    }

    const composeOnly = validPlan(catalog);
    composeOnly.goals[0] = {
      ...composeOnly.goals[0]!,
      strategy: "general",
      actionIds: ["compose-response"],
      evidenceRequirement: {
        kind: "none",
        freshness: "stable",
        allowedSourceKinds: [],
        citationRequired: false,
        minimumEvidenceCount: 0,
      },
    };
    composeOnly.actions = [{
      ...composeOnly.actions[1]!,
      dependencies: [],
    }];
    const required = validateTurnPlanV3({
      plan: composeOnly,
      catalog,
      envelope: envelope(catalog, "required"),
    });
    expect(required.ok).toBe(false);
    if (!required.ok) {
      expect(required.issues.map((issue) => issue.code))
        .toContain("turn_constraint_invalid");
    }

    const clarification = structuredClone(composeOnly);
    clarification.goals[0] = {
      ...clarification.goals[0]!,
      strategy: "control",
      operation: "control",
      semanticConfidence: 0.5,
      generalEligibility: "uncertain",
    };
    expect(validateTurnPlanV3({
      plan: clarification,
      catalog,
      envelope: envelope(catalog, "required"),
    }).ok).toBe(true);

    expect(validateTurnPlanV3({
      plan: validPlan(catalog),
      catalog,
      envelope: envelope(catalog, "auto"),
    }).ok).toBe(true);
  });

  it("rejects unknown references, dependency cycles, and mismatched catalog hashes", () => {
    const catalog = buildCatalog();
    const plan = validPlan(catalog);
    plan.capabilityCatalogHash = `sha256:${"e".repeat(64)}`;
    plan.goals[0]!.actionIds.push("missing-action");
    plan.actions[0]!.dependencies = [{
      actionId: "compose-response",
      allowedStatuses: ["succeeded"],
    }];

    const result = validateTurnPlanV3({ plan, catalog, envelope: envelope(catalog) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
        "catalog_hash_mismatch",
        "reference_unknown",
        "dependency_cycle",
      ]));
    }
  });

  it("binds a validated plan to its fixed candidate discovery snapshot", () => {
    const catalog = buildCatalog();
    const plan = validPlan(catalog);
    plan.capabilityCandidateSnapshotHash = `sha256:${"c".repeat(64)}`;
    const result = validateTurnPlanV3({
      plan,
      catalog,
      envelope: envelope(catalog),
      expectedCandidateSnapshotHash: `sha256:${"d".repeat(64)}`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "candidate_snapshot_hash_mismatch",
      }));
    }
  });

  it("requires planned alternatives to use on-failure activation from the source action", () => {
    const catalog = buildCatalog();
    const plan = validPlan(catalog);
    plan.actions[0]!.failurePolicy = {
      strategy: "try_planned_alternatives",
      alternativeActionIds: ["compose-response"],
      terminalStrategy: "stop",
    };

    const result = validateTurnPlanV3({ plan, catalog, envelope: envelope(catalog) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain(
        "failure_policy_invalid",
      );
    }
  });

  it("rejects unlisted or ambiguous fallback actions within one fallback group", () => {
    const catalog = buildCatalog();
    const plan = validPlan(catalog);
    const source = plan.actions[0]!;
    const firstFallback = structuredClone(source);
    firstFallback.id = "fallback-a";
    firstFallback.activation = {
      mode: "on_failure",
      sourceActionId: source.id,
      allowedFailureCodes: ["knowledge_unavailable"],
      fallbackGroupKey: "knowledge-fallbacks",
      priority: 10,
    };
    const secondFallback = structuredClone(firstFallback);
    secondFallback.id = "fallback-b";
    source.failurePolicy = {
      strategy: "try_planned_alternatives",
      alternativeActionIds: [firstFallback.id],
      terminalStrategy: "stop",
    };
    plan.actions.splice(1, 0, firstFallback, secondFallback);
    plan.goals[0]!.actionIds.push(firstFallback.id, secondFallback.id);

    const result = validateTurnPlanV3({ plan, catalog, envelope: envelope(catalog) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "activation_invalid",
          path: "/actions/2/activation",
        }),
        expect.objectContaining({
          code: "activation_invalid",
          path: "/actions/2/activation/priority",
        }),
      ]));
    }
  });

  it("accepts a three-candidate fallback group with unique serial priorities", () => {
    const catalog = buildCatalog();
    const plan = validPlan(catalog);
    const source = plan.actions[0]!;
    const fallbacks = [10, 20, 30].map((priority, index) => {
      const fallback = structuredClone(source);
      fallback.id = `fallback-${index + 1}`;
      fallback.activation = {
        mode: "on_failure",
        sourceActionId: source.id,
        allowedFailureCodes: ["knowledge_unavailable"],
        fallbackGroupKey: "knowledge-fallbacks",
        priority,
      };
      return fallback;
    });
    source.failurePolicy = {
      strategy: "try_planned_alternatives",
      alternativeActionIds: fallbacks.map((fallback) => fallback.id),
      terminalStrategy: "stop",
    };
    plan.actions.splice(1, 0, ...fallbacks);
    plan.goals[0]!.actionIds.push(...fallbacks.map((fallback) => fallback.id));

    expect(validateTurnPlanV3({
      plan,
      catalog,
      envelope: envelope(catalog),
    })).toMatchObject({ ok: true });
  });

  it("rejects missing provenance and previous outputs outside declared dependencies", () => {
    const catalog = buildCatalog();
    const plan = validPlan(catalog);
    delete plan.actions[0]!.argumentProvenance.question;
    plan.actions[1]!.arguments = { responseGoal: "Summarize" };
    plan.actions[1]!.argumentProvenance = {
      responseGoal: {
        source: "previous_action_output",
        pointer: "/actions/missing/output/text",
      },
    };

    const result = validateTurnPlanV3({ plan, catalog, envelope: envelope(catalog) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain(
        "provenance_invalid",
      );
    }
  });

  it("rejects ungrounded user arguments, unresolved goal sources, and missing scopes", () => {
    const catalog = buildCapabilityCatalogV3([
      definitionDraft({
        requiredIdentityScopes: ["account.read"],
        requiredDataScopes: ["knowledge.private"],
      }),
      definitionDraft({
        key: "response.compose",
        executor: "builtin",
        inputSchema: closedObjectSchema({}, []),
        outputSchema: closedObjectSchema({ segments: {
          type: "array",
          items: { type: "object" },
        } }, ["segments"]),
      }),
    ]);
    const plan = validPlan(catalog);
    plan.goals[0]!.sourcePointers = ["/currentMessage/missing"];
    plan.actions[0]!.arguments.question = "不存在于用户原文的参数";

    const result = validateTurnPlanV3({ plan, catalog, envelope: envelope(catalog) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
        "goal_source_invalid",
        "identity_scope_missing",
        "data_scope_missing",
        "provenance_invalid",
      ]));
    }
  });

  it("rejects external writes that continue after non-success dependency states", () => {
    const catalog = buildCapabilityCatalogV3([
      definitionDraft(),
      definitionDraft({
        key: "mcp.orders.refund",
        executor: "mcp",
        effect: {
          boundary: "external",
          mutation: "write",
          reversibility: "unknown",
        },
        idempotency: "non_idempotent",
        mcpToolSchemaHash: `sha256:${"a".repeat(64)}`,
        bindingDefinitionHash: `sha256:${"b".repeat(64)}`,
      }),
      definitionDraft({
        key: "response.compose",
        executor: "builtin",
        inputSchema: closedObjectSchema({}, []),
        outputSchema: closedObjectSchema({ segments: {
          type: "array",
          items: { type: "object" },
        } }, ["segments"]),
      }),
    ]);
    const plan = validPlan(catalog);
    const refund = catalog.capabilities.find((item) => item.key === "mcp.orders.refund")!;
    plan.actions.splice(1, 0, {
      id: "refund-order",
      capability: {
        key: refund.key,
        version: refund.version,
        definitionHash: refund.definitionHash,
      },
      arguments: { question: "退款政策是什么？" },
      argumentProvenance: {
        question: { source: "user_message", pointer: "/currentMessage/text" },
      },
      dependencies: [{
        actionId: "retrieve-knowledge",
        allowedStatuses: ["failed"],
      }],
      activation: { mode: "primary" },
      expectedOutputSchema: refund.outputSchema,
      completionCriteria: ["The external refund is confirmed."],
      failurePolicy: {
        strategy: "stop",
        publicMessageCode: "refund_failed",
      },
    });

    const result = validateTurnPlanV3({ plan, catalog, envelope: envelope(catalog) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain(
        "failure_policy_invalid",
      );
    }
  });

  it("requires live evidence for current-external and transactional goals", () => {
    const catalog = buildCatalog();
    const plan = validPlan(catalog);
    plan.goals[0]!.evidenceRequirement = {
      kind: "transactional_authority",
      freshness: "stable",
      allowedSourceKinds: ["order_api"],
      citationRequired: true,
      minimumEvidenceCount: 1,
    };

    const result = validateTurnPlanV3({ plan, catalog });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe("schema_invalid");
  });

  it("rejects a stable-general fallback policy attached to an exclusive evidence goal", () => {
    const catalog = buildCatalog();
    const plan = validPlan(catalog);
    plan.goals[0]!.evidenceFallbackPolicy = {
      kind: "authorized_knowledge_miss_to_stable_general",
      policySource: "server_planning_default",
      activationStatuses: ["not_found", "unavailable"],
      authorityBoundary: "non_owner_specific_stable_general",
      disclosureRequired: true,
    };
    plan.goals[0]!.sourceAuthorityBoundary = {
      classification: "stable_general_allowed",
      policySource: "server_authority_policy",
      policyVersion: "delegate.source-authority.v1",
      reasonCodes: ["no_owner_authority_signal"],
    };

    const result = validateTurnPlanV3({ plan, catalog });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "evidence_unsatisfied",
        path: "/goals/0/evidenceFallbackPolicy",
      }));
    }
  });

  it("accepts a server-owned stable fallback for an unexecuted public capability", () => {
    const result = goalEvidenceFallbackPolicyV3Schema.safeParse({
      kind: "capability_unexecuted_to_stable_general",
      policySource: "server_planning_default",
      activationStatuses: ["compiler_unavailable", "entitlement_denied"],
      authorityBoundary: "non_owner_specific_stable_general",
      disclosureRequired: true,
    });
    expect(result.success).toBe(true);
  });

  it("requires exact source spans for every non-control Goal in a multi-Goal Plan", () => {
    const catalog = buildCatalog();
    const plan = validPlan(catalog);
    plan.goals.push({
      ...plan.goals[0]!,
      id: "second-goal",
    });
    const result = validateTurnPlanV3({ plan, catalog });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "goal_source_invalid",
        path: "/goals/0/sourceSpan",
      }));
    }
  });

  it("rejects authorization or billing fields smuggled into the strict plan", () => {
    const catalog = buildCatalog();
    const result = validateTurnPlanV3({
      plan: {
        ...validPlan(catalog),
        authorization: "allow",
        billingDecision: "settle",
      },
      catalog,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe("schema_invalid");
  });

  it("rejects a non-composer action that is not owned by any goal", () => {
    const catalog = buildCatalog();
    const plan = validPlan(catalog);
    const extra = structuredClone(plan.actions[0]!);
    extra.id = "orphan-retrieval";
    plan.actions.splice(1, 0, extra);
    plan.actions.at(-1)!.dependencies.push({
      actionId: extra.id,
      allowedStatuses: ["succeeded"],
    });

    const result = validateTurnPlanV3({ plan, catalog, envelope: envelope(catalog) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "action_unowned",
        path: "/actions/1",
      }));
    }
  });

  it("rejects an action whose immutable semantics do not support its goal operation", () => {
    const catalog = buildCatalog();
    const plan = validPlan(catalog);
    plan.goals[0]!.operation = "mutate";

    const result = validateTurnPlanV3({ plan, catalog, envelope: envelope(catalog) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "evidence_unsatisfied",
        path: "/goals/0/operation",
      }));
    }
  });

  it("does not let an unclassified legacy MCP satisfy transactional evidence", () => {
    const catalog = buildCapabilityCatalogV3([
      definitionDraft({
        key: "knowledge.retrieve_authorized",
        executor: "mcp",
        mcpToolSchemaHash: `sha256:${"a".repeat(64)}`,
        bindingDefinitionHash: `sha256:${"b".repeat(64)}`,
      }),
      definitionDraft({
        key: "response.compose",
        executor: "builtin",
        inputSchema: closedObjectSchema({}, []),
        outputSchema: closedObjectSchema({ segments: {
          type: "array",
          items: { type: "object" },
        } }, ["segments"]),
      }),
    ]);
    const plan = validPlan(catalog);
    plan.goals[0] = {
      ...plan.goals[0]!,
      strategy: "capability",
      operation: "read",
      evidenceRequirement: {
        kind: "transactional_authority",
        freshness: "live",
        allowedSourceKinds: ["transactional_authority"],
        citationRequired: true,
        minimumEvidenceCount: 1,
      },
    };

    const result = validateTurnPlanV3({ plan, catalog, envelope: envelope(catalog) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "evidence_unsatisfied",
        path: "/goals/0/evidenceRequirement",
      }));
    }
  });
});

function buildCatalog() {
  return buildCapabilityCatalogV3([
    definitionDraft({
      key: "knowledge.retrieve_authorized",
      executor: "knowledge",
      inputSchema: closedObjectSchema({ question: { type: "string" } }, ["question"]),
      outputSchema: closedObjectSchema({ evidenceRefs: {
        type: "array",
        items: { type: "string" },
      } }, ["evidenceRefs"]),
      successContract: {
        kind: "status_predicate",
        pointer: "/evidenceRefs",
        operator: "in",
        value: ["non_empty"],
      },
      semantics: {
        operations: ["answer", "read", "search", "explain"],
        evidenceClasses: ["authorized_knowledge"],
        freshnessClasses: ["stable", "bounded"],
        authorityClasses: ["owner_authorized"],
        domains: ["owner knowledge"],
        aliases: ["knowledge"],
      },
    }),
    definitionDraft({
      key: "response.compose",
      executor: "builtin",
      inputSchema: closedObjectSchema({}, []),
      outputSchema: closedObjectSchema({ segments: {
        type: "array",
        items: { type: "object" },
      } }, ["segments"]),
      semantics: {
        operations: ["answer", "explain", "deliver"],
        evidenceClasses: ["none", "authorized_knowledge", "capability_result"],
        freshnessClasses: ["stable", "bounded"],
        authorityClasses: ["general", "owner_authorized"],
        domains: ["response"],
        aliases: ["compose"],
      },
    }),
  ]);
}

function definitionDraft(
  overrides: Partial<CapabilityDefinitionDraftV3> = {},
): CapabilityDefinitionDraftV3 {
  return {
    key: "knowledge.retrieve_authorized",
    version: "1",
    description: "Retrieve authorized evidence for the current goal.",
    executor: "knowledge",
    inputSchema: closedObjectSchema({ question: { type: "string" } }, ["question"]),
    outputSchema: closedObjectSchema({ evidenceRefs: {
      type: "array",
      items: { type: "string" },
    } }, ["evidenceRefs"]),
    effect: {
      boundary: "internal",
      mutation: "none",
      reversibility: "not_applicable",
    },
    idempotency: "naturally_idempotent",
    supportedChannels: ["web", "matrix", "telegram"],
    requiredIdentityScopes: [],
    requiredDataScopes: [],
    tags: ["knowledge"],
    canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
    ...overrides,
  };
}

function validPlan(catalog: CapabilityCatalogV3): TurnPlanV3 {
  const knowledge = catalog.capabilities.find(
    (definition) => definition.key === "knowledge.retrieve_authorized",
  )!;
  const composer = catalog.capabilities.find(
    (definition) => definition.key === "response.compose",
  )!;
  return {
    protocolVersion: 3,
    planId: "turn-plan-v3-1",
    scopeKey: {
      kind: "generation_turn",
      conversationId: "conversation-1",
      inputMessageId: "message-1",
    },
    revision: 1,
    envelopeHash: stableSha256({ messageId: "message-1" }),
    capabilityCatalogHash: catalog.catalogHash,
    validationPolicyVersion: "turn-plan-v3-policy.1",
    objective: "Answer the question from authorized knowledge.",
    goals: [{
      id: "answer-question",
      objective: "Answer the user's question.",
      sourcePointers: ["/currentMessage/text"],
      strategy: "knowledge",
      operation: "answer",
      semanticConfidence: 0.95,
      generalEligibility: "allowed",
      actionIds: ["retrieve-knowledge", "compose-response"],
      deliverableIds: ["reply-message"],
      evidenceRequirement: {
        kind: "authorized_knowledge",
        freshness: "bounded",
        allowedSourceKinds: ["public_knowledge"],
        citationRequired: true,
        minimumEvidenceCount: 1,
      },
      failurePolicy: {
        strategy: "clarify",
        reasonCode: "authorized_knowledge_unavailable",
      },
    }],
    actions: [{
      id: "retrieve-knowledge",
      capability: {
        key: knowledge.key,
        version: knowledge.version,
        definitionHash: knowledge.definitionHash,
      },
      arguments: { question: "退款政策是什么？" },
      argumentProvenance: {
        question: { source: "user_message", pointer: "/currentMessage/text" },
      },
      dependencies: [],
      activation: { mode: "primary" },
      expectedOutputSchema: knowledge.outputSchema,
      completionCriteria: ["At least one authorized evidence reference is returned."],
      failurePolicy: {
        strategy: "clarify",
        requiredFields: ["authorized knowledge source"],
      },
    }, {
      id: "compose-response",
      capability: {
        key: composer.key,
        version: composer.version,
        definitionHash: composer.definitionHash,
      },
      arguments: {},
      argumentProvenance: {},
      dependencies: [{
        actionId: "retrieve-knowledge",
        allowedStatuses: [
          "succeeded",
          "failed",
          "partial",
          "reconciliation_required",
        ],
      }],
      activation: { mode: "primary" },
      expectedOutputSchema: composer.outputSchema,
      completionCriteria: ["Every factual claim has a valid evidence binding."],
      failurePolicy: {
        strategy: "stop",
        publicMessageCode: "response_composition_failed",
      },
    }],
    deliverables: [{
      id: "reply-message",
      kind: "message",
      format: "text",
      producedByActionIds: ["compose-response"],
      completionCriteria: ["A validated message draft is ready for delivery."],
    }],
    decisionTrace: ["authorized_knowledge_required"],
  };
}

function envelope(
  catalog: CapabilityCatalogV3,
  toolPolicy: "auto" | "forbidden" | "required" | "conflict" = "auto",
) {
  const legacyCatalog = {
    protocolVersion: 1 as const,
    capabilities: [],
    catalogHash: stableSha256([]),
  };
  return {
    currentMessage: {
      id: "message-1",
      text: "退款政策是什么？",
      language: "zh",
    },
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
    turnConstraints: {
      scope: "turn" as const,
      toolPolicy,
      source: toolPolicy === "auto"
        ? "default" as const
        : "explicit_user_instruction" as const,
      sourcePointers: toolPolicy === "auto" ? [] : ["/currentMessage/text"],
    },
    capabilitySnapshot: legacyCatalog,
    v3CatalogHash: catalog.catalogHash,
  };
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

import { describe, expect, it } from "vitest";

import {
  CAPABILITY_CANONICALIZATION_VERSION_V3,
  CapabilityCompilerRegistry,
  buildCapabilityCatalogV3,
  buildCapabilityExecutionBase,
  createLegacyCapabilityCompilerRegistry,
  type CapabilityCompileContext,
} from "../src";

describe("capability compiler registry", () => {
  it("dispatches by executor and preserves every authoritative fence", () => {
    const context = compileContext();
    const registry = new CapabilityCompilerRegistry().register({
      executor: "builtin",
      compile(input) {
        return {
          ...buildCapabilityExecutionBase(input),
          executor: "builtin",
          handlerId: "response.compose",
          arguments: input.action.arguments,
        };
      },
    });
    expect(registry.compile(context)).toMatchObject({
      executor: "builtin",
      planId: "plan-1",
      planRevision: 2,
      executionEpoch: 3,
      actionId: "plan-action-db-1",
      capabilityDefinitionHash: context.definition.definitionHash,
      argumentsHash: expect.stringMatching(/^sha256:/),
      idempotencyKey: "turn-plan:plan-1:revision:2:action:plan-action-db-1",
    });
  });

  it("rejects a changed action definition before invoking a compiler", () => {
    const context = compileContext();
    context.action.capability.definitionHash = `sha256:${"0".repeat(64)}`;
    const compile = () => new CapabilityCompilerRegistry().register({
      executor: "builtin",
      compile(input) {
        return {
          ...buildCapabilityExecutionBase(input),
          executor: "builtin",
          handlerId: "response.compose",
          arguments: {},
        };
      },
    }).compile(context);
    expect(compile).toThrow("immutable action definition");
  });

  it("rejects duplicate compilers and missing executor implementations", () => {
    const compiler = {
      executor: "builtin" as const,
      compile(input: CapabilityCompileContext) {
        return {
          ...buildCapabilityExecutionBase(input),
          executor: "builtin" as const,
          handlerId: "response.compose",
          arguments: {},
        };
      },
    };
    const registry = new CapabilityCompilerRegistry().register(compiler);
    expect(() => registry.register(compiler)).toThrow("already registered");
    const context = compileContext();
    context.definition = { ...context.definition, executor: "knowledge" };
    expect(() => registry.compile(context)).toThrow("not registered");
  });

  it("rejects a compiler that mutates plan or billing fence coordinates", () => {
    const context = compileContext();
    const registry = new CapabilityCompilerRegistry().register({
      executor: "builtin",
      compile(input) {
        return {
          ...buildCapabilityExecutionBase(input),
          planRevision: 99,
          executor: "builtin",
          handlerId: "response.compose",
          arguments: {},
        };
      },
    });
    expect(() => registry.compile(context)).toThrow("planRevision");
  });

  it("compiles an MCP action only with exact published target and hashes", () => {
    const base = compileContext();
    const catalog = buildCapabilityCatalogV3([{
      key: "mcp.deepwiki.ask_question",
      version: "1",
      description: "Ask DeepWiki.",
      executor: "mcp",
      inputSchema: objectSchema(),
      outputSchema: objectSchema(),
      effect: {
        boundary: "external",
        mutation: "write",
        reversibility: "unknown",
      },
      idempotency: "non_idempotent",
      supportedChannels: ["web"],
      requiredIdentityScopes: [],
      requiredDataScopes: [],
      tags: [],
      canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
      mcpToolSchemaHash: `sha256:${"a".repeat(64)}`,
      bindingDefinitionHash: `sha256:${"b".repeat(64)}`,
    }]);
    const definition = catalog.capabilities[0]!;
    const context: CapabilityCompileContext = {
      ...base,
      definition,
      action: {
        ...base.action,
        capability: {
          key: definition.key,
          version: definition.version,
          definitionHash: definition.definitionHash,
        },
      },
    };
    const registry = createLegacyCapabilityCompilerRegistry({
      resolveMcpTarget: () => ({
        bindingId: "binding-1",
        bindingRevision: 4,
        toolName: "ask_question",
      }),
      resolveSkillRelease: () => ({ skillSlug: "unused", releaseId: "unused" }),
    });
    expect(registry.compile(context)).toMatchObject({
      executor: "mcp",
      bindingId: "binding-1",
      bindingRevision: 4,
      toolName: "ask_question",
      expectedToolSchemaHash: `sha256:${"a".repeat(64)}`,
      expectedBindingDefinitionHash: `sha256:${"b".repeat(64)}`,
    });
  });

  it("maps the planner-only compute.task capability onto governed exec", () => {
    const base = compileContext();
    const catalog = buildCapabilityCatalogV3([{
      key: "compute.task",
      version: "1",
      description: "Compile a self-contained sandbox task.",
      executor: "compute",
      inputSchema: {
        type: "object",
        properties: { instruction: { type: "string" } },
        required: ["instruction"],
        additionalProperties: false,
      },
      outputSchema: objectSchema(),
      effect: {
        boundary: "internal",
        mutation: "write",
        reversibility: "not_applicable",
      },
      idempotency: "requires_key",
      supportedChannels: ["web"],
      requiredIdentityScopes: [],
      requiredDataScopes: [],
      tags: ["task"],
      canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
    }]);
    const definition = catalog.capabilities[0]!;
    const context: CapabilityCompileContext = {
      ...base,
      definition,
      action: {
        ...base.action,
        capability: {
          key: definition.key,
          version: definition.version,
          definitionHash: definition.definitionHash,
        },
        arguments: { instruction: "计算质数" },
      },
    };
    const registry = createLegacyCapabilityCompilerRegistry({
      resolveMcpTarget: () => {
        throw new Error("unused");
      },
      resolveSkillRelease: () => {
        throw new Error("unused");
      },
    });

    expect(registry.compile(context)).toMatchObject({
      executor: "compute",
      capability: "exec",
      capabilityKey: "compute.task",
      payload: { instruction: "计算质数" },
    });
  });
});

function compileContext(): CapabilityCompileContext {
  const catalog = buildCapabilityCatalogV3([{
    key: "response.compose",
    version: "1",
    description: "Compose a verified response.",
    executor: "builtin",
    inputSchema: objectSchema(),
    outputSchema: objectSchema(),
    effect: {
      boundary: "internal",
      mutation: "none",
      reversibility: "not_applicable",
    },
    idempotency: "naturally_idempotent",
    supportedChannels: ["web"],
    requiredIdentityScopes: [],
    requiredDataScopes: [],
    tags: [],
    canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
  }]);
  const definition = catalog.capabilities[0]!;
  return {
    planId: "plan-1",
    planRevision: 2,
    executionEpoch: 3,
    generationRunId: "run-1",
    planActionId: "plan-action-db-1",
    definition,
    action: {
      id: "compose",
      capability: {
        key: definition.key,
        version: definition.version,
        definitionHash: definition.definitionHash,
      },
      arguments: {},
      argumentProvenance: {},
      dependencies: [],
      activation: { mode: "primary" },
      expectedOutputSchema: definition.outputSchema,
      completionCriteria: ["Validated response is ready."],
      failurePolicy: {
        strategy: "stop",
        publicMessageCode: "compose_failed",
      },
    },
  };
}

function objectSchema() {
  return { type: "object", properties: {}, required: [], additionalProperties: false };
}

import { stableSha256 } from "./turn-planning";
import type { CapabilityDefinitionV3, PlanActionV3 } from "./turn-planning-v3";

export type CapabilityExecutionBase = {
  planId: string;
  planRevision: number;
  executionEpoch: number;
  actionId: string;
  generationRunId: string;
  capabilityKey: string;
  capabilityVersion: string;
  capabilityDefinitionHash: string;
  argumentsHash: string;
  idempotencyKey: string;
};

export type BuiltinExecutionRequest = CapabilityExecutionBase & {
  executor: "builtin";
  handlerId: string;
  arguments: Record<string, unknown>;
};

export type KnowledgeExecutionRequest = CapabilityExecutionBase & {
  executor: "knowledge";
  retrieverId: string;
  arguments: Record<string, unknown>;
};

export type McpExecutionRequest = CapabilityExecutionBase & {
  executor: "mcp";
  bindingId: string;
  bindingRevision: number;
  toolName: string;
  expectedToolSchemaHash: string;
  expectedBindingDefinitionHash: string;
  toolArguments: Record<string, unknown>;
};

export type ComputeExecutionRequest = CapabilityExecutionBase & {
  executor: "compute";
  capability: "exec" | "read" | "write" | "process" | "browser";
  payload: Record<string, unknown>;
};

export type SkillExecutionRequest = CapabilityExecutionBase & {
  executor: "skill";
  skillSlug: string;
  releaseId: string;
  arguments: Record<string, unknown>;
};

export type CapabilityExecutionRequest =
  | BuiltinExecutionRequest
  | KnowledgeExecutionRequest
  | McpExecutionRequest
  | ComputeExecutionRequest
  | SkillExecutionRequest;

export type CapabilityCompileContext = {
  planId: string;
  planRevision: number;
  executionEpoch: number;
  generationRunId: string;
  /**
   * Database identity of the immutable PlanAction. The planner-facing
   * `action.id` is only an action key and must never be used as an execution
   * fence coordinate.
   */
  planActionId: string;
  action: PlanActionV3;
  definition: CapabilityDefinitionV3;
};

export type CapabilityCompiler = {
  executor: CapabilityDefinitionV3["executor"];
  compile(context: CapabilityCompileContext): CapabilityExecutionRequest;
};

export class CapabilityCompilerRegistry {
  private readonly compilers = new Map<CapabilityDefinitionV3["executor"], CapabilityCompiler>();

  register(compiler: CapabilityCompiler) {
    if (this.compilers.has(compiler.executor)) {
      throw new Error(`Capability compiler ${compiler.executor} is already registered.`);
    }
    this.compilers.set(compiler.executor, compiler);
    return this;
  }

  compile(context: CapabilityCompileContext): CapabilityExecutionRequest {
    assertCompileContext(context);
    const compiler = this.compilers.get(context.definition.executor);
    if (!compiler) {
      throw new Error(`Capability compiler ${context.definition.executor} is not registered.`);
    }
    const request = compiler.compile(context);
    assertCompiledRequest(context, request);
    return request;
  }
}

export function createLegacyCapabilityCompilerRegistry(resolvers: {
  resolveMcpTarget(context: CapabilityCompileContext): {
    bindingId: string;
    bindingRevision: number;
    toolName: string;
  };
  resolveSkillRelease(context: CapabilityCompileContext): {
    skillSlug: string;
    releaseId: string;
  };
}): CapabilityCompilerRegistry {
  return new CapabilityCompilerRegistry()
    .register({
      executor: "builtin",
      compile(context) {
        return {
          ...buildCapabilityExecutionBase(context),
          executor: "builtin",
          handlerId: context.definition.key,
          arguments: context.action.arguments,
        };
      },
    })
    .register({
      executor: "knowledge",
      compile(context) {
        return {
          ...buildCapabilityExecutionBase(context),
          executor: "knowledge",
          retrieverId: context.definition.key,
          arguments: context.action.arguments,
        };
      },
    })
    .register({
      executor: "mcp",
      compile(context) {
        const target = resolvers.resolveMcpTarget(context);
        if (!context.definition.mcpToolSchemaHash
          || !context.definition.bindingDefinitionHash) {
          throw new Error("MCP capability is missing published schema or binding hashes.");
        }
        return {
          ...buildCapabilityExecutionBase(context),
          executor: "mcp",
          bindingId: target.bindingId,
          bindingRevision: target.bindingRevision,
          toolName: target.toolName,
          expectedToolSchemaHash: context.definition.mcpToolSchemaHash,
          expectedBindingDefinitionHash: context.definition.bindingDefinitionHash,
          toolArguments: context.action.arguments,
        };
      },
    })
    .register({
      executor: "compute",
      compile(context) {
        const requestedCapability = context.definition.key.startsWith("compute.")
          ? context.definition.key.slice("compute.".length)
          : "";
        const capability = requestedCapability === "task"
          ? "exec"
          : requestedCapability;
        if (!isComputeCapability(capability)) {
          throw new Error(`Unsupported Compute capability ${context.definition.key}.`);
        }
        return {
          ...buildCapabilityExecutionBase(context),
          executor: "compute",
          capability,
          payload: context.action.arguments,
        };
      },
    })
    .register({
      executor: "skill",
      compile(context) {
        const target = resolvers.resolveSkillRelease(context);
        return {
          ...buildCapabilityExecutionBase(context),
          executor: "skill",
          skillSlug: target.skillSlug,
          releaseId: target.releaseId,
          arguments: context.action.arguments,
        };
      },
    });
}

export function buildCapabilityExecutionBase(
  context: CapabilityCompileContext,
): CapabilityExecutionBase {
  assertCompileContext(context);
  return {
    planId: context.planId,
    planRevision: context.planRevision,
    executionEpoch: context.executionEpoch,
    actionId: context.planActionId,
    generationRunId: context.generationRunId,
    capabilityKey: context.definition.key,
    capabilityVersion: context.definition.version,
    capabilityDefinitionHash: context.definition.definitionHash,
    argumentsHash: stableSha256(context.action.arguments),
    idempotencyKey:
      `turn-plan:${context.planId}:revision:${context.planRevision}:action:${context.planActionId}`,
  };
}

function assertCompileContext(context: CapabilityCompileContext) {
  if (
    !context.planActionId.trim()
    ||
    context.action.capability.key !== context.definition.key
    || context.action.capability.version !== context.definition.version
    || context.action.capability.definitionHash !== context.definition.definitionHash
  ) {
    throw new Error("Capability compile context does not match the immutable action definition.");
  }
  if (context.planRevision < 1 || context.executionEpoch < 0) {
    throw new Error("Capability compile context has an invalid revision or execution epoch.");
  }
}

function assertCompiledRequest(
  context: CapabilityCompileContext,
  request: CapabilityExecutionRequest,
) {
  const expected = buildCapabilityExecutionBase(context);
  for (const key of [
    "planId",
    "planRevision",
    "executionEpoch",
    "actionId",
    "generationRunId",
    "capabilityKey",
    "capabilityVersion",
    "capabilityDefinitionHash",
    "argumentsHash",
    "idempotencyKey",
  ] as const) {
    if (request[key] !== expected[key]) {
      throw new Error(`Capability compiler changed authoritative field ${key}.`);
    }
  }
  if (request.executor !== context.definition.executor) {
    throw new Error("Capability compiler returned the wrong executor request type.");
  }
}

function isComputeCapability(
  value: string,
): value is ComputeExecutionRequest["capability"] {
  return value === "exec"
    || value === "read"
    || value === "write"
    || value === "process"
    || value === "browser";
}

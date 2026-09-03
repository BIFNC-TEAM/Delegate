import {
  compileNaturalLanguageSandboxTask,
  type SandboxTaskCompilerResult,
} from "@delegate/model-runtime";
import {
  CAPABILITY_CANONICALIZATION_VERSION_V3,
  type CapabilityDefinitionDraftV3,
  type ComputeExecutionRequest,
} from "@delegate/runtime";

type ComputeCapability = "exec" | "read" | "write" | "process" | "browser";

type ComputeAuthority = {
  enabled: boolean;
  capabilityModes: Record<ComputeCapability, "allow" | "ask" | "deny">;
};

export class SandboxTaskCompilationError extends Error {
  constructor(readonly code: "disabled" | "declined" | "failed" | "multiple_actions") {
    super(`sandbox_task_compiler_${code}`);
    this.name = "SandboxTaskCompilationError";
  }
}

export function isNaturalSandboxTaskEnabled(input: {
  naturalLanguageEnabled: boolean;
  networkMode: string;
  filesystemMode: string;
}) {
  return input.naturalLanguageEnabled
    && input.networkMode.toLowerCase() === "no_network"
    && input.filesystemMode.toLowerCase() === "ephemeral_full";
}

export function buildV3ComputeCapabilityDefinitions(
  compute: ComputeAuthority | undefined,
  naturalTaskEnabled: boolean,
): CapabilityDefinitionDraftV3[] {
  if (!compute?.enabled) return [];
  const directCapabilities = (["exec", "read", "write", "process", "browser"] as const)
    .filter((capability) => compute.capabilityModes[capability] !== "deny")
    .map((capability) => {
      const inputSchema = capability === "read"
        ? closedObjectSchema({ path: { type: "string" } }, ["path"])
        : capability === "write"
          ? closedObjectSchema(
              { path: { type: "string" }, content: { type: "string" } },
              ["path", "content"],
            )
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
          : capability === "browser"
            ? { boundary: "external" as const, mutation: "none" as const, reversibility: "not_applicable" as const }
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
        tags: capability === "browser"
          ? ["compute", capability, "web retrieval", "current information", "网页检索", "实时信息"]
          : ["compute", capability],
        semantics: {
          operations: capability === "browser" || capability === "read"
            ? ["read" as const, "search" as const]
            : capability === "write"
              ? ["create" as const, "mutate" as const]
              : ["create" as const],
          evidenceClasses: capability === "browser"
            ? ["capability_result" as const, "current_external" as const]
            : ["capability_result" as const],
          freshnessClasses: capability === "browser"
            ? ["live" as const]
            : ["bounded" as const],
          authorityClasses: capability === "browser"
            ? ["external_authoritative" as const]
            : ["general" as const],
          domains: ["compute", capability],
          aliases: capability === "browser"
            ? ["compute", capability, "browse the web", "retrieve current information", "浏览网页", "检索外部信息", "获取实时信息"]
            : ["compute", capability],
        },
        canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
      };
    });
  if (!naturalTaskEnabled || compute.capabilityModes.exec === "deny") {
    return directCapabilities;
  }
  return [...directCapabilities, {
    key: "compute.task",
    version: "1",
    description: "Compile and execute one self-contained natural-language Python computation in an isolated sandbox. Use only when the answer requires actual calculation or data transformation from information fully present in the current message. 自然语言触发受治理的沙箱计算。",
    executor: "compute",
    inputSchema: closedObjectSchema({ instruction: { type: "string" } }, ["instruction"]),
    outputSchema: closedObjectSchema({
      exitCode: { type: "number" },
      artifactRefs: { type: "array", items: { type: "string" } },
    }, ["exitCode", "artifactRefs"]),
    effect: { boundary: "internal", mutation: "write", reversibility: "not_applicable" },
    idempotency: "requires_key",
    successContract: {
      kind: "status_predicate",
      pointer: "/exitCode",
      operator: "equals",
      value: 0,
    },
    supportedChannels: ["web", "matrix", "telegram"],
    requiredIdentityScopes: [],
    requiredDataScopes: [],
    tags: [
      "compute",
      "task",
      "calculation",
      "analysis",
      "transformation",
      "sandbox task",
      "计算",
      "分析",
      "处理",
      "转换",
      "统计",
      "求和",
      "排序",
      "去重",
      "沙箱任务",
    ],
    semantics: {
      operations: ["answer", "create"],
      evidenceClasses: ["capability_result"],
      freshnessClasses: ["bounded"],
      authorityClasses: ["general"],
      domains: ["self-contained computation", "calculation", "data transformation"],
      aliases: [
        "calculate",
        "analyze",
        "transform",
        "statistics",
        "计算",
        "分析",
        "处理",
        "转换",
        "统计",
        "求和",
        "排序",
        "去重",
      ],
    },
    canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
  }];
}

export async function compileV3NaturalTaskExecutionRequest(input: {
  request: ComputeExecutionRequest;
  enabled: boolean;
  compiler?: (params: { instruction: string }) => Promise<SandboxTaskCompilerResult>;
}): Promise<ComputeExecutionRequest> {
  const instruction = input.request.payload["instruction"];
  if (input.request.capability !== "exec" || typeof instruction !== "string") {
    return input.request;
  }
  if (!input.enabled) throw new SandboxTaskCompilationError("disabled");
  const compiled = await (input.compiler ?? compileNaturalLanguageSandboxTask)({ instruction });
  if (!compiled.ok) throw new SandboxTaskCompilationError("failed");
  if (!compiled.task) throw new SandboxTaskCompilationError("declined");
  return {
    ...input.request,
    payload: {
      command: compiled.task.command,
      compiledTask: {
        ...compiled.task.metadata,
        ...(compiled.provider ? { compilerProvider: compiled.provider } : {}),
        ...(compiled.model ? { compilerModel: compiled.model } : {}),
      },
    },
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

import { createHash, randomUUID } from "node:crypto";
import { setMaxListeners } from "node:events";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@earendil-works/pi-ai";

import { PiTelemetry } from "./telemetry";
import type {
  PiAgentRunResult,
  PiCapabilityAdapters,
  PiCapabilityResult,
  PiMcpToolDescriptor,
  PiModule,
  PiToolBuildResult,
  PiToolContext,
} from "./types";

export async function buildPiTools(input: {
  adapters: PiCapabilityAdapters;
  context: PiToolContext;
  telemetry: PiTelemetry;
  maximumRetries: number;
  signal: AbortSignal;
}): Promise<PiToolBuildResult> {
  const tools: AgentTool<any>[] = [];
  const sources: PiToolBuildResult["sources"] = [];
  const artifacts: PiToolBuildResult["artifacts"] = [];
  const authoritativeSummaries: string[] = [];
  let knowledgeAttempts = 0;
  let knowledgeOutcome: "not_attempted" | "found" | "missing" | "unavailable" = "not_attempted";
  let currentInformationAttempts = 0;
  let mcpWriteAttempts = 0;
  const loadedSkillIds = new Set<string>();
  const loadedStructuredDataSkillIds = new Set<string>();
  let sandboxAttempts = 0;
  let structuredDataSkillGateFailures = 0;
  let sandboxEvidenceResults = 0;
  let sandboxConclusiveResults = 0;
  let sandboxSuccesses = 0;
  let handoff: PiAgentRunResult["handoff"];
  let pendingApproval = false;

  if (input.adapters.knowledge) {
    tools.push({
      name: "retrieve_authorized_knowledge",
      label: "Knowledge",
      description:
        "Search the representative's authorized knowledge library. Use it before answering factual or explanatory questions within the representative's role, specialty, published materials, or configured subject domain, as well as every organization-specific/private question, policy, rule, identity, price, or internal fact. A miss is not evidence that no policy or source exists.",
      parameters: Type.Object({
        query: Type.String({ description: "The precise question to retrieve evidence for." }),
        maximumResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
      }),
      executionMode: "parallel",
      replay: "safe",
      execute: async (_callId, params: any, signal) => {
        knowledgeAttempts += 1;
        let result: PiCapabilityResult;
        try {
          result = await executeAdapter({
            module: "knowledge",
            operation: "retrieve",
            toolName: "retrieve_authorized_knowledge",
            retrySafe: true,
            maximumRetries: input.maximumRetries,
            signal: mergeSignals(input.signal, signal),
            telemetry: input.telemetry,
            call: (activeSignal) => input.adapters.knowledge!.retrieve({
              query: params.query,
              maximumResults: params.maximumResults ?? 6,
              context: input.context,
              signal: activeSignal,
            }),
          });
        } catch (error) {
          knowledgeOutcome = "unavailable";
          throw error;
        }
        const normalizedStatus = result.status?.toLocaleLowerCase();
        knowledgeOutcome = result.sources?.length
          ? "found"
          : normalizedStatus && ["failed", "error", "timeout", "unavailable"].includes(normalizedStatus)
            ? "unavailable"
            : "missing";
        collectResult(result, sources, artifacts);
        if (result.authoritativeSummary) authoritativeSummaries.push(result.authoritativeSummary);
        await input.telemetry.event({
          type: "retrieval.completed",
          module: "knowledge",
          status: result.status ?? "completed",
          data: {
            sourceCount: result.sources?.length ?? 0,
            resultRef: result.resultRef,
          },
        });
        return toolResult(result);
      },
    });
  }

  if (input.adapters.web) {
    tools.push({
      name: "search_current_web",
      label: "Web",
      description:
        "Fetch current public information from the web. Use for weather, news, schedules, prices, changing specifications, and other time-sensitive public facts. Preserve provider, URL, and data time from the result.",
      parameters: Type.Object({
        query: Type.String(),
        localDate: Type.Optional(Type.String({ description: "Date in YYYY-MM-DD in the user's timezone when relevant." })),
      }),
      executionMode: "parallel",
      replay: "safe",
      execute: async (_callId, params: any, signal) => {
        currentInformationAttempts += 1;
        const result = await executeAdapter({
          module: "web",
          operation: "search",
          toolName: "search_current_web",
          retrySafe: true,
          maximumRetries: input.maximumRetries,
          signal: mergeSignals(input.signal, signal),
          telemetry: input.telemetry,
          call: (activeSignal) => input.adapters.web!.search({
            query: params.query,
            ...(params.localDate ? { localDate: params.localDate } : {}),
            context: input.context,
            signal: activeSignal,
          }),
        });
        collectResult(result, sources, artifacts);
        if (result.authoritativeSummary) authoritativeSummaries.push(result.authoritativeSummary);
        return toolResult(result);
      },
    });
  }

  if (input.adapters.mcp) {
    // This reads Delegate's already-published, version-pinned catalog metadata;
    // it is not a remote MCP invocation and must not appear as one in timing or
    // BASIC no-tool assertions. Live tools/list refresh remains owned by the
    // Compute Broker outside the per-turn response critical path.
    const publishedTools = await input.adapters.mcp.listTools({
      context: input.context,
      signal: input.signal,
    });
    const descriptors = normalizeMcpDescriptors(publishedTools);
    for (const descriptor of descriptors.slice(0, 32)) {
      tools.push(buildMcpTool({
        adapter: input.adapters.mcp,
        descriptor,
        context: input.context,
        telemetry: input.telemetry,
        maximumRetries: input.maximumRetries,
        signal: input.signal,
        sources,
        artifacts,
        authoritativeSummaries,
        onWriteAttempt: () => { mcpWriteAttempts += 1; },
        onReadAttempt: () => { currentInformationAttempts += 1; },
        onPendingApproval: () => { pendingApproval = true; },
      }));
    }
  }

  if (input.adapters.skills) {
    tools.push({
      name: "discover_skills",
      label: "Discover skills",
      description:
        "Find relevant professional methods or workflows without loading every Skill body. Use when the task would benefit from an established procedure.",
      parameters: Type.Object({
        query: Type.String(),
        maximumResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      }),
      replay: "safe",
      execute: async (_callId, params: any, signal) => {
        const descriptors = await executeSkillDiscovery({
          query: params.query,
          maximumResults: params.maximumResults ?? 5,
          input,
          ...(signal ? { signal } : {}),
        });
        await input.telemetry.event({
          type: "skill.discovered",
          module: "skill",
          status: "completed",
          data: { skills: descriptors },
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ skills: descriptors }) }],
          details: { skills: descriptors },
        };
      },
    });
    tools.push({
      name: "load_skill",
      label: "Load skill",
      description:
        "Load one discovered Skill's pinned instructions. Loading a Skill does not itself execute the work; follow its instructions using the appropriate tools.",
      parameters: Type.Object({
        id: Type.String(),
        version: Type.Optional(Type.String()),
      }),
      replay: "safe",
      execute: async (_callId, params: any, signal) => {
        const result = await executeAdapter({
          module: "skill",
          operation: "load",
          toolName: "load_skill",
          retrySafe: true,
          maximumRetries: input.maximumRetries,
          signal: mergeSignals(input.signal, signal),
          telemetry: input.telemetry,
          skillId: params.id,
          call: async (activeSignal) => {
            const loaded = await input.adapters.skills!.load({
              id: params.id,
              ...(params.version ? { version: params.version } : {}),
              context: input.context,
              signal: activeSignal,
            });
            return {
              text: loaded.instructions,
              details: {
                skill: loaded.descriptor,
                instructionsDigest: loaded.instructionsDigest,
                resources: loaded.resources ?? [],
              },
            };
          },
        });
        const descriptor = result.details?.["skill"] as Record<string, unknown> | undefined;
        const loadedSkillId = String(descriptor?.["id"] ?? params.id);
        loadedSkillIds.add(loadedSkillId);
        if (isStructuredDataSkillDescriptor(descriptor)) {
          loadedStructuredDataSkillIds.add(loadedSkillId);
        }
        await input.telemetry.event({
          type: "skill.loaded",
          module: "skill",
          toolName: "load_skill",
          status: "completed",
          data: {
            id: descriptor?.["id"] ?? params.id,
            version: descriptor?.["version"] ?? params.version,
            instructionsDigest: result.details?.["instructionsDigest"],
            resourceCount: Array.isArray(result.details?.["resources"])
              ? result.details!["resources"].length
              : 0,
          },
        });
        return toolResult(result);
      },
    });
  }

  if (input.adapters.sandbox) {
    tools.push({
      name: "execute_in_sandbox",
      label: "Sandbox",
      description:
        "Run code in the configured isolated sandbox for calculations, data analysis, archive inspection, and file generation. The result is real execution evidence, not a simulation. When expectedOutputs contains one file, print exactly that file's final content to stdout; CSV output must include an ASCII field-name header row. The sandbox adapter validates and persists the verified stdout as the requested downloadable artifact.",
      parameters: Type.Object({
        language: Type.Union([
          Type.Literal("python"),
          Type.Literal("javascript"),
          Type.Literal("shell"),
        ]),
        code: Type.String(),
        attachmentIds: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
        expectedOutputs: Type.Optional(Type.Array(Type.String({
          description: "At most one requested output path; program stdout must be exactly that file's content.",
        }), { maxItems: 1 })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 120_000 })),
      }),
      executionMode: "parallel",
      replay: "safe",
      execute: async (_callId, params: any, signal, onUpdate) => {
        sandboxAttempts += 1;
        const hasStructuredDataAttachment = input.context.attachments.some((attachment) =>
          /(?:csv|spreadsheet|excel|json)/iu.test(attachment.mimeType)
          || /\.(?:csv|xlsx?|json)$/iu.test(attachment.fileName));
        if (
          hasStructuredDataAttachment
          && input.adapters.skills
          && loadedStructuredDataSkillIds.size === 0
        ) {
          structuredDataSkillGateFailures += 1;
          const terminal = structuredDataSkillGateFailures >= 2;
          const text = "A relevant spreadsheet or structured-data analysis Skill must be discovered and loaded before executing this attachment.";
          if (terminal) {
            authoritativeSummaries.length = 0;
            authoritativeSummaries.push("结构化附件未执行：连续两次未加载适用的表格或数据分析 Skill，系统已停止重复调用。请先加载匹配的 Skill 后重试。");
            sandboxConclusiveResults += 1;
          }
          return toolResult({
            status: "failed",
            text,
            details: {
              reason: "structured_data_skill_not_loaded",
              deterministicFailure: true,
              ...(terminal ? { verifiedFailure: true } : {}),
            },
          });
        }
        await input.telemetry.event({
          type: "sandbox.started",
          module: "sandbox",
          toolName: "execute_in_sandbox",
        });
        let result: PiCapabilityResult;
        try {
          result = await executeAdapter({
            module: "sandbox",
            operation: "execute",
            toolName: "execute_in_sandbox",
            retrySafe: false,
            maximumRetries: 0,
            signal: mergeSignals(input.signal, signal),
            telemetry: input.telemetry,
            call: (activeSignal) => input.adapters.sandbox!.execute({
              language: params.language,
              code: params.code,
              attachmentIds: params.attachmentIds ?? [],
              expectedOutputs: params.expectedOutputs ?? [],
              timeoutMs: params.timeoutMs ?? 30_000,
              context: input.context,
              signal: activeSignal,
              onProgress: (message) => onUpdate?.({
                content: [{ type: "text", text: message }],
                details: { progress: message },
              }),
            }),
          });
        } catch (error) {
          authoritativeSummaries.length = 0;
          throw error;
        }
        sandboxEvidenceResults += 1;
        if (result.status === "pending_approval") pendingApproval = true;
        if (result.status === undefined || ["completed", "succeeded", "success"].includes(result.status)) {
          sandboxSuccesses += 1;
          sandboxConclusiveResults += 1;
        } else if (result.details?.["verifiedFailure"] === true) {
          sandboxConclusiveResults += 1;
        }
        collectResult(result, sources, artifacts);
        if (result.authoritativeSummary) {
          authoritativeSummaries.length = 0;
          authoritativeSummaries.push(result.authoritativeSummary);
        }
        await input.telemetry.event({
          type: "sandbox.completed",
          module: "sandbox",
          toolName: "execute_in_sandbox",
          status: result.status ?? "completed",
          data: { resultRef: result.resultRef },
        });
        for (const artifact of result.artifacts ?? []) {
          await input.telemetry.event({
            type: "artifact.created",
            module: "artifact",
            status: "created",
            data: { artifactId: artifact.id, fileName: artifact.fileName },
          });
        }
        return toolResult(result);
      },
    });
  }

  if (input.adapters.artifacts) {
    tools.push({
      name: "register_artifacts",
      label: "Deliver files",
      description:
        "Register files produced by a successful sandbox run with the product artifact service and verify that they are accessible before presenting links.",
      parameters: Type.Object({
        sandboxResultRef: Type.String(),
        paths: Type.Array(Type.String(), { minItems: 1, maxItems: 16 }),
      }),
      executionMode: "sequential",
      replay: "safe",
      execute: async (_callId, params: any, signal) => {
        const result = await executeAdapter({
          module: "artifact",
          operation: "register",
          toolName: "register_artifacts",
          retrySafe: true,
          maximumRetries: input.maximumRetries,
          signal: mergeSignals(input.signal, signal),
          telemetry: input.telemetry,
          call: (activeSignal) => input.adapters.artifacts!.register({
            sandboxResultRef: params.sandboxResultRef,
            paths: params.paths,
            context: input.context,
            signal: activeSignal,
          }),
        });
        collectResult(result, sources, artifacts);
        if (result.authoritativeSummary) authoritativeSummaries.push(result.authoritativeSummary);
        for (const artifact of result.artifacts ?? []) {
          await input.telemetry.event({
            type: "artifact.created",
            module: "artifact",
            status: "registered",
            data: { artifactId: artifact.id, fileName: artifact.fileName },
          });
        }
        return toolResult(result);
      },
    });
  }

  if (input.adapters.handoff) {
    tools.push({
      name: "request_human_handoff",
      label: "Human handoff",
      description:
        "Actually request transfer of the current conversation to a human. Report connected, queued, failed, or unavailable exactly as returned; accepted/queued never means connected.",
      parameters: Type.Object({
        reason: Type.String(),
        summary: Type.String({ maxLength: 2_000 }),
        priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
      }),
      executionMode: "sequential",
      replay: "safe",
      execute: async (_callId, params: any, signal) => {
        const result = await executeAdapter({
          module: "handoff",
          operation: "request",
          toolName: "request_human_handoff",
          retrySafe: false,
          maximumRetries: 0,
          signal: mergeSignals(input.signal, signal),
          telemetry: input.telemetry,
          call: (activeSignal) => input.adapters.handoff!.request({
            reason: params.reason,
            summary: params.summary,
            ...(params.priority !== undefined ? { priority: params.priority } : {}),
            context: input.context,
            signal: activeSignal,
          }),
        });
        handoff = parseHandoff(result);
        authoritativeSummaries.length = 0;
        authoritativeSummaries.push(result.authoritativeSummary ?? result.text);
        await input.telemetry.event({
          type: "handoff.updated",
          module: "handoff",
          status: handoff.status,
          data: { ...handoff },
        });
        return toolResult(result);
      },
    });
    if (input.adapters.handoff.cancel) {
      tools.push({
        name: "cancel_human_handoff",
        label: "Cancel handoff",
        description: "Cancel the current queued human handoff and report only the confirmed result.",
        parameters: Type.Object({
          transferId: Type.Optional(Type.String()),
          queueId: Type.Optional(Type.String()),
        }),
        executionMode: "sequential",
        replay: "safe",
        execute: async (_callId, params: any, signal) => {
          const result = await executeAdapter({
            module: "handoff",
            operation: "cancel",
            toolName: "cancel_human_handoff",
            retrySafe: false,
            maximumRetries: 0,
            signal: mergeSignals(input.signal, signal),
            telemetry: input.telemetry,
            call: (activeSignal) => input.adapters.handoff!.cancel!({
              ...(params.transferId ? { transferId: params.transferId } : {}),
              ...(params.queueId ? { queueId: params.queueId } : {}),
              context: input.context,
              signal: activeSignal,
            }),
          });
          handoff = parseHandoff(result);
          authoritativeSummaries.length = 0;
          authoritativeSummaries.push(result.authoritativeSummary ?? result.text);
          await input.telemetry.event({
            type: "handoff.updated",
            module: "handoff",
            status: handoff.status,
            data: { ...handoff },
          });
          return toolResult(result);
        },
      });
    }
  }

  return {
    tools,
    sources,
    artifacts,
    getHandoff: () => handoff,
    getPendingApproval: () => pendingApproval,
    getKnowledgeAttempts: () => knowledgeAttempts,
    getKnowledgeOutcome: () => knowledgeOutcome,
    getCurrentInformationAttempts: () => currentInformationAttempts,
    getMcpWriteAttempts: () => mcpWriteAttempts,
    getAuthoritativeSummary: () => authoritativeSummaries.length
      ? [...new Set(authoritativeSummaries)].join("\n\n")
      : undefined,
    getSandboxAttempts: () => sandboxAttempts,
    getSandboxEvidenceResults: () => sandboxEvidenceResults,
    getSandboxConclusiveResults: () => sandboxConclusiveResults,
    getSandboxSuccesses: () => sandboxSuccesses,
    acceptSandboxRecoveryResult: (result) => {
      sandboxAttempts += 1;
      sandboxEvidenceResults += 1;
      const succeeded = result.status === undefined
        || ["completed", "succeeded", "success"].includes(result.status);
      if (succeeded) sandboxSuccesses += 1;
      if (succeeded || result.details?.["verifiedFailure"] === true) {
        sandboxConclusiveResults += 1;
      }
      collectResult(result, sources, artifacts);
      authoritativeSummaries.length = 0;
      authoritativeSummaries.push(result.authoritativeSummary ?? result.text);
      return succeeded;
    },
  };
}

function buildMcpTool(input: {
  adapter: NonNullable<PiCapabilityAdapters["mcp"]>;
  descriptor: PiMcpToolDescriptor;
  context: PiToolContext;
  telemetry: PiTelemetry;
  maximumRetries: number;
  signal: AbortSignal;
  sources: PiToolBuildResult["sources"];
  artifacts: PiToolBuildResult["artifacts"];
  authoritativeSummaries: string[];
  onWriteAttempt: () => void;
  onReadAttempt: () => void;
  onPendingApproval: () => void;
}): AgentTool<any> {
  const toolName = mcpToolName(input.descriptor.server, input.descriptor.name);
  return {
    name: toolName,
    label: `${input.descriptor.server}: ${input.descriptor.name}`,
    description: `${input.descriptor.description} Preserve the returned service, provider, record identifiers, and data time.`,
    parameters: input.descriptor.inputSchema as TSchema,
    executionMode: input.descriptor.readOnly ? "parallel" : "sequential",
    replay: input.descriptor.readOnly || input.descriptor.idempotent ? "safe" : "never",
    execute: async (_callId, params: any, signal) => {
      if (input.descriptor.readOnly) input.onReadAttempt();
      else input.onWriteAttempt();
      const result = await executeAdapter({
        module: "mcp",
        operation: `${input.descriptor.server}.${input.descriptor.name}`,
        toolName,
        retrySafe: input.descriptor.readOnly || input.descriptor.idempotent,
        maximumRetries:
          input.descriptor.readOnly || input.descriptor.idempotent
            ? input.maximumRetries
            : 0,
        signal: mergeSignals(input.signal, signal),
        telemetry: input.telemetry,
        call: (activeSignal) => input.adapter.callTool({
          server: input.descriptor.server,
          tool: input.descriptor.name,
          arguments: params as Record<string, unknown>,
          idempotencyKey: `${input.context.idempotencyKey}:mcp:${input.descriptor.server}:${input.descriptor.name}:${stableArgumentsHash(params)}`,
          context: input.context,
          signal: activeSignal,
        }),
      });
      if (result.status === "pending_approval") input.onPendingApproval();
      collectResult(result, input.sources, input.artifacts);
      if (result.authoritativeSummary) {
        input.authoritativeSummaries.push(result.authoritativeSummary);
      }
      return toolResult(result);
    },
  };
}

function stableArgumentsHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

async function executeSkillDiscovery(input: {
  query: string;
  maximumResults: number;
  input: Parameters<typeof buildPiTools>[0];
  signal?: AbortSignal;
}) {
  let descriptors: Awaited<ReturnType<NonNullable<PiCapabilityAdapters["skills"]>["discover"]>> = [];
  await executeAdapter({
    module: "skill",
    operation: "discover",
    toolName: "discover_skills",
    retrySafe: true,
    maximumRetries: input.input.maximumRetries,
    signal: mergeSignals(input.input.signal, input.signal),
    telemetry: input.input.telemetry,
    call: async (activeSignal) => {
      descriptors = await input.input.adapters.skills!.discover({
        query: input.query,
        maximumResults: input.maximumResults,
        context: input.input.context,
        signal: activeSignal,
      });
      return { text: "Skills discovered.", details: { descriptors } };
    },
  });
  return descriptors;
}

async function executeAdapter(input: {
  module: PiModule;
  operation: string;
  toolName: string;
  retrySafe: boolean;
  maximumRetries: number;
  signal: AbortSignal;
  telemetry: PiTelemetry;
  skillId?: string;
  call: (signal: AbortSignal) => Promise<PiCapabilityResult>;
}): Promise<PiCapabilityResult> {
  const logicalCallId = randomUUID();
  let lastError: unknown;
  for (let attempt = 1; attempt <= input.maximumRetries + 1; attempt += 1) {
    if (input.signal.aborted) throw abortError(input.signal.reason);
    const spanId = input.telemetry.start({
      module: input.module,
      operation: input.operation,
      toolName: input.toolName,
      logicalCallId,
      attempt,
      ...(input.skillId ? { skillId: input.skillId } : {}),
    });
    try {
      const result = await input.call(input.signal);
      input.telemetry.end(spanId, {
        status: "ok",
        ...(result.resultRef ? { resultRef: result.resultRef } : {}),
      });
      return result;
    } catch (error) {
      lastError = error;
      const cancelled = input.signal.aborted || isAbortError(error);
      input.telemetry.end(spanId, {
        status: cancelled ? "cancelled" : isTimeoutError(error) ? "timeout" : "error",
        error: errorMessage(error),
      });
      if (cancelled || !input.retrySafe || attempt > input.maximumRetries) throw error;
      const backoffMs = Math.min(1_000, 50 * 2 ** (attempt - 1));
      const waitSpan = input.telemetry.start({
        module: "wait",
        operation: "retry_backoff",
        logicalCallId,
        attempt,
        retryBackoffMs: backoffMs,
      });
      await delay(backoffMs, input.signal);
      input.telemetry.end(waitSpan, { status: "ok" });
    }
  }
  throw lastError;
}

function toolResult(result: PiCapabilityResult) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        status: result.status ?? "completed",
        result: result.text,
        details: result.details ?? {},
        sources: result.sources ?? [],
        artifacts: result.artifacts ?? [],
        resultRef: result.resultRef ?? null,
        authoritativeSummary: result.authoritativeSummary ?? null,
      }),
    }],
    details: result.details ?? {},
  };
}

function collectResult(
  result: PiCapabilityResult,
  sources: PiToolBuildResult["sources"],
  artifacts: PiToolBuildResult["artifacts"],
) {
  for (const source of result.sources ?? []) {
    if (!sources.some((candidate) => candidate.id === source.id)) sources.push(source);
  }
  for (const artifact of result.artifacts ?? []) {
    if (artifacts.some((candidate) => candidate.id === artifact.id)) continue;
    const staleIndex = artifacts.findIndex((candidate) => candidate.fileName === artifact.fileName);
    if (staleIndex >= 0) artifacts.splice(staleIndex, 1);
    artifacts.push(artifact);
  }
}

function isStructuredDataSkillDescriptor(
  descriptor: Record<string, unknown> | undefined,
) {
  if (!descriptor) return false;
  const value = [
    descriptor["id"],
    descriptor["slug"],
    descriptor["name"],
    descriptor["displayName"],
    descriptor["description"],
    ...(Array.isArray(descriptor["capabilityTags"])
      ? descriptor["capabilityTags"]
      : []),
  ].filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLocaleLowerCase();
  return /spreadsheet|csv|excel|tabular|data[-_ ]?analysis|sales[-_ ]?ranking|表格|数据分析|销售排名/u.test(value);
}

function parseHandoff(result: PiCapabilityResult): NonNullable<PiAgentRunResult["handoff"]> {
  const details = result.details ?? {};
  return {
    status: String(details["status"] ?? result.status ?? "unknown"),
    ...(typeof details["transferId"] === "string"
      ? { transferId: details["transferId"] }
      : typeof details["transfer_id"] === "string"
        ? { transferId: details["transfer_id"] }
        : {}),
    ...(typeof details["queueId"] === "string"
      ? { queueId: details["queueId"] }
      : typeof details["queue_id"] === "string"
        ? { queueId: details["queue_id"] }
        : {}),
  };
}

function normalizeMcpDescriptors(value: unknown): PiMcpToolDescriptor[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PiMcpToolDescriptor => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const candidate = item as Record<string, unknown>;
    return typeof candidate["server"] === "string"
      && typeof candidate["name"] === "string"
      && typeof candidate["description"] === "string"
      && Boolean(candidate["inputSchema"])
      && typeof candidate["readOnly"] === "boolean"
      && typeof candidate["idempotent"] === "boolean";
  });
}

function mcpToolName(server: string, tool: string) {
  const normalized = `${server}__${tool}`
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  return `mcp__${normalized || "tool"}`;
}

function mergeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 1) return active[0]!;
  const combined = AbortSignal.any(active);
  setMaxListeners(64, combined);
  return combined;
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal.reason));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(reason: unknown) {
  const error = new Error(typeof reason === "string" ? reason : "Operation cancelled.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && /timed?\s*out|timeout/iu.test(error.message);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

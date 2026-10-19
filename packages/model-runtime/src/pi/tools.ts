import { createHash, randomUUID } from "node:crypto";
import { setMaxListeners } from "node:events";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { agentTextFileOutput, agentTextFileOutputNotice } from "@delegate/domain";
import { AgentActionIdentityError, isActionIdentityError, auditErrorCode } from "@delegate/runtime";

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
  actionContext?: (callId: string) => PiToolContext;
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
        "Retrieve evidence from the represented owner's authorized knowledge library for that owner's facts, policies, services or explicitly designated materials. Access is scoped by the bound server session; do not request credential values. Reuse still-valid evidence when sufficient. Specialty explanations follow the published knowledge policy (materials-first or materials-only when configured). Otherwise, stable general explanations and other companies' public facts do not automatically require this library. A miss is not evidence that no fact or policy exists.",
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
        ...(input.actionContext ? { actionContext: input.actionContext } : {}),
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
                runtimeFileOutputCapabilities: agentTextFileOutput,
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
    if (input.adapters.sandbox.browse) {
      tools.push({
        name: "browse_in_sandbox",
        label: "Sandbox browser",
        description: "Look up public information across topics using the configured sandbox's real browser. This general lookup capability also works when no topic-specific MCP/API is installed. Open a relevant public HTTP(S) page; if the source URL is unknown, open a public search-engine results page and follow relevant links. Returns title, visible text, links and screenshot. Use this managed browser instead of writing browser launch code. The broker applies the configured policy and approval. Report only observed facts; preserve the source's data time separately from page observation time. If a page lacks the requested facts, try a relevant alternative or explain the gap; page-load success alone is not task completion.",
        parameters: Type.Object({ url: Type.String({ description: "Public HTTP(S) page to open." }) }),
        executionMode: "sequential",
        replay: "safe",
        execute: async (callId, params: any, signal) => {
          sandboxAttempts += 1;
          const actionContext = input.actionContext?.(callId) ?? input.context;
          await input.telemetry.event({ type: "sandbox.started", module: "sandbox", toolName: "browse_in_sandbox" });
          const result = await executeAdapter({
            module: "sandbox", operation: "browse", toolName: "browse_in_sandbox",
            retrySafe: false, maximumRetries: 0,
            signal: mergeSignals(input.signal, signal), telemetry: input.telemetry,
            call: activeSignal => input.adapters.sandbox!.browse!({
              url: params.url, context: actionContext, signal: activeSignal,
            }),
          });
          sandboxEvidenceResults += 1;
          if (result.status === "pending_approval") pendingApproval = true;
          if (result.status === undefined || ["completed", "succeeded", "success"].includes(result.status)) {
            sandboxSuccesses += 1;
            sandboxConclusiveResults += 1;
          } else if (result.details?.["verifiedFailure"] === true) sandboxConclusiveResults += 1;
          collectResult(result, sources, artifacts);
          if (result.authoritativeSummary) {
            authoritativeSummaries.length = 0;
            authoritativeSummaries.push(result.authoritativeSummary);
          }
          await input.telemetry.event({ type: "sandbox.completed", module: "sandbox", toolName: "browse_in_sandbox", status: result.status ?? "completed" });
          for (const artifact of result.artifacts ?? []) {
            await input.telemetry.event({ type: "artifact.created", module: "artifact", status: "created", data: { artifactId: artifact.id, fileName: artifact.fileName } });
          }
          return toolResult(result);
        },
      });
    }
    tools.push({
      name: "execute_in_sandbox",
      label: "Sandbox",
      description:
        `Request restricted Python execution for calculations and data analysis. The server first checks availability, authorization and approval. Current profile: one process, standard library, no network, threads, subprocesses or package installation; read-only declared inputs, fresh temporary workspace, maximum 30 seconds, 256 MiB address space. JavaScript, shell and persistent processes are unavailable. A code hash or risk label grants no execution permission. ${agentTextFileOutputNotice.en} Use browse_in_sandbox for public web/browser requests. Never print invented values as execution evidence. For a supported output file, print exactly its final UTF-8 contents to stdout without extra logs. CSV requires a nonempty header and consistent row widths; JSON must parse. The adapter verifies stored bytes and current audience download access before confirming delivery.`,
      parameters: Type.Object({
        language: Type.Union([
          Type.Literal("python"),
        ]),
        code: Type.String({ description: "Python source. When expectedOutputs declares a file, output its complete final contents to stdout; the server creates the downloadable file. Writing a sandbox path alone does not deliver it. Example: code=print(2+3), expectedOutputs=[\"result.txt\"] produces a text file containing 5." }),
        attachmentIds: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
        expectedOutputs: Type.Optional(Type.Array(Type.String({
          description: "One .txt, .md, .csv or .json filename (ASCII letters, digits, dots, underscores, hyphens), optionally under outputs/ or /workspace/outputs/. No binary formats. Stdout must equal the final content, at most 65536 UTF-8 bytes.",
        }), { maxItems: 1 })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 30_000 })),
      }),
      executionMode: "sequential",
      replay: "never",
      execute: async (callId, params: any, signal, onUpdate) => {
        const actionContext = input.actionContext?.(callId) ?? input.context;
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
              context: { ...actionContext, idempotencyKey: actionContext.logicalAction ? actionContext.idempotencyKey : `${input.context.idempotencyKey}:python:${callId}` },
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
  actionContext?: (callId: string) => PiToolContext;
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
    executionMode: input.descriptor.readOnly && input.descriptor.approvalRequired === false ? "parallel" : "sequential",
    replay: input.descriptor.readOnly || input.descriptor.idempotent ? "safe" : "never",
    execute: async (callId, params: any, signal) => {
      const actionContext = input.actionContext?.(callId) ?? input.context;
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
          idempotencyKey: actionContext.logicalAction ? actionContext.idempotencyKey : `${input.context.idempotencyKey}:mcp:${input.descriptor.readOnly ? callId : "action"}:${input.descriptor.server}:${input.descriptor.name}:${stableArgumentsHash(params)}`,
          context: actionContext,
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
      if (isActionIdentityError(error)) throw new AgentActionIdentityError(error.code);
      const cancelled = input.signal.aborted || isAbortError(error);
      input.telemetry.end(spanId, {
        status: cancelled ? "cancelled" : isTimeoutError(error) ? "timeout" : "error",
        error: errorMessage(error),
      });
      if (cancelled) throw abortError(auditErrorCode(error));
      if (!input.retrySafe || attempt > input.maximumRetries) {
        // SDK tool failures become model-visible tool results. Do not forward
        // transport errors that can contain credentials or private payloads.
        throw new Error(auditErrorCode(error));
      }
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
  throw new Error(auditErrorCode(lastError));
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
        contextSourceRef: result.contextSourceRef,
        authoritativeSummary: result.authoritativeSummary ?? null,
        observation: result.observation,
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
    const classification = candidate["effectClassification"];
    // Unknown host behavior is unavailable, not a writable tool that a
    // confirmation can authorize. Keep legacy adapter contracts compatible.
    if (classification !== undefined
      && !(classification === "read" && candidate["readOnly"] === true)
      && !(classification === "write" && candidate["readOnly"] === false)) return false;
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

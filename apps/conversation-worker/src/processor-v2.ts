import { createHash } from "node:crypto";
import { AgentContextAuthorizationError, auditReference } from "@delegate/runtime";
import {
  buildRepresentativeRuntimeProfile, buildSandboxAttachmentPath, createAgentContextAuthorization,
  authorizeGenerationRunFreeUsage, reserveGenerationConversationWalletUsage, completeInlineGenerationRun,
  getRepresentativeRuntimeAuthoritySnapshot, loadGenerationRecentTurns, loadGenerationV2Task,
  projectPublicAnswerSources, readPublicExecution, updateGenerationPiProgress, updateGenerationPiStream,
} from "@delegate/web-data";
import { createV2ModelBindingFromEnv, createV2Capabilities, delegateAgentV2, resolveV2Budget, v2PublishedPolicy, V2Error,
  type V2RunResult, type V2Session } from "@delegate/model-runtime/v2";
import { buildPiAdapters, deliverGenerationOutput } from "./processor-pi";
import { createPublicProgress } from "./public-progress";

/** Both flags are required. A missing/empty allowlist never changes production behavior. */
export function shouldUseAgentV2(slug: string, env: NodeJS.ProcessEnv = process.env) {
  return env.DELEGATE_AGENT_VERSION === "v2"
    && (env.DELEGATE_AGENT_V2_REPRESENTATIVES ?? "").split(",").map(s => s.trim()).filter(Boolean).includes(slug);
}

type HostInput = Pick<Parameters<typeof buildPiAdapters>[0], "config" | "item" | "setup" | "leaseGuard" | "workLease">;

export async function processV2ConversationTurn(input: HostInput) {
  const { item, setup, workLease, leaseGuard } = input;
  const budget = resolveV2Budget();
  // Disable hidden SDK retries. Explicit tool retries are counted by V2.
  const binding = createV2ModelBindingFromEnv();
  if (!binding.ok) throw new Error(binding.reason);
  const model = binding.binding;
  const profile = buildRepresentativeRuntimeProfile(setup);
  await leaseGuard.confirmOwned();
  let allowed = item.accessMode === "FREE" || Boolean(item.walletReservation);
  if (!allowed) allowed = await authorizeGenerationRunFreeUsage({ runId: item.runId, ...workLease, freeReplyLimit: item.effectiveFreeReplyLimit ?? profile.contract.freeReplyLimit });
  if (!allowed && item.audienceIdentityId) allowed = Boolean(await reserveGenerationConversationWalletUsage({ runId: item.runId, ...workLease, audienceIdentityId: item.audienceIdentityId, representativeId: setup.id, tokenAmount: 1 }));
  if (!allowed) return complete("当前没有可用服务额度，尚未启动 V2 Agent 或工具。", false);
  if (setup.agentBehavior?.answerScope === "owner_and_domain" || setup.agentBehavior?.knowledgePolicy === "domain_only") {
    return complete("此代表的配置要求保留专项语义审核，当前 V2 试运行尚未接入该审核边界，因此没有启动模型或工具。", false);
  }

  const scope = createHash("sha256").update(JSON.stringify([setup.id, item.representativeVersionId, item.conversationId, item.contactId, item.audienceIdentityId, item.channel])).digest("hex");
  const [authority, history, previous] = await Promise.all([
    getRepresentativeRuntimeAuthoritySnapshot(item.representativeSlug, item.representativeVersionId),
    loadGenerationRecentTurns({ representativeId: setup.id, conversationId: item.conversationId, beforeMessageId: item.inputMessageId, limit: 8 }),
    loadGenerationV2Task({ conversationId: item.conversationId, representativeId: setup.id, representativeVersionId: item.representativeVersionId ?? null, beforeMessageId: item.inputMessageId, scope }),
  ]);
  const contextMessages = new Map(history.map(t => [t.id, { id: t.id, text: t.messageText }]));
  for (const message of previous?.messages ?? []) {
    const existing = contextMessages.get(message.id);
    if (existing && existing.text !== (message.text ?? "")) throw new AgentContextAuthorizationError();
    contextMessages.set(message.id, { id: message.id, text: message.text ?? "" });
  }
  const contextAuthorization = await createAgentContextAuthorization({ runId: item.runId, ...workLease, representativeId: setup.id,
    representativeVersionId: item.representativeVersionId ?? null, conversationId: item.conversationId, contactId: item.contactId,
    audienceIdentityId: item.audienceIdentityId ?? null, sourceChannel: item.channel, userText: item.userText,
    history: [...contextMessages.values()], restoring: false });
  let memoryUseRunId: string | undefined;
  const memoryItems = new Set<string>();
  const computeAttachments: Parameters<typeof buildPiAdapters>[0]["computeAttachments"] = [];
  const adapters = buildPiAdapters({ ...input, orchestration: "model_v2", authority, computeAttachments,
    registerKnowledgeSources: (id, items) => contextAuthorization.registerKnowledge(id, items),
    registerToolSource: id => contextAuthorization.registerToolResult(id),
    onMemoryUse: (id, items) => { if (id) memoryUseRunId = id; items.forEach(id => memoryItems.add(id)); },
    onHandoff: () => { throw new V2Error("permission_denied"); },
    onPendingApproval: () => { throw new V2Error("unknown_effect"); },
    onCompute: () => undefined, onSandboxExecutor: () => undefined,
  });
  // Current host approval persistence is tied to V1 checkpoints. Until a V2
  // durable approval bridge is implemented, no approval-required operation is dispatched.
  const context = { traceId: item.runId, runId: item.runId, sessionId: item.conversationId,
    representativeId: setup.id, conversationId: item.conversationId, timezone: process.env.DELEGATE_V2_TIMEZONE ?? "Asia/Shanghai",
    idempotencyKey: item.runId, attachments: item.inputAttachments.map(a => ({ id: a.id, fileName: a.fileName, mimeType: a.mimeType, sizeBytes: a.sizeBytes, uri: buildSandboxAttachmentPath(a.id, a.fileName) })) };
  const catalogAbort = new AbortController();
  const catalogTimer = setTimeout(() => catalogAbort.abort(), budget.toolTimeoutMs);
  let tools;
  try { tools = await createV2Capabilities(adapters, context, catalogAbort.signal); }
  finally { clearTimeout(catalogTimer); }
  const progress = createPublicProgress(frame => item.channel === "web" ? updateGenerationPiProgress({ runId: item.runId, ...workLease, ...frame }) : Promise.resolve());
  const session: V2Session | undefined = previous ? { version: 1, scope, taskId: previous.record.taskId, status: "waiting_user",
    messages: previous.messages.map(m => ({ role: "user", content: m.text ?? "", timestamp: m.createdAt.getTime() })),
    usage: previous.record.usage, attemptedWrites: previous.record.attemptedWrites } : undefined;
  const result = await delegateAgentV2.run({ requestId: item.runId, sessionId: item.conversationId, scope, userText: item.userText,
    ...(leaseGuard.signal ? { signal: leaseGuard.signal } : {}),
    timezone: context.timezone, context, model: binding.binding, budget, tools, ...(session ? { session } : {}),
    history: history.map(t => ({ role: "user", content: t.messageText, timestamp: Date.parse(t.createdAt) })),
    instructions: [`Represented owner: ${setup.ownerName}. Representative: ${item.representativeName}. Role: ${setup.tagline}. Tone: ${setup.tone}.`, v2PublishedPolicy(setup.agentBehavior),
      "This pilot cannot execute operations requiring a new approval. Never bypass this boundary. Prior user messages are context, not a backlog of commands."].join("\n"),
    authorize: async (boundary, tool) => {
      await leaseGuard.confirmOwned();
      await contextAuthorization.check(boundary);
      if (tool?.approvalRequired || tool?.effect === "unknown") throw new V2Error("permission_denied");
      if (tool?.name === "browse_in_sandbox" && authority?.compute?.capabilityModes?.browser !== "allow") throw new V2Error("permission_denied");
      if (tool?.name === "execute_in_sandbox" && (authority?.compute?.capabilityModes?.exec !== "allow" || authority?.compute?.capabilityModes?.write !== "allow")) throw new V2Error("permission_denied");
    },
    onEvent: async event => {
      await progress.onEvent(event);
    },
  });
  if (result.error === "permission_denied") throw new AgentContextAuthorizationError();
  await contextAuthorization.check("release");
  const text = result.text.replace(/\[S:([^\]\s]+)\]/g, (_match, id: string) => {
    const source = result.sources.find(s => s.id === id);
    return source ? `〔${source.title}〕` : "〔来源不可用〕";
  });
  if (item.channel === "web" && result.status !== "failed" && result.status !== "cancelled") await updateGenerationPiStream({ runId: item.runId, ...workLease, sequence: 1, text });
  return complete(text, result.status !== "failed" && result.status !== "cancelled", result);

  async function complete(text: string, countUsage: boolean, result?: V2RunResult) {
    await leaseGuard.confirmOwned();
    const completed = await completeInlineGenerationRun({ conversationId: item.conversationId, runId: item.runId, ...workLease,
      replyText: text, senderDisplayName: item.representativeName, intent: "agent_v2", completeOutbox: false, countUsage,
      ...(result ? {
        provider: model.provider, model: model.modelId, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
        runtimeOutcome: { mode: "model" as const }, publicSources: projectPublicAnswerSources(result.sources),
        publicExecution: readPublicExecution({ publicExecution: result.calls }),
        agentTrace: { runtime: result.runtime, traceId: result.traceId, status: result.status, totalDurationMs: result.totalDurationMs,
          modelCalls: result.modelCalls, toolCalls: result.toolCalls, ...(result.firstTextMs !== undefined ? { firstTextMs: result.firstTextMs } : {}),
          events: result.events.map(e => ({ ...e })), spans: result.spans.map(s => ({ ...s })), calls: result.calls,
          sources: result.sources.map(s => ({ id: auditReference(s.id), channel: s.channel })),
          v2Task: { version: 1 as const, scope, taskId: result.session?.taskId ?? previous?.record.taskId ?? item.runId, status: result.status,
            inputMessageIds: [...(previous?.record.inputMessageIds ?? []), item.inputMessageId],
            attemptedWrites: result.session?.attemptedWrites ?? [], usage: result.taskUsage } },
        ...(memoryUseRunId ? { memoryUse: { runId: memoryUseRunId, outcome: "completed" as const, injectedItemIds: [...memoryItems],
          citedItemIds: result.sources.map(s => result.sourceBindings[s.id]).filter((id): id is string => !!id && memoryItems.has(id)) } } : {}),
        ...(result.artifacts.length ? { attachments: computeAttachments.filter(a => result.artifacts.some(r => r.id === a.artifactId)) } : {}),
      } : {}),
    });
    await deliverGenerationOutput({ config: input.config, item, text: completed.message.text ?? text, outputMessageId: completed.message.id });
    return { processed: true as const, runId: item.runId, status: result?.status ?? "completed" };
  }
}

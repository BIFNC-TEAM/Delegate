import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AgentContextAuthorizationError, agentContextProofSchema, type AgentContextAuthorization, type AgentContextProof } from "@delegate/runtime";
import { prisma } from "./prisma";
import { fenceGenerationWorkLease, isGenerationWorkLeaseLostError } from "./conversation-platform";
import { revalidateMemoryUseContextSourcesInTransaction } from "./memory-use-execution";
import { resolveServerOwnedMcpCapabilityPolicy } from "./mcp-server-policy";

const scopeSchema = z.object({
  runId: z.string(), representativeId: z.string(), ownerId: z.string(), representativeVersionId: z.string().nullable(),
  conversationId: z.string(), contactId: z.string().nullable(), audienceIdentityId: z.string().nullable(),
  sourceChannel: z.string(), channel: z.string(), inputMessageId: z.string(), episodeId: z.string().nullable(), messageEpisodeId: z.string().nullable(),
}).strict();
const remoteSchema = z.object({ executionId: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/u), toolName: z.string() }).strict();
const stateSchema = z.object({
  version: z.literal(1), scope: scopeSchema,
  messages: z.array(z.object({ id: z.string(), hash: z.string() }).strict()).max(32),
  attachmentsHash: z.string(),
  memory: z.array(z.object({ useRunId: z.string(), itemIds: z.array(z.string()).max(256) }).strict()).max(1),
  // Optional preserves the proof of existing v1 manifests without remote data.
  remote: z.array(remoteSchema).max(64).optional(),
}).strict();
const accessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("anonymous_browser") }).strict(),
  z.object({ kind: z.literal("derived_python") }).strict(),
  z.object({ kind: z.literal("public_mcp"), bindingId: z.string(), bindingHash: z.string(), toolName: z.string(), runtimeToolName: z.string() }).strict(),
]);
const receiptSchema = z.object({ version: z.literal(1), executionId: z.string(), input: stateSchema, access: accessSchema,
  executionHash: z.string(), artifacts: z.array(z.object({ id: z.string(), hash: z.string() }).strict()).max(32), observedAt: z.string().datetime(),
}).strict();
export type AgentExecutionSourceCapture = { input: z.infer<typeof stateSchema>; access: z.infer<typeof accessSchema> };
type State = z.infer<typeof stateSchema>;
type Tx = Prisma.TransactionClient;
const key = "agentContextAuthorization";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const fail = (): never => { throw new AgentContextAuthorizationError(); };
const proof = (state: State): AgentContextProof => ({ version: 1, runId: state.scope.runId, revision: hash(state) });
const canonical = (value: any): any => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = (value: unknown) => hash(canonical(value));
type Graph = { visiting: Set<string>; checked: Set<string> };

async function frame(tx: Tx, runId: string, delivery = false) {
  const run = await tx.generationRun.findUnique({ where: { id: runId }, select: {
    id: true, status: true, conversationId: true, representativeVersionId: true, inputMessageId: true, episodeId: true, contextSnapshot: true,
    representativeVersion: { select: { representativeId: true, status: true } },
    inputMessage: { select: { conversationId: true, episodeId: true, redactedAt: true } },
    conversation: { select: { representativeId: true, contactId: true, audienceIdentityId: true, sourceChannel: true, channel: true,
      representative: { select: { ownerId: true } },
      audienceIdentity: { select: { status: true, mergedIntoId: true } },
      contact: { select: { audienceIdentityId: true } },
    } },
  } });
  if (!run || !(delivery ? ["PROCESSING", "WAITING_APPROVAL", "COMPLETED"] : ["PROCESSING", "WAITING_APPROVAL"]).includes(run.status)) return fail();
  const c = run.conversation;
  if ((c.contact?.audienceIdentityId ?? null) !== c.audienceIdentityId) return fail();
  if (run.inputMessage.conversationId !== run.conversationId || run.inputMessage.redactedAt
    || run.representativeVersion?.representativeId !== c.representativeId || run.representativeVersion.status !== "PUBLISHED") return fail();
  if (c.audienceIdentityId && (!c.audienceIdentity || !["REGISTERED", "ANONYMOUS"].includes(c.audienceIdentity.status)
    || c.audienceIdentity.mergedIntoId || c.contact?.audienceIdentityId !== c.audienceIdentityId)) return fail();
  const scope: State["scope"] = { runId, representativeId: c.representativeId, ownerId: c.representative.ownerId, representativeVersionId: run.representativeVersionId,
    conversationId: run.conversationId, contactId: c.contactId, audienceIdentityId: c.audienceIdentityId,
    sourceChannel: (c.sourceChannel ?? "web").toLowerCase(), channel: c.channel, inputMessageId: run.inputMessageId, episodeId: run.episodeId, messageEpisodeId: run.inputMessage.episodeId };
  return { scope, snapshot: record(run.contextSnapshot) };
}
async function messageStamps(tx: Tx, scope: State["scope"], ids: string[]) {
  if (new Set(ids).size !== ids.length || !ids.includes(scope.inputMessageId)) return fail();
  const rows = await tx.message.findMany({ where: { id: { in: ids }, conversationId: scope.conversationId, episodeId: scope.messageEpisodeId,
    senderType: "AUDIENCE", redactedAt: null }, select: { id: true, text: true } });
  if (rows.length !== ids.length) return fail();
  return rows.sort((a,b) => a.id.localeCompare(b.id)).map(row => ({ id: row.id, hash: hash(row.text ?? "") }));
}
async function attachmentStamp(tx: Tx, messageId: string) {
  const rows = await tx.messageAttachment.findMany({ where: { messageId }, orderBy: { id: "asc" },
    select: { id: true, fileName: true, mimeType: true, sizeBytes: true, checksum: true, objectKey: true } });
  return hash(rows);
}
async function validate(tx: Tx, state: State, delivery = false, graph: Graph = { visiting: new Set(), checked: new Set() }) {
  const current = await frame(tx, state.scope.runId, delivery);
  // Compare recipient/scope before reading any message body for its fingerprint.
  if (hash(current.scope) !== hash(state.scope)) return fail();
  if (state.messages.length > 1) {
    const policy = await tx.representativeMemoryPolicy.findUnique({ where: { representativeId: state.scope.representativeId }, select: { shortTermMemoryEnabled: true } });
    if (policy?.shortTermMemoryEnabled === false) return fail();
  }
  const messages = await messageStamps(tx, state.scope, state.messages.map(item => item.id));
  if (hash(messages) !== hash(state.messages) || await attachmentStamp(tx, state.scope.inputMessageId) !== state.attachmentsHash) return fail();
  for (const memory of state.memory) await revalidateMemoryUseContextSourcesInTransaction(tx, {
    generationRunId: state.scope.runId, conversationId: state.scope.conversationId, ...memory,
  });
  for (const remote of state.remote ?? []) await validateRemote(tx, state.scope, remote, delivery, graph);
}

async function mcpAccess(tx: Tx, scope: State["scope"], bindingId: string, toolName: string) {
  const binding = await tx.representativeMcpBinding.findFirst({ where: { id: bindingId, representativeId: scope.representativeId, enabled: true },
    select: { id: true, slug: true, serverUrl: true, transportKind: true, configRevision: true, allowedToolNames: true,
      representativeSkillPackLink: { select: { enabled: true } } } });
  if (!binding || binding.representativeSkillPackLink?.enabled === false) return undefined;
  const allowed = binding.allowedToolNames;
  if (!Array.isArray(allowed) || (allowed.length && !allowed.includes(toolName))) return undefined;
  const definition = await tx.mcpToolDefinition.findFirst({ where: { bindingId, bindingRevision: binding.configRevision, exactToolName: toolName, availability: "ready", supersededAt: null },
    select: { toolSchemaHash: true, bindingDefinitionHash: true, inputSchema: true } });
  if (!definition) return undefined;
  const policy = resolveServerOwnedMcpCapabilityPolicy({ serverUrl: binding.serverUrl, transportKind: binding.transportKind,
    toolName, toolSchemaHash: definition.toolSchemaHash, inputSchema: record(definition.inputSchema) });
  if (policy?.resultAccess !== "public_snapshot") return undefined;
  const normalized = `${binding.slug}__${toolName}`.normalize("NFKC").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96);
  return { kind: "public_mcp" as const, bindingId, bindingHash: fingerprint({ binding, definition, policyId: policy.policyId, resultAccess: policy.resultAccess }),
    toolName, runtimeToolName: `mcp__${normalized || "tool"}` };
}
async function executionParts(tx: Tx, scope: State["scope"], executionId: string) {
  // Constrain scope before reading private request parameters for fingerprints.
  const execution = await tx.toolExecution.findFirst({ where: { id: executionId, status: "SUCCEEDED", session: {
    generationRunId: scope.runId, representativeId: scope.representativeId, conversationId: scope.conversationId, contactId: scope.contactId, requestedBy: "AUDIENCE" } },
    select: { id: true, sessionId: true, capability: true, mcpBindingId: true, approvalRequestId: true, requestPayload: true,
      requestedCommand: true, requestedPath: true, semanticOutcome: true, transportOutcome: true, finishedAt: true,
      artifacts: { orderBy: { id: "asc" }, select: { id: true, representativeId: true, conversationId: true, contactId: true, sessionId: true,
        toolExecutionId: true, kind: true, objectKey: true, sha256: true, mimeType: true, sizeBytes: true, retentionUntil: true } } } });
  if (!execution || !execution.finishedAt || !execution.artifacts.length || execution.artifacts.length > 32) return fail();
  const { artifacts, ...action } = execution;
  for (const artifact of artifacts) if (artifact.representativeId !== scope.representativeId || artifact.conversationId !== scope.conversationId
    || artifact.contactId !== scope.contactId || artifact.sessionId !== execution.sessionId || (artifact.retentionUntil && artifact.retentionUntil <= new Date())) return fail();
  return { action, executionHash: fingerprint(action), artifacts: artifacts.map(artifact => ({ id: artifact.id, hash: fingerprint(artifact) })) };
}
async function validateRemote(tx: Tx, scope: State["scope"], reference: z.infer<typeof remoteSchema>, delivery: boolean, graph: Graph) {
  const key = `${reference.executionId}:${reference.revision}`;
  if (graph.checked.has(key)) return;
  if (graph.visiting.has(key) || graph.checked.size + graph.visiting.size >= 64) return fail();
  const row = await tx.toolExecution.findFirst({ where: { id: reference.executionId, session: { generationRunId: scope.runId } }, select: { sourceReceipt: true } });
  const receipt = receiptSchema.parse(row?.sourceReceipt);
  if (receipt.executionId !== reference.executionId || fingerprint(receipt) !== reference.revision || hash(receipt.input.scope) !== hash(scope)
    || receiptToolName(receipt.access) !== reference.toolName) return fail();
  graph.visiting.add(key);
  await validate(tx, receipt.input, delivery, graph);
  if (receipt.access.kind === "public_mcp" && fingerprint(await mcpAccess(tx, scope, receipt.access.bindingId, receipt.access.toolName)) !== fingerprint(receipt.access)) return fail();
  // Reusable snapshots are not live data. Bound model reuse; historical files
  // remain downloadable under current source permissions and retention.
  if (!delivery && receipt.access.kind !== "derived_python" && Date.now() - Date.parse(receipt.observedAt) > 60 * 60 * 1000) return fail();
  const current = await executionParts(tx, scope, reference.executionId);
  if (current.executionHash !== receipt.executionHash || fingerprint(current.artifacts) !== fingerprint(receipt.artifacts)) return fail();
  graph.visiting.delete(key); graph.checked.add(key);
}
function receiptToolName(access: z.infer<typeof accessSchema>) {
  return access.kind === "anonymous_browser" ? "browse_in_sandbox" : access.kind === "derived_python" ? "execute_in_sandbox" : access.runtimeToolName;
}

/** Broker captures the currently authorized dependencies before dispatch.
 * The public-browser contract may only be selected by its anonymous recipe. */
export async function captureAgentExecutionSources(input: { runId: string; kind: "anonymous_browser" | "derived_python" | "public_mcp"; bindingId?: string; toolName?: string }) {
  return safe(() => prisma.$transaction(async tx => {
    const current = await frame(tx, input.runId);
    if (!current.snapshot[key]) return undefined; // legacy/non-Pi remains untracked
    const state = stateSchema.parse(current.snapshot[key]); await validate(tx, state);
    const access = input.kind === "public_mcp" ? input.bindingId && input.toolName ? await mcpAccess(tx, state.scope, input.bindingId, input.toolName) : undefined : { kind: input.kind };
    return access ? { input: state, access } satisfies AgentExecutionSourceCapture : undefined;
  }));
}

/** Called in the completion transaction. Does not erase business success if
 * inputs have since been withdrawn; future readers must reauthorize them. */
export async function persistAgentExecutionSourceReceipt(tx: Tx, executionId: string, captured: AgentExecutionSourceCapture) {
  const input = stateSchema.parse(captured.input); const access = accessSchema.parse(captured.access);
  const parts = await executionParts(tx, input.scope, executionId);
  if ((access.kind === "anonymous_browser" && parts.action.capability !== "BROWSER")
    || (access.kind === "derived_python" && parts.action.capability !== "EXEC")
    || (access.kind === "public_mcp" && (parts.action.capability !== "MCP" || parts.action.mcpBindingId !== access.bindingId || parts.action.requestedCommand !== access.toolName))) return fail();
  const receipt = receiptSchema.parse({ version: 1, executionId, input, access, executionHash: parts.executionHash, artifacts: parts.artifacts, observedAt: parts.action.finishedAt!.toISOString() });
  await tx.toolExecution.update({ where: { id: executionId }, data: { sourceReceipt: receipt as Prisma.InputJsonObject } });
}

function snapshotWithState(snapshot: Record<string, any>, previous: State, next: State) {
  const continuation = snapshot.piApprovalContinuation;
  if (continuation?.checkpoint) {
    if (JSON.stringify(agentContextProofSchema.parse(continuation.checkpoint.contextAuthorization)) !== JSON.stringify(proof(previous))) return fail();
    return { ...snapshot, [key]: next, piApprovalContinuation: { ...continuation, checkpoint: { ...continuation.checkpoint, contextAuthorization: proof(next) } } };
  }
  return { ...snapshot, [key]: next };
}
async function safe<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch (error) { if (isGenerationWorkLeaseLostError(error)) throw error; return fail(); }
}

export async function createAgentContextAuthorization(input: {
  runId: string; outboxId: string; leaseAttempt: number;
  representativeId: string; representativeVersionId: string | null; conversationId: string;
  contactId: string | null; audienceIdentityId: string | null; sourceChannel: string;
  userText: string; history: Array<{ id: string; text: string }>;
  checkpointProof?: unknown; restoring: boolean;
}): Promise<AgentContextAuthorization & {
  registerKnowledge(useRunId: string, itemIds: string[]): Promise<void>;
  registerToolResult(executionId: string): Promise<string | undefined>;
  memorySources(): { useRunId?: string; itemIds: string[] };
}> {
  let state = await safe(() => prisma.$transaction(async tx => {
    await fenceGenerationWorkLease(tx, input);
    await tx.$queryRaw`SELECT "id" FROM "GenerationRun" WHERE "id" = ${input.runId} FOR UPDATE`;
    const current = await frame(tx, input.runId);
    for (const field of ["representativeId", "representativeVersionId", "conversationId", "contactId", "audienceIdentityId"] as const) {
      if (current.scope[field] !== input[field]) return fail();
    }
    if (current.scope.sourceChannel !== input.sourceChannel.toLowerCase()) return fail();
    const stored = current.snapshot[key];
    if (stored) {
      const old = stateSchema.parse(stored);
      const supplied = [{ id: current.scope.inputMessageId, hash: hash(input.userText) }, ...input.history.map(item => ({ id: item.id, hash: hash(item.text) }))].sort((a,b) => a.id.localeCompare(b.id));
      if (hash(supplied) !== hash(old.messages)) return fail();
      if (input.restoring && JSON.stringify(agentContextProofSchema.parse(input.checkpointProof)) !== JSON.stringify(proof(old))) return fail();
      await validate(tx, old); return old;
    }
    // Never bless an old checkpoint, prior draft, or recall by writing a new
    // empty manifest. The complete original dependency set is unknown.
    if (input.restoring || current.snapshot.piApprovalContinuation || current.snapshot.piStream || current.snapshot.agentTrace
      || await tx.memoryUseRun.findFirst({ where: { generationRunId: input.runId }, select: { id: true } })) return fail();
    const supplied = [{ id: current.scope.inputMessageId, text: input.userText }, ...input.history];
    const messages = await messageStamps(tx, current.scope, supplied.map(item => item.id));
    if (messages.some(item => item.hash !== hash(supplied.find(value => value.id === item.id)?.text ?? ""))) return fail();
    const created = stateSchema.parse({ version: 1, scope: current.scope, messages, attachmentsHash: await attachmentStamp(tx, current.scope.inputMessageId), memory: [] });
    await tx.generationRun.update({ where: { id: input.runId }, data: { contextSnapshot: { ...current.snapshot, [key]: created } as Prisma.InputJsonObject } });
    return created;
  }));
  return {
    snapshot: () => proof(state),
    hasResultSource: (reference, toolName) => (state.remote ?? []).some(item => `${item.executionId}:${item.revision}` === reference && item.toolName === toolName),
    memorySources: () => ({ ...(state.memory[0] ? { useRunId: state.memory[0].useRunId } : {}), itemIds: [...(state.memory[0]?.itemIds ?? [])] }),
    async check(_boundary, expected) {
      await safe(() => prisma.$transaction(async tx => {
        await fenceGenerationWorkLease(tx, input);
        const current = await frame(tx, input.runId); const latest = stateSchema.parse(current.snapshot[key]);
        if (hash(latest) !== hash(state) || (expected && JSON.stringify(agentContextProofSchema.parse(expected)) !== JSON.stringify(proof(latest)))) return fail();
        await validate(tx, latest);
      }));
    },
    async registerKnowledge(useRunId, itemIds) {
      state = await safe(() => prisma.$transaction(async tx => {
        await fenceGenerationWorkLease(tx, input);
        await tx.$queryRaw`SELECT "id" FROM "GenerationRun" WHERE "id" = ${input.runId} FOR UPDATE`;
        const current = await frame(tx, input.runId); const latest = stateSchema.parse(current.snapshot[key]);
        if (hash(latest) !== hash(state) || (latest.memory[0] && latest.memory[0].useRunId !== useRunId)) return fail();
        await validate(tx, latest);
        const updated = stateSchema.parse({ ...latest, memory: [{ useRunId, itemIds: [...new Set([...(latest.memory[0]?.itemIds ?? []), ...itemIds])].sort() }] });
        await validate(tx, updated);
        await tx.generationRun.update({ where: { id: input.runId }, data: { contextSnapshot: snapshotWithState(current.snapshot, latest, updated) as Prisma.InputJsonObject } });
        return updated;
      }));
    },
    async registerToolResult(executionId) {
      let reference: string | undefined;
      state = await safe(() => prisma.$transaction(async tx => {
        await fenceGenerationWorkLease(tx, input);
        await tx.$queryRaw`SELECT "id" FROM "GenerationRun" WHERE "id" = ${input.runId} FOR UPDATE`;
        const current = await frame(tx, input.runId); const latest = stateSchema.parse(current.snapshot[key]);
        if (hash(latest) !== hash(state)) return fail();
        await validate(tx, latest);
        const row = await tx.toolExecution.findFirst({ where: { id: executionId, session: { generationRunId: input.runId } }, select: { sourceReceipt: true } });
        if (!row?.sourceReceipt) return latest; // never bless an old untracked result
        const receipt = receiptSchema.parse(row.sourceReceipt);
        const item = { executionId, revision: fingerprint(receipt), toolName: receiptToolName(receipt.access) };
        await validateRemote(tx, latest.scope, item, false, { visiting: new Set(), checked: new Set() });
        const remote = [...new Map([...(latest.remote ?? []), item].map(value => [value.executionId, value])).values()].sort((a,b) => a.executionId.localeCompare(b.executionId));
        const updated = stateSchema.parse({ ...latest, remote });
        await tx.generationRun.update({ where: { id: input.runId }, data: { contextSnapshot: snapshotWithState(current.snapshot, latest, updated) as Prisma.InputJsonObject } });
        reference = `${executionId}:${item.revision}`; return updated;
      }));
      return reference;
    },
  };
}

/** Broker uses persisted server state, never a model-selected dependency list.
 * Legacy non-Pi clients remain under their existing policy contracts. */
export async function assertAgentContextForExecution(generationRunId: string) {
  return safe(() => prisma.$transaction(async tx => {
    const current = await frame(tx, generationRunId);
    if (!current.snapshot[key]) {
      if (current.snapshot.piExecutionProtocol || current.snapshot.piApprovalContinuation
        || await tx.memoryUseRun.findFirst({ where: { generationRunId }, select: { id: true } })) return fail();
      return;
    }
    const state = stateSchema.parse(current.snapshot[key]);
    const checkpoint = current.snapshot.piApprovalContinuation?.checkpoint;
    if (checkpoint && checkpoint.replaySourcesTracked !== true) return fail();
    if (checkpoint && JSON.stringify(agentContextProofSchema.parse(checkpoint.contextAuthorization)) !== JSON.stringify(proof(state))) return fail();
    await validate(tx, state);
  }));
}

/** Called inside the existing provider delivery fence. Source-independent
 * system notifications are handled by that fence before this function. */
export async function revalidateAgentContextDeliveryInTransaction(tx: Tx, input: { runId: string; conversationId: string; outputMessageId: string }) {
  const run = await tx.generationRun.findUnique({ where: { id: input.runId }, select: { contextSnapshot: true, conversationId: true, outputMessageId: true } });
  if (!run) return false;
  const snapshot = record(run?.contextSnapshot);
  if (!snapshot[key]) return !snapshot.piExecutionProtocol && !snapshot.piApprovalContinuation;
  if (run?.conversationId !== input.conversationId || run.outputMessageId !== input.outputMessageId) return false;
  try { await validate(tx, stateSchema.parse(snapshot[key]), true); return true; } catch { return false; }
}

/** Conservative inheritance of all registered generation sources. Unrelated
 * legacy/non-Pi artifacts keep their existing contract. */
export async function isAgentContextArtifactAuthorized(input: { runId: string; representativeId: string; conversationId: string; audienceIdentityId: string; toolExecutionId?: string | null; artifactId?: string }) {
  try {
    return await prisma.$transaction(async tx => {
      if (input.toolExecutionId && input.artifactId) {
        const row = await tx.toolExecution.findFirst({ where: { id: input.toolExecutionId, session: { generationRunId: input.runId } }, select: { sourceReceipt: true } });
        if (row?.sourceReceipt) {
          const receipt = receiptSchema.parse(row.sourceReceipt); const scope = receipt.input.scope;
          if (scope.runId !== input.runId || scope.representativeId !== input.representativeId || scope.conversationId !== input.conversationId
            || scope.audienceIdentityId !== input.audienceIdentityId || !receipt.artifacts.some(item => item.id === input.artifactId)) return false;
          await validateRemote(tx, scope, { executionId: input.toolExecutionId, revision: fingerprint(receipt), toolName: receiptToolName(receipt.access) }, true,
            { visiting: new Set(), checked: new Set() });
          return true;
        }
      }
      const origin = await tx.generationRun.findUnique({ where: { id: input.runId }, select: { contextSnapshot: true } });
      if (!origin) return false;
      const snapshot = record(origin.contextSnapshot);
      if (!snapshot[key]) {
        if (snapshot.piExecutionProtocol || snapshot.piApprovalContinuation) return false;
        return !await tx.memoryUseRun.findFirst({ where: { generationRunId: input.runId }, select: { id: true } });
      }
      const current = await frame(tx, input.runId, true);
      if (current.scope.representativeId !== input.representativeId || current.scope.conversationId !== input.conversationId
        || current.scope.audienceIdentityId !== input.audienceIdentityId) return false;
      if (current.snapshot.piApprovalContinuation?.checkpoint?.replaySourcesTracked === false) return false;
      await validate(tx, stateSchema.parse(current.snapshot[key]), true); return true;
    });
  } catch { return false; }
}

export async function getApprovedAgentToolExecution(input: { runId: string; approvalId: string }) {
  return prisma.toolExecution.findFirst({ where: { approvalRequestId: input.approvalId, session: { generationRunId: input.runId }, status: "SUCCEEDED" },
    select: { id: true } });
}

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { mcpRecoveryContractSchema, type McpProviderOperation, type McpRecoveryContract } from "@delegate/compute-protocol";
import { resolveServerOwnedMcpCapabilityPolicy } from "@delegate/web-data";
import { prisma } from "./prisma";
import { providerArguments, providerFingerprint, parseProviderContract } from "./mcp-recovery-contract";
import { queryRemoteMcpOperation } from "./mcp";
import { SessionError } from "./session-error";

const scopeSchema = z.object({ representativeId: z.string(), ownerId: z.string(), representativeVersionId: z.string().nullable(),
  conversationId: z.string().nullable(), contactId: z.string().nullable(), audienceIdentityId: z.string().nullable(), requestedBy: z.string(),
  channel: z.string().nullable(), sourceChannel: z.string().nullable() }).strict();
const snapshotSchema = z.object({ version: z.literal(1), executionId: z.string(), sessionId: z.string(), scope: scopeSchema,
  bindingId: z.string(), bindingFingerprint: z.string(), toolName: z.string(), toolSchemaHash: z.string().nullable(),
  contract: mcpRecoveryContractSchema, key: z.string(), argumentsHash: z.string(), requestHash: z.string().nullable(), createdAt: z.string().datetime(), expiresAt: z.string().datetime().nullable(),
}).strict();
type Snapshot = z.infer<typeof snapshotSchema>;
type Db = Prisma.TransactionClient;
const fail = (): never => { throw new SessionError(409, "mcp_provider_scope_changed"); };
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const noRecovery: McpRecoveryContract = { version: 1, id: "delegate.no-provider-recovery.v1", mode: "none" };

async function loadScope(db: Db, sessionId: string) {
  const session = await db.computeSession.findUnique({ where: { id: sessionId }, select: { representativeId: true, representativeVersionId: true,
    conversationId: true, contactId: true, requestedBy: true, representative: { select: { ownerId: true } },
    representativeVersion: { select: { status: true, representativeId: true } },
    conversation: { select: { audienceIdentityId: true, representativeId: true, contactId: true, channel: true, sourceChannel: true,
      audienceIdentity: { select: { status: true, mergedIntoId: true } }, contact: { select: { audienceIdentityId: true } } } } } });
  if (!session || session.representativeVersion?.status !== "PUBLISHED" || session.representativeVersion.representativeId !== session.representativeId) return fail();
  const c = session.conversation;
  if (session.requestedBy === "AUDIENCE" && (!c || !c.audienceIdentityId || c.representativeId !== session.representativeId || c.contactId !== session.contactId
    || c.contact?.audienceIdentityId !== c.audienceIdentityId || !c.audienceIdentity || c.audienceIdentity.mergedIntoId
    || !["REGISTERED", "ANONYMOUS"].includes(c.audienceIdentity.status))) return fail();
  return scopeSchema.parse({ representativeId: session.representativeId, ownerId: session.representative.ownerId, representativeVersionId: session.representativeVersionId,
    conversationId: session.conversationId, contactId: session.contactId, requestedBy: session.requestedBy, audienceIdentityId: c?.audienceIdentityId ?? null,
    channel: c?.channel ?? null, sourceChannel: c?.sourceChannel ?? null });
}
async function loadBinding(db: Db, representativeId: string, bindingId: string, toolName: string) {
  const binding = await db.representativeMcpBinding.findFirst({ where: { id: bindingId, representativeId, enabled: true },
    include: { representativeSkillPackLink: { select: { enabled: true } } } });
  if (!binding || binding.representativeSkillPackLink?.enabled === false) return fail();
  const allowed = Array.isArray(binding.allowedToolNames) ? binding.allowedToolNames : [];
  if (allowed.length && !allowed.includes(toolName)) return fail();
  const definition = await db.mcpToolDefinition.findFirst({ where: { bindingId, bindingRevision: binding.configRevision, exactToolName: toolName,
    availability: "ready", supersededAt: null }, select: { toolSchemaHash: true, bindingDefinitionHash: true, inputSchema: true } });
  // Never use health counters/timestamps in the contract fingerprint.
  const fingerprint = providerFingerprint({ id: binding.id, serverUrl: binding.serverUrl, transportKind: binding.transportKind,
    configRevision: binding.configRevision, allowedToolNames: binding.allowedToolNames, maxRetries: binding.maxRetries,
    retryBackoffMs: binding.retryBackoffMs, approvalRequired: binding.approvalRequired, definition });
  return { binding, definition, fingerprint };
}
export function resolveMcpRecoveryContract(input: Parameters<typeof resolveServerOwnedMcpCapabilityPolicy>[0]) {
  const policy = resolveServerOwnedMcpCapabilityPolicy(input);
  const contract = parseProviderContract(policy?.recoveryContract ?? noRecovery);
  if ((contract.mode === "natural_read" && (policy?.effect.mutation !== "none" || policy.idempotency !== "naturally_idempotent"))
    || (contract.mode === "keyed" && policy?.idempotency !== "idempotency_key")) throw new SessionError(409, "mcp_provider_contract_invalid");
  if (contract.mode === "keyed" && contract.query?.toolName === input.toolName) throw new SessionError(409, "mcp_provider_contract_invalid");
  return contract;
}

/** Pin before the first possible submission; no model-provided keys/contracts. */
export async function pinMcpProviderOperation(input: { executionId: string; executionLeaseToken: string; sessionId: string;
  bindingId: string; toolName: string; toolSchemaHash?: string; toolArguments: Record<string, unknown> }) {
  return prisma.$transaction(async tx => {
    const toolSchemaHash = input.toolSchemaHash?.replace(/^sha256:/u, "");
    const scope = await loadScope(tx, input.sessionId);
    const live = await loadBinding(tx, scope.representativeId, input.bindingId, input.toolName);
    if (toolSchemaHash && live.definition?.toolSchemaHash !== toolSchemaHash) return fail();
    const contract = toolSchemaHash ? resolveMcpRecoveryContract({ serverUrl: live.binding.serverUrl, transportKind: live.binding.transportKind,
      toolName: input.toolName, toolSchemaHash, inputSchema: record(live.definition?.inputSchema) }) : noRecovery;
    if (contract.mode === "keyed" && contract.query) {
      if (Array.isArray(live.binding.allowedToolNames) && live.binding.allowedToolNames.length && !live.binding.allowedToolNames.includes(contract.query.toolName)) return fail();
      const statusDefinition = await tx.mcpToolDefinition.findFirst({ where: { bindingId: input.bindingId, bindingRevision: live.binding.configRevision,
        exactToolName: contract.query.toolName, toolSchemaHash: contract.query.toolSchemaHash, supersededAt: null, availability: "ready" }, select: { id: true } });
      if (!statusDefinition) return fail();
    }
    const execution = await tx.toolExecution.findFirst({ where: { id: input.executionId, sessionId: input.sessionId, status: "RUNNING", executionLeaseToken: input.executionLeaseToken },
      select: { providerOperation: true, requestPayloadHash: true, requestPayload: true, actionIdentity: true, mcpBindingId: true, requestedCommand: true } });
    if (!execution || execution.mcpBindingId !== input.bindingId || execution.requestedCommand !== input.toolName) return fail();
    if (contract.mode === "keyed" && record(execution.actionIdentity).version !== 1) throw new SessionError(409, "mcp_provider_action_identity_required");
    const payload = typeof execution.requestPayload === "string" ? JSON.parse(execution.requestPayload) : record(execution.requestPayload);
    if (providerFingerprint(payload.toolArguments ?? {}) !== providerFingerprint(input.toolArguments)) throw new SessionError(409, "mcp_provider_request_changed");
    const now = new Date();
    const created = snapshotSchema.parse({ version: 1, executionId: input.executionId, sessionId: input.sessionId, scope,
      bindingId: input.bindingId, bindingFingerprint: live.fingerprint, toolName: input.toolName, toolSchemaHash: toolSchemaHash ?? null,
      contract, key: `delegate:${input.executionId}`, argumentsHash: providerFingerprint(input.toolArguments), requestHash: execution.requestPayloadHash,
      createdAt: now.toISOString(), expiresAt: contract.mode === "keyed" ? new Date(now.getTime() + contract.retentionSeconds * 1000).toISOString() : null });
    providerArguments(created, input.toolArguments); // reserved fields cannot be supplied by the caller
    if (execution.providerOperation) {
      const existing = snapshotSchema.parse(execution.providerOperation);
      if (existing.bindingFingerprint !== created.bindingFingerprint || existing.argumentsHash !== created.argumentsHash || existing.requestHash !== created.requestHash
        || providerFingerprint(existing.scope) !== providerFingerprint(scope) || providerFingerprint(existing.contract) !== providerFingerprint(contract)) return fail();
      return existing; // never extend TTL or mint a replacement key
    }
    const stored = await tx.toolExecution.updateMany({ where: { id: input.executionId, status: "RUNNING", executionLeaseToken: input.executionLeaseToken, providerOperation: { equals: Prisma.DbNull } },
      data: { providerOperation: created as Prisma.InputJsonObject } });
    if (stored.count !== 1) return fail();
    return created;
  });
}

export async function assertMcpProviderOperationCurrent(snapshot: Snapshot, leaseToken?: string) {
  const scope = await loadScope(prisma, snapshot.sessionId);
  if (providerFingerprint(scope) !== providerFingerprint(snapshot.scope)) return fail();
  const execution = await prisma.toolExecution.findFirst({ where: { id: snapshot.executionId, sessionId: snapshot.sessionId,
    ...(leaseToken ? { executionLeaseToken: leaseToken, status: "RUNNING" as const } : {}) }, select: { providerOperation: true, requestPayloadHash: true } });
  if (!execution || execution.requestPayloadHash !== snapshot.requestHash || providerFingerprint(snapshotSchema.parse(execution.providerOperation)) !== providerFingerprint(snapshot)) return fail();
  const live = await loadBinding(prisma, scope.representativeId, snapshot.bindingId, snapshot.toolName);
  if (live.fingerprint !== snapshot.bindingFingerprint) return fail();
  const contract = snapshot.toolSchemaHash ? resolveMcpRecoveryContract({ serverUrl: live.binding.serverUrl, transportKind: live.binding.transportKind,
    toolName: snapshot.toolName, toolSchemaHash: snapshot.toolSchemaHash, inputSchema: record(live.definition?.inputSchema) }) : noRecovery;
  if (providerFingerprint(contract) !== providerFingerprint(snapshot.contract)) return fail();
  if (contract.mode === "keyed" && contract.query) {
    const definition = await prisma.mcpToolDefinition.findFirst({ where: { bindingId: snapshot.bindingId, bindingRevision: live.binding.configRevision,
      exactToolName: contract.query.toolName, toolSchemaHash: contract.query.toolSchemaHash, supersededAt: null, availability: "ready" }, select: { id: true } });
    if (!definition || (Array.isArray(live.binding.allowedToolNames) && live.binding.allowedToolNames.length && !live.binding.allowedToolNames.includes(contract.query.toolName))) return fail();
  }
  return live.binding;
}

/** Existing-outcome read: no model quota, no resubmission, no business-status or
 * billing mutation. D12 consumes these observations to perform reconciliation. */
export async function queryStoredMcpOutcome(input: { sessionId: string; executionId: string; audienceIdentityId: string }) {
  const current = await loadScope(prisma, input.sessionId);
  if (current.requestedBy !== "AUDIENCE" || current.audienceIdentityId !== input.audienceIdentityId) throw new SessionError(403, "mcp_provider_scope_changed");
  const row = await prisma.toolExecution.findFirst({ where: { id: input.executionId, sessionId: input.sessionId, capability: "MCP" }, select: { providerOperation: true } });
  const parsed = snapshotSchema.safeParse(row?.providerOperation);
  if (!parsed.success || parsed.data.contract.mode !== "keyed" || !parsed.data.contract.query) throw new SessionError(409, "mcp_provider_status_unsupported");
  const snapshot = parsed.data;
  const binding = await assertMcpProviderOperationCurrent(snapshot);
  const result = await queryRemoteMcpOperation({ binding: { ...binding, transportKind: binding.transportKind.toLowerCase() as "streamable_http" | "sse" },
    operation: snapshot as McpProviderOperation, authorize: async () => { await assertMcpProviderOperationCurrent(snapshot); } });
  await assertMcpProviderOperationCurrent(snapshot); // withdrawal during lookup must not release a result
  const observedAt = new Date().toISOString();
  await prisma.eventAudit.create({ data: { representativeId: current.representativeId, conversationId: current.conversationId, contactId: current.contactId,
    type: "MCP_PROVIDER_OUTCOME_OBSERVED", payload: { executionId: input.executionId, contractId: snapshot.contract.id, state: result.state, observedAt } } });
  return { executionId: input.executionId, state: result.state === "not_found" ? "unknown" as const : result.state,
    providerReportedState: result.state, observedAt, observationOnly: true as const };
}

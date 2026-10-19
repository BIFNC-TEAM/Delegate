import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
const mocks = vi.hoisted(() => ({ policy: vi.fn(), bodies: new Map<string, Buffer>() }));
vi.mock("@delegate/web-data", async original => ({ ...await original<typeof import("@delegate/web-data")>(), resolveServerOwnedMcpCapabilityPolicy: mocks.policy, finalizeComputeApprovalConversation: vi.fn() }));
vi.mock("@delegate/lifecycle-hooks", async () => import("../../lifecycle-hooks/src/index"));
import { prisma } from "../src/prisma";
import { prisma as brokerDb } from "../../../apps/compute-broker/src/prisma";
import { createComputeSession } from "../../../apps/compute-broker/src/sessions";
import { executeTool, resolveApproval, processNextApprovedExecution } from "../../../apps/compute-broker/src/executions";
import { queryStoredMcpOutcome } from "../../../apps/compute-broker/src/mcp-provider-operation";
import * as artifacts from "../../../apps/compute-broker/src/artifacts";
import { fixtureRecoveryContract, schemaHash, startRecoveryFixture, submitSchema, statusSchema } from "../../../apps/compute-broker/tests/mcp-recovery-fixture";
import type { McpRecoveryContract } from "@delegate/compute-protocol";
const enabled = process.env.DELEGATE_POSTGRES_E2E === "1";
if (enabled) { const url = new URL(process.env.DATABASE_URL ?? ""); if (!["127.0.0.1", "localhost"].includes(url.hostname) || !url.pathname.endsWith("_test")) throw new Error("isolated_mcp_recovery_database_required"); }
const suite = enabled ? describe : describe.skip;
const hash = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
let server: Awaited<ReturnType<typeof startRecoveryFixture>>;
let contract: McpRecoveryContract;
suite("MCP provider contracts: actual Broker, isolated PostgreSQL and real local HTTP", () => {
  beforeEach(async () => {
    vi.stubEnv("DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS", "true"); mocks.bodies.clear();
    server = await startRecoveryFixture(); contract = fixtureRecoveryContract();
    // This test-only registry supplies the synthetic service contract. No live
    // write provider or endpoint is added to the production policy registry.
    mocks.policy.mockImplementation((input: { toolName: string; serverUrl: string }) => input.toolName === "submit" && input.serverUrl === server.url ? {
      policyId: "synthetic-write-policy", classificationVersion: "synthetic-v1", effect: { boundary: "external", mutation: "write", reversibility: "unknown" },
      idempotency: contract.mode === "keyed" ? "idempotency_key" : "unknown", recoveryContract: contract,
    } : null);
    vi.spyOn(artifacts, "persistJsonArtifact").mockImplementation(async input => {
      const id = `synthetic-${randomUUID()}`; const body = Buffer.from(JSON.stringify(input.value)); mocks.bodies.set(id, body);
      return prisma.artifact.create({ data: { id, representativeId: input.representativeId, conversationId: input.conversationId ?? null, contactId: input.contactId ?? null,
        sessionId: input.sessionId, toolExecutionId: input.executionId, kind: "JSON", bucket: "synthetic", objectKey: id, mimeType: "application/json", sha256: hash(body), sizeBytes: body.length } });
    });
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await server.close(); });
  afterAll(async () => { await Promise.all([prisma.$disconnect(), brokerDb.$disconnect()]); });

  it("recovers a committed action with a lost response, keeps the original key and does not duplicate effects or billing on replay", async () => {
    server.controls.dropSubmissions = 1; const f = await fixture();
    const result = await executeTool(f.sessionId, f.request);
    expect(result.outcome, JSON.stringify({ failure: result.session.failureReason, execution: result.execution.status, calls: server.calls.map(call => call.name ?? call.method) })).toBe("completed"); expect(result.execution.semanticOutcome).toBe("succeeded");
    const action = await prisma.toolExecution.findUniqueOrThrow({ where: { id: result.execution.id } });
    expect(action.providerOperation).toMatchObject({ key: `delegate:${action.id}`, argumentsHash: expect.any(String), contract: { mode: "keyed" } });
    expect(JSON.stringify(action.providerOperation)).not.toContain('"amount"');
    expect(server.calls.filter(call => call.name === "submit")).toHaveLength(1); expect(server.calls.filter(call => call.name === "status")).toHaveLength(1); expect(server.effects.size).toBe(1);
    const count = await prisma.ledgerEntry.count({ where: { toolExecutionId: action.id } });
    const replay = await executeTool(f.sessionId, f.request);
    expect(replay.execution.id).toBe(action.id); expect(server.effects.size).toBe(1); expect(server.calls.filter(call => call.name === "submit")).toHaveLength(1);
    expect(await prisma.ledgerEntry.count({ where: { toolExecutionId: action.id } })).toBe(count);
    await expect(prisma.toolExecution.update({ where: { id: action.id }, data: { providerOperation: Prisma.DbNull } })).rejects.toThrow("immutable");
    expect([...mocks.bodies.values()].map(body => body.toString()).join()).not.toContain("SYNTHETIC_PROVIDER_PRIVATE_DEBUG");
  });
  it("keeps pending distinct from success and blocks another write", async () => {
    server.controls.dropSubmissions = 1; server.controls.status = "pending"; const f = await fixture();
    const result = await executeTool(f.sessionId, f.request);
    expect(result.outcome).toBe("failed"); expect(result.execution.semanticOutcome).toBe("unknown"); expect(server.effects.size).toBe(0);
    await expect(executeTool(f.sessionId, { ...f.request, logicalAction: { version: 1, ordinal: 2 } })).rejects.toThrow("previous_unresolved");
    expect(server.calls.filter(call => call.name === "submit")).toHaveLength(1);
  });
  it("pins the provider key only after the configured approval and reuses it on approved response loss", async () => {
    server.controls.dropSubmissions = 1; const f = await fixture(1, true);
    const pending = await executeTool(f.sessionId, f.request); expect(pending.outcome).toBe("pending_approval"); expect(server.calls).toHaveLength(0);
    expect((await prisma.toolExecution.findUniqueOrThrow({ where: { id: pending.execution.id } })).providerOperation).toBeNull();
    await resolveApproval(pending.approvalRequest!.id, { resolution: "approved", resolvedBy: "synthetic-owner" }); await processNextApprovedExecution();
    const action = await prisma.toolExecution.findUniqueOrThrow({ where: { id: pending.execution.id } });
    expect(action).toMatchObject({ status: "SUCCEEDED", semanticOutcome: "succeeded", providerOperation: { key: `delegate:${pending.execution.id}` } });
    expect(server.calls.filter(call => call.name === "submit")).toHaveLength(1); expect(server.effects.size).toBe(1);
  });
  it("queries the original unknown result without new quota even after task cancellation/session expiry; it does not reconcile or bill", async () => {
    server.controls.dropSubmissions = 1; server.controls.status = "not_found"; const f = await fixture(0);
    const result = await executeTool(f.sessionId, f.request); expect(result.execution.semanticOutcome).toBe("unknown");
    await prisma.generationRun.update({ where: { id: f.runId }, data: { status: "CANCELED", runtimePolicySnapshot: { billingMode: "unavailable" } } });
    await prisma.computeSession.update({ where: { id: f.sessionId }, data: { expiresAt: new Date(1) } });
    const count = await prisma.ledgerEntry.count({ where: { toolExecutionId: result.execution.id } });
    const unknown = await queryStoredMcpOutcome({ ...f.coordinates, executionId: result.execution.id });
    expect(unknown).toMatchObject({ state: "unknown", providerReportedState: "not_found", observationOnly: true });
    server.controls.status = "succeeded";
    const observed = await queryStoredMcpOutcome({ ...f.coordinates, executionId: result.execution.id });
    expect(observed).toMatchObject({ state: "succeeded", observationOnly: true }); expect(JSON.stringify(observed)).not.toContain("SYNTHETIC_PROVIDER_PRIVATE_DEBUG");
    expect(await prisma.toolExecution.findUniqueOrThrow({ where: { id: result.execution.id } })).toMatchObject({ semanticOutcome: "unknown" });
    expect(await prisma.ledgerEntry.count({ where: { toolExecutionId: result.execution.id } })).toBe(count); expect(server.calls.filter(call => call.name === "submit")).toHaveLength(1);
  });
  it.each(["visitor", "binding", "definition", "channel", "contract"])("blocks outcome lookup before network access after %s changes", async change => {
    const f = await fixture(); const result = await executeTool(f.sessionId, f.request); const queries = server.calls.length;
    if (change === "binding") await prisma.representativeMcpBinding.update({ where: { id: f.bindingId }, data: { enabled: false } });
    if (change === "definition") await prisma.mcpToolDefinition.updateMany({ where: { bindingId: f.bindingId, exactToolName: "status" }, data: { supersededAt: new Date() } });
    if (change === "channel") await prisma.conversation.update({ where: { id: f.conversationId }, data: { channel: "GROUP_REPLY" } });
    if (change === "contract") contract = { ...contract, id: "changed-provider-contract" };
    await expect(queryStoredMcpOutcome({ ...f.coordinates, executionId: result.execution.id, ...(change === "visitor" ? { audienceIdentityId: "other-visitor" } : {}) })).rejects.toThrow("scope_changed");
    expect(server.calls).toHaveLength(queries);
  });
  it("rechecks scope after lookup and never releases a result revoked while the provider answered", async () => {
    const f = await fixture(); const result = await executeTool(f.sessionId, f.request);
    server.controls.onQuery = async () => { await prisma.conversation.update({ where: { id: f.conversationId }, data: { audienceIdentityId: null } }); };
    await expect(queryStoredMcpOutcome({ ...f.coordinates, executionId: result.execution.id })).rejects.toThrow("scope_changed");
    expect(await prisma.eventAudit.count({ where: { representativeId: f.repId, type: "MCP_PROVIDER_OUTCOME_OBSERVED" } })).toBe(0);
  });
  it("checks withdrawal before opening the recovery connection, with no second business call", async () => {
    const f = await fixture(); server.controls.dropSubmissions = 1;
    server.controls.onSubmit = async () => { await prisma.representativeMcpBinding.update({ where: { id: f.bindingId }, data: { enabled: false } }); };
    const result = await executeTool(f.sessionId, f.request);
    expect(result.execution.semanticOutcome).toBe("unknown"); expect(server.effects.size).toBe(1);
    expect(server.calls.filter(call => call.method === "initialize")).toHaveLength(1); expect(server.calls.filter(call => call.name === "status")).toHaveLength(0);
    expect(server.calls.filter(call => call.name === "submit")).toHaveLength(1);
  });
  it("does not infer a query/replay contract from approval or an idempotency hint", async () => {
    contract = { version: 1, id: "unverified", mode: "none" }; server.controls.dropSubmissions = 1; const f = await fixture(4);
    const result = await executeTool(f.sessionId, f.request); expect(result.execution.semanticOutcome).toBe("unknown");
    await expect(queryStoredMcpOutcome({ ...f.coordinates, executionId: result.execution.id })).rejects.toThrow("status_unsupported");
    expect(server.calls.filter(call => call.name === "submit")).toHaveLength(1); expect(server.calls.filter(call => call.name === "status")).toHaveLength(0);
  });
});

async function fixture(maxRetries = 1, approvalRequired = false) {
  const owner = await prisma.owner.create({ data: { displayName: "Synthetic recovery owner" } });
  const rep = await prisma.representative.create({ data: { ownerId: owner.id, slug: `recovery-${randomUUID()}`, displayName: "Synthetic", roleSummary: "Test", tone: "neutral", languages: ["zh"], freeScope: [], paywalledIntents: [], handoffPrompt: "Test", allowedSkills: [], actionGate: {},
    computeEnabled: true, computeDefaultPolicyMode: "ALLOW", computeNetworkMode: "FULL", computeFilesystemMode: "EPHEMERAL_FULL", computeAutoApproveTokenLimit: 10000 } });
  await prisma.capabilityPolicyProfile.create({ data: { representativeId: rep.id, name: "Synthetic", isDefault: true, defaultDecision: "ALLOW", networkMode: "FULL", filesystemMode: "EPHEMERAL_FULL",
    rules: { create: [{ id: `${rep.id}_mcp_owner_mode`, capability: "MCP", decision: "ALLOW" }] } } });
  const binding = await prisma.representativeMcpBinding.create({ data: { representativeId: rep.id, slug: "fixture", displayName: "Synthetic provider", serverUrl: server.url,
    allowedToolNames: ["submit", "status"], defaultToolName: "submit", approvalRequired, maxRetries, retryBackoffMs: 0 } });
  for (const [name, schema] of [["submit", submitSchema], ["status", statusSchema]] as const) await prisma.mcpToolDefinition.create({ data: { bindingId: binding.id, bindingRevision: 1,
    exactToolName: name, inputSchema: schema, toolSchemaHash: schemaHash(schema), bindingDefinitionHash: "a".repeat(64), observedAt: new Date() } });
  const version = await prisma.representativeVersion.create({ data: { representativeId: rep.id, versionNumber: 1, status: "PUBLISHED", snapshot: {
    compute: { enabled: true, defaultPolicyMode: "allow", baseImage: rep.computeBaseImage, maxSessionMinutes: 15, autoApproveTokenLimit: 10000, artifactRetentionDays: 14, networkMode: "full", networkAllowlist: [], filesystemMode: "ephemeral_full",
      capabilityModes: { exec: "allow", read: "allow", write: "allow", process: "deny", browser: "allow", mcp: "allow" } },
    mcpBindings: [{ id: binding.id, slug: binding.slug, serverUrl: server.url, transportKind: "streamable_http", enabled: true, allowedToolNames: ["submit", "status"], defaultToolName: "submit",
      approvalRequired, estimatedTokensPerCall: 0, maxRetries, retryBackoffMs: 0, skillReleasePin: null }],
  } } });
  await prisma.representative.update({ where: { id: rep.id }, data: { activeVersionId: version.id } });
  const audience = await prisma.audienceIdentity.create({ data: { audienceKey: randomUUID(), status: "REGISTERED" } });
  const contact = await prisma.contact.create({ data: { representativeId: rep.id, audienceIdentityId: audience.id, sourceChannel: "web" } });
  const conversation = await prisma.conversation.create({ data: { representativeId: rep.id, contactId: contact.id, audienceIdentityId: audience.id, channel: "PRIVATE_CHAT", sourceChannel: "web" } });
  const episode = await prisma.conversationEpisode.create({ data: { conversationId: conversation.id, representativeVersionId: version.id, sequence: 1 } });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { activeEpisodeId: episode.id } });
  const message = await prisma.message.create({ data: { conversationId: conversation.id, episodeId: episode.id, senderType: "AUDIENCE", text: "Synthetic atomic submission" } });
  const run = await prisma.generationRun.create({ data: { conversationId: conversation.id, representativeVersionId: version.id, inputMessageId: message.id,
    episodeId: episode.id, status: "PROCESSING", idempotencyKey: randomUUID(), runtimePolicySnapshot: { billingMode: "free" }, contextSnapshot: { piActionIdentityVersion: 1 } } });
  const work = await prisma.outboxEvent.create({ data: { aggregateType: "generation_run", aggregateId: run.id, eventType: "generation.requested", payload: {}, status: "PROCESSING", attemptCount: 1, availableAt: new Date(Date.now()+300000), idempotencyKey: randomUUID() } });
  const session = await createComputeSession({ representativeId: rep.id, requestedBy: "audience", contactId: contact.id, conversationId: conversation.id, generationRunId: run.id,
    subagentId: "compute-agent", requestedCapabilities: ["mcp"], reason: "synthetic" });
  return { repId: rep.id, conversationId: conversation.id, bindingId: binding.id, sessionId: session.session.id, runId: run.id,
    coordinates: { sessionId: session.session.id, audienceIdentityId: audience.id },
    request: { capability: "mcp", subagentId: "compute-agent", bindingId: binding.id, toolName: "submit", toolArguments: { amount: 7 }, logicalAction: { version: 1, ordinal: 1 }, generationWorkLease: { outboxId: work.id, leaseAttempt: 1 } } };
}

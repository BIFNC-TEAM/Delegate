import { createHash, randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({ read: vi.fn(async () => ({ buffer: Buffer.from("SYNTHETIC_ARTIFACT"), contentType: "text/plain" })) }));
vi.mock("../src/artifact-store", () => ({ readArtifactObject: storage.read }));
vi.mock("@delegate/lifecycle-hooks", async () => import("../../lifecycle-hooks/src/index"));
vi.mock("@delegate/web-data", async original => ({ ...await original<typeof import("@delegate/web-data")>(), finalizeComputeApprovalConversation: vi.fn() }));
import { createAgentContextAuthorization, assertAgentContextForExecution, captureAgentExecutionSources, persistAgentExecutionSourceReceipt, isAgentContextArtifactAuthorized } from "../src/agent-context-authorization";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "../../model-runtime/tests/faux-source-fixture";
import { prepareGenerationMessageChannelDelivery, admitGenerationMessageProviderDelivery, withGenerationMessageProviderDeliveryFence, loadConversationOperationalContext, updateGenerationPiStream, getPublicGenerationRunSnapshot } from "../src/conversation-platform";
import { buildWebConversationThreadId } from "../src/web-audience";
import { recordMemoryUseSearchHits, startOrReuseMemoryUseRun } from "../src/memory-use-execution";
import { prisma } from "../src/prisma";
import { getPublicConversationArtifactDownload } from "../src/public-compute-artifacts";
import { DelegatePiAgentRuntime, executionScopeHash } from "../../model-runtime/src/pi";
import { prisma as brokerDb } from "../../../apps/compute-broker/src/prisma";
import { createComputeSession } from "../../../apps/compute-broker/src/sessions";
import { executeTool, resolveApproval, processNextApprovedExecution } from "../../../apps/compute-broker/src/executions";
import * as leases from "../../../apps/compute-broker/src/sandbox-leases";
import { computeBrokerConfig } from "../../../apps/compute-broker/src/config";
import * as brokerArtifacts from "../../../apps/compute-broker/src/artifacts";
import * as brokerLeases from "../../../apps/compute-broker/src/leases";
import * as brokerRunner from "../../../apps/compute-broker/src/runner";
import { loadLatestNativeBrowserSeed } from "../../../apps/compute-broker/src/native-browser-seed";
import { executeNativeComputerUseLoop } from "../../../apps/compute-broker/src/native-browser";
const enabled = process.env.DELEGATE_POSTGRES_E2E === "1";
if (enabled) { const url = new URL(process.env.DATABASE_URL ?? ""); if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) throw new Error("isolated_context_database_required"); }
const suite = enabled ? describe : describe.skip;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const canary = "SYNTHETIC_REVOKED_DEPENDENCY_CANARY";
const priorConfig = { ...computeBrokerConfig.tencent };
suite("Agent source authorization on real isolated PostgreSQL", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); Object.assign(computeBrokerConfig.tencent, priorConfig); });
  afterAll(async () => { await Promise.all([prisma.$disconnect(), brokerDb.$disconnect()]); });
  it("revalidates a Web draft's actual sources and audience before SSE disclosure", async () => {
    const f = await fixture(); const visitor = randomUUID();
    await prisma.conversation.update({ where: { id: f.conversationId }, data: { channelThreadId: buildWebConversationThreadId(visitor) } });
    await prisma.outboxEvent.update({ where: { id: f.outboxId }, data: { conversationId: f.conversationId } });
    const guard = await createAgentContextAuthorization(f.input); const knowledge = await addKnowledge(f, true);
    await guard.registerKnowledge(knowledge.runId, [knowledge.itemId]);
    const input = { representativeSlug: f.slug, runId: f.runId, audienceIdentityId: f.audienceId, audienceId: visitor, allowDraftPreview: true };
    await updateGenerationPiStream({ ...f.input, sequence: 1, text: canary, previewPhase: "verifying" });
    expect((await getPublicGenerationRunSnapshot(input))?.stream).toMatchObject({ text: canary, phase: "verifying" });
    expect(await getPublicGenerationRunSnapshot({ ...input, audienceIdentityId: "other" })).toBeNull();
    expect(await getPublicGenerationRunSnapshot({ ...input, audienceId: "other" })).toBeNull();
    await prisma.knowledgeAssetRepresentative.updateMany({ where: { assetId: f.assetId, representativeId: f.repId }, data: { enabled: false } });
    expect(await getPublicGenerationRunSnapshot(input)).not.toHaveProperty("stream");
    // A copied run id or cached draft cannot bypass the current source grant.
    expect(JSON.stringify(await getPublicGenerationRunSnapshot(input))).not.toContain(canary);
  });
  it("fences stale preview writers and hides canceled and completed drafts", async () => {
    const f = await fixture(); const visitor = randomUUID();
    await prisma.conversation.update({ where: { id: f.conversationId }, data: { channelThreadId: buildWebConversationThreadId(visitor) } });
    await prisma.outboxEvent.update({ where: { id: f.outboxId }, data: { conversationId: f.conversationId } });
    await createAgentContextAuthorization(f.input);
    const input = { representativeSlug: f.slug, runId: f.runId, audienceIdentityId: f.audienceId, audienceId: visitor, allowDraftPreview: true };
    await updateGenerationPiStream({ ...f.input, sequence: 5, text: "OLD", previewPhase: "generating" });
    await prisma.outboxEvent.update({ where: { id: f.outboxId }, data: { attemptCount: 2 } });
    expect(await getPublicGenerationRunSnapshot(input)).not.toHaveProperty("stream");
    await expect(updateGenerationPiStream({ ...f.input, sequence: 99, text: "STALE", previewPhase: "verifying" })).rejects.toThrow();
    await updateGenerationPiStream({ ...f.input, leaseAttempt: 2, sequence: 1, text: "NEW", previewPhase: "verifying" });
    expect((await getPublicGenerationRunSnapshot(input))?.stream?.text).toBe("NEW");
    for (const status of ["CANCELED", "COMPLETED"] as const) {
      await prisma.generationRun.update({ where: { id: f.runId }, data: { status } });
      expect(await getPublicGenerationRunSnapshot(input)).not.toHaveProperty("stream");
    }
  });
  it("persists only references/hashes, accepts an intact proof after JSONB storage and does not reset dependencies", async () => {
    const f = await fixture(); const guard = await createAgentContextAuthorization(f.input);
    const knowledge = await addKnowledge(f, true); await guard.registerKnowledge(knowledge.runId, [knowledge.itemId]);
    const before = guard.snapshot(); await guard.registerKnowledge(knowledge.runId, []); expect(guard.snapshot()).toEqual(before);
    const row = await prisma.generationRun.findUniqueOrThrow({ where: { id: f.runId } });
    expect(JSON.stringify(row.contextSnapshot)).not.toContain(canary);
    const fromJsonb = await prisma.$queryRaw<Array<{ proof: unknown }>>`SELECT ${JSON.stringify(before)}::jsonb AS proof`;
    const restored = await createAgentContextAuthorization({ ...f.input, restoring: true, checkpointProof: fromJsonb[0]!.proof });
    await expect(restored.check("resume", fromJsonb[0]!.proof as never)).resolves.toBeUndefined();
    expect(restored.memorySources().itemIds).toEqual([knowledge.itemId]);
    await expect(assertAgentContextForExecution(f.runId)).resolves.toBeUndefined();
  });
  it.each(["asset_archived", "asset_deleted", "binding_disabled", "binding_unapproved"])("blocks recalled text and derived tool arguments after %s", async change => {
    const f = await fixture(); const guard = await createAgentContextAuthorization(f.input); const knowledge = await addKnowledge(f, true);
    await guard.registerKnowledge(knowledge.runId, [knowledge.itemId]);
    if (change === "asset_archived") await prisma.knowledgeAsset.update({ where: { id: f.assetId }, data: { status: "ARCHIVED", archivedAt: new Date() } });
    if (change === "binding_disabled") await prisma.knowledgeAssetRepresentative.updateMany({ where: { assetId: f.assetId, representativeId: f.repId }, data: { enabled: false } });
    if (change === "asset_deleted") await prisma.knowledgeAsset.delete({ where: { id: f.assetId } });
    if (change === "binding_unapproved") await prisma.knowledgeAssetRepresentative.updateMany({ where: { assetId: f.assetId, representativeId: f.repId }, data: { reviewStatus: "PENDING" } });
    await expect(guard.check("model")).rejects.toThrow("authorization_failed");
    await expect(guard.check("tool")).rejects.toThrow("authorization_failed");
    await expect(assertAgentContextForExecution(f.runId)).rejects.toThrow("authorization_failed");
  });
  it.each(["audience", "owner", "group", "redaction", "attachment", "short_term_disabled"])("invalidates the whole inherited context when %s changes", async change => {
    const f = await fixture(); const guard = await createAgentContextAuthorization(f.input);
    if (change === "audience") await prisma.conversation.update({ where: { id: f.conversationId }, data: { audienceIdentityId: null } });
    if (change === "owner") { const owner = await prisma.owner.create({ data: { displayName: "Synthetic changed owner" } }); await prisma.representative.update({ where: { id: f.repId }, data: { ownerId: owner.id } }); }
    if (change === "group") await prisma.conversation.update({ where: { id: f.conversationId }, data: { channel: "GROUP_REPLY" } });
    if (change === "redaction") await prisma.message.update({ where: { id: f.historyId }, data: { redactedAt: new Date() } });
    if (change === "attachment") await prisma.messageAttachment.create({ data: { messageId: f.messageId, fileName: "changed.txt", checksum: digest("changed") } });
    if (change === "short_term_disabled") await prisma.representativeMemoryPolicy.create({ data: { representativeId: f.repId, namespaceKey: randomUUID(), shortTermMemoryEnabled: false, contactMemoryCrossChannelEnabled: false } });
    await expect(guard.check("release")).rejects.toThrow("authorization_failed");
    await expect(createAgentContextAuthorization({ ...f.input, restoring: true, checkpointProof: guard.snapshot() })).rejects.toThrow("authorization_failed");
  });
  it("rejects old untracked checkpoints, changed scopes and a forged proof without upgrading them", async () => {
    const f = await fixture();
    await expect(createAgentContextAuthorization({ ...f.input, restoring: true })).rejects.toThrow("authorization_failed");
    expect((await prisma.generationRun.findUniqueOrThrow({ where: { id: f.runId } })).contextSnapshot).toEqual({ piExecutionProtocol: "goal_v2" });
    const guard = await createAgentContextAuthorization(f.input);
    await expect(createAgentContextAuthorization({ ...f.input, audienceIdentityId: "different" })).rejects.toThrow("authorization_failed");
    await expect(createAgentContextAuthorization({ ...f.input, restoring: true, checkpointProof: { ...guard.snapshot(), revision: "0".repeat(64) } })).rejects.toThrow("authorization_failed");
  });
  it("keeps immutable projection/hash enforcement instead of weakening SQL to simulate revocation", async () => {
    const f = await fixture(); const guard = await createAgentContextAuthorization(f.input); const k = await addKnowledge(f); await guard.registerKnowledge(k.runId, [k.itemId]);
    await expect(prisma.representativeVersion.update({ where: { id: f.versionId }, data: { status: "ARCHIVED" } })).rejects.toThrow("immutable");
    await expect(prisma.publicKnowledgeProjectionItem.update({ where: { id: k.projectionId }, data: { contentHash: digest("tamper") } })).rejects.toThrow("immutable");
    await expect(prisma.representativeVersionResource.deleteMany({ where: { publishedVersionId: f.versionId } })).rejects.toThrow();
    await expect(guard.check("resume", guard.snapshot())).resolves.toBeUndefined();
  });
  it("feeds no old checkpoint text, arguments, summaries or artifact names to the real Pi boundary after revocation", async () => {
    const f = await fixture(); const guard = await createAgentContextAuthorization(f.input); const knowledge = await addKnowledge(f, true); await guard.registerKnowledge(knowledge.runId, [knowledge.itemId]);
    const stream = vi.fn(); const input = { runId: f.runId, sessionId: f.conversationId, conversationId: f.conversationId, userId: f.audienceId, userText: f.input.userText,
      representative: { id: f.repId, versionId: f.versionId, name: "Synthetic", role: "Assistant" }, contextAuthorization: guard,
      model: { provider: "synthetic", modelId: "synthetic", model: {} as never, streamFn: stream } };
    const checkpoint = { version: 2 as const, replaySourcesTracked: true, runId: f.runId, sessionId: f.conversationId, scopeHash: executionScopeHash(input), goal: input.userText, contextAuthorization: guard.snapshot(),
      turnsUsed: 0, activeMs: 0, pending: { approvalId: "synthetic", callId: "pending", toolName: "execute_in_sandbox" }, messages: [],
      observations: [{ callId: "pending", toolName: "execute_in_sandbox", status: "pending_approval", text: canary, sources: [], artifacts: [] }] };
    await prisma.knowledgeAsset.update({ where: { id: f.assetId }, data: { status: "ARCHIVED", archivedAt: new Date() } });
    const result = await new DelegatePiAgentRuntime().run({ ...input, checkpoint, approvedToolResult: { approvalId: "synthetic", toolName: "execute_in_sandbox", status: "completed", text: canary } });
    expect(result.contextAuthorizationBlocked).toBe(true); expect(stream).not.toHaveBeenCalled(); expect(result.messages).toEqual([]); expect(result.text).not.toContain(canary);
  });
  it("does not run an approved derived script after its source is withdrawn; approval fact is retained", async () => {
    Object.assign(computeBrokerConfig.tencent, { apiKey: "synthetic", domain: "synthetic.invalid", allInOneTool: "synthetic" });
    const acquire = vi.spyOn(leases, "ensureUserSandboxLease").mockRejectedValue(new Error("must_not_dispatch"));
    const f = await fixture(); const guard = await createAgentContextAuthorization(f.input); const k = await addKnowledge(f, true); await guard.registerKnowledge(k.runId, [k.itemId]);
    const session = await createComputeSession({ representativeId: f.repId, contactId: f.contactId, conversationId: f.conversationId, generationRunId: f.runId,
      requestedBy: "audience", subagentId: "compute-agent", requestedCapabilities: ["exec"], reason: "synthetic" });
    const response = await executeTool(session.session.id, { capability: "exec", subagentId: "compute-agent", logicalAction: { version: 1, ordinal: 1 }, generationWorkLease: { outboxId: f.outboxId, leaseAttempt: 1 },
      isolatedPython: { profileId: "delegate.aio.single-python.v1", actionKey: "derived", source: `print('${canary}')`, timeoutMs: 1000, inputs: [] } });
    expect(response.outcome).toBe("pending_approval");
    await resolveApproval(response.approvalRequest!.id, { resolution: "approved", resolvedBy: "synthetic-owner" });
    await prisma.knowledgeAsset.update({ where: { id: f.assetId }, data: { status: "ARCHIVED", archivedAt: new Date() } });
    await processNextApprovedExecution();
    expect(acquire).not.toHaveBeenCalled(); expect(await prisma.ledgerEntry.count({ where: { sessionId: session.session.id } })).toBe(0);
    expect(await prisma.artifact.count({ where: { sessionId: session.session.id } })).toBe(0);
    expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: response.approvalRequest!.id } })).toMatchObject({ status: "APPROVED" });
    expect(await prisma.toolExecution.findUniqueOrThrow({ where: { id: response.execution.id } })).toMatchObject({ status: "FAILED" });
  });
  it("checks inherited history again at the actual provider delivery fence", async () => {
    const f = await fixture(); await createAgentContextAuthorization(f.input);
    const output = await prisma.message.create({ data: { conversationId: f.conversationId, episodeId: null, senderType: "REPRESENTATIVE", text: canary, deliveryStatus: "QUEUED" } });
    await prisma.generationRun.update({ where: { id: f.runId }, data: { outputMessageId: output.id, status: "COMPLETED" } });
    const coordinates = { runId: f.runId, conversationId: f.conversationId, outboxId: f.outboxId, leaseAttempt: 1, outputMessageId: output.id };
    const prepared = await prepareGenerationMessageChannelDelivery(coordinates);
    await admitGenerationMessageProviderDelivery({ ...coordinates, deliveryAdmission: prepared.deliveryAdmission });
    await prisma.message.update({ where: { id: f.historyId }, data: { redactedAt: new Date() } });
    const provider = vi.fn();
    const result = await prisma.$transaction(tx => withGenerationMessageProviderDeliveryFence(tx, { ...coordinates, deliveryAdmission: prepared.deliveryAdmission }, provider));
    expect(result).toMatchObject({ executed: false, reason: "memory_delivery_source_revoked" }); expect(provider).not.toHaveBeenCalled();
    expect(await prisma.message.findUniqueOrThrow({ where: { id: output.id } })).toMatchObject({ deliveryStatus: "CANCELED" });
  });
  it("blocks a previously downloadable derived file before reading storage or charging after source revocation", async () => {
    const f = await fixture(); const guard = await createAgentContextAuthorization(f.input); const k = await addKnowledge(f, true); await guard.registerKnowledge(k.runId, [k.itemId]);
    const session = await prisma.computeSession.create({ data: { representativeId: f.repId, representativeVersionId: f.versionId, contactId: f.contactId,
      conversationId: f.conversationId, generationRunId: f.runId, requestedBy: "AUDIENCE", baseImage: "synthetic", leaseTokenHash: digest(randomUUID()) } });
    const artifact = await prisma.artifact.create({ data: { representativeId: f.repId, conversationId: f.conversationId, contactId: f.contactId, sessionId: session.id,
      kind: "FILE", bucket: "synthetic", objectKey: "synthetic", mimeType: "text/plain", sizeBytes: Buffer.byteLength("SYNTHETIC_ARTIFACT"), sha256: digest("SYNTHETIC_ARTIFACT") } });
    const request = { representativeSlug: f.slug, artifactId: artifact.id, audienceIdentityId: f.audienceId };
    expect(await getPublicConversationArtifactDownload(request)).not.toBeNull(); storage.read.mockClear();
    const count = await prisma.ledgerEntry.count({ where: { sessionId: session.id } });
    await prisma.knowledgeAssetRepresentative.updateMany({ where: { assetId: f.assetId, representativeId: f.repId }, data: { enabled: false } });
    expect(await getPublicConversationArtifactDownload(request)).toBeNull(); expect(storage.read).not.toHaveBeenCalled();
    expect(await prisma.ledgerEntry.count({ where: { sessionId: session.id } })).toBe(count);
    expect(await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).toMatchObject({ downloadCount: 1 });
  });
  it.each(["wrong_action", "wrong_run", "wrong_approval", "other_visitor", "retention"])("rejects artifact %s before reading storage or recording egress", async change => {
    const f = await mediaFixture(); storage.read.mockClear();
    const origin = { generationRunId: f.runId, toolExecutionId: f.execution.id };
    if (change === "wrong_action") origin.toolExecutionId = "different-execution";
    if (change === "wrong_run") origin.generationRunId = "different-run";
    if (change === "retention") await prisma.artifact.update({ where: { id: f.artifact.id }, data: { retentionUntil: new Date(1) } });
    const result = await getPublicConversationArtifactDownload({ representativeSlug: f.slug, artifactId: f.artifact.id,
      audienceIdentityId: change === "other_visitor" ? "other-visitor" : f.audienceId }, { expectedOrigin: {
        ...origin, ...(change === "wrong_approval" ? { approvalId: "different-approval" } : {}) } });
    expect(result).toBeNull(); expect(storage.read).not.toHaveBeenCalled();
    expect(await prisma.ledgerEntry.count({ where: { sessionId: f.session.id } })).toBe(0);
    expect((await prisma.artifact.findUniqueOrThrow({ where: { id: f.artifact.id } })).downloadCount).toBe(0);
  });
  it("withholds bytes when the source is withdrawn while an authorized artifact read is in flight", async () => {
    const f = await mediaFixture();
    storage.read.mockImplementationOnce(async () => {
      await prisma.message.update({ where: { id: f.historyId }, data: { redactedAt: new Date() } });
      return { buffer: f.bytes, contentType: "image/png" };
    });
    const result = await getPublicConversationArtifactDownload({ representativeSlug: f.slug, artifactId: f.artifact.id, audienceIdentityId: f.audienceId },
      { expectedOrigin: { generationRunId: f.runId, toolExecutionId: f.execution.id } });
    expect(result).toBeNull();
    expect(await prisma.ledgerEntry.count({ where: { sessionId: f.session.id } })).toBe(0);
    expect((await prisma.artifact.findUniqueOrThrow({ where: { id: f.artifact.id } })).downloadCount).toBe(0);
  });
  it("reuses an authorized screenshot only within its originating run, then blocks a revoked seed at the model boundary", async () => {
    const f = await mediaFixture(); const read = vi.spyOn(brokerArtifacts, "readPersistedArtifactObject").mockResolvedValue(f.bytes);
    const seed = await loadLatestNativeBrowserSeed({ computeSessionId: f.session.id, sandboxIdentityId: f.identity.id });
    expect(seed.textSnippet).toBe(canary); expect(read).toHaveBeenCalledOnce();
    await prisma.message.update({ where: { id: f.historyId }, data: { redactedAt: new Date() } });
    vi.stubEnv("COMPUTE_NATIVE_OPENAI_ENABLED", "true"); vi.stubEnv("COMPUTE_NATIVE_OPENAI_MODEL", "synthetic-model"); vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
    const send = vi.fn(); vi.stubGlobal("fetch", send); const action = vi.fn();
    await expect(executeNativeComputerUseLoop({ ...seed, authorizeContext: seed.revalidate, provider: "openai", task: "Inspect the synthetic page",
      maxSteps: 1, allowMutations: false, executeActionBatch: action })).rejects.toThrow("authorization_failed");
    expect(send).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledOnce();
  });
  it("does not import the prior run's page or screenshot through a retained sandbox identity", async () => {
    const f = await mediaFixture(); const read = vi.spyOn(brokerArtifacts, "readPersistedArtifactObject").mockResolvedValue(f.bytes);
    const oldRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: f.runId } });
    const inputMessage = await prisma.message.create({ data: { conversationId: f.conversationId, episodeId: oldRun.episodeId, senderType: "AUDIENCE", text: "New task" } });
    const run = await prisma.generationRun.create({ data: { conversationId: f.conversationId, representativeVersionId: f.versionId,
      inputMessageId: inputMessage.id, episodeId: oldRun.episodeId, status: "PROCESSING", idempotencyKey: randomUUID() } });
    const session = await prisma.computeSession.create({ data: { representativeId: f.repId, contactId: f.contactId, conversationId: f.conversationId,
      generationRunId: run.id, requestedBy: "AUDIENCE", baseImage: "synthetic", leaseTokenHash: digest(randomUUID()) } });
    const pageRead = vi.spyOn(brokerDb.browserNavigation, "findFirst");
    await expect(loadLatestNativeBrowserSeed({ computeSessionId: session.id, sandboxIdentityId: f.identity.id })).rejects.toThrow("native_browser_seed_missing");
    expect(read).not.toHaveBeenCalled(); expect(pageRead).not.toHaveBeenCalled();
  });
  it("keeps status available without reading a derived approval summary", async () => {
    const f = await fixture();
    await prisma.approvalRequest.create({ data: { representativeId: f.repId, conversationId: f.conversationId,
      requestedActionSummary: canary, reason: "synthetic", riskSummary: "synthetic", status: "PENDING", expiresAt: new Date(Date.now()+60000) } });
    const query = vi.spyOn(prisma.approvalRequest, "findFirst");
    const result = await loadConversationOperationalContext({ representativeId: f.repId, conversationId: f.conversationId, audienceIdentityId: f.audienceId });
    expect(result?.pendingApproval).toBeDefined(); expect(JSON.stringify(result)).not.toContain(canary);
    expect(query.mock.calls[0]![0]?.select).toEqual({ expiresAt: true });
    expect(await loadConversationOperationalContext({ representativeId: f.repId, conversationId: f.conversationId, audienceIdentityId: "other-visitor" })).toBeNull();
  });
  it("freezes action dependencies, extends proofs atomically and preserves earlier files when unrelated later knowledge is revoked", async () => {
    const f = await mediaFixture(); const guard = await createAgentContextAuthorization(f.input);
    const captured = await captureAgentExecutionSources({ runId: f.runId, kind: "anonymous_browser" }); expect(captured).toBeDefined();
    await prisma.toolExecution.update({ where: { id: f.execution.id }, data: { finishedAt: new Date() } });
    await prisma.$transaction(tx => persistAgentExecutionSourceReceipt(tx, f.execution.id, captured!));
    const original = guard.snapshot(); const row = await prisma.generationRun.findUniqueOrThrow({ where: { id: f.runId } });
    await prisma.generationRun.update({ where: { id: f.runId }, data: { contextSnapshot: { ...row.contextSnapshot as object,
      piApprovalContinuation: { version: 2, status: "completed", approvalId: "synthetic", checkpoint: { replaySourcesTracked: true, contextAuthorization: original } } } } });
    const ref = await guard.registerToolResult(f.execution.id); expect(ref).toBeDefined(); expect(guard.hasResultSource!(ref!, "browse_in_sandbox")).toBe(true);
    const stored = await prisma.generationRun.findUniqueOrThrow({ where: { id: f.runId } });
    expect((stored.contextSnapshot as any).piApprovalContinuation.checkpoint.contextAuthorization).toEqual(guard.snapshot());
    await expect(assertAgentContextForExecution(f.runId)).resolves.toBeUndefined();
    const knowledge = await addKnowledge(f, true); await guard.registerKnowledge(knowledge.runId, [knowledge.itemId]);
    await prisma.knowledgeAsset.update({ where: { id: f.assetId }, data: { status: "ARCHIVED", archivedAt: new Date() } });
    await expect(guard.check("model")).rejects.toThrow("authorization_failed");
    storage.read.mockResolvedValueOnce({ buffer: f.bytes, contentType: "image/png" });
    const file = await getPublicConversationArtifactDownload({ representativeSlug: f.slug, artifactId: f.artifact.id, audienceIdentityId: f.audienceId }, { recordDownload: false });
    expect(file?.buffer).toEqual(f.bytes); // original action never consumed the later knowledge
    await prisma.message.update({ where: { id: f.historyId }, data: { redactedAt: new Date() } });
    storage.read.mockClear();
    expect(await getPublicConversationArtifactDownload({ representativeSlug: f.slug, artifactId: f.artifact.id, audienceIdentityId: f.audienceId })).toBeNull();
    expect(storage.read).not.toHaveBeenCalled(); expect(await prisma.ledgerEntry.count({ where: { sessionId: f.session.id } })).toBe(0);
  });
  it.each(["binding_disabled", "binding_changed", "definition_revoked", "artifact_changed", "retention_expired", "audience_changed"])("blocks registered public MCP after %s before the model and object read", async change => {
    const f = await remoteFixture();
    await f.guard.registerToolResult(f.execution.id);
    if (change === "binding_disabled") await prisma.representativeMcpBinding.update({ where: { id: f.binding.id }, data: { enabled: false } });
    if (change === "binding_changed") await prisma.representativeMcpBinding.update({ where: { id: f.binding.id }, data: { serverUrl: "https://different.invalid/mcp" } });
    if (change === "definition_revoked") await prisma.mcpToolDefinition.updateMany({ where: { bindingId: f.binding.id }, data: { supersededAt: new Date() } });
    if (change === "artifact_changed") await prisma.artifact.update({ where: { id: f.artifact.id }, data: { objectKey: "changed-object" } });
    if (change === "retention_expired") await prisma.artifact.update({ where: { id: f.artifact.id }, data: { retentionUntil: new Date(1) } });
    if (change === "audience_changed") await prisma.conversation.update({ where: { id: f.conversationId }, data: { audienceIdentityId: null } });
    const stream = vi.fn(); const run = await new DelegatePiAgentRuntime().run({ runId: f.runId, sessionId: f.conversationId, userText: "Continue",
      representative: { id: f.repId, versionId: f.versionId, name: "Synthetic", role: "Assistant" }, contextAuthorization: f.guard,
      model: { model: {} as never, provider: "synthetic", modelId: "synthetic", streamFn: stream } });
    expect(run.contextAuthorizationBlocked).toBe(true); expect(stream).not.toHaveBeenCalled();
    storage.read.mockClear();
    expect(await getPublicConversationArtifactDownload({ representativeSlug: f.slug, artifactId: f.artifact.id, audienceIdentityId: f.audienceId })).toBeNull();
    expect(storage.read).not.toHaveBeenCalled(); expect(await prisma.ledgerEntry.count({ where: { sessionId: f.session.id } })).toBe(0);
  });
  it("denies uncontracted MCP and old receipts instead of inferring public access from read-only or approval", async () => {
    const f = await remoteFixture();
    await prisma.representativeMcpBinding.update({ where: { id: f.binding.id }, data: { serverUrl: "https://private.invalid/mcp", approvalRequired: false } });
    expect(await captureAgentExecutionSources({ runId: f.runId, kind: "public_mcp", bindingId: f.binding.id, toolName: "openmeteo_search_locations" })).toBeUndefined();
    const old = await prisma.toolExecution.create({ data: { sessionId: f.session.id, capability: "MCP", status: "SUCCEEDED" } });
    const previous = f.guard.snapshot(); expect(await f.guard.registerToolResult(old.id)).toBeUndefined(); expect(f.guard.snapshot()).toEqual(previous);
  });
  it("keeps receipts immutable in SQL and bounds model reuse without expiring historical file access", async () => {
    const f = await remoteFixture(61 * 60 * 1000);
    await expect(f.guard.registerToolResult(f.execution.id)).rejects.toThrow("authorization_failed");
    await expect(prisma.toolExecution.update({ where: { id: f.execution.id }, data: { sourceReceipt: {} } })).rejects.toThrow("immutable");
    expect(await isAgentContextArtifactAuthorized({ runId: f.runId, representativeId: f.repId, conversationId: f.conversationId,
      audienceIdentityId: f.audienceId, toolExecutionId: f.execution.id, artifactId: f.artifact.id })).toBe(true);
    const receipt = (await prisma.toolExecution.findUniqueOrThrow({ where: { id: f.execution.id } })).sourceReceipt;
    expect(JSON.stringify(receipt)).not.toContain(canary); expect(JSON.stringify(receipt)).not.toContain("SYNTHETIC_PRIVATE_REQUEST_ARGUMENT");
  });
  it("resumes twice with DB-authorized remote evidence without reexecuting completed steps, then blocks after withdrawal", async () => {
    const f = await remoteFixture(); const contextInputs: unknown[] = []; const dispatch = vi.fn();
    const makeModel = (messages: any[]) => { const provider = fauxProvider({ tokensPerSecond: 100000 }); provider.setResponses(messages); const models = createModels(); models.setProvider(provider.provider);
      return { model: provider.getModel(), streamFn: models.streamSimple.bind(models), provider: "faux", modelId: provider.getModel().id }; };
    const sourceRef = await f.guard.registerToolResult(f.execution.id);
    const input = { runId: f.runId, sessionId: f.conversationId, conversationId: f.conversationId, userId: f.audienceId,
      userText: f.input.userText, contextAuthorization: f.guard, representative: { id: f.repId, versionId: f.versionId, name: "Synthetic", role: "Assistant" }, maxSteps: 8 };
    const sandbox = { execute: dispatch.mockResolvedValue({ status: "pending_approval", text: "pending", details: { approvalId: "approval-1" } }) };
    const mcp = { listTools: async () => [{ server: "fixture", name: "openmeteo_search_locations", description: "Synthetic public source", inputSchema: { type: "object", properties: {} }, readOnly: true, idempotent: true }],
      callTool: vi.fn(async () => ({ status: "completed", text: canary, contextSourceRef: sourceRef! })) };
    const first = await new DelegatePiAgentRuntime().run({ ...input, capabilities: { mcp, sandbox }, model: makeModel([
      fauxAssistantMessage(fauxToolCall("mcp__fixture__openmeteo_search_locations", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("execute_in_sandbox", { language: "python", code: "print(1)" }), { stopReason: "toolUse" }),
    ]) });
    expect(first.status).toBe("waiting_approval"); expect(first.checkpoint?.replaySourcesTracked).toBe(true);
    const row = await prisma.generationRun.findUniqueOrThrow({ where: { id: f.runId } });
    await prisma.generationRun.update({ where: { id: f.runId }, data: { contextSnapshot: { ...row.contextSnapshot as object,
      piApprovalContinuation: { version: 2, status: "completed", approvalId: "approval-1", checkpoint: JSON.parse(JSON.stringify(first.checkpoint)) } } } });
    const restored = await createAgentContextAuthorization({ ...f.input, restoring: true, checkpointProof: first.checkpoint!.contextAuthorization });
    dispatch.mockResolvedValue({ status: "pending_approval", text: "pending", details: { approvalId: "approval-2" } });
    const second = await new DelegatePiAgentRuntime().run({ ...input, contextAuthorization: restored, checkpoint: first.checkpoint!,
      approvedToolResult: { approvalId: "approval-1", toolName: "execute_in_sandbox", status: "completed", text: "first action receipt" },
      capabilities: { mcp, sandbox }, model: makeModel([(context: unknown) => { contextInputs.push(context); return fauxAssistantMessage(fauxToolCall("execute_in_sandbox", { language: "python", code: "print(2)" }), { stopReason: "toolUse" }); }]) });
    expect(second.status).toBe("waiting_approval"); expect(second.checkpoint?.replaySourcesTracked).toBe(true);
    expect(JSON.stringify(contextInputs)).toContain(canary); expect(mcp.callTool).toHaveBeenCalledOnce(); expect(dispatch).toHaveBeenCalledTimes(2);
    await prisma.representativeMcpBinding.update({ where: { id: f.binding.id }, data: { enabled: false } });
    const stream = vi.fn();
    const third = await new DelegatePiAgentRuntime().run({ ...input, contextAuthorization: restored, checkpoint: second.checkpoint!,
      approvedToolResult: { approvalId: "approval-2", toolName: "execute_in_sandbox", status: "completed", text: "second action receipt" },
      capabilities: { mcp, sandbox }, model: { ...makeModel([]), streamFn: stream } });
    expect(third.contextAuthorizationBlocked).toBe(true); expect(stream).not.toHaveBeenCalled(); expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("propagates a revoked remote dependency into a later derived action's artifact", async () => {
    const f = await remoteFixture(); await f.guard.registerToolResult(f.execution.id);
    const captured = await captureAgentExecutionSources({ runId: f.runId, kind: "derived_python" }); expect(captured).toBeDefined();
    const execution = await prisma.toolExecution.create({ data: { sessionId: f.session.id, capability: "EXEC", status: "SUCCEEDED", finishedAt: new Date(), requestedCommand: "isolated_python" } });
    const artifact = await prisma.artifact.create({ data: { representativeId: f.repId, conversationId: f.conversationId, contactId: f.contactId,
      sessionId: f.session.id, toolExecutionId: execution.id, kind: "FILE", bucket: "synthetic", objectKey: "derived", mimeType: "text/plain", sha256: digest(canary), sizeBytes: Buffer.byteLength(canary) } });
    await prisma.$transaction(tx => persistAgentExecutionSourceReceipt(tx, execution.id, captured!));
    const coordinates = { runId: f.runId, representativeId: f.repId, conversationId: f.conversationId, audienceIdentityId: f.audienceId, toolExecutionId: execution.id, artifactId: artifact.id };
    expect(await isAgentContextArtifactAuthorized(coordinates)).toBe(true);
    await prisma.representativeMcpBinding.update({ where: { id: f.binding.id }, data: { enabled: false } });
    expect(await isAgentContextArtifactAuthorized(coordinates)).toBe(false);
  });
  it("records a source receipt through the real Broker completion transaction and serves its exact artifact", async () => {
    const f = await fixture(); const guard = await createAgentContextAuthorization(f.input); const bodies = new Map<string, Buffer>();
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: any) => {
      if (command.constructor.name === "PutObjectCommand") { bodies.set(command.input.Key, Buffer.from(command.input.Body)); return {}; }
      if (command.constructor.name === "HeadBucketCommand") return {};
      throw new Error("unexpected_synthetic_storage_operation");
    });
    vi.spyOn(brokerLeases, "ensureComputeSessionLease").mockImplementation(async ({ session }) => ({ ...session, containerId: "synthetic", runnerType: "DOCKER" }));
    const runner = vi.spyOn(brokerRunner, "runRunnerExecution").mockResolvedValue({ exitCode: 0, wallMs: 10, containerName: "synthetic", termination: "exit", stdout: JSON.stringify({
      transportKind: "playwright", profilePath: "__delegate_anonymous_v1__", title: "Synthetic public page", finalUrl: "https://example.invalid",
      textSnippet: "SYNTHETIC_PUBLIC_PAGE", contentSnippet: "<body>Public</body>", httpStatus: 200, observedAt: new Date().toISOString(), links: [],
      screenshotBase64: Buffer.from("synthetic-image").toString("base64"), screenshotMimeType: "image/png" }), stderr: "" });
    const session = await createComputeSession({ representativeId: f.repId, contactId: f.contactId, conversationId: f.conversationId, generationRunId: f.runId,
      requestedBy: "audience", subagentId: "browser-agent", requestedCapabilities: ["browser"], reason: "synthetic" });
    const result = await executeTool(session.session.id, { capability: "browser", subagentId: "browser-agent", url: "https://example.invalid", browserMode: "deterministic", allowMutations: false,
      generationWorkLease: { outboxId: f.outboxId, leaseAttempt: 1 } });
    if (result.outcome === "pending_approval") { await resolveApproval(result.approvalRequest!.id, { resolution: "approved", resolvedBy: "synthetic-owner" }); await processNextApprovedExecution(); }
    const stored = await prisma.toolExecution.findUniqueOrThrow({ where: { id: result.execution.id } });
    expect(stored.status).toBe("SUCCEEDED"); expect(stored.sourceReceipt).toMatchObject({ access: { kind: "anonymous_browser" }, input: { scope: { runId: f.runId } } });
    expect(runner).toHaveBeenCalledOnce(); expect(runner.mock.calls[0]![0].command).toContain("browser.newContext"); expect(runner.mock.calls[0]![0].command).not.toContain("launchPersistentContext");
    const reference = await guard.registerToolResult(stored.id); expect(guard.hasResultSource!(reference!, "browse_in_sandbox")).toBe(true);
    const page = await prisma.artifact.findFirstOrThrow({ where: { toolExecutionId: stored.id, kind: "JSON" } });
    storage.read.mockResolvedValueOnce({ buffer: Buffer.from(bodies.get(page.objectKey)!), contentType: page.mimeType });
    const ledgerCount = await prisma.ledgerEntry.count({ where: { toolExecutionId: stored.id } });
    const downloaded = await getPublicConversationArtifactDownload({ representativeSlug: f.slug, artifactId: page.id, audienceIdentityId: f.audienceId },
      { recordDownload: false, expectedOrigin: { generationRunId: f.runId, toolExecutionId: stored.id } });
    expect(downloaded?.buffer.toString()).toContain("SYNTHETIC_PUBLIC_PAGE"); expect(bodies.size).toBe(2);
    expect(await prisma.ledgerEntry.count({ where: { toolExecutionId: stored.id } })).toBe(ledgerCount); expect(runner).toHaveBeenCalledOnce();
  });
});
async function fixture() {
  const id = randomUUID(); const owner = await prisma.owner.create({ data: { displayName: "Synthetic source owner" } });
  const rep = await prisma.representative.create({ data: { ownerId: owner.id, slug: `context-${id}`, displayName: "Synthetic", roleSummary: "Assistant", tone: "neutral", languages: ["zh"], freeScope: [], paywalledIntents: [], handoffPrompt: "Help", allowedSkills: [], actionGate: {}, computeEnabled: true, computeDefaultPolicyMode: "ASK", computeNetworkMode: "FULL", computeFilesystemMode: "EPHEMERAL_FULL", computeAutoApproveTokenLimit: 10000 } });
  await prisma.capabilityPolicyProfile.create({ data: { representativeId: rep.id, name: "Synthetic", isDefault: true, defaultDecision: "ASK", networkMode: "FULL", filesystemMode: "EPHEMERAL_FULL" } });
  const asset = await prisma.knowledgeAsset.create({ data: { ownerId: owner.id, kind: "TEXT", status: "READY", title: "Synthetic source", extractedText: canary, checksum: digest(canary) } });
  await prisma.knowledgeAssetRepresentative.create({ data: { assetId: asset.id, representativeId: rep.id, enabled: true, reviewStatus: "APPROVED" } });
  const version = await prisma.representativeVersion.create({ data: { representativeId: rep.id, versionNumber: 1, status: "PUBLISHED", snapshot: { knowledgeAssets: [{ assetId: asset.id, checksum: digest(canary), processingVersion: 1 }], compute: { enabled: true, defaultPolicyMode: "ask", baseImage: rep.computeBaseImage, maxSessionMinutes: 15, autoApproveTokenLimit: 10000, artifactRetentionDays: 14, networkMode: "full", networkAllowlist: [], filesystemMode: "ephemeral_full", capabilityModes: { exec: "ask", read: "allow", write: "ask", process: "deny", browser: "allow", mcp: "ask" } } } } });
  await prisma.representative.update({ where: { id: rep.id }, data: { activeVersionId: version.id } });
  const audience = await prisma.audienceIdentity.create({ data: { audienceKey: id, status: "REGISTERED" } });
  const contact = await prisma.contact.create({ data: { representativeId: rep.id, audienceIdentityId: audience.id, sourceChannel: "web" } });
  const conversation = await prisma.conversation.create({ data: { representativeId: rep.id, contactId: contact.id, audienceIdentityId: audience.id, channel: "PRIVATE_CHAT", sourceChannel: "web" } });
  const episode = await prisma.conversationEpisode.create({ data: { conversationId: conversation.id, representativeVersionId: version.id, sequence: 1 } });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { activeEpisodeId: episode.id } });
  const history = await prisma.message.create({ data: { conversationId: conversation.id, episodeId: episode.id, senderType: "AUDIENCE", text: "SYNTHETIC_PRIOR_USER_MESSAGE" } });
  const message = await prisma.message.create({ data: { conversationId: conversation.id, episodeId: episode.id, senderType: "AUDIENCE", text: "按资料继续" } });
  const run = await prisma.generationRun.create({ data: { conversationId: conversation.id, episodeId: episode.id, representativeVersionId: version.id, inputMessageId: message.id, status: "PROCESSING", idempotencyKey: id, runtimePolicySnapshot: { billingMode: "free" }, contextSnapshot: { piExecutionProtocol: "goal_v2" } } });
  const outbox = await prisma.outboxEvent.create({ data: { aggregateType: "generation_run", aggregateId: run.id, eventType: "generation.requested", payload: {}, status: "PROCESSING", attemptCount: 1, availableAt: new Date(Date.now()+300000), idempotencyKey: id } });
  const input = { runId: run.id, outboxId: outbox.id, leaseAttempt: 1, representativeId: rep.id, representativeVersionId: version.id, conversationId: conversation.id,
    contactId: contact.id, audienceIdentityId: audience.id, sourceChannel: "web", userText: message.text!, history: [{ id: history.id, text: history.text! }], restoring: false };
  return { input, repId: rep.id, slug: rep.slug, assetId: asset.id, versionId: version.id, audienceId: audience.id, conversationId: conversation.id, contactId: contact.id, runId: run.id, outboxId: outbox.id, messageId: message.id, historyId: history.id };
}
async function mediaFixture() {
  const f = await fixture(); await createAgentContextAuthorization(f.input);
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=", "base64");
  const scope = { representativeId: f.repId, conversationId: f.conversationId, contactId: f.contactId };
  const session = await prisma.computeSession.create({ data: { ...scope, representativeVersionId: f.versionId, generationRunId: f.runId,
    requestedBy: "AUDIENCE", baseImage: "synthetic", leaseTokenHash: digest(randomUUID()) } });
  const execution = await prisma.toolExecution.create({ data: { sessionId: session.id, capability: "BROWSER", status: "SUCCEEDED" } });
  const artifact = await prisma.artifact.create({ data: { ...scope, sessionId: session.id, toolExecutionId: execution.id,
    kind: "SCREENSHOT", bucket: "synthetic", objectKey: "synthetic-image", mimeType: "image/png", sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") } });
  const identity = await prisma.sandboxIdentity.create({ data: { representativeId: f.repId, contactId: f.contactId, audienceIdentityId: f.audienceId } });
  const browser = await prisma.browserSession.create({ data: { ...scope, computeSessionId: session.id, sandboxIdentityId: identity.id } });
  await prisma.browserNavigation.create({ data: { ...scope, browserSessionId: browser.id, toolExecutionId: execution.id, status: "SUCCEEDED",
    requestedUrl: "https://example.invalid", finalUrl: "https://example.invalid", textSnippet: canary, screenshotArtifactId: artifact.id } });
  return { ...f, session, execution, artifact, identity, bytes };
}

async function remoteFixture(ageMs = 0) {
  const f = await mediaFixture(); const guard = await createAgentContextAuthorization(f.input);
  const binding = await prisma.representativeMcpBinding.create({ data: { representativeId: f.repId, slug: "fixture", displayName: "Synthetic public service",
    serverUrl: "https://open-meteo.caseyjhand.com/mcp", allowedToolNames: ["openmeteo_search_locations"], approvalRequired: true } });
  await prisma.mcpToolDefinition.create({ data: { bindingId: binding.id, bindingRevision: 1, exactToolName: "openmeteo_search_locations",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    toolSchemaHash: "af23eb22e1651a38e705d9ceeff31faca25ef327324256088ca275b8d2849968", bindingDefinitionHash: "a".repeat(64), observedAt: new Date() } });
  const captured = await captureAgentExecutionSources({ runId: f.runId, kind: "public_mcp", bindingId: binding.id, toolName: "openmeteo_search_locations" }); expect(captured).toBeDefined();
  await prisma.toolExecution.update({ where: { id: f.execution.id }, data: { capability: "MCP", mcpBindingId: binding.id,
    requestedCommand: "openmeteo_search_locations", requestPayload: { toolArguments: { name: "SYNTHETIC_PRIVATE_REQUEST_ARGUMENT" } }, finishedAt: new Date(Date.now() - ageMs) } });
  await prisma.$transaction(tx => persistAgentExecutionSourceReceipt(tx, f.execution.id, captured!));
  return { ...f, guard, binding };
}

async function addKnowledge(f: Awaited<ReturnType<typeof fixture>>, asset = false) {
  const sourceKind = asset ? "KNOWLEDGE_ASSET" as const : "REPRESENTATIVE_VERSION_RESOURCE" as const;
  const resourceKey = asset ? `knowledge/${f.assetId}.md` : "identity/profile.md";
  const knowledgeAssetId = asset ? f.assetId : null;
  if (!asset) await prisma.representativeVersionResource.create({ data: { representativeId: f.repId, publishedVersionId: f.versionId, sourceKind, resourceKey, knowledgeAssetId, contentHash: digest(canary), safeText: canary } });
  const projected = await prisma.publicKnowledgeProjectionItem.create({ data: { representativeId: f.repId, publishedVersionId: f.versionId, sourceKind, resourceKey, knowledgeAssetId, contentHash: digest(canary), remoteUri: `viking://resources/delegate/reps/${f.slug}/versions/${f.versionId}/${resourceKey}`, projectedAt: new Date() } });
  const use = await startOrReuseMemoryUseRun({ generationRunId: f.runId, sourceChannel: "web" });
  const hits = await recordMemoryUseSearchHits({ useRunId: use.run.id, hits: [{ sourceKind: "PUBLIC_KNOWLEDGE", publicKnowledgeProjectionId: projected.id }] });
  expect(hits.eligibleItems).toHaveLength(1);
  return { runId: use.run.id, itemId: hits.eligibleItems[0]!.memoryUseItemId, projectionId: projected.id };
}

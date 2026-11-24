import { createHash, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { prisma } from "../src/prisma";
import { createAgentContextAuthorization, captureAgentExecutionSources, persistAgentExecutionSourceReceipt } from "../src/agent-context-authorization";
import { recordMemoryUseSearchHits, startOrReuseMemoryUseRun } from "../src/memory-use-execution";
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const canary = "SYNTHETIC_CITATION_SOURCE";

export async function prepared(asset = false) {
  const f = await fixture();
  const guard = await createAgentContextAuthorization(f.input);
  const knowledge = await addKnowledge(f, asset);
  await guard.registerKnowledge(knowledge.runId, [knowledge.itemId]);
  const run = await prisma.generationRun.findUniqueOrThrow({ where: { id: f.runId } });
  return { ...f, guard, knowledge, episodeId: run.episodeId!, source: { id: knowledge.itemId, title: "Synthetic", channel: "knowledge" as const } };
}
export async function nextRun(f: Pick<Awaited<ReturnType<typeof prepared>>, "input" | "conversationId" | "episodeId" | "versionId">) {
  const id = randomUUID();
  const message = await prisma.message.create({ data: { conversationId: f.conversationId, episodeId: f.episodeId, senderType: "AUDIENCE", text: "next" } });
  const run = await prisma.generationRun.create({ data: { conversationId: f.conversationId, episodeId: f.episodeId, representativeVersionId: f.versionId, inputMessageId: message.id, status: "PROCESSING", idempotencyKey: id, contextSnapshot: { piExecutionProtocol: "goal_v2" }, runtimePolicySnapshot: { billingMode: "free" } } });
  const outbox = await prisma.outboxEvent.create({ data: { aggregateType: "generation_run", aggregateId: run.id, eventType: "generation.requested", payload: {}, status: "PROCESSING", attemptCount: 1, availableAt: new Date(Date.now() + 300000), idempotencyKey: id } });
  return { runId: run.id, input: { ...f.input, runId: run.id, outboxId: outbox.id, userText: "next", history: [] } };
}
export async function webObservation(f: Awaited<ReturnType<typeof fixture>>, guard: Awaited<ReturnType<typeof createAgentContextAuthorization>>) {
  const captured = await captureAgentExecutionSources({ runId: f.runId, kind: "anonymous_browser" });
  const scope = { representativeId: f.repId, conversationId: f.conversationId, contactId: f.contactId };
  const session = await prisma.computeSession.create({ data: { ...scope, representativeVersionId: f.versionId, generationRunId: f.runId, requestedBy: "AUDIENCE", baseImage: "synthetic", leaseTokenHash: digest(randomUUID()) } });
  const execution = await prisma.toolExecution.create({ data: { sessionId: session.id, capability: "BROWSER", status: "SUCCEEDED", finishedAt: new Date() } });
  const artifact = await prisma.artifact.create({ data: { ...scope, sessionId: session.id, toolExecutionId: execution.id, kind: "JSON", bucket: "synthetic", objectKey: randomUUID(), mimeType: "application/json", sizeBytes: 2, sha256: digest("{}") } });
  await prisma.$transaction(tx => persistAgentExecutionSourceReceipt(tx, execution.id, captured!));
  const reference = await guard.registerToolResult(execution.id);
  return { reference: reference!, source: { id: artifact.id, title: "Web fixture", channel: "web" as const, url: "https://example.invalid/same-url" } };
}

export async function fixture() {
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
  return { input, episodeId: episode.id, repId: rep.id, slug: rep.slug, assetId: asset.id, versionId: version.id, audienceId: audience.id, conversationId: conversation.id, contactId: contact.id, runId: run.id, outboxId: outbox.id, messageId: message.id, historyId: history.id };
}

export async function addKnowledge(f: Awaited<ReturnType<typeof fixture>>, asset = false) {
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

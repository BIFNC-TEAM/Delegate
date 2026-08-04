import { createHash, randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  approveMemoryCandidate,
  requestGovernedMemoryDeletion,
} from "../src/memory-governance";
import {
  MemoryProjectionProviderError,
  runNextMemoryDeletionCleanup,
  runNextMemoryProjectionDeletion,
  runNextMemoryProjectionWrite,
  type MemoryProjectionProvider,
} from "../src/memory-projection-execution";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("Memory projection PostgreSQL execution", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("allows only one live SKIP LOCKED claimant", async () => {
    const fixture = await createApprovedFixture();
    const provider = new InMemoryProjectionProvider();
    provider.blockNextEnsure();

    const first = runNextMemoryProjectionWrite({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
      leaseMilliseconds: 5_000,
    });
    await provider.ensureStarted.promise;
    const second = await runNextMemoryProjectionWrite({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
      leaseMilliseconds: 5_000,
    });

    expect(second).toEqual({ processed: false });
    provider.releaseEnsure();
    await expect(first).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: { status: true, attemptCount: true },
    })).resolves.toEqual({ status: "ACTIVE", attemptCount: 1 });
  });

  it("recovers an expired write lease and rejects the stale worker completion", async () => {
    const fixture = await createApprovedFixture();
    const provider = new InMemoryProjectionProvider();
    provider.blockNextEnsure();

    const staleWorker = runNextMemoryProjectionWrite({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
      leaseMilliseconds: 25,
    });
    await provider.ensureStarted.promise;
    await waitMilliseconds(150);
    const recoveredWorker = await runNextMemoryProjectionWrite({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
      leaseMilliseconds: 5_000,
    });
    expect(recoveredWorker).toMatchObject({
      processed: true,
      status: "completed",
    });

    provider.releaseEnsure();
    await expect(staleWorker).resolves.toMatchObject({
      processed: true,
      status: "lease_lost",
      errorCode: "projection_lease_lost",
    });
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: { status: true, attemptCount: true, leaseToken: true },
    })).resolves.toEqual({
      status: "ACTIVE",
      attemptCount: 2,
      leaseToken: null,
    });
  });

  it("turns delete-during-write into exact deletion and completes proof only after absence", async () => {
    const fixture = await createApprovedFixture();
    const provider = new InMemoryProjectionProvider();
    provider.blockNextWrite();

    const writer = runNextMemoryProjectionWrite({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
      leaseMilliseconds: 5_000,
    });
    await provider.writeStarted.promise;
    const deletion = await requestDeletion(fixture);
    provider.releaseWrite();

    await expect(writer).resolves.toMatchObject({
      processed: true,
      status: "completed",
      errorCode: "projection_not_authoritative",
    });
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: { status: true, deleteRequestedAt: true },
    })).resolves.toMatchObject({
      status: "DELETE_PENDING",
      deleteRequestedAt: expect.any(Date),
    });

    await expect(runNextMemoryProjectionDeletion({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    }))
      .resolves.toMatchObject({ processed: true, status: "completed" });
    await expect(runNextMemoryDeletionCleanup({
      client: prisma,
      representativeId: fixture.representativeId,
    }))
      .resolves.toMatchObject({ processed: true, status: "completed" });

    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: {
        status: true,
        deleteReceiptHash: true,
        remoteAbsentAt: true,
        leaseToken: true,
      },
    })).resolves.toMatchObject({
      status: "DELETED",
      deleteReceiptHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      remoteAbsentAt: expect.any(Date),
      leaseToken: null,
    });
    await expect(prisma.memoryDeletionProof.findUniqueOrThrow({
      where: { id: deletion.deletionProofId! },
      select: {
        cleanupStatus: true,
        localPurgeCompletedAt: true,
        remotePurgeCompletedAt: true,
        providerReceiptHash: true,
        proofHash: true,
        completedAt: true,
      },
    })).resolves.toMatchObject({
      cleanupStatus: "SUCCEEDED",
      localPurgeCompletedAt: expect.any(Date),
      remotePurgeCompletedAt: expect.any(Date),
      providerReceiptHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      proofHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      completedAt: expect.any(Date),
    });
    await expect(prisma.governedMemory.findUniqueOrThrow({
      where: { id: fixture.memoryId },
      select: { status: true },
    })).resolves.toEqual({ status: "DELETED" });
  });

  it("purges local bodies but keeps proof pending and retryable when remote delete fails", async () => {
    const fixture = await createApprovedFixture();
    const provider = new InMemoryProjectionProvider();
    const deletion = await requestDeletion(fixture);
    provider.failDeletes = true;

    await expect(runNextMemoryProjectionDeletion({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    }))
      .resolves.toMatchObject({
        processed: true,
        status: "retrying",
        errorCode: "test_remote_unavailable",
      });
    await expect(runNextMemoryDeletionCleanup({
      client: prisma,
      representativeId: fixture.representativeId,
    }))
      .resolves.toMatchObject({
        processed: true,
        status: "retrying",
        errorCode: "projection_drain_pending",
      });

    await expect(prisma.governedMemoryVersion.findUniqueOrThrow({
      where: { id: fixture.memoryVersionId },
      select: { safeText: true, summary: true, purgedAt: true, contentHash: true },
    })).resolves.toEqual({
      safeText: null,
      summary: null,
      purgedAt: expect.any(Date),
      contentHash: fixture.contentHash,
    });
    await expect(prisma.memoryCandidate.findUniqueOrThrow({
      where: { id: fixture.candidateId },
      select: { safeText: true, summary: true, contentPurgedAt: true },
    })).resolves.toEqual({
      safeText: null,
      summary: null,
      contentPurgedAt: expect.any(Date),
    });
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: {
        status: true,
        remoteUri: true,
        contentHash: true,
        deleteReceiptHash: true,
        remoteAbsentAt: true,
      },
    })).resolves.toEqual({
      status: "DELETE_PENDING",
      remoteUri: fixture.remoteUri,
      contentHash: fixture.contentHash,
      deleteReceiptHash: null,
      remoteAbsentAt: null,
    });
    await expect(prisma.memoryDeletionProof.findUniqueOrThrow({
      where: { id: deletion.deletionProofId! },
      select: {
        cleanupStatus: true,
        localPurgeCompletedAt: true,
        remotePurgeCompletedAt: true,
        providerReceiptHash: true,
        proofHash: true,
        completedAt: true,
      },
    })).resolves.toEqual({
      cleanupStatus: "RETRYING",
      localPurgeCompletedAt: expect.any(Date),
      remotePurgeCompletedAt: null,
      providerReceiptHash: null,
      proofHash: null,
      completedAt: null,
    });
    await expect(prisma.governedMemory.findUniqueOrThrow({
      where: { id: fixture.memoryId },
      select: { status: true, deletedAt: true },
    })).resolves.toEqual({ status: "DELETE_PENDING", deletedAt: null });
  });

  it("repairs hash drift on the same URI without creating business-deletion evidence", async () => {
    const fixture = await createApprovedFixture();
    const provider = new InMemoryProjectionProvider();
    await runNextMemoryProjectionWrite({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    });
    const before = await prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: { writeReceiptHash: true, writeVerifiedAt: true },
    });
    provider.objects.set(fixture.remoteUri, "f".repeat(64));

    const reconciliation = await createPartialReconciliationIssue(fixture, {
      issueKind: "HASH_MISMATCH",
      reasonCode: "reconciliation_hash_mismatch",
      observedContentHash: "f".repeat(64),
    });
    provider.events.length = 0;

    await expect(runNextMemoryProjectionWrite({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    }))
      .resolves.toMatchObject({ processed: true, status: "completed" });

    expect(provider.events).toEqual([
      "inspect:present",
      "delete:deleted",
      "inspect:absent",
      "ensure",
      "write:created",
      "inspect:present",
    ]);
    expect(provider.objects.get(fixture.remoteUri)).toBe(fixture.contentHash);
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: {
        status: true,
        remoteUri: true,
        writeReceiptHash: true,
        writeVerifiedAt: true,
        deleteReceiptHash: true,
        remoteAbsentAt: true,
        lastErrorCode: true,
      },
    })).resolves.toMatchObject({
      status: "ACTIVE",
      remoteUri: fixture.remoteUri,
      writeReceiptHash: expect.not.stringMatching(before.writeReceiptHash!),
      writeVerifiedAt: expect.any(Date),
      deleteReceiptHash: null,
      remoteAbsentAt: null,
      lastErrorCode: null,
    });
    await expect(prisma.memoryReconciliationItem.findFirstOrThrow({
      where: {
        reconciliationRunId: reconciliation.id,
        projectionItemId: fixture.projectionId,
      },
      select: { status: true, resolvedAt: true, lastErrorCode: true },
    })).resolves.toEqual({
      status: "RESOLVED",
      resolvedAt: expect.any(Date),
      lastErrorCode: null,
    });
    await expect(prisma.memoryReconciliationRun.findUniqueOrThrow({
      where: { id: reconciliation.id },
      select: { resolvedCount: true },
    })).resolves.toEqual({ resolvedCount: 1 });
  });

  it("recovers a conflicting create by exact cleanup and rewrite without business deletion evidence", async () => {
    const fixture = await createApprovedFixture();
    const provider = new InMemoryProjectionProvider();
    provider.objects.set(fixture.remoteUri, "e".repeat(64));

    await expect(runNextMemoryProjectionWrite({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
      retryBaseMilliseconds: 1,
    })).resolves.toMatchObject({
      processed: true,
      status: "retrying",
      errorCode: "projection_content_conflict",
    });
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: {
        status: true,
        lastErrorCode: true,
        deleteRequestedAt: true,
        deleteReceiptHash: true,
      },
    })).resolves.toEqual({
      status: "RETRYING",
      lastErrorCode: "projection_write_cleanup_required",
      deleteRequestedAt: null,
      deleteReceiptHash: null,
    });

    provider.events.length = 0;
    await waitMilliseconds(10);
    await expect(runNextMemoryProjectionWrite({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
      retryBaseMilliseconds: 1,
    })).resolves.toMatchObject({ processed: true, status: "completed" });

    expect(provider.events).toEqual([
      "inspect:present",
      "delete:deleted",
      "inspect:absent",
      "ensure",
      "write:created",
      "inspect:present",
    ]);
    expect(provider.objects.get(fixture.remoteUri)).toBe(fixture.contentHash);
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: {
        status: true,
        remoteUri: true,
        lastErrorCode: true,
        deleteRequestedAt: true,
        deleteReceiptHash: true,
        remoteAbsentAt: true,
      },
    })).resolves.toEqual({
      status: "ACTIVE",
      remoteUri: fixture.remoteUri,
      lastErrorCode: null,
      deleteRequestedAt: null,
      deleteReceiptHash: null,
      remoteAbsentAt: null,
    });
  });

  it("resolves a known-stale issue only after its exact remote leaf is confirmed absent", async () => {
    const fixture = await createApprovedFixture();
    const provider = new InMemoryProjectionProvider();
    await runNextMemoryProjectionWrite({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    });
    await prisma.memoryProjectionItem.update({
      where: { id: fixture.projectionId },
      data: { status: "SUPERSEDED" },
    });
    const reconciliation = await createPartialReconciliationIssue(fixture, {
      issueKind: "STALE_ACTIVE_POINTER",
      reasonCode: "reconciliation_stale_active_pointer",
    });

    await expect(runNextMemoryProjectionDeletion({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    }))
      .resolves.toMatchObject({ processed: true, status: "completed" });

    await expect(prisma.memoryReconciliationItem.findFirstOrThrow({
      where: {
        reconciliationRunId: reconciliation.id,
        projectionItemId: fixture.projectionId,
      },
      select: { status: true, resolvedAt: true },
    })).resolves.toEqual({ status: "RESOLVED", resolvedAt: expect.any(Date) });
    await expect(prisma.memoryReconciliationRun.findUniqueOrThrow({
      where: { id: reconciliation.id },
      select: { resolvedCount: true },
    })).resolves.toEqual({ resolvedCount: 1 });
  });

  it("lets Owner deletion supersede a fenced hash repair and complete auditable cleanup", async () => {
    const fixture = await createApprovedFixture();
    const provider = new InMemoryProjectionProvider();
    await runNextMemoryProjectionWrite({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    });
    const reconciliation = await createPartialReconciliationIssue(fixture, {
      issueKind: "HASH_MISMATCH",
      reasonCode: "reconciliation_hash_mismatch",
      observedContentHash: "c".repeat(64),
    });

    const deletion = await requestDeletion(fixture);
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: { status: true, lastErrorCode: true, deleteRequestedAt: true },
    })).resolves.toEqual({
      status: "DELETE_PENDING",
      lastErrorCode: null,
      deleteRequestedAt: expect.any(Date),
    });
    await expect(runNextMemoryProjectionDeletion({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    }))
      .resolves.toMatchObject({ processed: true, status: "completed" });
    await expect(runNextMemoryDeletionCleanup({
      client: prisma,
      representativeId: fixture.representativeId,
    }))
      .resolves.toMatchObject({ processed: true, status: "completed" });
    await expect(prisma.memoryDeletionProof.findUniqueOrThrow({
      where: { id: deletion.deletionProofId! },
      select: { cleanupStatus: true, completedAt: true },
    })).resolves.toEqual({
      cleanupStatus: "SUCCEEDED",
      completedAt: expect.any(Date),
    });
    await expect(prisma.memoryReconciliationItem.findUniqueOrThrow({
      where: {
        reconciliationRunId_itemKey: {
          reconciliationRunId: reconciliation.id,
          itemKey: `known_projection:${fixture.projectionId}`,
        },
      },
      select: { status: true, resolvedAt: true, lastErrorCode: true },
    })).resolves.toEqual({
      status: "RESOLVED",
      resolvedAt: expect.any(Date),
      lastErrorCode: null,
    });
    await expect(prisma.memoryReconciliationRun.findUniqueOrThrow({
      where: { id: reconciliation.id },
      select: { issueCount: true, resolvedCount: true },
    })).resolves.toEqual({ issueCount: 1, resolvedCount: 1 });
  });
});

class InMemoryProjectionProvider implements MemoryProjectionProvider {
  readonly name = "projection-test";
  readonly objects = new Map<string, string>();
  readonly events: string[] = [];
  failDeletes = false;
  ensureStarted = deferred<void>();
  writeStarted = deferred<void>();
  private ensureRelease: ReturnType<typeof deferred<void>> | null = null;
  private activeEnsureRelease: ReturnType<typeof deferred<void>> | null = null;
  private writeRelease: ReturnType<typeof deferred<void>> | null = null;

  blockNextEnsure() {
    this.ensureStarted = deferred<void>();
    this.ensureRelease = deferred<void>();
  }

  releaseEnsure() {
    this.activeEnsureRelease?.resolve(undefined);
    this.activeEnsureRelease = null;
  }

  blockNextWrite() {
    this.writeStarted = deferred<void>();
    this.writeRelease = deferred<void>();
  }

  releaseWrite() {
    this.writeRelease?.resolve(undefined);
    this.writeRelease = null;
  }

  async ensureRoot(input: { namespaceKey: string; rootUri: string }) {
    this.events.push("ensure");
    if (this.ensureRelease) {
      const release = this.ensureRelease;
      this.ensureRelease = null;
      this.activeEnsureRelease = release;
      this.ensureStarted.resolve(undefined);
      await release.promise;
    }
    return { rootUri: input.rootUri, receipt: `ensure:${input.rootUri}` };
  }

  async writeExact(input: {
    namespaceKey: string;
    uri: string;
    safeText: string;
    contentHash: string;
  }) {
    if (this.writeRelease) {
      const release = this.writeRelease;
      this.writeStarted.resolve(undefined);
      await release.promise;
    }
    const current = this.objects.get(input.uri);
    if (current && current !== input.contentHash) {
      throw new MemoryProjectionProviderError(
        "projection_content_conflict",
        "Different bytes already exist.",
        false,
        true,
      );
    }
    const outcome = current ? "unchanged" : "created";
    this.objects.set(input.uri, input.contentHash);
    this.events.push(`write:${outcome}`);
    return {
      uri: input.uri,
      contentHash: input.contentHash,
      receipt: `write:${outcome}:${input.uri}:${input.contentHash}`,
    };
  }

  async inspectExact(input: { namespaceKey: string; uri: string }) {
    const contentHash = this.objects.get(input.uri);
    this.events.push(contentHash ? "inspect:present" : "inspect:absent");
    return contentHash
      ? {
          uri: input.uri,
          exists: true,
          contentHash,
          receipt: `inspect:present:${input.uri}:${contentHash}`,
        }
      : {
          uri: input.uri,
          exists: false,
          receipt: `inspect:absent:${input.uri}`,
        };
  }

  async deleteExact(input: { namespaceKey: string; uri: string }) {
    if (this.failDeletes) {
      throw new MemoryProjectionProviderError(
        "test_remote_unavailable",
        "Test provider is unavailable.",
        true,
      );
    }
    const existed = this.objects.delete(input.uri);
    const outcome = existed ? "deleted" as const : "absent" as const;
    this.events.push(`delete:${outcome}`);
    return {
      uri: input.uri,
      outcome,
      receipt: `delete:${outcome}:${input.uri}`,
    };
  }
}

async function createApprovedFixture() {
  const suffix = randomUUID();
  const providerName = "projection-test";
  const owner = await prisma.owner.create({
    data: { displayName: `Projection owner ${suffix}` },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `projection-${suffix}`,
      displayName: "Projection representative",
      roleSummary: "Tests governed memory projection.",
      tone: "clear",
      languages: ["en"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
    },
  });
  await prisma.representativeMemoryPolicy.create({
    data: {
      representativeId: representative.id,
      namespaceKey: `projection-${suffix}`,
      longTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      representativeExperienceEnabled: false,
      autoExtract: false,
      webRecallEnabled: true,
      webExtractEnabled: false,
      provider: providerName,
    },
  });
  const contact = await prisma.contact.create({
    data: { representativeId: representative.id, sourceChannel: "WEB" },
  });
  const conversation = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: contact.id,
      channel: "PRIVATE_CHAT",
      sourceChannel: "WEB",
    },
  });
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      senderType: "AUDIENCE",
      text: "I prefer concise replies",
    },
  });
  const safeText = "Preference: reply_length=concise";
  const contentHash = createHash("sha256").update(safeText).digest("hex");
  const candidate = await prisma.memoryCandidate.create({
    data: {
      representativeId: representative.id,
      contactId: contact.id,
      scope: "CONTACT_CHANNEL",
      scopeChannel: "WEB",
      originChannel: "WEB",
      category: "CONTACT_PREFERENCE",
      sourceKind: "AUDIENCE_MESSAGE",
      safeText,
      summary: safeText,
      contentHash,
      dedupeKey: `candidate-${suffix}`,
      status: "PENDING_REVIEW",
      safetyClass: "LOW_RISK",
      extractionReasonCode: "explicit_contact_preference",
      sourceContactId: contact.id,
      sourceConversationId: conversation.id,
      sourceMessageId: message.id,
    },
  });
  const approved = await approveMemoryCandidate({
    actorOwnerId: owner.id,
    representativeSlug: representative.slug,
    candidateId: candidate.id,
    requestId: `approve-${suffix}`,
    idempotencyKey: `approve-${suffix}`,
    expectedUpdatedAt: candidate.updatedAt.toISOString(),
    reasonCode: "owner_verified",
  }, { client: prisma });
  if (!approved.memoryId || !approved.memoryVersionId) {
    throw new Error("Approved fixture did not create governed memory coordinates.");
  }
  const projection = await prisma.memoryProjectionItem.findFirstOrThrow({
    where: {
      memoryId: approved.memoryId,
      memoryVersionId: approved.memoryVersionId,
    },
  });
  return {
    ownerId: owner.id,
    representativeId: representative.id,
    representativeSlug: representative.slug,
    candidateId: candidate.id,
    memoryId: approved.memoryId,
    memoryVersionId: approved.memoryVersionId,
    projectionId: projection.id,
    remoteUri: projection.remoteUri,
    contentHash,
    providerName,
  };
}

async function createPartialReconciliationIssue(
  fixture: Awaited<ReturnType<typeof createApprovedFixture>>,
  issue: {
    issueKind: "HASH_MISMATCH" | "STALE_ACTIVE_POINTER";
    reasonCode:
      | "reconciliation_hash_mismatch"
      | "reconciliation_stale_active_pointer";
    observedContentHash?: string;
  },
) {
  const reconciliation = await prisma.memoryReconciliationRun.create({
    data: {
      representativeId: fixture.representativeId,
      provider: fixture.providerName,
      idempotencyKey: `reconcile-${randomUUID()}`,
    },
  });
  const startedAt = new Date();
  const runLeaseToken = randomUUID();
  await prisma.memoryReconciliationRun.update({
    where: { id: reconciliation.id },
    data: {
      status: "RUNNING",
      attemptCount: 1,
      leaseToken: runLeaseToken,
      leaseExpiresAt: new Date(startedAt.getTime() + 60_000),
      startedAt,
    },
  });
  const projection = await prisma.memoryProjectionItem.findUniqueOrThrow({
    where: { id: fixture.projectionId },
    select: {
      status: true,
      updatedAt: true,
      attemptCount: true,
      remoteUri: true,
      contentHash: true,
    },
  });
  const targetKind = issue.issueKind === "STALE_ACTIVE_POINTER"
    ? "KNOWN_STALE" as const
    : "EXPECTED_ACTIVE" as const;
  await prisma.memoryReconciliationTarget.create({
    data: {
      reconciliationRunId: reconciliation.id,
      representativeId: fixture.representativeId,
      projectionItemId: fixture.projectionId,
      kind: targetKind,
      snapshotProjectionStatus: projection.status,
      snapshotProjectionUpdatedAt: projection.updatedAt,
      snapshotAttemptCount: projection.attemptCount,
      snapshotRemoteUri: projection.remoteUri,
      expectedContentHash: projection.contentHash,
    },
  });
  const targetLeaseToken = randomUUID();
  await prisma.memoryReconciliationTarget.update({
    where: {
      reconciliationRunId_projectionItemId: {
        reconciliationRunId: reconciliation.id,
        projectionItemId: fixture.projectionId,
      },
    },
    data: {
      status: "CHECKING",
      attemptCount: 1,
      leaseToken: targetLeaseToken,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  await prisma.memoryReconciliationItem.create({
    data: {
      reconciliationRunId: reconciliation.id,
      representativeId: fixture.representativeId,
      projectionItemId: fixture.projectionId,
      itemKey: `known_projection:${fixture.projectionId}`,
      issueKind: issue.issueKind,
      expectedContentHash: fixture.contentHash,
      observedContentHash: issue.observedContentHash ?? null,
      remoteObjectIdHash: createHash("sha256")
        .update(fixture.remoteUri)
        .digest("hex"),
      reasonCode: issue.reasonCode,
    },
  });
  if (issue.issueKind === "HASH_MISMATCH") {
    await prisma.memoryProjectionItem.update({
      where: { id: fixture.projectionId },
      data: {
        status: "RETRYING",
        availableAt: new Date(),
        lastErrorCode: issue.reasonCode,
      },
    });
  } else {
    await prisma.memoryProjectionItem.update({
      where: { id: fixture.projectionId },
      data: {
        status: "DELETE_PENDING",
        deleteRequestedAt: new Date(),
        availableAt: new Date(),
        lastErrorCode: null,
      },
    });
  }
  await prisma.memoryReconciliationTarget.update({
    where: {
      reconciliationRunId_projectionItemId: {
        reconciliationRunId: reconciliation.id,
        projectionItemId: fixture.projectionId,
      },
    },
    data: {
      status: "ISSUE",
      remoteExists: issue.issueKind === "HASH_MISMATCH" ? true : null,
      observedContentHash: issue.observedContentHash ?? null,
      checkedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  await prisma.memoryReconciliationRun.update({
    where: { id: reconciliation.id },
    data: {
      status: "PARTIAL",
      expectedCount: 1,
      observedCount: issue.issueKind === "HASH_MISMATCH" ? 1 : 0,
      issueCount: 1,
      leaseToken: null,
      leaseExpiresAt: null,
      finishedAt: new Date(),
      errorCode: "openviking_inventory_no_snapshot_cursor",
    },
  });
  return reconciliation;
}

async function requestDeletion(
  fixture: Awaited<ReturnType<typeof createApprovedFixture>>,
) {
  const memory = await prisma.governedMemory.findUniqueOrThrow({
    where: { id: fixture.memoryId },
    select: { updatedAt: true },
  });
  const suffix = randomUUID();
  return requestGovernedMemoryDeletion({
    actorOwnerId: fixture.ownerId,
    representativeSlug: fixture.representativeSlug,
    memoryId: fixture.memoryId,
    requestId: `delete-${suffix}`,
    idempotencyKey: `delete-${suffix}`,
    expectedUpdatedAt: memory.updatedAt.toISOString(),
    reasonCode: "owner_request",
  }, { client: prisma });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitMilliseconds(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for Memory projection PostgreSQL E2E.");
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host)
    || !["test", "e2e", "delegate"].some((marker) => database.includes(marker))
  ) {
    throw new Error(`Refusing Memory projection PostgreSQL E2E against ${host}/${database}.`);
  }
}

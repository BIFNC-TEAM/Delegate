import { createHash, randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  applyAutomaticMemoryPolicyInTransaction,
  requestAutomaticContactReplyPreferenceDeletionInTransaction,
} from "../src/memory-governance";
import { runNextMemoryLifecycle } from "../src/memory-lifecycle";
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
    const fixture = await createAutomaticallyActivatedFixture();
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

  it("archives expired memory and immediately withdraws its recall projection", async () => {
    const fixture = await createAutomaticallyActivatedFixture();
    const expiresAt = new Date(Date.now() + 50);
    await prisma.governedMemory.update({
      where: { id: fixture.memoryId },
      data: { expiresAt },
    });
    await waitMilliseconds(100);

    await expect(runNextMemoryLifecycle({
      client: prisma,
      representativeId: fixture.representativeId,
    })).resolves.toMatchObject({
      processed: true,
      archivedCount: 1,
      deletePendingCount: 0,
    });
    await expect(prisma.governedMemory.findUniqueOrThrow({
      where: { id: fixture.memoryId },
      select: { status: true, recallDisabledAt: true, archivedAt: true },
    })).resolves.toEqual({
      status: "ARCHIVED",
      recallDisabledAt: expect.any(Date),
      archivedAt: expect.any(Date),
    });
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: { status: true, deleteRequestedAt: true },
    })).resolves.toEqual({
      status: "DELETE_PENDING",
      deleteRequestedAt: expect.any(Date),
    });
    await expect(prisma.memoryDeletionProof.findUnique({
      where: { memoryId: fixture.memoryId },
    })).resolves.toBeNull();
  });

  it("deletes an expired memory with a legacy versioned correction and body-free proof", async () => {
    const fixture = await createAutomaticallyActivatedFixture();
    const provider = new InMemoryProjectionProvider();
    const source = await prisma.memoryCandidate.findUniqueOrThrow({
      where: { id: fixture.candidateId },
      select: {
        contactId: true,
        sourceContactId: true,
        sourceConversationId: true,
        sourceMessageId: true,
      },
    });
    const correctionText = "Preference: reply_length=detailed";
    const correctionHash = createHash("sha256")
      .update(correctionText)
      .digest("hex");
    const suppressedAt = new Date();
    await prisma.governedMemory.update({
      where: { id: fixture.memoryId },
      data: {
        status: "SUPPRESSED",
        recallDisabledAt: suppressedAt,
        suppressedAt,
      },
    });
    const correction = await prisma.memoryCandidate.create({
      data: {
        representativeId: fixture.representativeId,
        contactId: source.contactId,
        scope: "CONTACT_CHANNEL",
        scopeChannel: "WEB",
        originChannel: "WEB",
        category: "CONTACT_PREFERENCE",
        sourceKind: "OWNER_VERIFIED_CORRECTION",
        safeText: correctionText,
        summary: correctionText,
        contentHash: correctionHash,
        semanticKey: "contact-preference:communication",
        dedupeKey: `legacy-correction-${randomUUID()}`,
        status: "PENDING_REVIEW",
        safetyClass: "LOW_RISK",
        extractionReasonCode: "legacy_owner_correction",
        sourceContactId: source.sourceContactId,
        sourceConversationId: source.sourceConversationId,
        sourceMessageId: source.sourceMessageId,
        correctionMemoryId: fixture.memoryId,
        correctionBaseVersionId: fixture.memoryVersionId,
      },
    });
    const correctionVersion = await prisma.governedMemoryVersion.create({
      data: {
        memoryId: fixture.memoryId,
        representativeId: fixture.representativeId,
        scope: "CONTACT_CHANNEL",
        sourceCandidateId: correction.id,
        supersedesVersionId: fixture.memoryVersionId,
        versionNumber: 2,
        safeText: correctionText,
        summary: correctionText,
        contentHash: correctionHash,
        correctionReasonCode: "legacy_owner_correction",
        createdByActorId: "system:legacy-memory-migration",
      },
    });
    const expiresAt = new Date(Date.now() + 50);
    await prisma.representativeMemoryPolicy.update({
      where: { representativeId: fixture.representativeId },
      data: { expiryAction: "DELETE" },
    });
    await prisma.governedMemory.update({
      where: { id: fixture.memoryId },
      data: { expiresAt },
    });
    await waitMilliseconds(100);

    await expect(runNextMemoryLifecycle({
      client: prisma,
      representativeId: fixture.representativeId,
    })).resolves.toMatchObject({ processed: true, deletePendingCount: 1 });
    const proof = await prisma.memoryDeletionProof.findUniqueOrThrow({
      where: { memoryId: fixture.memoryId },
    });
    expect(proof).toMatchObject({
      requestedByActorId: "system:memory-lifecycle",
      reasonCode: "memory_retention_expired",
      contentHash: fixture.contentHash,
      cleanupStatus: "QUEUED",
    });
    expect(JSON.stringify(proof)).not.toContain("Preference: reply_length");
    await expect(prisma.memoryCandidate.findUniqueOrThrow({
      where: { id: correction.id },
      select: { status: true, safeText: true, summary: true, contentPurgedAt: true },
    })).resolves.toEqual({
      status: "EXPIRED",
      safeText: null,
      summary: null,
      contentPurgedAt: expect.any(Date),
    });
    await expect(prisma.governedMemoryVersion.findUniqueOrThrow({
      where: { id: correctionVersion.id },
      select: { safeText: true, purgedAt: true },
    })).resolves.toEqual({ safeText: correctionText, purgedAt: null });

    await expect(runNextMemoryProjectionDeletion({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    })).resolves.toMatchObject({ processed: true, status: "completed" });
    await expect(runNextMemoryDeletionCleanup({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    })).resolves.toMatchObject({ processed: true, status: "completed" });
    await expect(prisma.governedMemory.findUniqueOrThrow({
      where: { id: fixture.memoryId },
      select: { status: true },
    })).resolves.toEqual({ status: "DELETED" });
    await expect(prisma.governedMemoryVersion.findUniqueOrThrow({
      where: { id: correctionVersion.id },
      select: { safeText: true, summary: true, purgedAt: true },
    })).resolves.toEqual({
      safeText: null,
      summary: null,
      purgedAt: expect.any(Date),
    });
  });

  it("reprojects policy-withdrawn tombstones after re-enable but never retries ordinary FAILED", async () => {
    const fixture = await createAutomaticallyActivatedFixture();
    const provider = new InMemoryProjectionProvider();
    await runNextMemoryProjectionWrite({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    });
    await prisma.representativeMemoryPolicy.update({
      where: { representativeId: fixture.representativeId },
      data: {
        longTermMemoryEnabled: false,
        contactMemoryEnabled: false,
        autoExtract: false,
        webRecallEnabled: false,
        webExtractEnabled: false,
      },
    });
    await prisma.memoryProjectionItem.update({
      where: { id: fixture.projectionId },
      data: {
        status: "DELETE_PENDING",
        deleteRequestedAt: new Date(),
        availableAt: new Date(),
        lastErrorCode: "projection_cleanup_requested_by_memory_policy",
      },
    });
    await runNextMemoryProjectionDeletion({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    });
    await prisma.representativeMemoryPolicy.update({
      where: { representativeId: fixture.representativeId },
      data: {
        longTermMemoryEnabled: true,
        contactMemoryEnabled: true,
        autoExtract: true,
        webRecallEnabled: true,
        webExtractEnabled: true,
      },
    });

    await expect(runNextMemoryProjectionWrite({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    })).resolves.toMatchObject({ processed: true, status: "completed" });
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: { status: true, deleteRequestedAt: true },
    })).resolves.toEqual({ status: "ACTIVE", deleteRequestedAt: null });
    await expect(prisma.memoryDeletionProof.findUnique({
      where: { memoryId: fixture.memoryId },
    })).resolves.toBeNull();

    const failedFixture = await createAutomaticallyActivatedFixture();
    await prisma.memoryProjectionItem.update({
      where: { id: failedFixture.projectionId },
      data: { status: "FAILED", lastErrorCode: "provider_rejected" },
    });
    await expect(runNextMemoryProjectionWrite({
      client: prisma,
      provider,
      representativeId: failedFixture.representativeId,
    })).resolves.toEqual({ processed: false });
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: failedFixture.projectionId },
      select: { status: true },
    })).resolves.toEqual({ status: "FAILED" });
  });

  it.each(["DELETE_PENDING", "DELETE_FAILED"] as const)(
    "requeues a proof-free policy withdrawal from %s without violating receipt immutability",
    async (withdrawnStatus) => {
      const fixture = await createAutomaticallyActivatedFixture();
      const provider = new InMemoryProjectionProvider();
      await runNextMemoryProjectionWrite({
        client: prisma,
        provider,
        representativeId: fixture.representativeId,
      });
      await prisma.representativeMemoryPolicy.update({
        where: { representativeId: fixture.representativeId },
        data: {
          longTermMemoryEnabled: false,
          contactMemoryEnabled: false,
          autoExtract: false,
          webRecallEnabled: false,
          webExtractEnabled: false,
        },
      });
      await prisma.memoryProjectionItem.update({
        where: { id: fixture.projectionId },
        data: {
          status: "DELETE_PENDING",
          deleteRequestedAt: new Date(),
          availableAt: new Date(),
          lastErrorCode: "projection_cleanup_requested_by_memory_policy",
        },
      });
      if (withdrawnStatus === "DELETE_FAILED") {
        provider.failDeletes = true;
        await expect(runNextMemoryProjectionDeletion({
          client: prisma,
          provider,
          representativeId: fixture.representativeId,
          retryBaseMilliseconds: 1,
        })).resolves.toMatchObject({
          processed: true,
          status: "retrying",
          errorCode: "test_remote_unavailable",
        });
        provider.failDeletes = false;
      }
      await prisma.representativeMemoryPolicy.update({
        where: { representativeId: fixture.representativeId },
        data: {
          longTermMemoryEnabled: true,
          contactMemoryEnabled: true,
          autoExtract: true,
          webRecallEnabled: true,
          webExtractEnabled: true,
        },
      });

      await expect(runNextMemoryProjectionWrite({
        client: prisma,
        provider,
        representativeId: fixture.representativeId,
      })).resolves.toMatchObject({ processed: true, status: "completed" });
      await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
        where: { id: fixture.projectionId },
        select: {
          status: true,
          attemptCount: true,
          deleteRequestedAt: true,
          deleteReceiptHash: true,
          remoteAbsentAt: true,
        },
      })).resolves.toEqual({
        status: "ACTIVE",
        attemptCount: 1,
        deleteRequestedAt: null,
        deleteReceiptHash: null,
        remoteAbsentAt: null,
      });
      await expect(prisma.memoryDeletionProof.findUnique({
        where: { memoryId: fixture.memoryId },
      })).resolves.toBeNull();
    },
  );

  it("never revives an explicit deletion after restart or policy re-enable", async () => {
    const fixture = await createAutomaticallyActivatedFixture();
    await requestDeletion(fixture);
    await prisma.representativeMemoryPolicy.update({
      where: { representativeId: fixture.representativeId },
      data: { longTermMemoryEnabled: true, webRecallEnabled: true },
    });

    await expect(runNextMemoryProjectionWrite({
      client: prisma,
      provider: new InMemoryProjectionProvider(),
      representativeId: fixture.representativeId,
    })).resolves.toEqual({ processed: false });
    await expect(runNextMemoryProjectionWrite({
      client: prisma,
      provider: new InMemoryProjectionProvider(),
      representativeId: fixture.representativeId,
    })).resolves.toEqual({ processed: false });
    await expect(prisma.memoryProjectionItem.update({
      where: { id: fixture.projectionId },
      data: {
        status: "QUEUED",
        remoteObjectId: null,
        writeReceiptHash: null,
        writeVerifiedAt: null,
        deleteReceiptHash: null,
        remoteAbsentAt: null,
        attemptCount: 0,
        projectedAt: null,
        deleteRequestedAt: null,
        deletedAt: null,
        lastErrorCode: null,
      },
    })).rejects.toThrow();
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: { status: true },
    })).resolves.toEqual({ status: "DELETE_PENDING" });
    await expect(prisma.memoryDeletionProof.findUnique({
      where: { memoryId: fixture.memoryId },
      select: { id: true },
    })).resolves.toEqual({ id: expect.any(String) });
  });

  it("recovers an expired write lease and rejects the stale worker completion", async () => {
    const fixture = await createAutomaticallyActivatedFixture();
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
    const fixture = await createAutomaticallyActivatedFixture();
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
      provider,
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
    const fixture = await createAutomaticallyActivatedFixture();
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
      provider,
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

  it("automatically resumes a due failed cleanup without restoring recall", async () => {
    const fixture = await createAutomaticallyActivatedFixture();
    const provider = new InMemoryProjectionProvider();
    const deletion = await requestDeletion(fixture);

    await expect(runNextMemoryProjectionDeletion({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    })).resolves.toMatchObject({ processed: true, status: "completed" });

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const leaseToken = `cleanup-failed-${attempt}-${randomUUID()}`;
      await prisma.memoryDeletionProof.update({
        where: { id: deletion.deletionProofId! },
        data: {
          cleanupStatus: "RUNNING",
          attemptCount: attempt,
          leaseToken,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          lastErrorCode: null,
        },
      });
      await prisma.memoryDeletionProof.update({
        where: { id: deletion.deletionProofId! },
        data: {
          cleanupStatus: "FAILED",
          availableAt: new Date(Date.now() - 1_000),
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: "test_cleanup_exhausted",
        },
      });
      if (attempt < 8) {
        await prisma.memoryDeletionProof.update({
          where: { id: deletion.deletionProofId! },
          data: { cleanupStatus: "QUEUED" },
        });
      }
    }

    const resumed = await runNextMemoryDeletionCleanup({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    });
    const completed = resumed.processed
      ? resumed
      : await runNextMemoryDeletionCleanup({
          client: prisma,
          provider,
          representativeId: fixture.representativeId,
        });
    expect(completed).toMatchObject({ processed: true, status: "completed" });

    await expect(prisma.governedMemory.findUniqueOrThrow({
      where: { id: fixture.memoryId },
      select: { status: true, recallDisabledAt: true },
    })).resolves.toEqual({
      status: "DELETED",
      recallDisabledAt: expect.any(Date),
    });
    await expect(prisma.memoryDeletionProof.findUniqueOrThrow({
      where: { id: deletion.deletionProofId! },
      select: { cleanupStatus: true, attemptCount: true, completedAt: true },
    })).resolves.toEqual({
      cleanupStatus: "SUCCEEDED",
      attemptCount: 9,
      completedAt: expect.any(Date),
    });
  });

  it("repairs hash drift on the same URI without creating business-deletion evidence", async () => {
    const fixture = await createAutomaticallyActivatedFixture();
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
    const fixture = await createAutomaticallyActivatedFixture();
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
    const fixture = await createAutomaticallyActivatedFixture();
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

  it("lets automatic contact deletion supersede a fenced hash repair and complete auditable cleanup", async () => {
    const fixture = await createAutomaticallyActivatedFixture();
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
      provider,
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

async function createAutomaticallyActivatedFixture() {
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
      autoExtract: true,
      webRecallEnabled: true,
      webExtractEnabled: true,
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
      semanticKey: "contact-preference:communication",
      dedupeKey: `candidate-${suffix}`,
      status: "PENDING_REVIEW",
      safetyClass: "LOW_RISK",
      extractionReasonCode: "explicit_contact_preference",
      sourceContactId: contact.id,
      sourceConversationId: conversation.id,
      sourceMessageId: message.id,
    },
  });
  const activated = await prisma.$transaction((tx) =>
    applyAutomaticMemoryPolicyInTransaction(tx, {
      candidateId: candidate.id,
      sourceHash: createHash("sha256")
        .update(message.text ?? "")
        .digest("hex"),
      confidence: 1,
    }),
  );
  if (!activated.memoryId || !activated.memoryVersionId) {
    throw new Error("Automatic policy did not create governed memory coordinates.");
  }
  const projection = await prisma.memoryProjectionItem.findFirstOrThrow({
    where: {
      memoryId: activated.memoryId,
      memoryVersionId: activated.memoryVersionId,
    },
  });
  return {
    representativeId: representative.id,
    contactId: contact.id,
    candidateId: candidate.id,
    memoryId: activated.memoryId,
    memoryVersionId: activated.memoryVersionId,
    projectionId: projection.id,
    remoteUri: projection.remoteUri,
    contentHash,
    providerName,
  };
}

async function createPartialReconciliationIssue(
  fixture: Awaited<ReturnType<typeof createAutomaticallyActivatedFixture>>,
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
  fixture: Awaited<ReturnType<typeof createAutomaticallyActivatedFixture>>,
) {
  const suffix = randomUUID();
  const result = await prisma.$transaction((tx) =>
    requestAutomaticContactReplyPreferenceDeletionInTransaction(tx, {
      representativeId: fixture.representativeId,
      contactId: fixture.contactId,
      sourceChannel: "WEB",
      sourceMessageId: `forget-${suffix}`,
      sourceHash: createHash("sha256")
        .update("forget my reply preference")
        .digest("hex"),
      occurredAt: new Date(),
    }),
  );
  if (!result.matched || !result.memoryId) {
    throw new Error("Automatic contact forget did not resolve the fixture memory.");
  }
  const proof = await prisma.memoryDeletionProof.findUniqueOrThrow({
    where: { memoryId: fixture.memoryId },
    select: { id: true },
  });
  return { ...result, deletionProofId: proof.id };
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

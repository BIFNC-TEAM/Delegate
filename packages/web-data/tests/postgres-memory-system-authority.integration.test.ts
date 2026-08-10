import crypto from "node:crypto";

import { buildGovernedContactChannelMemoryVersionUri } from "@delegate/openviking";
import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("Memory System PostgreSQL authority guards", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("fails closed across approval, staging, active-version, and deletion boundaries", async () => {
    const suffix = crypto.randomUUID();
    const namespaceKey = `memory-authority-${suffix}`;
    const safeText = "Prefers concise answers.";
    const hash = crypto.createHash("sha256").update(safeText).digest("hex");
    const owner = await prisma.owner.create({
      data: { displayName: `Memory authority ${suffix}` },
    });
    const representative = await prisma.representative.create({
      data: {
        ownerId: owner.id,
        slug: `memory-authority-${suffix}`,
        displayName: "Memory authority representative",
        roleSummary: "Exercises governed memory constraints.",
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
        namespaceKey,
        longTermMemoryEnabled: true,
        contactMemoryEnabled: true,
        representativeExperienceEnabled: false,
        autoExtract: false,
        webRecallEnabled: true,
        webExtractEnabled: false,
      },
    });
    const publishedVersion = await prisma.representativeVersion.create({
      data: {
        representativeId: representative.id,
        versionNumber: 1,
        status: "PUBLISHED",
        snapshot: { knowledgeAssets: [] },
      },
    });
    await prisma.representative.update({
      where: { id: representative.id },
      data: { activeVersionId: publishedVersion.id },
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
        text: "Please remember that concise answers are preferred.",
      },
    });
    const generationRun = await prisma.generationRun.create({
      data: {
        conversationId: conversation.id,
        inputMessageId: message.id,
        representativeVersionId: publishedVersion.id,
        status: "PROCESSING",
        idempotencyKey: `memory-authority-generation-${suffix}`,
      },
    });
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
        summary: "Answer concisely.",
        contentHash: hash,
        semanticKey: "contact-preference:communication",
        dedupeKey: `candidate-${suffix}`,
        status: "PENDING_REVIEW",
        safetyClass: "LOW_RISK",
        extractionReasonCode: "explicit_preference",
        sourceContactId: contact.id,
        sourceConversationId: conversation.id,
        sourceMessageId: message.id,
      },
    });
    const memory = await prisma.governedMemory.create({
      data: {
        representativeId: representative.id,
        contactId: contact.id,
        scope: "CONTACT_CHANNEL",
        sourceChannel: "WEB",
        category: "CONTACT_PREFERENCE",
      },
    });
    const memoryVersion = await prisma.governedMemoryVersion.create({
      data: {
        memoryId: memory.id,
        representativeId: representative.id,
        scope: "CONTACT_CHANNEL",
        sourceCandidateId: candidate.id,
        versionNumber: 1,
        safeText: candidate.safeText,
        summary: candidate.summary,
        contentHash: hash,
        createdByActorId: owner.id,
      },
    });

    const legacySafeText = "Prefers detailed answers.";
    const legacyHash = crypto.createHash("sha256").update(legacySafeText).digest("hex");
    const legacyCandidate = await prisma.memoryCandidate.create({
      data: {
        representativeId: representative.id,
        contactId: contact.id,
        scope: "CONTACT_CHANNEL",
        scopeChannel: "WEB",
        originChannel: "WEB",
        category: "CONTACT_PREFERENCE",
        sourceKind: "AUDIENCE_MESSAGE",
        safeText: legacySafeText,
        summary: legacySafeText,
        contentHash: legacyHash,
        semanticKey: "contact-preference:legacy-authority-check",
        dedupeKey: `legacy-candidate-${suffix}`,
        status: "PENDING_REVIEW",
        safetyClass: "LOW_RISK",
        extractionReasonCode: "legacy_owner_review",
        sourceContactId: contact.id,
        sourceConversationId: conversation.id,
        sourceMessageId: message.id,
      },
    });
    const legacyMemory = await prisma.governedMemory.create({
      data: {
        representativeId: representative.id,
        contactId: contact.id,
        scope: "CONTACT_CHANNEL",
        sourceChannel: "WEB",
        category: "CONTACT_PREFERENCE",
        semanticKey: "contact-preference:legacy-authority-check",
      },
    });
    const legacyVersion = await prisma.governedMemoryVersion.create({
      data: {
        memoryId: legacyMemory.id,
        representativeId: representative.id,
        scope: "CONTACT_CHANNEL",
        sourceCandidateId: legacyCandidate.id,
        versionNumber: 1,
        safeText: legacySafeText,
        summary: legacySafeText,
        contentHash: legacyHash,
        createdByActorId: owner.id,
      },
    });
    await prisma.memoryReviewDecision.create({
      data: {
        representativeId: representative.id,
        candidateId: legacyCandidate.id,
        memoryId: legacyMemory.id,
        resultVersionId: legacyVersion.id,
        outcome: "APPROVED",
        reviewerRole: "OWNER",
        reviewerActorId: owner.id,
        reasonCode: "legacy_owner_review",
      },
    });
    await prisma.memoryCandidate.update({
      where: { id: legacyCandidate.id },
      data: { status: "APPROVED", reviewedAt: new Date() },
    });
    await expect(prisma.governedMemory.update({
      where: { id: legacyMemory.id },
      data: {
        status: "ACTIVE",
        currentVersionId: legacyVersion.id,
        recallDisabledAt: null,
      },
    })).rejects.toThrow(/automatic policy decision/u);

    await expect(prisma.memoryCandidate.update({
      where: { id: candidate.id },
      data: { status: "APPROVED", reviewedAt: new Date() },
    })).rejects.toThrow();
    expect((await prisma.memoryCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
    })).status).toBe("PENDING_REVIEW");

    await prisma.memoryPolicyDecision.create({
      data: {
        representativeId: representative.id,
        candidateId: candidate.id,
        memoryId: memory.id,
        resultVersionId: memoryVersion.id,
        outcome: "ACTIVATED",
        policyRevision: 0,
        policyVersion: "automatic-memory-v2",
        extractorVersion: "closed-structured-v2",
        sourceHash: crypto.createHash("sha256").update(message.text ?? "").digest("hex"),
        outputHash: hash,
        confidence: 1,
        reasonCode: "automatic_low_risk_activation",
        decisionHash: crypto.createHash("sha256").update(`decision-${suffix}`).digest("hex"),
      },
    });
    await prisma.memoryCandidate.update({
      where: { id: candidate.id },
      data: { status: "APPROVED", reviewedAt: new Date() },
    });
    await prisma.governedMemory.update({
      where: { id: memory.id },
      data: {
        status: "ACTIVE",
        currentVersionId: memoryVersion.id,
        recallDisabledAt: null,
      },
    });

    const stagedProjection = await prisma.memoryProjectionItem.create({
      data: {
        representativeId: representative.id,
        memoryId: memory.id,
        memoryVersionId: memoryVersion.id,
        provider: "staging-success",
        lane: "STAGING",
        status: "QUEUED",
        contentHash: hash,
        remoteUri: buildGovernedContactChannelMemoryVersionUri({
          namespaceKey,
          contactId: contact.id,
          channel: "web",
          memoryId: memory.id,
          memoryVersionId: memoryVersion.id,
        }),
        idempotencyKey: `staging-success-${suffix}`,
      },
    });
    const stagedLeaseToken = `staging-lease-${suffix}`;
    await prisma.memoryProjectionItem.update({
      where: { id: stagedProjection.id },
      data: {
        status: "PROJECTING",
        attemptCount: { increment: 1 },
        leaseToken: stagedLeaseToken,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(prisma.memoryProjectionItem.update({
      where: { id: stagedProjection.id },
      data: {
        status: "ACTIVE",
        remoteObjectId: `remote-${suffix}`,
        writeReceiptHash: crypto.createHash("sha256").update(`staging-write-${suffix}`).digest("hex"),
        writeVerifiedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        projectedAt: new Date(),
      },
    })).rejects.toThrow();
    await prisma.memoryProjectionItem.update({
      where: { id: stagedProjection.id },
      data: {
        status: "STAGED",
        remoteObjectId: stagedProjection.remoteUri,
        leaseToken: null,
        leaseExpiresAt: null,
        projectedAt: new Date(),
      },
    });
    await expect(prisma.memoryProjectionItem.delete({
      where: { id: stagedProjection.id },
    })).rejects.toThrow();

    const stalePublishedVersion = await prisma.representativeVersion.create({
      data: {
        representativeId: representative.id,
        versionNumber: 2,
        status: "PUBLISHED",
        snapshot: { knowledgeAssets: [] },
      },
    });
    await prisma.representative.update({
      where: { id: representative.id },
      data: { activeVersionId: stalePublishedVersion.id },
    });
    await expect(prisma.memoryUseRun.create({
      data: {
        representativeId: representative.id,
        conversationId: conversation.id,
        contactId: contact.id,
        sourceChannel: "WEB",
        representativeVersionId: publishedVersion.id,
        inputMessageId: message.id,
        generationRunId: generationRun.id,
        idempotencyKey: `stale-run-${suffix}`,
      },
    })).rejects.toThrow();
    await prisma.representative.update({
      where: { id: representative.id },
      data: { activeVersionId: publishedVersion.id },
    });

    const recallProjection = await prisma.memoryProjectionItem.create({
      data: {
        representativeId: representative.id,
        memoryId: memory.id,
        memoryVersionId: memoryVersion.id,
        provider: "recall-success",
        lane: "RECALL",
        status: "QUEUED",
        contentHash: hash,
        remoteUri: buildGovernedContactChannelMemoryVersionUri({
          namespaceKey,
          contactId: contact.id,
          channel: "web",
          memoryId: memory.id,
          memoryVersionId: memoryVersion.id,
        }),
        idempotencyKey: `recall-success-${suffix}`,
      },
    });
    const recallLeaseToken = `recall-lease-${suffix}`;
    await prisma.memoryProjectionItem.update({
      where: { id: recallProjection.id },
      data: {
        status: "PROJECTING",
        attemptCount: { increment: 1 },
        leaseToken: recallLeaseToken,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.memoryProjectionItem.update({
      where: { id: recallProjection.id },
      data: {
        status: "ACTIVE",
        remoteObjectId: recallProjection.remoteUri,
        writeReceiptHash: crypto.createHash("sha256").update(`recall-write-${suffix}`).digest("hex"),
        writeVerifiedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        projectedAt: new Date(),
      },
    });

    const recallBlockedAt = new Date();
    await prisma.governedMemory.update({
      where: { id: memory.id },
      data: {
        status: "SUPPRESSED",
        recallDisabledAt: recallBlockedAt,
        suppressedAt: recallBlockedAt,
      },
    });
    await prisma.governedMemory.update({
      where: { id: memory.id },
      data: { status: "DELETE_PENDING", deleteRequestedAt: new Date() },
    });
    const proof = await prisma.memoryDeletionProof.create({
      data: {
        representativeId: representative.id,
        memoryId: memory.id,
        requestId: `delete-${suffix}`,
        requestedByActorId: owner.id,
        reasonCode: "owner_request",
        contentHash: hash,
        recallBlockedAt,
      },
    });
    await prisma.memoryDeletionProof.update({
      where: { id: proof.id },
      data: {
        cleanupStatus: "RUNNING",
        attemptCount: 1,
        leaseToken: `cleanup-${suffix}`,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.memoryCandidate.update({
      where: { id: candidate.id },
      data: { safeText: null, summary: null, contentPurgedAt: new Date() },
    });
    await prisma.governedMemoryVersion.update({
      where: { id: memoryVersion.id },
      data: { safeText: null, summary: null, purgedAt: new Date() },
    });
    await prisma.memoryDeletionProof.update({
      where: { id: proof.id },
      data: { localPurgeCompletedAt: new Date() },
    });
    await expect(prisma.memoryDeletionProof.update({
      where: { id: proof.id },
      data: { remotePurgeCompletedAt: new Date() },
    })).rejects.toThrow();

    for (const projectionId of [stagedProjection.id, recallProjection.id]) {
      await prisma.memoryProjectionItem.update({
        where: { id: projectionId },
        data: { status: "DELETE_PENDING", deleteRequestedAt: new Date() },
      });
      await prisma.memoryProjectionItem.update({
        where: { id: projectionId },
        data: {
          status: "DELETING",
          attemptCount: { increment: 1 },
          leaseToken: `delete-${projectionId}`,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          lastErrorCode: null,
        },
      });
      await prisma.memoryProjectionItem.update({
        where: { id: projectionId },
        data: {
          status: "DELETED",
          deleteReceiptHash: crypto.createHash("sha256").update(`delete-${projectionId}`).digest("hex"),
          remoteAbsentAt: new Date(),
          deletedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
    }
    const remotePurgeCompletedAt = new Date();
    const providerReceiptHash = crypto.createHash("sha256").update(`provider-${suffix}`).digest("hex");
    await prisma.memoryDeletionProof.update({
      where: { id: proof.id },
      data: { remotePurgeCompletedAt, providerReceiptHash },
    });
    await prisma.memoryDeletionProof.update({
      where: { id: proof.id },
      data: {
        cleanupStatus: "SUCCEEDED",
        leaseToken: null,
        leaseExpiresAt: null,
        proofHash: crypto.createHash("sha256").update(`proof-${suffix}`).digest("hex"),
        completedAt: new Date(remotePurgeCompletedAt.getTime() + 1),
      },
    });
    await prisma.governedMemory.update({
      where: { id: memory.id },
      data: { status: "DELETED", deletedAt: new Date() },
    });
    await expect(prisma.governedMemory.update({
      where: { id: memory.id },
      data: { status: "SUPPRESSED" },
    })).rejects.toThrow();
    await expect(prisma.memoryDeletionProof.delete({
      where: { id: proof.id },
    })).rejects.toThrow();
  });
});

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for the Memory System PostgreSQL E2E.");
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host)
    || !["test", "e2e", "delegate"].some((marker) => database.includes(marker))
  ) {
    throw new Error(`Refusing Memory System PostgreSQL E2E against ${host}/${database}.`);
  }
}

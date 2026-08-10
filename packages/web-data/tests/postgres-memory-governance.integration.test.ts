import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  requestAutomaticContactReplyPreferenceDeletionInTransaction,
} from "../src/memory-governance";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("Memory System T4 PostgreSQL governance guards", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("locks correction coordinates and prevents legacy human correction from reactivating memory", async () => {
    const fixture = await createFixture("correction");
    const initial = await createApprovedContactMemory(fixture, "initial");
    const suppressedAt = new Date();
    await prisma.governedMemory.update({
      where: { id: initial.memory.id },
      data: {
        status: "SUPPRESSED",
        recallDisabledAt: suppressedAt,
        suppressedAt,
      },
    });

    const correctionSource = await createAudienceMessage(
      fixture.conversationId,
      "Please remember that detailed answers are now preferred.",
    );
    const correction = await prisma.memoryCandidate.create({
      data: {
        ...contactCandidateData(fixture, correctionSource.id, "correction"),
        sourceKind: "OWNER_VERIFIED_CORRECTION",
        safeText: "Prefers detailed answers.",
        summary: "Answer with useful detail.",
        contentHash: hashOf("corrected-contact-memory"),
        correctionMemoryId: initial.memory.id,
        correctionBaseVersionId: initial.version.id,
      },
    });
    await prisma.memoryReviewDecision.create({
      data: {
        representativeId: fixture.representativeId,
        candidateId: correction.id,
        memoryId: initial.memory.id,
        outcome: "CORRECTION_REQUESTED",
        reviewerRole: "OWNER",
        reviewerActorId: fixture.ownerId,
        reasonCode: "owner_correction_requested",
      },
    });

    await expect(prisma.memoryReviewDecision.create({
      data: {
        representativeId: fixture.representativeId,
        candidateId: correction.id,
        memoryId: initial.memory.id,
        outcome: "CORRECTION_REQUESTED",
        reviewerRole: "ADMIN",
        reviewerActorId: `${fixture.ownerId}-admin`,
        reasonCode: "duplicate_correction_request",
      },
    })).rejects.toThrow();

    await expect(prisma.memoryCandidate.create({
      data: {
        ...contactCandidateData(fixture, correctionSource.id, "duplicate-correction"),
        sourceKind: "OWNER_VERIFIED_CORRECTION",
        correctionMemoryId: initial.memory.id,
        correctionBaseVersionId: initial.version.id,
      },
    })).rejects.toThrow();

    await expect(prisma.memoryCandidate.update({
      where: { id: correction.id },
      data: { correctionBaseVersionId: null },
    })).rejects.toThrow();

    const correctedVersion = await prisma.governedMemoryVersion.create({
      data: {
        memoryId: initial.memory.id,
        representativeId: fixture.representativeId,
        scope: "CONTACT_CHANNEL",
        sourceCandidateId: correction.id,
        supersedesVersionId: initial.version.id,
        versionNumber: 2,
        safeText: correction.safeText,
        summary: correction.summary,
        contentHash: correction.contentHash!,
        correctionReasonCode: "owner_verified_correction",
        createdByActorId: `${fixture.ownerId}-correction-requester`,
      },
    });

    await prisma.governedMemory.update({
      where: { id: initial.memory.id },
      data: { currentVersionId: null },
    });
    await expect(prisma.memoryReviewDecision.create({
      data: approvalDecisionData(
        fixture,
        correction.id,
        initial.memory.id,
        correctedVersion.id,
        "stale-correction",
      ),
    })).rejects.toThrow();

    await prisma.governedMemory.update({
      where: { id: initial.memory.id },
      data: { currentVersionId: initial.version.id },
    });
    await prisma.memoryReviewDecision.create({
      data: approvalDecisionData(
        fixture,
        correction.id,
        initial.memory.id,
        correctedVersion.id,
        "current-correction",
      ),
    });
    await prisma.memoryCandidate.update({
      where: { id: correction.id },
      data: { status: "APPROVED", reviewedAt: new Date() },
    });
    await expect(prisma.governedMemory.update({
      where: { id: initial.memory.id },
      data: {
        status: "ACTIVE",
        currentVersionId: correctedVersion.id,
        recallDisabledAt: null,
      },
      select: { status: true, currentVersionId: true },
    })).rejects.toThrow(/automatic policy decision/u);
  });

  it("rejects restore after source invalidation and while policy is disabled", async () => {
    const sourceFixture = await createFixture("restore-source");
    const sourceMemory = await createApprovedContactMemory(sourceFixture, "source");
    await prisma.message.update({
      where: { id: sourceMemory.message.id },
      data: {
        text: "Edited source must permanently invalidate this approval.",
        deliveryStatus: "EDITED",
        editedAt: new Date(),
      },
    });
    await expect(prisma.governedMemory.findUniqueOrThrow({
      where: { id: sourceMemory.memory.id },
      select: { status: true, recallDisabledAt: true },
    })).resolves.toMatchObject({ status: "SUPPRESSED" });
    await expect(prisma.governedMemory.update({
      where: { id: sourceMemory.memory.id },
      data: { status: "ACTIVE", recallDisabledAt: null },
    })).rejects.toThrow();

    const policyFixture = await createFixture("restore-policy");
    const policyMemory = await createApprovedContactMemory(policyFixture, "policy");
    const suppressedAt = new Date();
    await prisma.governedMemory.update({
      where: { id: policyMemory.memory.id },
      data: {
        status: "SUPPRESSED",
        recallDisabledAt: suppressedAt,
        suppressedAt,
      },
    });
    await prisma.representativeMemoryPolicy.update({
      where: { representativeId: policyFixture.representativeId },
      data: {
        webRecallEnabled: false,
        contactMemoryEnabled: false,
      },
    });
    await expect(prisma.governedMemory.update({
      where: { id: policyMemory.memory.id },
      data: { status: "ACTIVE", recallDisabledAt: null },
    })).rejects.toThrow();
    await prisma.representativeMemoryPolicy.update({
      where: { representativeId: policyFixture.representativeId },
      data: {
        contactMemoryEnabled: true,
        webRecallEnabled: true,
      },
    });
    await expect(prisma.governedMemory.update({
      where: { id: policyMemory.memory.id },
      data: { status: "ACTIVE", recallDisabledAt: null },
      select: { status: true },
    })).resolves.toEqual({ status: "ACTIVE" });

    const correctionFixture = await createFixture("restore-correction");
    const correctionMemory = await createApprovedContactMemory(
      correctionFixture,
      "restore-correction",
    );
    const correctionSuppressedAt = new Date();
    await prisma.governedMemory.update({
      where: { id: correctionMemory.memory.id },
      data: {
        status: "SUPPRESSED",
        recallDisabledAt: correctionSuppressedAt,
        suppressedAt: correctionSuppressedAt,
      },
    });
    const correctionSource = await createAudienceMessage(
      correctionFixture.conversationId,
      "Please remember that I now prefer detailed answers.",
    );
    const pendingCorrection = await prisma.memoryCandidate.create({
      data: {
        ...contactCandidateData(
          correctionFixture,
          correctionSource.id,
          "restore-pending-correction",
        ),
        sourceKind: "OWNER_VERIFIED_CORRECTION",
        safeText: "Preference: reply_length=detailed",
        summary: "Preference: reply_length=detailed",
        contentHash: hashOf("restore-pending-correction"),
        correctionMemoryId: correctionMemory.memory.id,
        correctionBaseVersionId: correctionMemory.version.id,
      },
    });
    await prisma.memoryReviewDecision.create({
      data: {
        representativeId: correctionFixture.representativeId,
        candidateId: pendingCorrection.id,
        memoryId: correctionMemory.memory.id,
        outcome: "CORRECTION_REQUESTED",
        reviewerRole: "OWNER",
        reviewerActorId: correctionFixture.ownerId,
        reasonCode: "owner_correction_requested",
      },
    });
    await expect(prisma.governedMemory.update({
      where: { id: correctionMemory.memory.id },
      data: { status: "ACTIVE", recallDisabledAt: null },
    })).rejects.toThrow();

    await prisma.memoryReviewDecision.create({
      data: {
        representativeId: correctionFixture.representativeId,
        candidateId: pendingCorrection.id,
        memoryId: correctionMemory.memory.id,
        outcome: "BLOCKED",
        reviewerRole: "OWNER",
        reviewerActorId: correctionFixture.ownerId,
        reasonCode: "correction_withdrawn",
      },
    });
    await prisma.memoryCandidate.update({
      where: { id: pendingCorrection.id },
      data: {
        status: "BLOCKED",
        reviewedAt: new Date(),
        safeText: null,
        summary: null,
        contentPurgedAt: new Date(),
      },
    });
    await expect(prisma.governedMemory.update({
      where: { id: correctionMemory.memory.id },
      data: { status: "ACTIVE", recallDisabledAt: null },
      select: { status: true },
    })).resolves.toEqual({ status: "ACTIVE" });
  });

  it("blocks system approval and requires independent representative-experience review", async () => {
    const fixture = await createFixture("independent-review");
    const message = await createAudienceMessage(
      fixture.conversationId,
      "Visitors respond better when the representative starts with one clear next step.",
    );
    const candidate = await prisma.memoryCandidate.create({
      data: {
        representativeId: fixture.representativeId,
        contactId: null,
        scope: "REPRESENTATIVE",
        scopeChannel: null,
        originChannel: "WEB",
        category: "REPRESENTATIVE_RESPONSE_PATTERN",
        sourceKind: "AUDIENCE_MESSAGE",
        safeText: "Start with one clear next step.",
        summary: "Lead with one next step.",
        contentHash: hashOf("deidentified-representative-experience"),
        dedupeKey: `rep-experience-${fixture.suffix}`,
        status: "PENDING_REVIEW",
        safetyClass: "REVIEW_REQUIRED",
        extractionReasonCode: "deidentified_response_pattern",
        sourceContactId: fixture.contactId,
        sourceConversationId: fixture.conversationId,
        sourceMessageId: message.id,
        deidentifiedAt: new Date(),
      },
    });
    const memory = await prisma.governedMemory.create({
      data: {
        representativeId: fixture.representativeId,
        scope: "REPRESENTATIVE",
        category: "REPRESENTATIVE_RESPONSE_PATTERN",
      },
    });
    const creatorActorId = `system:memory-extraction:${fixture.suffix}`;
    const version = await prisma.governedMemoryVersion.create({
      data: {
        memoryId: memory.id,
        representativeId: fixture.representativeId,
        scope: "REPRESENTATIVE",
        sourceCandidateId: candidate.id,
        versionNumber: 1,
        safeText: candidate.safeText,
        summary: candidate.summary,
        contentHash: candidate.contentHash!,
        deidentifiedAt: new Date(),
        deidentificationMethod: "deterministic-contact-removal-v1",
        createdByActorId: creatorActorId,
      },
    });

    await expect(prisma.memoryReviewDecision.create({
      data: {
        ...approvalDecisionData(
          fixture,
          candidate.id,
          memory.id,
          version.id,
          "system-review",
        ),
        reviewerRole: "SYSTEM",
        reviewerActorId: `system:review:${fixture.suffix}`,
      },
    })).rejects.toThrow();
    await expect(prisma.memoryReviewDecision.create({
      data: {
        ...approvalDecisionData(
          fixture,
          candidate.id,
          memory.id,
          version.id,
          "self-review",
        ),
        reviewerActorId: creatorActorId,
      },
    })).rejects.toThrow();

    await expect(prisma.memoryReviewDecision.create({
      data: approvalDecisionData(
        fixture,
        candidate.id,
        memory.id,
        version.id,
        "independent-review",
      ),
      select: { outcome: true },
    })).resolves.toEqual({ outcome: "APPROVED" });
  });

  it("terminates pending corrections before deletion proof and blocks late correction inserts", async () => {
    const fixture = await createFixture("delete-correction");
    const approved = await createApprovedContactMemory(fixture, "delete-correction");
    const suppressedAt = new Date();
    await prisma.governedMemory.update({
      where: { id: approved.memory.id },
      data: {
        status: "SUPPRESSED",
        recallDisabledAt: suppressedAt,
        suppressedAt,
      },
    });
    const correctionSource = await createAudienceMessage(
      fixture.conversationId,
      "Please remember that detailed answers are now preferred.",
    );
    const correction = await prisma.memoryCandidate.create({
      data: {
        ...contactCandidateData(
          fixture,
          correctionSource.id,
          "delete-correction-pending",
        ),
        sourceKind: "OWNER_VERIFIED_CORRECTION",
        safeText: "Preference: reply_length=detailed",
        summary: "Preference: reply_length=detailed",
        contentHash: hashOf("delete-correction-candidate"),
        correctionMemoryId: approved.memory.id,
        correctionBaseVersionId: approved.version.id,
      },
    });
    await prisma.memoryReviewDecision.create({
      data: {
        representativeId: fixture.representativeId,
        candidateId: correction.id,
        memoryId: approved.memory.id,
        outcome: "CORRECTION_REQUESTED",
        reviewerRole: "OWNER",
        reviewerActorId: fixture.ownerId,
        reasonCode: "owner_correction_requested",
      },
    });

    const forgetSource = await createAudienceMessage(
      fixture.conversationId,
      "forget my reply preference",
    );
    const result = await prisma.$transaction((tx) =>
      requestAutomaticContactReplyPreferenceDeletionInTransaction(tx, {
        representativeId: fixture.representativeId,
        contactId: fixture.contactId,
        sourceChannel: "WEB",
        sourceMessageId: forgetSource.id,
        sourceHash: hashOf(forgetSource.text ?? ""),
        occurredAt: new Date(),
      }),
    );
    expect(result).toMatchObject({
      matched: true,
      memoryId: approved.memory.id,
      replayed: false,
    });
    await expect(prisma.governedMemory.findUniqueOrThrow({
      where: { id: approved.memory.id },
      select: { status: true },
    })).resolves.toEqual({ status: "DELETE_PENDING" });
    await expect(prisma.memoryDeletionProof.findUniqueOrThrow({
      where: { memoryId: approved.memory.id },
      select: { cleanupStatus: true },
    })).resolves.toEqual({ cleanupStatus: "QUEUED" });
    await expect(prisma.memoryCandidate.findUniqueOrThrow({
      where: { id: correction.id },
      select: {
        status: true,
        safeText: true,
        summary: true,
        contentPurgedAt: true,
      },
    })).resolves.toMatchObject({
      status: "EXPIRED",
      safeText: null,
      summary: null,
      contentPurgedAt: expect.any(Date),
    });
    expect(await prisma.memoryPolicyDecision.count({
      where: { candidateId: correction.id },
    })).toBe(0);
    expect(await prisma.memoryReviewDecision.count({
      where: { candidateId: correction.id },
    })).toBe(1);

    await expect(prisma.memoryCandidate.create({
      data: {
        ...contactCandidateData(fixture, correctionSource.id, "late-correction"),
        sourceKind: "OWNER_VERIFIED_CORRECTION",
        safeText: "Preference: reply_length=detailed",
        summary: "Preference: reply_length=detailed",
        contentHash: hashOf("late-correction"),
        correctionMemoryId: approved.memory.id,
        correctionBaseVersionId: approved.version.id,
      },
    })).rejects.toThrow();
  });

  it("refuses a deletion proof while an unversioned correction remains pending", async () => {
    const fixture = await createFixture("proof-pending-correction");
    const approved = await createApprovedContactMemory(
      fixture,
      "proof-pending-correction",
    );
    const recallBlockedAt = new Date();
    await prisma.governedMemory.update({
      where: { id: approved.memory.id },
      data: {
        status: "SUPPRESSED",
        recallDisabledAt: recallBlockedAt,
        suppressedAt: recallBlockedAt,
      },
    });
    const correctionSource = await createAudienceMessage(
      fixture.conversationId,
      "Please remember that detailed answers are now preferred.",
    );
    const correction = await prisma.memoryCandidate.create({
      data: {
        ...contactCandidateData(fixture, correctionSource.id, "proof-pending"),
        sourceKind: "OWNER_VERIFIED_CORRECTION",
        safeText: "Preference: reply_length=detailed",
        summary: "Preference: reply_length=detailed",
        contentHash: hashOf("proof-pending-correction"),
        correctionMemoryId: approved.memory.id,
        correctionBaseVersionId: approved.version.id,
      },
    });
    await prisma.memoryReviewDecision.create({
      data: {
        representativeId: fixture.representativeId,
        candidateId: correction.id,
        memoryId: approved.memory.id,
        outcome: "CORRECTION_REQUESTED",
        reviewerRole: "OWNER",
        reviewerActorId: fixture.ownerId,
        reasonCode: "owner_correction_requested",
      },
    });
    await prisma.governedMemory.update({
      where: { id: approved.memory.id },
      data: { status: "DELETE_PENDING", deleteRequestedAt: new Date() },
    });
    await expect(prisma.memoryDeletionProof.create({
      data: {
        representativeId: fixture.representativeId,
        memoryId: approved.memory.id,
        requestId: `proof:${fixture.suffix}`,
        requestedByActorId: fixture.ownerId,
        reasonCode: "owner_request",
        contentHash: approved.version.contentHash,
        recallBlockedAt,
      },
    })).rejects.toThrow();
  });

  it("enforces durable cleanup leases, retries, proof completion, and terminal success", async () => {
    const fixture = await createFixture("cleanup");
    const approved = await createApprovedContactMemory(fixture, "cleanup");
    const recallBlockedAt = new Date();
    await prisma.governedMemory.update({
      where: { id: approved.memory.id },
      data: {
        status: "SUPPRESSED",
        recallDisabledAt: recallBlockedAt,
        suppressedAt: recallBlockedAt,
      },
    });
    await prisma.governedMemory.update({
      where: { id: approved.memory.id },
      data: {
        status: "DELETE_PENDING",
        deleteRequestedAt: new Date(),
      },
    });
    const proof = await prisma.memoryDeletionProof.create({
      data: {
        representativeId: fixture.representativeId,
        memoryId: approved.memory.id,
        requestId: `delete-${fixture.suffix}`,
        requestedByActorId: fixture.ownerId,
        reasonCode: "owner_request",
        contentHash: approved.version.contentHash,
        recallBlockedAt,
      },
    });
    expect(proof).toMatchObject({
      cleanupStatus: "QUEUED",
      attemptCount: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
    });

    await expect(prisma.memoryDeletionProof.update({
      where: { id: proof.id },
      data: { cleanupStatus: "FAILED", lastErrorCode: "invalid_skip" },
    })).rejects.toThrow();
    await expect(prisma.memoryDeletionProof.update({
      where: { id: proof.id },
      data: {
        cleanupStatus: "RUNNING",
        attemptCount: 0,
        leaseToken: `lease-invalid-${fixture.suffix}`,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    })).rejects.toThrow();

    await claimCleanup(proof.id, 1, `lease-1-${fixture.suffix}`);
    await prisma.memoryDeletionProof.update({
      where: { id: proof.id },
      data: {
        cleanupStatus: "RETRYING",
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: "provider_unavailable",
        availableAt: new Date(Date.now() + 1_000),
      },
    });
    await claimCleanup(proof.id, 2, `lease-2-${fixture.suffix}`);
    await prisma.memoryDeletionProof.update({
      where: { id: proof.id },
      data: {
        cleanupStatus: "FAILED",
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: "retry_exhausted",
      },
    });
    await prisma.memoryDeletionProof.update({
      where: { id: proof.id },
      data: {
        cleanupStatus: "QUEUED",
        availableAt: new Date(),
        lastErrorCode: null,
      },
    });
    await claimCleanup(proof.id, 3, `lease-3-${fixture.suffix}`);

    await prisma.memoryCandidate.update({
      where: { id: approved.candidate.id },
      data: {
        safeText: null,
        summary: null,
        contentPurgedAt: new Date(),
      },
    });
    await prisma.governedMemoryVersion.update({
      where: { id: approved.version.id },
      data: {
        safeText: null,
        summary: null,
        purgedAt: new Date(),
      },
    });
    const localPurgeCompletedAt = new Date();
    await prisma.memoryDeletionProof.update({
      where: { id: proof.id },
      data: { localPurgeCompletedAt },
    });
    const remotePurgeCompletedAt = new Date(localPurgeCompletedAt.getTime() + 1);
    await prisma.memoryDeletionProof.update({
      where: { id: proof.id },
      data: {
        remotePurgeCompletedAt,
        providerReceiptHash: hashOf(`provider-receipt-${fixture.suffix}`),
      },
    });
    const completedAt = new Date(remotePurgeCompletedAt.getTime() + 1);
    await prisma.memoryDeletionProof.update({
      where: { id: proof.id },
      data: {
        cleanupStatus: "SUCCEEDED",
        leaseToken: null,
        leaseExpiresAt: null,
        proofHash: hashOf(`proof-${fixture.suffix}`),
        completedAt,
      },
    });
    await expect(prisma.memoryDeletionProof.update({
      where: { id: proof.id },
      data: { availableAt: new Date() },
    })).rejects.toThrow();
    await expect(prisma.governedMemory.update({
      where: { id: approved.memory.id },
      data: { status: "DELETED", deletedAt: new Date() },
      select: { status: true },
    })).resolves.toEqual({ status: "DELETED" });
  });
});

async function createFixture(label: string) {
  const suffix = `${label}-${crypto.randomUUID()}`;
  const owner = await prisma.owner.create({
    data: { displayName: `Memory governance ${suffix}` },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `memory-governance-${suffix}`,
      displayName: "Memory governance representative",
      roleSummary: "Exercises T4 governed memory constraints.",
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
      namespaceKey: `memory-governance-${suffix}`,
      longTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      representativeExperienceEnabled: true,
      autoExtract: false,
      webRecallEnabled: true,
      webExtractEnabled: false,
      matrixRecallEnabled: false,
      matrixExtractEnabled: false,
      telegramRecallEnabled: false,
      telegramExtractEnabled: false,
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
  return {
    suffix,
    ownerId: owner.id,
    representativeId: representative.id,
    representativeSlug: representative.slug,
    contactId: contact.id,
    conversationId: conversation.id,
  };
}

async function createApprovedContactMemory(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  label: string,
) {
  const message = await createAudienceMessage(
    fixture.conversationId,
    `Please remember my concise-answer preference (${label}).`,
  );
  const candidate = await prisma.memoryCandidate.create({
    data: contactCandidateData(fixture, message.id, label),
  });
  const memory = await prisma.governedMemory.create({
    data: {
      representativeId: fixture.representativeId,
      contactId: fixture.contactId,
      scope: "CONTACT_CHANNEL",
      sourceChannel: "WEB",
      category: "CONTACT_PREFERENCE",
      semanticKey: "contact-preference:communication",
    },
  });
  const version = await prisma.governedMemoryVersion.create({
    data: {
      memoryId: memory.id,
      representativeId: fixture.representativeId,
      scope: "CONTACT_CHANNEL",
      sourceCandidateId: candidate.id,
      versionNumber: 1,
      safeText: candidate.safeText,
      summary: candidate.summary,
      contentHash: candidate.contentHash!,
      createdByActorId: `system:memory-extraction:${fixture.suffix}`,
    },
  });
  await prisma.memoryPolicyDecision.create({
    data: {
      representativeId: fixture.representativeId,
      candidateId: candidate.id,
      memoryId: memory.id,
      resultVersionId: version.id,
      outcome: "ACTIVATED",
      policyRevision: 0,
      policyVersion: "automatic-memory-v2",
      extractorVersion: "closed-structured-v2",
      sourceHash: hashOf(`source-${fixture.suffix}-${label}`),
      outputHash: version.contentHash,
      confidence: 1,
      reasonCode: "automatic_low_risk_activation",
      decisionHash: hashOf(`decision-${fixture.suffix}-${label}`),
    },
  });
  const approvedCandidate = await prisma.memoryCandidate.update({
    where: { id: candidate.id },
    data: { status: "APPROVED", reviewedAt: new Date() },
  });
  const activeMemory = await prisma.governedMemory.update({
    where: { id: memory.id },
    data: {
      status: "ACTIVE",
      currentVersionId: version.id,
      recallDisabledAt: null,
    },
  });
  return { message, candidate: approvedCandidate, memory: activeMemory, version };
}

function contactCandidateData(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sourceMessageId: string,
  label: string,
) {
  return {
    representativeId: fixture.representativeId,
    contactId: fixture.contactId,
    scope: "CONTACT_CHANNEL" as const,
    scopeChannel: "WEB" as const,
    originChannel: "WEB" as const,
    category: "CONTACT_PREFERENCE" as const,
    sourceKind: "AUDIENCE_MESSAGE" as const,
    safeText: "Prefers concise answers.",
    summary: "Answer concisely.",
    contentHash: hashOf("Prefers concise answers."),
    semanticKey: "contact-preference:communication",
    dedupeKey: `${label}-${fixture.suffix}`,
    status: "PENDING_REVIEW" as const,
    safetyClass: "LOW_RISK" as const,
    extractionReasonCode: "explicit_preference",
    sourceContactId: fixture.contactId,
    sourceConversationId: fixture.conversationId,
    sourceMessageId,
  };
}

function approvalDecisionData(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  candidateId: string,
  memoryId: string,
  resultVersionId: string,
  label: string,
) {
  return {
    representativeId: fixture.representativeId,
    candidateId,
    memoryId,
    resultVersionId,
    outcome: "APPROVED" as const,
    reviewerRole: "OWNER" as const,
    reviewerActorId: fixture.ownerId,
    reasonCode: label,
  };
}

async function createAudienceMessage(conversationId: string, text: string) {
  return prisma.message.create({
    data: {
      conversationId,
      senderType: "AUDIENCE",
      contentType: "TEXT",
      text,
    },
  });
}

async function claimCleanup(proofId: string, attemptCount: number, leaseToken: string) {
  return prisma.memoryDeletionProof.update({
    where: { id: proofId },
    data: {
      cleanupStatus: "RUNNING",
      attemptCount,
      leaseToken,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      lastErrorCode: null,
    },
  });
}

function hashOf(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

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

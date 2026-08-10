import { createHash, randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  contactMemorySharingConsentContractVersion,
  consumeIdentityBindingChallenge,
  createContactMemorySharingChallenge,
  createIdentityBindingChallenge,
  grantContactMemorySharingConsent,
  revokePrivateChannelIdentityBinding,
  revokeContactMemorySharingConsent,
  revokeContactMemorySharingConsentInTransaction,
} from "../src";
import {
  prepareGenerationMessageChannelDelivery,
  withGenerationMessageProviderDeliveryFence,
} from "../src/conversation-platform";
import {
  enqueueInboundMessageMemoryExtraction,
  processMemoryExtractionRun,
  processMemoryExtractionRunInTransaction,
} from "../src/memory-extraction";
import {
  activateCurrentMemoryChannelDisclosureAfterMessage,
  claimMemoryChannelDisclosureDelivery,
  completeMemoryChannelDisclosureDelivery,
  memoryChannelDisclosureContractVersion,
} from "../src/memory-disclosure";
import {
  runNextMemoryDeletionCleanup,
  runNextMemoryProjectionDeletion,
  runNextMemoryProjectionWrite,
  type MemoryProjectionProvider,
} from "../src/memory-projection-execution";
import {
  finalizeMemoryUseGenerationInTransaction,
  recordMemoryUseSearchHits,
  recordMemoryUseSearchHitsInTransaction,
  startOrReuseMemoryUseRun,
} from "../src/memory-use-execution";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("cross-channel Contact Memory consent PostgreSQL", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("serializes concurrent grants, terminally revokes, and reauthorizes with a new version", async () => {
    const suffix = randomUUID();
    const owner = await prisma.owner.create({
      data: { displayName: `Sharing owner ${suffix}` },
    });
    const representative = await prisma.representative.create({
      data: {
        ownerId: owner.id,
        slug: `sharing-${suffix}`,
        displayName: "Sharing representative",
        roleSummary: "Exercises consent concurrency.",
        tone: "clear",
        languages: ["en", "zh"],
        freeScope: [],
        paywalledIntents: [],
        handoffPrompt: "Escalate.",
        allowedSkills: [],
        actionGate: {},
      },
    });
    const identity = await prisma.audienceIdentity.create({
      data: {
        audienceKey: `sharing:${suffix}`,
        status: "REGISTERED",
      },
    });
    const webProviderSubject = `sharing-subject-${suffix}`;
    const webIssuer = "https://issuer.example.test";
    const webConnectionId = `sharing-web-session-${suffix}`;
    const webIdentityLink = await prisma.identityLink.create({
      data: {
        audienceIdentityId: identity.id,
        provider: "LOGTO",
        providerSubject: webProviderSubject,
        issuer: webIssuer,
        connectionId: webConnectionId,
        verifiedAt: new Date(),
        assuranceLevel: "PLATFORM_VERIFIED",
      },
    });
    await prisma.representativeMemoryPolicy.create({
      data: {
        representativeId: representative.id,
        namespaceKey: `sharing_${suffix.replaceAll("-", "")}`,
        longTermMemoryEnabled: true,
        contactMemoryEnabled: true,
        contactMemoryCrossChannelEnabled: true,
        autoExtract: true,
        webRecallEnabled: true,
        webExtractEnabled: true,
        retentionDays: 30,
        revision: 1,
      },
    });

    try {
      const sourceEvidence = {
        representativeSlug: representative.slug,
        audienceIdentityId: identity.id,
        sourceChannel: "WEB" as const,
        providerSubject: webProviderSubject,
        issuer: webIssuer,
        connectionId: webConnectionId,
        sourceIdentityLinkId: webIdentityLink.id,
      };
      const disclosureEventKey = `sharing-disclosure-${suffix}`;
      const confirmationEventKey = `sharing-confirm-${suffix}`;
      const firstChallenge = await createContactMemorySharingChallenge({
        ...sourceEvidence,
        disclosureContractVersion:
          contactMemorySharingConsentContractVersion,
        sourceEventKey: disclosureEventKey,
      });
      const grants = await Promise.allSettled([
        grantContactMemorySharingConsent({
          ...sourceEvidence,
          challengeToken: firstChallenge.challengeToken,
          sourceEventKey: confirmationEventKey,
        }),
        grantContactMemorySharingConsent({
          ...sourceEvidence,
          challengeToken: firstChallenge.challengeToken,
          sourceEventKey: confirmationEventKey,
        }),
      ]);
      expect(grants.filter((grant) => grant.status === "fulfilled"))
        .toHaveLength(1);
      expect(grants.filter((grant) =>
        grant.status === "rejected"
        && grant.reason?.code === "contact_memory_sharing_challenge_consumed"
      )).toHaveLength(1);
      expect(await prisma.contactMemorySharingConsent.findMany({
        where: {
          representativeId: representative.id,
          audienceIdentityId: identity.id,
        },
        select: {
          status: true,
          consentVersion: true,
          disclosureContractVersion: true,
          revokedAt: true,
        },
      })).toEqual([{
        status: "GRANTED",
        consentVersion: 1,
        disclosureContractVersion:
          contactMemorySharingConsentContractVersion,
        revokedAt: null,
      }]);

      await expect(createContactMemorySharingChallenge({
        ...sourceEvidence,
        disclosureContractVersion:
          contactMemorySharingConsentContractVersion,
        sourceEventKey: disclosureEventKey,
      })).rejects.toMatchObject({
        code: "contact_memory_sharing_conflict",
      });
      const duplicateConfirmationChallenge =
        await createContactMemorySharingChallenge({
          ...sourceEvidence,
          disclosureContractVersion:
            contactMemorySharingConsentContractVersion,
          sourceEventKey: `sharing-disclosure-duplicate-confirm-${suffix}`,
        });
      await expect(grantContactMemorySharingConsent({
        ...sourceEvidence,
        challengeToken: duplicateConfirmationChallenge.challengeToken,
        sourceEventKey: confirmationEventKey,
      })).rejects.toMatchObject({
        code: "contact_memory_sharing_conflict",
      });
      await expect(prisma.contactMemorySharingChallenge.findFirstOrThrow({
        where: {
          tokenHash: createHash("sha256")
            .update(duplicateConfirmationChallenge.challengeToken)
            .digest("hex"),
        },
        select: { consumedAt: true, revokedAt: true },
      })).resolves.toEqual({ consumedAt: null, revokedAt: null });

      const revoked = await revokeContactMemorySharingConsent({
        representativeSlug: representative.slug,
        audienceIdentityId: identity.id,
        sourceChannel: "WEB",
      });
      expect(revoked).toMatchObject({ active: false, changed: true });
      await expect(grantContactMemorySharingConsent({
        ...sourceEvidence,
        challengeToken: firstChallenge.challengeToken,
        sourceEventKey: `sharing-confirm-old-token-${suffix}`,
      })).rejects.toMatchObject({
        code: "contact_memory_sharing_challenge_consumed",
      });

      const secondChallenge = await createContactMemorySharingChallenge({
        ...sourceEvidence,
        disclosureContractVersion:
          contactMemorySharingConsentContractVersion,
        sourceEventKey: `sharing-disclosure-2-${suffix}`,
      });
      const reauthorized = await grantContactMemorySharingConsent({
        ...sourceEvidence,
        challengeToken: secondChallenge.challengeToken,
        sourceEventKey: `sharing-confirm-2-${suffix}`,
      });
      expect(reauthorized).toMatchObject({ active: true, replayed: false });
      expect(await prisma.contactMemorySharingConsent.findMany({
        where: {
          representativeId: representative.id,
          audienceIdentityId: identity.id,
        },
        orderBy: { consentVersion: "asc" },
        select: { status: true, consentVersion: true, revokedAt: true },
      })).toEqual([
        {
          status: "REVOKED",
          consentVersion: 1,
          revokedAt: expect.any(Date),
        },
        {
          status: "GRANTED",
          consentVersion: 2,
          revokedAt: null,
        },
      ]);
    } finally {
      await prisma.representative.delete({ where: { id: representative.id } });
      await prisma.audienceIdentity.delete({ where: { id: identity.id } });
      await prisma.owner.delete({ where: { id: owner.id } });
    }
  });

  it("rejects direct proof deletion and preserves replay tombstones through representative cleanup", async () => {
    const suffix = randomUUID();
    const owner = await prisma.owner.create({
      data: { displayName: `Sharing tombstone owner ${suffix}` },
    });
    const representativeId = `sharing-tombstone-rep-${suffix}`;
    const representativeSlug = `sharing-tombstone-${suffix}`;
    const representativeData = {
      id: representativeId,
      ownerId: owner.id,
      slug: representativeSlug,
      displayName: "Sharing tombstone representative",
      roleSummary: "Exercises permanent provider-event replay fences.",
      tone: "clear",
      languages: ["en", "zh"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
    };
    await prisma.representative.create({ data: representativeData });
    const identity = await prisma.audienceIdentity.create({
      data: {
        audienceKey: `sharing-tombstone:${suffix}`,
        status: "REGISTERED",
      },
    });
    const providerSubject = `sharing-tombstone-subject-${suffix}`;
    const issuer = "https://issuer.example.test";
    const connectionId = `sharing-tombstone-session-${suffix}`;
    const identityLink = await prisma.identityLink.create({
      data: {
        audienceIdentityId: identity.id,
        provider: "LOGTO",
        providerSubject,
        issuer,
        connectionId,
        verifiedAt: new Date(),
        assuranceLevel: "PLATFORM_VERIFIED",
      },
    });
    const namespaceKey = `sharing_tombstone_${suffix.replaceAll("-", "")}`;
    const sourceEvidence = {
      representativeSlug,
      audienceIdentityId: identity.id,
      sourceChannel: "WEB" as const,
      providerSubject,
      issuer,
      connectionId,
      sourceIdentityLinkId: identityLink.id,
    };
    const disclosureEventKey = `sharing-tombstone-disclosure-${suffix}`;
    const confirmationEventKey = `sharing-tombstone-confirmation-${suffix}`;
    let representativeExists = true;

    try {
      await prisma.representativeMemoryPolicy.create({
        data: {
          representativeId,
          namespaceKey,
          longTermMemoryEnabled: true,
          contactMemoryEnabled: true,
          contactMemoryCrossChannelEnabled: true,
          autoExtract: true,
          webRecallEnabled: true,
          webExtractEnabled: true,
          retentionDays: 30,
          revision: 1,
        },
      });
      const challenge = await createContactMemorySharingChallenge({
        ...sourceEvidence,
        disclosureContractVersion:
          contactMemorySharingConsentContractVersion,
        sourceEventKey: disclosureEventKey,
      });
      await grantContactMemorySharingConsent({
        ...sourceEvidence,
        challengeToken: challenge.challengeToken,
        sourceEventKey: confirmationEventKey,
      });
      const consent = await prisma.contactMemorySharingConsent.findFirstOrThrow({
        where: { representativeId, audienceIdentityId: identity.id },
        select: {
          id: true,
          challengeId: true,
          confirmationEventHash: true,
          challenge: { select: { disclosureEventHash: true } },
        },
      });
      expect(consent.challengeId).not.toBeNull();
      expect(consent.confirmationEventHash).not.toBeNull();

      await expect(prisma.contactMemorySharingConsent.delete({
        where: { id: consent.id },
      })).rejects.toThrow(/sharing consent proofs cannot be deleted directly/u);
      await expect(prisma.contactMemorySharingChallenge.delete({
        where: { id: consent.challengeId! },
      })).rejects.toThrow(/sharing challenges cannot be deleted directly/u);
      await expect(prisma.contactMemorySharingSourceEventClaim.delete({
        where: { eventHash: consent.challenge!.disclosureEventHash },
      })).rejects.toThrow(
        /contact memory sharing source-event claims cannot be deleted directly/u,
      );
      await expect(prisma.contactMemorySharingSourceEventTombstone.delete({
        where: { eventHash: consent.challenge!.disclosureEventHash },
      })).rejects.toThrow(
        /contact memory sharing replay tombstones are immutable/u,
      );

      await expect(revokeContactMemorySharingConsent({
        representativeSlug,
        audienceIdentityId: identity.id,
        sourceChannel: "WEB",
      })).resolves.toMatchObject({ active: false, changed: true });

      const eventHashes = [
        consent.challenge!.disclosureEventHash,
        consent.confirmationEventHash!,
      ];
      expect(await prisma.contactMemorySharingSourceEventTombstone.count({
        where: { eventHash: { in: eventHashes } },
      })).toBe(2);

      await prisma.representative.delete({ where: { id: representativeId } });
      representativeExists = false;
      expect(await prisma.contactMemorySharingSourceEventClaim.count({
        where: { eventHash: { in: eventHashes } },
      })).toBe(0);
      expect(await prisma.contactMemorySharingSourceEventTombstone.count({
        where: { eventHash: { in: eventHashes } },
      })).toBe(2);

      await prisma.representative.create({ data: representativeData });
      representativeExists = true;
      await prisma.representativeMemoryPolicy.create({
        data: {
          representativeId,
          namespaceKey,
          longTermMemoryEnabled: true,
          contactMemoryEnabled: true,
          contactMemoryCrossChannelEnabled: true,
          autoExtract: true,
          webRecallEnabled: true,
          webExtractEnabled: true,
          retentionDays: 30,
          revision: 1,
        },
      });
      await expect(createContactMemorySharingChallenge({
        ...sourceEvidence,
        disclosureContractVersion:
          contactMemorySharingConsentContractVersion,
        sourceEventKey: disclosureEventKey,
      })).rejects.toMatchObject({
        code: "contact_memory_sharing_conflict",
      });
    } finally {
      if (representativeExists) {
        await prisma.representative.delete({ where: { id: representativeId } });
      }
      await prisma.audienceIdentity.delete({ where: { id: identity.id } });
      await prisma.owner.delete({ where: { id: owner.id } });
    }
  });

  it("extracts, projects, recalls across channels, revokes, deletes, and reauthorizes without reviving old authority", async () => {
    const fixture = await createSharedMemoryEndToEndFixture();
    const provider = new SharedMemoryProjectionProvider();
    const preferenceText = "I prefer concise replies";

    await expect(grantSharedMemoryConsent(fixture)).resolves.toMatchObject({
      active: true,
      replayed: false,
      sourceChannel: "WEB",
    });

    const firstExtraction = await extractSharedContactMemory({
      representativeId: fixture.representativeId,
      contactId: fixture.webContactId,
      conversationId: fixture.webConversationId,
      audienceIdentityId: fixture.audienceIdentityId,
      sourceIdentityLinkId: fixture.webIdentityLinkId,
      text: preferenceText,
    });
    expect(firstExtraction.candidate).toMatchObject({
      contactId: null,
      audienceIdentityId: fixture.audienceIdentityId,
      scope: "CONTACT_SHARED",
      scopeChannel: null,
      originChannel: "WEB",
      status: "APPROVED",
      safetyClass: "LOW_RISK",
      sourceContactId: fixture.webContactId,
      sourceConversationId: fixture.webConversationId,
      deidentifiedAt: expect.any(Date),
    });
    expect(firstExtraction.candidate.safeText).not.toBe(preferenceText);
    expect(firstExtraction.version).toMatchObject({
      deidentifiedAt: expect.any(Date),
      deidentificationMethod: expect.stringMatching(/\S/u),
    });
    expect(firstExtraction.policyDecision).toMatchObject({
      outcome: "ACTIVATED",
      policyRevision: fixture.policyRevision,
      memoryId: firstExtraction.memory.id,
      resultVersionId: firstExtraction.version.id,
      outputHash: firstExtraction.version.contentHash,
    });
    expect(firstExtraction.memory).toMatchObject({
      contactId: null,
      audienceIdentityId: fixture.audienceIdentityId,
      scope: "CONTACT_SHARED",
      sourceChannel: null,
      status: "ACTIVE",
      currentVersionId: firstExtraction.version.id,
      recallDisabledAt: null,
    });
    expect(firstExtraction.projection).toMatchObject({
      lane: "RECALL",
      status: "QUEUED",
      contentHash: firstExtraction.version.contentHash,
    });
    expect(firstExtraction.projection.remoteUri).toContain(
      `/audience-identities/${fixture.audienceIdentityId}`
        + `/contact-memory/memories/${firstExtraction.memory.id}`
        + `/versions/${firstExtraction.version.id}.md`,
    );
    expect(firstExtraction.projection.remoteUri).not.toContain("/contacts/");

    await drainProjectionWrites(fixture.representativeId, provider);
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: firstExtraction.projection.id },
      select: { status: true, writeVerifiedAt: true },
    })).resolves.toEqual({
      status: "ACTIVE",
      writeVerifiedAt: expect.any(Date),
    });
    expect(provider.objects.get(firstExtraction.projection.remoteUri))
      .toBe(firstExtraction.version.contentHash);

    const firstMatrixGeneration = await createMatrixGenerationInput(fixture);
    const firstUse = await startOrReuseMemoryUseRun({
      generationRunId: firstMatrixGeneration.generationRunId,
      sourceChannel: "matrix",
    }, { client: prisma });
    const firstRecall = await recordMemoryUseSearchHits({
      useRunId: firstUse.run.id,
      hits: [{
        sourceKind: "CONTACT_MEMORY",
        projectionItemId: firstExtraction.projection.id,
        searchRank: 1,
        searchScore: 0.99,
      }],
    }, { client: prisma });
    expect(firstRecall).toMatchObject({
      anonymousRejectedCount: 0,
      run: {
        searchedCount: 1,
        scopePassedCount: 1,
        safetyPassedCount: 1,
      },
    });
    expect(firstRecall.eligibleItems).toEqual([expect.objectContaining({
      sourceKind: "CONTACT_MEMORY",
      projectionItemId: firstExtraction.projection.id,
    })]);

    const firstEligibleItemId = firstRecall.eligibleItems[0]!.memoryUseItemId;
    const revoked = await revokeContactMemorySharingConsent({
      representativeSlug: fixture.representativeSlug,
      audienceIdentityId: fixture.audienceIdentityId,
      sourceChannel: "WEB",
    });
    expect(revoked).toMatchObject({
      active: false,
      changed: true,
      matchedMemoryCount: 1,
      queuedDeletionCount: 1,
    });

    await expect(prisma.governedMemory.findUniqueOrThrow({
      where: { id: firstExtraction.memory.id },
      select: {
        status: true,
        recallDisabledAt: true,
        deleteRequestedAt: true,
      },
    })).resolves.toEqual({
      status: "DELETE_PENDING",
      recallDisabledAt: expect.any(Date),
      deleteRequestedAt: expect.any(Date),
    });
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: firstExtraction.projection.id },
      select: { status: true, deleteRequestedAt: true },
    })).resolves.toEqual({
      status: "DELETE_PENDING",
      deleteRequestedAt: expect.any(Date),
    });

    const rejectedOutputClientId = `shared-revoked-output-${randomUUID()}`;
    await expect(prisma.$transaction(async (tx) => {
      const output = await tx.message.create({
        data: {
          conversationId: fixture.matrixConversationId,
          senderType: "REPRESENTATIVE",
          text: "This output must be rolled back after revocation.",
          deliveryStatus: "ACCEPTED",
          clientMessageId: rejectedOutputClientId,
        },
      });
      await tx.generationRun.update({
        where: { id: firstMatrixGeneration.generationRunId },
        data: {
          outputMessageId: output.id,
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
      return finalizeMemoryUseGenerationInTransaction(tx, {
        useRunId: firstUse.run.id,
        outputMessageId: output.id,
        injectedItemIds: [firstEligibleItemId],
        citedItemIds: [firstEligibleItemId],
      });
    })).rejects.toMatchObject({ code: "memory_use_source_rejected" });
    await expect(prisma.message.findUnique({
      where: {
        conversationId_clientMessageId: {
          conversationId: fixture.matrixConversationId,
          clientMessageId: rejectedOutputClientId,
        },
      },
    })).resolves.toBeNull();

    const revokedMatrixGeneration = await createMatrixGenerationInput(fixture);
    const revokedUse = await startOrReuseMemoryUseRun({
      generationRunId: revokedMatrixGeneration.generationRunId,
      sourceChannel: "matrix",
    }, { client: prisma });
    await expect(recordMemoryUseSearchHits({
      useRunId: revokedUse.run.id,
      hits: [{
        sourceKind: "CONTACT_MEMORY",
        projectionItemId: firstExtraction.projection.id,
      }],
    }, { client: prisma })).resolves.toMatchObject({
      anonymousRejectedCount: 1,
      eligibleItems: [],
      run: { safetyPassedCount: 0, injectedCount: 0 },
    });

    const queuedProof = await prisma.memoryDeletionProof.findUniqueOrThrow({
      where: { memoryId: firstExtraction.memory.id },
    });
    expect(queuedProof).toMatchObject({
      requestedByActorId: expect.stringMatching(/^contact:[0-9a-f]{32}$/u),
      reasonCode: "contact_cross_channel_sharing_revoked",
      contentHash: firstExtraction.version.contentHash,
      cleanupStatus: "QUEUED",
      recallBlockedAt: expect.any(Date),
    });
    expect(Object.keys(queuedProof)).not.toEqual(expect.arrayContaining([
      "safeText",
      "summary",
      "text",
    ]));
    expect(JSON.stringify(queuedProof)).not.toContain(preferenceText);
    expect(JSON.stringify(queuedProof)).not.toContain(
      firstExtraction.version.safeText!,
    );
    expect(JSON.stringify(queuedProof)).not.toContain(fixture.audienceIdentityId);

    await expect(runNextMemoryProjectionDeletion({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    })).resolves.toMatchObject({ processed: true, status: "completed" });
    expect(provider.objects.has(firstExtraction.projection.remoteUri)).toBe(false);
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: firstExtraction.projection.id },
      select: { status: true, deletedAt: true },
    })).resolves.toEqual({
      status: "DELETED",
      deletedAt: expect.any(Date),
    });
    await expect(runNextMemoryDeletionCleanup({
      client: prisma,
      provider,
      representativeId: fixture.representativeId,
    })).resolves.toMatchObject({ processed: true, status: "completed" });
    await expect(prisma.memoryDeletionProof.findUniqueOrThrow({
      where: { memoryId: firstExtraction.memory.id },
      select: {
        cleanupStatus: true,
        localPurgeCompletedAt: true,
        remotePurgeCompletedAt: true,
        completedAt: true,
        proofHash: true,
      },
    })).resolves.toEqual({
      cleanupStatus: "SUCCEEDED",
      localPurgeCompletedAt: expect.any(Date),
      remotePurgeCompletedAt: expect.any(Date),
      completedAt: expect.any(Date),
      proofHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    await expect(prisma.governedMemoryVersion.findUniqueOrThrow({
      where: { id: firstExtraction.version.id },
      select: { safeText: true, summary: true, purgedAt: true },
    })).resolves.toEqual({
      safeText: null,
      summary: null,
      purgedAt: expect.any(Date),
    });

    await expect(grantSharedMemoryConsent(fixture)).resolves.toMatchObject({
      active: true,
      replayed: false,
    });
    await expect(prisma.contactMemorySharingConsent.findMany({
      where: {
        representativeId: fixture.representativeId,
        audienceIdentityId: fixture.audienceIdentityId,
      },
      orderBy: { consentVersion: "asc" },
      select: {
        status: true,
        consentVersion: true,
        disclosureContractVersion: true,
        revokedAt: true,
      },
    })).resolves.toEqual([
      {
        status: "REVOKED",
        consentVersion: 1,
        disclosureContractVersion:
          contactMemorySharingConsentContractVersion,
        revokedAt: expect.any(Date),
      },
      {
        status: "GRANTED",
        consentVersion: 2,
        disclosureContractVersion:
          contactMemorySharingConsentContractVersion,
        revokedAt: null,
      },
    ]);

    const secondExtraction = await extractSharedContactMemory({
      representativeId: fixture.representativeId,
      contactId: fixture.webContactId,
      conversationId: fixture.webConversationId,
      audienceIdentityId: fixture.audienceIdentityId,
      sourceIdentityLinkId: fixture.webIdentityLinkId,
      text: preferenceText,
    });
    expect(secondExtraction.memory.id).not.toBe(firstExtraction.memory.id);
    expect(secondExtraction.projection.id).not.toBe(firstExtraction.projection.id);
    await drainProjectionWrites(fixture.representativeId, provider);
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: secondExtraction.projection.id },
      select: { status: true, writeVerifiedAt: true },
    })).resolves.toEqual({
      status: "ACTIVE",
      writeVerifiedAt: expect.any(Date),
    });
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: firstExtraction.projection.id },
      select: { status: true },
    })).resolves.toEqual({ status: "DELETED" });
    expect(provider.objects.has(firstExtraction.projection.remoteUri)).toBe(false);
    expect(provider.objects.get(secondExtraction.projection.remoteUri))
      .toBe(secondExtraction.version.contentHash);

    const reauthorizedMatrixGeneration = await createMatrixGenerationInput(fixture);
    const reauthorizedUse = await startOrReuseMemoryUseRun({
      generationRunId: reauthorizedMatrixGeneration.generationRunId,
      sourceChannel: "matrix",
    }, { client: prisma });
    const reauthorizedRecall = await recordMemoryUseSearchHits({
      useRunId: reauthorizedUse.run.id,
      hits: [
        {
          sourceKind: "CONTACT_MEMORY",
          projectionItemId: firstExtraction.projection.id,
          searchRank: 1,
          searchScore: 0.99,
        },
        {
          sourceKind: "CONTACT_MEMORY",
          projectionItemId: secondExtraction.projection.id,
          searchRank: 2,
          searchScore: 0.98,
        },
      ],
    }, { client: prisma });
    expect(reauthorizedRecall).toMatchObject({
      anonymousRejectedCount: 0,
      run: {
        searchedCount: 2,
        scopePassedCount: 2,
        safetyPassedCount: 1,
      },
    });
    expect(reauthorizedRecall.eligibleItems).toEqual([expect.objectContaining({
      projectionItemId: secondExtraction.projection.id,
    })]);
    await expect(prisma.memoryUseItem.findFirstOrThrow({
      where: {
        useRunId: reauthorizedUse.run.id,
        projectionItemId: firstExtraction.projection.id,
      },
      select: { safetyPassedAt: true, rejectionReasonCode: true },
    })).resolves.toEqual({
      safetyPassedAt: null,
      rejectionReasonCode: "memory_not_recall_active",
    });
  });

  it("serializes Web finalization and revocation in both commit orders without deadlocks", async () => {
    {
      const scenario = await createActiveSharedMemoryScenario();
      const use = await createSharedMemoryUse(scenario, "web");
      const finalizationAuthorized = createDeferred<void>();
      const releaseFinalization = createDeferred<void>();
      let sequence = 0;
      let finalizationCommitOrder = 0;
      let revocationCommitOrder = 0;
      const finalization = finalizeSharedMemoryUse(use, {
        hold: async () => {
          finalizationAuthorized.resolve();
          await releaseFinalization.promise;
        },
      }).then((output) => {
        finalizationCommitOrder = ++sequence;
        return output;
      });
      await finalizationAuthorized.promise;

      const revocationBackendReady = createDeferred<number>();
      const revocation = prisma.$transaction(async (tx) => {
        const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
          "SELECT pg_backend_pid()::INTEGER AS pid",
        );
        if (!backend) throw new Error("Could not identify revocation backend.");
        revocationBackendReady.resolve(backend.pid);
        return revokeSharedMemoryConsentInTransaction(tx, scenario.fixture);
      }, { timeout: 15_000 }).then((result) => {
        revocationCommitOrder = ++sequence;
        return result;
      });
      await waitForBackendLock(await revocationBackendReady.promise);
      expect(revocationCommitOrder).toBe(0);

      releaseFinalization.resolve();
      await expect(finalization).resolves.toMatchObject({
        deliveryStatus: "QUEUED",
      });
      await expect(revocation).resolves.toMatchObject({ active: false });
      expect(finalizationCommitOrder).toBeGreaterThan(0);
      expect(revocationCommitOrder).toBeGreaterThan(finalizationCommitOrder);
    }

    {
      const scenario = await createActiveSharedMemoryScenario();
      const use = await createSharedMemoryUse(scenario, "web");
      const revocationLocked = createDeferred<void>();
      const releaseRevocation = createDeferred<void>();
      const revocation = prisma.$transaction(async (tx) => {
        const result = await revokeSharedMemoryConsentInTransaction(
          tx,
          scenario.fixture,
        );
        revocationLocked.resolve();
        await releaseRevocation.promise;
        return result;
      }, { timeout: 15_000 });
      await revocationLocked.promise;

      const finalizationBackendReady = createDeferred<number>();
      const finalization = finalizeSharedMemoryUse(use, {
        backendReady: (pid) => finalizationBackendReady.resolve(pid),
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForBackendLock(await finalizationBackendReady.promise);
      releaseRevocation.resolve();
      await expect(revocation).resolves.toMatchObject({ active: false });

      const outcome = await finalization;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Revoked Web finalization committed.");
      expectNotPostgresDeadlock(outcome.error);
      expect(outcome.error).toMatchObject({ code: "memory_use_source_rejected" });
      await expect(prisma.memoryUseRun.findUniqueOrThrow({
        where: { id: use.started.run.id },
        select: { status: true, injectedCount: true, citedCount: true },
      })).resolves.toEqual({
        status: "STARTED",
        injectedCount: 0,
        citedCount: 0,
      });
    }
  }, 30_000);

  it("serializes Web provider delivery and revocation in both commit orders without deadlocks", async () => {
    {
      const scenario = await createActiveSharedMemoryScenario();
      const use = await createSharedMemoryUse(scenario, "web");
      const delivery = await prepareSharedMemoryDelivery(use);
      const providerAuthorized = createDeferred<void>();
      const releaseProvider = createDeferred<void>();
      let providerCalled = false;
      let sequence = 0;
      let providerOrder = 0;
      let revocationCommitOrder = 0;
      const provider = prisma.$transaction((tx) =>
        withGenerationMessageProviderDeliveryFence(
          tx,
          delivery.fenceInput,
          async () => {
            providerAuthorized.resolve();
            await releaseProvider.promise;
            providerCalled = true;
            providerOrder = ++sequence;
            return "web-provider-message";
          },
        ),
      { timeout: 15_000 });
      await providerAuthorized.promise;

      const revocationBackendReady = createDeferred<number>();
      const revocation = prisma.$transaction(async (tx) => {
        const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
          "SELECT pg_backend_pid()::INTEGER AS pid",
        );
        if (!backend) throw new Error("Could not identify revocation backend.");
        revocationBackendReady.resolve(backend.pid);
        return revokeSharedMemoryConsentInTransaction(tx, scenario.fixture);
      }, { timeout: 15_000 }).then((result) => {
        revocationCommitOrder = ++sequence;
        return result;
      });
      await waitForBackendLock(await revocationBackendReady.promise);
      expect(providerCalled).toBe(false);

      releaseProvider.resolve();
      await expect(provider).resolves.toEqual({
        executed: true,
        value: "web-provider-message",
      });
      await expect(revocation).resolves.toMatchObject({ active: false });
      expect(providerCalled).toBe(true);
      expect(providerOrder).toBeGreaterThan(0);
      expect(revocationCommitOrder).toBeGreaterThan(providerOrder);
    }

    {
      const scenario = await createActiveSharedMemoryScenario();
      const use = await createSharedMemoryUse(scenario, "web");
      const delivery = await prepareSharedMemoryDelivery(use);
      const revocationLocked = createDeferred<void>();
      const releaseRevocation = createDeferred<void>();
      const revocation = prisma.$transaction(async (tx) => {
        const result = await revokeSharedMemoryConsentInTransaction(
          tx,
          scenario.fixture,
        );
        revocationLocked.resolve();
        await releaseRevocation.promise;
        return result;
      }, { timeout: 15_000 });
      await revocationLocked.promise;

      let providerCalled = false;
      const providerBackendReady = createDeferred<number>();
      const provider = prisma.$transaction(async (tx) => {
        const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
          "SELECT pg_backend_pid()::INTEGER AS pid",
        );
        if (!backend) throw new Error("Could not identify provider backend.");
        providerBackendReady.resolve(backend.pid);
        return withGenerationMessageProviderDeliveryFence(
          tx,
          delivery.fenceInput,
          async () => {
            providerCalled = true;
            return "must-not-send";
          },
        );
      }, { timeout: 15_000 }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForBackendLock(await providerBackendReady.promise);
      releaseRevocation.resolve();
      await expect(revocation).resolves.toMatchObject({ active: false });

      const outcome = await provider;
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        expectNotPostgresDeadlock(outcome.error);
        throw outcome.error;
      }
      expect(outcome.value).toEqual({
        executed: false,
        reason: "memory_delivery_source_revoked",
      });
      expect(providerCalled).toBe(false);
    }
  }, 30_000);

  it("serializes Matrix and Telegram provider side effects ahead of revocation without deadlocks", async () => {
    for (const target of ["matrix", "telegram-a"] as const) {
      const scenario = await createActiveSharedMemoryScenario();
      const use = await createSharedMemoryUse(scenario, target);
      const delivery = await prepareSharedMemoryDelivery(use);
      const providerAuthorized = createDeferred<void>();
      const releaseProvider = createDeferred<void>();
      let providerCalled = false;
      const provider = prisma.$transaction((tx) =>
        withGenerationMessageProviderDeliveryFence(
          tx,
          delivery.fenceInput,
          async () => {
            providerAuthorized.resolve();
            await releaseProvider.promise;
            providerCalled = true;
            return `${target}-provider-message`;
          },
        ),
      { timeout: 15_000 });
      await providerAuthorized.promise;

      const revocationBackendReady = createDeferred<number>();
      const revocation = prisma.$transaction(async (tx) => {
        const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
          "SELECT pg_backend_pid()::INTEGER AS pid",
        );
        if (!backend) throw new Error("Could not identify revocation backend.");
        revocationBackendReady.resolve(backend.pid);
        return revokeSharedMemoryConsentInTransaction(tx, scenario.fixture);
      }, { timeout: 15_000 });
      await waitForBackendLock(await revocationBackendReady.promise);
      expect(providerCalled).toBe(false);

      releaseProvider.resolve();
      await expect(provider).resolves.toEqual({
        executed: true,
        value: `${target}-provider-message`,
      });
      await expect(revocation).resolves.toMatchObject({ active: false });
      expect(providerCalled).toBe(true);
    }
  }, 30_000);

  it("revokes only Telegram account B while A keeps shared extraction, recall, finalization, and delivery", async () => {
    const scenario = await createActiveSharedMemoryScenario();
    const fixture = scenario.fixture;

    const bPendingUse = await createSharedMemoryUse(scenario, "telegram-b");
    const bDeliveryUse = await createSharedMemoryUse(scenario, "telegram-b");
    const bDelivery = await prepareSharedMemoryDelivery(bDeliveryUse);
    const bSearchGeneration = await createTelegramGenerationInput(fixture, "B");
    const bExtraction = await enqueueTelegramMemoryExtraction(
      fixture,
      "B",
      "I prefer concise replies",
    );

    await expect(revokePrivateChannelIdentityBinding({
      audienceIdentityId: fixture.audienceIdentityId,
      provider: "TELEGRAM",
      providerSubject: fixture.telegramProviderSubjectB,
      issuer: "delegate-managed-bot",
      connectionId: fixture.telegramConnectionId,
    })).resolves.toMatchObject({ changed: true });
    await expect(Promise.all([
      prisma.identityLink.findUniqueOrThrow({
        where: { id: fixture.telegramIdentityLinkAId },
        select: { revokedAt: true },
      }),
      prisma.identityLinkConnectionProof.findUniqueOrThrow({
        where: { id: fixture.telegramProofAId },
        select: { revokedAt: true },
      }),
      prisma.identityLink.findUniqueOrThrow({
        where: { id: fixture.telegramIdentityLinkBId },
        select: { revokedAt: true },
      }),
      prisma.identityLinkConnectionProof.findUniqueOrThrow({
        where: { id: fixture.telegramProofBId },
        select: { revokedAt: true },
      }),
    ])).resolves.toEqual([
      { revokedAt: null },
      { revokedAt: null },
      { revokedAt: expect.any(Date) },
      { revokedAt: expect.any(Date) },
    ]);

    const bSearchUse = await startOrReuseMemoryUseRun({
      generationRunId: bSearchGeneration.generationRunId,
      sourceChannel: "telegram",
    }, { client: prisma });
    const bSearch = await recordMemoryUseSearchHits({
      useRunId: bSearchUse.run.id,
      hits: [{
        sourceKind: "CONTACT_MEMORY",
        projectionItemId: scenario.extraction.projection.id,
      }],
    }, { client: prisma });
    expect(bSearch.eligibleItems).toEqual([]);
    expect(bSearch).toMatchObject({
      anonymousRejectedCount: 1,
      run: { safetyPassedCount: 0 },
    });

    const bFinalization = await finalizeSharedMemoryUse(bPendingUse).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    expect(bFinalization.ok).toBe(false);
    if (bFinalization.ok) {
      throw new Error("Telegram account B finalized after unlink.");
    }
    expectNotPostgresDeadlock(bFinalization.error);
    expect(bFinalization.error).toMatchObject({
      code: "memory_use_source_rejected",
    });

    let bProviderCalled = false;
    await expect(prisma.$transaction((tx) =>
      withGenerationMessageProviderDeliveryFence(
        tx,
        bDelivery.fenceInput,
        async () => {
          bProviderCalled = true;
          return "must-not-send";
        },
      )
    )).resolves.toEqual({
      executed: false,
      reason: "memory_delivery_source_revoked",
    });
    expect(bProviderCalled).toBe(false);

    await expect(processMemoryExtractionRunEventually(bExtraction.runId))
      .resolves.toMatchObject({
        processed: true,
        status: "completed",
      });
    await expect(prisma.memoryExtractionRun.findUniqueOrThrow({
      where: { id: bExtraction.runId },
      select: {
        status: true,
        candidateCount: true,
        acceptedCount: true,
        rejectedCount: true,
        quarantinedCount: true,
      },
    })).resolves.toEqual({
      status: "SUCCEEDED",
      candidateCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      quarantinedCount: 0,
    });
    await expect(prisma.memoryCandidate.count({
      where: {
        sourceMessageId: bExtraction.messageId,
        scope: "CONTACT_SHARED",
      },
    })).resolves.toBe(0);
    await expect(prisma.memoryCandidate.count({
      where: {
        sourceMessageId: bExtraction.messageId,
        scope: "CONTACT_CHANNEL",
      },
    })).resolves.toBe(1);

    const aUse = await createSharedMemoryUse(scenario, "telegram-a");
    const aDelivery = await prepareSharedMemoryDelivery(aUse);
    let aProviderCalled = false;
    await expect(prisma.$transaction((tx) =>
      withGenerationMessageProviderDeliveryFence(
        tx,
        aDelivery.fenceInput,
        async () => {
          aProviderCalled = true;
          return "telegram-a-provider-message";
        },
      )
    )).resolves.toEqual({
      executed: true,
      value: "telegram-a-provider-message",
    });
    expect(aProviderCalled).toBe(true);

    const aExtraction = await enqueueTelegramMemoryExtraction(
      fixture,
      "A",
      "I prefer concise replies",
    );
    await expect(processMemoryExtractionRunEventually(aExtraction.runId))
      .resolves.toMatchObject({
        processed: true,
        status: "completed",
      });
    await expect(prisma.memoryExtractionRun.findUniqueOrThrow({
      where: { id: aExtraction.runId },
      select: {
        status: true,
        candidateCount: true,
        acceptedCount: true,
        rejectedCount: true,
        quarantinedCount: true,
      },
    })).resolves.toEqual({
      status: "SUCCEEDED",
      candidateCount: 2,
      acceptedCount: 2,
      rejectedCount: 0,
      quarantinedCount: 0,
    });
    await expect(prisma.memoryCandidate.findFirstOrThrow({
      where: {
        sourceMessageId: aExtraction.messageId,
        scope: "CONTACT_SHARED",
      },
      select: {
        audienceIdentityId: true,
        sourceContactId: true,
        originChannel: true,
        deidentifiedAt: true,
      },
    })).resolves.toEqual({
      audienceIdentityId: fixture.audienceIdentityId,
      sourceContactId: fixture.telegramContactAId,
      originChannel: "TELEGRAM",
      deidentifiedAt: expect.any(Date),
    });
    await expect(prisma.contactMemorySharingConsent.findFirstOrThrow({
      where: {
        representativeId: fixture.representativeId,
        audienceIdentityId: fixture.audienceIdentityId,
      },
      orderBy: { consentVersion: "desc" },
      select: { status: true, revokedAt: true },
    })).resolves.toEqual({ status: "GRANTED", revokedAt: null });
  }, 30_000);

  it("blocks exact Matrix and Telegram shared-memory work when unlink or replacement wins", async () => {
    for (const target of exactIdentityMutationTargets) {
      const scenario = await createActiveSharedMemoryScenario();
      const mutation = await prepareExactIdentityMutation(scenario.fixture, target);
      const extraction = await enqueueExactPrivateChannelMemoryExtraction(
        scenario.fixture,
        target,
        "I prefer concise replies",
      );
      const searchGeneration = await createExactPrivateChannelGenerationInput(
        scenario.fixture,
        target,
      );
      const searchUse = await startOrReuseMemoryUseRun({
        generationRunId: searchGeneration.generationRunId,
        sourceChannel: target.startsWith("matrix") ? "matrix" : "telegram",
      }, { client: prisma });
      const finalUse = await createSharedMemoryUse(
        scenario,
        exactMutationUseTarget(target),
      );
      const deliveryUse = await createSharedMemoryUse(
        scenario,
        exactMutationUseTarget(target),
      );
      const delivery = await prepareSharedMemoryDelivery(deliveryUse);

      const mutationAuthorized = createDeferred<void>();
      const releaseMutation = createDeferred<void>();
      const mutationPromise = runExactIdentityMutation(mutation, {
        afterMutation: () => mutationAuthorized.resolve(),
        hold: () => releaseMutation.promise,
      });
      await mutationAuthorized.promise;

      const extractionBackend = createDeferred<number>();
      const extractionPromise = prisma.$transaction(async (tx) => {
        extractionBackend.resolve(await currentBackendPid(tx));
        return processMemoryExtractionRunInTransaction(tx, {
          runId: extraction.runId,
        });
      }, { timeout: 20_000 }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      const searchBackend = createDeferred<number>();
      const searchPromise = prisma.$transaction(async (tx) => {
        searchBackend.resolve(await currentBackendPid(tx));
        return recordMemoryUseSearchHitsInTransaction(tx, {
          useRunId: searchUse.run.id,
          hits: [{
            sourceKind: "CONTACT_MEMORY",
            projectionItemId: scenario.extraction.projection.id,
            searchRank: 1,
            searchScore: 0.99,
          }],
        });
      }, { timeout: 20_000 }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      const finalBackend = createDeferred<number>();
      const finalPromise = finalizeSharedMemoryUse(finalUse, {
        backendReady: (pid) => finalBackend.resolve(pid),
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      let providerCalled = false;
      const providerBackend = createDeferred<number>();
      const providerPromise = prisma.$transaction(async (tx) => {
        providerBackend.resolve(await currentBackendPid(tx));
        return withGenerationMessageProviderDeliveryFence(
          tx,
          delivery.fenceInput,
          async () => {
            providerCalled = true;
            return `${target}-must-not-send`;
          },
        );
      }, { timeout: 20_000 }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      await Promise.all([
        extractionBackend.promise.then(waitForBackendLock),
        searchBackend.promise.then(waitForBackendLock),
        finalBackend.promise.then(waitForBackendLock),
        providerBackend.promise.then(waitForBackendLock),
      ]);
      releaseMutation.resolve();
      await expect(mutationPromise).resolves.toMatchObject({ changed: true });

      const [extractionOutcome, searchOutcome, finalOutcome, providerOutcome] =
        await Promise.all([
          extractionPromise,
          searchPromise,
          finalPromise,
          providerPromise,
        ]);
      for (const outcome of [
        extractionOutcome,
        searchOutcome,
        finalOutcome,
        providerOutcome,
      ]) {
        if (!outcome.ok) expectNotPostgresDeadlock(outcome.error);
      }

      expect(extractionOutcome.ok).toBe(true);
      if (!extractionOutcome.ok) throw extractionOutcome.error;
      expect(extractionOutcome.value).toMatchObject({
        processed: true,
        status: "SUCCEEDED",
      });
      await expect(prisma.memoryCandidate.count({
        where: {
          sourceMessageId: extraction.messageId,
          scope: "CONTACT_SHARED",
        },
      })).resolves.toBe(0);
      await expect(prisma.memoryCandidate.count({
        where: {
          sourceMessageId: extraction.messageId,
          scope: "CONTACT_CHANNEL",
        },
      })).resolves.toBe(1);

      expect(searchOutcome.ok).toBe(true);
      if (!searchOutcome.ok) throw searchOutcome.error;
      expect(searchOutcome.value).toMatchObject({
        anonymousRejectedCount: 1,
        eligibleItems: [],
        run: { safetyPassedCount: 0, injectedCount: 0 },
      });

      expect(finalOutcome.ok).toBe(false);
      if (finalOutcome.ok) {
        throw new Error(`${target} finalization survived exact identity loss.`);
      }
      expect(finalOutcome.error).toMatchObject({
        code: "memory_use_source_rejected",
      });
      await expect(prisma.memoryUseRun.findUniqueOrThrow({
        where: { id: finalUse.started.run.id },
        select: { status: true, injectedCount: true, citedCount: true },
      })).resolves.toEqual({
        status: "STARTED",
        injectedCount: 0,
        citedCount: 0,
      });

      expect(providerOutcome.ok).toBe(true);
      if (!providerOutcome.ok) throw providerOutcome.error;
      expect(providerOutcome.value).toEqual({
        executed: false,
        reason: "memory_delivery_source_revoked",
      });
      expect(providerCalled).toBe(false);

      await expectExactMutationLeavesAlternativeBindingActive(
        scenario.fixture,
        mutation,
      );
    }
  }, 120_000);

  it("makes exact Matrix and Telegram unlink or replacement wait for completed shared-memory send work", async () => {
    for (const target of exactIdentityMutationTargets) {
      const scenario = await createActiveSharedMemoryScenario();
      const mutation = await prepareExactIdentityMutation(scenario.fixture, target);
      const extraction = await enqueueExactPrivateChannelMemoryExtraction(
        scenario.fixture,
        target,
        "I prefer concise replies",
      );
      const searchGeneration = await createExactPrivateChannelGenerationInput(
        scenario.fixture,
        target,
      );
      const searchUse = await startOrReuseMemoryUseRun({
        generationRunId: searchGeneration.generationRunId,
        sourceChannel: target.startsWith("matrix") ? "matrix" : "telegram",
      }, { client: prisma });
      const finalUse = await createSharedMemoryUse(
        scenario,
        exactMutationUseTarget(target),
      );
      const deliveryUse = await createSharedMemoryUse(
        scenario,
        exactMutationUseTarget(target),
      );
      const delivery = await prepareSharedMemoryDelivery(deliveryUse);

      const operationsCommitted = createDeferred<void>();
      const releaseOperations = createDeferred<void>();
      let providerCalled = false;
      let operationsCommitOrder = 0;
      let mutationCommitOrder = 0;
      let sequence = 0;
      const operations = prisma.$transaction(async (tx) => {
        const extractionResult = await processMemoryExtractionRunInTransaction(
          tx,
          { runId: extraction.runId },
        );
        const searchResult = await recordMemoryUseSearchHitsInTransaction(tx, {
          useRunId: searchUse.run.id,
          hits: [{
            sourceKind: "CONTACT_MEMORY",
            projectionItemId: scenario.extraction.projection.id,
            searchRank: 1,
            searchScore: 0.99,
          }],
        });
        const finalResult = await finalizeSharedMemoryUseInTransaction(
          tx,
          finalUse,
        );
        const providerResult = await withGenerationMessageProviderDeliveryFence(
          tx,
          delivery.fenceInput,
          async () => {
            providerCalled = true;
            return `${target}-provider-message`;
          },
        );
        operationsCommitted.resolve();
        await releaseOperations.promise;
        return { extractionResult, searchResult, finalResult, providerResult };
      }, { timeout: 20_000 }).then((value) => {
        operationsCommitOrder = ++sequence;
        return value;
      });
      await operationsCommitted.promise;

      const mutationBackend = createDeferred<number>();
      const mutationPromise = runExactIdentityMutation(mutation, {
        backendReady: (pid) => mutationBackend.resolve(pid),
      }).then((value) => {
        mutationCommitOrder = ++sequence;
        return value;
      });
      await waitForBackendLock(await mutationBackend.promise);
      expect(mutationCommitOrder).toBe(0);

      releaseOperations.resolve();
      const operationResults = await operations;
      await expect(mutationPromise).resolves.toMatchObject({ changed: true });
      expect(operationsCommitOrder).toBeGreaterThan(0);
      expect(mutationCommitOrder).toBeGreaterThan(operationsCommitOrder);
      expect(operationResults.extractionResult).toMatchObject({
        processed: true,
        status: "SUCCEEDED",
      });
      expect(operationResults.searchResult.eligibleItems).toHaveLength(1);
      expect(operationResults.finalResult).toMatchObject({
        deliveryStatus: "QUEUED",
      });
      expect(operationResults.providerResult).toEqual({
        executed: true,
        value: `${target}-provider-message`,
      });
      expect(providerCalled).toBe(true);
      await expect(prisma.memoryCandidate.count({
        where: {
          sourceMessageId: extraction.messageId,
          scope: "CONTACT_SHARED",
        },
      })).resolves.toBe(1);

      await expectExactMutationLeavesAlternativeBindingActive(
        scenario.fixture,
        mutation,
      );
    }
  }, 120_000);

  it("permits citation retention cleanup after consent withdrawal but rejects new use authority", async () => {
    const scenario = await createActiveSharedMemoryScenario();
    const finalizedUse = await createSharedMemoryUse(scenario, "matrix");
    const output = await finalizeSharedMemoryUse(finalizedUse);
    const pendingUse = await createSharedMemoryUse(scenario, "matrix");
    const finalizedItemId =
      finalizedUse.recorded.eligibleItems[0]!.memoryUseItemId;
    const pendingItemId = pendingUse.recorded.eligibleItems[0]!.memoryUseItemId;
    const before = await prisma.memoryUseItem.findUniqueOrThrow({
      where: { id: finalizedItemId },
      select: {
        citationId: true,
        citationPurgedAt: true,
        injectedAt: true,
        citedAt: true,
      },
    });
    expect(before).toMatchObject({
      citationId: expect.any(String),
      citationPurgedAt: null,
      injectedAt: expect.any(Date),
      citedAt: expect.any(Date),
    });

    await expect(revokeContactMemorySharingConsent({
      representativeSlug: scenario.fixture.representativeSlug,
      audienceIdentityId: scenario.fixture.audienceIdentityId,
      sourceChannel: "WEB",
    })).resolves.toMatchObject({ active: false, changed: true });

    // Citation retention cleanup is driven by the parent Message deletion.
    // It may remove presentation metadata, but must not change prior use facts.
    await expect(prisma.message.delete({
      where: { id: output.id },
    })).resolves.toMatchObject({ id: output.id });
    await expect(prisma.memoryUseItem.findUniqueOrThrow({
      where: { id: finalizedItemId },
      select: {
        citationId: true,
        citationPurgedAt: true,
        injectedAt: true,
        citedAt: true,
      },
    })).resolves.toEqual({
      citationId: null,
      citationPurgedAt: expect.any(Date),
      injectedAt: before.injectedAt,
      citedAt: before.citedAt,
    });

    const advancement = await prisma.memoryUseItem.update({
      where: { id: pendingItemId },
      data: { injectedAt: new Date() },
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    expect(advancement.ok).toBe(false);
    if (advancement.ok) {
      throw new Error("Revoked shared memory gained new injection authority.");
    }
    expectNotPostgresDeadlock(advancement.error);
    expect(String(advancement.error)).toMatch(
      /shared contact memory (?:lacks current policy-bound consent|use requires current one-shot challenge authority)/u,
    );
  }, 30_000);

  it("enforces global source-event roles, chronological authority, and deployed disclosure v2", async () => {
    const fixture = await createSharedMemoryEndToEndFixture();
    const sourceEvidence = {
      representativeSlug: fixture.representativeSlug,
      audienceIdentityId: fixture.audienceIdentityId,
      sourceChannel: "WEB" as const,
      providerSubject: fixture.webProviderSubject,
      issuer: fixture.webIssuer,
      connectionId: fixture.webConnectionId,
      sourceIdentityLinkId: fixture.webIdentityLinkId,
    };
    const disclosureEvent = `cross-role-disclosure-${randomUUID()}`;
    await createContactMemorySharingChallenge({
      ...sourceEvidence,
      disclosureContractVersion: contactMemorySharingConsentContractVersion,
      sourceEventKey: disclosureEvent,
    });
    const currentChallenge = await createContactMemorySharingChallenge({
      ...sourceEvidence,
      disclosureContractVersion: contactMemorySharingConsentContractVersion,
      sourceEventKey: `cross-role-current-${randomUUID()}`,
    });
    await expect(grantContactMemorySharingConsent({
      ...sourceEvidence,
      challengeToken: currentChallenge.challengeToken,
      sourceEventKey: disclosureEvent,
    })).rejects.toMatchObject({ code: "contact_memory_sharing_conflict" });
    await expect(prisma.contactMemorySharingChallenge.findFirstOrThrow({
      where: {
        tokenHash: createHash("sha256")
          .update(currentChallenge.challengeToken)
          .digest("hex"),
      },
      select: { consumedAt: true },
    })).resolves.toEqual({ consumedAt: null });

    await expect(grantContactMemorySharingConsent({
      ...sourceEvidence,
      challengeToken: currentChallenge.challengeToken,
      sourceEventKey: `cross-role-confirm-${randomUUID()}`,
    })).resolves.toMatchObject({ active: true });

    const challengeCreatedAt = new Date(Date.now() + 60_000);
    const chronologicalChallenge = await createContactMemorySharingChallenge({
      ...sourceEvidence,
      disclosureContractVersion: contactMemorySharingConsentContractVersion,
      sourceEventKey: `chronological-disclosure-${randomUUID()}`,
    }, { now: () => challengeCreatedAt });
    const reversedChronology = await grantContactMemorySharingConsent({
      ...sourceEvidence,
      challengeToken: chronologicalChallenge.challengeToken,
      sourceEventKey: `chronological-confirm-invalid-${randomUUID()}`,
    }, {
      now: () => new Date(challengeCreatedAt.getTime() - 1),
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    expect(reversedChronology.ok).toBe(false);
    if (reversedChronology.ok) {
      throw new Error("A sharing challenge was consumed before creation.");
    }
    expectNotPostgresDeadlock(reversedChronology.error);
    expect(String(reversedChronology.error)).toContain(
      "ContactMemorySharingChallenge_lifecycle_check",
    );
    await expect(prisma.contactMemorySharingChallenge.findFirstOrThrow({
      where: {
        tokenHash: createHash("sha256")
          .update(chronologicalChallenge.challengeToken)
          .digest("hex"),
      },
      select: { consumedAt: true },
    })).resolves.toEqual({ consumedAt: null });

    await expect(grantContactMemorySharingConsent({
      ...sourceEvidence,
      challengeToken: chronologicalChallenge.challengeToken,
      sourceEventKey: `chronological-confirm-valid-${randomUUID()}`,
    }, {
      now: () => new Date(challengeCreatedAt.getTime() + 1),
    })).resolves.toMatchObject({ active: true });

    const [deployedFunction] = await prisma.$queryRawUnsafe<Array<{
      definition: string;
    }>>(`
      SELECT pg_get_functiondef(
        '"memory_projection_policy_reenable_allowed"("MemoryProjectionItem","MemoryProjectionItem")'::regprocedure
      ) AS definition
    `);
    expect(deployedFunction?.definition).toContain(
      memoryChannelDisclosureContractVersion,
    );
    expect(deployedFunction?.definition).not.toContain(
      "private-channel-memory-v1",
    );
  }, 30_000);

  });

type SharedMemoryEndToEndFixture = Awaited<
  ReturnType<typeof createSharedMemoryEndToEndFixture>
>;

const exactIdentityMutationTargets = [
  "matrix-unlink",
  "matrix-replacement",
  "telegram-unlink",
] as const;

type ExactIdentityMutationTarget =
  typeof exactIdentityMutationTargets[number];

type PreparedExactIdentityMutation = {
  fixture: SharedMemoryEndToEndFixture;
  target: ExactIdentityMutationTarget;
  alternativeMatrixProofId?: string;
  replacementMatrixProviderSubject?: string;
  replacementMatrixIssuer?: string;
  replacementChallengeToken?: string;
};

async function createSharedMemoryEndToEndFixture() {
  const suffix = randomUUID();
  const connectionId = `shared-memory-matrix-${suffix}`;
  const matrixIssuer = "example.test";
  const matrixProviderSubject = `@shared-memory-${suffix}:example.test`;
  const webProviderSubject = `shared-memory-logto-${suffix}`;
  const webIssuer = "https://auth.example.test";
  const webConnectionId = `shared-memory-web-session-${suffix}`;
  const telegramConnectionId = `shared-memory-telegram-${suffix}`;
  const telegramIssuer = "delegate-managed-bot";
  const telegramSubjectSeed = Number.parseInt(
    suffix.replaceAll("-", "").slice(0, 12),
    16,
  ) * 2;
  const telegramProviderSubjectA = String(telegramSubjectSeed);
  const telegramProviderSubjectB = String(telegramSubjectSeed + 1);
  const owner = await prisma.owner.create({
    data: { displayName: `Shared memory E2E owner ${suffix}` },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `shared-memory-e2e-${suffix}`,
      displayName: "Shared memory E2E representative",
      roleSummary: "Exercises the shared Contact Memory lifecycle.",
      tone: "clear",
      languages: ["en", "zh"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
    },
  });
  const representativeVersion = await prisma.representativeVersion.create({
    data: {
      representativeId: representative.id,
      versionNumber: 1,
      status: "PUBLISHED",
      snapshot: { knowledgeAssets: [] },
    },
  });
  await prisma.representative.update({
    where: { id: representative.id },
    data: { activeVersionId: representativeVersion.id },
  });
  const audienceIdentity = await prisma.audienceIdentity.create({
    data: {
      audienceKey: `shared-memory-e2e:${suffix}`,
      status: "REGISTERED",
    },
  });
  const webIdentityLink = await prisma.identityLink.create({
    data: {
      audienceIdentityId: audienceIdentity.id,
      provider: "LOGTO",
      providerSubject: webProviderSubject,
      issuer: webIssuer,
      connectionId: webConnectionId,
      verifiedAt: new Date(),
      assuranceLevel: "PLATFORM_VERIFIED",
    },
  });
  const matrixIdentityLink = await prisma.identityLink.create({
    data: {
      audienceIdentityId: audienceIdentity.id,
      provider: "MATRIX",
      providerSubject: matrixProviderSubject,
      issuer: matrixIssuer,
      connectionId,
      verifiedAt: new Date(),
      assuranceLevel: "PLATFORM_VERIFIED",
    },
  });
  const matrixIdentityProof = await prisma.identityLinkConnectionProof.create({
    data: {
      identityLinkId: matrixIdentityLink.id,
      issuer: matrixIssuer,
      connectionId,
      verifiedAt: new Date(),
      assuranceLevel: "PLATFORM_VERIFIED",
    },
  });
  const [telegramIdentityLinkA, telegramIdentityLinkB] = await Promise.all([
    prisma.identityLink.create({
      data: {
        audienceIdentityId: audienceIdentity.id,
        provider: "TELEGRAM",
        providerSubject: telegramProviderSubjectA,
        issuer: telegramIssuer,
        verifiedAt: new Date(),
        assuranceLevel: "PLATFORM_VERIFIED",
      },
    }),
    prisma.identityLink.create({
      data: {
        audienceIdentityId: audienceIdentity.id,
        provider: "TELEGRAM",
        providerSubject: telegramProviderSubjectB,
        issuer: telegramIssuer,
        verifiedAt: new Date(),
        assuranceLevel: "PLATFORM_VERIFIED",
      },
    }),
  ]);
  const [telegramProofA, telegramProofB] = await Promise.all([
    prisma.identityLinkConnectionProof.create({
      data: {
        identityLinkId: telegramIdentityLinkA.id,
        issuer: telegramIssuer,
        connectionId: telegramConnectionId,
        verifiedAt: new Date(),
        assuranceLevel: "PLATFORM_VERIFIED",
      },
    }),
    prisma.identityLinkConnectionProof.create({
      data: {
        identityLinkId: telegramIdentityLinkB.id,
        issuer: telegramIssuer,
        connectionId: telegramConnectionId,
        verifiedAt: new Date(),
        assuranceLevel: "PLATFORM_VERIFIED",
      },
    }),
  ]);
  const policyRevision = 1;
  await prisma.representativeMemoryPolicy.create({
    data: {
      representativeId: representative.id,
      namespaceKey: `shared_memory_e2e_${suffix.replaceAll("-", "")}`,
      longTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      contactMemoryCrossChannelEnabled: true,
      representativeExperienceEnabled: false,
      autoExtract: true,
      webRecallEnabled: true,
      webExtractEnabled: true,
      matrixRecallEnabled: true,
      matrixExtractEnabled: true,
      telegramRecallEnabled: true,
      telegramExtractEnabled: true,
      retentionDays: 30,
      revision: policyRevision,
      provider: "openviking",
    },
  });

  const webContact = await prisma.contact.create({
    data: {
      representativeId: representative.id,
      audienceIdentityId: audienceIdentity.id,
      sourceChannel: "WEB",
    },
  });
  const webConversation = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: webContact.id,
      audienceIdentityId: audienceIdentity.id,
      channel: "PRIVATE_CHAT",
      sourceChannel: "WEB",
    },
  });

  const representativeBinding = await prisma.representativeChannelBinding.create({
    data: {
      representativeId: representative.id,
      kind: "MATRIX",
      transport: "MATRIX",
      sourceProvider: "MATRIX",
      connectionId,
      endpointAssignmentRevision: 1,
      endpointLifecycleRevision: 1,
      desiredState: "ACTIVE",
      healthStatus: "HEALTHY",
      status: "CONNECTED",
    },
  });
  const matrixContact = await prisma.contact.create({
    data: {
      representativeId: representative.id,
      audienceIdentityId: audienceIdentity.id,
      channelUserId: matrixIdentityLink.providerSubject,
      sourceChannel: "MATRIX",
    },
  });
  const matrixConversation = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: matrixContact.id,
      audienceIdentityId: audienceIdentity.id,
      channel: "PRIVATE_CHAT",
      sourceChannel: "matrix",
    },
  });
  const matrixChannelBinding = await prisma.conversationChannelBinding.create({
    data: {
      conversationId: matrixConversation.id,
      representativeBindingId: representativeBinding.id,
      representativeAssignmentRevision: 1,
      kind: "MATRIX",
      transport: "MATRIX",
      sourceProvider: "MATRIX",
      interactionMode: "PRIVATE_CHAT",
      connectionId,
      externalConversationId: `!shared-memory-${suffix}:example.test`,
    },
  });
  const matrixEpisode = await prisma.conversationEpisode.create({
    data: {
      conversationId: matrixConversation.id,
      representativeVersionId: representativeVersion.id,
      sequence: 1,
      status: "ACTIVE",
    },
  });
  await prisma.conversation.update({
    where: { id: matrixConversation.id },
    data: { activeEpisodeId: matrixEpisode.id },
  });

  const disclosureBoundaryExternalId =
    `$shared-memory-disclosure-boundary-${suffix}`;
  const disclosure = await claimMemoryChannelDisclosureDelivery({
    conversationId: matrixConversation.id,
    channel: "matrix",
    inboundExternalMessageIds: [disclosureBoundaryExternalId],
  });
  if (!disclosure.send) {
    throw new Error("Expected a new Matrix memory disclosure claim.");
  }
  if (!await completeMemoryChannelDisclosureDelivery({
    deliveryId: disclosure.deliveryId,
    leaseToken: disclosure.leaseToken,
    externalMessageId: `$shared-memory-disclosure-notice-${suffix}`,
  })) {
    throw new Error("Expected the Matrix memory disclosure to complete.");
  }
  const boundaryMessage = await prisma.message.create({
    data: {
      conversationId: matrixConversation.id,
      channelBindingId: matrixChannelBinding.id,
      sourceIdentityLinkId: matrixIdentityLink.id,
      sourceIdentityConnectionProofId: matrixIdentityProof.id,
      channelLifecycleRevision: 1,
      senderType: "AUDIENCE",
      senderId: matrixProviderSubject,
      contentType: "TEXT",
      text: "Disclosure boundary message",
      clientMessageId: disclosureBoundaryExternalId,
      externalMessageId: disclosureBoundaryExternalId,
      deliveryStatus: "SENT",
    },
  });
  if (!await prisma.$transaction((tx) =>
    activateCurrentMemoryChannelDisclosureAfterMessage(tx, {
      representativeId: representative.id,
      contactId: matrixContact.id,
      conversationId: matrixConversation.id,
      messageId: boundaryMessage.id,
      channel: "matrix",
    })
  )) {
    throw new Error("Expected the Matrix memory disclosure to activate.");
  }

  const [telegramContactA, telegramContactB] = await Promise.all([
    prisma.contact.create({
      data: {
        representativeId: representative.id,
        audienceIdentityId: audienceIdentity.id,
        telegramUserId: telegramProviderSubjectA,
        channelUserId: telegramProviderSubjectA,
        sourceChannel: "TELEGRAM",
      },
    }),
    prisma.contact.create({
      data: {
        representativeId: representative.id,
        audienceIdentityId: audienceIdentity.id,
        telegramUserId: telegramProviderSubjectB,
        channelUserId: telegramProviderSubjectB,
        sourceChannel: "TELEGRAM",
      },
    }),
  ]);
  const telegramRepresentativeBinding = await prisma.representativeChannelBinding
    .create({
      data: {
        representativeId: representative.id,
        kind: "TELEGRAM",
        transport: "TELEGRAM",
        sourceProvider: "TELEGRAM",
        connectionId: telegramConnectionId,
        endpointAssignmentRevision: 1,
        endpointLifecycleRevision: 1,
        desiredState: "ACTIVE",
        healthStatus: "HEALTHY",
        status: "CONNECTED",
      },
    });
  const telegramConversationA = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: telegramContactA.id,
      audienceIdentityId: audienceIdentity.id,
      telegramChatId: `telegram-chat-a-${suffix}`,
      channel: "PRIVATE_CHAT",
      sourceChannel: "telegram",
    },
  });
  const telegramConversationB = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: telegramContactB.id,
      audienceIdentityId: audienceIdentity.id,
      telegramChatId: `telegram-chat-b-${suffix}`,
      channel: "PRIVATE_CHAT",
      sourceChannel: "telegram",
    },
  });
  const telegramChannelBindingA = await prisma.conversationChannelBinding.create({
    data: {
      conversationId: telegramConversationA.id,
      representativeBindingId: telegramRepresentativeBinding.id,
      representativeAssignmentRevision: 1,
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      interactionMode: "PRIVATE_CHAT",
      connectionId: telegramConnectionId,
      externalConversationId: `telegram-chat-a-${suffix}`,
    },
  });
  const telegramChannelBindingB = await prisma.conversationChannelBinding.create({
    data: {
      conversationId: telegramConversationB.id,
      representativeBindingId: telegramRepresentativeBinding.id,
      representativeAssignmentRevision: 1,
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      interactionMode: "PRIVATE_CHAT",
      connectionId: telegramConnectionId,
      externalConversationId: `telegram-chat-b-${suffix}`,
    },
  });
  const [telegramEpisodeA, telegramEpisodeB] = await Promise.all([
    prisma.conversationEpisode.create({
      data: {
        conversationId: telegramConversationA.id,
        representativeVersionId: representativeVersion.id,
        sequence: 1,
        status: "ACTIVE",
      },
    }),
    prisma.conversationEpisode.create({
      data: {
        conversationId: telegramConversationB.id,
        representativeVersionId: representativeVersion.id,
        sequence: 1,
        status: "ACTIVE",
      },
    }),
  ]);
  await Promise.all([
    prisma.conversation.update({
      where: { id: telegramConversationA.id },
      data: { activeEpisodeId: telegramEpisodeA.id },
    }),
    prisma.conversation.update({
      where: { id: telegramConversationB.id },
      data: { activeEpisodeId: telegramEpisodeB.id },
    }),
  ]);
  await activatePrivateChannelDisclosure({
    representativeId: representative.id,
    contactId: telegramContactA.id,
    conversationId: telegramConversationA.id,
    channelBindingId: telegramChannelBindingA.id,
    channel: "telegram",
    externalIdPrefix: `telegram-a-${suffix}`,
    senderId: telegramProviderSubjectA,
    sourceIdentityLinkId: telegramIdentityLinkA.id,
    sourceIdentityConnectionProofId: telegramProofA.id,
  });
  await activatePrivateChannelDisclosure({
    representativeId: representative.id,
    contactId: telegramContactB.id,
    conversationId: telegramConversationB.id,
    channelBindingId: telegramChannelBindingB.id,
    channel: "telegram",
    externalIdPrefix: `telegram-b-${suffix}`,
    senderId: telegramProviderSubjectB,
    sourceIdentityLinkId: telegramIdentityLinkB.id,
    sourceIdentityConnectionProofId: telegramProofB.id,
  });

  return {
    representativeId: representative.id,
    representativeSlug: representative.slug,
    representativeVersionId: representativeVersion.id,
    policyRevision,
    audienceIdentityId: audienceIdentity.id,
    webIdentityLinkId: webIdentityLink.id,
    webProviderSubject,
    webIssuer,
    webConnectionId,
    webContactId: webContact.id,
    webConversationId: webConversation.id,
    matrixContactId: matrixContact.id,
    matrixIdentityLinkId: matrixIdentityLink.id,
    matrixIdentityProofId: matrixIdentityProof.id,
    matrixProviderSubject,
    matrixIssuer,
    matrixConnectionId: connectionId,
    matrixConversationId: matrixConversation.id,
    matrixChannelBindingId: matrixChannelBinding.id,
    matrixEpisodeId: matrixEpisode.id,
    telegramIdentityLinkAId: telegramIdentityLinkA.id,
    telegramIdentityLinkBId: telegramIdentityLinkB.id,
    telegramConnectionId,
    telegramIssuer,
    telegramProviderSubjectA,
    telegramProviderSubjectB,
    telegramProofAId: telegramProofA.id,
    telegramProofBId: telegramProofB.id,
    telegramContactAId: telegramContactA.id,
    telegramContactBId: telegramContactB.id,
    telegramRepresentativeBindingId: telegramRepresentativeBinding.id,
    telegramConversationAId: telegramConversationA.id,
    telegramConversationBId: telegramConversationB.id,
    telegramChannelBindingAId: telegramChannelBindingA.id,
    telegramChannelBindingBId: telegramChannelBindingB.id,
    telegramEpisodeAId: telegramEpisodeA.id,
    telegramEpisodeBId: telegramEpisodeB.id,
  };
}

async function grantSharedMemoryConsent(
  fixture: SharedMemoryEndToEndFixture,
) {
  const suffix = randomUUID();
  const sourceEvidence = {
    representativeSlug: fixture.representativeSlug,
    audienceIdentityId: fixture.audienceIdentityId,
    sourceChannel: "WEB" as const,
    providerSubject: fixture.webProviderSubject,
    issuer: fixture.webIssuer,
    connectionId: fixture.webConnectionId,
    sourceIdentityLinkId: fixture.webIdentityLinkId,
  };
  const challenge = await createContactMemorySharingChallenge({
    ...sourceEvidence,
    disclosureContractVersion: contactMemorySharingConsentContractVersion,
    sourceEventKey: `shared-memory-disclosure-${suffix}`,
  });
  return grantContactMemorySharingConsent({
    ...sourceEvidence,
    challengeToken: challenge.challengeToken,
    sourceEventKey: `shared-memory-confirm-${suffix}`,
  });
}

async function prepareExactIdentityMutation(
  fixture: SharedMemoryEndToEndFixture,
  target: ExactIdentityMutationTarget,
): Promise<PreparedExactIdentityMutation> {
  if (!target.startsWith("matrix")) return { fixture, target };

  const alternativeMatrixProof =
    await prisma.identityLinkConnectionProof.create({
      data: {
        identityLinkId: fixture.matrixIdentityLinkId,
        issuer: fixture.matrixIssuer,
        connectionId: `${fixture.matrixConnectionId}-alternative`,
        verifiedAt: new Date(),
        assuranceLevel: "PLATFORM_VERIFIED",
      },
    });
  if (target === "matrix-unlink") {
    return {
      fixture,
      target,
      alternativeMatrixProofId: alternativeMatrixProof.id,
    };
  }

  const suffix = randomUUID();
  const replacementMatrixIssuer = `replacement-${suffix}.example.test`;
  const replacementMatrixProviderSubject =
    `@replacement-${suffix}:${replacementMatrixIssuer}`;
  const challenge = await createIdentityBindingChallenge({
    audienceIdentityId: fixture.audienceIdentityId,
    provider: "MATRIX",
    issuer: replacementMatrixIssuer,
    connectionId: fixture.matrixConnectionId,
    expectedProviderSubject: replacementMatrixProviderSubject,
  });
  return {
    fixture,
    target,
    alternativeMatrixProofId: alternativeMatrixProof.id,
    replacementMatrixIssuer,
    replacementMatrixProviderSubject,
    replacementChallengeToken: challenge.token,
  };
}

async function runExactIdentityMutation(
  mutation: PreparedExactIdentityMutation,
  options: {
    backendReady?: (pid: number) => void;
    afterMutation?: () => void;
    hold?: () => Promise<void>;
  } = {},
) {
  return prisma.$transaction(async (tx) => {
    options.backendReady?.(await currentBackendPid(tx));
    let result: { changed: boolean };
    if (mutation.target === "matrix-replacement") {
      if (
        !mutation.replacementChallengeToken
        || !mutation.replacementMatrixProviderSubject
        || !mutation.replacementMatrixIssuer
      ) {
        throw new Error("Matrix replacement mutation is incomplete.");
      }
      await consumeIdentityBindingChallenge({
        token: mutation.replacementChallengeToken,
        provider: "MATRIX",
        providerSubject: mutation.replacementMatrixProviderSubject,
        issuer: mutation.replacementMatrixIssuer,
        connectionId: mutation.fixture.matrixConnectionId,
      }, tx as never);
      result = { changed: true };
    } else {
      const isMatrix = mutation.target === "matrix-unlink";
      result = await revokePrivateChannelIdentityBinding({
        audienceIdentityId: mutation.fixture.audienceIdentityId,
        provider: isMatrix ? "MATRIX" : "TELEGRAM",
        providerSubject: isMatrix
          ? mutation.fixture.matrixProviderSubject
          : mutation.fixture.telegramProviderSubjectB,
        issuer: isMatrix
          ? mutation.fixture.matrixIssuer
          : mutation.fixture.telegramIssuer,
        connectionId: isMatrix
          ? mutation.fixture.matrixConnectionId
          : mutation.fixture.telegramConnectionId,
      }, tx as never);
    }
    options.afterMutation?.();
    if (options.hold) await options.hold();
    return result;
  }, { timeout: 20_000 });
}

async function expectExactMutationLeavesAlternativeBindingActive(
  fixture: SharedMemoryEndToEndFixture,
  mutation: PreparedExactIdentityMutation,
) {
  if (mutation.target.startsWith("matrix")) {
    await expect(Promise.all([
      prisma.identityLink.findUniqueOrThrow({
        where: { id: fixture.matrixIdentityLinkId },
        select: { revokedAt: true },
      }),
      prisma.identityLinkConnectionProof.findUniqueOrThrow({
        where: { id: fixture.matrixIdentityProofId },
        select: { revokedAt: true },
      }),
      prisma.identityLinkConnectionProof.findUniqueOrThrow({
        where: { id: mutation.alternativeMatrixProofId! },
        select: { revokedAt: true },
      }),
    ])).resolves.toEqual([
      { revokedAt: null },
      { revokedAt: expect.any(Date) },
      { revokedAt: null },
    ]);
    if (mutation.target === "matrix-replacement") {
      await expect(prisma.identityLink.findUniqueOrThrow({
        where: {
          provider_providerSubject: {
            provider: "MATRIX",
            providerSubject: mutation.replacementMatrixProviderSubject!,
          },
        },
        select: {
          audienceIdentityId: true,
          revokedAt: true,
          connectionProofs: {
            where: {
              issuer: mutation.replacementMatrixIssuer!,
              connectionId: fixture.matrixConnectionId,
            },
            select: { revokedAt: true },
          },
        },
      })).resolves.toEqual({
        audienceIdentityId: fixture.audienceIdentityId,
        revokedAt: null,
        connectionProofs: [{ revokedAt: null }],
      });
    }
    return;
  }

  await expect(Promise.all([
    prisma.identityLink.findUniqueOrThrow({
      where: { id: fixture.telegramIdentityLinkAId },
      select: { revokedAt: true },
    }),
    prisma.identityLinkConnectionProof.findUniqueOrThrow({
      where: { id: fixture.telegramProofAId },
      select: { revokedAt: true },
    }),
    prisma.identityLink.findUniqueOrThrow({
      where: { id: fixture.telegramIdentityLinkBId },
      select: { revokedAt: true },
    }),
    prisma.identityLinkConnectionProof.findUniqueOrThrow({
      where: { id: fixture.telegramProofBId },
      select: { revokedAt: true },
    }),
  ])).resolves.toEqual([
    { revokedAt: null },
    { revokedAt: null },
    { revokedAt: expect.any(Date) },
    { revokedAt: expect.any(Date) },
  ]);
}

function exactMutationUseTarget(
  target: ExactIdentityMutationTarget,
): SharedUseTarget {
  return target.startsWith("matrix") ? "matrix" : "telegram-b";
}

function createExactPrivateChannelGenerationInput(
  fixture: SharedMemoryEndToEndFixture,
  target: ExactIdentityMutationTarget,
) {
  return target.startsWith("matrix")
    ? createMatrixGenerationInput(fixture)
    : createTelegramGenerationInput(fixture, "B");
}

function enqueueExactPrivateChannelMemoryExtraction(
  fixture: SharedMemoryEndToEndFixture,
  target: ExactIdentityMutationTarget,
  text: string,
) {
  return target.startsWith("matrix")
    ? enqueueMatrixMemoryExtraction(fixture, text)
    : enqueueTelegramMemoryExtraction(fixture, "B", text);
}

type SharedUseTarget = "web" | "matrix" | "telegram-a" | "telegram-b";

type ActiveSharedMemoryScenario = Awaited<
  ReturnType<typeof createActiveSharedMemoryScenario>
>;

async function createActiveSharedMemoryScenario() {
  const fixture = await createSharedMemoryEndToEndFixture();
  const provider = new SharedMemoryProjectionProvider();
  await grantSharedMemoryConsent(fixture);
  const extraction = await extractSharedContactMemory({
    representativeId: fixture.representativeId,
    contactId: fixture.webContactId,
    conversationId: fixture.webConversationId,
    audienceIdentityId: fixture.audienceIdentityId,
    sourceIdentityLinkId: fixture.webIdentityLinkId,
    text: "I prefer concise replies",
  });
  await drainProjectionWrites(fixture.representativeId, provider);
  await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
    where: { id: extraction.projection.id },
    select: { status: true, writeVerifiedAt: true },
  })).resolves.toEqual({
    status: "ACTIVE",
    writeVerifiedAt: expect.any(Date),
  });
  return { fixture, provider, extraction };
}

async function createSharedMemoryUse(
  scenario: ActiveSharedMemoryScenario,
  target: SharedUseTarget,
  options: { expectEligible?: boolean } = {},
) {
  const generation = target === "web"
    ? await createWebGenerationInput(scenario.fixture)
    : target === "matrix"
      ? await createMatrixGenerationInput(scenario.fixture)
      : await createTelegramGenerationInput(
          scenario.fixture,
          target === "telegram-a" ? "A" : "B",
        );
  if (target !== "web") {
    await expect(privateDisclosureAllows(
      scenario.fixture,
      target,
      generation.inputMessageId,
    )).resolves.toBe(true);
  }
  const sourceChannel = target === "web"
    ? "web"
    : target === "matrix"
      ? "matrix"
      : "telegram";
  const started = await startOrReuseMemoryUseRun({
    generationRunId: generation.generationRunId,
    sourceChannel,
  }, { client: prisma });
  const recorded = await recordMemoryUseSearchHits({
    useRunId: started.run.id,
    hits: [{
      sourceKind: "CONTACT_MEMORY",
      projectionItemId: scenario.extraction.projection.id,
      searchRank: 1,
      searchScore: 0.99,
    }],
  }, { client: prisma });
  if (options.expectEligible !== false) {
    expect(recorded.eligibleItems).toHaveLength(1);
  }
  return {
    target,
    generation,
    started,
    recorded,
    conversationId: sharedUseTargetConversationId(scenario.fixture, target),
  };
}

async function privateDisclosureAllows(
  fixture: SharedMemoryEndToEndFixture,
  target: Exclude<SharedUseTarget, "web">,
  inputMessageId: string,
) {
  const conversationId = sharedUseTargetConversationId(fixture, target);
  const contactId = target === "matrix"
    ? fixture.matrixContactId
    : target === "telegram-a"
      ? fixture.telegramContactAId
      : fixture.telegramContactBId;
  const sourceChannel = target === "matrix" ? "MATRIX" : "TELEGRAM";
  const [row] = await prisma.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT "memory_private_channel_disclosure_allows"(
      ${fixture.representativeId},
      ${contactId},
      ${conversationId},
      ${inputMessageId},
      ${sourceChannel}::"RepresentativeChannelKind",
      ${fixture.policyRevision}::INTEGER,
      ${memoryChannelDisclosureContractVersion}
    ) AS allowed
  `;
  return row?.allowed ?? false;
}

function sharedUseTargetConversationId(
  fixture: SharedMemoryEndToEndFixture,
  target: SharedUseTarget,
) {
  if (target === "web") return fixture.webConversationId;
  if (target === "matrix") return fixture.matrixConversationId;
  return target === "telegram-a"
    ? fixture.telegramConversationAId
    : fixture.telegramConversationBId;
}

async function finalizeSharedMemoryUse(
  use: Awaited<ReturnType<typeof createSharedMemoryUse>>,
  options: {
    hold?: () => Promise<void>;
    backendReady?: (pid: number) => void;
  } = {},
) {
  const itemId = use.recorded.eligibleItems[0]?.memoryUseItemId;
  if (!itemId) throw new Error("Expected an eligible shared memory item.");
  const outputId = `shared-memory-output-${randomUUID()}`;
  return prisma.$transaction(async (tx) => {
    const output = await tx.message.create({
      data: {
        id: outputId,
        conversationId: use.conversationId,
        senderType: "REPRESENTATIVE",
        deliveryStatus: "QUEUED",
        text: "A personalized answer using shared Contact Memory.",
      },
    });
    await tx.generationRun.update({
      where: { id: use.generation.generationRunId },
      data: {
        outputMessageId: output.id,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });
    if (options.backendReady) {
      const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
        "SELECT pg_backend_pid()::INTEGER AS pid",
      );
      if (!backend) throw new Error("Could not identify finalization backend.");
      options.backendReady(backend.pid);
    }
    await finalizeMemoryUseGenerationInTransaction(tx, {
      useRunId: use.started.run.id,
      outputMessageId: output.id,
      injectedItemIds: [itemId],
      citedItemIds: [itemId],
    });
    if (options.hold) await options.hold();
    return output;
  }, { timeout: 15_000 });
}

async function finalizeSharedMemoryUseInTransaction(
  tx: Parameters<typeof finalizeMemoryUseGenerationInTransaction>[0],
  use: Awaited<ReturnType<typeof createSharedMemoryUse>>,
) {
  const itemId = use.recorded.eligibleItems[0]?.memoryUseItemId;
  if (!itemId) throw new Error("Expected an eligible shared memory item.");
  const output = await tx.message.create({
    data: {
      id: `shared-memory-output-${randomUUID()}`,
      conversationId: use.conversationId,
      senderType: "REPRESENTATIVE",
      deliveryStatus: "QUEUED",
      text: "A personalized answer using shared Contact Memory.",
    },
  });
  await tx.generationRun.update({
    where: { id: use.generation.generationRunId },
    data: {
      outputMessageId: output.id,
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
  await finalizeMemoryUseGenerationInTransaction(tx, {
    useRunId: use.started.run.id,
    outputMessageId: output.id,
    injectedItemIds: [itemId],
    citedItemIds: [itemId],
  });
  return output;
}

async function prepareSharedMemoryDelivery(
  use: Awaited<ReturnType<typeof createSharedMemoryUse>>,
) {
  const output = await finalizeSharedMemoryUse(use);
  const outbox = await prisma.outboxEvent.create({
    data: {
      conversationId: use.conversationId,
      aggregateType: "generation_run",
      aggregateId: use.generation.generationRunId,
      eventType: "generation.requested",
      payload: {},
      status: "PROCESSING",
      idempotencyKey: `shared-memory-provider-${randomUUID()}`,
      attemptCount: 1,
      availableAt: new Date(Date.now() + 60_000),
    },
  });
  const fenceInput = {
    conversationId: use.conversationId,
    runId: use.generation.generationRunId,
    outboxId: outbox.id,
    leaseAttempt: 1,
    outputMessageId: output.id,
  };
  await prepareGenerationMessageChannelDelivery(fenceInput);
  return { output, outbox, fenceInput };
}

async function revokeSharedMemoryConsentInTransaction(
  tx: Parameters<typeof revokeContactMemorySharingConsentInTransaction>[0],
  fixture: SharedMemoryEndToEndFixture,
) {
  return revokeContactMemorySharingConsentInTransaction(tx, {
    representativeSlug: fixture.representativeSlug,
    audienceIdentityId: fixture.audienceIdentityId,
    sourceChannel: "WEB",
  });
}

async function activatePrivateChannelDisclosure(input: {
  representativeId: string;
  contactId: string;
  conversationId: string;
  channelBindingId: string;
  channel: "matrix" | "telegram";
  externalIdPrefix: string;
  senderId?: string;
  sourceIdentityLinkId?: string;
  sourceIdentityConnectionProofId?: string;
}) {
  const triggerId = `${input.externalIdPrefix}-disclosure-boundary`;
  const disclosure = await claimMemoryChannelDisclosureDelivery({
    conversationId: input.conversationId,
    channel: input.channel,
    inboundExternalMessageIds: [triggerId],
  });
  if (!disclosure.send) {
    throw new Error(`Expected a new ${input.channel} disclosure claim.`);
  }
  if (!await completeMemoryChannelDisclosureDelivery({
    deliveryId: disclosure.deliveryId,
    leaseToken: disclosure.leaseToken,
    externalMessageId: `${input.externalIdPrefix}-disclosure-notice`,
  })) {
    throw new Error(`Expected ${input.channel} disclosure delivery to complete.`);
  }
  const boundaryMessage = await prisma.message.create({
    data: {
      conversationId: input.conversationId,
      channelBindingId: input.channelBindingId,
      ...(input.sourceIdentityLinkId
        ? { sourceIdentityLinkId: input.sourceIdentityLinkId }
        : {}),
      ...(input.sourceIdentityConnectionProofId
        ? {
            sourceIdentityConnectionProofId:
              input.sourceIdentityConnectionProofId,
          }
        : {}),
      channelLifecycleRevision: 1,
      senderType: "AUDIENCE",
      ...(input.senderId ? { senderId: input.senderId } : {}),
      contentType: "TEXT",
      text: "Disclosure boundary message",
      clientMessageId: triggerId,
      externalMessageId: triggerId,
      deliveryStatus: "SENT",
    },
  });
  if (!await prisma.$transaction((tx) =>
    activateCurrentMemoryChannelDisclosureAfterMessage(tx, {
      representativeId: input.representativeId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      messageId: boundaryMessage.id,
      channel: input.channel,
    })
  )) {
    throw new Error(`Expected ${input.channel} disclosure to activate.`);
  }
}

async function extractSharedContactMemory(input: {
  representativeId: string;
  contactId: string;
  conversationId: string;
  audienceIdentityId: string;
  sourceIdentityLinkId: string;
  text: string;
}) {
  const message = await prisma.message.create({
    data: {
      conversationId: input.conversationId,
      sourceIdentityLinkId: input.sourceIdentityLinkId,
      senderType: "AUDIENCE",
      contentType: "TEXT",
      text: input.text,
      clientMessageId: `shared-memory-source-${randomUUID()}`,
      deliveryStatus: "SENT",
    },
  });
  const queued = await prisma.$transaction((tx) =>
    enqueueInboundMessageMemoryExtraction(tx, {
      representativeId: input.representativeId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      messageId: message.id,
      channel: "web",
    })
  );
  if (!queued.enqueued) throw new Error(queued.reasonCode);
  await expect(processMemoryExtractionRunEventually(queued.runId))
    .resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
  await expect(prisma.memoryExtractionRun.findUniqueOrThrow({
    where: { id: queued.runId },
    select: {
      status: true,
      candidateCount: true,
      acceptedCount: true,
      rejectedCount: true,
      quarantinedCount: true,
    },
  })).resolves.toEqual({
    status: "SUCCEEDED",
    candidateCount: 2,
    acceptedCount: 2,
    rejectedCount: 0,
    quarantinedCount: 0,
  });
  const candidate = await prisma.memoryCandidate.findFirstOrThrow({
    where: {
      sourceMessageId: message.id,
      scope: "CONTACT_SHARED",
      audienceIdentityId: input.audienceIdentityId,
    },
  });
  const policyDecision = await prisma.memoryPolicyDecision.findUniqueOrThrow({
    where: { candidateId: candidate.id },
  });
  if (!policyDecision.memoryId || !policyDecision.resultVersionId) {
    throw new Error("Shared Contact Memory was not automatically governed.");
  }
  const [memory, version, projection] = await Promise.all([
    prisma.governedMemory.findUniqueOrThrow({
      where: { id: policyDecision.memoryId! },
    }),
    prisma.governedMemoryVersion.findUniqueOrThrow({
      where: { id: policyDecision.resultVersionId! },
    }),
    prisma.memoryProjectionItem.findFirstOrThrow({
      where: {
        memoryId: policyDecision.memoryId!,
        memoryVersionId: policyDecision.resultVersionId!,
      },
    }),
  ]);
  expect(candidate.contentHash).toBe(
    createHash("sha256").update(candidate.safeText!).digest("hex"),
  );
  return { message, candidate, policyDecision, memory, version, projection };
}

async function createMatrixGenerationInput(
  fixture: SharedMemoryEndToEndFixture,
) {
  const suffix = randomUUID();
  const inputMessage = await prisma.message.create({
    data: {
      conversationId: fixture.matrixConversationId,
      channelBindingId: fixture.matrixChannelBindingId,
      sourceIdentityLinkId: fixture.matrixIdentityLinkId,
      sourceIdentityConnectionProofId: fixture.matrixIdentityProofId,
      channelLifecycleRevision: 1,
      senderType: "AUDIENCE",
      senderId: fixture.matrixProviderSubject,
      contentType: "TEXT",
      text: "How should you reply to me?",
      clientMessageId: `$shared-memory-input-${suffix}`,
      externalMessageId: `$shared-memory-input-${suffix}`,
      deliveryStatus: "SENT",
    },
  });
  const generationRun = await prisma.generationRun.create({
    data: {
      conversationId: fixture.matrixConversationId,
      episodeId: fixture.matrixEpisodeId,
      inputMessageId: inputMessage.id,
      representativeVersionId: fixture.representativeVersionId,
      status: "PROCESSING",
      idempotencyKey: `shared-memory-generation-${suffix}`,
    },
  });
  return { inputMessageId: inputMessage.id, generationRunId: generationRun.id };
}

async function createWebGenerationInput(
  fixture: SharedMemoryEndToEndFixture,
) {
  const suffix = randomUUID();
  const inputMessage = await prisma.message.create({
    data: {
      conversationId: fixture.webConversationId,
      sourceIdentityLinkId: fixture.webIdentityLinkId,
      senderType: "AUDIENCE",
      contentType: "TEXT",
      text: "How should you reply to me?",
      clientMessageId: `shared-memory-web-input-${suffix}`,
      deliveryStatus: "SENT",
    },
  });
  const generationRun = await prisma.generationRun.create({
    data: {
      conversationId: fixture.webConversationId,
      inputMessageId: inputMessage.id,
      representativeVersionId: fixture.representativeVersionId,
      status: "PROCESSING",
      idempotencyKey: `shared-memory-web-generation-${suffix}`,
    },
  });
  return { inputMessageId: inputMessage.id, generationRunId: generationRun.id };
}

async function createTelegramGenerationInput(
  fixture: SharedMemoryEndToEndFixture,
  connection: "A" | "B",
) {
  const suffix = randomUUID();
  const conversationId = connection === "A"
    ? fixture.telegramConversationAId
    : fixture.telegramConversationBId;
  const channelBindingId = connection === "A"
    ? fixture.telegramChannelBindingAId
    : fixture.telegramChannelBindingBId;
  const episodeId = connection === "A"
    ? fixture.telegramEpisodeAId
    : fixture.telegramEpisodeBId;
  const inputMessage = await prisma.message.create({
    data: {
      conversationId,
      channelBindingId,
      sourceIdentityLinkId: connection === "A"
        ? fixture.telegramIdentityLinkAId
        : fixture.telegramIdentityLinkBId,
      sourceIdentityConnectionProofId: connection === "A"
        ? fixture.telegramProofAId
        : fixture.telegramProofBId,
      channelLifecycleRevision: 1,
      senderType: "AUDIENCE",
      senderId: connection === "A"
        ? fixture.telegramProviderSubjectA
        : fixture.telegramProviderSubjectB,
      contentType: "TEXT",
      text: "How should you reply to me?",
      clientMessageId: `shared-memory-telegram-${connection}-${suffix}`,
      externalMessageId: `shared-memory-telegram-${connection}-${suffix}`,
      deliveryStatus: "SENT",
    },
  });
  const generationRun = await prisma.generationRun.create({
    data: {
      conversationId,
      episodeId,
      inputMessageId: inputMessage.id,
      representativeVersionId: fixture.representativeVersionId,
      status: "PROCESSING",
      idempotencyKey: `shared-memory-telegram-generation-${connection}-${suffix}`,
    },
  });
  return { inputMessageId: inputMessage.id, generationRunId: generationRun.id };
}

async function enqueueMatrixMemoryExtraction(
  fixture: SharedMemoryEndToEndFixture,
  text: string,
) {
  const suffix = randomUUID();
  const message = await prisma.message.create({
    data: {
      conversationId: fixture.matrixConversationId,
      channelBindingId: fixture.matrixChannelBindingId,
      sourceIdentityLinkId: fixture.matrixIdentityLinkId,
      sourceIdentityConnectionProofId: fixture.matrixIdentityProofId,
      channelLifecycleRevision: 1,
      senderType: "AUDIENCE",
      senderId: fixture.matrixProviderSubject,
      contentType: "TEXT",
      text,
      clientMessageId: `$shared-memory-matrix-extraction-${suffix}`,
      externalMessageId: `$shared-memory-matrix-extraction-${suffix}`,
      deliveryStatus: "SENT",
    },
  });
  const queued = await prisma.$transaction((tx) =>
    enqueueInboundMessageMemoryExtraction(tx, {
      representativeId: fixture.representativeId,
      contactId: fixture.matrixContactId,
      conversationId: fixture.matrixConversationId,
      messageId: message.id,
      channel: "matrix",
    })
  );
  if (!queued.enqueued) throw new Error(queued.reasonCode);
  return { messageId: message.id, runId: queued.runId };
}

async function enqueueTelegramMemoryExtraction(
  fixture: SharedMemoryEndToEndFixture,
  account: "A" | "B",
  text: string,
) {
  const suffix = randomUUID();
  const coordinates = account === "A"
    ? {
        contactId: fixture.telegramContactAId,
        conversationId: fixture.telegramConversationAId,
        channelBindingId: fixture.telegramChannelBindingAId,
        sourceIdentityLinkId: fixture.telegramIdentityLinkAId,
        sourceIdentityConnectionProofId: fixture.telegramProofAId,
        senderId: fixture.telegramProviderSubjectA,
      }
    : {
        contactId: fixture.telegramContactBId,
        conversationId: fixture.telegramConversationBId,
        channelBindingId: fixture.telegramChannelBindingBId,
        sourceIdentityLinkId: fixture.telegramIdentityLinkBId,
        sourceIdentityConnectionProofId: fixture.telegramProofBId,
        senderId: fixture.telegramProviderSubjectB,
      };
  const message = await prisma.message.create({
    data: {
      conversationId: coordinates.conversationId,
      channelBindingId: coordinates.channelBindingId,
      sourceIdentityLinkId: coordinates.sourceIdentityLinkId,
      sourceIdentityConnectionProofId:
        coordinates.sourceIdentityConnectionProofId,
      channelLifecycleRevision: 1,
      senderType: "AUDIENCE",
      senderId: coordinates.senderId,
      contentType: "TEXT",
      text,
      clientMessageId: `shared-memory-telegram-extraction-${suffix}`,
      externalMessageId: `shared-memory-telegram-extraction-${suffix}`,
      deliveryStatus: "SENT",
    },
  });
  const queued = await prisma.$transaction((tx) =>
    enqueueInboundMessageMemoryExtraction(tx, {
      representativeId: fixture.representativeId,
      contactId: coordinates.contactId,
      conversationId: coordinates.conversationId,
      messageId: message.id,
      channel: "telegram",
    })
  );
  if (!queued.enqueued) throw new Error(queued.reasonCode);
  return { messageId: message.id, runId: queued.runId };
}

async function drainProjectionWrites(
  representativeId: string,
  provider: MemoryProjectionProvider,
) {
  for (let index = 0; index < 200; index += 1) {
    const result = await runNextMemoryProjectionWrite({
      client: prisma,
      provider,
      representativeId,
    });
    if (!result.processed) {
      const queued = await prisma.memoryProjectionItem.count({
        where: { representativeId, status: "QUEUED" },
      });
      if (queued === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    expect(result).toMatchObject({ processed: true, status: "completed" });
  }
  throw new Error("Projection write queue did not drain within two seconds.");
}

async function processMemoryExtractionRunEventually(runId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await processMemoryExtractionRun({ runId });
    if (result.processed) return result;
    const run = await prisma.memoryExtractionRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (run?.status !== "QUEUED") return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Memory extraction run ${runId} was not claimable in two seconds.`);
}

class SharedMemoryProjectionProvider implements MemoryProjectionProvider {
  readonly name = "openviking";
  readonly objects = new Map<string, string>();

  async ensureRoot(input: { rootUri: string }) {
    return { rootUri: input.rootUri, receipt: `ensure:${input.rootUri}` };
  }

  async writeExact(input: {
    uri: string;
    safeText: string;
    contentHash: string;
  }) {
    expect(createHash("sha256").update(input.safeText).digest("hex"))
      .toBe(input.contentHash);
    const existing = this.objects.get(input.uri);
    if (existing && existing !== input.contentHash) {
      throw new Error("Projection content conflict in test provider.");
    }
    this.objects.set(input.uri, input.contentHash);
    return {
      uri: input.uri,
      contentHash: input.contentHash,
      receipt: `write:${input.uri}:${input.contentHash}`,
    };
  }

  async inspectExact(input: { uri: string }) {
    const contentHash = this.objects.get(input.uri);
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

  async deleteExact(input: { uri: string }) {
    const existed = this.objects.delete(input.uri);
    return {
      uri: input.uri,
      outcome: existed ? "deleted" as const : "absent" as const,
      receipt: `delete:${existed ? "deleted" : "absent"}:${input.uri}`,
    };
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function currentBackendPid(
  tx: Parameters<typeof finalizeMemoryUseGenerationInTransaction>[0],
) {
  const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
    "SELECT pg_backend_pid()::INTEGER AS pid",
  );
  if (!backend) throw new Error("Could not identify PostgreSQL backend.");
  return backend.pid;
}

async function waitForBackendLock(pid: number) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const [activity] = await prisma.$queryRawUnsafe<Array<{
      waitEventType: string | null;
      waitEvent: string | null;
    }>>(`
      SELECT wait_event_type AS "waitEventType", wait_event AS "waitEvent"
        FROM pg_stat_activity
       WHERE pid = ${pid}
    `);
    if (activity?.waitEventType === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${pid} did not block on the expected memory lock.`);
}

function expectNotPostgresDeadlock(error: unknown) {
  const record = error && typeof error === "object"
    ? error as { code?: unknown; meta?: unknown; message?: unknown }
    : null;
  const diagnostic = [
    String(error),
    String(record?.code ?? ""),
    String(record?.message ?? ""),
    JSON.stringify(record?.meta ?? null),
  ].join(" ");
  expect(diagnostic).not.toContain("40P01");
  expect(diagnostic.toLowerCase()).not.toContain("deadlock detected");
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for Contact Memory sharing E2E.");
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host)
    || !["test", "e2e", "delegate"].some((marker) => database.includes(marker))
  ) {
    throw new Error(
      `Refusing Contact Memory sharing E2E against ${host}/${database}.`,
    );
  }
}

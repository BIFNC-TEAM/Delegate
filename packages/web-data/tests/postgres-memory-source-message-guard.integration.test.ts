import crypto from "node:crypto";

import { buildGovernedContactChannelMemoryVersionUri } from "@delegate/openviking";
import { afterAll, describe, expect, it } from "vitest";

import {
  enqueueInboundMessageMemoryExtraction,
  processMemoryExtractionRun,
} from "../src/memory-extraction";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("Memory System source-message PostgreSQL guards", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rejects operator/tool provenance and cross-run source substitution", async () => {
    const fixture = await createFixture();
    const audienceMessage = await createMessage(fixture.conversationId, {
      senderType: "AUDIENCE",
      text: "Please remember that I prefer concise answers.",
    });
    const secondAudienceMessage = await createMessage(fixture.conversationId, {
      senderType: "AUDIENCE",
      text: "A separate audience message.",
    });
    const operatorMessage = await createMessage(fixture.conversationId, {
      senderType: "OPERATOR",
      text: "Owner-only service note.",
    });
    const toolMessage = await createMessage(fixture.conversationId, {
      senderType: "TOOL",
      contentType: "TOOL_RESULT",
      text: "Compute output must not become memory.",
    });

    for (const [label, sourceMessageId] of [
      ["operator", operatorMessage.id],
      ["tool", toolMessage.id],
    ] as const) {
      await expect(prisma.memoryExtractionRun.create({
        data: extractionRunData(fixture, sourceMessageId, `${label}-run`),
      })).rejects.toThrow();
      await expect(prisma.memoryCandidate.create({
        data: candidateData(
          fixture,
          sourceMessageId,
          `${label}-candidate`,
        ),
      })).rejects.toThrow();
    }

    const run = await prisma.memoryExtractionRun.create({
      data: extractionRunData(fixture, audienceMessage.id, "valid-run"),
    });
    await expect(prisma.memoryCandidate.create({
      data: {
        ...candidateData(
          fixture,
          secondAudienceMessage.id,
          "substituted-source-candidate",
        ),
        extractionRunId: run.id,
      },
    })).rejects.toThrow();
    await expect(prisma.memoryCandidate.create({
      data: {
        ...candidateData(
          fixture,
          audienceMessage.id,
          "forged-source-kind-candidate",
        ),
        extractionRunId: run.id,
        sourceKind: "OWNER_VERIFIED_CORRECTION",
      },
    })).rejects.toThrow();

    const secondContact = await prisma.contact.create({
      data: {
        representativeId: fixture.representativeId,
        sourceChannel: "WEB",
      },
    });
    const secondConversation = await prisma.conversation.create({
      data: {
        representativeId: fixture.representativeId,
        contactId: secondContact.id,
        channel: "PRIVATE_CHAT",
        sourceChannel: "WEB",
      },
    });
    const crossContactMessage = await createMessage(secondConversation.id, {
      senderType: "AUDIENCE",
      text: "This belongs to another contact.",
    });
    await expect(prisma.memoryExtractionRun.create({
      data: {
        ...extractionRunData(
          fixture,
          crossContactMessage.id,
          "cross-contact-run",
        ),
        sourceConversationId: secondConversation.id,
      },
    })).rejects.toThrow();
  });

  it("cancels unfinished extraction and purges candidates on edit/redaction", async () => {
    const fixture = await createFixture();
    const editSource = await createMessage(fixture.conversationId, {
      senderType: "AUDIENCE",
      text: "Remember this original preference.",
    });
    const editRun = await prisma.memoryExtractionRun.create({
      data: extractionRunData(fixture, editSource.id, "edit-run"),
    });
    const editCandidate = await prisma.memoryCandidate.create({
      data: {
        ...candidateData(fixture, editSource.id, "edit-candidate"),
        extractionRunId: editRun.id,
      },
    });

    await prisma.message.update({
      where: { id: editSource.id },
      data: { deliveryStatus: "SENT" },
    });
    await prisma.message.update({
      where: { id: editSource.id },
      data: { deliveryStatus: "FAILED" },
    });
    await prisma.message.update({
      where: { id: editSource.id },
      data: { deliveryStatus: "CANCELED" },
    });
    await expect(prisma.memoryExtractionRun.findUniqueOrThrow({
      where: { id: editRun.id },
      select: { status: true, errorCode: true },
    })).resolves.toEqual({ status: "QUEUED", errorCode: null });
    await expect(prisma.memoryCandidate.findUniqueOrThrow({
      where: { id: editCandidate.id },
      select: { status: true, contentPurgedAt: true },
    })).resolves.toEqual({ status: "EXTRACTED", contentPurgedAt: null });
    await expect(prisma.memoryExtractionRun.create({
      data: extractionRunData(fixture, editSource.id, "delivery-only-run"),
    })).resolves.toMatchObject({ status: "QUEUED", errorCode: null });

    await prisma.message.update({
      where: { id: editSource.id },
      data: {
        text: "This edited message must not retain the prior candidate.",
        editedAt: new Date(),
        deliveryStatus: "EDITED",
      },
    });

    await expect(prisma.memoryExtractionRun.findUniqueOrThrow({
      where: { id: editRun.id },
      select: {
        status: true,
        errorCode: true,
        startedAt: true,
        finishedAt: true,
        leaseToken: true,
        leaseExpiresAt: true,
      },
    })).resolves.toMatchObject({
      status: "CANCELED",
      errorCode: "source_message_edited",
      leaseToken: null,
      leaseExpiresAt: null,
    });
    await expect(prisma.memoryCandidate.findUniqueOrThrow({
      where: { id: editCandidate.id },
      select: {
        status: true,
        safeText: true,
        summary: true,
        contentHash: true,
        contentPurgedAt: true,
        safetyClass: true,
        safetyReasonCode: true,
      },
    })).resolves.toMatchObject({
      status: "BLOCKED",
      safeText: null,
      summary: null,
      safetyClass: "PROHIBITED",
      safetyReasonCode: "source_message_edited",
    });

    const editedRun = await prisma.memoryExtractionRun.findUniqueOrThrow({
      where: { id: editRun.id },
    });
    expect(editedRun.startedAt).not.toBeNull();
    expect(editedRun.finishedAt).not.toBeNull();
    const editedCandidate = await prisma.memoryCandidate.findUniqueOrThrow({
      where: { id: editCandidate.id },
    });
    expect(editedCandidate.contentPurgedAt).not.toBeNull();
    expect(editedCandidate.contentHash).toBe(
      candidateData(fixture, editSource.id, "edit-candidate").contentHash,
    );

    await expect(prisma.memoryExtractionRun.create({
      data: extractionRunData(fixture, editSource.id, "post-edit-run"),
    })).rejects.toThrow();

    const redactSource = await createMessage(fixture.conversationId, {
      senderType: "AUDIENCE",
      text: "This pending memory will be redacted.",
    });
    const queuedRedactRun = await prisma.memoryExtractionRun.create({
      data: extractionRunData(fixture, redactSource.id, "redact-run"),
    });
    const redactStartedAt = new Date(queuedRedactRun.createdAt.getTime() + 1);
    const redactRun = await prisma.memoryExtractionRun.update({
      where: { id: queuedRedactRun.id },
      data: {
        status: "RUNNING",
        startedAt: redactStartedAt,
        leaseToken: `lease-${crypto.randomUUID()}`,
        leaseExpiresAt: new Date(redactStartedAt.getTime() + 60_000),
      },
    });
    const redactCandidate = await prisma.memoryCandidate.create({
      data: {
        ...candidateData(fixture, redactSource.id, "redact-candidate"),
        extractionRunId: redactRun.id,
        status: "PENDING_REVIEW",
      },
    });

    await prisma.message.update({
      where: { id: redactSource.id },
      data: {
        redactedAt: new Date(),
        deliveryStatus: "REDACTED",
        redactionReason: "audience_request",
      },
    });

    await expect(prisma.memoryExtractionRun.findUniqueOrThrow({
      where: { id: redactRun.id },
      select: { status: true, errorCode: true, leaseToken: true },
    })).resolves.toEqual({
      status: "CANCELED",
      errorCode: "source_message_redacted",
      leaseToken: null,
    });
    const redactedCandidate = await prisma.memoryCandidate.findUniqueOrThrow({
      where: { id: redactCandidate.id },
    });
    expect(redactedCandidate).toMatchObject({
      status: "EXPIRED",
      safeText: null,
      summary: null,
      safetyClass: "PROHIBITED",
      safetyReasonCode: "source_message_redacted",
    });
    expect(redactedCandidate.contentPurgedAt).not.toBeNull();
    expect(redactedCandidate.contentHash).not.toBeNull();
  });

  it("invalidates automatically decided representative evidence without rewriting locked safety coordinates", async () => {
    const fixture = await createFixture();
    await prisma.representativeMemoryPolicy.update({
      where: { representativeId: fixture.representativeId },
      data: {
        representativeExperienceEnabled: true,
        autoExtract: true,
        webExtractEnabled: true,
      },
    });
    const source = await createMessage(fixture.conversationId, {
      senderType: "AUDIENCE",
      text: "I prefer concise replies",
    });
    const queued = await prisma.$transaction((tx) =>
      enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: fixture.representativeId,
        contactId: fixture.contactId,
        conversationId: fixture.conversationId,
        messageId: source.id,
        channel: "web",
      }));
    expect(queued.enqueued).toBe(true);
    if (!queued.enqueued) throw new Error("Expected representative evidence extraction.");
    await expect(processMemoryExtractionRun({ runId: queued.runId })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    const candidate = await prisma.memoryCandidate.findFirstOrThrow({
      where: { sourceMessageId: source.id, scope: "REPRESENTATIVE" },
      include: { policyDecision: true },
    });
    expect(candidate).toMatchObject({
      status: "EXTRACTED",
      safetyClass: "LOW_RISK",
      safetyReasonCode: null,
      policyDecision: { outcome: "EVIDENCE_RECORDED" },
    });

    await expect(prisma.message.update({
      where: { id: source.id },
      data: {
        text: "This source was edited after evidence was recorded.",
        editedAt: new Date(),
        deliveryStatus: "EDITED",
      },
    })).resolves.toMatchObject({ id: source.id });

    await expect(prisma.memoryCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
      select: {
        status: true,
        safeText: true,
        summary: true,
        contentPurgedAt: true,
        safetyClass: true,
        safetyReasonCode: true,
      },
    })).resolves.toMatchObject({
      status: "BLOCKED",
      safeText: null,
      summary: null,
      safetyClass: "LOW_RISK",
      safetyReasonCode: null,
    });
    const invalidated = await prisma.memoryCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
      select: { contentPurgedAt: true },
    });
    expect(invalidated.contentPurgedAt).not.toBeNull();
  });

  it("expires versioned pending candidates and hands immutable content to cleanup", async () => {
    const fixture = await createFixture();
    const source = await createMessage(fixture.conversationId, {
      senderType: "AUDIENCE",
      text: "This pending version will be invalidated by an edit.",
    });
    const run = await prisma.memoryExtractionRun.create({
      data: extractionRunData(fixture, source.id, "versioned-run"),
    });
    const candidate = await prisma.memoryCandidate.create({
      data: {
        ...candidateData(fixture, source.id, "versioned-candidate"),
        extractionRunId: run.id,
        status: "PENDING_REVIEW",
      },
    });
    const memory = await prisma.governedMemory.create({
      data: {
        representativeId: fixture.representativeId,
        contactId: fixture.contactId,
        scope: "CONTACT_CHANNEL",
        sourceChannel: "WEB",
        category: "CONTACT_PREFERENCE",
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
        createdByActorId: "memory-extraction-system",
      },
    });

    await prisma.message.update({
      where: { id: source.id },
      data: {
        text: "The source changed before review.",
        editedAt: new Date(),
        deliveryStatus: "EDITED",
      },
    });

    await expect(prisma.memoryCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
      select: {
        status: true,
        safeText: true,
        summary: true,
        contentHash: true,
        contentPurgedAt: true,
      },
    })).resolves.toEqual({
      status: "EXPIRED",
      safeText: candidate.safeText,
      summary: candidate.summary,
      contentHash: candidate.contentHash,
      contentPurgedAt: null,
    });
    await expect(prisma.governedMemory.findUniqueOrThrow({
      where: { id: memory.id },
      select: {
        status: true,
        recallDisabledAt: true,
        deleteRequestedAt: true,
      },
    })).resolves.toMatchObject({ status: "DELETE_PENDING" });
    const pendingCleanup = await prisma.governedMemory.findUniqueOrThrow({
      where: { id: memory.id },
    });
    expect(pendingCleanup.recallDisabledAt).not.toBeNull();
    expect(pendingCleanup.deleteRequestedAt).not.toBeNull();
    await expect(prisma.governedMemoryVersion.findUniqueOrThrow({
      where: { id: version.id },
      select: { safeText: true, summary: true, contentHash: true, purgedAt: true },
    })).resolves.toEqual({
      safeText: candidate.safeText,
      summary: candidate.summary,
      contentHash: candidate.contentHash,
      purgedAt: null,
    });
    await expect(prisma.memoryReviewDecision.create({
      data: {
        representativeId: fixture.representativeId,
        candidateId: candidate.id,
        memoryId: memory.id,
        resultVersionId: version.id,
        outcome: "APPROVED",
        reviewerRole: "OWNER",
        reviewerActorId: fixture.ownerId,
        reasonCode: "late_owner_approval",
      },
    })).rejects.toThrow();
    await expect(prisma.memoryReviewDecision.count({
      where: { candidateId: candidate.id, outcome: "APPROVED" },
    })).resolves.toBe(0);
  });

  it("suppresses approved current memories after either source edit or redaction", async () => {
    for (const mutation of ["edit", "redact"] as const) {
      const fixture = await createFixture();
      const source = await createMessage(fixture.conversationId, {
        senderType: "AUDIENCE",
        text: `Approved memory source for ${mutation}.`,
      });
      const approved = await createApprovedMemoryVersion({
        fixture,
        sourceMessageId: source.id,
        label: `approved-${mutation}`,
      });
      const projection = await prisma.memoryProjectionItem.create({
        data: {
          representativeId: fixture.representativeId,
          memoryId: approved.memory.id,
          memoryVersionId: approved.version.id,
          lane: "RECALL",
          status: "QUEUED",
          contentHash: approved.version.contentHash,
          remoteUri: buildGovernedContactChannelMemoryVersionUri({
            namespaceKey: fixture.namespaceKey,
            contactId: fixture.contactId,
            channel: "web",
            memoryId: approved.memory.id,
            memoryVersionId: approved.version.id,
          }),
          idempotencyKey: `projection-${mutation}-${crypto.randomUUID()}`,
        },
      });
      await prisma.memoryProjectionItem.update({
        where: { id: projection.id },
        data: {
          status: "PROJECTING",
          attemptCount: { increment: 1 },
          leaseToken: `projection-${crypto.randomUUID()}`,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      await prisma.memoryProjectionItem.update({
        where: { id: projection.id },
        data: {
          status: "ACTIVE",
          remoteObjectId: projection.remoteUri,
          writeReceiptHash: crypto.createHash("sha256").update(`write-${projection.id}`).digest("hex"),
          writeVerifiedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
          projectedAt: new Date(),
        },
      });

      await expect(prisma.governedMemory.findUniqueOrThrow({
        where: { id: approved.memory.id },
        select: { status: true, recallDisabledAt: true },
      })).resolves.toEqual({ status: "ACTIVE", recallDisabledAt: null });

      await prisma.message.update({
        where: { id: source.id },
        data: mutation === "edit"
          ? {
              text: "The approved source was edited after activation.",
              editedAt: new Date(),
              deliveryStatus: "EDITED",
            }
          : {
              redactedAt: new Date(),
              deliveryStatus: "REDACTED",
              redactionReason: "audience_request",
            },
      });

      const suppressed = await prisma.governedMemory.findUniqueOrThrow({
        where: { id: approved.memory.id },
      });
      expect(suppressed).toMatchObject({
        status: "SUPPRESSED",
        currentVersionId: approved.version.id,
      });
      expect(suppressed.recallDisabledAt).not.toBeNull();
      expect(suppressed.suppressedAt).not.toBeNull();
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: approved.candidate.id },
        select: {
          status: true,
          safeText: true,
          summary: true,
          contentHash: true,
          contentPurgedAt: true,
        },
      })).resolves.toEqual({
        status: "APPROVED",
        safeText: approved.candidate.safeText,
        summary: approved.candidate.summary,
        contentHash: approved.candidate.contentHash,
        contentPurgedAt: null,
      });
      await expect(prisma.governedMemoryVersion.findUniqueOrThrow({
        where: { id: approved.version.id },
        select: {
          safeText: true,
          summary: true,
          contentHash: true,
          purgedAt: true,
        },
      })).resolves.toEqual({
        safeText: approved.version.safeText,
        summary: approved.version.summary,
        contentHash: approved.version.contentHash,
        purgedAt: null,
      });
      await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
        where: { id: projection.id },
        select: { status: true },
      })).resolves.toEqual({ status: "ACTIVE" });
    }
  });

  it("does not allow a legacy human correction to reactivate memory", async () => {
    const fixture = await createFixture();
    const oldSource = await createMessage(fixture.conversationId, {
      senderType: "AUDIENCE",
      text: "Old preference source.",
    });
    const currentSource = await createMessage(fixture.conversationId, {
      senderType: "AUDIENCE",
      text: "Corrected current preference source.",
    });
    const oldApproved = await createApprovedMemoryVersion({
      fixture,
      sourceMessageId: oldSource.id,
      label: "historical-v1",
    });
    await expect(createApprovedMemoryVersion({
      fixture,
      sourceMessageId: currentSource.id,
      label: "current-v2",
      memoryId: oldApproved.memory.id,
      versionNumber: 2,
      supersedesVersionId: oldApproved.version.id,
    })).rejects.toThrow(/automatic policy decision/u);
  });

  it("allows only bodyless blocked/quarantined markers and review transitions", async () => {
    const fixture = await createFixture();
    const source = await createMessage(fixture.conversationId, {
      senderType: "AUDIENCE",
      text: "A valid audience text source.",
    });

    await expect(prisma.memoryCandidate.create({
      data: {
        ...candidateData(fixture, source.id, "blocked-with-body"),
        status: "BLOCKED",
        safetyClass: "PROHIBITED",
        safetyReasonCode: "credential_detected",
      },
    })).rejects.toThrow();

    const marker = await prisma.memoryCandidate.create({
      data: {
        ...candidateData(fixture, source.id, "bodyless-quarantine"),
        safeText: null,
        summary: null,
        contentHash: null,
        contentPurgedAt: new Date(),
        status: "QUARANTINED",
        safetyClass: "SENSITIVE",
        safetyReasonCode: "credential_detected",
      },
    });
    expect(marker).toMatchObject({
      status: "QUARANTINED",
      safeText: null,
      summary: null,
      contentHash: null,
    });

    const channelRun = await prisma.memoryExtractionRun.create({
      data: extractionRunData(fixture, source.id, "channel-run"),
    });
    await expect(prisma.memoryCandidate.create({
      data: {
        ...candidateData(fixture, source.id, "direct-approved"),
        extractionRunId: channelRun.id,
        status: "APPROVED",
        reviewedAt: new Date(),
      },
    })).rejects.toThrow();
  });
});

async function createFixture() {
  const suffix = crypto.randomUUID();
  const namespaceKey = `memory-source-guard-${suffix}`;
  const owner = await prisma.owner.create({
    data: { displayName: `Memory source guard ${suffix}` },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `memory-source-guard-${suffix}`,
      displayName: "Memory source guard representative",
      roleSummary: "Exercises source-message trust boundaries.",
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
    ownerId: owner.id,
    representativeId: representative.id,
    namespaceKey,
    contactId: contact.id,
    conversationId: conversation.id,
  };
}

async function createMessage(
  conversationId: string,
  data: {
    senderType: "AUDIENCE" | "OPERATOR" | "TOOL";
    contentType?: "TEXT" | "TOOL_RESULT";
    text: string;
  },
) {
  return prisma.message.create({
    data: {
      conversationId,
      senderType: data.senderType,
      contentType: data.contentType ?? "TEXT",
      text: data.text,
    },
  });
}

function extractionRunData(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sourceMessageId: string,
  label: string,
) {
  return {
    representativeId: fixture.representativeId,
    contactId: fixture.contactId,
    sourceChannel: "WEB" as const,
    sourceConversationId: fixture.conversationId,
    sourceMessageId,
    trigger: "CHANNEL_MESSAGE" as const,
    idempotencyKey: `${label}-${crypto.randomUUID()}`,
  };
}

function candidateData(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sourceMessageId: string,
  label: string,
) {
  const safeText = `Sanitized ${label}`;
  return {
    representativeId: fixture.representativeId,
    contactId: fixture.contactId,
    scope: "CONTACT_CHANNEL" as const,
    scopeChannel: "WEB" as const,
    originChannel: "WEB" as const,
    category: "CONTACT_PREFERENCE" as const,
    sourceKind: "AUDIENCE_MESSAGE" as const,
    safeText,
    summary: `Summary ${label}`,
    contentHash: crypto.createHash("sha256").update(safeText).digest("hex"),
    semanticKey: "contact-preference:communication",
    dedupeKey: `${label}-${crypto.randomUUID()}`,
    safetyClass: "LOW_RISK" as const,
    extractionReasonCode: "explicit_preference",
    sourceContactId: fixture.contactId,
    sourceConversationId: fixture.conversationId,
    sourceMessageId,
  };
}

async function createApprovedMemoryVersion(input: {
  fixture: Awaited<ReturnType<typeof createFixture>>;
  sourceMessageId: string;
  label: string;
  memoryId?: string;
  versionNumber?: number;
  supersedesVersionId?: string;
}) {
  const memory = input.memoryId
    ? await prisma.governedMemory.findUniqueOrThrow({
        where: { id: input.memoryId },
      })
    : await prisma.governedMemory.create({
        data: {
          representativeId: input.fixture.representativeId,
          contactId: input.fixture.contactId,
          scope: "CONTACT_CHANNEL",
          sourceChannel: "WEB",
          category: "CONTACT_PREFERENCE",
          semanticKey: "contact-preference:communication",
        },
      });
  if (input.supersedesVersionId && memory.status === "ACTIVE") {
    const suppressedAt = new Date();
    await prisma.governedMemory.update({
      where: { id: memory.id },
      data: {
        status: "SUPPRESSED",
        recallDisabledAt: suppressedAt,
        suppressedAt,
      },
    });
  }
  const run = input.supersedesVersionId
    ? null
    : await prisma.memoryExtractionRun.create({
        data: extractionRunData(
          input.fixture,
          input.sourceMessageId,
          `${input.label}-run`,
        ),
      });
  const candidate = await prisma.memoryCandidate.create({
    data: {
      ...candidateData(
        input.fixture,
        input.sourceMessageId,
        `${input.label}-candidate`,
      ),
      ...(input.supersedesVersionId
        ? {
            sourceKind: "OWNER_VERIFIED_CORRECTION" as const,
            correctionMemoryId: memory.id,
            correctionBaseVersionId: input.supersedesVersionId,
          }
        : { extractionRunId: run!.id }),
      status: "PENDING_REVIEW",
    },
  });
  if (input.supersedesVersionId) {
    await prisma.memoryReviewDecision.create({
      data: {
        representativeId: input.fixture.representativeId,
        candidateId: candidate.id,
        memoryId: memory.id,
        outcome: "CORRECTION_REQUESTED",
        reviewerRole: "OWNER",
        reviewerActorId: input.fixture.ownerId,
        reasonCode: "owner_correction_requested",
      },
    });
  }
  const version = await prisma.governedMemoryVersion.create({
    data: {
      memoryId: memory.id,
      representativeId: input.fixture.representativeId,
      scope: "CONTACT_CHANNEL",
      sourceCandidateId: candidate.id,
      ...(input.supersedesVersionId
        ? { supersedesVersionId: input.supersedesVersionId }
        : {}),
      versionNumber: input.versionNumber ?? 1,
      safeText: candidate.safeText,
      summary: candidate.summary,
      contentHash: candidate.contentHash!,
      ...(input.supersedesVersionId
        ? { correctionReasonCode: "owner_correction" }
        : {}),
      createdByActorId: `memory-extraction-${input.label}`,
    },
  });
  if (input.supersedesVersionId) {
    await prisma.memoryReviewDecision.create({
      data: {
        representativeId: input.fixture.representativeId,
        candidateId: candidate.id,
        memoryId: memory.id,
        resultVersionId: version.id,
        outcome: "APPROVED",
        reviewerRole: "OWNER",
        reviewerActorId: input.fixture.ownerId,
        reasonCode: "owner_verified_correction",
      },
    });
  } else {
    await prisma.memoryPolicyDecision.create({
      data: {
        representativeId: input.fixture.representativeId,
        candidateId: candidate.id,
        memoryId: memory.id,
        resultVersionId: version.id,
        outcome: "ACTIVATED",
        policyRevision: 0,
        policyVersion: "automatic-memory-v2",
        extractorVersion: "closed-structured-v2",
        sourceHash: crypto.createHash("sha256")
          .update(`source-${input.label}`)
          .digest("hex"),
        outputHash: version.contentHash,
        confidence: 1,
        reasonCode: "automatic_low_risk_activation",
        decisionHash: crypto.createHash("sha256")
          .update(`decision-${input.label}-${candidate.id}`)
          .digest("hex"),
      },
    });
  }
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
      suppressedAt: null,
    },
  });

  return {
    run,
    candidate: approvedCandidate,
    memory: activeMemory,
    version,
  };
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

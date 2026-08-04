import { createHash, randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { approveMemoryCandidate } from "../src/memory-governance";
import {
  runNextMemoryProjectionWrite,
  type MemoryProjectionProvider,
} from "../src/memory-projection-execution";
import {
  finalizeMemoryUseGenerationInTransaction,
  markMemoryUseItemsDisplayed,
  recordMemoryUseSearchHits,
  startOrReuseMemoryUseRun,
} from "../src/memory-use-execution";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("Memory use PostgreSQL execution", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("tracks search, injection, citation, and Web display without crossing contacts", async () => {
    const fixture = await createFixture();
    const started = await startOrReuseMemoryUseRun({
      generationRunId: fixture.generationRunId,
      sourceChannel: "web",
    }, { client: prisma });
    await expect(startOrReuseMemoryUseRun({
      generationRunId: fixture.generationRunId,
      sourceChannel: "web",
    }, { client: prisma })).resolves.toMatchObject({
      replayed: true,
      run: { id: started.run.id },
    });

    const recorded = await recordMemoryUseSearchHits({
      useRunId: started.run.id,
      hits: [
        {
          sourceKind: "CONTACT_MEMORY",
          projectionItemId: fixture.contactAProjectionId,
          searchRank: 1,
          searchScore: 0.96,
        },
        {
          sourceKind: "CONTACT_MEMORY",
          projectionItemId: fixture.contactBProjectionId,
          searchRank: 2,
          searchScore: 0.85,
        },
        {
          sourceKind: "PUBLIC_KNOWLEDGE",
          publicKnowledgeProjectionId: fixture.publicProjectionId,
          searchRank: 3,
          searchScore: 0.75,
        },
      ],
    }, { client: prisma });

    expect(recorded).toMatchObject({
      anonymousRejectedCount: 1,
      run: {
        unmappedCandidateCount: 1,
        searchedCount: 2,
        scopePassedCount: 2,
        safetyPassedCount: 2,
        injectedCount: 0,
        citedCount: 0,
        displayedCount: 0,
      },
    });
    expect(recorded.eligibleItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceKind: "CONTACT_MEMORY",
        projectionItemId: fixture.contactAProjectionId,
      }),
      expect.objectContaining({
        sourceKind: "PUBLIC_KNOWLEDGE",
        publicKnowledgeProjectionId: fixture.publicProjectionId,
      }),
    ]));
    expect(recorded.eligibleItems).toHaveLength(2);

    const contactItem = recorded.eligibleItems.find(
      (item) => item.sourceKind === "CONTACT_MEMORY",
    )!;
    const publicItem = recorded.eligibleItems.find(
      (item) => item.sourceKind === "PUBLIC_KNOWLEDGE",
    )!;
    const finalized = await prisma.$transaction(async (tx) => {
      const output = await tx.message.create({
        data: {
          conversationId: fixture.conversationAId,
          senderType: "REPRESENTATIVE",
          deliveryStatus: "ACCEPTED",
          text: "A concise response grounded in approved memory.",
        },
      });
      await tx.generationRun.update({
        where: { id: fixture.generationRunId },
        data: {
          outputMessageId: output.id,
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
      const result = await finalizeMemoryUseGenerationInTransaction(tx, {
        useRunId: started.run.id,
        outputMessageId: output.id,
        injectedItemIds: [contactItem.memoryUseItemId, publicItem.memoryUseItemId],
        citedItemIds: [contactItem.memoryUseItemId, publicItem.memoryUseItemId],
      });
      return { output, result };
    });

    expect(finalized.result.run).toMatchObject({
      status: "COMPLETED",
      searchedCount: 2,
      scopePassedCount: 2,
      safetyPassedCount: 2,
      injectedCount: 2,
      citedCount: 2,
      displayedCount: 0,
    });
    await expect(prisma.messageCitation.findMany({
      where: { messageId: finalized.output.id },
      select: {
        title: true,
        excerpt: true,
        knowledgeAssetId: true,
        knowledgeRevision: true,
      },
      orderBy: { title: "asc" },
    })).resolves.toEqual([
      {
        title: "本人历史信息",
        excerpt: null,
        knowledgeAssetId: null,
        knowledgeRevision: null,
      },
      {
        title: "身份",
        excerpt: null,
        knowledgeAssetId: null,
        knowledgeRevision: fixture.representativeVersionId,
      },
    ]);

    await prisma.message.update({
      where: { id: finalized.output.id },
      data: { deliveryStatus: "SENT" },
    });
    await expect(markMemoryUseItemsDisplayed({
      useRunId: started.run.id,
      displayedItemIds: [contactItem.memoryUseItemId, publicItem.memoryUseItemId],
    }, { client: prisma })).resolves.toMatchObject({
      displayedCount: 2,
    });
  });

  it("rolls back the output when a selected memory is withdrawn before injection", async () => {
    const fixture = await createFixture();
    const started = await startOrReuseMemoryUseRun({
      generationRunId: fixture.generationRunId,
      sourceChannel: "web",
    }, { client: prisma });
    const recorded = await recordMemoryUseSearchHits({
      useRunId: started.run.id,
      hits: [{
        sourceKind: "CONTACT_MEMORY",
        projectionItemId: fixture.contactAProjectionId,
      }],
    }, { client: prisma });
    const memoryUseItemId = recorded.eligibleItems[0]!.memoryUseItemId;

    const blockedAt = new Date();
    await prisma.governedMemory.update({
      where: { id: fixture.contactAMemoryId },
      data: {
        status: "SUPPRESSED",
        recallDisabledAt: blockedAt,
        suppressedAt: blockedAt,
      },
    });
    const outputMessageId = `rolled_back_output_${randomUUID()}`;
    await expect(prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          id: outputMessageId,
          conversationId: fixture.conversationAId,
          senderType: "REPRESENTATIVE",
          deliveryStatus: "ACCEPTED",
          text: "This output must roll back.",
        },
      });
      await tx.generationRun.update({
        where: { id: fixture.generationRunId },
        data: { outputMessageId },
      });
      await finalizeMemoryUseGenerationInTransaction(tx, {
        useRunId: started.run.id,
        outputMessageId,
        injectedItemIds: [memoryUseItemId],
        citedItemIds: [memoryUseItemId],
      });
    })).rejects.toMatchObject({ code: "memory_use_source_rejected" });

    await expect(prisma.message.findUnique({
      where: { id: outputMessageId },
    })).resolves.toBeNull();
    await expect(prisma.generationRun.findUniqueOrThrow({
      where: { id: fixture.generationRunId },
      select: { outputMessageId: true },
    })).resolves.toEqual({ outputMessageId: null });
    await expect(prisma.memoryUseRun.findUniqueOrThrow({
      where: { id: started.run.id },
      select: { status: true, injectedCount: true, citedCount: true },
    })).resolves.toEqual({
      status: "STARTED",
      injectedCount: 0,
      citedCount: 0,
    });
  });

  it("blocks a racing injection until withdrawal commits, then revalidates fail-closed", async () => {
    const fixture = await createFixture();
    const started = await startOrReuseMemoryUseRun({
      generationRunId: fixture.generationRunId,
      sourceChannel: "web",
    }, { client: prisma });
    const recorded = await recordMemoryUseSearchHits({
      useRunId: started.run.id,
      hits: [{
        sourceKind: "CONTACT_MEMORY",
        projectionItemId: fixture.contactAProjectionId,
      }],
    }, { client: prisma });
    const memoryUseItemId = recorded.eligibleItems[0]!.memoryUseItemId;
    const withdrawalLocked = createDeferred<void>();
    const releaseWithdrawal = createDeferred<void>();

    const withdrawal = prisma.$transaction(async (tx) => {
      const blockedAt = new Date();
      await tx.governedMemory.update({
        where: { id: fixture.contactAMemoryId },
        data: {
          status: "SUPPRESSED",
          recallDisabledAt: blockedAt,
          suppressedAt: blockedAt,
        },
      });
      withdrawalLocked.resolve();
      await releaseWithdrawal.promise;
    }, { timeout: 10_000 });
    await withdrawalLocked.promise;

    const outputMessageId = `racing_output_${randomUUID()}`;
    const finalizationBackendReady = createDeferred<number>();
    const finalizationOutcome = prisma.$transaction(async (tx) => {
      const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
        "SELECT pg_backend_pid()::INTEGER AS pid",
      );
      if (!backend) throw new Error("Could not identify finalization backend.");
      await tx.message.create({
        data: {
          id: outputMessageId,
          conversationId: fixture.conversationAId,
          senderType: "REPRESENTATIVE",
          deliveryStatus: "ACCEPTED",
          text: "This racing output must roll back.",
        },
      });
      await tx.generationRun.update({
        where: { id: fixture.generationRunId },
        data: {
          outputMessageId,
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
      finalizationBackendReady.resolve(backend.pid);
      return finalizeMemoryUseGenerationInTransaction(tx, {
        useRunId: started.run.id,
        outputMessageId,
        injectedItemIds: [memoryUseItemId],
        citedItemIds: [memoryUseItemId],
      });
    }, { timeout: 10_000 }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const finalizationBackendPid = await finalizationBackendReady.promise;
    await waitForBackendLock(finalizationBackendPid);
    releaseWithdrawal.resolve();
    await withdrawal;

    const outcome = await finalizationOutcome;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("Racing injection unexpectedly committed.");
    }
    expect(String(outcome.error)).toMatch(
      /memory was not active, current, independently reviewed, policy-enabled, and recall-projected at injection/u,
    );
    await expect(prisma.message.findUnique({
      where: { id: outputMessageId },
    })).resolves.toBeNull();
    await expect(prisma.generationRun.findUniqueOrThrow({
      where: { id: fixture.generationRunId },
      select: { status: true, outputMessageId: true, completedAt: true },
    })).resolves.toEqual({
      status: "PROCESSING",
      outputMessageId: null,
      completedAt: null,
    });
    await expect(prisma.memoryUseRun.findUniqueOrThrow({
      where: { id: started.run.id },
      select: { status: true, injectedCount: true, citedCount: true },
    })).resolves.toEqual({
      status: "STARTED",
      injectedCount: 0,
      citedCount: 0,
    });
  });
});

async function createFixture() {
  const suffix = randomUUID();
  const owner = await prisma.owner.create({
    data: { displayName: `Memory use owner ${suffix}` },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `memory-use-${suffix}`,
      displayName: "Memory use representative",
      roleSummary: "Tests the authoritative memory-use ledger.",
      tone: "clear",
      languages: ["en"],
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
  await prisma.representativeMemoryPolicy.create({
    data: {
      representativeId: representative.id,
      namespaceKey: `memory-use-${suffix}`,
      longTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      representativeExperienceEnabled: true,
      autoExtract: false,
      webRecallEnabled: true,
      webExtractEnabled: false,
    },
  });

  const contactA = await prisma.contact.create({
    data: { representativeId: representative.id, sourceChannel: "WEB" },
  });
  const contactB = await prisma.contact.create({
    data: { representativeId: representative.id, sourceChannel: "WEB" },
  });
  const conversationA = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: contactA.id,
      channel: "PRIVATE_CHAT",
      sourceChannel: "WEB",
    },
  });
  const conversationB = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: contactB.id,
      channel: "PRIVATE_CHAT",
      sourceChannel: "WEB",
    },
  });

  const contactAMemory = await createApprovedContactMemory({
    ownerId: owner.id,
    representativeId: representative.id,
    representativeSlug: representative.slug,
    contactId: contactA.id,
    conversationId: conversationA.id,
    preference: "concise",
    suffix: `${suffix}-a`,
  });
  const contactBMemory = await createApprovedContactMemory({
    ownerId: owner.id,
    representativeId: representative.id,
    representativeSlug: representative.slug,
    contactId: contactB.id,
    conversationId: conversationB.id,
    preference: "detailed",
    suffix: `${suffix}-b`,
  });
  const provider = new SuccessfulProjectionProvider();
  await runNextMemoryProjectionWrite({
    client: prisma,
    representativeId: representative.id,
    provider,
  });
  await runNextMemoryProjectionWrite({
    client: prisma,
    representativeId: representative.id,
    provider,
  });

  const inputMessage = await prisma.message.create({
    data: {
      conversationId: conversationA.id,
      senderType: "AUDIENCE",
      text: "How should I proceed?",
    },
  });
  const generationRun = await prisma.generationRun.create({
    data: {
      conversationId: conversationA.id,
      inputMessageId: inputMessage.id,
      representativeVersionId: representativeVersion.id,
      status: "PROCESSING",
      idempotencyKey: `memory-use-generation-${suffix}`,
    },
  });
  const publicHash = createHash("sha256")
    .update(`published-profile-${suffix}`)
    .digest("hex");
  await prisma.representativeVersionResource.create({
    data: {
      representativeId: representative.id,
      publishedVersionId: representativeVersion.id,
      sourceKind: "REPRESENTATIVE_VERSION_RESOURCE",
      resourceKey: "identity/profile.md",
      contentHash: publicHash,
    },
  });
  const publicProjection = await prisma.publicKnowledgeProjectionItem.create({
    data: {
      representativeId: representative.id,
      publishedVersionId: representativeVersion.id,
      sourceKind: "REPRESENTATIVE_VERSION_RESOURCE",
      resourceKey: "identity/profile.md",
      contentHash: publicHash,
      remoteUri:
        `viking://resources/delegate/reps/${representative.slug}/versions/`
        + `${representativeVersion.id}/identity/profile.md`,
      projectedAt: new Date(),
    },
  });

  return {
    representativeVersionId: representativeVersion.id,
    conversationAId: conversationA.id,
    generationRunId: generationRun.id,
    contactAMemoryId: contactAMemory.memoryId,
    contactAProjectionId: contactAMemory.projectionId,
    contactBProjectionId: contactBMemory.projectionId,
    publicProjectionId: publicProjection.id,
  };
}

async function createApprovedContactMemory(input: {
  ownerId: string;
  representativeId: string;
  representativeSlug: string;
  contactId: string;
  conversationId: string;
  preference: "concise" | "detailed";
  suffix: string;
}) {
  const sourceMessage = await prisma.message.create({
    data: {
      conversationId: input.conversationId,
      senderType: "AUDIENCE",
      text: `I prefer ${input.preference} replies`,
    },
  });
  const safeText = `Preference: reply_length=${input.preference}`;
  const contentHash = createHash("sha256").update(safeText).digest("hex");
  const candidate = await prisma.memoryCandidate.create({
    data: {
      representativeId: input.representativeId,
      contactId: input.contactId,
      scope: "CONTACT_CHANNEL",
      scopeChannel: "WEB",
      originChannel: "WEB",
      category: "CONTACT_PREFERENCE",
      sourceKind: "AUDIENCE_MESSAGE",
      safeText,
      summary: safeText,
      contentHash,
      dedupeKey: `memory-use-candidate-${input.suffix}`,
      status: "PENDING_REVIEW",
      safetyClass: "LOW_RISK",
      extractionReasonCode: "explicit_contact_preference",
      sourceContactId: input.contactId,
      sourceConversationId: input.conversationId,
      sourceMessageId: sourceMessage.id,
    },
  });
  const approved = await approveMemoryCandidate({
    actorOwnerId: input.ownerId,
    representativeSlug: input.representativeSlug,
    candidateId: candidate.id,
    requestId: `memory-use-approve-${input.suffix}`,
    idempotencyKey: `memory-use-approve-${input.suffix}`,
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
    memoryId: approved.memoryId,
    projectionId: projection.id,
  };
}

class SuccessfulProjectionProvider implements MemoryProjectionProvider {
  readonly name = "openviking";

  async ensureRoot(input: { rootUri: string }) {
    return { rootUri: input.rootUri, receipt: `ensure:${input.rootUri}` };
  }

  async writeExact(input: { uri: string; contentHash: string }) {
    return {
      uri: input.uri,
      contentHash: input.contentHash,
      receipt: `write:${input.uri}`,
    };
  }

  async inspectExact(input: { uri: string }) {
    const projection = await prisma.memoryProjectionItem.findFirstOrThrow({
      where: { remoteUri: input.uri },
      select: { contentHash: true },
    });
    return {
      uri: input.uri,
      exists: true,
      contentHash: projection.contentHash,
      receipt: `inspect:${input.uri}`,
    };
  }

  async deleteExact(input: { uri: string }) {
    return {
      uri: input.uri,
      outcome: "deleted" as const,
      receipt: `delete:${input.uri}`,
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

async function waitForBackendLock(pid: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
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
  throw new Error(`Backend ${pid} did not block on the withdrawal row lock.`);
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for Memory use PostgreSQL E2E.");
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host)
    || !["test", "e2e", "delegate"].some((marker) => database.includes(marker))
  ) {
    throw new Error(`Refusing Memory use PostgreSQL E2E against ${host}/${database}.`);
  }
}

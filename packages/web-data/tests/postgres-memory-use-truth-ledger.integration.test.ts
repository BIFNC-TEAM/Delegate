import { createHash, randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("Memory use PostgreSQL truth ledger guards", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("derives five-stage counts, requires proven citations, and preserves retention", async () => {
    const fixture = await createUseFixture("truth");
    const now = new Date();
    await createRepresentativeResourceManifest(fixture);

    await prisma.$executeRawUnsafe(`
      INSERT INTO "PublicKnowledgeProjectionItem" (
        "id", "representativeId", "publishedVersionId", "sourceKind",
        "resourceKey", "provider", "contentHash", "remoteUri", "projectedAt"
      ) VALUES (
        '${fixture.projectionId}', '${fixture.representative.id}',
        '${fixture.version.id}',
        'REPRESENTATIVE_VERSION_RESOURCE'::"PublicKnowledgeProjectionSourceKind",
        'identity/profile.md', 'openviking', '${fixture.contentHash}',
        '${fixture.remoteUri}', CURRENT_TIMESTAMP
      )
    `);

    await expect(prisma.$executeRawUnsafe(`
      INSERT INTO "MemoryUseRun" (
        "id", "representativeId", "conversationId", "contactId",
        "sourceChannel", "representativeVersionId", "inputMessageId",
        "outputMessageId", "generationRunId", "idempotencyKey", "updatedAt"
      ) VALUES (
        'missing_generation_${fixture.suffix}', '${fixture.representative.id}',
        '${fixture.conversation.id}', '${fixture.contact.id}',
        'WEB'::"RepresentativeChannelKind", '${fixture.version.id}',
        '${fixture.inputMessage.id}', '${fixture.outputMessage.id}',
        'missing_generation_${fixture.suffix}', 'missing-generation-${fixture.suffix}',
        CURRENT_TIMESTAMP
      )
    `)).rejects.toThrow();

    await createUseRun(fixture);
    await createInjectedPublicItem({
      fixture,
      itemId: fixture.itemId,
      now,
    });

    await expect(prisma.$executeRawUnsafe(`
      UPDATE "MemoryUseRun"
         SET "searchedCount" = 99
       WHERE "id" = '${fixture.useRunId}'
    `)).rejects.toThrow(/mapped memory use counts are maintained only from use items/u);

    await expect(prisma.$executeRawUnsafe(`
      UPDATE "MemoryUseRun"
         SET "unmappedCandidateCount" = 3,
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = '${fixture.useRunId}'
    `)).rejects.toThrow(/maintained from anonymous observations/u);
    await prisma.memoryUseUnmappedObservation.create({
      data: {
        useRunId: fixture.useRunId,
        representativeId: fixture.representative.id,
        observationKey: hashOf("three anonymous candidates"),
        candidateCount: 3,
      },
    });

    const unprovenCitationId = `citation_unproven_${fixture.suffix}`;
    await expect(prisma.$executeRawUnsafe(`
      INSERT INTO "MessageCitation" (
        "id", "messageId", "title", "createdAt"
      ) VALUES (
        '${unprovenCitationId}', '${fixture.outputMessage.id}',
        'Unproven source', CURRENT_TIMESTAMP
      )
    `)).rejects.toThrow(/must be linked to an injected and explicitly cited use item/u);

    const citationId = `citation_${fixture.suffix}`;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "MessageCitation" (
          "id", "messageId", "knowledgeRevision", "title", "excerpt", "createdAt"
        ) VALUES (
          '${citationId}', '${fixture.outputMessage.id}', '${fixture.version.id}',
          'Published identity', 'Verified public source.', CURRENT_TIMESTAMP
        )
      `);
      await tx.$executeRawUnsafe(`
        UPDATE "MemoryUseItem"
           SET "citationId" = '${citationId}',
               "citedAt" = CURRENT_TIMESTAMP,
               "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = '${fixture.itemId}'
      `);
    });

    await prisma.$executeRawUnsafe(`
      INSERT INTO "MemoryUseItem" (
        "id", "useRunId", "representativeId", "itemKey", "sourceKind",
        "publicKnowledgeProjectionId", "contentHash", "searchedAt",
        "scopeCheckedAt", "rejectionReasonCode", "createdAt", "updatedAt"
      ) VALUES (
        'rejected_item_${fixture.suffix}', '${fixture.useRunId}',
        '${fixture.representative.id}', 'rejected-${fixture.suffix}',
        'PUBLIC_KNOWLEDGE'::"MemoryUseSourceKind", '${fixture.projectionId}',
        '${fixture.contentHash}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        'scope_mismatch', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `);
    await expect(prisma.$executeRawUnsafe(`
      UPDATE "MemoryUseItem"
         SET "scopePassedAt" = CURRENT_TIMESTAMP,
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = 'rejected_item_${fixture.suffix}'
    `)).rejects.toThrow(/rejected use item cannot advance/u);

    await prisma.$executeRawUnsafe(`
      UPDATE "MemoryUseRun"
         SET "status" = 'COMPLETED'::"MemoryUseRunStatus",
             "completedAt" = CURRENT_TIMESTAMP,
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = '${fixture.useRunId}'
    `);
    await expect(prisma.$executeRawUnsafe(`
      UPDATE "MemoryUseRun"
         SET "unmappedCandidateCount" = 4,
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = '${fixture.useRunId}'
    `)).rejects.toThrow(/unmapped candidate count is append-only/u);

    await expect(prisma.$executeRawUnsafe(`
      UPDATE "MemoryUseItem"
         SET "displayedAt" = CURRENT_TIMESTAMP,
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = '${fixture.itemId}'
    `)).rejects.toThrow(/successfully delivered Web response/u);
    await prisma.message.update({
      where: { id: fixture.outputMessage.id },
      data: { deliveryStatus: "SENT" },
    });
    await prisma.$executeRawUnsafe(`
      UPDATE "MemoryUseItem"
         SET "displayedAt" = CURRENT_TIMESTAMP,
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = '${fixture.itemId}'
    `);

    const [counts] = await prisma.$queryRawUnsafe<Array<{
      unmappedCandidateCount: number;
      searchedCount: number;
      scopePassedCount: number;
      safetyPassedCount: number;
      injectedCount: number;
      citedCount: number;
      displayedCount: number;
    }>>(`
      SELECT "unmappedCandidateCount", "searchedCount", "scopePassedCount",
             "safetyPassedCount", "injectedCount", "citedCount", "displayedCount"
        FROM "MemoryUseRun"
       WHERE "id" = '${fixture.useRunId}'
    `);
    expect(counts).toEqual({
      unmappedCandidateCount: 3,
      searchedCount: 2,
      scopePassedCount: 1,
      safetyPassedCount: 1,
      injectedCount: 1,
      citedCount: 1,
      displayedCount: 1,
    });

    await prisma.message.delete({ where: { id: fixture.outputMessage.id } });
    const retainedRuns = await prisma.$queryRawUnsafe<Array<{
      outputMessageId: string | null;
    }>>(`
      SELECT "outputMessageId"
        FROM "MemoryUseRun"
       WHERE "id" = '${fixture.useRunId}'
    `);
    const retainedItems = await prisma.$queryRawUnsafe<Array<{
      citationId: string | null;
      cited: boolean;
      displayed: boolean;
      citationPurged: boolean;
    }>>(`
      SELECT "citationId", "citedAt" IS NOT NULL AS cited,
             "displayedAt" IS NOT NULL AS displayed,
             "citationPurgedAt" IS NOT NULL AS "citationPurged"
        FROM "MemoryUseItem"
       WHERE "id" = '${fixture.itemId}'
    `);
    expect(retainedRuns[0]!.outputMessageId).toBeNull();
    expect(retainedItems[0]).toEqual({
      citationId: null,
      cited: true,
      displayed: true,
      citationPurged: true,
    });

    await prisma.generationRun.delete({ where: { id: fixture.generationRun.id } });
    const runCounts = await prisma.$queryRawUnsafe<Array<{ runCount: bigint }>>(`
      SELECT COUNT(*) AS "runCount"
        FROM "MemoryUseRun"
       WHERE "id" = '${fixture.useRunId}'
    `);
    const itemCounts = await prisma.$queryRawUnsafe<Array<{ itemCount: bigint }>>(`
      SELECT COUNT(*) AS "itemCount"
        FROM "MemoryUseItem"
       WHERE "useRunId" = '${fixture.useRunId}'
    `);
    expect(runCounts[0]!.runCount).toBe(0n);
    expect(itemCounts[0]!.itemCount).toBe(0n);
  });

  it("requires an immutable manifest and forbids published snapshot mutation", async () => {
    const fixture = await createUseFixture("immutable-manifest");

    await expect(prisma.$executeRawUnsafe(`
      INSERT INTO "PublicKnowledgeProjectionItem" (
        "id", "representativeId", "publishedVersionId", "sourceKind",
        "resourceKey", "provider", "contentHash", "remoteUri", "projectedAt"
      ) VALUES (
        '${fixture.projectionId}', '${fixture.representative.id}',
        '${fixture.version.id}',
        'REPRESENTATIVE_VERSION_RESOURCE'::"PublicKnowledgeProjectionSourceKind",
        'identity/profile.md', 'openviking', '${fixture.contentHash}',
        '${fixture.remoteUri}', CURRENT_TIMESTAMP
      )
    `)).rejects.toThrow(/immutable published resource manifest/u);

    await createRepresentativeResourceManifest(fixture);
    await expect(prisma.representativeVersionResource.update({
      where: {
        publishedVersionId_resourceKey: {
          publishedVersionId: fixture.version.id,
          resourceKey: "identity/profile.md",
        },
      },
      data: { contentHash: hashOf("mutated resource") },
    })).rejects.toThrow(/resource manifests are immutable/u);
    await expect(prisma.representativeVersionResource.delete({
      where: {
        publishedVersionId_resourceKey: {
          publishedVersionId: fixture.version.id,
          resourceKey: "identity/profile.md",
        },
      },
    })).rejects.toThrow(/resource manifests cannot be deleted/u);
    await expect(prisma.representativeVersion.update({
      where: { id: fixture.version.id },
      data: { snapshot: { knowledgeAssets: [], mutated: true } },
    })).rejects.toThrow(/published representative versions are immutable/u);
    await expect(prisma.representativeVersion.delete({
      where: { id: fixture.version.id },
    })).rejects.toThrow(/published representative versions cannot be deleted/u);
  });

  it("keeps immutable published bytes after its KnowledgeAsset changes and is deleted", async () => {
    const suffix = randomUUID();
    const publishedText = `Published content ${suffix}`;
    const contentHash = hashOf(publishedText);
    const owner = await prisma.owner.create({
      data: { displayName: `Knowledge receipt ${suffix}` },
    });
    const representative = await prisma.representative.create({
      data: {
        ownerId: owner.id,
        slug: `knowledge-receipt-${suffix}`,
        displayName: "Knowledge receipt representative",
        roleSummary: "Tests an immutable public knowledge receipt.",
        tone: "clear",
        languages: ["en"],
        freeScope: [],
        paywalledIntents: [],
        handoffPrompt: "Escalate.",
        allowedSkills: [],
        actionGate: {},
      },
    });
    const asset = await prisma.knowledgeAsset.create({
      data: {
        ownerId: owner.id,
        kind: "TEXT",
        status: "READY",
        visibility: "PUBLIC_MATERIAL",
        title: "Published asset",
        sourceText: publishedText,
        extractedText: publishedText,
        checksum: contentHash,
        processingVersion: 7,
      },
    });
    await prisma.knowledgeAssetRepresentative.create({
      data: {
        assetId: asset.id,
        representativeId: representative.id,
        reviewStatus: "APPROVED",
        enabled: true,
      },
    });
    const version = await prisma.representativeVersion.create({
      data: {
        representativeId: representative.id,
        versionNumber: 1,
        status: "PUBLISHED",
        snapshot: {
          knowledgeAssets: [{
            assetId: asset.id,
            checksum: contentHash,
            processingVersion: 7,
          }],
        },
      },
    });
    const projectionId = `asset_projection_${suffix}`;
    const remoteUri = `viking://resources/delegate/reps/${representative.slug}/versions/${version.id}/knowledge/${asset.id}.md`;
    await expect(prisma.representativeVersionResource.findUniqueOrThrow({
      where: {
        publishedVersionId_resourceKey: {
          publishedVersionId: version.id,
          resourceKey: `knowledge/${asset.id}.md`,
        },
      },
      select: { safeText: true, citationTitle: true, contentHash: true },
    })).resolves.toEqual({
      safeText: publishedText,
      citationTitle: "Published asset",
      contentHash,
    });

    const editedText = `Edited draft ${suffix}`;
    await prisma.knowledgeAsset.update({
      where: { id: asset.id },
      data: {
        title: "Edited draft title",
        sourceText: editedText,
        extractedText: editedText,
        checksum: hashOf(editedText),
        processingVersion: 8,
      },
    });
    await prisma.$executeRawUnsafe(`
      INSERT INTO "PublicKnowledgeProjectionItem" (
        "id", "representativeId", "publishedVersionId", "sourceKind",
        "resourceKey", "knowledgeAssetId", "provider", "contentHash",
        "remoteUri", "projectedAt"
      ) VALUES (
        '${projectionId}', '${representative.id}', '${version.id}',
        'KNOWLEDGE_ASSET'::"PublicKnowledgeProjectionSourceKind",
        'knowledge/${asset.id}.md', '${asset.id}', 'openviking',
        '${contentHash}', '${remoteUri}', CURRENT_TIMESTAMP
      )
    `);

    await prisma.knowledgeAsset.delete({ where: { id: asset.id } });

    const [receipt] = await prisma.$queryRawUnsafe<Array<{
      knowledgeAssetId: string;
      remoteUri: string;
    }>>(`
      SELECT "knowledgeAssetId", "remoteUri"
        FROM "PublicKnowledgeProjectionItem"
       WHERE "id" = '${projectionId}'
    `);
    expect(receipt).toEqual({ knowledgeAssetId: asset.id, remoteUri });
    await expect(prisma.representativeVersionResource.findUniqueOrThrow({
      where: {
        publishedVersionId_resourceKey: {
          publishedVersionId: version.id,
          resourceKey: `knowledge/${asset.id}.md`,
        },
      },
      select: { safeText: true, citationTitle: true, contentHash: true },
    })).resolves.toEqual({
      safeText: publishedText,
      citationTitle: "Published asset",
      contentHash,
    });
  });

  it.each(["MATRIX", "TELEGRAM"] as const)(
    "does not count a SENT %s reply as publicly displayed memory",
    async (sourceChannel) => {
      const fixture = await createUseFixture(
        `non-web-${sourceChannel.toLowerCase()}`,
        sourceChannel,
      );
      const now = new Date();
      await createRepresentativeResourceManifest(fixture);

      await prisma.$executeRawUnsafe(`
        INSERT INTO "PublicKnowledgeProjectionItem" (
          "id", "representativeId", "publishedVersionId", "sourceKind",
          "resourceKey", "provider", "contentHash", "remoteUri", "projectedAt"
        ) VALUES (
          '${fixture.projectionId}', '${fixture.representative.id}',
          '${fixture.version.id}',
          'REPRESENTATIVE_VERSION_RESOURCE'::"PublicKnowledgeProjectionSourceKind",
          'identity/profile.md', 'openviking', '${fixture.contentHash}',
          '${fixture.remoteUri}', CURRENT_TIMESTAMP
        )
      `);
      await createUseRun(fixture);
      await createInjectedPublicItem({
        fixture,
        itemId: fixture.itemId,
        now,
      });

      const citationId = `citation_non_web_${fixture.suffix}`;
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`
          INSERT INTO "MessageCitation" (
            "id", "messageId", "knowledgeRevision", "title", "createdAt"
          ) VALUES (
            '${citationId}', '${fixture.outputMessage.id}', '${fixture.version.id}',
            'Published identity', CURRENT_TIMESTAMP
          )
        `);
        await tx.$executeRawUnsafe(`
          UPDATE "MemoryUseItem"
             SET "citationId" = '${citationId}',
                 "citedAt" = CURRENT_TIMESTAMP,
                 "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = '${fixture.itemId}'
        `);
      });
      await prisma.$executeRawUnsafe(`
        UPDATE "MemoryUseRun"
           SET "status" = 'COMPLETED'::"MemoryUseRunStatus",
               "completedAt" = CURRENT_TIMESTAMP,
               "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = '${fixture.useRunId}'
      `);
      await prisma.message.update({
        where: { id: fixture.outputMessage.id },
        data: { deliveryStatus: "SENT" },
      });

      await expect(prisma.$executeRawUnsafe(`
        UPDATE "MemoryUseItem"
           SET "displayedAt" = CURRENT_TIMESTAMP,
               "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = '${fixture.itemId}'
      `)).rejects.toThrow(/successfully delivered Web response/u);
      await expect(prisma.memoryUseRun.findUniqueOrThrow({
        where: { id: fixture.useRunId },
        select: { displayedCount: true },
      })).resolves.toEqual({ displayedCount: 0 });
    },
  );

  it.each([
    { status: "COMPLETED", bindOutput: false, failDelivery: false },
    { status: "DEGRADED", bindOutput: true, failDelivery: true },
  ] as const)(
    "rejects a $status use run without a completed deliverable generation output",
    async ({ status, bindOutput, failDelivery }) => {
      const fixture = await createUseFixture(`terminal-${status.toLowerCase()}`);
      await createUseRun(fixture, { bindOutput });
      if (failDelivery) {
        await prisma.message.update({
          where: { id: fixture.outputMessage.id },
          data: { deliveryStatus: "FAILED" },
        });
      }

      await expect(prisma.$executeRawUnsafe(`
        UPDATE "MemoryUseRun"
           SET "status" = '${status}'::"MemoryUseRunStatus",
               "completedAt" = CURRENT_TIMESTAMP,
               "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = '${fixture.useRunId}'
      `)).rejects.toThrow(
        /completed memory use must bind the completed generation representative output/u,
      );
      await expect(prisma.memoryUseRun.findUniqueOrThrow({
        where: { id: fixture.useRunId },
        select: { status: true, completedAt: true },
      })).resolves.toEqual({ status: "STARTED", completedAt: null });
    },
  );

  it("rejects a knowledge projection owned by someone other than the representative owner", async () => {
    const suffix = randomUUID();
    const contentHash = hashOf(`foreign-owner-asset-${suffix}`);
    const [representativeOwner, foreignOwner] = await Promise.all([
      prisma.owner.create({
        data: { displayName: `Representative owner ${suffix}` },
      }),
      prisma.owner.create({
        data: { displayName: `Foreign knowledge owner ${suffix}` },
      }),
    ]);
    const representative = await prisma.representative.create({
      data: {
        ownerId: representativeOwner.id,
        slug: `foreign-knowledge-${suffix}`,
        displayName: "Foreign knowledge representative",
        roleSummary: "Tests knowledge ownership isolation.",
        tone: "clear",
        languages: ["en"],
        freeScope: [],
        paywalledIntents: [],
        handoffPrompt: "Escalate.",
        allowedSkills: [],
        actionGate: {},
      },
    });
    const foreignAsset = await prisma.knowledgeAsset.create({
      data: {
        ownerId: foreignOwner.id,
        kind: "TEXT",
        status: "READY",
        visibility: "PUBLIC_MATERIAL",
        title: "Foreign owner's asset",
        sourceText: "This must not cross owner scope.",
        extractedText: "This must not cross owner scope.",
        checksum: contentHash,
        processingVersion: 1,
      },
    });
    await prisma.knowledgeAssetRepresentative.create({
      data: {
        assetId: foreignAsset.id,
        representativeId: representative.id,
        reviewStatus: "APPROVED",
        enabled: true,
      },
    });
    await expect(prisma.representativeVersion.create({
      data: {
        representativeId: representative.id,
        versionNumber: 1,
        status: "PUBLISHED",
        snapshot: {
          knowledgeAssets: [{
            assetId: foreignAsset.id,
            checksum: contentHash,
            processingVersion: 1,
          }],
        },
      },
    })).rejects.toThrow(
      /published knowledge asset pin no longer matches approved authoritative bytes/u,
    );
    await expect(prisma.representativeVersion.findFirst({
      where: { representativeId: representative.id, versionNumber: 1 },
    })).resolves.toBeNull();
  });
});

async function createUseFixture(
  label: string,
  sourceChannel: "WEB" | "MATRIX" | "TELEGRAM" = "WEB",
) {
  const suffix = randomUUID();
  const owner = await prisma.owner.create({
    data: { displayName: `Memory use ${label} ${suffix}` },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `memory-use-${label}-${suffix}`,
      displayName: "Memory use representative",
      roleSummary: "Tests use truth boundaries.",
      tone: "clear",
      languages: ["en"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
    },
  });
  const version = await prisma.representativeVersion.create({
    data: {
      representativeId: representative.id,
      versionNumber: 1,
      status: "PUBLISHED",
      snapshot: { knowledgeAssets: [] },
    },
  });
  await prisma.representative.update({
    where: { id: representative.id },
    data: { activeVersionId: version.id },
  });
  const contact = await prisma.contact.create({
    data: { representativeId: representative.id, sourceChannel },
  });
  const conversation = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: contact.id,
      channel: "PRIVATE_CHAT",
      sourceChannel,
    },
  });
  const inputMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      senderType: "AUDIENCE",
      text: "Who are you?",
    },
  });
  const outputMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      senderType: "REPRESENTATIVE",
      text: "A grounded response.",
    },
  });
  const generationRun = await prisma.generationRun.create({
    data: {
      conversationId: conversation.id,
      inputMessageId: inputMessage.id,
      outputMessageId: outputMessage.id,
      representativeVersionId: version.id,
      idempotencyKey: `memory-use-generation-${suffix}`,
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
  const contentHash = hashOf(`identity-${suffix}`);
  const projectionId = `public_projection_${suffix}`;
  return {
    suffix,
    representative,
    version,
    contact,
    conversation,
    inputMessage,
    outputMessage,
    generationRun,
    sourceChannel,
    contentHash,
    projectionId,
    useRunId: `use_run_${suffix}`,
    itemId: `use_item_${suffix}`,
    remoteUri: `viking://resources/delegate/reps/${representative.slug}/versions/${version.id}/identity/profile.md`,
  };
}

async function createUseRun(
  fixture: Awaited<ReturnType<typeof createUseFixture>>,
  options: { bindOutput?: boolean } = {},
) {
  const outputMessageId = options.bindOutput === false
    ? "NULL"
    : `'${fixture.outputMessage.id}'`;
  await prisma.$executeRawUnsafe(`
    INSERT INTO "MemoryUseRun" (
      "id", "representativeId", "conversationId", "contactId",
      "sourceChannel", "representativeVersionId", "inputMessageId",
      "outputMessageId", "generationRunId", "idempotencyKey", "updatedAt"
    ) VALUES (
      '${fixture.useRunId}', '${fixture.representative.id}',
      '${fixture.conversation.id}', '${fixture.contact.id}',
      '${fixture.sourceChannel}'::"RepresentativeChannelKind", '${fixture.version.id}',
      '${fixture.inputMessage.id}', ${outputMessageId},
      '${fixture.generationRun.id}', 'memory-use-${fixture.suffix}', CURRENT_TIMESTAMP
    )
  `);
}

async function createInjectedPublicItem(input: {
  fixture: Awaited<ReturnType<typeof createUseFixture>>;
  itemId: string;
  now: Date;
}) {
  const timestamp = input.now.toISOString();
  await prisma.$executeRawUnsafe(`
    INSERT INTO "MemoryUseItem" (
      "id", "useRunId", "representativeId", "itemKey", "sourceKind",
      "publicKnowledgeProjectionId", "contentHash", "searchRank", "searchScore",
      "searchedAt", "scopeCheckedAt", "scopePassedAt", "safetyCheckedAt",
      "safetyPassedAt", "injectedAt", "createdAt", "updatedAt"
    ) VALUES (
      '${input.itemId}', '${input.fixture.useRunId}',
      '${input.fixture.representative.id}', 'identity-${input.fixture.suffix}',
      'PUBLIC_KNOWLEDGE'::"MemoryUseSourceKind", '${input.fixture.projectionId}',
      '${input.fixture.contentHash}', 1, 0.99, '${timestamp}', '${timestamp}',
      '${timestamp}', '${timestamp}', '${timestamp}', '${timestamp}',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `);
}

async function createRepresentativeResourceManifest(
  fixture: Awaited<ReturnType<typeof createUseFixture>>,
) {
  const safeText = `identity-${fixture.suffix}`;
  await prisma.representativeVersionResource.create({
    data: {
      publishedVersionId: fixture.version.id,
      representativeId: fixture.representative.id,
      sourceKind: "REPRESENTATIVE_VERSION_RESOURCE",
      resourceKey: "identity/profile.md",
      contentHash: fixture.contentHash,
      safeText,
      citationTitle: "Published identity",
    },
  });
}

function hashOf(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) throw new Error("DATABASE_URL is required for memory use PostgreSQL E2E.");
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host)
    || !["test", "e2e", "delegate"].some((marker) => database.includes(marker))
  ) {
    throw new Error(`Refusing memory use PostgreSQL E2E against ${host}/${database}.`);
  }
}

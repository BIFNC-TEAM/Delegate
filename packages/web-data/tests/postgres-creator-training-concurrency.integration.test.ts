import {
  CreatorTrainingSuggestionStatus,
  CreatorTrainingSuggestionType,
  CreatorTrainingVersionStatus,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildCreatorTrainingSuggestions,
  listCreatorTrainingVersions,
  reviewCreatorTrainingSuggestion,
  rollbackCreatorTrainingVersion,
} from "../src/creator-training";
import { prisma } from "../src/prisma";
import {
  getRepresentativeSetupSnapshot,
  updateRepresentativeSetup,
  type RepresentativeSetupSnapshot,
  type RepresentativeSetupUpdateInput,
} from "../src/representative-setup";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("creator training PostgreSQL concurrency", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("preserves both KnowledgePack updates when different suggestions are approved concurrently", async () => {
    const fixture = await createFixture(2);

    try {
      await Promise.all(
        fixture.suggestionIds.map((suggestionId) =>
          reviewCreatorTrainingSuggestion(
            fixture.representativeSlug,
            suggestionId,
            { action: "approve", reviewedBy: fixture.ownerId },
          ),
        ),
      );

      const [knowledgePack, versions] = await Promise.all([
        prisma.knowledgePack.findUniqueOrThrow({
          where: { representativeId: fixture.representativeId },
        }),
        prisma.creatorTrainingVersion.findMany({
          where: { representativeId: fixture.representativeId },
        }),
      ]);
      const faqIds = knowledgePackSnapshot(knowledgePack).faq
        .map((item) => recordString(item, "id"))
        .sort();

      expect(faqIds).toEqual(
        fixture.suggestionOriginKeys.map(stableTrainingId).sort(),
      );
      expect(versions).toHaveLength(2);

      const firstVersion = versions.find(
        (version) => knowledgePackSnapshot(version.snapshotBefore).faq.length === 0,
      );
      const finalVersion = versions.find(
        (version) => knowledgePackSnapshot(version.snapshotAfter).faq.length === 2,
      );
      expect(firstVersion).toBeDefined();
      expect(finalVersion).toBeDefined();
      expect(knowledgePackSnapshot(finalVersion?.snapshotBefore)).toEqual(
        knowledgePackSnapshot(firstVersion?.snapshotAfter),
      );
      expect(knowledgePackSnapshot(knowledgePack)).toEqual(
        knowledgePackSnapshot(finalVersion?.snapshotAfter),
      );
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("keeps KnowledgePack aligned with the newest version when approval races rollback", async () => {
    const fixture = await createFixture(2);

    try {
      const baseApproval = await reviewCreatorTrainingSuggestion(
        fixture.representativeSlug,
        fixture.suggestionIds[0]!,
        { action: "approve", reviewedBy: fixture.ownerId },
      );
      const baseVersion = baseApproval.version;
      if (!baseVersion) {
        throw new Error("Expected the base approval to create a version.");
      }

      const [approvalResult, rollbackResult] = await Promise.allSettled([
        reviewCreatorTrainingSuggestion(
          fixture.representativeSlug,
          fixture.suggestionIds[1]!,
          { action: "approve", reviewedBy: fixture.ownerId },
        ),
        rollbackCreatorTrainingVersion(
          fixture.representativeSlug,
          baseVersion.id,
        ),
      ]);

      expect(approvalResult.status).toBe("fulfilled");
      if (approvalResult.status !== "fulfilled" || !approvalResult.value.version) {
        throw new Error("Expected the concurrent approval to create a version.");
      }

      const [knowledgePack, versions] = await Promise.all([
        prisma.knowledgePack.findUniqueOrThrow({
          where: { representativeId: fixture.representativeId },
        }),
        prisma.creatorTrainingVersion.findMany({
          where: { representativeId: fixture.representativeId },
        }),
      ]);
      const approvedVersion = versions.find(
        (version) => version.id === approvalResult.value.version?.id,
      );
      const persistedBaseVersion = versions.find(
        (version) => version.id === baseVersion.id,
      );

      expect(approvedVersion?.status).toBe(CreatorTrainingVersionStatus.PUBLISHED);
      expect(knowledgePackSnapshot(knowledgePack)).toEqual(
        knowledgePackSnapshot(approvedVersion?.snapshotAfter),
      );

      if (rollbackResult.status === "fulfilled") {
        expect(persistedBaseVersion?.status).toBe(
          CreatorTrainingVersionStatus.ROLLED_BACK,
        );
        expect(knowledgePackSnapshot(approvedVersion?.snapshotBefore)).toEqual(
          knowledgePackSnapshot(persistedBaseVersion?.snapshotBefore),
        );
      } else {
        expect(String(rollbackResult.reason)).toContain(
          "Only the latest applied creator training version can be rolled back.",
        );
        expect(persistedBaseVersion?.status).toBe(
          CreatorTrainingVersionStatus.PUBLISHED,
        );
        expect(knowledgePackSnapshot(approvedVersion?.snapshotBefore)).toEqual(
          knowledgePackSnapshot(persistedBaseVersion?.snapshotAfter),
        );
      }
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("orders revisions by lock acquisition even when an older transaction applies later", async () => {
    const fixture = await createFixture(2);
    const olderTransactionStarted = deferred();
    const releaseOlderTransaction = deferred();
    const delayedClient = withTransactionHooks({
      beforeCallback: async (tx) => {
        await tx.$queryRaw`SELECT 1::int AS transaction_started`;
        olderTransactionStarted.resolve();
        await releaseOlderTransaction.promise;
      },
    });

    try {
      const olderTransactionApproval = reviewCreatorTrainingSuggestion(
        fixture.representativeSlug,
        fixture.suggestionIds[0]!,
        { action: "approve", reviewedBy: fixture.ownerId },
        delayedClient as never,
      );
      await olderTransactionStarted.promise;

      const firstApplied = await reviewCreatorTrainingSuggestion(
        fixture.representativeSlug,
        fixture.suggestionIds[1]!,
        { action: "approve", reviewedBy: fixture.ownerId },
      );
      releaseOlderTransaction.resolve();
      const secondApplied = await olderTransactionApproval;

      expect(firstApplied.version?.revisionNumber).toBe(1);
      expect(secondApplied.version?.revisionNumber).toBe(2);

      const listed = await listCreatorTrainingVersions(fixture.representativeSlug);
      expect(listed.map((version) => version.revisionNumber)).toEqual([2, 1]);
      await expect(
        rollbackCreatorTrainingVersion(
          fixture.representativeSlug,
          secondApplied.version!.id,
          { rolledBackBy: fixture.ownerId },
        ),
      ).resolves.toMatchObject({
        revisionNumber: 2,
        status: "rolled_back",
        rolledBackBy: fixture.ownerId,
      });
    } finally {
      releaseOlderTransaction.resolve();
      await deleteFixture(fixture);
    }
  });

  it("serializes suggestion generation before review and leaves only the successor pending", async () => {
    const fixture = await createFixture(0);
    const source = await prisma.creatorTrainingSource.create({
      data: {
        representativeId: fixture.representativeId,
        kind: "TEXT",
        status: "DRAFT",
        title: "Concurrent source",
        contentText: "Source evidence A.",
        createdBy: fixture.ownerId,
      },
    });
    const [original] = await buildCreatorTrainingSuggestions(
      fixture.representativeSlug,
    );
    if (!original) {
      throw new Error("Expected an initial source suggestion.");
    }
    await prisma.creatorTrainingSource.update({
      where: { id: source.id },
      data: { contentText: "Source evidence B." },
    });
    const generationLockAcquired = deferred();
    const releaseGeneration = deferred();
    const reviewLockAttempted = deferred();
    const generatorClient = withTransactionHooks({
      afterLockAcquired: async () => {
        generationLockAcquired.resolve();
        await releaseGeneration.promise;
      },
    });
    const reviewerClient = withTransactionHooks({
      beforeLockAttempt: async () => {
        reviewLockAttempted.resolve();
      },
    });

    try {
      const generationPromise = buildCreatorTrainingSuggestions(
        fixture.representativeSlug,
        {},
        generatorClient as never,
      );
      await generationLockAcquired.promise;
      const reviewPromise = reviewCreatorTrainingSuggestion(
        fixture.representativeSlug,
        original.id,
        { action: "approve", reviewedBy: fixture.ownerId },
        reviewerClient as never,
      );
      await reviewLockAttempted.promise;

      releaseGeneration.resolve();
      const [generationResult, reviewResult] = await Promise.allSettled([
        generationPromise,
        reviewPromise,
      ]);
      expect(generationResult.status).toBe("fulfilled");
      expect(reviewResult).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: "Creator training suggestion is no longer pending.",
        }),
      });

      const suggestions = await prisma.creatorTrainingSuggestion.findMany({
        where: {
          representativeId: fixture.representativeId,
          originKey: original.originKey,
        },
        orderBy: { createdAt: "asc" },
      });
      expect(suggestions).toHaveLength(2);
      expect(suggestions[0]).toMatchObject({
        id: original.id,
        status: CreatorTrainingSuggestionStatus.SUPERSEDED,
      });
      expect(
        suggestions.filter(
          (suggestion) =>
            suggestion.status === CreatorTrainingSuggestionStatus.PENDING,
        ),
      ).toEqual([
        expect.objectContaining({
          originKey: original.originKey,
          draftPayload: expect.objectContaining({
            summary: "Source evidence B.",
          }),
        }),
      ]);
    } finally {
      releaseGeneration.resolve();
      await deleteFixture(fixture);
    }
  });

  it("creates and publishes a new origin generation when published evidence changes A to B to A", async () => {
    const fixture = await createFixture(0);
    const source = await prisma.creatorTrainingSource.create({
      data: {
        representativeId: fixture.representativeId,
        kind: "TEXT",
        status: "DRAFT",
        title: "Published source cycle",
        contentText: "Published source evidence A.",
        createdBy: fixture.ownerId,
      },
    });

    try {
      const [firstA] = await buildCreatorTrainingSuggestions(fixture.representativeSlug);
      if (!firstA) throw new Error("Expected the first A suggestion.");
      await reviewCreatorTrainingSuggestion(
        fixture.representativeSlug,
        firstA.id,
        { action: "approve", reviewedBy: fixture.ownerId },
      );

      await prisma.creatorTrainingSource.update({
        where: { id: source.id },
        data: { contentText: "Published source evidence B." },
      });
      const [publishedB] = await buildCreatorTrainingSuggestions(fixture.representativeSlug);
      if (!publishedB) throw new Error("Expected the B suggestion.");
      await reviewCreatorTrainingSuggestion(
        fixture.representativeSlug,
        publishedB.id,
        { action: "approve", reviewedBy: fixture.ownerId },
      );

      await prisma.creatorTrainingSource.update({
        where: { id: source.id },
        data: { contentText: "Published source evidence A." },
      });
      const [revertedA] = await buildCreatorTrainingSuggestions(fixture.representativeSlug);
      const [idempotentA] = await buildCreatorTrainingSuggestions(fixture.representativeSlug);
      if (!revertedA) throw new Error("Expected the reverted A suggestion.");

      expect(revertedA).toMatchObject({
        status: "pending",
        originKey: firstA.originKey,
        originRevision: 3,
        dedupeKey: firstA.dedupeKey,
      });
      expect(revertedA.id).not.toBe(firstA.id);
      expect(revertedA.id).not.toBe(publishedB.id);
      expect(idempotentA?.id).toBe(revertedA.id);

      await reviewCreatorTrainingSuggestion(
        fixture.representativeSlug,
        revertedA.id,
        { action: "approve", reviewedBy: fixture.ownerId },
      );

      const [knowledgePack, suggestions, versions] = await Promise.all([
        prisma.knowledgePack.findUniqueOrThrow({
          where: { representativeId: fixture.representativeId },
        }),
        prisma.creatorTrainingSuggestion.findMany({
          where: {
            representativeId: fixture.representativeId,
            originKey: firstA.originKey,
          },
          orderBy: { originRevision: "asc" },
        }),
        prisma.creatorTrainingVersion.findMany({
          where: { representativeId: fixture.representativeId },
        }),
      ]);

      expect(suggestions.map((suggestion) => suggestion.originRevision)).toEqual([1, 2, 3]);
      expect(suggestions.map((suggestion) => suggestion.status)).toEqual([
        CreatorTrainingSuggestionStatus.PUBLISHED,
        CreatorTrainingSuggestionStatus.PUBLISHED,
        CreatorTrainingSuggestionStatus.PUBLISHED,
      ]);
      expect(versions).toHaveLength(3);
      expect(knowledgePackSnapshot(knowledgePack).materials).toEqual([
        expect.objectContaining({
          id: stableTrainingId(firstA.originKey),
          summary: "Published source evidence A.",
        }),
      ]);
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("does not create a duplicate generation after rollback restores the matching evidence", async () => {
    const fixture = await createFixture(0);
    const source = await prisma.creatorTrainingSource.create({
      data: {
        representativeId: fixture.representativeId,
        kind: "TEXT",
        status: "DRAFT",
        title: "Rollback-restored source",
        contentText: "Rollback-restored evidence A.",
        createdBy: fixture.ownerId,
      },
    });

    try {
      const [firstA] = await buildCreatorTrainingSuggestions(fixture.representativeSlug);
      if (!firstA) throw new Error("Expected the first A suggestion.");
      await reviewCreatorTrainingSuggestion(
        fixture.representativeSlug,
        firstA.id,
        { action: "approve", reviewedBy: fixture.ownerId },
      );

      await prisma.creatorTrainingSource.update({
        where: { id: source.id },
        data: { contentText: "Later evidence B." },
      });
      const [publishedB] = await buildCreatorTrainingSuggestions(fixture.representativeSlug);
      if (!publishedB) throw new Error("Expected the B suggestion.");
      const reviewedB = await reviewCreatorTrainingSuggestion(
        fixture.representativeSlug,
        publishedB.id,
        { action: "approve", reviewedBy: fixture.ownerId },
      );

      await rollbackCreatorTrainingVersion(
        fixture.representativeSlug,
        reviewedB.version!.id,
        { rolledBackBy: fixture.ownerId },
      );
      await prisma.creatorTrainingSource.update({
        where: { id: source.id },
        data: { contentText: "Rollback-restored evidence A." },
      });

      const [restoredA] = await buildCreatorTrainingSuggestions(fixture.representativeSlug);
      const [knowledgePack, suggestions] = await Promise.all([
        prisma.knowledgePack.findUniqueOrThrow({
          where: { representativeId: fixture.representativeId },
        }),
        prisma.creatorTrainingSuggestion.findMany({
          where: {
            representativeId: fixture.representativeId,
            originKey: firstA.originKey,
          },
          orderBy: { originRevision: "asc" },
        }),
      ]);

      expect(restoredA).toMatchObject({
        id: firstA.id,
        status: "published",
        originRevision: 1,
      });
      expect(suggestions).toHaveLength(2);
      expect(
        suggestions.filter(
          (suggestion) => suggestion.status === CreatorTrainingSuggestionStatus.PENDING,
        ),
      ).toHaveLength(0);
      expect(knowledgePackSnapshot(knowledgePack).materials).toEqual([
        expect.objectContaining({
          id: stableTrainingId(firstA.originKey),
          summary: "Rollback-restored evidence A.",
        }),
      ]);
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("enforces one pending suggestion per origin under direct concurrent inserts", async () => {
    const fixture = await createFixture(0);
    const originKey = `postgres-pending-origin:${crypto.randomUUID()}`;

    try {
      const attempts = await Promise.allSettled(
        ["a", "b"].map((suffix, index) =>
          prisma.creatorTrainingSuggestion.create({
            data: {
              representativeId: fixture.representativeId,
              originKey,
              originRevision: index + 1,
              suggestionType: CreatorTrainingSuggestionType.FAQ_UPDATE,
              status: CreatorTrainingSuggestionStatus.PENDING,
              title: `Concurrent pending ${suffix}`,
              rationale: "Partial unique index concurrency regression coverage.",
              draftPayload: {
                kind: "faq",
                title: `Concurrent pending ${suffix}`,
                summary: `Only one pending row may survive insert ${suffix}.`,
              },
              dedupeKey: `${originKey}:${suffix}`,
              riskLevel: "low",
            },
          }),
        ),
      );

      expect(attempts.filter((attempt) => attempt.status === "fulfilled"))
        .toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === "rejected"))
        .toHaveLength(1);
      await expect(
        prisma.creatorTrainingSuggestion.count({
          where: {
            representativeId: fixture.representativeId,
            originKey,
            status: CreatorTrainingSuggestionStatus.PENDING,
          },
        }),
      ).resolves.toBe(1);
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("backfills the exact current published snapshot as the highest revision", async () => {
    const fixture = await createFixture(0);
    const currentSnapshot = {
      identitySummary: "Concurrency test representative",
      faq: [],
      materials: [],
      policies: [],
    };
    const currentVersionId = `migration-current-${crypto.randomUUID()}`;
    const historicalVersionId = `migration-other-${crypto.randomUUID()}`;
    await prisma.creatorTrainingVersion.createMany({
      data: [
        {
          id: currentVersionId,
          representativeId: fixture.representativeId,
          revisionNumber: 1,
          status: CreatorTrainingVersionStatus.PUBLISHED,
          title: "Current exact snapshot",
          snapshotBefore: {
            ...currentSnapshot,
            identitySummary: "Before current",
          },
          snapshotAfter: currentSnapshot,
        },
        {
          id: historicalVersionId,
          representativeId: fixture.representativeId,
          revisionNumber: 2,
          status: CreatorTrainingVersionStatus.PUBLISHED,
          title: "Historical non-current snapshot",
          snapshotBefore: {
            ...currentSnapshot,
            identitySummary: "Before historical",
          },
          snapshotAfter: {
            ...currentSnapshot,
            identitySummary: "Historical snapshot",
          },
        },
      ],
    });
    const migrationSql = readFileSync(
      new URL(
        "../../../prisma/migrations/20260731133000_creator_training_revision_order/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const backfillSql = migrationSql.match(
      /WITH candidate_versions AS \([\s\S]+?WHERE version\."id" = ranked_versions\."id";/u,
    )?.[0];
    if (!backfillSql) {
      throw new Error("Expected creator training revision backfill SQL.");
    }
    const rollbackSentinel = new Error("rollback migration fixture");
    let assigned: Array<{ id: string; revisionNumber: number }> = [];

    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'DROP INDEX "CreatorTrainingVersion_representativeId_revisionNumber_key"',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE "CreatorTrainingVersion" ALTER COLUMN "revisionNumber" DROP NOT NULL',
        );
        await tx.$executeRaw`
          UPDATE "CreatorTrainingVersion"
          SET "revisionNumber" = NULL
          WHERE "representativeId" = ${fixture.representativeId}
        `;
        await tx.$executeRawUnsafe(backfillSql);
        assigned = await tx.creatorTrainingVersion.findMany({
          where: { representativeId: fixture.representativeId },
          select: { id: true, revisionNumber: true },
          orderBy: { revisionNumber: "asc" },
        });
        throw rollbackSentinel;
      });
    } catch (error) {
      if (error !== rollbackSentinel) {
        throw error;
      }
    }

    try {
      expect(assigned).toEqual([
        {
          id: historicalVersionId,
          revisionNumber: 1,
        },
        {
          id: currentVersionId,
          revisionNumber: 2,
        },
      ]);
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("serializes setup before approval through the shared KnowledgePack lock", async () => {
    const fixture = await createFixture(1);
    const setupLockAcquired = deferred();
    const releaseSetup = deferred();
    const setupClient = withTransactionHooks({
      afterLockAcquired: async () => {
        setupLockAcquired.resolve();
        await releaseSetup.promise;
      },
    });

    try {
      const setup = await requireSetup(fixture.representativeSlug);
      const setupUpdate = buildSetupUpdate(setup, {
        identitySummary: "Setup update acquired the shared lock first.",
        faq: [],
        materials: setup.knowledgePack.materials,
        policies: setup.knowledgePack.policies,
      });
      const updatePromise = updateRepresentativeSetup(
        {
          representativeSlug: fixture.representativeSlug,
          input: setupUpdate,
          changedBy: fixture.ownerId,
        },
        setupClient as never,
      );
      await setupLockAcquired.promise;

      const approvalPromise = reviewCreatorTrainingSuggestion(
        fixture.representativeSlug,
        fixture.suggestionIds[0]!,
        { action: "approve", reviewedBy: fixture.ownerId },
      );
      releaseSetup.resolve();
      const [, approval] = await Promise.all([updatePromise, approvalPromise]);

      expect(approval.version?.snapshotBefore).toMatchObject({
        identitySummary: "Setup update acquired the shared lock first.",
        faq: [],
      });
      const knowledgePack = await prisma.knowledgePack.findUniqueOrThrow({
        where: { representativeId: fixture.representativeId },
      });
      expect(knowledgePackSnapshot(knowledgePack)).toMatchObject({
        identitySummary: "Setup update acquired the shared lock first.",
        faq: [
          expect.objectContaining({
            id: stableTrainingId(fixture.suggestionOriginKeys[0]!),
          }),
        ],
      });
      expect(knowledgePack.revision).toBe(2);
    } finally {
      releaseSetup.resolve();
      await deleteFixture(fixture);
    }
  });

  it("rejects a stale setup after an approval updates KnowledgePack first", async () => {
    const fixture = await createFixture(1);

    try {
      const staleSetup = await requireSetup(fixture.representativeSlug);
      await reviewCreatorTrainingSuggestion(
        fixture.representativeSlug,
        fixture.suggestionIds[0]!,
        { action: "approve", reviewedBy: fixture.ownerId },
      );

      await expect(
        updateRepresentativeSetup({
          representativeSlug: fixture.representativeSlug,
          input: buildSetupUpdate(staleSetup, {
            identitySummary: "This stale setup must not replace approved knowledge.",
            faq: [],
            materials: staleSetup.knowledgePack.materials,
            policies: staleSetup.knowledgePack.policies,
          }),
          changedBy: fixture.ownerId,
        }),
      ).rejects.toMatchObject({
        code: "KNOWLEDGE_PACK_CONFLICT",
        statusCode: 409,
      });

      const knowledgePack = await prisma.knowledgePack.findUniqueOrThrow({
        where: { representativeId: fixture.representativeId },
      });
      expect(knowledgePackSnapshot(knowledgePack)).toMatchObject({
        identitySummary: "Concurrency test representative",
        faq: [
          expect.objectContaining({
            id: stableTrainingId(fixture.suggestionOriginKeys[0]!),
          }),
        ],
      });
      expect(knowledgePack.revision).toBe(1);
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("makes stale setup wait for rollback and then fail optimistic concurrency", async () => {
    const fixture = await createFixture(1);
    const rollbackLockAcquired = deferred();
    const releaseRollback = deferred();
    const setupLockAttempted = deferred();
    const rollbackClient = withTransactionHooks({
      afterLockAcquired: async () => {
        rollbackLockAcquired.resolve();
        await releaseRollback.promise;
      },
    });
    const setupClient = withTransactionHooks({
      beforeLockAttempt: async () => {
        setupLockAttempted.resolve();
      },
    });

    try {
      const approval = await reviewCreatorTrainingSuggestion(
        fixture.representativeSlug,
        fixture.suggestionIds[0]!,
        { action: "approve", reviewedBy: fixture.ownerId },
      );
      if (!approval.version) {
        throw new Error("Expected approval to create a rollback fixture.");
      }
      const setup = await requireSetup(fixture.representativeSlug);
      const setupUpdate = buildSetupUpdate(setup, {
        identitySummary: "Manual setup saved after rollback.",
        faq: [],
        materials: setup.knowledgePack.materials,
        policies: setup.knowledgePack.policies,
      });

      const rollbackPromise = rollbackCreatorTrainingVersion(
        fixture.representativeSlug,
        approval.version.id,
        {},
        rollbackClient as never,
      );
      await rollbackLockAcquired.promise;

      let setupSettled = false;
      const setupPromise = updateRepresentativeSetup(
        {
          representativeSlug: fixture.representativeSlug,
          input: setupUpdate,
          changedBy: fixture.ownerId,
        },
        setupClient as never,
      ).finally(() => {
        setupSettled = true;
      });
      await setupLockAttempted.promise;
      await Promise.resolve();
      expect(setupSettled).toBe(false);

      releaseRollback.resolve();
      const [rollbackResult, setupResult] = await Promise.allSettled([
        rollbackPromise,
        setupPromise,
      ]);
      expect(rollbackResult.status).toBe("fulfilled");
      if (rollbackResult.status !== "fulfilled") {
        throw rollbackResult.reason;
      }
      const rolledBack = rollbackResult.value;
      expect(rolledBack.status).toBe("rolled_back");
      expect(setupResult).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          code: "KNOWLEDGE_PACK_CONFLICT",
          statusCode: 409,
        }),
      });

      const knowledgePack = await prisma.knowledgePack.findUniqueOrThrow({
        where: { representativeId: fixture.representativeId },
      });
      expect(knowledgePackSnapshot(knowledgePack)).toEqual({
        identitySummary: "Concurrency test representative",
        faq: [],
        materials: [],
        policies: [],
      });
      expect(knowledgePack.revision).toBe(2);
    } finally {
      releaseRollback.resolve();
      await deleteFixture(fixture);
    }
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function withTransactionHooks(hooks: {
  beforeCallback?: (tx: typeof prisma) => Promise<void>;
  beforeLockAttempt?: () => Promise<void>;
  afterLockAcquired?: () => Promise<void>;
}) {
  return new Proxy(prisma, {
    get(target, property) {
      if (property !== "$transaction") {
        return Reflect.get(target, property, target);
      }
      return async (callback: (tx: typeof prisma) => Promise<unknown>) =>
        prisma.$transaction(async (tx) => {
          if (hooks.beforeCallback) {
            await hooks.beforeCallback(tx as never);
          }
          const hookedTx = new Proxy(tx, {
            get(transaction, transactionProperty) {
              if (transactionProperty !== "$queryRaw") {
                return Reflect.get(transaction, transactionProperty, transaction);
              }
              return async (query: TemplateStringsArray, ...values: unknown[]) => {
                await hooks.beforeLockAttempt?.();
                const queryRaw = Reflect.get(
                  transaction,
                  "$queryRaw",
                  transaction,
                ) as (
                  query: TemplateStringsArray,
                  ...values: unknown[]
                ) => Promise<unknown>;
                const result = await queryRaw.call(transaction, query, ...values);
                await hooks.afterLockAcquired?.();
                return result;
              };
            },
          });
          return callback(hookedTx as never);
        });
    },
  });
}

async function requireSetup(
  representativeSlug: string,
): Promise<RepresentativeSetupSnapshot> {
  const setup = await getRepresentativeSetupSnapshot(representativeSlug);
  if (!setup) {
    throw new Error("Expected representative setup fixture.");
  }
  return setup;
}

function buildSetupUpdate(
  setup: RepresentativeSetupSnapshot,
  knowledgePack: RepresentativeSetupUpdateInput["knowledgePack"],
): RepresentativeSetupUpdateInput {
  return {
    knowledgePackRevision: setup.knowledgePackRevision,
    ownerName: setup.ownerName,
    name: setup.name,
    tagline: setup.tagline,
    tone: setup.tone,
    languages: setup.languages,
    groupActivation: setup.groupActivation,
    publicMode: setup.publicMode,
    humanInLoop: setup.humanInLoop,
    actionGate: setup.actionGate,
    contract: setup.contract,
    handoffPrompt: setup.handoffPrompt,
    pricing: setup.pricing,
    knowledgePack,
    compute: setup.compute,
    delegation: setup.delegation,
  };
}

async function createFixture(suggestionCount: number) {
  const suffix = crypto.randomUUID();
  const owner = await prisma.owner.create({
    data: { displayName: `Creator training concurrency ${suffix}` },
    select: { id: true },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `creator-training-concurrency-${suffix}`,
      displayName: "Creator training concurrency representative",
      roleSummary: "Exercises serialized creator training mutations.",
      tone: "clear",
      languages: ["en"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Handoff",
      allowedSkills: [],
      actionGate: {},
      knowledgePack: {
        create: {
          identitySummary: "Concurrency test representative",
          faq: [],
          materials: [],
          policies: [],
        },
      },
    },
    select: { id: true, slug: true },
  });
  const suggestions = await Promise.all(
    Array.from({ length: suggestionCount }, (_, index) =>
      prisma.creatorTrainingSuggestion.create({
        data: {
          representativeId: representative.id,
          originKey: `postgres-concurrency:${suffix}:${index + 1}`,
          originRevision: 1,
          suggestionType: CreatorTrainingSuggestionType.FAQ_UPDATE,
          status: CreatorTrainingSuggestionStatus.PENDING,
          title: `Concurrency FAQ ${index + 1}`,
          rationale: "PostgreSQL concurrency regression coverage.",
          draftPayload: {
            kind: "faq",
            title: `Concurrency FAQ ${index + 1}`,
            summary: `Concurrency answer ${index + 1} is retained after approval.`,
          },
          dedupeKey: `postgres-concurrency-${suffix}-${index + 1}`,
          riskLevel: "low",
        },
        select: { id: true, originKey: true },
      }),
    ),
  );

  return {
    ownerId: owner.id,
    representativeId: representative.id,
    representativeSlug: representative.slug,
    suggestionIds: suggestions.map((suggestion) => suggestion.id),
    suggestionOriginKeys: suggestions.map((suggestion) => suggestion.originKey),
  };
}

async function deleteFixture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  await prisma.creatorTrainingVersion.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.creatorTrainingSuggestion.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.creatorTrainingSource.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.knowledgePack.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.pricingPlan.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.eventAudit.deleteMany({
    where: {
      OR: [
        { representativeId: fixture.representativeId },
        { ownerId: fixture.ownerId },
      ],
    },
  });
  await prisma.capabilityPolicyRule.deleteMany({
    where: {
      profile: {
        OR: [
          { representativeId: fixture.representativeId },
          { ownerId: fixture.ownerId },
        ],
      },
    },
  });
  await prisma.capabilityPolicyProfile.deleteMany({
    where: {
      OR: [
        { representativeId: fixture.representativeId },
        { ownerId: fixture.ownerId },
      ],
    },
  });
  await prisma.representative.delete({
    where: { id: fixture.representativeId },
  });
  await prisma.owner.delete({ where: { id: fixture.ownerId } });
}

function knowledgePackSnapshot(value: unknown): {
  identitySummary: string;
  faq: unknown[];
  materials: unknown[];
  policies: unknown[];
} {
  if (!value || typeof value !== "object") {
    throw new Error("Expected a KnowledgePack snapshot.");
  }
  const record = value as Record<string, unknown>;
  return {
    identitySummary:
      typeof record.identitySummary === "string" ? record.identitySummary : "",
    faq: Array.isArray(record.faq) ? record.faq : [],
    materials: Array.isArray(record.materials) ? record.materials : [],
    policies: Array.isArray(record.policies) ? record.policies : [],
  };
}

function recordString(value: unknown, field: string): string {
  if (
    !value
    || typeof value !== "object"
    || typeof (value as Record<string, unknown>)[field] !== "string"
  ) {
    throw new Error(`Expected ${field} to be a string.`);
  }
  return (value as Record<string, string>)[field]!;
}

function stableTrainingId(originKey: string): string {
  return `training_origin_${createHash("sha256").update(originKey).digest("hex")}`;
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error(
      "DATABASE_URL is required for the creator training PostgreSQL concurrency E2E.",
    );
  }

  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return;
  }

  const databaseName = url.pathname.replace(/^\/+/u, "");
  if (
    process.env.DELEGATE_POSTGRES_E2E_ALLOW_REMOTE !== "1"
    || !/(?:^|[_-])(staging|test|rehearsal)(?:$|[_-])/iu.test(databaseName)
  ) {
    throw new Error(
      "Remote PostgreSQL E2E is blocked. Use an explicitly named staging/test/rehearsal database and set DELEGATE_POSTGRES_E2E_ALLOW_REMOTE=1.",
    );
  }
}

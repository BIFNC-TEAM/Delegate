import {
  GovernedMemoryStatus,
  MemoryCandidateStatus,
  MemoryCleanupStatus,
  MemoryExpiryAction,
  Prisma,
  type PrismaClient,
} from "@prisma/client";

import { queueGovernedMemoryProjectionDeletion } from "./memory-projection-execution";
import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";

const defaultLifecycleBatchSize = 32;
const maximumLifecycleBatchSize = 100;
const expiryReasonCode = "memory_retention_expired";
const lifecycleActorId = "system:memory-lifecycle";

type ExpiredMemoryClaim = {
  id: string;
  representativeId: string;
  status: GovernedMemoryStatus;
  currentVersionId: string;
  contentHash: string;
  expiryAction: MemoryExpiryAction;
  recallDisabledAt: Date | null;
  archivedAt: Date | null;
  deleteRequestedAt: Date | null;
};

export type MemoryLifecycleExecutionOptions = {
  client?: PrismaClient;
  representativeId?: string;
  limit?: number;
  now?: () => Date;
};

export type MemoryLifecycleTickResult =
  | { processed: false }
  | {
      processed: true;
      status: "completed";
      processedCount: number;
      archivedCount: number;
      deletePendingCount: number;
    };

/**
 * Applies retention expiry in one bounded, atomic database tick. The row lock
 * is also the idempotency boundary: committed terminal states are not selected
 * by a later worker, while concurrent workers skip the same rows.
 */
export async function runNextMemoryLifecycle(
  options: MemoryLifecycleExecutionOptions = {},
): Promise<MemoryLifecycleTickResult> {
  const client = options.client ?? prisma;
  const representativeId = optionalNonEmptyText(options.representativeId);
  const limit = boundedBatchSize(options.limit);
  const occurredAt = options.now?.() ?? new Date();

  return runWithPrismaWriteConflictRetry(() => client.$transaction(
    async (tx) => {
      const claims = await tx.$queryRaw<ExpiredMemoryClaim[]>(Prisma.sql`
        SELECT memory_record."id",
               memory_record."representativeId",
               memory_record."status",
               memory_record."currentVersionId",
               version."contentHash",
               COALESCE(
                 policy."expiryAction",
                 'ARCHIVE'::"MemoryExpiryAction"
               ) AS "expiryAction",
               memory_record."recallDisabledAt",
               memory_record."archivedAt",
               memory_record."deleteRequestedAt"
          FROM "GovernedMemory" memory_record
          JOIN "GovernedMemoryVersion" version
            ON version."id" = memory_record."currentVersionId"
           AND version."memoryId" = memory_record."id"
           AND version."representativeId" = memory_record."representativeId"
          LEFT JOIN "RepresentativeMemoryPolicy" policy
            ON policy."representativeId" = memory_record."representativeId"
         WHERE memory_record."expiresAt" IS NOT NULL
           AND memory_record."expiresAt" <= ${occurredAt}
           AND (${representativeId}::TEXT IS NULL
             OR memory_record."representativeId" = ${representativeId})
           AND (
             memory_record."status" IN (
               'ACTIVE'::"GovernedMemoryStatus",
               'SUPPRESSED'::"GovernedMemoryStatus",
               'EXPIRED'::"GovernedMemoryStatus"
             )
             OR (
               memory_record."status" = 'ARCHIVED'::"GovernedMemoryStatus"
               AND policy."expiryAction" = 'DELETE'::"MemoryExpiryAction"
             )
           )
         ORDER BY memory_record."expiresAt" ASC, memory_record."id" ASC
         FOR UPDATE OF memory_record SKIP LOCKED
         LIMIT ${limit}
      `);
      if (claims.length === 0) return { processed: false } as const;

      let archivedCount = 0;
      let deletePendingCount = 0;
      for (const claim of claims) {
        if (claim.expiryAction === MemoryExpiryAction.DELETE) {
          await expireMemoryIntoDeletion(tx, claim, occurredAt);
          deletePendingCount += 1;
        } else {
          await archiveExpiredMemory(tx, claim, occurredAt);
          archivedCount += 1;
        }
      }

      return {
        processed: true,
        status: "completed",
        processedCount: claims.length,
        archivedCount,
        deletePendingCount,
      } as const;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  ));
}

async function archiveExpiredMemory(
  tx: Prisma.TransactionClient,
  claim: ExpiredMemoryClaim,
  occurredAt: Date,
) {
  const updated = await tx.governedMemory.updateMany({
    where: {
      id: claim.id,
      representativeId: claim.representativeId,
      status: {
        in: [
          GovernedMemoryStatus.ACTIVE,
          GovernedMemoryStatus.SUPPRESSED,
          GovernedMemoryStatus.EXPIRED,
        ],
      },
      expiresAt: { lte: occurredAt },
    },
    data: {
      status: GovernedMemoryStatus.ARCHIVED,
      recallDisabledAt: claim.recallDisabledAt ?? occurredAt,
      archivedAt: claim.archivedAt ?? occurredAt,
    },
  });
  if (updated.count !== 1) {
    throw new Error("Expired governed memory lost its lifecycle lock.");
  }
  await queueGovernedMemoryProjectionDeletion(tx, {
    representativeId: claim.representativeId,
    memoryId: claim.id,
    requestedAt: occurredAt,
    reasonCode: expiryReasonCode,
  });
}

async function expireMemoryIntoDeletion(
  tx: Prisma.TransactionClient,
  claim: ExpiredMemoryClaim,
  occurredAt: Date,
) {
  let status = claim.status;
  let recallDisabledAt = claim.recallDisabledAt;
  if (status === GovernedMemoryStatus.ACTIVE) {
    const blocked = await tx.governedMemory.update({
      where: { id: claim.id },
      data: {
        status: GovernedMemoryStatus.EXPIRED,
        recallDisabledAt: occurredAt,
      },
      select: { status: true, recallDisabledAt: true },
    });
    status = blocked.status;
    recallDisabledAt = blocked.recallDisabledAt;
  }

  if (!new Set<GovernedMemoryStatus>([
    GovernedMemoryStatus.SUPPRESSED,
    GovernedMemoryStatus.EXPIRED,
    GovernedMemoryStatus.ARCHIVED,
  ]).has(status)) {
    throw new Error("Expired governed memory cannot enter deletion.");
  }

  const deletePending = await tx.governedMemory.updateMany({
    where: {
      id: claim.id,
      representativeId: claim.representativeId,
      status,
      expiresAt: { lte: occurredAt },
    },
    data: {
      status: GovernedMemoryStatus.DELETE_PENDING,
      recallDisabledAt: recallDisabledAt ?? occurredAt,
      deleteRequestedAt: claim.deleteRequestedAt ?? occurredAt,
    },
  });
  if (deletePending.count !== 1) {
    throw new Error("Expired governed memory lost its deletion lock.");
  }

  // A legacy correction may already own a non-current version. The candidate
  // purge guard intentionally permits that body to be removed only after the
  // governed memory has crossed the irreversible recall fence.
  await terminatePendingCorrections(tx, claim, occurredAt);

  await queueGovernedMemoryProjectionDeletion(tx, {
    representativeId: claim.representativeId,
    memoryId: claim.id,
    requestedAt: occurredAt,
    reasonCode: expiryReasonCode,
  });
  await tx.memoryDeletionProof.create({
    data: {
      representativeId: claim.representativeId,
      memoryId: claim.id,
      requestId: `expiry:${claim.id}`,
      requestedByActorId: lifecycleActorId,
      reasonCode: expiryReasonCode,
      contentHash: claim.contentHash,
      recallBlockedAt: recallDisabledAt ?? occurredAt,
      cleanupStatus: MemoryCleanupStatus.QUEUED,
      availableAt: occurredAt,
      createdAt: occurredAt,
    },
  });
}

async function terminatePendingCorrections(
  tx: Prisma.TransactionClient,
  claim: ExpiredMemoryClaim,
  occurredAt: Date,
) {
  const pending = await tx.memoryCandidate.findMany({
    where: {
      representativeId: claim.representativeId,
      correctionMemoryId: claim.id,
      status: MemoryCandidateStatus.PENDING_REVIEW,
    },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  if (pending.length === 0) return;

  for (const candidate of pending) {
    // Manual correction candidates are legacy audit records, not automatic
    // policy inputs. Retire them without creating an authority decision.
    await tx.memoryCandidate.update({
      where: { id: candidate.id },
      data: {
        status: MemoryCandidateStatus.EXPIRED,
        safeText: null,
        summary: null,
        contentPurgedAt: occurredAt,
      },
    });
  }
}

function boundedBatchSize(value: number | undefined) {
  if (!Number.isFinite(value)) return defaultLifecycleBatchSize;
  return Math.min(
    maximumLifecycleBatchSize,
    Math.max(1, Math.trunc(value ?? defaultLifecycleBatchSize)),
  );
}

function optionalNonEmptyText(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

import { createHash, randomUUID } from "node:crypto";

import {
  assertExactGovernedMemoryVersionUri,
  OpenVikingRequestError,
} from "@delegate/openviking";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  createDefaultMemoryProjectionProvider,
  defaultMemoryProjectionProviderIsEnabled,
  MemoryProjectionProviderError,
  type MemoryProjectionProvider,
} from "./memory-projection-provider";
import { prisma } from "./prisma";

export * from "./memory-projection-provider";

const defaultLeaseMilliseconds = 60_000;
const defaultMaximumWriteAttempts = 8;
const defaultMaximumCleanupAttempts = 8;
const defaultRetryBaseMilliseconds = 1_000;
const defaultRetryMaximumMilliseconds = 5 * 60_000;
const sha256Pattern = /^[0-9a-f]{64}$/u;

export type MemoryProjectionTickResult =
  | { processed: false }
  | {
      processed: true;
      workId: string;
      status: "completed" | "retrying" | "failed" | "lease_lost";
      errorCode?: string;
    };

export type MemoryProjectionExecutionOptions = {
  client?: PrismaClient;
  representativeId?: string;
  provider?: MemoryProjectionProvider;
  resolveProvider?: (
    providerName: string,
  ) => MemoryProjectionProvider | null | undefined;
  leaseMilliseconds?: number;
  maximumWriteAttempts?: number;
  maximumCleanupAttempts?: number;
  retryBaseMilliseconds?: number;
  retryMaximumMilliseconds?: number;
};

type ProjectionClaim = {
  id: string;
  representativeId: string;
  memoryId: string;
  memoryVersionId: string;
  provider: string;
  lane: "RECALL" | "STAGING";
  remoteUri: string;
  contentHash: string;
  attemptCount: number;
  leaseToken: string;
  leaseExpiresAt: Date;
  deleteRequestedAt: Date | null;
  safeText: string | null;
  versionContentHash: string;
  versionPurgedAt: Date | null;
  memoryStatus: string;
  currentVersionId: string | null;
  recallDisabledAt: Date | null;
  namespaceKey: string;
  policyProvider: string;
  longTermMemoryEnabled: boolean;
  previousErrorCode: string | null;
  previousWriteReceiptHash: string | null;
};

type CleanupClaim = {
  id: string;
  representativeId: string;
  memoryId: string;
  requestId: string;
  reasonCode: string;
  contentHash: string;
  recallBlockedAt: Date;
  attemptCount: number;
  leaseToken: string;
  leaseExpiresAt: Date;
};

type FailureClassification = {
  code: string;
  retryable: boolean;
  cleanupRequired: boolean;
};

type WriteFailureContext = {
  exactLeafAbsenceConfirmed?: boolean;
};

export async function runNextMemoryProjectionWrite(
  options: MemoryProjectionExecutionOptions = {},
): Promise<MemoryProjectionTickResult> {
  const client = options.client ?? prisma;
  const claim = await claimNextProjectionWrite(client, options);
  if (!claim) return { processed: false };

  const preflightError = validateWriteClaim(claim);
  if (preflightError) {
    const updated = await moveClaimToDeletePending(
      client,
      claim,
      preflightError,
    );
    return updated
      ? {
          processed: true,
          workId: claim.id,
          status: "completed",
          errorCode: preflightError,
        }
      : leaseLost(claim.id);
  }

  const provider = resolveProjectionProvider(claim.provider, options);
  if (!provider) {
    return recordWriteFailure(client, claim, {
      code: defaultProviderErrorCode(claim.provider, options),
      retryable: false,
      cleanupRequired: false,
    }, options);
  }

  let versionCoordinates;
  try {
    versionCoordinates = assertExactGovernedMemoryVersionUri({
      namespaceKey: claim.namespaceKey,
      uri: claim.remoteUri,
    });
    if (
      versionCoordinates.memoryId !== claim.memoryId
      || versionCoordinates.memoryVersionId !== claim.memoryVersionId
    ) {
      throw new Error("Projection URI coordinates do not match the claimed version.");
    }
  } catch {
    return recordWriteFailure(client, claim, {
      code: "projection_canonical_uri_invalid",
      retryable: false,
      cleanupRequired: false,
    }, options);
  }

  const repairReason = writeRepairReason(claim.previousErrorCode);
  const receiptEvidence: string[] = [];
  let exactLeafAbsenceConfirmed = false;
  if (
    repairReason === "reconciliation_hash_mismatch"
    || repairReason === "projection_write_cleanup_required"
  ) {
    try {
      const inspected = await provider.inspectExact({
        namespaceKey: claim.namespaceKey,
        uri: claim.remoteUri,
      });
      if (inspected.uri !== claim.remoteUri) {
        throw new MemoryProjectionProviderError(
          "projection_repair_target_mismatch",
          "Provider returned a different reconciliation target.",
          false,
        );
      }
      receiptEvidence.push(inspected.receipt);
      if (!inspected.exists) exactLeafAbsenceConfirmed = true;
      if (
        inspected.exists
        && (
          repairReason === "projection_write_cleanup_required"
          || inspected.contentHash !== claim.contentHash
        )
      ) {
        const deleted = await provider.deleteExact({
          namespaceKey: claim.namespaceKey,
          uri: claim.remoteUri,
        });
        if (deleted.uri !== claim.remoteUri) {
          throw new MemoryProjectionProviderError(
            "projection_repair_delete_target_mismatch",
            "Provider returned a different reconciliation deletion target.",
            false,
          );
        }
        receiptEvidence.push(deleted.receipt);
        const absent = await provider.inspectExact({
          namespaceKey: claim.namespaceKey,
          uri: claim.remoteUri,
        });
        if (absent.uri !== claim.remoteUri || absent.exists) {
          throw new MemoryProjectionProviderError(
            "projection_repair_delete_unverified",
            "Reconciliation could not verify exact-leaf absence.",
            true,
          );
        }
        receiptEvidence.push(absent.receipt);
        exactLeafAbsenceConfirmed = true;
      }
    } catch (error) {
      const failure = classifyProviderFailure(error, "write_exact");
      return recordWriteFailure(
        client,
        claim,
        // Repair inspection/deletion can itself have committed remotely before
        // its response failed. Keep the exact-leaf cleanup fence until a later
        // tick proves absence; normal attempt exhaustion is not safe here.
        { ...failure, cleanupRequired: true },
        options,
      );
    }
  }

  let ensureReceipt: string;
  try {
    const ensured = await provider.ensureRoot({
      namespaceKey: claim.namespaceKey,
      rootUri: versionCoordinates.rootUri,
    });
    if (ensured.rootUri !== versionCoordinates.rootUri) {
      throw new MemoryProjectionProviderError(
        "projection_root_target_mismatch",
        "Provider returned a different governed-memory root.",
        false,
      );
    }
    ensureReceipt = ensured.receipt;
    receiptEvidence.push(ensureReceipt);
  } catch (error) {
    return recordWriteFailure(
      client,
      claim,
      classifyProviderFailure(error, "ensure_root"),
      options,
      { exactLeafAbsenceConfirmed },
    );
  }

  let writeReceipt: string;
  try {
    const written = await provider.writeExact({
      namespaceKey: claim.namespaceKey,
      uri: claim.remoteUri,
      safeText: claim.safeText!,
      contentHash: claim.contentHash,
    });
    if (
      written.uri !== claim.remoteUri
      || written.contentHash !== claim.contentHash
    ) {
      throw new MemoryProjectionProviderError(
        "projection_write_result_mismatch",
        "Provider returned different projection coordinates.",
        false,
        true,
      );
    }
    writeReceipt = written.receipt;
    receiptEvidence.push(writeReceipt);
  } catch (error) {
    return recordWriteFailure(
      client,
      claim,
      classifyProviderFailure(error, "write_exact"),
      options,
      { exactLeafAbsenceConfirmed },
    );
  }

  let inspectReceipt: string;
  try {
    const inspected = await provider.inspectExact({
      namespaceKey: claim.namespaceKey,
      uri: claim.remoteUri,
    });
    if (
      inspected.uri !== claim.remoteUri
      || !inspected.exists
      || inspected.contentHash !== claim.contentHash
    ) {
      throw new MemoryProjectionProviderError(
        "projection_write_verification_mismatch",
        "The exact governed-memory leaf did not verify after write.",
        false,
        true,
      );
    }
    inspectReceipt = inspected.receipt;
    receiptEvidence.push(inspectReceipt);
  } catch (error) {
    return recordWriteFailure(
      client,
      claim,
      classifyProviderFailure(error, "inspect_after_write"),
      options,
      { exactLeafAbsenceConfirmed },
    );
  }

  const receiptHash = repairReason
    ? hashCanonicalJson({
        previousWriteReceiptHash: claim.previousWriteReceiptHash,
        repairReason,
        evidence: receiptEvidence,
      })
    : hashReceiptEvidence(receiptEvidence);
  const completed = await completeProjectionWrite(
    client,
    claim,
    receiptHash,
    repairReason,
  );
  if (!completed) return leaseLost(claim.id);
  if (completed === "DELETE_PENDING") {
    return {
      processed: true,
      workId: claim.id,
      status: "completed",
      errorCode: "projection_not_authoritative",
    };
  }
  return { processed: true, workId: claim.id, status: "completed" };
}

export async function runNextMemoryProjectionDeletion(
  options: MemoryProjectionExecutionOptions = {},
): Promise<MemoryProjectionTickResult> {
  const client = options.client ?? prisma;
  const claim = await claimNextProjectionDeletion(client, options);
  if (!claim) return { processed: false };

  const provider = resolveProjectionProvider(claim.provider, options);
  if (!provider) {
    return recordDeleteFailure(client, claim, {
      code: defaultProviderErrorCode(claim.provider, options),
      retryable: false,
      cleanupRequired: false,
    }, options);
  }

  try {
    const coordinates = assertExactGovernedMemoryVersionUri({
      namespaceKey: claim.namespaceKey,
      uri: claim.remoteUri,
    });
    if (
      coordinates.memoryId !== claim.memoryId
      || coordinates.memoryVersionId !== claim.memoryVersionId
    ) {
      throw new Error("Projection URI coordinates do not match the claimed version.");
    }
  } catch {
    return recordDeleteFailure(client, claim, {
      code: "projection_canonical_uri_invalid",
      retryable: false,
      cleanupRequired: false,
    }, options);
  }

  let deleteReceipt: string;
  try {
    const deleted = await provider.deleteExact({
      namespaceKey: claim.namespaceKey,
      uri: claim.remoteUri,
    });
    if (deleted.uri !== claim.remoteUri) {
      throw new MemoryProjectionProviderError(
        "projection_delete_target_mismatch",
        "Provider returned a different deletion target.",
        false,
      );
    }
    const inspected = await provider.inspectExact({
      namespaceKey: claim.namespaceKey,
      uri: claim.remoteUri,
    });
    if (inspected.uri !== claim.remoteUri || inspected.exists) {
      throw new MemoryProjectionProviderError(
        "projection_remote_still_present",
        "The exact governed-memory leaf still exists after deletion.",
        true,
      );
    }
    deleteReceipt = hashReceiptEvidence([
      deleted.receipt,
      inspected.receipt,
    ]);
  } catch (error) {
    return recordDeleteFailure(
      client,
      claim,
      classifyProviderFailure(error, "delete_exact"),
      options,
    );
  }

  const completed = await completeProjectionDeletion(
    client,
    claim,
    deleteReceipt,
  );
  return completed
    ? { processed: true, workId: claim.id, status: "completed" }
    : leaseLost(claim.id);
}

export async function runNextMemoryDeletionCleanup(
  options: MemoryProjectionExecutionOptions = {},
): Promise<MemoryProjectionTickResult> {
  const client = options.client ?? prisma;
  const claim = await claimNextDeletionCleanup(client, options);
  if (!claim) return { processed: false };

  try {
    const result = await executeDeletionCleanup(client, claim, options);
    if (result === "lease_lost") return leaseLost(claim.id);
    if (result === "draining") {
      return {
        processed: true,
        workId: claim.id,
        status: "retrying",
        errorCode: "projection_drain_pending",
      };
    }
    return { processed: true, workId: claim.id, status: "completed" };
  } catch {
    return recordCleanupFailure(
      client,
      claim,
      "memory_cleanup_execution_failed",
      options,
    );
  }
}

async function claimNextProjectionWrite(
  client: PrismaClient,
  options: MemoryProjectionExecutionOptions,
): Promise<ProjectionClaim | null> {
  const leaseToken = randomUUID();
  const leaseMilliseconds = positiveInteger(
    options.leaseMilliseconds,
    defaultLeaseMilliseconds,
  );
  const maximumAttempts = positiveInteger(
    options.maximumWriteAttempts,
    defaultMaximumWriteAttempts,
  );
  const representativeId = optionalNonEmptyText(options.representativeId);
  return client.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      WITH expired_projection AS MATERIALIZED (
        SELECT projection."id"
          FROM "MemoryProjectionItem" projection
         WHERE projection."status" = 'PROJECTING'::"MemoryProjectionStatus"
           AND (${representativeId}::TEXT IS NULL
             OR projection."representativeId" = ${representativeId})
           AND projection."leaseExpiresAt" <= CURRENT_TIMESTAMP
         ORDER BY projection."leaseExpiresAt" ASC, projection."id" ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 32
      )
      UPDATE "MemoryProjectionItem" projection
         SET "status" = CASE
               WHEN projection."deleteRequestedAt" IS NOT NULL
                 THEN 'DELETE_PENDING'::"MemoryProjectionStatus"
               WHEN projection."lastErrorCode" = 'projection_write_cleanup_required'
                 THEN 'RETRYING'::"MemoryProjectionStatus"
               WHEN projection."attemptCount" >= ${maximumAttempts}
                 THEN 'FAILED'::"MemoryProjectionStatus"
               ELSE 'RETRYING'::"MemoryProjectionStatus"
             END,
             "availableAt" = CURRENT_TIMESTAMP - INTERVAL '1 millisecond',
             "leaseToken" = NULL,
             "leaseExpiresAt" = NULL,
             "lastErrorCode" = CASE
               WHEN projection."lastErrorCode" IN (
                      'reconciliation_missing_remote',
                      'reconciliation_hash_mismatch',
                      'reconciliation_stale_active_pointer',
                      'projection_write_cleanup_required'
                    )
                 THEN projection."lastErrorCode"
               WHEN projection."deleteRequestedAt" IS NOT NULL
                 THEN 'projection_delete_requested_during_write'
               WHEN projection."attemptCount" >= ${maximumAttempts}
                 THEN 'projection_write_attempts_exhausted'
               ELSE 'projection_write_lease_expired'
             END,
             "updatedAt" = CURRENT_TIMESTAMP
        FROM expired_projection
       WHERE projection."id" = expired_projection."id"
    `);

    await tx.$queryRaw(Prisma.sql`
      WITH exhausted_projection AS MATERIALIZED (
        SELECT projection."id", projection."status"
          FROM "MemoryProjectionItem" projection
         WHERE projection."lane" = 'RECALL'::"MemoryProjectionLane"
           AND (${representativeId}::TEXT IS NULL
             OR projection."representativeId" = ${representativeId})
           AND projection."status" IN (
             'QUEUED'::"MemoryProjectionStatus",
             'RETRYING'::"MemoryProjectionStatus"
           )
           AND projection."attemptCount" >= ${maximumAttempts}
           AND projection."availableAt" <= CURRENT_TIMESTAMP
           AND projection."deleteRequestedAt" IS NULL
           AND projection."lastErrorCode" IS DISTINCT FROM 'projection_write_cleanup_required'
         ORDER BY projection."availableAt" ASC, projection."id" ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 32
      )
      UPDATE "MemoryProjectionItem" projection
         SET "status" = 'FAILED'::"MemoryProjectionStatus",
             "leaseToken" = NULL,
             "leaseExpiresAt" = NULL,
             "lastErrorCode" = CASE
               WHEN projection."lastErrorCode" IN (
                      'reconciliation_missing_remote',
                      'reconciliation_hash_mismatch',
                      'reconciliation_stale_active_pointer',
                      'projection_write_cleanup_required'
                    )
                 THEN projection."lastErrorCode"
               ELSE 'projection_write_attempts_exhausted'
             END,
             "updatedAt" = CURRENT_TIMESTAMP
        FROM exhausted_projection
       WHERE projection."id" = exhausted_projection."id"
    `);

    const rows = await tx.$queryRaw<ProjectionClaim[]>(Prisma.sql`
      WITH next_projection AS MATERIALIZED (
        SELECT projection."id",
               projection."lastErrorCode" AS "previousErrorCode",
               projection."writeReceiptHash" AS "previousWriteReceiptHash"
          FROM "MemoryProjectionItem" projection
         WHERE projection."lane" = 'RECALL'::"MemoryProjectionLane"
           AND (${representativeId}::TEXT IS NULL
             OR projection."representativeId" = ${representativeId})
           AND projection."status" IN (
             'QUEUED'::"MemoryProjectionStatus",
             'RETRYING'::"MemoryProjectionStatus"
           )
           AND (
             projection."attemptCount" < ${maximumAttempts}
             OR projection."lastErrorCode" = 'projection_write_cleanup_required'
           )
           AND projection."availableAt" <= CURRENT_TIMESTAMP
           AND projection."deleteRequestedAt" IS NULL
         ORDER BY projection."availableAt" ASC,
                  projection."createdAt" ASC,
                  projection."id" ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      ), claimed_projection AS (
        UPDATE "MemoryProjectionItem" projection
           SET "status" = 'PROJECTING'::"MemoryProjectionStatus",
               "attemptCount" = projection."attemptCount" + 1,
               "leaseToken" = ${leaseToken},
               "leaseExpiresAt" = CURRENT_TIMESTAMP
                 + (${leaseMilliseconds} * INTERVAL '1 millisecond'),
               "lastErrorCode" = CASE
                 WHEN next_projection."previousErrorCode" IN (
                   'reconciliation_missing_remote',
                   'reconciliation_hash_mismatch',
                   'reconciliation_stale_active_pointer',
                   'projection_write_cleanup_required'
                 ) THEN next_projection."previousErrorCode"
                 ELSE NULL
               END,
               "updatedAt" = CURRENT_TIMESTAMP
          FROM next_projection
         WHERE projection."id" = next_projection."id"
        RETURNING projection.*,
                  next_projection."previousErrorCode",
                  next_projection."previousWriteReceiptHash"
      )
      SELECT projection."id",
             projection."representativeId",
             projection."memoryId",
             projection."memoryVersionId",
             projection."provider",
             projection."lane",
             projection."remoteUri",
             projection."contentHash",
             projection."attemptCount",
             projection."leaseToken",
             projection."leaseExpiresAt",
             projection."deleteRequestedAt",
             version."safeText",
             version."contentHash" AS "versionContentHash",
             version."purgedAt" AS "versionPurgedAt",
             memory_record."status" AS "memoryStatus",
             memory_record."currentVersionId",
             memory_record."recallDisabledAt",
             policy."namespaceKey",
             policy."provider" AS "policyProvider",
             policy."longTermMemoryEnabled",
             projection."previousErrorCode",
             projection."previousWriteReceiptHash"
        FROM claimed_projection projection
        JOIN "GovernedMemoryVersion" version
          ON version."id" = projection."memoryVersionId"
         AND version."memoryId" = projection."memoryId"
         AND version."representativeId" = projection."representativeId"
        JOIN "GovernedMemory" memory_record
          ON memory_record."id" = projection."memoryId"
         AND memory_record."representativeId" = projection."representativeId"
        JOIN "RepresentativeMemoryPolicy" policy
          ON policy."representativeId" = projection."representativeId"
    `);
    return rows[0] ?? null;
  });
}

async function claimNextProjectionDeletion(
  client: PrismaClient,
  options: MemoryProjectionExecutionOptions,
): Promise<ProjectionClaim | null> {
  const leaseToken = randomUUID();
  const leaseMilliseconds = positiveInteger(
    options.leaseMilliseconds,
    defaultLeaseMilliseconds,
  );
  const representativeId = optionalNonEmptyText(options.representativeId);
  return client.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      WITH expired_projection AS MATERIALIZED (
        SELECT projection."id"
          FROM "MemoryProjectionItem" projection
         WHERE projection."status" = 'DELETING'::"MemoryProjectionStatus"
           AND (${representativeId}::TEXT IS NULL
             OR projection."representativeId" = ${representativeId})
           AND projection."leaseExpiresAt" <= CURRENT_TIMESTAMP
         ORDER BY projection."leaseExpiresAt" ASC, projection."id" ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 32
      )
      UPDATE "MemoryProjectionItem" projection
         SET "status" = 'DELETE_FAILED'::"MemoryProjectionStatus",
             "availableAt" = CURRENT_TIMESTAMP - INTERVAL '1 millisecond',
             "leaseToken" = NULL,
             "leaseExpiresAt" = NULL,
             "lastErrorCode" = 'projection_delete_lease_expired',
             "updatedAt" = CURRENT_TIMESTAMP
        FROM expired_projection
       WHERE projection."id" = expired_projection."id"
    `);

    const rows = await tx.$queryRaw<ProjectionClaim[]>(Prisma.sql`
      WITH next_projection AS MATERIALIZED (
        SELECT projection."id"
          FROM "MemoryProjectionItem" projection
         WHERE projection."status" IN (
             'DELETE_PENDING'::"MemoryProjectionStatus",
             'DELETE_FAILED'::"MemoryProjectionStatus"
           )
           AND (${representativeId}::TEXT IS NULL
             OR projection."representativeId" = ${representativeId})
           AND projection."availableAt" <= CURRENT_TIMESTAMP
           AND projection."deleteRequestedAt" IS NOT NULL
         ORDER BY projection."availableAt" ASC,
                  projection."createdAt" ASC,
                  projection."id" ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      ), claimed_projection AS (
        UPDATE "MemoryProjectionItem" projection
           SET "status" = 'DELETING'::"MemoryProjectionStatus",
               "attemptCount" = projection."attemptCount" + 1,
               "leaseToken" = ${leaseToken},
               "leaseExpiresAt" = CURRENT_TIMESTAMP
                 + (${leaseMilliseconds} * INTERVAL '1 millisecond'),
               "lastErrorCode" = NULL,
               "updatedAt" = CURRENT_TIMESTAMP
          FROM next_projection
         WHERE projection."id" = next_projection."id"
        RETURNING projection.*
      )
      SELECT projection."id",
             projection."representativeId",
             projection."memoryId",
             projection."memoryVersionId",
             projection."provider",
             projection."lane",
             projection."remoteUri",
             projection."contentHash",
             projection."attemptCount",
             projection."leaseToken",
             projection."leaseExpiresAt",
             projection."deleteRequestedAt",
             version."safeText",
             version."contentHash" AS "versionContentHash",
             version."purgedAt" AS "versionPurgedAt",
             memory_record."status" AS "memoryStatus",
             memory_record."currentVersionId",
             memory_record."recallDisabledAt",
             policy."namespaceKey",
             policy."provider" AS "policyProvider",
             policy."longTermMemoryEnabled"
        FROM claimed_projection projection
        JOIN "GovernedMemoryVersion" version
          ON version."id" = projection."memoryVersionId"
         AND version."memoryId" = projection."memoryId"
         AND version."representativeId" = projection."representativeId"
        JOIN "GovernedMemory" memory_record
          ON memory_record."id" = projection."memoryId"
         AND memory_record."representativeId" = projection."representativeId"
        JOIN "RepresentativeMemoryPolicy" policy
          ON policy."representativeId" = projection."representativeId"
    `);
    return rows[0] ?? null;
  });
}

async function claimNextDeletionCleanup(
  client: PrismaClient,
  options: MemoryProjectionExecutionOptions,
): Promise<CleanupClaim | null> {
  const leaseToken = randomUUID();
  const leaseMilliseconds = positiveInteger(
    options.leaseMilliseconds,
    defaultLeaseMilliseconds,
  );
  const representativeId = optionalNonEmptyText(options.representativeId);
  return client.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      WITH expired_proof AS MATERIALIZED (
        SELECT proof."id"
          FROM "MemoryDeletionProof" proof
         WHERE proof."cleanupStatus" = 'RUNNING'::"MemoryCleanupStatus"
           AND (${representativeId}::TEXT IS NULL
             OR proof."representativeId" = ${representativeId})
           AND proof."leaseExpiresAt" <= CURRENT_TIMESTAMP
         ORDER BY proof."leaseExpiresAt" ASC, proof."id" ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 32
      )
      UPDATE "MemoryDeletionProof" proof
         SET "cleanupStatus" = 'RETRYING'::"MemoryCleanupStatus",
             "availableAt" = CURRENT_TIMESTAMP - INTERVAL '1 millisecond',
             "leaseToken" = NULL,
             "leaseExpiresAt" = NULL,
             "lastErrorCode" = 'memory_cleanup_lease_expired',
             "updatedAt" = CURRENT_TIMESTAMP
        FROM expired_proof
       WHERE proof."id" = expired_proof."id"
    `);

    const rows = await tx.$queryRaw<CleanupClaim[]>(Prisma.sql`
      WITH next_proof AS MATERIALIZED (
        SELECT proof."id"
          FROM "MemoryDeletionProof" proof
          JOIN "GovernedMemory" memory_record
            ON memory_record."id" = proof."memoryId"
           AND memory_record."representativeId" = proof."representativeId"
         WHERE proof."cleanupStatus" IN (
             'QUEUED'::"MemoryCleanupStatus",
             'RETRYING'::"MemoryCleanupStatus"
           )
           AND (${representativeId}::TEXT IS NULL
             OR proof."representativeId" = ${representativeId})
           AND proof."availableAt" <= CURRENT_TIMESTAMP
           AND memory_record."status" = 'DELETE_PENDING'::"GovernedMemoryStatus"
         ORDER BY proof."availableAt" ASC,
                  proof."createdAt" ASC,
                  proof."id" ASC
         FOR UPDATE OF proof SKIP LOCKED
         LIMIT 1
      ), claimed_proof AS (
        UPDATE "MemoryDeletionProof" proof
           SET "cleanupStatus" = 'RUNNING'::"MemoryCleanupStatus",
               "attemptCount" = proof."attemptCount" + 1,
               "leaseToken" = ${leaseToken},
               "leaseExpiresAt" = CURRENT_TIMESTAMP
                 + (${leaseMilliseconds} * INTERVAL '1 millisecond'),
               "lastErrorCode" = NULL,
               "updatedAt" = CURRENT_TIMESTAMP
          FROM next_proof
         WHERE proof."id" = next_proof."id"
        RETURNING proof.*
      )
      SELECT proof."id",
             proof."representativeId",
             proof."memoryId",
             proof."requestId",
             proof."reasonCode",
             proof."contentHash",
             proof."recallBlockedAt",
             proof."attemptCount",
             proof."leaseToken",
             proof."leaseExpiresAt"
        FROM claimed_proof proof
    `);
    return rows[0] ?? null;
  });
}

function validateWriteClaim(claim: ProjectionClaim): string | null {
  if (
    claim.lane !== "RECALL"
    || claim.deleteRequestedAt !== null
    || claim.provider !== claim.policyProvider
    || !claim.longTermMemoryEnabled
    || claim.memoryStatus !== "ACTIVE"
    || claim.recallDisabledAt !== null
    || claim.currentVersionId !== claim.memoryVersionId
    || claim.versionPurgedAt !== null
    || claim.safeText === null
    || claim.contentHash !== claim.versionContentHash
    || !sha256Pattern.test(claim.contentHash)
    || sha256Text(claim.safeText ?? "") !== claim.contentHash
  ) {
    return "projection_not_authoritative";
  }
  return null;
}

async function completeProjectionWrite(
  client: PrismaClient,
  claim: ProjectionClaim,
  receiptHash: string,
  repairReason: ReturnType<typeof writeRepairReason>,
): Promise<"ACTIVE" | "DELETE_PENDING" | null> {
  return client.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{
      status: "ACTIVE" | "DELETE_PENDING";
    }>>(Prisma.sql`
      WITH completion_candidate AS MATERIALIZED (
        SELECT projection."id",
               (
                 projection."deleteRequestedAt" IS NULL
                 AND memory_record."status" = 'ACTIVE'::"GovernedMemoryStatus"
                 AND memory_record."recallDisabledAt" IS NULL
                 AND memory_record."currentVersionId" = version."id"
                 AND version."purgedAt" IS NULL
                 AND version."safeText" IS NOT NULL
                 AND version."contentHash" = projection."contentHash"
                 AND EXISTS (
                   SELECT 1 FROM "MemoryCandidate" candidate
                    WHERE candidate."id" = version."sourceCandidateId"
                      AND candidate."representativeId" = projection."representativeId"
                      AND candidate."status" = 'APPROVED'::"MemoryCandidateStatus"
                      AND candidate."contentPurgedAt" IS NULL
                 )
                 AND EXISTS (
                   SELECT 1 FROM "MemoryReviewDecision" decision
                    WHERE decision."candidateId" = version."sourceCandidateId"
                      AND decision."resultVersionId" = version."id"
                      AND decision."memoryId" = memory_record."id"
                      AND decision."representativeId" = projection."representativeId"
                      AND decision."outcome" = 'APPROVED'::"MemoryReviewOutcome"
                 )
               ) AS authoritative
          FROM "MemoryProjectionItem" projection
          JOIN "GovernedMemory" memory_record
            ON memory_record."id" = projection."memoryId"
           AND memory_record."representativeId" = projection."representativeId"
          JOIN "GovernedMemoryVersion" version
            ON version."id" = projection."memoryVersionId"
           AND version."memoryId" = projection."memoryId"
           AND version."representativeId" = projection."representativeId"
         WHERE projection."id" = ${claim.id}
           AND projection."status" = 'PROJECTING'::"MemoryProjectionStatus"
           AND projection."leaseToken" = ${claim.leaseToken}
           AND projection."attemptCount" = ${claim.attemptCount}
           AND projection."leaseExpiresAt" > CURRENT_TIMESTAMP
         FOR UPDATE OF projection, memory_record, version
      )
      UPDATE "MemoryProjectionItem" projection
         SET "status" = CASE
               WHEN completion_candidate.authoritative
                 THEN 'ACTIVE'::"MemoryProjectionStatus"
               ELSE 'DELETE_PENDING'::"MemoryProjectionStatus"
             END,
             "remoteObjectId" = COALESCE(projection."remoteObjectId", projection."remoteUri"),
             "writeReceiptHash" = CASE
               WHEN ${repairReason !== null} THEN ${receiptHash}
               ELSE COALESCE(projection."writeReceiptHash", ${receiptHash})
             END,
             "writeVerifiedAt" = CASE
               WHEN ${repairReason !== null} THEN CURRENT_TIMESTAMP
               ELSE COALESCE(projection."writeVerifiedAt", CURRENT_TIMESTAMP)
             END,
             "projectedAt" = CURRENT_TIMESTAMP,
             "deleteRequestedAt" = CASE
               WHEN completion_candidate.authoritative
                 THEN projection."deleteRequestedAt"
               ELSE COALESCE(projection."deleteRequestedAt", CURRENT_TIMESTAMP)
             END,
             "leaseToken" = NULL,
             "leaseExpiresAt" = NULL,
             "lastErrorCode" = CASE
               WHEN completion_candidate.authoritative
                 THEN NULL
               ELSE 'projection_not_authoritative'
             END,
             "updatedAt" = CURRENT_TIMESTAMP
        FROM completion_candidate
       WHERE projection."id" = completion_candidate."id"
         AND projection."status" = 'PROJECTING'::"MemoryProjectionStatus"
         AND projection."leaseToken" = ${claim.leaseToken}
         AND projection."attemptCount" = ${claim.attemptCount}
         AND projection."leaseExpiresAt" > CURRENT_TIMESTAMP
      RETURNING projection."status"
    `);
    const status = rows[0]?.status ?? null;
    const issue = writeReconciliationIssue(repairReason);
    if (status === "ACTIVE" && issue) {
      await resolveProjectionReconciliationIssues(tx, claim, issue);
    }
    return status;
  });
}

async function completeProjectionDeletion(
  client: PrismaClient,
  claim: ProjectionClaim,
  receiptHash: string,
): Promise<boolean> {
  return client.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "MemoryProjectionItem"
         SET "status" = 'DELETED'::"MemoryProjectionStatus",
             "deleteReceiptHash" = ${receiptHash},
             "remoteAbsentAt" = CURRENT_TIMESTAMP,
             "deletedAt" = CURRENT_TIMESTAMP,
             "leaseToken" = NULL,
             "leaseExpiresAt" = NULL,
             "lastErrorCode" = NULL,
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = ${claim.id}
         AND "status" = 'DELETING'::"MemoryProjectionStatus"
         AND "leaseToken" = ${claim.leaseToken}
         AND "attemptCount" = ${claim.attemptCount}
         AND "leaseExpiresAt" > CURRENT_TIMESTAMP
      RETURNING "id"
    `);
    if (rows.length !== 1) return false;
    for (const issue of [
      {
        issueKind: "MISSING_REMOTE" as const,
        reasonCode: "reconciliation_missing_remote" as const,
      },
      {
        issueKind: "HASH_MISMATCH" as const,
        reasonCode: "reconciliation_hash_mismatch" as const,
      },
      {
        issueKind: "STALE_ACTIVE_POINTER" as const,
        reasonCode: "reconciliation_stale_active_pointer" as const,
      },
    ]) {
      await resolveProjectionReconciliationIssues(tx, claim, issue);
    }
    return true;
  });
}

async function resolveProjectionReconciliationIssues(
  tx: Prisma.TransactionClient,
  claim: ProjectionClaim,
  issue: {
    issueKind: "MISSING_REMOTE" | "HASH_MISMATCH" | "STALE_ACTIVE_POINTER";
    reasonCode:
      | "reconciliation_missing_remote"
      | "reconciliation_hash_mismatch"
      | "reconciliation_stale_active_pointer";
  },
) {
  const candidates = await tx.$queryRaw<Array<{
    id: string;
    reconciliationRunId: string;
  }>>(Prisma.sql`
    SELECT item."id", item."reconciliationRunId"
      FROM "MemoryReconciliationItem" item
     WHERE item."projectionItemId" = ${claim.id}
       AND item."representativeId" = ${claim.representativeId}
       AND item."issueKind" = ${issue.issueKind}::"MemoryReconciliationIssueKind"
       AND item."reasonCode" = ${issue.reasonCode}
       AND item."status" IN (
         'OPEN'::"MemoryReconciliationItemStatus",
         'RETRYING'::"MemoryReconciliationItemStatus"
       )
     ORDER BY item."reconciliationRunId" ASC, item."id" ASC
  `);
  if (candidates.length === 0) return;

  const runIds = [...new Set(
    candidates.map((candidate) => candidate.reconciliationRunId),
  )].sort();
  await tx.$queryRaw(Prisma.sql`
    SELECT run."id"
      FROM "MemoryReconciliationRun" run
     WHERE run."id" IN (${Prisma.join(runIds)})
     ORDER BY run."id" ASC
     FOR UPDATE
  `);

  const candidateIds = candidates.map((candidate) => candidate.id);
  const resolved = await tx.$queryRaw<Array<{
    id: string;
    reconciliationRunId: string;
  }>>(Prisma.sql`
    UPDATE "MemoryReconciliationItem" item
       SET "status" = 'RESOLVED'::"MemoryReconciliationItemStatus",
           "resolvedAt" = CURRENT_TIMESTAMP,
           "lastErrorCode" = NULL,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE item."id" IN (${Prisma.join(candidateIds)})
       AND item."status" IN (
         'OPEN'::"MemoryReconciliationItemStatus",
         'RETRYING'::"MemoryReconciliationItemStatus"
       )
    RETURNING item."id", item."reconciliationRunId"
  `);
  if (resolved.length === 0) return;

  const resolvedRunIds = [...new Set(
    resolved.map((item) => item.reconciliationRunId),
  )].sort();
  const updatedRuns = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "MemoryReconciliationRun" run
       SET "resolvedCount" = (
             SELECT COUNT(*)::INTEGER
               FROM "MemoryReconciliationItem" item
              WHERE item."reconciliationRunId" = run."id"
                AND item."status" = 'RESOLVED'::"MemoryReconciliationItemStatus"
           ),
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE run."id" IN (${Prisma.join(resolvedRunIds)})
    RETURNING run."id"
  `);
  if (updatedRuns.length !== resolvedRunIds.length) {
    throw new Error("Reconciliation resolution rollup lost a scoped run.");
  }
}

function writeReconciliationIssue(
  repairReason: ReturnType<typeof writeRepairReason>,
) {
  if (repairReason === "reconciliation_missing_remote") {
    return {
      issueKind: "MISSING_REMOTE" as const,
      reasonCode: "reconciliation_missing_remote" as const,
    };
  }
  if (repairReason === "reconciliation_hash_mismatch") {
    return {
      issueKind: "HASH_MISMATCH" as const,
      reasonCode: "reconciliation_hash_mismatch" as const,
    };
  }
  return null;
}

async function moveClaimToDeletePending(
  client: PrismaClient,
  claim: ProjectionClaim,
  errorCode: string,
): Promise<boolean> {
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "MemoryProjectionItem"
       SET "status" = 'DELETE_PENDING'::"MemoryProjectionStatus",
           "deleteRequestedAt" = COALESCE("deleteRequestedAt", CURRENT_TIMESTAMP),
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "lastErrorCode" = ${errorCode},
           "availableAt" = CURRENT_TIMESTAMP,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = ${claim.id}
       AND "status" = 'PROJECTING'::"MemoryProjectionStatus"
       AND "leaseToken" = ${claim.leaseToken}
       AND "attemptCount" = ${claim.attemptCount}
       AND "leaseExpiresAt" > CURRENT_TIMESTAMP
    RETURNING "id"
  `);
  return rows.length === 1;
}

async function recordWriteFailure(
  client: PrismaClient,
  claim: ProjectionClaim,
  failure: FailureClassification,
  options: MemoryProjectionExecutionOptions,
  context: WriteFailureContext = {},
): Promise<MemoryProjectionTickResult> {
  const repairReason = writeRepairReason(claim.previousErrorCode);
  const exhausted = claim.attemptCount >= positiveInteger(
    options.maximumWriteAttempts,
    defaultMaximumWriteAttempts,
  );
  const cleanupFenceRequired = failure.cleanupRequired
    || (
      repairReason === "projection_write_cleanup_required"
      && !context.exactLeafAbsenceConfirmed
    );
  const retrying = cleanupFenceRequired || (failure.retryable && !exhausted);
  const retainedErrorCode = cleanupFenceRequired
    ? "projection_write_cleanup_required"
    : repairReason === "projection_write_cleanup_required"
      ? failure.code
      : repairReason ?? failure.code;
  const delay = retryDelayMilliseconds(claim.attemptCount, options);
  const rows = await client.$queryRaw<Array<{ status: string }>>(Prisma.sql`
    UPDATE "MemoryProjectionItem"
       SET "status" = CASE
             WHEN "deleteRequestedAt" IS NOT NULL
               THEN 'DELETE_PENDING'::"MemoryProjectionStatus"
             WHEN ${retrying}
               THEN 'RETRYING'::"MemoryProjectionStatus"
             ELSE 'FAILED'::"MemoryProjectionStatus"
           END,
           "availableAt" = CASE
             WHEN "deleteRequestedAt" IS NOT NULL THEN CURRENT_TIMESTAMP
             ELSE CURRENT_TIMESTAMP + (${delay} * INTERVAL '1 millisecond')
           END,
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "lastErrorCode" = CASE
             WHEN "deleteRequestedAt" IS NOT NULL
               THEN 'projection_delete_requested_during_write'
             ELSE ${retainedErrorCode}
           END,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = ${claim.id}
       AND "status" = 'PROJECTING'::"MemoryProjectionStatus"
       AND "leaseToken" = ${claim.leaseToken}
       AND "attemptCount" = ${claim.attemptCount}
       AND "leaseExpiresAt" > CURRENT_TIMESTAMP
    RETURNING "status"
  `);
  if (rows.length !== 1) return leaseLost(claim.id);
  const actualStatus = rows[0]!.status;
  return {
    processed: true,
    workId: claim.id,
    status: actualStatus === "RETRYING"
      ? "retrying"
      : actualStatus === "DELETE_PENDING"
        ? "completed"
        : "failed",
    errorCode: failure.code,
  };
}

async function recordDeleteFailure(
  client: PrismaClient,
  claim: ProjectionClaim,
  failure: FailureClassification,
  options: MemoryProjectionExecutionOptions,
): Promise<MemoryProjectionTickResult> {
  const delay = retryDelayMilliseconds(claim.attemptCount, options);
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "MemoryProjectionItem"
       SET "status" = 'DELETE_FAILED'::"MemoryProjectionStatus",
           "availableAt" = CURRENT_TIMESTAMP
             + (${delay} * INTERVAL '1 millisecond'),
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "lastErrorCode" = ${failure.code},
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = ${claim.id}
       AND "status" = 'DELETING'::"MemoryProjectionStatus"
       AND "leaseToken" = ${claim.leaseToken}
       AND "attemptCount" = ${claim.attemptCount}
       AND "leaseExpiresAt" > CURRENT_TIMESTAMP
    RETURNING "id"
  `);
  if (rows.length !== 1) return leaseLost(claim.id);
  return {
    processed: true,
    workId: claim.id,
    status: failure.retryable ? "retrying" : "failed",
    errorCode: failure.code,
  };
}

async function executeDeletionCleanup(
  client: PrismaClient,
  claim: CleanupClaim,
  options: MemoryProjectionExecutionOptions,
): Promise<"completed" | "draining" | "lease_lost"> {
  return client.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT proof."id"
        FROM "MemoryDeletionProof" proof
        JOIN "GovernedMemory" memory_record
          ON memory_record."id" = proof."memoryId"
         AND memory_record."representativeId" = proof."representativeId"
       WHERE proof."id" = ${claim.id}
         AND proof."cleanupStatus" = 'RUNNING'::"MemoryCleanupStatus"
         AND proof."leaseToken" = ${claim.leaseToken}
         AND proof."attemptCount" = ${claim.attemptCount}
         AND proof."leaseExpiresAt" > CURRENT_TIMESTAMP
         AND memory_record."status" = 'DELETE_PENDING'::"GovernedMemoryStatus"
       FOR UPDATE OF proof, memory_record
    `);
    if (locked.length !== 1) return "lease_lost";

    await tx.memoryCandidate.updateMany({
      where: {
        representativeId: claim.representativeId,
        OR: [
          { correctionMemoryId: claim.memoryId },
          { version: { is: { memoryId: claim.memoryId } } },
        ],
        contentPurgedAt: null,
      },
      data: {
        safeText: null,
        summary: null,
        contentPurgedAt: new Date(),
      },
    });
    await tx.governedMemoryVersion.updateMany({
      where: { memoryId: claim.memoryId, purgedAt: null },
      data: { safeText: null, summary: null, purgedAt: new Date() },
    });
    await tx.$queryRaw(Prisma.sql`
      UPDATE "MemoryDeletionProof"
         SET "localPurgeCompletedAt" = COALESCE(
               "localPurgeCompletedAt",
               CURRENT_TIMESTAMP
             ),
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = ${claim.id}
         AND "cleanupStatus" = 'RUNNING'::"MemoryCleanupStatus"
         AND "leaseToken" = ${claim.leaseToken}
         AND "attemptCount" = ${claim.attemptCount}
         AND "leaseExpiresAt" > CURRENT_TIMESTAMP
    `);

    await tx.$queryRaw(Prisma.sql`
      UPDATE "MemoryProjectionItem"
         SET "deleteRequestedAt" = COALESCE("deleteRequestedAt", CURRENT_TIMESTAMP),
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "memoryId" = ${claim.memoryId}
         AND "status" IN (
           'PROJECTING'::"MemoryProjectionStatus",
           'DELETING'::"MemoryProjectionStatus"
         )
    `);
    await tx.$queryRaw(Prisma.sql`
      UPDATE "MemoryProjectionItem"
       SET "status" = 'DELETE_PENDING'::"MemoryProjectionStatus",
             "deleteRequestedAt" = COALESCE("deleteRequestedAt", CURRENT_TIMESTAMP),
             "leaseToken" = NULL,
             "leaseExpiresAt" = NULL,
             "lastErrorCode" = NULL,
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "memoryId" = ${claim.memoryId}
         AND "status" NOT IN (
           'PROJECTING'::"MemoryProjectionStatus",
           'DELETING'::"MemoryProjectionStatus",
           'DELETED'::"MemoryProjectionStatus"
         )
    `);

    const projections = await tx.$queryRaw<Array<{
      id: string;
      status: string;
      leaseToken: string | null;
      leaseExpiresAt: Date | null;
      deleteReceiptHash: string | null;
      remoteAbsentAt: Date | null;
    }>>(Prisma.sql`
      SELECT "id", "status", "leaseToken", "leaseExpiresAt",
             "deleteReceiptHash", "remoteAbsentAt"
        FROM "MemoryProjectionItem"
       WHERE "memoryId" = ${claim.memoryId}
       ORDER BY "id" ASC
       FOR SHARE
    `);

    const drained = projections.every((projection) =>
      projection.status === "DELETED"
      && projection.leaseToken === null
      && projection.leaseExpiresAt === null
      && projection.deleteReceiptHash !== null
      && projection.remoteAbsentAt !== null
    );
    if (!drained) {
      const delay = retryDelayMilliseconds(claim.attemptCount, options);
      const retried = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "MemoryDeletionProof"
           SET "cleanupStatus" = 'RETRYING'::"MemoryCleanupStatus",
               "availableAt" = CURRENT_TIMESTAMP
                 + (${delay} * INTERVAL '1 millisecond'),
               "leaseToken" = NULL,
               "leaseExpiresAt" = NULL,
               "lastErrorCode" = 'projection_drain_pending',
               "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = ${claim.id}
           AND "cleanupStatus" = 'RUNNING'::"MemoryCleanupStatus"
           AND "leaseToken" = ${claim.leaseToken}
           AND "attemptCount" = ${claim.attemptCount}
           AND "leaseExpiresAt" > CURRENT_TIMESTAMP
        RETURNING "id"
      `);
      return retried.length === 1 ? "draining" : "lease_lost";
    }

    const providerReceiptHash = hashCanonicalJson(
      projections.map((projection) => ({
        projectionId: projection.id,
        deleteReceiptHash: projection.deleteReceiptHash!,
      })),
    );
    const proofCoordinates = await tx.$queryRaw<Array<{
      id: string;
      representativeId: string;
      memoryId: string;
      requestId: string;
      reasonCode: string;
      contentHash: string;
      recallBlockedAt: Date;
      localPurgeCompletedAt: Date;
      completionAt: Date;
    }>>(Prisma.sql`
      SELECT "id", "representativeId", "memoryId", "requestId",
             "reasonCode", "contentHash", "recallBlockedAt",
             "localPurgeCompletedAt",
             GREATEST(CURRENT_TIMESTAMP, "localPurgeCompletedAt")
               + INTERVAL '1 millisecond' AS "completionAt"
        FROM "MemoryDeletionProof"
       WHERE "id" = ${claim.id}
         AND "cleanupStatus" = 'RUNNING'::"MemoryCleanupStatus"
         AND "leaseToken" = ${claim.leaseToken}
         AND "attemptCount" = ${claim.attemptCount}
         AND "leaseExpiresAt" > CURRENT_TIMESTAMP
       FOR UPDATE
    `);
    const proofCoordinate = proofCoordinates[0];
    if (!proofCoordinate?.localPurgeCompletedAt) return "lease_lost";
    const proofHash = hashCanonicalJson({
      proofVersion: 1,
      proofId: proofCoordinate.id,
      representativeId: proofCoordinate.representativeId,
      memoryId: proofCoordinate.memoryId,
      requestId: proofCoordinate.requestId,
      reasonCode: proofCoordinate.reasonCode,
      contentHash: proofCoordinate.contentHash,
      recallBlockedAt: proofCoordinate.recallBlockedAt.toISOString(),
      localPurgeCompletedAt: proofCoordinate.localPurgeCompletedAt.toISOString(),
      remotePurgeCompletedAt: proofCoordinate.completionAt.toISOString(),
      providerReceiptHash,
    });
    const completionRows = await tx.$queryRaw<Array<{
      localPurgeCompletedAt: Date;
      remotePurgeCompletedAt: Date;
    }>>(Prisma.sql`
      UPDATE "MemoryDeletionProof"
         SET "cleanupStatus" = 'SUCCEEDED'::"MemoryCleanupStatus",
             "remotePurgeCompletedAt" = ${proofCoordinate.completionAt},
             "providerReceiptHash" = ${providerReceiptHash},
             "proofHash" = ${proofHash},
             "completedAt" = ${proofCoordinate.completionAt},
             "leaseToken" = NULL,
             "leaseExpiresAt" = NULL,
             "lastErrorCode" = NULL,
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = ${claim.id}
         AND "cleanupStatus" = 'RUNNING'::"MemoryCleanupStatus"
         AND "leaseToken" = ${claim.leaseToken}
         AND "attemptCount" = ${claim.attemptCount}
         AND "leaseExpiresAt" > CURRENT_TIMESTAMP
      RETURNING "localPurgeCompletedAt", "remotePurgeCompletedAt"
    `);
    if (completionRows.length !== 1) return "lease_lost";

    const deleted = await tx.governedMemory.updateMany({
      where: {
        id: claim.memoryId,
        representativeId: claim.representativeId,
        status: "DELETE_PENDING",
      },
      data: { status: "DELETED", deletedAt: new Date() },
    });
    if (deleted.count !== 1) {
      throw new Error("Deletion proof completed without deleting its memory tombstone.");
    }
    return "completed";
  });
}

async function recordCleanupFailure(
  client: PrismaClient,
  claim: CleanupClaim,
  errorCode: string,
  options: MemoryProjectionExecutionOptions,
): Promise<MemoryProjectionTickResult> {
  const maximumAttempts = positiveInteger(
    options.maximumCleanupAttempts,
    defaultMaximumCleanupAttempts,
  );
  const failed = claim.attemptCount >= maximumAttempts;
  const delay = retryDelayMilliseconds(claim.attemptCount, options);
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "MemoryDeletionProof"
       SET "cleanupStatus" = ${failed
         ? Prisma.sql`'FAILED'::"MemoryCleanupStatus"`
         : Prisma.sql`'RETRYING'::"MemoryCleanupStatus"`},
           "availableAt" = CURRENT_TIMESTAMP
             + (${delay} * INTERVAL '1 millisecond'),
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "lastErrorCode" = ${errorCode},
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = ${claim.id}
       AND "cleanupStatus" = 'RUNNING'::"MemoryCleanupStatus"
       AND "leaseToken" = ${claim.leaseToken}
       AND "attemptCount" = ${claim.attemptCount}
       AND "leaseExpiresAt" > CURRENT_TIMESTAMP
    RETURNING "id"
  `);
  if (rows.length !== 1) return leaseLost(claim.id);
  return {
    processed: true,
    workId: claim.id,
    status: failed ? "failed" : "retrying",
    errorCode,
  };
}

function resolveProjectionProvider(
  providerName: string,
  options: MemoryProjectionExecutionOptions,
): MemoryProjectionProvider | null {
  const resolved = options.resolveProvider?.(providerName);
  if (resolved !== undefined) return resolved;
  if (options.provider?.name === providerName) return options.provider;
  if (providerName !== "openviking") return null;
  return createDefaultMemoryProjectionProvider();
}

function defaultProviderErrorCode(
  providerName: string,
  options: MemoryProjectionExecutionOptions,
) {
  if (
    providerName === "openviking"
    && !options.provider
    && !options.resolveProvider
    && !defaultMemoryProjectionProviderIsEnabled()
  ) {
    return "projection_provider_disabled";
  }
  return "projection_provider_unavailable";
}

function writeRepairReason(value: string | null) {
  return value === "reconciliation_missing_remote"
    || value === "reconciliation_hash_mismatch"
    || value === "reconciliation_stale_active_pointer"
    || value === "projection_write_cleanup_required"
    ? value
    : null;
}

function classifyProviderFailure(
  error: unknown,
  operation: "ensure_root" | "write_exact" | "inspect_after_write" | "delete_exact",
): FailureClassification {
  if (error instanceof MemoryProjectionProviderError) {
    return {
      code: stableErrorCode(error.code, "projection_provider_failure"),
      retryable: error.retryable,
      cleanupRequired: error.cleanupRequired
        || operation === "inspect_after_write"
        || (operation === "write_exact" && error.retryable),
    };
  }
  const status = providerErrorStatus(error);
  const retryable = status === 408
    || status === 425
    || status === 429
    || (status !== null && status >= 500)
    || (status === null && isNetworkLikeError(error));

  if (operation === "ensure_root") {
    return {
      code: "projection_root_provision_failed",
      retryable,
      cleanupRequired: false,
    };
  }
  if (operation === "write_exact" && status === 409) {
    return {
      code: "projection_content_conflict",
      retryable: false,
      cleanupRequired: true,
    };
  }
  if (operation === "write_exact") {
    const explicitlyRejected = status !== null
      && status >= 400
      && status < 500
      && status !== 408;
    return {
      code: "projection_write_provider_failed",
      retryable,
      // Once writeExact has been dispatched, a successful-but-malformed
      // response, a transport timeout, or a server failure cannot prove that
      // the immutable leaf was not created. Exact cleanup is safe and must run
      // before the same URI is retried. Explicit 4xx rejections (apart from the
      // content-conflict repair above) are known not to have committed.
      cleanupRequired: !explicitlyRejected,
    };
  }
  return {
    code: operation === "delete_exact"
      ? "projection_delete_provider_failed"
      : operation === "inspect_after_write"
        ? "projection_write_verification_failed"
        : "projection_write_provider_failed",
    retryable,
    cleanupRequired: operation === "inspect_after_write",
  };
}

function providerErrorStatus(error: unknown): number | null {
  if (error instanceof OpenVikingRequestError) return error.status;
  if (
    typeof error === "object"
    && error !== null
    && "status" in error
    && typeof error.status === "number"
  ) {
    return error.status;
  }
  return null;
}

function isNetworkLikeError(error: unknown): boolean {
  return error instanceof TypeError
    || (
      error instanceof Error
      && (error.name === "AbortError" || error.name === "TimeoutError")
    );
}

export function resolveMemoryProjectionRetryDelayMilliseconds(
  attemptCount: number,
  options: Pick<
    MemoryProjectionExecutionOptions,
    "retryBaseMilliseconds" | "retryMaximumMilliseconds"
  > = {},
): number {
  return retryDelayMilliseconds(attemptCount, options);
}

function retryDelayMilliseconds(
  attemptCount: number,
  options: Pick<
    MemoryProjectionExecutionOptions,
    "retryBaseMilliseconds" | "retryMaximumMilliseconds"
  >,
) {
  const base = positiveInteger(
    options.retryBaseMilliseconds,
    defaultRetryBaseMilliseconds,
  );
  const maximum = positiveInteger(
    options.retryMaximumMilliseconds,
    defaultRetryMaximumMilliseconds,
  );
  return Math.min(
    maximum,
    base * (2 ** Math.max(0, Math.trunc(attemptCount) - 1)),
  );
}

function positiveInteger(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function optionalNonEmptyText(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function stableErrorCode(value: string, fallback: string) {
  return /^[a-z][a-z0-9_]{0,127}$/u.test(value) ? value : fallback;
}

function sha256Text(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashReceiptEvidence(receipts: readonly string[]) {
  return hashCanonicalJson([...receipts]);
}

function hashCanonicalJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function leaseLost(workId: string): MemoryProjectionTickResult {
  return {
    processed: true,
    workId,
    status: "lease_lost",
    errorCode: "projection_lease_lost",
  };
}

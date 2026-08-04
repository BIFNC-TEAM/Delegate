import { createHash, randomUUID } from "node:crypto";

import {
  assertExactGovernedMemoryVersionUri,
  buildGovernedMemoryManagedUserId,
  OpenVikingClient,
  OpenVikingRequestError,
  resolveOpenVikingEnv,
} from "@delegate/openviking";
import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma } from "./prisma";

export const OPENVIKING_INVENTORY_NO_SNAPSHOT_CURSOR =
  "openviking_inventory_no_snapshot_cursor";

const defaultLeaseMilliseconds = 60_000;
const defaultPageSize = 16;
const maximumPageSize = 64;
const defaultMaximumTargetAttempts = 8;
const defaultReconciliationIntervalMilliseconds = 5 * 60_000;
const defaultRetryBaseMilliseconds = 1_000;
const defaultRetryMaximumMilliseconds = 5 * 60_000;
const sha256Pattern = /^[0-9a-f]{64}$/u;

export type MemoryReconciliationProviderInspectInput = {
  namespaceKey: string;
  uri: string;
};

/**
 * Reconciliation intentionally has no provider enumerate or delete method.
 * OpenViking v0.4.12 cannot prove a complete, point-in-time remote inventory,
 * and a read-side drift detector must never become an alternate deletion API.
 */
export interface MemoryReconciliationProvider {
  readonly name: string;
  inspectExact(input: MemoryReconciliationProviderInspectInput): Promise<{
    uri: string;
    exists: boolean;
    contentHash?: string;
  }>;
}

export class OpenVikingMemoryReconciliationProvider
implements MemoryReconciliationProvider {
  readonly name = "openviking";

  constructor(private readonly client: OpenVikingClient) {}

  async inspectExact(input: MemoryReconciliationProviderInspectInput) {
    const client = this.client.withScope({
      userId: buildGovernedMemoryManagedUserId(input.namespaceKey),
    });
    try {
      const result = await client.readGovernedMemoryVersion(input);
      return {
        uri: result.uri,
        exists: true,
        contentHash: result.contentHash,
      };
    } catch (error) {
      if (error instanceof OpenVikingRequestError && error.status === 404) {
        return { uri: input.uri, exists: false };
      }
      throw error;
    }
  }
}

export type MemoryReconciliationTargetKind =
  | "EXPECTED_ACTIVE"
  | "KNOWN_STALE"
  | "RETAINED_INACTIVE"
  | "LIVE_IN_FLIGHT";

export type MemoryReconciliationTargetClaim = {
  projectionItemId: string;
  representativeId: string;
  memoryId: string;
  memoryVersionId: string;
  provider: string;
  namespaceKey: string;
  kind: MemoryReconciliationTargetKind;
  remoteUri: string;
  expectedContentHash: string;
  snapshotProjectionStatus: string;
  snapshotProjectionUpdatedAt: Date;
  snapshotAttemptCount: number;
  targetAttemptCount: number;
};

export type MemoryReconciliationClaim = {
  runId: string;
  representativeId: string;
  provider: string;
  runAttemptCount: number;
  leaseToken: string;
  leaseExpiresAt: Date;
  targets: MemoryReconciliationTargetClaim[];
};

export type MemoryReconciliationTargetObservation =
  | {
      kind: "matched";
      target: MemoryReconciliationTargetClaim;
      observedContentHash: string;
    }
  | {
      kind: "missing";
      target: MemoryReconciliationTargetClaim;
    }
  | {
      kind: "hash_mismatch";
      target: MemoryReconciliationTargetClaim;
      observedContentHash: string;
    }
  | {
      kind: "known_stale";
      target: MemoryReconciliationTargetClaim;
    }
  | {
      kind: "live_in_flight";
      target: MemoryReconciliationTargetClaim;
    }
  | {
      kind: "retained_inactive";
      target: MemoryReconciliationTargetClaim;
    }
  | {
      kind: "retryable_error" | "permanent_error";
      target: MemoryReconciliationTargetClaim;
      errorCode: string;
    };

export type MemoryReconciliationCoverage = {
  checked: number;
  total: number;
  matched: number;
  issues: number;
  skipped: number;
  retrying: number;
  failed: number;
};

export type MemoryReconciliationPageCommit = {
  state: "partial" | "requeued" | "lease_lost";
  coverage: MemoryReconciliationCoverage;
  availableAt?: Date;
};

export interface MemoryReconciliationRepository {
  ensureDueRun(input: {
    now: Date;
    intervalMilliseconds: number;
  }): Promise<boolean>;
  claimNext(input: {
    leaseToken: string;
    leaseMilliseconds: number;
    pageSize: number;
  }): Promise<MemoryReconciliationClaim | null>;
  completePage(input: {
    claim: MemoryReconciliationClaim;
    observations: readonly MemoryReconciliationTargetObservation[];
    maximumTargetAttempts: number;
    retryBaseMilliseconds: number;
    retryMaximumMilliseconds: number;
  }): Promise<MemoryReconciliationPageCommit>;
}

export type MemoryReconciliationExecutionOptions = {
  client?: PrismaClient;
  repository?: MemoryReconciliationRepository;
  provider?: MemoryReconciliationProvider;
  resolveProvider?: (
    providerName: string,
  ) => MemoryReconciliationProvider | null | undefined;
  leaseMilliseconds?: number;
  pageSize?: number;
  maximumTargetAttempts?: number;
  retryBaseMilliseconds?: number;
  retryMaximumMilliseconds?: number;
  reconciliationIntervalMilliseconds?: number;
  now?: () => Date;
};

export type MemoryReconciliationTickResult =
  | {
      processed: false;
      inventoryStatus: "partial";
      exactProbe: "supported";
      remoteEnumeration: "unsupported";
      errorCode: typeof OPENVIKING_INVENTORY_NO_SNAPSHOT_CURSOR;
    }
  | {
      processed: true;
      runId: string;
      status: "partial" | "requeued" | "lease_lost";
      inventoryStatus: "partial";
      exactProbe: "supported";
      remoteEnumeration: "unsupported";
      errorCode: string;
      operationalStatus: "ok" | "retrying" | "failed";
      operationalErrorCode?: string;
      known: MemoryReconciliationCoverage;
      availableAt?: Date;
    };

export type MemoryReconciliationExactProbeResult =
  | { kind: "matched"; observedContentHash: string }
  | { kind: "missing" }
  | { kind: "hash_mismatch"; observedContentHash: string };

export function classifyMemoryReconciliationExactProbe(
  expectedContentHash: string,
  result: { uri: string; exists: boolean; contentHash?: string },
): MemoryReconciliationExactProbeResult {
  requireSha256(expectedContentHash, "expected content hash");
  if (!result.exists) return { kind: "missing" };
  const observedContentHash = requireSha256(
    result.contentHash,
    "observed content hash",
  );
  return observedContentHash === expectedContentHash
    ? { kind: "matched", observedContentHash }
    : { kind: "hash_mismatch", observedContentHash };
}

export async function runNextMemoryReconciliation(
  options: MemoryReconciliationExecutionOptions = {},
): Promise<MemoryReconciliationTickResult> {
  const leaseMilliseconds = positiveInteger(
    options.leaseMilliseconds,
    defaultLeaseMilliseconds,
  );
  const pageSize = boundedPageSize(options.pageSize);
  const maximumTargetAttempts = positiveInteger(
    options.maximumTargetAttempts,
    defaultMaximumTargetAttempts,
  );
  const retryBaseMilliseconds = positiveInteger(
    options.retryBaseMilliseconds,
    defaultRetryBaseMilliseconds,
  );
  const retryMaximumMilliseconds = positiveInteger(
    options.retryMaximumMilliseconds,
    defaultRetryMaximumMilliseconds,
  );
  const repository = options.repository
    ?? new PrismaMemoryReconciliationRepository(options.client ?? prisma);
  const now = options.now?.() ?? new Date();
  await repository.ensureDueRun({
    now,
    intervalMilliseconds: positiveInteger(
      options.reconciliationIntervalMilliseconds,
      defaultReconciliationIntervalMilliseconds,
    ),
  });
  const claim = await repository.claimNext({
    leaseToken: randomUUID(),
    leaseMilliseconds,
    pageSize,
  });
  if (!claim) return noWorkResult();

  let provider: MemoryReconciliationProvider | null = null;
  let providerUnavailableCode = "reconciliation_provider_unavailable";
  if (claim.targets.some((target) => target.kind === "EXPECTED_ACTIVE")) {
    try {
      provider = resolveReconciliationProvider(claim.provider, options);
    } catch (error) {
      provider = null;
      if (error instanceof MemoryReconciliationProviderError) {
        providerUnavailableCode = error.code;
      }
    }
  }
  const observations = await Promise.all(
    claim.targets.map((target) =>
      inspectClaimedTarget(target, provider, providerUnavailableCode)
    ),
  );
  const committed = await repository.completePage({
    claim,
    observations,
    maximumTargetAttempts,
    retryBaseMilliseconds,
    retryMaximumMilliseconds,
  });
  const operational = classifyReconciliationOperationalResult({
    committed,
    observations,
    maximumTargetAttempts,
  });

  return {
    processed: true,
    runId: claim.runId,
    status: committed.state,
    inventoryStatus: "partial",
    exactProbe: "supported",
    remoteEnumeration: "unsupported",
    errorCode: committed.state === "lease_lost"
      ? "reconciliation_lease_lost"
      : OPENVIKING_INVENTORY_NO_SNAPSHOT_CURSOR,
    operationalStatus: operational.status,
    ...(operational.errorCode
      ? { operationalErrorCode: operational.errorCode }
      : {}),
    known: committed.coverage,
    ...(committed.availableAt ? { availableAt: committed.availableAt } : {}),
  };
}

function classifyReconciliationOperationalResult(input: {
  committed: MemoryReconciliationPageCommit;
  observations: readonly MemoryReconciliationTargetObservation[];
  maximumTargetAttempts: number;
}): {
  status: "ok" | "retrying" | "failed";
  errorCode?: string;
} {
  if (input.committed.state === "lease_lost") {
    return { status: "failed", errorCode: "reconciliation_lease_lost" };
  }

  const permanentFailure = input.observations.find(
    (observation) => observation.kind === "permanent_error",
  );
  const exhaustedRetry = input.observations.find(
    (observation) => observation.kind === "retryable_error"
      && observation.target.targetAttemptCount >= input.maximumTargetAttempts,
  );
  if (input.committed.coverage.failed > 0 || permanentFailure || exhaustedRetry) {
    return {
      status: "failed",
      errorCode: permanentFailure?.kind === "permanent_error"
        ? permanentFailure.errorCode
        : exhaustedRetry
          ? "reconciliation_attempts_exhausted"
          : "reconciliation_target_failed",
    };
  }

  const retryableFailure = input.observations.find(
    (observation) => observation.kind === "retryable_error",
  );
  if (
    input.committed.coverage.retrying > 0
    || retryableFailure?.kind === "retryable_error"
  ) {
    return {
      status: "retrying",
      errorCode: retryableFailure?.kind === "retryable_error"
        ? retryableFailure.errorCode
        : "reconciliation_target_retrying",
    };
  }

  return { status: "ok" };
}

class PrismaMemoryReconciliationRepository
implements MemoryReconciliationRepository {
  constructor(private readonly client: PrismaClient) {}

  async ensureDueRun(input: {
    now: Date;
    intervalMilliseconds: number;
  }) {
    const bucket = Math.floor(
      input.now.getTime() / input.intervalMilliseconds,
    );
    const idempotencyKey = `periodic:${bucket}`;
    const rows = await this.client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH due_representative AS MATERIALIZED (
        SELECT policy."representativeId", policy."provider"
          FROM "RepresentativeMemoryPolicy" policy
         WHERE EXISTS (
           SELECT 1
             FROM "MemoryProjectionItem" projection
            WHERE projection."representativeId" = policy."representativeId"
              AND projection."provider" = policy."provider"
              AND projection."lane" = 'RECALL'::"MemoryProjectionLane"
              AND projection."status" <> 'DELETED'::"MemoryProjectionStatus"
         )
           AND NOT EXISTS (
             SELECT 1
               FROM "MemoryReconciliationRun" active_run
              WHERE active_run."representativeId" = policy."representativeId"
                AND active_run."status" IN (
                  'QUEUED'::"MemoryReconciliationStatus",
                  'RUNNING'::"MemoryReconciliationStatus"
                )
           )
           AND NOT EXISTS (
             SELECT 1
               FROM "MemoryReconciliationRun" bucket_run
              WHERE bucket_run."representativeId" = policy."representativeId"
                AND bucket_run."idempotencyKey" = ${idempotencyKey}
           )
         ORDER BY (
           SELECT MAX(previous_run."createdAt")
             FROM "MemoryReconciliationRun" previous_run
            WHERE previous_run."representativeId" = policy."representativeId"
         ) ASC NULLS FIRST,
         policy."representativeId" ASC
         FOR UPDATE OF policy SKIP LOCKED
         LIMIT 1
      )
      INSERT INTO "MemoryReconciliationRun" (
        "id",
        "representativeId",
        "provider",
        "status",
        "idempotencyKey",
        "asOf",
        "availableAt",
        "createdAt",
        "updatedAt"
      )
      SELECT ${randomUUID()},
             due."representativeId",
             due."provider",
             'QUEUED'::"MemoryReconciliationStatus",
             ${idempotencyKey},
             CURRENT_TIMESTAMP,
             date_trunc('milliseconds', CURRENT_TIMESTAMP),
             CURRENT_TIMESTAMP,
             CURRENT_TIMESTAMP
        FROM due_representative due
      ON CONFLICT DO NOTHING
      RETURNING "id"
    `);
    return rows.length === 1;
  }

  async claimNext(input: {
    leaseToken: string;
    leaseMilliseconds: number;
    pageSize: number;
  }): Promise<MemoryReconciliationClaim | null> {
    return this.client.$transaction(async (tx) => {
      await recoverExpiredReconciliationLeases(tx);
      const runRows = await tx.$queryRaw<RunClaimRow[]>(Prisma.sql`
        WITH next_run AS MATERIALIZED (
          SELECT run."id"
            FROM "MemoryReconciliationRun" run
           WHERE run."status" = 'QUEUED'::"MemoryReconciliationStatus"
             AND run."availableAt" <= CURRENT_TIMESTAMP
           ORDER BY run."availableAt" ASC,
                    run."createdAt" ASC,
                    run."id" ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        UPDATE "MemoryReconciliationRun" run
           SET "status" = 'RUNNING'::"MemoryReconciliationStatus",
               "attemptCount" = run."attemptCount" + 1,
               "leaseToken" = ${input.leaseToken},
               "leaseExpiresAt" = CURRENT_TIMESTAMP
                 + (${input.leaseMilliseconds} * INTERVAL '1 millisecond'),
               "startedAt" = COALESCE(run."startedAt", CURRENT_TIMESTAMP),
               "asOf" = CASE
                 WHEN run."attemptCount" = 0 THEN CURRENT_TIMESTAMP
                 ELSE run."asOf"
               END,
               "finishedAt" = NULL,
               "errorCode" = NULL,
               "updatedAt" = CURRENT_TIMESTAMP
          FROM next_run
         WHERE run."id" = next_run."id"
        RETURNING run."id" AS "runId",
                  run."representativeId",
                  run."provider",
                  run."attemptCount" AS "runAttemptCount",
                  run."leaseToken",
                  run."leaseExpiresAt"
      `);
      const run = runRows[0];
      if (!run) return null;

      await materializeReconciliationTargets(tx, run);
      await tx.$queryRaw(Prisma.sql`
        UPDATE "MemoryReconciliationRun" run
           SET "expectedCount" = (
                 SELECT COUNT(*)::INTEGER
                   FROM "MemoryReconciliationTarget" target
                  WHERE target."reconciliationRunId" = run."id"
               ),
               "updatedAt" = CURRENT_TIMESTAMP
         WHERE run."id" = ${run.runId}
           AND run."status" = 'RUNNING'::"MemoryReconciliationStatus"
           AND run."leaseToken" = ${run.leaseToken}
           AND run."attemptCount" = ${run.runAttemptCount}
      `);

      const targets = await tx.$queryRaw<TargetClaimRow[]>(Prisma.sql`
        WITH next_target AS MATERIALIZED (
          SELECT target."reconciliationRunId", target."projectionItemId"
            FROM "MemoryReconciliationTarget" target
           WHERE target."reconciliationRunId" = ${run.runId}
             AND target."status" IN (
               'PENDING'::"MemoryReconciliationTargetStatus",
               'RETRYING'::"MemoryReconciliationTargetStatus"
             )
             AND target."availableAt" <= CURRENT_TIMESTAMP
           ORDER BY target."projectionItemId" ASC
           FOR UPDATE SKIP LOCKED
           LIMIT ${input.pageSize}
        ), claimed_target AS (
          UPDATE "MemoryReconciliationTarget" target
             SET "status" = 'CHECKING'::"MemoryReconciliationTargetStatus",
                 "attemptCount" = target."attemptCount" + 1,
                 "leaseToken" = ${run.leaseToken},
                 "leaseExpiresAt" = ${run.leaseExpiresAt},
                 "lastErrorCode" = NULL,
                 "updatedAt" = CURRENT_TIMESTAMP
            FROM next_target
           WHERE target."reconciliationRunId" = next_target."reconciliationRunId"
             AND target."projectionItemId" = next_target."projectionItemId"
          RETURNING target.*
        )
        SELECT target."projectionItemId",
               target."representativeId",
               projection."memoryId",
               projection."memoryVersionId",
               projection."provider",
               policy."namespaceKey",
               target."kind",
               target."snapshotRemoteUri" AS "remoteUri",
               target."expectedContentHash",
               target."snapshotProjectionStatus",
               target."snapshotProjectionUpdatedAt",
               target."snapshotAttemptCount",
               target."attemptCount" AS "targetAttemptCount"
          FROM claimed_target target
          JOIN "MemoryProjectionItem" projection
            ON projection."id" = target."projectionItemId"
           AND projection."representativeId" = target."representativeId"
          JOIN "RepresentativeMemoryPolicy" policy
            ON policy."representativeId" = target."representativeId"
         ORDER BY target."projectionItemId" ASC
      `);

      return {
        ...run,
        targets,
      };
    });
  }

  async completePage(input: {
    claim: MemoryReconciliationClaim;
    observations: readonly MemoryReconciliationTargetObservation[];
    maximumTargetAttempts: number;
    retryBaseMilliseconds: number;
    retryMaximumMilliseconds: number;
  }): Promise<MemoryReconciliationPageCommit> {
    return this.client.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT run."id"
          FROM "MemoryReconciliationRun" run
         WHERE run."id" = ${input.claim.runId}
           AND run."status" = 'RUNNING'::"MemoryReconciliationStatus"
           AND run."leaseToken" = ${input.claim.leaseToken}
           AND run."attemptCount" = ${input.claim.runAttemptCount}
           AND run."leaseExpiresAt" > CURRENT_TIMESTAMP
         FOR UPDATE
      `);
      if (locked.length !== 1) {
        return {
          state: "lease_lost",
          coverage: emptyCoverage(),
        };
      }

      for (const observation of input.observations) {
        await persistTargetObservation(tx, input, observation);
      }

      return finishOrRequeueRun(tx, input.claim);
    });
  }
}

type RunClaimRow = Omit<MemoryReconciliationClaim, "targets">;
type TargetClaimRow = MemoryReconciliationTargetClaim;

type TransactionClient = Prisma.TransactionClient;

async function recoverExpiredReconciliationLeases(
  tx: TransactionClient,
) {
  await tx.$queryRaw(Prisma.sql`
    WITH expired_target AS MATERIALIZED (
      SELECT target."reconciliationRunId", target."projectionItemId"
        FROM "MemoryReconciliationTarget" target
       WHERE target."status" = 'CHECKING'::"MemoryReconciliationTargetStatus"
         AND target."leaseExpiresAt" <= CURRENT_TIMESTAMP
       ORDER BY target."leaseExpiresAt" ASC,
                target."projectionItemId" ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 64
    )
    UPDATE "MemoryReconciliationTarget" target
       SET "status" = 'RETRYING'::"MemoryReconciliationTargetStatus",
           "availableAt" = CURRENT_TIMESTAMP,
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "lastErrorCode" = 'reconciliation_target_lease_expired',
           "updatedAt" = CURRENT_TIMESTAMP
      FROM expired_target
     WHERE target."reconciliationRunId" = expired_target."reconciliationRunId"
       AND target."projectionItemId" = expired_target."projectionItemId"
  `);
  await tx.$queryRaw(Prisma.sql`
    WITH expired_run AS MATERIALIZED (
      SELECT run."id"
        FROM "MemoryReconciliationRun" run
       WHERE run."status" = 'RUNNING'::"MemoryReconciliationStatus"
         AND run."leaseExpiresAt" <= CURRENT_TIMESTAMP
       ORDER BY run."leaseExpiresAt" ASC, run."id" ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 32
    )
    UPDATE "MemoryReconciliationRun" run
       SET "status" = 'QUEUED'::"MemoryReconciliationStatus",
           "availableAt" = CURRENT_TIMESTAMP,
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "errorCode" = 'reconciliation_run_lease_expired',
           "updatedAt" = CURRENT_TIMESTAMP
      FROM expired_run
     WHERE run."id" = expired_run."id"
  `);
}

async function materializeReconciliationTargets(
  tx: TransactionClient,
  run: RunClaimRow,
) {
  await tx.$queryRaw(Prisma.sql`
    INSERT INTO "MemoryReconciliationTarget" (
      "reconciliationRunId",
      "representativeId",
      "projectionItemId",
      "kind",
      "status",
      "snapshotProjectionStatus",
      "snapshotProjectionUpdatedAt",
      "snapshotAttemptCount",
      "snapshotRemoteUri",
      "expectedContentHash",
      "attemptCount",
      "availableAt",
      "createdAt",
      "updatedAt"
    )
    SELECT run."id",
           run."representativeId",
           projection."id",
           CASE
             WHEN projection."status" = 'PROJECTING'::"MemoryProjectionStatus"
               THEN 'LIVE_IN_FLIGHT'::"MemoryReconciliationTargetKind"
             WHEN projection."status" = 'ACTIVE'::"MemoryProjectionStatus"
              AND projection."deleteRequestedAt" IS NULL
              AND memory_record."status" = 'ACTIVE'::"GovernedMemoryStatus"
              AND memory_record."recallDisabledAt" IS NULL
              AND (
                memory_record."expiresAt" IS NULL
                OR memory_record."expiresAt" > CURRENT_TIMESTAMP
              )
              AND memory_record."currentVersionId" = projection."memoryVersionId"
              AND version."purgedAt" IS NULL
              AND version."contentHash" = projection."contentHash"
              AND policy."provider" = projection."provider"
              AND policy."longTermMemoryEnabled"
              AND (
                (
                  memory_record."scope" = 'CONTACT_CHANNEL'::"MemoryScope"
                  AND policy."contactMemoryEnabled"
                  AND CASE memory_record."sourceChannel"
                    WHEN 'WEB'::"RepresentativeChannelKind"
                      THEN policy."webRecallEnabled"
                    WHEN 'MATRIX'::"RepresentativeChannelKind"
                      THEN policy."matrixRecallEnabled"
                    WHEN 'TELEGRAM'::"RepresentativeChannelKind"
                      THEN policy."telegramRecallEnabled"
                    ELSE FALSE
                  END
                )
                OR (
                  memory_record."scope" = 'REPRESENTATIVE'::"MemoryScope"
                  AND policy."representativeExperienceEnabled"
                )
              )
               THEN 'EXPECTED_ACTIVE'::"MemoryReconciliationTargetKind"
             WHEN projection."status" = 'SUPERSEDED'::"MemoryProjectionStatus"
               OR projection."deleteRequestedAt" IS NOT NULL
               OR memory_record."status" IN (
                 'SUPERSEDED'::"GovernedMemoryStatus",
                 'DELETE_PENDING'::"GovernedMemoryStatus",
                 'DELETED'::"GovernedMemoryStatus"
               )
               OR (
                 memory_record."currentVersionId" IS NOT NULL
                 AND memory_record."currentVersionId" <> projection."memoryVersionId"
               )
               OR version."purgedAt" IS NOT NULL
               THEN 'KNOWN_STALE'::"MemoryReconciliationTargetKind"
             ELSE 'RETAINED_INACTIVE'::"MemoryReconciliationTargetKind"
           END,
           'PENDING'::"MemoryReconciliationTargetStatus",
           projection."status",
           projection."updatedAt",
           projection."attemptCount",
           projection."remoteUri",
           projection."contentHash",
           0,
           date_trunc('milliseconds', CURRENT_TIMESTAMP),
           CURRENT_TIMESTAMP,
           CURRENT_TIMESTAMP
      FROM "MemoryReconciliationRun" run
      JOIN "MemoryProjectionItem" projection
        ON projection."representativeId" = run."representativeId"
       AND projection."provider" = run."provider"
       AND projection."lane" = 'RECALL'::"MemoryProjectionLane"
      JOIN "GovernedMemoryVersion" version
        ON version."id" = projection."memoryVersionId"
       AND version."memoryId" = projection."memoryId"
       AND version."representativeId" = projection."representativeId"
      JOIN "GovernedMemory" memory_record
        ON memory_record."id" = projection."memoryId"
       AND memory_record."representativeId" = projection."representativeId"
      JOIN "RepresentativeMemoryPolicy" policy
        ON policy."representativeId" = projection."representativeId"
     WHERE run."id" = ${run.runId}
       AND run."status" = 'RUNNING'::"MemoryReconciliationStatus"
       AND run."leaseToken" = ${run.leaseToken}
       AND run."attemptCount" = ${run.runAttemptCount}
       AND run."attemptCount" = 1
       AND (
         projection."status" IN (
           'ACTIVE'::"MemoryProjectionStatus",
           'SUPERSEDED'::"MemoryProjectionStatus"
         )
         OR (
           projection."status" = 'PROJECTING'::"MemoryProjectionStatus"
           AND projection."leaseToken" IS NOT NULL
           AND projection."leaseExpiresAt" > CURRENT_TIMESTAMP
         )
       )
    ON CONFLICT ("reconciliationRunId", "projectionItemId") DO NOTHING
  `);
}

async function persistTargetObservation(
  tx: TransactionClient,
  input: {
    claim: MemoryReconciliationClaim;
    maximumTargetAttempts: number;
    retryBaseMilliseconds: number;
    retryMaximumMilliseconds: number;
  },
  observation: MemoryReconciliationTargetObservation,
) {
  if (observation.kind === "retryable_error") {
    const exhausted = observation.target.targetAttemptCount
      >= input.maximumTargetAttempts;
    const delay = retryDelayMilliseconds(
      observation.target.targetAttemptCount,
      input.retryBaseMilliseconds,
      input.retryMaximumMilliseconds,
    );
    await transitionTarget(tx, input.claim, observation.target, {
      status: exhausted ? "FAILED" : "RETRYING",
      errorCode: exhausted
        ? "reconciliation_attempts_exhausted"
        : observation.errorCode,
      availableInMilliseconds: exhausted ? 0 : delay,
      checked: false,
    });
    return;
  }
  if (observation.kind === "permanent_error") {
    await transitionTarget(tx, input.claim, observation.target, {
      status: "FAILED",
      errorCode: observation.errorCode,
      availableInMilliseconds: 0,
      checked: false,
    });
    return;
  }
  if (observation.kind === "live_in_flight") {
    await transitionTarget(tx, input.claim, observation.target, {
      status: "SKIPPED",
      errorCode: "reconciliation_live_projection_skipped",
      availableInMilliseconds: 0,
      checked: true,
    });
    return;
  }
  if (observation.kind === "retained_inactive") {
    await transitionTarget(tx, input.claim, observation.target, {
      status: "SKIPPED",
      errorCode: "reconciliation_retained_inactive_skipped",
      availableInMilliseconds: 0,
      checked: true,
    });
    return;
  }

  if (observation.kind === "matched") {
    const matched = await markMatchedIfCurrent(
      tx,
      input.claim,
      observation.target,
      observation.observedContentHash,
    );
    if (!matched) {
      await markMovingTargetSkipped(tx, input.claim, observation.target);
    }
    return;
  }

  if (observation.kind === "known_stale") {
    await createReconciliationIssue(tx, input.claim, observation.target, {
      issueKind: "STALE_ACTIVE_POINTER",
      reasonCode: "reconciliation_stale_active_pointer",
    });
    const fenced = await fenceKnownStaleProjection(
      tx,
      input.claim,
      observation.target,
    );
    if (!fenced) {
      await ignoreReconciliationIssue(
        tx,
        input.claim,
        observation.target,
        "reconciliation_stale_active_pointer",
      );
      await markMovingTargetSkipped(tx, input.claim, observation.target);
      return;
    }
    await markIssueTarget(tx, input.claim, observation.target, {
      remoteExists: null,
      observedContentHash: null,
    });
    return;
  }

  const observedContentHash = observation.kind === "hash_mismatch"
    ? observation.observedContentHash
    : null;
  const reasonCode = observation.kind === "missing"
    ? "reconciliation_missing_remote"
    : "reconciliation_hash_mismatch";
  await createReconciliationIssue(tx, input.claim, observation.target, {
    issueKind: observation.kind === "missing"
      ? "MISSING_REMOTE"
      : "HASH_MISMATCH",
    reasonCode,
    observedContentHash,
  });
  const fenced = await fenceExpectedProjectionForRetry(
    tx,
    input.claim,
    observation.target,
    observation.kind,
  );
  if (!fenced) {
    await ignoreReconciliationIssue(
      tx,
      input.claim,
      observation.target,
      reasonCode,
    );
    await markMovingTargetSkipped(tx, input.claim, observation.target);
    return;
  }
  await markIssueTarget(tx, input.claim, observation.target, {
    remoteExists: observation.kind === "hash_mismatch",
    observedContentHash,
  });
}

async function markMatchedIfCurrent(
  tx: TransactionClient,
  claim: MemoryReconciliationClaim,
  target: MemoryReconciliationTargetClaim,
  observedContentHash: string,
) {
  const rows = await tx.$queryRaw<Array<{ projectionItemId: string }>>(Prisma.sql`
    UPDATE "MemoryReconciliationTarget" target
       SET "status" = 'MATCHED'::"MemoryReconciliationTargetStatus",
           "remoteExists" = TRUE,
           "observedContentHash" = ${observedContentHash},
           "checkedAt" = CURRENT_TIMESTAMP,
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "lastErrorCode" = NULL,
           "updatedAt" = CURRENT_TIMESTAMP
      FROM "MemoryProjectionItem" projection,
           "GovernedMemoryVersion" version,
           "GovernedMemory" memory_record,
           "RepresentativeMemoryPolicy" policy
     WHERE target."reconciliationRunId" = ${claim.runId}
       AND target."projectionItemId" = ${target.projectionItemId}
       AND target."status" = 'CHECKING'::"MemoryReconciliationTargetStatus"
       AND target."leaseToken" = ${claim.leaseToken}
       AND target."attemptCount" = ${target.targetAttemptCount}
       AND target."leaseExpiresAt" > CURRENT_TIMESTAMP
       AND projection."id" = target."projectionItemId"
       AND projection."representativeId" = target."representativeId"
       AND projection."lane" = 'RECALL'::"MemoryProjectionLane"
       AND projection."status" = 'ACTIVE'::"MemoryProjectionStatus"
       AND projection."updatedAt" = target."snapshotProjectionUpdatedAt"
       AND projection."attemptCount" = target."snapshotAttemptCount"
       AND projection."remoteUri" = target."snapshotRemoteUri"
       AND projection."contentHash" = target."expectedContentHash"
       AND projection."deleteRequestedAt" IS NULL
       AND version."id" = projection."memoryVersionId"
       AND version."memoryId" = projection."memoryId"
       AND version."representativeId" = projection."representativeId"
       AND version."purgedAt" IS NULL
       AND version."contentHash" = projection."contentHash"
       AND memory_record."id" = projection."memoryId"
       AND memory_record."representativeId" = projection."representativeId"
       AND memory_record."status" = 'ACTIVE'::"GovernedMemoryStatus"
       AND memory_record."recallDisabledAt" IS NULL
       AND (
         memory_record."expiresAt" IS NULL
         OR memory_record."expiresAt" > CURRENT_TIMESTAMP
       )
       AND memory_record."currentVersionId" = projection."memoryVersionId"
       AND policy."representativeId" = projection."representativeId"
       AND policy."provider" = projection."provider"
       AND policy."longTermMemoryEnabled"
       AND (
         (
           memory_record."scope" = 'CONTACT_CHANNEL'::"MemoryScope"
           AND policy."contactMemoryEnabled"
           AND CASE memory_record."sourceChannel"
             WHEN 'WEB'::"RepresentativeChannelKind"
               THEN policy."webRecallEnabled"
             WHEN 'MATRIX'::"RepresentativeChannelKind"
               THEN policy."matrixRecallEnabled"
             WHEN 'TELEGRAM'::"RepresentativeChannelKind"
               THEN policy."telegramRecallEnabled"
             ELSE FALSE
           END
         )
         OR (
           memory_record."scope" = 'REPRESENTATIVE'::"MemoryScope"
           AND policy."representativeExperienceEnabled"
         )
       )
    RETURNING target."projectionItemId"
  `);
  return rows.length === 1;
}

async function fenceExpectedProjectionForRetry(
  tx: TransactionClient,
  claim: MemoryReconciliationClaim,
  target: MemoryReconciliationTargetClaim,
  issue: "missing" | "hash_mismatch",
) {
  const errorCode = issue === "missing"
    ? "reconciliation_missing_remote"
    : "reconciliation_hash_mismatch";
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "MemoryProjectionItem" projection
       SET "status" = 'RETRYING'::"MemoryProjectionStatus",
           "availableAt" = CURRENT_TIMESTAMP,
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "lastErrorCode" = ${errorCode},
           "updatedAt" = CURRENT_TIMESTAMP
      FROM "MemoryReconciliationTarget" target,
           "GovernedMemoryVersion" version,
           "GovernedMemory" memory_record,
           "RepresentativeMemoryPolicy" policy
     WHERE target."reconciliationRunId" = ${claim.runId}
       AND target."projectionItemId" = ${target.projectionItemId}
       AND target."status" = 'CHECKING'::"MemoryReconciliationTargetStatus"
       AND target."leaseToken" = ${claim.leaseToken}
       AND target."attemptCount" = ${target.targetAttemptCount}
       AND target."leaseExpiresAt" > CURRENT_TIMESTAMP
       AND projection."id" = target."projectionItemId"
       AND projection."representativeId" = target."representativeId"
       AND projection."lane" = 'RECALL'::"MemoryProjectionLane"
       AND projection."status" = 'ACTIVE'::"MemoryProjectionStatus"
       AND projection."updatedAt" = target."snapshotProjectionUpdatedAt"
       AND projection."attemptCount" = target."snapshotAttemptCount"
       AND projection."remoteUri" = target."snapshotRemoteUri"
       AND projection."contentHash" = target."expectedContentHash"
       AND projection."deleteRequestedAt" IS NULL
       AND version."id" = projection."memoryVersionId"
       AND version."memoryId" = projection."memoryId"
       AND version."representativeId" = projection."representativeId"
       AND version."purgedAt" IS NULL
       AND version."contentHash" = projection."contentHash"
       AND memory_record."id" = projection."memoryId"
       AND memory_record."representativeId" = projection."representativeId"
       AND memory_record."status" = 'ACTIVE'::"GovernedMemoryStatus"
       AND memory_record."recallDisabledAt" IS NULL
       AND (
         memory_record."expiresAt" IS NULL
         OR memory_record."expiresAt" > CURRENT_TIMESTAMP
       )
       AND memory_record."currentVersionId" = projection."memoryVersionId"
       AND policy."representativeId" = projection."representativeId"
       AND policy."provider" = projection."provider"
       AND policy."longTermMemoryEnabled"
       AND (
         (
           memory_record."scope" = 'CONTACT_CHANNEL'::"MemoryScope"
           AND policy."contactMemoryEnabled"
           AND CASE memory_record."sourceChannel"
             WHEN 'WEB'::"RepresentativeChannelKind"
               THEN policy."webRecallEnabled"
             WHEN 'MATRIX'::"RepresentativeChannelKind"
               THEN policy."matrixRecallEnabled"
             WHEN 'TELEGRAM'::"RepresentativeChannelKind"
               THEN policy."telegramRecallEnabled"
             ELSE FALSE
           END
         )
         OR (
           memory_record."scope" = 'REPRESENTATIVE'::"MemoryScope"
           AND policy."representativeExperienceEnabled"
         )
       )
    RETURNING projection."id"
  `);
  return rows.length === 1;
}

async function fenceKnownStaleProjection(
  tx: TransactionClient,
  claim: MemoryReconciliationClaim,
  target: MemoryReconciliationTargetClaim,
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "MemoryProjectionItem" projection
       SET "status" = 'DELETE_PENDING'::"MemoryProjectionStatus",
           "deleteRequestedAt" = COALESCE(
             projection."deleteRequestedAt",
             CURRENT_TIMESTAMP
           ),
           "availableAt" = CURRENT_TIMESTAMP,
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "lastErrorCode" = NULL,
           "updatedAt" = CURRENT_TIMESTAMP
      FROM "MemoryReconciliationTarget" target,
           "GovernedMemoryVersion" version,
           "GovernedMemory" memory_record,
           "RepresentativeMemoryPolicy" policy
     WHERE target."reconciliationRunId" = ${claim.runId}
       AND target."projectionItemId" = ${target.projectionItemId}
       AND target."status" = 'CHECKING'::"MemoryReconciliationTargetStatus"
       AND target."leaseToken" = ${claim.leaseToken}
       AND target."attemptCount" = ${target.targetAttemptCount}
       AND target."leaseExpiresAt" > CURRENT_TIMESTAMP
       AND projection."id" = target."projectionItemId"
       AND projection."representativeId" = target."representativeId"
       AND projection."lane" = 'RECALL'::"MemoryProjectionLane"
       AND projection."status" = target."snapshotProjectionStatus"
       AND projection."status" IN (
         'ACTIVE'::"MemoryProjectionStatus",
         'SUPERSEDED'::"MemoryProjectionStatus"
       )
       AND projection."updatedAt" = target."snapshotProjectionUpdatedAt"
       AND projection."attemptCount" = target."snapshotAttemptCount"
       AND projection."remoteUri" = target."snapshotRemoteUri"
       AND projection."contentHash" = target."expectedContentHash"
       AND version."id" = projection."memoryVersionId"
       AND version."memoryId" = projection."memoryId"
       AND version."representativeId" = projection."representativeId"
       AND memory_record."id" = projection."memoryId"
       AND memory_record."representativeId" = projection."representativeId"
       AND policy."representativeId" = projection."representativeId"
       AND (
         projection."status" = 'SUPERSEDED'::"MemoryProjectionStatus"
         OR projection."deleteRequestedAt" IS NOT NULL
         OR memory_record."status" IN (
           'SUPERSEDED'::"GovernedMemoryStatus",
           'DELETE_PENDING'::"GovernedMemoryStatus",
           'DELETED'::"GovernedMemoryStatus"
         )
         OR (
           memory_record."currentVersionId" IS NOT NULL
           AND memory_record."currentVersionId" <> projection."memoryVersionId"
         )
         OR version."purgedAt" IS NOT NULL
       )
    RETURNING projection."id"
  `);
  return rows.length === 1;
}

async function createReconciliationIssue(
  tx: TransactionClient,
  claim: MemoryReconciliationClaim,
  target: MemoryReconciliationTargetClaim,
  issue: {
    issueKind: "MISSING_REMOTE" | "HASH_MISMATCH" | "STALE_ACTIVE_POINTER";
    reasonCode: string;
    observedContentHash?: string | null;
  },
) {
  const itemKey = `known_projection:${target.projectionItemId}`;
  await tx.$queryRaw(Prisma.sql`
    INSERT INTO "MemoryReconciliationItem" (
      "id",
      "reconciliationRunId",
      "representativeId",
      "projectionItemId",
      "itemKey",
      "issueKind",
      "status",
      "expectedContentHash",
      "observedContentHash",
      "remoteObjectIdHash",
      "reasonCode",
      "attemptCount",
      "availableAt",
      "createdAt",
      "updatedAt"
    ) VALUES (
      ${randomUUID()},
      ${claim.runId},
      ${target.representativeId},
      ${target.projectionItemId},
      ${itemKey},
      ${reconciliationIssueKindSql(issue.issueKind)},
      'OPEN'::"MemoryReconciliationItemStatus",
      ${target.expectedContentHash},
      ${issue.observedContentHash ?? null},
      ${sha256Text(target.remoteUri)},
      ${issue.reasonCode},
      0,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("reconciliationRunId", "itemKey") DO NOTHING
  `);
}

async function ignoreReconciliationIssue(
  tx: TransactionClient,
  claim: MemoryReconciliationClaim,
  target: MemoryReconciliationTargetClaim,
  reasonCode: string,
) {
  await tx.$queryRaw(Prisma.sql`
    UPDATE "MemoryReconciliationItem"
       SET "status" = 'IGNORED'::"MemoryReconciliationItemStatus",
           "resolvedAt" = CURRENT_TIMESTAMP,
           "lastErrorCode" = 'reconciliation_moving_target',
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "reconciliationRunId" = ${claim.runId}
       AND "projectionItemId" = ${target.projectionItemId}
       AND "itemKey" = ${`known_projection:${target.projectionItemId}`}
       AND "reasonCode" = ${reasonCode}
       AND "status" IN (
         'OPEN'::"MemoryReconciliationItemStatus",
         'RETRYING'::"MemoryReconciliationItemStatus"
       )
  `);
}

async function markIssueTarget(
  tx: TransactionClient,
  claim: MemoryReconciliationClaim,
  target: MemoryReconciliationTargetClaim,
  result: {
    remoteExists: boolean | null;
    observedContentHash: string | null;
  },
) {
  await transitionTarget(tx, claim, target, {
    status: "ISSUE",
    errorCode: null,
    availableInMilliseconds: 0,
    checked: true,
    remoteExists: result.remoteExists,
    observedContentHash: result.observedContentHash,
  });
}

async function markMovingTargetSkipped(
  tx: TransactionClient,
  claim: MemoryReconciliationClaim,
  target: MemoryReconciliationTargetClaim,
) {
  await transitionTarget(tx, claim, target, {
    status: "SKIPPED",
    errorCode: "reconciliation_moving_target",
    availableInMilliseconds: 0,
    checked: true,
  });
}

async function transitionTarget(
  tx: TransactionClient,
  claim: MemoryReconciliationClaim,
  target: MemoryReconciliationTargetClaim,
  transition: {
    status: "RETRYING" | "MATCHED" | "ISSUE" | "SKIPPED" | "FAILED";
    errorCode: string | null;
    availableInMilliseconds: number;
    checked: boolean;
    remoteExists?: boolean | null;
    observedContentHash?: string | null;
  },
) {
  await tx.$queryRaw(Prisma.sql`
    UPDATE "MemoryReconciliationTarget"
       SET "status" = ${reconciliationTargetStatusSql(transition.status)},
           "availableAt" = CURRENT_TIMESTAMP
             + (${transition.availableInMilliseconds} * INTERVAL '1 millisecond'),
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "lastErrorCode" = ${transition.errorCode},
           "remoteExists" = ${transition.remoteExists ?? null},
           "observedContentHash" = ${transition.observedContentHash ?? null},
           "checkedAt" = ${transition.checked
             ? Prisma.sql`CURRENT_TIMESTAMP`
             : Prisma.sql`NULL`},
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "reconciliationRunId" = ${claim.runId}
       AND "projectionItemId" = ${target.projectionItemId}
       AND "status" = 'CHECKING'::"MemoryReconciliationTargetStatus"
       AND "leaseToken" = ${claim.leaseToken}
       AND "attemptCount" = ${target.targetAttemptCount}
       AND "leaseExpiresAt" > CURRENT_TIMESTAMP
  `);
}

async function finishOrRequeueRun(
  tx: TransactionClient,
  claim: MemoryReconciliationClaim,
): Promise<MemoryReconciliationPageCommit> {
  const summaries = await tx.$queryRaw<TargetSummaryRow[]>(Prisma.sql`
    SELECT COUNT(*)::INTEGER AS "total",
           COUNT(*) FILTER (
             WHERE target."status" IN (
               'MATCHED'::"MemoryReconciliationTargetStatus",
               'ISSUE'::"MemoryReconciliationTargetStatus"
             )
           )::INTEGER AS "checked",
           COUNT(*) FILTER (
             WHERE target."status" = 'MATCHED'::"MemoryReconciliationTargetStatus"
           )::INTEGER AS "matched",
           COUNT(*) FILTER (
             WHERE target."status" = 'ISSUE'::"MemoryReconciliationTargetStatus"
           )::INTEGER AS "issues",
           COUNT(*) FILTER (
             WHERE target."status" = 'SKIPPED'::"MemoryReconciliationTargetStatus"
           )::INTEGER AS "skipped",
           COUNT(*) FILTER (
             WHERE target."status" = 'RETRYING'::"MemoryReconciliationTargetStatus"
           )::INTEGER AS "retrying",
           COUNT(*) FILTER (
             WHERE target."status" = 'FAILED'::"MemoryReconciliationTargetStatus"
           )::INTEGER AS "failed",
           COUNT(*) FILTER (
             WHERE target."status" IN (
               'PENDING'::"MemoryReconciliationTargetStatus",
               'CHECKING'::"MemoryReconciliationTargetStatus",
               'RETRYING'::"MemoryReconciliationTargetStatus"
             )
           )::INTEGER AS "remaining",
           MIN(
             CASE
               WHEN target."status" = 'CHECKING'::"MemoryReconciliationTargetStatus"
                 THEN target."leaseExpiresAt"
               ELSE target."availableAt"
             END
           ) FILTER (
             WHERE target."status" IN (
               'PENDING'::"MemoryReconciliationTargetStatus",
               'CHECKING'::"MemoryReconciliationTargetStatus",
               'RETRYING'::"MemoryReconciliationTargetStatus"
             )
           ) AS "nextAvailableAt",
           MAX(target."projectionItemId") FILTER (
             WHERE target."status" IN (
               'MATCHED'::"MemoryReconciliationTargetStatus",
               'ISSUE'::"MemoryReconciliationTargetStatus",
               'SKIPPED'::"MemoryReconciliationTargetStatus",
               'FAILED'::"MemoryReconciliationTargetStatus"
             )
           ) AS "cursor"
      FROM "MemoryReconciliationTarget" target
     WHERE target."reconciliationRunId" = ${claim.runId}
  `);
  const summary = summaries[0] ?? emptyTargetSummary();
  const coverage = coverageFromSummary(summary);
  const requeue = summary.remaining > 0;
  const availableAt = summary.nextAvailableAt ?? new Date();
  const updated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "MemoryReconciliationRun" run
       SET "status" = ${requeue
         ? Prisma.sql`'QUEUED'::"MemoryReconciliationStatus"`
         : Prisma.sql`'PARTIAL'::"MemoryReconciliationStatus"`},
           "expectedCount" = ${summary.total},
           "observedCount" = (
             SELECT COUNT(*)::INTEGER
               FROM "MemoryReconciliationTarget" target
              WHERE target."reconciliationRunId" = run."id"
                AND target."remoteExists" IS TRUE
           ),
           "matchedCount" = ${summary.matched},
           "issueCount" = ${summary.issues},
           "resolvedCount" = (
             SELECT COUNT(*)::INTEGER
               FROM "MemoryReconciliationItem" item
              WHERE item."reconciliationRunId" = run."id"
                AND item."status" = 'RESOLVED'::"MemoryReconciliationItemStatus"
           ),
           "cursor" = ${summary.cursor},
           "availableAt" = ${availableAt},
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "finishedAt" = ${requeue ? Prisma.sql`NULL` : Prisma.sql`CURRENT_TIMESTAMP`},
           "errorCode" = ${requeue
             ? Prisma.sql`'reconciliation_work_remaining'`
             : Prisma.sql`${OPENVIKING_INVENTORY_NO_SNAPSHOT_CURSOR}`},
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE run."id" = ${claim.runId}
       AND run."status" = 'RUNNING'::"MemoryReconciliationStatus"
       AND run."leaseToken" = ${claim.leaseToken}
       AND run."attemptCount" = ${claim.runAttemptCount}
       AND run."leaseExpiresAt" > CURRENT_TIMESTAMP
    RETURNING run."id"
  `);
  if (updated.length !== 1) {
    return { state: "lease_lost", coverage };
  }
  return {
    state: requeue ? "requeued" : "partial",
    coverage,
    ...(requeue ? { availableAt } : {}),
  };
}

type TargetSummaryRow = MemoryReconciliationCoverage & {
  remaining: number;
  nextAvailableAt: Date | null;
  cursor: string | null;
};

function coverageFromSummary(summary: TargetSummaryRow): MemoryReconciliationCoverage {
  return {
    checked: summary.checked,
    total: summary.total,
    matched: summary.matched,
    issues: summary.issues,
    skipped: summary.skipped,
    retrying: summary.retrying,
    failed: summary.failed,
  };
}

function emptyTargetSummary(): TargetSummaryRow {
  return {
    ...emptyCoverage(),
    remaining: 0,
    nextAvailableAt: null,
    cursor: null,
  };
}

function emptyCoverage(): MemoryReconciliationCoverage {
  return {
    checked: 0,
    total: 0,
    matched: 0,
    issues: 0,
    skipped: 0,
    retrying: 0,
    failed: 0,
  };
}

async function inspectClaimedTarget(
  target: MemoryReconciliationTargetClaim,
  provider: MemoryReconciliationProvider | null,
  providerUnavailableCode = "reconciliation_provider_unavailable",
): Promise<MemoryReconciliationTargetObservation> {
  try {
    validateTargetCoordinates(target);
  } catch (error) {
    const failure = classifyReconciliationFailure(error);
    return {
      kind: failure.retryable ? "retryable_error" : "permanent_error",
      target,
      errorCode: failure.code,
    };
  }
  if (target.kind === "KNOWN_STALE") {
    return { kind: "known_stale", target };
  }
  if (target.kind === "RETAINED_INACTIVE") {
    return { kind: "retained_inactive", target };
  }
  if (target.kind === "LIVE_IN_FLIGHT") {
    return { kind: "live_in_flight", target };
  }
  if (!provider) {
    return {
      kind: "permanent_error",
      target,
      errorCode: providerUnavailableCode,
    };
  }

  try {
    const result = await provider.inspectExact({
      namespaceKey: target.namespaceKey,
      uri: target.remoteUri,
    });
    if (result.uri !== target.remoteUri) {
      throw new MemoryReconciliationProviderError(
        "reconciliation_exact_target_mismatch",
        false,
      );
    }
    const classified = classifyMemoryReconciliationExactProbe(
      target.expectedContentHash,
      result,
    );
    return { ...classified, target };
  } catch (error) {
    const failure = classifyReconciliationFailure(error);
    return {
      kind: failure.retryable ? "retryable_error" : "permanent_error",
      target,
      errorCode: failure.code,
    };
  }
}

function validateTargetCoordinates(target: MemoryReconciliationTargetClaim) {
  const coordinates = assertExactGovernedMemoryVersionUri({
    namespaceKey: target.namespaceKey,
    uri: target.remoteUri,
  });
  if (
    coordinates.memoryId !== target.memoryId
    || coordinates.memoryVersionId !== target.memoryVersionId
    || coordinates.userId !== buildGovernedMemoryManagedUserId(target.namespaceKey)
  ) {
    throw new MemoryReconciliationProviderError(
      "reconciliation_canonical_target_invalid",
      false,
    );
  }
  requireSha256(target.expectedContentHash, "expected content hash");
}

class MemoryReconciliationProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "MemoryReconciliationProviderError";
  }
}

function classifyReconciliationFailure(error: unknown) {
  if (error instanceof MemoryReconciliationProviderError) {
    return { code: error.code, retryable: error.retryable };
  }
  const status = providerErrorStatus(error);
  const retryable = status === 408
    || status === 425
    || status === 429
    || (status !== null && status >= 500)
    || (status === null && isNetworkLikeError(error));
  return {
    code: retryable
      ? "reconciliation_provider_retryable"
      : "reconciliation_provider_failed",
    retryable,
  };
}

function resolveReconciliationProvider(
  providerName: string,
  options: MemoryReconciliationExecutionOptions,
) {
  const resolved = options.resolveProvider?.(providerName);
  if (resolved?.name === providerName) return resolved;
  if (options.provider?.name === providerName) return options.provider;
  if (providerName !== "openviking") return null;
  const env = resolveOpenVikingEnv();
  if (!env.enabled) {
    throw new MemoryReconciliationProviderError(
      "reconciliation_provider_disabled",
      false,
    );
  }
  return new OpenVikingMemoryReconciliationProvider(new OpenVikingClient({
    baseUrl: env.baseUrl,
    ...(env.apiKey ? { apiKey: env.apiKey } : {}),
    timeoutMs: env.timeoutMs,
    accountId: "delegate",
    userId: "delegate-memory-bootstrap",
  }));
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

function isNetworkLikeError(error: unknown) {
  return error instanceof TypeError
    || (
      error instanceof Error
      && (error.name === "AbortError" || error.name === "TimeoutError")
    );
}

function requireSha256(value: string | undefined, label: string) {
  if (!value || !sha256Pattern.test(value)) {
    throw new MemoryReconciliationProviderError(
      `reconciliation_invalid_${label.replaceAll(" ", "_")}`,
      false,
    );
  }
  return value;
}

function retryDelayMilliseconds(
  attemptCount: number,
  base: number,
  maximum: number,
) {
  return Math.min(
    maximum,
    base * (2 ** Math.max(0, Math.trunc(attemptCount) - 1)),
  );
}

function reconciliationIssueKindSql(
  value: "MISSING_REMOTE" | "HASH_MISMATCH" | "STALE_ACTIVE_POINTER",
) {
  switch (value) {
    case "MISSING_REMOTE":
      return Prisma.sql`'MISSING_REMOTE'::"MemoryReconciliationIssueKind"`;
    case "HASH_MISMATCH":
      return Prisma.sql`'HASH_MISMATCH'::"MemoryReconciliationIssueKind"`;
    case "STALE_ACTIVE_POINTER":
      return Prisma.sql`'STALE_ACTIVE_POINTER'::"MemoryReconciliationIssueKind"`;
  }
}

function reconciliationTargetStatusSql(
  value: "RETRYING" | "MATCHED" | "ISSUE" | "SKIPPED" | "FAILED",
) {
  switch (value) {
    case "RETRYING":
      return Prisma.sql`'RETRYING'::"MemoryReconciliationTargetStatus"`;
    case "MATCHED":
      return Prisma.sql`'MATCHED'::"MemoryReconciliationTargetStatus"`;
    case "ISSUE":
      return Prisma.sql`'ISSUE'::"MemoryReconciliationTargetStatus"`;
    case "SKIPPED":
      return Prisma.sql`'SKIPPED'::"MemoryReconciliationTargetStatus"`;
    case "FAILED":
      return Prisma.sql`'FAILED'::"MemoryReconciliationTargetStatus"`;
  }
}

function boundedPageSize(value: number | undefined) {
  return Math.min(maximumPageSize, positiveInteger(value, defaultPageSize));
}

function positiveInteger(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function sha256Text(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function noWorkResult(): MemoryReconciliationTickResult {
  return {
    processed: false,
    inventoryStatus: "partial",
    exactProbe: "supported",
    remoteEnumeration: "unsupported",
    errorCode: OPENVIKING_INVENTORY_NO_SNAPSHOT_CURSOR,
  };
}

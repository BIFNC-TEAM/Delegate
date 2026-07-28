import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "./prisma";

export const DEFAULT_PAYMENT_PROVIDER_OPERATION_LEASE_MS = 15_000;
export const DEFAULT_PAYMENT_PROVIDER_OPERATION_COOLDOWN_MS = 10_000;

const MAX_PAYMENT_PROVIDER_OPERATION_DURATION_MS = 60 * 60 * 1_000;
const SCOPE_KEY_PATTERN = /^[0-9a-f]{64}$/;

export type PaymentProviderOperationGateClient = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

export class PaymentProviderOperationLeaseLostError extends Error {
  readonly code = "PAYMENT_PROVIDER_OPERATION_LEASE_LOST";

  constructor() {
    super("Payment provider operation lease is no longer owned by this caller.");
    this.name = "PaymentProviderOperationLeaseLostError";
  }
}

export type ClaimPaymentProviderOperationInput = {
  scopeKey: string;
  leaseDurationMs?: number;
  cooldownMs?: number;
  leaseToken?: string;
};

export type PaymentProviderOperationClaim =
  | {
      claimed: true;
      scopeKey: string;
      leaseToken: string;
      leaseExpiresAt: Date;
      nextAllowedAt: Date;
    }
  | {
      claimed: false;
      scopeKey: string;
      retryAfterSeconds: number;
    };

type ClaimedGateRow = {
  scopeKey: string;
  leaseToken: string;
  leaseExpiresAt: Date;
  nextAllowedAt: Date;
};

type DeferredGateRow = {
  retryAfterSeconds: number;
};

/**
 * Produces a non-reversible, fixed-size database key. Callers should pass only
 * server-resolved identity and operation components; raw identifiers are never
 * stored in the operation gate table.
 */
export function createPaymentProviderOperationScopeKey(
  parts: readonly string[],
): string {
  if (parts.length === 0) {
    throw new Error("Payment provider operation scope requires at least one part.");
  }
  const normalizedParts = parts.map((part, index) => {
    const normalized = part.trim();
    if (!normalized) {
      throw new Error(
        `Payment provider operation scope part ${index + 1} is required.`,
      );
    }
    return normalized;
  });
  return createHash("sha256")
    .update(
      JSON.stringify([
        "delegate-payment-provider-operation-gate",
        1,
        ...normalizedParts,
      ]),
      "utf8",
    )
    .digest("hex");
}

/**
 * Claims one provider-call lease and starts its cooldown in a single atomic
 * PostgreSQL statement. A crashed caller becomes reclaimable after the lease,
 * while a successful caller may release early without shortening cooldown.
 */
export async function claimPaymentProviderOperation(
  input: ClaimPaymentProviderOperationInput,
  client: PaymentProviderOperationGateClient = prisma,
): Promise<PaymentProviderOperationClaim> {
  const scopeKey = requiredScopeKey(input.scopeKey);
  const leaseDurationMs = normalizedDuration(
    input.leaseDurationMs,
    DEFAULT_PAYMENT_PROVIDER_OPERATION_LEASE_MS,
    "leaseDurationMs",
  );
  const cooldownMs = normalizedDuration(
    input.cooldownMs,
    DEFAULT_PAYMENT_PROVIDER_OPERATION_COOLDOWN_MS,
    "cooldownMs",
  );
  const leaseToken = input.leaseToken?.trim() || randomUUID();

  const claimedRows = await client.$queryRaw<ClaimedGateRow[]>(Prisma.sql`
    INSERT INTO "PaymentProviderOperationGate" AS gate (
      "scopeKey",
      "leaseToken",
      "leaseExpiresAt",
      "nextAllowedAt",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${scopeKey},
      ${leaseToken},
      NOW() + (${leaseDurationMs} * INTERVAL '1 millisecond'),
      NOW() + (${cooldownMs} * INTERVAL '1 millisecond'),
      NOW(),
      NOW()
    )
    ON CONFLICT ("scopeKey") DO UPDATE
    SET
      "leaseToken" = EXCLUDED."leaseToken",
      "leaseExpiresAt" = EXCLUDED."leaseExpiresAt",
      "nextAllowedAt" = EXCLUDED."nextAllowedAt",
      "updatedAt" = NOW()
    WHERE
      (
        gate."leaseExpiresAt" IS NULL
        OR gate."leaseExpiresAt" <= NOW()
      )
      AND gate."nextAllowedAt" <= NOW()
    RETURNING
      gate."scopeKey",
      gate."leaseToken",
      gate."leaseExpiresAt",
      gate."nextAllowedAt"
  `);
  const claimed = claimedRows[0];
  if (claimed) {
    return {
      claimed: true,
      scopeKey: claimed.scopeKey,
      leaseToken: claimed.leaseToken,
      leaseExpiresAt: claimed.leaseExpiresAt,
      nextAllowedAt: claimed.nextAllowedAt,
    };
  }

  const deferredRows = await client.$queryRaw<DeferredGateRow[]>(Prisma.sql`
    SELECT
      GREATEST(
        1,
        CEIL(
          EXTRACT(
            EPOCH FROM (
              GREATEST(
                COALESCE("leaseExpiresAt", "nextAllowedAt"),
                "nextAllowedAt"
              ) - NOW()
            )
          )
        )::integer
      ) AS "retryAfterSeconds"
    FROM "PaymentProviderOperationGate"
    WHERE "scopeKey" = ${scopeKey}
    LIMIT 1
  `);
  const retryAfterSeconds =
    deferredRows[0]?.retryAfterSeconds
    ?? Math.max(
      1,
      Math.ceil(Math.max(leaseDurationMs, cooldownMs) / 1_000),
    );
  return {
    claimed: false,
    scopeKey,
    retryAfterSeconds,
  };
}

/**
 * Verifies the exact unexpired fencing token and locks its gate row for the
 * caller's surrounding database transaction. Call this with a transaction
 * client immediately before creating the local provider intent. A contender
 * cannot reclaim the lease until that transaction commits or rolls back.
 */
export async function lockPaymentProviderOperationLease(
  input: {
    scopeKey: string;
    leaseToken: string;
  },
  client: PaymentProviderOperationGateClient = prisma,
): Promise<boolean> {
  const scopeKey = requiredScopeKey(input.scopeKey);
  const leaseToken = requiredLeaseToken(input.leaseToken);
  const rows = await client.$queryRaw<Array<{ scopeKey: string }>>(Prisma.sql`
    SELECT "scopeKey"
    FROM "PaymentProviderOperationGate"
    WHERE "scopeKey" = ${scopeKey}
      AND "leaseToken" = ${leaseToken}
      AND "leaseExpiresAt" > NOW()
    FOR UPDATE
  `);
  return rows.length === 1;
}

/**
 * Extends only the exact currently-owned, still-unexpired lease using database
 * time. Returning null is a fencing failure: an old caller must not perform
 * the remote provider effect after another request can own the gate.
 */
export async function renewPaymentProviderOperationLease(
  input: {
    scopeKey: string;
    leaseToken: string;
    leaseDurationMs?: number;
  },
  client: PaymentProviderOperationGateClient = prisma,
): Promise<Date | null> {
  const scopeKey = requiredScopeKey(input.scopeKey);
  const leaseToken = requiredLeaseToken(input.leaseToken);
  const leaseDurationMs = normalizedDuration(
    input.leaseDurationMs,
    DEFAULT_PAYMENT_PROVIDER_OPERATION_LEASE_MS,
    "leaseDurationMs",
  );
  const rows = await client.$queryRaw<Array<{
    leaseExpiresAt: Date;
  }>>(Prisma.sql`
    UPDATE "PaymentProviderOperationGate"
    SET
      "leaseExpiresAt" =
        NOW() + (${leaseDurationMs} * INTERVAL '1 millisecond'),
      "updatedAt" = NOW()
    WHERE "scopeKey" = ${scopeKey}
      AND "leaseToken" = ${leaseToken}
      AND "leaseExpiresAt" > NOW()
    RETURNING "leaseExpiresAt"
  `);
  return rows[0]?.leaseExpiresAt ?? null;
}

/**
 * Releases only the lease owned by this caller. A stale caller cannot clear a
 * lease acquired later with a different fencing token.
 */
export async function releasePaymentProviderOperation(
  input: {
    scopeKey: string;
    leaseToken: string;
  },
  client: PaymentProviderOperationGateClient = prisma,
): Promise<boolean> {
  const scopeKey = requiredScopeKey(input.scopeKey);
  const leaseToken = requiredLeaseToken(input.leaseToken);
  const released = await client.$executeRaw(Prisma.sql`
    UPDATE "PaymentProviderOperationGate"
    SET
      "leaseToken" = NULL,
      "leaseExpiresAt" = NULL,
      "updatedAt" = NOW()
    WHERE "scopeKey" = ${scopeKey}
      AND "leaseToken" = ${leaseToken}
  `);
  return released === 1;
}

function requiredLeaseToken(leaseTokenInput: string): string {
  const leaseToken = leaseTokenInput.trim();
  if (!leaseToken) {
    throw new Error("Payment provider operation leaseToken is required.");
  }
  return leaseToken;
}

function requiredScopeKey(scopeKeyInput: string): string {
  const scopeKey = scopeKeyInput.trim();
  if (!SCOPE_KEY_PATTERN.test(scopeKey)) {
    throw new Error(
      "Payment provider operation scopeKey must be a SHA-256 hex digest.",
    );
  }
  return scopeKey;
}

function normalizedDuration(
  input: number | undefined,
  fallback: number,
  field: string,
): number {
  const duration = input ?? fallback;
  if (
    !Number.isInteger(duration)
    || duration <= 0
    || duration > MAX_PAYMENT_PROVIDER_OPERATION_DURATION_MS
  ) {
    throw new Error(
      `Payment provider operation ${field} must be an integer between 1 and ${MAX_PAYMENT_PROVIDER_OPERATION_DURATION_MS}.`,
    );
  }
  return duration;
}

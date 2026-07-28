import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "./prisma";

const minimumLeaseDurationMs = 1_000;
const maximumLeaseDurationMs = 15 * 60_000;
const safeLeaseCoordinate = /^[A-Za-z0-9._:-]{1,191}$/;

export type TelegramBotRuntimeLease = {
  telegramBotConnectionId: string;
  holderId: string;
  leaseToken: string;
  expiresAt: Date;
  acquiredAt: Date;
  renewedAt: Date;
};

type TelegramBotRuntimeLeaseClient = Pick<
  typeof prisma,
  "$queryRaw" | "$executeRaw"
>;

type TelegramBotRuntimeLeaseDependencies = {
  client?: TelegramBotRuntimeLeaseClient;
  tokenFactory?: () => string;
};

type TelegramBotRuntimeLeaseRow = TelegramBotRuntimeLease;

/**
 * Atomically acquires an expired or absent polling lease. An unexpired lease
 * is never overwritten, including by another process that happens to reuse
 * the same holder id.
 */
export async function acquireTelegramBotRuntimeLease(
  input: {
    telegramBotConnectionId: string;
    holderId: string;
    leaseDurationMs: number;
  },
  dependencies: TelegramBotRuntimeLeaseDependencies = {},
): Promise<TelegramBotRuntimeLease | null> {
  const telegramBotConnectionId = normalizeCoordinate(
    input.telegramBotConnectionId,
    "telegramBotConnectionId",
  );
  const holderId = normalizeCoordinate(input.holderId, "holderId");
  const leaseDurationMs = normalizeLeaseDuration(input.leaseDurationMs);
  const leaseToken = normalizeCoordinate(
    (dependencies.tokenFactory ?? randomUUID)(),
    "leaseToken",
  );
  const client = dependencies.client ?? prisma;
  const rows = await client.$queryRaw<TelegramBotRuntimeLeaseRow[]>(
    Prisma.sql`
      INSERT INTO "TelegramBotRuntimeLease" (
        "telegramBotConnectionId",
        "holderId",
        "leaseToken",
        "expiresAt",
        "acquiredAt",
        "renewedAt",
        "updatedAt"
      )
      SELECT
        connection."id",
        ${holderId},
        ${leaseToken},
        CURRENT_TIMESTAMP
          + (${leaseDurationMs} * INTERVAL '1 millisecond'),
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM "TelegramBotConnection" AS connection
      WHERE connection."id" = ${telegramBotConnectionId}
        AND connection."status" = 'ACTIVE'::"TelegramBotConnectionStatus"
        AND connection."revokedAt" IS NULL
        AND EXISTS (
          SELECT 1
          FROM "RepresentativeChannelBinding" AS binding
          WHERE binding."telegramBotConnectionId" = connection."id"
            AND binding."kind" = 'TELEGRAM'::"RepresentativeChannelKind"
            AND binding."desiredState" = 'ACTIVE'::"ChannelDesiredState"
        )
      ON CONFLICT ("telegramBotConnectionId") DO UPDATE
      SET
        "holderId" = EXCLUDED."holderId",
        "leaseToken" = EXCLUDED."leaseToken",
        "expiresAt" = EXCLUDED."expiresAt",
        "acquiredAt" = EXCLUDED."acquiredAt",
        "renewedAt" = EXCLUDED."renewedAt",
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "TelegramBotRuntimeLease"."expiresAt" <= CURRENT_TIMESTAMP
      RETURNING
        "telegramBotConnectionId",
        "holderId",
        "leaseToken",
        "expiresAt",
        "acquiredAt",
        "renewedAt"
    `,
  );
  return rows[0] ?? null;
}

/**
 * Renews only the exact, still-unexpired lease token. A late heartbeat cannot
 * resurrect an expired lease after another holder became eligible.
 */
export async function renewTelegramBotRuntimeLease(
  input: TelegramBotRuntimeLease & {
    leaseDurationMs: number;
  },
  dependencies: Pick<TelegramBotRuntimeLeaseDependencies, "client"> = {},
): Promise<TelegramBotRuntimeLease | null> {
  const telegramBotConnectionId = normalizeCoordinate(
    input.telegramBotConnectionId,
    "telegramBotConnectionId",
  );
  const holderId = normalizeCoordinate(input.holderId, "holderId");
  const leaseToken = normalizeCoordinate(input.leaseToken, "leaseToken");
  const leaseDurationMs = normalizeLeaseDuration(input.leaseDurationMs);
  const client = dependencies.client ?? prisma;
  const rows = await client.$queryRaw<TelegramBotRuntimeLeaseRow[]>(
    Prisma.sql`
      UPDATE "TelegramBotRuntimeLease" AS lease
      SET
        "expiresAt" = CURRENT_TIMESTAMP
          + (${leaseDurationMs} * INTERVAL '1 millisecond'),
        "renewedAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE lease."telegramBotConnectionId" = ${telegramBotConnectionId}
        AND lease."holderId" = ${holderId}
        AND lease."leaseToken" = ${leaseToken}
        AND lease."expiresAt" > CURRENT_TIMESTAMP
        AND EXISTS (
          SELECT 1
          FROM "TelegramBotConnection" AS connection
          WHERE connection."id" = lease."telegramBotConnectionId"
            AND connection."status"
              = 'ACTIVE'::"TelegramBotConnectionStatus"
            AND connection."revokedAt" IS NULL
            AND EXISTS (
              SELECT 1
              FROM "RepresentativeChannelBinding" AS binding
              WHERE binding."telegramBotConnectionId" = connection."id"
                AND binding."kind"
                  = 'TELEGRAM'::"RepresentativeChannelKind"
                AND binding."desiredState"
                  = 'ACTIVE'::"ChannelDesiredState"
            )
        )
      RETURNING
        lease."telegramBotConnectionId",
        lease."holderId",
        lease."leaseToken",
        lease."expiresAt",
        lease."acquiredAt",
        lease."renewedAt"
    `,
  );
  return rows[0] ?? null;
}

/**
 * Best-effort release is fenced by both holder and token, so an old process
 * cannot delete a successor's lease.
 */
export async function releaseTelegramBotRuntimeLease(
  input: Pick<
    TelegramBotRuntimeLease,
    "telegramBotConnectionId" | "holderId" | "leaseToken"
  >,
  dependencies: Pick<TelegramBotRuntimeLeaseDependencies, "client"> = {},
): Promise<boolean> {
  const telegramBotConnectionId = normalizeCoordinate(
    input.telegramBotConnectionId,
    "telegramBotConnectionId",
  );
  const holderId = normalizeCoordinate(input.holderId, "holderId");
  const leaseToken = normalizeCoordinate(input.leaseToken, "leaseToken");
  const client = dependencies.client ?? prisma;
  const deleted = await client.$executeRaw(
    Prisma.sql`
      DELETE FROM "TelegramBotRuntimeLease"
      WHERE "telegramBotConnectionId" = ${telegramBotConnectionId}
        AND "holderId" = ${holderId}
        AND "leaseToken" = ${leaseToken}
    `,
  );
  return deleted === 1;
}

function normalizeCoordinate(value: string, label: string): string {
  const normalized = value.trim();
  if (!safeLeaseCoordinate.test(normalized)) {
    throw new Error(`Telegram runtime lease ${label} is invalid.`);
  }
  return normalized;
}

function normalizeLeaseDuration(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < minimumLeaseDurationMs
    || value > maximumLeaseDurationMs
  ) {
    throw new Error(
      `Telegram runtime lease duration must be an integer between ${minimumLeaseDurationMs} and ${maximumLeaseDurationMs} milliseconds.`,
    );
  }
  return value;
}

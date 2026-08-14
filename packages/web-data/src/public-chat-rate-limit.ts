import { createHmac } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "./prisma";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
let nextExpiredBucketPruneAt = 0;

export type PublicChatRateLimitScope =
  | "network_minute"
  | "audience_minute"
  | "representative_day";

export class PublicChatRateLimitError extends Error {
  constructor(
    readonly scope: PublicChatRateLimitScope,
    readonly retryAfterSeconds: number,
  ) {
    super("Public chat request rate limit exceeded.");
    this.name = "PublicChatRateLimitError";
  }
}

type RateLimitRow = {
  count: number;
  windowEndsAt: Date;
};

export async function enforcePublicChatNetworkAdmission(input: {
  clientAddress: string;
  now?: Date;
}) {
  await claimPublicChatRateLimit({
    scope: "network_minute",
    // This limit is deliberately global per trusted client address. Binding it
    // to an unvalidated slug would let an attacker bypass admission by rotating
    // arbitrary path segments before representative lookup.
    identity: input.clientAddress,
    limit: readPositiveInteger(
      process.env.PUBLIC_CHAT_NETWORK_REQUESTS_PER_MINUTE,
      30,
      10_000,
    ),
    windowMs: MINUTE_MS,
    ...(input.now ? { now: input.now } : {}),
  });
}

export async function enforcePublicChatPrincipalAdmission(input: {
  representativeId: string;
  audienceIdentityId: string;
  now?: Date;
}) {
  await claimPublicChatRateLimit({
    scope: "audience_minute",
    identity: `${input.representativeId}:${input.audienceIdentityId}`,
    limit: readPositiveInteger(
      process.env.PUBLIC_CHAT_AUDIENCE_REQUESTS_PER_MINUTE,
      12,
      10_000,
    ),
    windowMs: MINUTE_MS,
    ...(input.now ? { now: input.now } : {}),
  });
  await claimPublicChatRateLimit({
    scope: "representative_day",
    identity: input.representativeId,
    limit: readPositiveInteger(
      process.env.PUBLIC_CHAT_REPRESENTATIVE_REQUESTS_PER_DAY,
      5_000,
      10_000_000,
    ),
    windowMs: DAY_MS,
    ...(input.now ? { now: input.now } : {}),
  });
}

async function claimPublicChatRateLimit(input: {
  scope: PublicChatRateLimitScope;
  identity: string;
  limit: number;
  windowMs: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const windowStartsAt = alignWindowStart(now, input.windowMs);
  const windowEndsAt = new Date(windowStartsAt.getTime() + input.windowMs);
  const scopeKey = createScopeKey(input.scope, input.identity, windowStartsAt);
  const rows = await prisma.$queryRaw<RateLimitRow[]>(Prisma.sql`
    INSERT INTO "PublicChatRateLimitBucket" (
      "scopeKey", "count", "windowStartsAt", "windowEndsAt", "createdAt", "updatedAt"
    ) VALUES (
      ${scopeKey}, 1, ${windowStartsAt}, ${windowEndsAt}, ${now}, ${now}
    )
    ON CONFLICT ("scopeKey") DO UPDATE
      SET "count" = "PublicChatRateLimitBucket"."count" + 1,
          "updatedAt" = ${now}
    RETURNING "count", "windowEndsAt"
  `);
  const row = rows[0];
  await maybePruneExpiredBuckets(now);
  if (!row || row.count > input.limit) {
    throw new PublicChatRateLimitError(
      input.scope,
      Math.max(1, Math.ceil((windowEndsAt.getTime() - now.getTime()) / 1_000)),
    );
  }
}

async function maybePruneExpiredBuckets(now: Date) {
  if (now.getTime() < nextExpiredBucketPruneAt) return;
  nextExpiredBucketPruneAt = now.getTime() + MINUTE_MS;
  const retentionBoundary = new Date(now.getTime() - DAY_MS);
  try {
    await prisma.$executeRaw(Prisma.sql`
      WITH expired AS (
        SELECT "scopeKey"
        FROM "PublicChatRateLimitBucket"
        WHERE "windowEndsAt" < ${retentionBoundary}
        ORDER BY "windowEndsAt" ASC
        LIMIT 1000
      )
      DELETE FROM "PublicChatRateLimitBucket" AS bucket
      USING expired
      WHERE bucket."scopeKey" = expired."scopeKey"
    `);
  } catch (error) {
    // Admission remains authoritative even if maintenance is temporarily
    // unavailable. Back off to avoid turning a database incident into log spam.
    nextExpiredBucketPruneAt = now.getTime() + DAY_MS;
    console.warn("Failed to prune expired public-chat rate-limit buckets.", error);
  }
}

function alignWindowStart(now: Date, windowMs: number) {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

function createScopeKey(
  scope: PublicChatRateLimitScope,
  identity: string,
  windowStartsAt: Date,
) {
  const secret =
    process.env.PUBLIC_CHAT_RATE_LIMIT_SECRET?.trim()
    || process.env.REP_PUBLIC_CHAT_SESSION_SECRET?.trim();
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error(
      "PUBLIC_CHAT_RATE_LIMIT_SECRET or REP_PUBLIC_CHAT_SESSION_SECRET is required in production.",
    );
  }
  return createHmac("sha256", secret || "delegate-public-chat-rate-limit-dev-secret")
    .update(`${scope}:${windowStartsAt.toISOString()}:${identity}`)
    .digest("hex");
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
}

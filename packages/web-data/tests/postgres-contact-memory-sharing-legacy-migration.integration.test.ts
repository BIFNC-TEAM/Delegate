import { readFileSync } from "node:fs";

import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260807129000_contact_memory_sharing_replay_and_legacy_fence/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const migrationBody = migration
  .replace(/^\s*BEGIN;\s*/u, "")
  .replace(/\s*COMMIT;\s*$/u, "");
const migrationStatements = splitSqlStatements(migrationBody);

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("Contact Memory sharing legacy migration PostgreSQL guard", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("atomically aborts when legacy and valid challenge authority coexist", async () => {
    await prisma.$transaction(async (tx) => {
      await createTemporary1280SharingTables(tx);
      await insertMixedAuthorityFixture(tx);
      await tx.$executeRawUnsafe("SAVEPOINT before_legacy_migration");

      let migrationError: unknown;
      try {
        await executeMigrationStatements(tx);
      } catch (error) {
        migrationError = error;
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT before_legacy_migration");
      }

      expect(String(migrationError)).toMatch(
        /legacy and challenge-backed Contact Memory sharing authority coexist/u,
      );
      const consents = await tx.$queryRawUnsafe<Array<{
        id: string;
        status: string;
        revokedAt: Date | null;
      }>>(`
        SELECT "id", "status"::text AS "status", "revokedAt"
          FROM "ContactMemorySharingConsent"
         ORDER BY "id" ASC
      `);
      expect(consents).toEqual([
        { id: "authority-consent", status: "GRANTED", revokedAt: null },
        { id: "legacy-consent", status: "GRANTED", revokedAt: null },
      ]);
      await expectMemoryAndProjectionState(tx, {
        memoryId: "mixed-memory",
        memoryStatus: "ACTIVE",
        projectionStatus: "ACTIVE",
        recallDisabled: false,
        proofCount: 0n,
      });
    });
  });

  it("cleans a legacy-only scope without touching challenge authority elsewhere", async () => {
    await prisma.$transaction(async (tx) => {
      await createTemporary1280SharingTables(tx);
      await insertSeparatedAuthorityFixture(tx);

      await executeMigrationStatements(tx);

      const consents = await tx.$queryRawUnsafe<Array<{
        id: string;
        status: string;
        revoked: boolean;
      }>>(`
        SELECT
          "id",
          "status"::text AS "status",
          "revokedAt" IS NOT NULL AS "revoked"
        FROM "ContactMemorySharingConsent"
        ORDER BY "id" ASC
      `);
      expect(consents).toEqual([
        { id: "authority-consent", status: "GRANTED", revoked: false },
        { id: "legacy-consent", status: "REVOKED", revoked: true },
      ]);
      await expectMemoryAndProjectionState(tx, {
        memoryId: "authority-memory",
        memoryStatus: "ACTIVE",
        projectionStatus: "ACTIVE",
        recallDisabled: false,
        proofCount: 0n,
      });
      await expectMemoryAndProjectionState(tx, {
        memoryId: "legacy-memory",
        memoryStatus: "DELETE_PENDING",
        projectionStatus: "DELETE_PENDING",
        recallDisabled: true,
        proofCount: 1n,
      });
    });
  });
});

async function executeMigrationStatements(tx: Prisma.TransactionClient) {
  for (const statement of migrationStatements) {
    await tx.$executeRawUnsafe(statement);
  }
}

async function createTemporary1280SharingTables(tx: Prisma.TransactionClient) {
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "ContactMemorySharingChallenge" (
      "id" TEXT PRIMARY KEY,
      "representativeId" TEXT NOT NULL,
      "audienceIdentityId" TEXT NOT NULL,
      "sourceChannel" "RepresentativeChannelKind" NOT NULL,
      "policyRevision" INTEGER NOT NULL,
      "disclosureContractVersion" TEXT NOT NULL,
      "sourceEvidenceHash" TEXT NOT NULL,
      "disclosureEventHash" TEXT NOT NULL,
      "expiresAt" TIMESTAMP(3) NOT NULL,
      "consumedAt" TIMESTAMP(3),
      "revokedAt" TIMESTAMP(3)
    ) ON COMMIT DROP
  `);
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "ContactMemorySharingConsent" (
      "id" TEXT PRIMARY KEY,
      "representativeId" TEXT NOT NULL,
      "audienceIdentityId" TEXT NOT NULL,
      "status" "ContactMemorySharingConsentStatus" NOT NULL,
      "policyRevision" INTEGER NOT NULL,
      "sourceChannel" "RepresentativeChannelKind" NOT NULL,
      "disclosureContractVersion" TEXT NOT NULL,
      "challengeId" TEXT,
      "sourceEvidenceHash" TEXT,
      "confirmationEventHash" TEXT,
      "revokedAt" TIMESTAMP(3),
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "ContactMemorySharingConsent_fixture_status_check" CHECK (
        ("status" = 'GRANTED' AND "revokedAt" IS NULL)
        OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
      )
    ) ON COMMIT DROP
  `);
  await tx.$executeRawUnsafe(`
    CREATE UNIQUE INDEX "ContactMemorySharingConsent_fixture_current_grant_key"
      ON "ContactMemorySharingConsent"(
        "representativeId", "audienceIdentityId", "policyRevision"
      )
      WHERE "status" = 'GRANTED' AND "revokedAt" IS NULL
  `);
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "GovernedMemory" (
      "id" TEXT PRIMARY KEY,
      "representativeId" TEXT NOT NULL,
      "audienceIdentityId" TEXT,
      "scope" "MemoryScope" NOT NULL,
      "status" "GovernedMemoryStatus" NOT NULL,
      "currentVersionId" TEXT,
      "recallDisabledAt" TIMESTAMP(3),
      "suppressedAt" TIMESTAMP(3),
      "deleteRequestedAt" TIMESTAMP(3),
      "updatedAt" TIMESTAMP(3) NOT NULL
    ) ON COMMIT DROP
  `);
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "GovernedMemoryVersion" (
      "id" TEXT PRIMARY KEY,
      "memoryId" TEXT NOT NULL,
      "contentHash" TEXT NOT NULL
    ) ON COMMIT DROP
  `);
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "MemoryProjectionItem" (
      "id" TEXT PRIMARY KEY,
      "memoryId" TEXT NOT NULL,
      "status" "MemoryProjectionStatus" NOT NULL,
      "deleteRequestedAt" TIMESTAMP(3),
      "availableAt" TIMESTAMP(3) NOT NULL,
      "leaseToken" TEXT,
      "leaseExpiresAt" TIMESTAMP(3),
      "lastErrorCode" TEXT,
      "updatedAt" TIMESTAMP(3) NOT NULL
    ) ON COMMIT DROP
  `);
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "MemoryDeletionProof" (
      "id" TEXT PRIMARY KEY,
      "representativeId" TEXT NOT NULL,
      "memoryId" TEXT NOT NULL,
      "requestId" TEXT NOT NULL,
      "requestedByActorId" TEXT NOT NULL,
      "reasonCode" TEXT NOT NULL,
      "contentHash" TEXT NOT NULL,
      "recallBlockedAt" TIMESTAMP(3) NOT NULL,
      "cleanupStatus" "MemoryCleanupStatus" NOT NULL,
      "availableAt" TIMESTAMP(3) NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL,
      "updatedAt" TIMESTAMP(3) NOT NULL
    ) ON COMMIT DROP
  `);
}

async function insertMixedAuthorityFixture(tx: Prisma.TransactionClient) {
  await insertChallengeAuthority(tx, {
    representativeId: "representative-mixed",
    audienceIdentityId: "identity-mixed",
  });
  await insertLegacyConsent(tx, {
    representativeId: "representative-mixed",
    audienceIdentityId: "identity-mixed",
  });
  await insertMemory(tx, {
    memoryId: "mixed-memory",
    representativeId: "representative-mixed",
    audienceIdentityId: "identity-mixed",
  });
  await addGrandfatheredChallengeShapeConstraint(tx);
}

async function insertSeparatedAuthorityFixture(tx: Prisma.TransactionClient) {
  await insertChallengeAuthority(tx, {
    representativeId: "representative-authority",
    audienceIdentityId: "identity-authority",
  });
  await insertLegacyConsent(tx, {
    representativeId: "representative-legacy",
    audienceIdentityId: "identity-legacy",
  });
  await insertMemory(tx, {
    memoryId: "authority-memory",
    representativeId: "representative-authority",
    audienceIdentityId: "identity-authority",
  });
  await insertMemory(tx, {
    memoryId: "legacy-memory",
    representativeId: "representative-legacy",
    audienceIdentityId: "identity-legacy",
  });
  await addGrandfatheredChallengeShapeConstraint(tx);
}

async function insertChallengeAuthority(
  tx: Prisma.TransactionClient,
  input: { representativeId: string; audienceIdentityId: string },
) {
  await tx.$executeRawUnsafe(`
    INSERT INTO "ContactMemorySharingChallenge" (
      "id", "representativeId", "audienceIdentityId", "sourceChannel",
      "policyRevision", "disclosureContractVersion", "sourceEvidenceHash",
      "disclosureEventHash", "expiresAt", "consumedAt", "revokedAt"
    ) VALUES (
      'authority-challenge', '${input.representativeId}',
      '${input.audienceIdentityId}', 'WEB'::"RepresentativeChannelKind", 2,
      'cross-channel-contact-memory-v1', '${"a".repeat(64)}',
      '${"b".repeat(64)}', '2026-08-07T02:00:00.000Z',
      '2026-08-07T01:30:00.000Z', NULL
    )
  `);
  await tx.$executeRawUnsafe(`
    INSERT INTO "ContactMemorySharingConsent" (
      "id", "representativeId", "audienceIdentityId", "status",
      "policyRevision", "sourceChannel", "disclosureContractVersion",
      "challengeId", "sourceEvidenceHash", "confirmationEventHash",
      "revokedAt", "updatedAt"
    ) VALUES (
      'authority-consent', '${input.representativeId}',
      '${input.audienceIdentityId}',
      'GRANTED'::"ContactMemorySharingConsentStatus", 2,
      'WEB'::"RepresentativeChannelKind",
      'cross-channel-contact-memory-v1', 'authority-challenge',
      '${"a".repeat(64)}', '${"c".repeat(64)}', NULL, CURRENT_TIMESTAMP
    )
  `);
}

async function insertLegacyConsent(
  tx: Prisma.TransactionClient,
  input: { representativeId: string; audienceIdentityId: string },
) {
  await tx.$executeRawUnsafe(`
    INSERT INTO "ContactMemorySharingConsent" (
      "id", "representativeId", "audienceIdentityId", "status",
      "policyRevision", "sourceChannel", "disclosureContractVersion",
      "challengeId", "sourceEvidenceHash", "confirmationEventHash",
      "revokedAt", "updatedAt"
    ) VALUES (
      'legacy-consent', '${input.representativeId}',
      '${input.audienceIdentityId}',
      'GRANTED'::"ContactMemorySharingConsentStatus", 1,
      'WEB'::"RepresentativeChannelKind", 'legacy-unversioned',
      NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP
    )
  `);
}

async function insertMemory(
  tx: Prisma.TransactionClient,
  input: {
    memoryId: string;
    representativeId: string;
    audienceIdentityId: string;
  },
) {
  await tx.$executeRawUnsafe(`
    INSERT INTO "GovernedMemory" (
      "id", "representativeId", "audienceIdentityId", "scope", "status",
      "currentVersionId", "recallDisabledAt", "updatedAt"
    ) VALUES (
      '${input.memoryId}', '${input.representativeId}',
      '${input.audienceIdentityId}', 'CONTACT_SHARED'::"MemoryScope",
      'ACTIVE'::"GovernedMemoryStatus", '${input.memoryId}-version', NULL,
      CURRENT_TIMESTAMP
    )
  `);
  await tx.$executeRawUnsafe(`
    INSERT INTO "GovernedMemoryVersion" ("id", "memoryId", "contentHash")
    VALUES (
      '${input.memoryId}-version', '${input.memoryId}', '${"d".repeat(64)}'
    )
  `);
  await tx.$executeRawUnsafe(`
    INSERT INTO "MemoryProjectionItem" (
      "id", "memoryId", "status", "availableAt", "updatedAt"
    ) VALUES (
      '${input.memoryId}-projection', '${input.memoryId}',
      'ACTIVE'::"MemoryProjectionStatus", CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
  `);
}

async function addGrandfatheredChallengeShapeConstraint(
  tx: Prisma.TransactionClient,
) {
  await tx.$executeRawUnsafe(`
    ALTER TABLE "ContactMemorySharingConsent"
      ADD CONSTRAINT "ContactMemorySharingConsent_challenge_shape_check" CHECK (
        "status" <> 'GRANTED'
        OR (
          "challengeId" IS NOT NULL
          AND "sourceEvidenceHash" ~ '^[0-9a-f]{64}$'
          AND "confirmationEventHash" ~ '^[0-9a-f]{64}$'
        )
      ) NOT VALID
  `);
}

async function expectMemoryAndProjectionState(
  tx: Prisma.TransactionClient,
  input: {
    memoryId: string;
    memoryStatus: string;
    projectionStatus: string;
    recallDisabled: boolean;
    proofCount: bigint;
  },
) {
  const [memory] = await tx.$queryRawUnsafe<Array<{
    status: string;
    recallDisabled: boolean;
  }>>(`
    SELECT
      "status"::text AS "status",
      "recallDisabledAt" IS NOT NULL AS "recallDisabled"
    FROM "GovernedMemory"
    WHERE "id" = '${input.memoryId}'
  `);
  const [projection] = await tx.$queryRawUnsafe<Array<{ status: string }>>(`
    SELECT "status"::text AS "status"
    FROM "MemoryProjectionItem"
    WHERE "memoryId" = '${input.memoryId}'
  `);
  const [proof] = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(`
    SELECT COUNT(*) AS "count"
    FROM "MemoryDeletionProof"
    WHERE "memoryId" = '${input.memoryId}'
  `);
  expect(memory).toEqual({
    status: input.memoryStatus,
    recallDisabled: input.recallDisabled,
  });
  expect(projection).toEqual({ status: input.projectionStatus });
  expect(proof?.count).toBe(input.proofCount);
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for sharing migration PostgreSQL E2E.");
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host)
    || !["test", "e2e", "delegate"].some((marker) => database.includes(marker))
  ) {
    throw new Error(
      `Refusing sharing migration PostgreSQL E2E against ${host}/${database}.`,
    );
  }
}

function splitSqlStatements(source: string) {
  const statements: string[] = [];
  let current = "";
  let dollarQuote: string | null = null;
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    current += character;

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (dollarQuote) {
      if (source.startsWith(dollarQuote, index)) {
        current += dollarQuote.slice(1);
        index += dollarQuote.length - 1;
        dollarQuote = null;
      }
      continue;
    }
    if (singleQuoted) {
      if (character === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (character === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (doubleQuoted) {
      if (character === '"' && next === '"') {
        current += next;
        index += 1;
      } else if (character === '"') {
        doubleQuoted = false;
      }
      continue;
    }
    if (character === "-" && next === "-") {
      current += next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === "/" && next === "*") {
      current += next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (character === "'") {
      singleQuoted = true;
      continue;
    }
    if (character === '"') {
      doubleQuoted = true;
      continue;
    }
    if (character === "$") {
      const tag = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u)?.[0];
      if (tag) {
        current += tag.slice(1);
        index += tag.length - 1;
        dollarQuote = tag;
        continue;
      }
    }
    if (character === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

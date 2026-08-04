import { readFileSync } from "node:fs";

import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260804130000_memory_use_truth_ledger/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const historicalCitationScrub = requiredMatch(
  migration,
  /-- HISTORICAL_CITATION_SCRUB_BEGIN\n([\s\S]*?)\n-- HISTORICAL_CITATION_SCRUB_END/u,
  "historical citation scrub",
);
const legacyMemoryPolicyNormalization = requiredMatch(
  migration,
  /-- LEGACY_MEMORY_POLICY_NORMALIZATION_BEGIN\n([\s\S]*?)\n-- LEGACY_MEMORY_POLICY_NORMALIZATION_END/u,
  "legacy memory policy normalization",
);
const legacyMemoryUseGenerationMapping = requiredMatch(
  migration,
  /-- LEGACY_MEMORY_USE_GENERATION_MAPPING_BEGIN\n([\s\S]*?)\n-- LEGACY_MEMORY_USE_GENERATION_MAPPING_END/u,
  "legacy memory use generation mapping",
);
const legacyMemoryUseRejectionNormalization = requiredMatch(
  migration,
  /-- LEGACY_MEMORY_USE_REJECTION_NORMALIZATION_BEGIN\n([\s\S]*?)\n-- LEGACY_MEMORY_USE_REJECTION_NORMALIZATION_END/u,
  "legacy memory use rejection normalization",
);
const legacyMemoryUseTerminalReason = requiredMatch(
  migration,
  /-- LEGACY_MEMORY_USE_TERMINAL_REASON_BEGIN\n([\s\S]*?)\n-- LEGACY_MEMORY_USE_TERMINAL_REASON_END/u,
  "legacy memory use terminal reason remediation",
);

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("Memory use truth migration PostgreSQL scrub", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("scrubs all pre-nonce citations without losing injected facts", async () => {
    await prisma.$transaction(async (tx) => {
      await createTemporaryLegacyCitationTables(tx);
      await tx.$executeRawUnsafe(`
        INSERT INTO "MessageCitation" ("id", "uri", "score") VALUES
          ('citation_unmapped', 'viking://resources/private-unmapped', 0.91),
          ('citation_old_display', 'viking://resources/old-display', 0.87)
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "MemoryUseItem" (
          "id", "displayedCitationId", "injectedAt", "displayedAt"
        ) VALUES
          ('item_not_injected', NULL, NULL, NULL),
          (
            'item_injected', 'citation_old_display',
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
      `);

      await executeSqlStatements(tx, historicalCitationScrub);

      const items = await tx.$queryRawUnsafe<Array<{
        id: string;
        displayedCitationId: string | null;
        injected: boolean;
        displayed: boolean;
      }>>(`
        SELECT "id",
               "displayedCitationId",
               "injectedAt" IS NOT NULL AS injected,
               "displayedAt" IS NOT NULL AS displayed
          FROM "MemoryUseItem"
         ORDER BY "id"
      `);
      const citationCounts = await tx.$queryRawUnsafe<Array<{
        count: bigint;
      }>>('SELECT COUNT(*) AS count FROM "MessageCitation"');
      const diagnosticColumns = await tx.$queryRawUnsafe<Array<{ column_name: string }>>(`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema LIKE 'pg_temp_%'
           AND table_name = 'MessageCitation'
           AND column_name IN ('uri', 'score')
      `);

      expect(items).toEqual([
        {
          id: "item_injected",
          displayedCitationId: null,
          injected: true,
          displayed: false,
        },
        {
          id: "item_not_injected",
          displayedCitationId: null,
          injected: false,
          displayed: false,
        },
      ]);
      expect(citationCounts[0]!.count).toBe(0n);
      expect(diagnosticColumns).toEqual([]);
    });
  });

  it("normalizes legacy policy combinations before adding the stricter constraint", async () => {
    await prisma.$transaction(async (tx) => {
      await createTemporaryLegacyPolicyTable(tx);
      await tx.$executeRawUnsafe(`
        INSERT INTO "RepresentativeMemoryPolicy" (
          "id", "contactMemoryEnabled", "representativeExperienceEnabled",
          "autoExtract", "webExtractEnabled", "matrixRecallEnabled",
          "matrixExtractEnabled", "telegramRecallEnabled",
          "telegramExtractEnabled", "revision", "updatedAt"
        ) VALUES
          ('auto_without_contact', false, true, true, true, false, false, false, false, 4, CURRENT_TIMESTAMP),
          ('web_without_auto', true, false, false, true, false, false, false, false, 5, CURRENT_TIMESTAMP),
          ('unsupported_channels', true, false, true, true, true, true, true, true, 6, CURRENT_TIMESTAMP),
          ('already_valid', true, false, true, true, false, false, false, false, 7, CURRENT_TIMESTAMP),
          ('experience_only', false, true, false, false, false, false, false, false, 8, CURRENT_TIMESTAMP)
      `);

      await tx.$executeRawUnsafe(legacyMemoryPolicyNormalization);

      const policies = await tx.$queryRawUnsafe<Array<{
        id: string;
        autoExtract: boolean;
        webExtractEnabled: boolean;
        matrixRecallEnabled: boolean;
        matrixExtractEnabled: boolean;
        telegramRecallEnabled: boolean;
        telegramExtractEnabled: boolean;
        revision: number;
      }>>(`
        SELECT "id", "autoExtract", "webExtractEnabled",
               "matrixRecallEnabled", "matrixExtractEnabled",
               "telegramRecallEnabled", "telegramExtractEnabled", "revision"
          FROM "RepresentativeMemoryPolicy"
         ORDER BY "id"
      `);

      expect(policies).toEqual([
        {
          id: "already_valid",
          autoExtract: true,
          webExtractEnabled: true,
          matrixRecallEnabled: false,
          matrixExtractEnabled: false,
          telegramRecallEnabled: false,
          telegramExtractEnabled: false,
          revision: 7,
        },
        {
          id: "auto_without_contact",
          autoExtract: false,
          webExtractEnabled: false,
          matrixRecallEnabled: false,
          matrixExtractEnabled: false,
          telegramRecallEnabled: false,
          telegramExtractEnabled: false,
          revision: 5,
        },
        {
          id: "experience_only",
          autoExtract: false,
          webExtractEnabled: false,
          matrixRecallEnabled: false,
          matrixExtractEnabled: false,
          telegramRecallEnabled: false,
          telegramExtractEnabled: false,
          revision: 8,
        },
        {
          id: "unsupported_channels",
          autoExtract: true,
          webExtractEnabled: true,
          matrixRecallEnabled: false,
          matrixExtractEnabled: false,
          telegramRecallEnabled: false,
          telegramExtractEnabled: false,
          revision: 7,
        },
        {
          id: "web_without_auto",
          autoExtract: false,
          webExtractEnabled: false,
          matrixRecallEnabled: false,
          matrixExtractEnabled: false,
          telegramRecallEnabled: false,
          telegramExtractEnabled: false,
          revision: 6,
        },
      ]);
    });
  });

  it("keeps only a bidirectionally unique legacy generation match and fails closed otherwise", async () => {
    await prisma.$transaction(async (tx) => {
      await createTemporaryLegacyMemoryUseTables(tx);
      await tx.$executeRawUnsafe(`
        INSERT INTO "GenerationRun" (
          "id", "conversationId", "inputMessageId", "representativeVersionId"
        ) VALUES
          ('generation_unique', 'conversation_unique', 'message_unique', 'version_unique'),
          ('generation_contended', 'conversation_contended', 'message_contended', 'version_contended'),
          ('generation_ambiguous_a', 'conversation_ambiguous', 'message_ambiguous', 'version_ambiguous'),
          ('generation_ambiguous_b', 'conversation_ambiguous', 'message_ambiguous', 'version_ambiguous'),
          ('generation_bound', 'conversation_bound', 'message_bound', 'version_bound')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "MemoryUseRun" (
          "id", "conversationId", "inputMessageId", "representativeVersionId",
          "generationRunId", "updatedAt"
        ) VALUES
          ('run_unique', 'conversation_unique', 'message_unique', 'version_unique', NULL, CURRENT_TIMESTAMP),
          ('run_contended_a', 'conversation_contended', 'message_contended', 'version_contended', NULL, CURRENT_TIMESTAMP),
          ('run_contended_b', 'conversation_contended', 'message_contended', 'version_contended', NULL, CURRENT_TIMESTAMP),
          ('run_ambiguous', 'conversation_ambiguous', 'message_ambiguous', 'version_ambiguous', NULL, CURRENT_TIMESTAMP),
          ('run_bound', 'conversation_bound', 'message_bound', 'version_bound', 'generation_bound', CURRENT_TIMESTAMP),
          ('run_competes_with_bound', 'conversation_bound', 'message_bound', 'version_bound', NULL, CURRENT_TIMESTAMP),
          ('run_unmappable', 'conversation_missing', 'message_missing', 'version_missing', NULL, CURRENT_TIMESTAMP)
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "MemoryUseItem" (
          "id", "useRunId", "sourceKind", "scopeCheckedAt", "scopePassedAt",
          "safetyCheckedAt", "safetyPassedAt", "rejectionReasonCode", "updatedAt"
        ) VALUES
          ('item_public', 'run_unique', 'PUBLIC_KNOWLEDGE'::"MemoryUseSourceKind", NULL, NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP),
          ('item_scope_rejected', 'run_unique', 'CONTACT_MEMORY'::"MemoryUseSourceKind", CURRENT_TIMESTAMP, NULL, NULL, NULL, 'raw scope failure details', CURRENT_TIMESTAMP),
          ('item_safety_rejected', 'run_unique', 'CONTACT_MEMORY'::"MemoryUseSourceKind", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, 'raw safety failure details', CURRENT_TIMESTAMP),
          ('item_contended', 'run_contended_a', 'CONTACT_MEMORY'::"MemoryUseSourceKind", NULL, NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP)
      `);

      await executeSqlStatements(tx, legacyMemoryUseGenerationMapping);
      await executeSqlStatements(tx, legacyMemoryUseRejectionNormalization);

      const runs = await tx.$queryRawUnsafe<Array<{
        id: string;
        generationRunId: string;
      }>>(`
        SELECT "id", "generationRunId"
          FROM "MemoryUseRun"
         ORDER BY "id"
      `);
      const items = await tx.$queryRawUnsafe<Array<{
        id: string;
        rejectionReasonCode: string | null;
      }>>(`
        SELECT "id", "rejectionReasonCode"
          FROM "MemoryUseItem"
         ORDER BY "id"
      `);

      expect(runs).toEqual([
        { id: "run_bound", generationRunId: "generation_bound" },
        { id: "run_unique", generationRunId: "generation_unique" },
      ]);
      expect(items).toEqual([
        { id: "item_safety_rejected", rejectionReasonCode: "legacy_safety_rejected" },
        { id: "item_scope_rejected", rejectionReasonCode: "legacy_scope_rejected" },
      ]);
    });
  });

  it("backfills stable reason codes for legacy terminal runs", async () => {
    await prisma.$transaction(async (tx) => {
      await createTemporaryLegacyTerminalRunTable(tx);
      await tx.$executeRawUnsafe(`
        INSERT INTO "MemoryUseRun" ("id", "status", "reasonCode", "updatedAt") VALUES
          ('run_started', 'STARTED'::"MemoryUseRunStatus", NULL, CURRENT_TIMESTAMP),
          ('run_completed', 'COMPLETED'::"MemoryUseRunStatus", NULL, CURRENT_TIMESTAMP),
          ('run_degraded', 'DEGRADED'::"MemoryUseRunStatus", NULL, CURRENT_TIMESTAMP),
          ('run_failed', 'FAILED'::"MemoryUseRunStatus", NULL, CURRENT_TIMESTAMP),
          ('run_canceled', 'CANCELED'::"MemoryUseRunStatus", NULL, CURRENT_TIMESTAMP)
      `);

      await tx.$executeRawUnsafe(legacyMemoryUseTerminalReason);

      const runs = await tx.$queryRawUnsafe<Array<{
        id: string;
        reasonCode: string | null;
      }>>(`
        SELECT "id", "reasonCode" FROM "MemoryUseRun" ORDER BY "id"
      `);
      expect(runs).toEqual([
        { id: "run_canceled", reasonCode: "legacy_canceled" },
        { id: "run_completed", reasonCode: null },
        { id: "run_degraded", reasonCode: "legacy_degraded" },
        { id: "run_failed", reasonCode: "legacy_failed" },
        { id: "run_started", reasonCode: null },
      ]);
    });
  });
});

async function createTemporaryLegacyPolicyTable(
  tx: Prisma.TransactionClient,
) {
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "RepresentativeMemoryPolicy" (
      "id" TEXT PRIMARY KEY,
      "contactMemoryEnabled" BOOLEAN NOT NULL,
      "representativeExperienceEnabled" BOOLEAN NOT NULL,
      "autoExtract" BOOLEAN NOT NULL,
      "webExtractEnabled" BOOLEAN NOT NULL,
      "matrixRecallEnabled" BOOLEAN NOT NULL,
      "matrixExtractEnabled" BOOLEAN NOT NULL,
      "telegramRecallEnabled" BOOLEAN NOT NULL,
      "telegramExtractEnabled" BOOLEAN NOT NULL,
      "revision" INTEGER NOT NULL,
      "updatedAt" TIMESTAMP(3) NOT NULL
    ) ON COMMIT DROP
  `);
}

async function createTemporaryLegacyMemoryUseTables(
  tx: Prisma.TransactionClient,
) {
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "GenerationRun" (
      "id" TEXT PRIMARY KEY,
      "conversationId" TEXT NOT NULL,
      "inputMessageId" TEXT NOT NULL,
      "representativeVersionId" TEXT NOT NULL
    ) ON COMMIT DROP
  `);
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "MemoryUseRun" (
      "id" TEXT PRIMARY KEY,
      "conversationId" TEXT NOT NULL,
      "inputMessageId" TEXT NOT NULL,
      "representativeVersionId" TEXT NOT NULL,
      "generationRunId" TEXT,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      UNIQUE ("generationRunId", "conversationId")
    ) ON COMMIT DROP
  `);
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "MemoryUseItem" (
      "id" TEXT PRIMARY KEY,
      "useRunId" TEXT NOT NULL,
      "sourceKind" "MemoryUseSourceKind" NOT NULL,
      "scopeCheckedAt" TIMESTAMP(3),
      "scopePassedAt" TIMESTAMP(3),
      "safetyCheckedAt" TIMESTAMP(3),
      "safetyPassedAt" TIMESTAMP(3),
      "rejectionReasonCode" TEXT,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      FOREIGN KEY ("useRunId") REFERENCES "MemoryUseRun"("id") ON DELETE CASCADE
    ) ON COMMIT DROP
  `);
}

async function createTemporaryLegacyTerminalRunTable(
  tx: Prisma.TransactionClient,
) {
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "MemoryUseRun" (
      "id" TEXT PRIMARY KEY,
      "status" "MemoryUseRunStatus" NOT NULL,
      "reasonCode" TEXT,
      "updatedAt" TIMESTAMP(3) NOT NULL
    ) ON COMMIT DROP
  `);
}

async function createTemporaryLegacyCitationTables(
  tx: Prisma.TransactionClient,
) {
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "MessageCitation" (
      "id" TEXT PRIMARY KEY,
      "uri" TEXT,
      "score" DOUBLE PRECISION
    ) ON COMMIT DROP
  `);
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "MemoryUseItem" (
      "id" TEXT PRIMARY KEY,
      "displayedCitationId" TEXT,
      "injectedAt" TIMESTAMP(3),
      "displayedAt" TIMESTAMP(3),
      CONSTRAINT "MemoryUseItem_citation_fkey"
        FOREIGN KEY ("displayedCitationId")
        REFERENCES "MessageCitation"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
    ) ON COMMIT DROP
  `);
}

async function executeSqlStatements(
  tx: Prisma.TransactionClient,
  sql: string,
) {
  for (const statement of sql
    .split(/;\s*(?:\n|$)/u)
    .map((value) => value.trim())
    .filter(Boolean)) {
    await tx.$executeRawUnsafe(statement);
  }
}

function requiredMatch(source: string, pattern: RegExp, label: string) {
  const value = source.match(pattern)?.[1]?.trim();
  if (!value) throw new Error(`Could not extract ${label} from migration.`);
  return value;
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for memory truth migration E2E.");
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host)
    || !["test", "e2e", "delegate"].some((marker) => database.includes(marker))
  ) {
    throw new Error(
      `Refusing memory truth migration E2E against ${host}/${database}.`,
    );
  }
}

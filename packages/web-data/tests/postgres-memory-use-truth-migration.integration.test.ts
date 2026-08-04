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

      for (const statement of historicalCitationScrub
        .split(/;\s*(?:\n|$)/u)
        .map((value) => value.trim())
        .filter(Boolean)) {
        await tx.$executeRawUnsafe(statement);
      }

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
});

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

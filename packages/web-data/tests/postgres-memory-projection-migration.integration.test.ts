import { readFileSync } from "node:fs";

import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260804110000_memory_projection_execution/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const legacyEvidencePreflight = requiredMatch(
  migration,
  /-- LEGACY_REMOTE_EVIDENCE_PREFLIGHT_BEGIN\n([\s\S]*?)\n-- LEGACY_REMOTE_EVIDENCE_PREFLIGHT_END/u,
  "legacy evidence preflight",
);
const canonicalBackfill = requiredMatch(
  migration,
  /(UPDATE "MemoryProjectionItem" projection\n\s+SET "remoteUri" = CASE[\s\S]*?AND projection\."deletedAt" IS NULL;)/u,
  "canonical URI backfill",
);

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("Memory projection legacy migration PostgreSQL guard", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("blocks canonical backfill when a legacy exact URI is remote evidence", async () => {
    await expect(prisma.$transaction(async (tx) => {
      await createTemporaryLegacyProjectionTables(tx);
      await tx.$executeRawUnsafe(`
        INSERT INTO "MemoryProjectionItem" (
          "id", "representativeId", "memoryId", "memoryVersionId",
          "status", "attemptCount", "remoteUri"
        ) VALUES (
          'legacy_projection', 'representative', 'memory', 'version',
          'QUEUED'::"MemoryProjectionStatus", 0,
          'viking://user/memories/delegate/legacy/contact/memory.md'
        )
      `);
      await tx.$executeRawUnsafe(legacyEvidencePreflight);
    })).rejects.toThrow(
      /legacy memory projection evidence requires explicit exact-URI cleanup/u,
    );
  });

  it("canonicalizes only pristine rows that prove no provider attempt started", async () => {
    await prisma.$transaction(async (tx) => {
      await createTemporaryLegacyProjectionTables(tx);
      await tx.$executeRawUnsafe(`
        INSERT INTO "RepresentativeMemoryPolicy" (
          "representativeId", "namespaceKey"
        ) VALUES ('representative', 'namespace_safe')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "GovernedMemory" (
          "id", "representativeId", "scope", "contactId", "sourceChannel"
        ) VALUES
          (
            'contact_memory', 'representative',
            'CONTACT_CHANNEL'::"MemoryScope", 'contact_safe',
            'WEB'::"RepresentativeChannelKind"
          ),
          (
            'experience_memory', 'representative',
            'REPRESENTATIVE'::"MemoryScope", NULL, NULL
          )
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "MemoryProjectionItem" (
          "id", "representativeId", "memoryId", "memoryVersionId",
          "status", "attemptCount", "deleteRequestedAt"
        ) VALUES
          (
            'contact_projection', 'representative', 'contact_memory',
            'contact_version', 'QUEUED'::"MemoryProjectionStatus", 0, NULL
          ),
          (
            'experience_projection', 'representative', 'experience_memory',
            'experience_version', 'DELETE_PENDING'::"MemoryProjectionStatus", 0,
            CURRENT_TIMESTAMP
          )
      `);

      await tx.$executeRawUnsafe(legacyEvidencePreflight);
      await tx.$executeRawUnsafe(canonicalBackfill);
      const rows = await tx.$queryRawUnsafe<Array<{ id: string; remoteUri: string }>>(`
        SELECT "id", "remoteUri"
          FROM "MemoryProjectionItem"
         ORDER BY "id" ASC
      `);

      expect(rows).toEqual([
        {
          id: "contact_projection",
          remoteUri:
            "viking://user/delegate-memory-namespace_safe/memories/delegate/namespace_safe/contacts/contact_safe/channels/web/memories/contact_memory/versions/contact_version.md",
        },
        {
          id: "experience_projection",
          remoteUri:
            "viking://user/delegate-memory-namespace_safe/memories/delegate/namespace_safe/representative-experience/memories/experience_memory/versions/experience_version.md",
        },
      ]);
    });
  });
});

async function createTemporaryLegacyProjectionTables(
  tx: Prisma.TransactionClient,
) {
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "MemoryProjectionItem" (
      "id" TEXT NOT NULL,
      "representativeId" TEXT NOT NULL,
      "memoryId" TEXT NOT NULL,
      "memoryVersionId" TEXT NOT NULL,
      "status" "MemoryProjectionStatus" NOT NULL,
      "attemptCount" INTEGER NOT NULL,
      "leaseToken" TEXT,
      "leaseExpiresAt" TIMESTAMP(3),
      "remoteUri" TEXT,
      "remoteObjectId" TEXT,
      "projectedAt" TIMESTAMP(3),
      "deleteRequestedAt" TIMESTAMP(3),
      "deletedAt" TIMESTAMP(3)
    ) ON COMMIT DROP
  `);
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "GovernedMemory" (
      "id" TEXT NOT NULL,
      "representativeId" TEXT NOT NULL,
      "scope" "MemoryScope" NOT NULL,
      "contactId" TEXT,
      "sourceChannel" "RepresentativeChannelKind"
    ) ON COMMIT DROP
  `);
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE "RepresentativeMemoryPolicy" (
      "representativeId" TEXT NOT NULL,
      "namespaceKey" TEXT NOT NULL
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
    throw new Error("DATABASE_URL is required for projection migration PostgreSQL E2E.");
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host)
    || !["test", "e2e", "delegate"].some((marker) => database.includes(marker))
  ) {
    throw new Error(
      `Refusing projection migration PostgreSQL E2E against ${host}/${database}.`,
    );
  }
}

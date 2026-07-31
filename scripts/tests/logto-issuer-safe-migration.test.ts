import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260729143000_logto_issuer_safe_legacy_identity/migration.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const indexMigrationSql = [
  "20260729143100_owner_logto_issuer_lookup_index",
  "20260729143200_owner_logto_issuer_unique_index",
  "20260729143300_audience_logto_issuer_unique_index",
].map((migration) =>
  readFileSync(
    resolve(
      process.cwd(),
      `prisma/migrations/${migration}/migration.sql`,
    ),
    "utf8",
  ),
).join("\n");
const backfillSql = readFileSync(
  resolve(
    process.cwd(),
    "prisma/backfill/logto-issuer-safe-legacy.sql",
  ),
  "utf8",
);

describe("issuer-safe legacy identity migration", () => {
  it("expands OwnerIdentityLink without forcing an invented issuer", () => {
    expect(migrationSql).toContain(
      'ALTER TABLE "OwnerIdentityLink"\nADD COLUMN "issuer" TEXT;',
    );
    expect(migrationSql).not.toMatch(
      /ADD COLUMN "issuer" TEXT NOT NULL/u,
    );
    expect(migrationSql).not.toMatch(
      /DROP INDEX "OwnerIdentityLink_provider_providerSubject_key"/u,
    );
  });

  it("backfills Owner and Audience Logto issuers only from valid metadata evidence", () => {
    expect(migrationSql).not.toMatch(/\bUPDATE\b/u);
    expect(backfillSql).toContain('UPDATE "OwnerIdentityLink" AS link');
    expect(backfillSql).toContain('UPDATE "IdentityLink" AS link');
    expect(backfillSql).toContain(
      `btrim(link."metadata" ->> 'issuer') ~ '^https?://[^[:space:]]+$'`,
    );
    expect(backfillSql).toContain(
      `lower(btrim(link."issuer")) = 'delegate'`,
    );
    expect(backfillSql.match(/metadata" ->> 'issuer'/gu)?.length).toBeGreaterThanOrEqual(6);
    expect(backfillSql).toContain("LIMIT :batch_size");
    expect(backfillSql).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("adds exact-principal keys while retaining expand-phase legacy uniqueness", () => {
    expect(indexMigrationSql).toContain(
      '"OwnerIdentityLink_provider_issuer_providerSubject_key"',
    );
    expect(indexMigrationSql).toContain(
      'WHERE "issuer" IS NOT NULL;',
    );
    expect(indexMigrationSql).toContain(
      '"IdentityLink_provider_issuer_providerSubject_key"',
    );
    expect(indexMigrationSql).toMatch(/CREATE UNIQUE INDEX CONCURRENTLY/u);
    expect(indexMigrationSql).not.toMatch(
      /CREATE(?: UNIQUE)? INDEX CONCURRENTLY IF NOT EXISTS/u,
    );
    expect(indexMigrationSql).not.toMatch(
      /DROP INDEX "IdentityLink_provider_providerSubject_key"/u,
    );
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260803162010_lock_memory_namespace_key/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Memory System namespace-key authority", () => {
  it("locks the database namespace to the same lossless URI-segment alphabet", () => {
    expect(migration).toContain('ALTER TABLE "RepresentativeMemoryPolicy"');
    expect(migration).toContain(
      'CONSTRAINT "MemoryPolicy_namespace_key_canonical_check"',
    );
    expect(migration).toContain(
      `CHECK ("namespaceKey" ~ '^[A-Za-z0-9_-]{1,128}$')`,
    );
  });

  it("makes the namespace immutable without blocking other policy updates", () => {
    expect(migration).toContain(
      'CREATE FUNCTION "representative_memory_namespace_key_guard"()',
    );
    expect(migration).toContain(
      'IF NEW."namespaceKey" IS DISTINCT FROM OLD."namespaceKey" THEN',
    );
    expect(migration).toContain(
      'CONSTRAINT = \'MemoryPolicy_namespace_key_immutable_check\'',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "RepresentativeMemoryPolicy_namespace_key_guard"',
    );
    expect(migration).toContain(
      'BEFORE UPDATE ON "RepresentativeMemoryPolicy"',
    );
    expect(migration).toContain("RETURN NEW");
  });

  it("does not rewrite or normalize existing namespace keys", () => {
    expect(migration).not.toMatch(
      /UPDATE\s+"RepresentativeMemoryPolicy"\s+SET/iu,
    );
    expect(migration).not.toMatch(/\b(?:lower|trim|replace)\s*\(/iu);
  });
});

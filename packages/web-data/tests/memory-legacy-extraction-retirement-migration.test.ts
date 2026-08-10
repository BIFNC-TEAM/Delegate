import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("legacy memory extraction retirement migration", () => {
  it("cancels unfinished non-channel runs without deleting audit history", () => {
    const migration = fs.readFileSync(
      path.join(
        process.cwd(),
        "../../prisma/migrations/20260806170000_retire_legacy_memory_extraction_triggers/migration.sql",
      ),
      "utf8",
    );

    expect(migration).toContain('UPDATE "MemoryExtractionRun"');
    expect(migration).toContain("'CANCELED'::\"MemoryExtractionStatus\"");
    expect(migration).toContain("'MANUAL'::\"MemoryExtractionTrigger\"");
    expect(migration).toContain("'SHADOW'::\"MemoryExtractionTrigger\"");
    expect(migration).toContain("'SCHEDULED'::\"MemoryExtractionTrigger\"");
    expect(migration).toContain("memory_extraction_trigger_retired");
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"MemoryExtractionRun"/u);
  });
});

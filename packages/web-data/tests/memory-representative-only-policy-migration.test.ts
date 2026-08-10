import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "../../prisma/migrations/20260806150000_representative_experience_only_policy/migration.sql",
  ),
  "utf8",
);

describe("representative-experience-only memory policy migration", () => {
  it("allows automatic Web extraction for either durable memory type", () => {
    expect(migration).toContain(
      '("contactMemoryEnabled" OR "representativeExperienceEnabled")',
    );
    expect(migration).toContain('AND "autoExtract"');
    expect(migration).toContain(
      'NOT "contactMemoryCrossChannelEnabled" OR',
    );
    expect(migration).toContain(
      'DROP CONSTRAINT "MemoryPolicy_safe_enablement_check"',
    );
  });
});

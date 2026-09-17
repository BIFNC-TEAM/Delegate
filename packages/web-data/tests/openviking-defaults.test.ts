import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(
  new URL("../../../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const representativeSetup = readFileSync(
  new URL("../src/representative-setup.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260917090000_enable_openviking_by_default/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("OpenViking representative defaults", () => {
  it("enables OpenViking for newly created representatives", () => {
    expect(schema).toMatch(
      /openvikingEnabled\s+Boolean\s+@default\(true\)/u,
    );
    expect(representativeSetup).toContain("openvikingEnabled: true,");
  });

  it("changes only the database default without backfilling existing choices", () => {
    expect(migration).toContain(
      'ALTER COLUMN "openvikingEnabled" SET DEFAULT true;',
    );
    expect(migration).not.toContain('UPDATE "Representative"');
  });
});

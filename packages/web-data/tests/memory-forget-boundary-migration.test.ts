import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260806250000_contact_channel_memory_forget_boundary/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("contact-channel memory forget boundary migration", () => {
  it("uses server ordering plus an immutable, bodyless coordinate proof", () => {
    expect(migration).toContain('CREATE SEQUENCE "Message_memory_ingress_ordinal_seq"');
    expect(migration).toContain('NEW."memoryIngressOrdinal" := nextval');
    expect(migration).toContain(
      'UPDATE OF "memoryIngressOrdinal", "senderType" ON "Message"',
    );
    expect(migration).toContain('CREATE TABLE "ContactChannelMemoryForgetBoundary"');
    expect(migration).toContain('"cutoffIngressSequence" INTEGER');
    expect(migration).toContain('"requestHash" TEXT NOT NULL');
    expect(migration).toContain(
      'CREATE TRIGGER "ContactChannelMemoryForgetBoundary_guard"',
    );
    const table = tableBlock("ContactChannelMemoryForgetBoundary");
    expect(table).not.toMatch(/"(?:text|body|content|summary)"/iu);
    expect(migration).toContain(
      "Contact-channel memory forget proofs are immutable.",
    );
  });

  it("fences extraction epochs, automatic activation, and final injection", () => {
    expect(migration).toContain('ADD COLUMN "contactChannelMemoryEpoch"');
    expect(migration).toContain(
      'CREATE TRIGGER "MemoryExtractionRun_forget_epoch_immutable_guard"',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "00_GovernedMemory_forget_boundary_guard"',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "00_MemoryUseItem_forget_boundary_guard"',
    );
    expect(migration).toContain(
      'PERFORM pg_advisory_xact_lock(hashtext(coordinate_lock_key))',
    );
    expect(migration).toContain(
      'source_record.source_ordinal\n      <= latest_boundary."cutoffMemoryIngressOrdinal"',
    );
    expect(migration).toContain(
      'use_record.input_ordinal\n      <= latest_boundary."cutoffMemoryIngressOrdinal"',
    );
  });
});

function tableBlock(tableName: string) {
  const match = migration.match(new RegExp(
    `CREATE TABLE "${tableName}" \\([\\s\\S]*?\\n\\);`,
    "u",
  ));
  if (!match) throw new Error(`Missing table ${tableName}`);
  return match[0];
}

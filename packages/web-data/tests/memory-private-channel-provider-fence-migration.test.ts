import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260806230000_private_channel_disclosure_provider_fence/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const service = readFileSync(
  new URL("../src/memory-disclosure.ts", import.meta.url),
  "utf8",
);

describe("private-channel disclosure provider-event fence", () => {
  it("stores an immutable provider-ID exclusion set", () => {
    expect(migration).toContain(
      'CREATE TABLE "MemoryChannelDisclosureExcludedInbound"',
    );
    expect(migration).toContain(
      'PRIMARY KEY ("deliveryId", "externalInboundMessageId")',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "MemoryDisclosureExcludedInbound_immutable_guard"',
    );
    expect(migration).toContain("BEFORE UPDATE");
    expect(migration).not.toContain("BEFORE UPDATE OR DELETE");
  });

  it("rejects every exact input provider ID observed before delivery", () => {
    const guard = functionBlock("memory_private_channel_disclosure_allows");
    expect(guard).toContain(
      'input_message."externalMessageId" IS NOT NULL',
    );
    expect(guard).toContain(
      'FROM "MemoryChannelDisclosureExcludedInbound" AS excluded',
    );
    expect(guard).toContain(
      'excluded."deliveryId" = disclosure."id"',
    );
    expect(guard).toContain(
      'excluded."externalInboundMessageId"\n                  = input_message."externalMessageId"',
    );
  });

  it("serializes claim append and delivery completion on the same row lock", () => {
    expect(service.match(
      /FROM "MemoryChannelDisclosureDelivery"[\s\S]*?FOR UPDATE/gu,
    )).toHaveLength(2);
    const claimLock = service.indexOf(
      'WHERE "id" = ${current.id}\n         FOR UPDATE',
    );
    const pendingDecision = service.indexOf(
      "current.status !== MemoryDisclosureDeliveryStatus.DELIVERED",
      claimLock,
    );
    const exclusionAppend = service.indexOf(
      "recordMemoryDisclosureInboundExclusions",
      pendingDecision,
    );
    expect(claimLock).toBeGreaterThan(-1);
    expect(pendingDecision).toBeGreaterThan(claimLock);
    expect(exclusionAppend).toBeGreaterThan(pendingDecision);
    expect(service).toContain(
      "inboundExternalMessageIds: readonly string[]",
    );
    expect(service).toContain("skipDuplicates: true");
  });
});

function functionBlock(functionName: string) {
  const match = migration.match(new RegExp(
    `CREATE OR REPLACE FUNCTION "${functionName}"\\([\\s\\S]*?\\$\\$ LANGUAGE plpgsql(?: STABLE)?;`,
    "u",
  ));
  if (!match) throw new Error(`Missing function ${functionName}`);
  return match[0];
}

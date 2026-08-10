import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const schema = readFileSync(
  new URL("../../../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260807133000_contact_memory_sharing_replay_tombstones/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("contact memory sharing replay tombstones", () => {
  it("keeps an opaque global event fence without retention-parent relations", () => {
    const tombstone = modelBlock(
      schema,
      "ContactMemorySharingSourceEventTombstone",
    );
    expect(tombstone).toContain("eventHash");
    expect(tombstone).toContain("@id");
    expect(tombstone).toContain("firstClaimedAt");
    expect(tombstone).not.toContain("representativeId");
    expect(tombstone).not.toContain("audienceIdentityId");
    expect(tombstone).not.toContain("@relation");
    expect(migration).toContain(
      'CREATE TABLE "ContactMemorySharingSourceEventTombstone"',
    );
    expect(migration).toContain(
      'FROM "ContactMemorySharingSourceEventClaim" claim',
    );
    const challengeLock = migration.indexOf(
      'LOCK TABLE "ContactMemorySharingChallenge"\n  IN ACCESS EXCLUSIVE MODE;',
    );
    const consentLock = migration.indexOf(
      'LOCK TABLE "ContactMemorySharingConsent"\n  IN ACCESS EXCLUSIVE MODE;',
    );
    const liveClaimLock = migration.indexOf(
      'LOCK TABLE "ContactMemorySharingSourceEventClaim"\n  IN SHARE ROW EXCLUSIVE MODE;',
    );
    const tombstoneBackfill = migration.indexOf(
      'INSERT INTO "ContactMemorySharingSourceEventTombstone"',
    );
    expect(challengeLock).toBeGreaterThan(-1);
    expect(consentLock).toBeGreaterThan(challengeLock);
    expect(liveClaimLock).toBeGreaterThan(consentLock);
    expect(tombstoneBackfill).toBeGreaterThan(liveClaimLock);
    expect(migration).toContain(
      "ContactMemorySharingSourceEventTombstone_immutable_check",
    );
  });

  it("claims the permanent fence atomically and blocks direct proof deletion", () => {
    const claimGuard = functionBlock(
      migration,
      "contact_memory_sharing_source_event_claim_guard",
    );
    expect(claimGuard).toContain(
      'INSERT INTO "ContactMemorySharingSourceEventTombstone"',
    );
    expect(claimGuard).toContain("NEW.\"eventHash\"");
    expect(claimGuard).toContain("pg_trigger_depth() <= 1");
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON "ContactMemorySharingChallenge"',
    );
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON "ContactMemorySharingConsent"',
    );
    expect(migration).toContain("ContactMemorySharingChallenge_delete_check");
    expect(migration).toContain("ContactMemorySharingConsent_delete_check");
  });
});

function modelBlock(source: string, modelName: string) {
  const match = source.match(
    new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`, "u"),
  );
  if (!match?.[1]) throw new Error(`Missing model ${modelName}`);
  return match[1];
}

function functionBlock(source: string, functionName: string) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = source.match(new RegExp(
    `CREATE OR REPLACE FUNCTION "${escapedName}"\\(\\)[\\s\\S]*?\\$\\$ LANGUAGE plpgsql;`,
    "u",
  ));
  if (!match?.[0]) throw new Error(`Missing function ${functionName}`);
  return match[0];
}

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260807129000_contact_memory_sharing_replay_and_legacy_fence/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Contact Memory sharing legacy migration", () => {
  it("aborts ambiguous mixed-authority scopes before any revocation or cleanup", () => {
    const preflight = requiredMatch(
      migration,
      /DO \$legacy_contact_memory_sharing_mixed_authority_preflight\$([\s\S]*?)\$legacy_contact_memory_sharing_mixed_authority_preflight\$;/u,
      "mixed-authority preflight",
    );

    expect(preflight).toContain('JOIN "ContactMemorySharingConsent" authority_consent');
    expect(preflight).toContain('JOIN "ContactMemorySharingChallenge" authority_challenge');
    expect(preflight).toContain(
      'authority_challenge."sourceEvidenceHash"\n            = authority_consent."sourceEvidenceHash"',
    );
    expect(preflight).toContain('authority_challenge."consumedAt" IS NOT NULL');
    expect(preflight).toContain('authority_challenge."revokedAt" IS NULL');
    expect(preflight).toContain(
      "ContactMemorySharingConsent_legacy_mixed_authority_preflight",
    );
    expect(preflight).toContain(
      "do not revoke challenge-backed grants or infer memory ownership",
    );

    const preflightOffset = migration.indexOf(
      "DO $legacy_contact_memory_sharing_mixed_authority_preflight$",
    );
    const revocationOffset = migration.indexOf(
      'UPDATE "ContactMemorySharingConsent" consent',
    );
    const memoryCleanupOffset = migration.indexOf('UPDATE "GovernedMemory" memory');
    expect(preflightOffset).toBeGreaterThan(-1);
    expect(preflightOffset).toBeLessThan(revocationOffset);
    expect(preflightOffset).toBeLessThan(memoryCleanupOffset);
  });

  it("revokes exact legacy grant rows rather than every grant in their scope", () => {
    expect(migration).toContain(
      'CREATE TEMPORARY TABLE "_LegacyContactMemorySharingGrant"',
    );
    const revocation = requiredMatch(
      migration,
      /(UPDATE "ContactMemorySharingConsent" consent[\s\S]*?;)/u,
      "legacy consent revocation",
    );
    expect(revocation).toContain(
      'FROM "_LegacyContactMemorySharingGrant" legacy_grant',
    );
    expect(revocation).toContain('consent."id" = legacy_grant."id"');
    expect(revocation).not.toContain(
      'consent."representativeId" = legacy_scope."representativeId"',
    );
    expect(revocation).not.toContain(
      'consent."audienceIdentityId" = legacy_scope."audienceIdentityId"',
    );
  });

  it("holds authority and cleanup writers across classification and cleanup", () => {
    const writerLockOffset = migration.indexOf("LOCK TABLE");
    const snapshotOffset = migration.indexOf(
      'CREATE TEMPORARY TABLE "_LegacyContactMemorySharingGrant"',
    );
    expect(writerLockOffset).toBeGreaterThan(-1);
    expect(writerLockOffset).toBeLessThan(snapshotOffset);
    for (const table of [
      "ContactMemorySharingChallenge",
      "ContactMemorySharingConsent",
      "GovernedMemory",
      "MemoryProjectionItem",
      "MemoryDeletionProof",
    ]) {
      expect(migration).toContain(`  "${table}"`);
    }
    expect(migration).toContain("IN SHARE ROW EXCLUSIVE MODE");
  });
});

function requiredMatch(source: string, pattern: RegExp, label: string) {
  const value = source.match(pattern)?.[1]?.trim();
  if (!value) throw new Error(`Could not extract ${label}.`);
  return value;
}

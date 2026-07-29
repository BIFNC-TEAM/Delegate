import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260728120000_owner_settings_foundation/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const lookupIndexMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260728120100_owner_settings_audit_lookup_index/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const idempotencyIndexMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260728120200_owner_settings_idempotency_index/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("owner settings migration safety", () => {
  it("keeps the private account name separate from public Owner attribution", () => {
    expect(migration).toContain(
      'ADD COLUMN "accountDisplayName" VARCHAR(80)',
    );
  });

  it("does not infer channel verification from the legacy provider timestamp", () => {
    expect(migration).not.toContain(
      'SET "emailVerifiedAt" = "verifiedAt"',
    );
    expect(migration).not.toContain(
      'SET "phoneVerifiedAt" = "verifiedAt"',
    );
  });

  it("does not reserve unsupported quiet-hours fields and validates Owner checks online", () => {
    expect(migration).not.toContain("quietHours");
    expect(migration).toContain(
      'VALIDATE CONSTRAINT "Owner_preferredLocale_valid"',
    );
    expect(migration).toContain(
      'VALIDATE CONSTRAINT "Owner_settingsVersion_nonnegative"',
    );
  });

  it("avoids rewriting legacy audit rows and validates new scope constraints online", () => {
    expect(migration).not.toContain('UPDATE "EventAudit"');
    expect(migration).toContain(
      'ADD CONSTRAINT "EventAudit_scope_valid" CHECK',
    );
    expect(migration).toContain("NOT VALID");
    expect(migration).toContain(
      'VALIDATE CONSTRAINT "EventAudit_scope_valid"',
    );
    expect(migration).toContain(
      'VALIDATE CONSTRAINT "EventAudit_ownerId_fkey"',
    );
  });

  it("builds hot audit indexes concurrently in isolated migrations", () => {
    expect(lookupIndexMigration.trim()).toMatch(
      /^CREATE INDEX CONCURRENTLY[\s\S]+;$/,
    );
    expect(idempotencyIndexMigration.trim()).toMatch(
      /^CREATE UNIQUE INDEX CONCURRENTLY[\s\S]+;$/,
    );
  });
});

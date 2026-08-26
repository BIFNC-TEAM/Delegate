import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const schema = readFileSync(
  new URL("../../../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260729143400_account_appsession_shadow_foundation/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const ownerAccountIndexMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260729143500_owner_account_unique_index/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const audienceAccountIndexMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260729143600_audience_account_unique_index/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const publicAudienceBindingMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260826103000_appsession_public_audience_binding/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const indexRecoveryOperation = readFileSync(
  new URL(
    "../../../scripts/logto-issuer-safe-index-operation.sh",
    import.meta.url,
  ),
  "utf8",
);

describe("Account/AppSession shadow schema", () => {
  it("is expand-only and leaves both legacy persona links nullable", () => {
    expect(schema).toContain("model Account {");
    expect(schema).toContain("model AuthIdentity {");
    expect(schema).toContain("model AppSession {");
    expect(schema).toMatch(/model Owner \{\s+id[\s\S]*?accountId\s+String\?\s+@unique/u);
    expect(schema).toMatch(
      /model AudienceIdentity \{\s+id[\s\S]*?accountId\s+String\?\s+@unique/u,
    );
    expect(migration).not.toMatch(
      /^\s*(?:UPDATE|DELETE|DROP|TRUNCATE)\b/mu,
    );
    expect(migration).not.toContain('CREATE UNIQUE INDEX "Owner_accountId_key"');
    expect(migration).not.toContain(
      'CREATE UNIQUE INDEX "AudienceIdentity_accountId_key"',
    );
  });

  it("builds each existing persona uniqueness key concurrently in its own migration", () => {
    expect(ownerAccountIndexMigration.trim()).toBe(
      'CREATE UNIQUE INDEX CONCURRENTLY "Owner_accountId_key"\n'
      + '  ON "Owner"("accountId");',
    );
    expect(audienceAccountIndexMigration.trim()).toBe(
      'CREATE UNIQUE INDEX CONCURRENTLY "AudienceIdentity_accountId_key"\n'
      + '  ON "AudienceIdentity"("accountId");',
    );
    expect(
      `${ownerAccountIndexMigration}\n${audienceAccountIndexMigration}`,
    ).not.toContain("IF NOT EXISTS");
  });

  it("ships a fail-closed recovery operation for both accountId CCI migrations", () => {
    expect(indexRecoveryOperation).toContain("owner-account-unique)");
    expect(indexRecoveryOperation).toContain("audience-account-unique)");
    expect(indexRecoveryOperation).toContain(
      'expected_columns="accountId"',
    );
    expect(indexRecoveryOperation).toContain(
      'expected_opclasses="pg_catalog.text_ops"',
    );
    expect(indexRecoveryOperation).toContain(
      'create_sql=\'CREATE UNIQUE INDEX CONCURRENTLY "Owner_accountId_key" ON public."Owner"("accountId");\'',
    );
    expect(indexRecoveryOperation).toContain(
      'create_sql=\'CREATE UNIQUE INDEX CONCURRENTLY "AudienceIdentity_accountId_key" ON public."AudienceIdentity"("accountId");\'',
    );
    expect(indexRecoveryOperation).toContain(
      "WHERE constraint_state.conindid = index_state.indexrelid",
    );
    expect(indexRecoveryOperation).toContain(
      'valid_action="reject"',
    );
    expect(indexRecoveryOperation).not.toContain("IF NOT EXISTS");
  });

  it("adds existing persona foreign keys without a blocking validation scan", () => {
    expect(migration).toMatch(
      /Owner_accountId_fkey[\s\S]*?ON DELETE SET NULL ON UPDATE CASCADE\s+NOT VALID;/u,
    );
    expect(migration).toMatch(
      /AudienceIdentity_accountId_fkey[\s\S]*?ON DELETE SET NULL ON UPDATE CASCADE\s+NOT VALID;/u,
    );
  });

  it("keys authentication only by provider, issuer, and subject", () => {
    expect(schema).toContain("@@unique([provider, issuer, subject])");
    expect(migration).toContain(
      'CONSTRAINT "AuthIdentity_issuer_nonblank_check"',
    );
    expect(migration).toContain(
      'CONSTRAINT "AuthIdentity_subject_nonblank_check"',
    );
    expect(migration).not.toMatch(
      /UNIQUE[^(]*\(\s*"email"\s*\)|UNIQUE[^(]*\(\s*"phone"\s*\)/u,
    );
  });

  it("binds every session to an identity from the same Account", () => {
    expect(schema).toContain("authIdentityId       String");
    expect(schema).toContain("@@unique([id, accountId])");
    expect(schema).toContain(
      "@relation(fields: [authIdentityId, accountId], references: [id, accountId], onDelete: Restrict)",
    );
    expect(migration).toContain(
      'FOREIGN KEY ("authIdentityId", "accountId")',
    );
    expect(migration).toContain(
      'REFERENCES "AuthIdentity"("id", "accountId")',
    );
  });

  it("adds the public audience binding as an expand-only nullable column", () => {
    expect(schema).toContain(
      "publicAudienceId     String?                @db.VarChar(191)",
    );
    expect(publicAudienceBindingMigration).toContain(
      'ADD COLUMN "publicAudienceId" VARCHAR(191)',
    );
    expect(publicAudienceBindingMigration).not.toMatch(
      /^\s*(?:UPDATE|DELETE|DROP|TRUNCATE)\b/mu,
    );
    expect(publicAudienceBindingMigration).not.toContain("NOT NULL");
  });

  it("enforces token, expiry, and registered-audience invariants", () => {
    expect(migration).toContain(
      'CHECK (octet_length("tokenHash") = 32)',
    );
    expect(migration).toContain(
      '"lastSeenAt" < "idleExpiresAt"',
    );
    expect(migration).toContain(
      '"idleExpiresAt" <= "absoluteExpiresAt"',
    );
    expect(migration).toContain(
      'CONSTRAINT "AppSession_active_organization_disabled_check"',
    );
    expect(migration).toContain(
      'CHECK ("activeOrganizationId" IS NULL)',
    );
    expect(migration).toMatch(
      /"revokedAt" IS NULL[\s\S]*"revokedReason" IS NULL[\s\S]*"revokedAt" IS NOT NULL[\s\S]*"revokedReason" IS NOT NULL/u,
    );
    expect(migration).toContain(
      'CHECK ("accountId" IS NULL OR "status" = \'REGISTERED\'::"AudienceIdentityStatus")',
    );
    expect(migration).toMatch(
      /AudienceIdentity_registered_account_check[\s\S]*NOT VALID;/u,
    );
  });
});

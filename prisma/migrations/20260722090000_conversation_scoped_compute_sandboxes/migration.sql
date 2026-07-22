-- Public compute sandboxes are isolated by conversation instead of being
-- shared across every conversation owned by the same contact.
ALTER TABLE "SandboxIdentity"
ADD COLUMN "scopeKey" TEXT NOT NULL DEFAULT 'contact';

DROP INDEX "SandboxIdentity_representativeId_contactId_key";

CREATE UNIQUE INDEX "SandboxIdentity_representativeId_contactId_scopeKey_key"
ON "SandboxIdentity"("representativeId", "contactId", "scopeKey");

CREATE INDEX "SandboxIdentity_scopeKey_updatedAt_idx"
ON "SandboxIdentity"("scopeKey", "updatedAt");

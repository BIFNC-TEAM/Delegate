CREATE UNIQUE INDEX CONCURRENTLY "EventAudit_ownerId_idempotencyKey_key"
  ON "EventAudit"("ownerId", "idempotencyKey");

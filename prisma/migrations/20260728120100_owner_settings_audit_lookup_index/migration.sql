CREATE INDEX CONCURRENTLY "EventAudit_ownerId_createdAt_idx"
  ON "EventAudit"("ownerId", "createdAt");

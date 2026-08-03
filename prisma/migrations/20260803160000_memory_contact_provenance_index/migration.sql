-- This hot-table composite provenance index is isolated so a failed
-- concurrent build can be resolved and retried without replaying other scans.
CREATE UNIQUE INDEX CONCURRENTLY "Contact_id_representativeId_key"
  ON "Contact"("id", "representativeId");

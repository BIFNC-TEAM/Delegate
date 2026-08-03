-- One concurrent hot-table index per migration keeps recovery bounded.
CREATE UNIQUE INDEX CONCURRENTLY "GenerationRun_id_conversationId_key"
  ON "GenerationRun"("id", "conversationId");

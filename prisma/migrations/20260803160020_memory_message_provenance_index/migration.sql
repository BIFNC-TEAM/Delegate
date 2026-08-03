-- One concurrent hot-table index per migration keeps recovery bounded.
CREATE UNIQUE INDEX CONCURRENTLY "Message_id_conversationId_key"
  ON "Message"("id", "conversationId");

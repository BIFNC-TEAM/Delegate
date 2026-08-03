-- One concurrent hot-table index per migration keeps recovery bounded.
CREATE UNIQUE INDEX CONCURRENTLY "Conversation_id_rep_contact_key"
  ON "Conversation"("id", "representativeId", "contactId");

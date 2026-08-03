-- One concurrent hot-table index per migration keeps recovery bounded.
CREATE UNIQUE INDEX CONCURRENTLY "KnowledgeAssetRep_id_rep_key"
  ON "KnowledgeAssetRepresentative"("id", "representativeId");

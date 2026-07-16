CREATE INDEX "KnowledgeAsset_ownerId_sourceObjectChecksum_idx"
ON "KnowledgeAsset"("ownerId", "sourceObjectChecksum");

CREATE INDEX "KnowledgeAsset_ownerId_originalFileName_idx"
ON "KnowledgeAsset"("ownerId", "originalFileName");

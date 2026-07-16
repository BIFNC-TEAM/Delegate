ALTER TABLE "KnowledgeAsset"
ADD COLUMN "sourceObjectBucket" TEXT,
ADD COLUMN "sourceObjectKey" TEXT,
ADD COLUMN "sourceObjectEtag" TEXT,
ADD COLUMN "sourceObjectVersion" TEXT,
ADD COLUMN "sourceObjectChecksum" TEXT,
ADD COLUMN "vectorBackend" TEXT,
ADD COLUMN "vectorUri" TEXT,
ADD COLUMN "vectorChunkCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "embeddingModel" TEXT,
ADD COLUMN "indexedAt" TIMESTAMP(3);

CREATE INDEX "KnowledgeAsset_ownerId_vectorBackend_indexedAt_idx"
ON "KnowledgeAsset"("ownerId", "vectorBackend", "indexedAt");

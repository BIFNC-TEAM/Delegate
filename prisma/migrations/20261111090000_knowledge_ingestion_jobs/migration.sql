CREATE TABLE "KnowledgeIngestionJob" (
 "assetId" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'pending', "checkpoint" JSONB,
 "leaseToken" TEXT, "leaseExpiresAt" TIMESTAMP(3),
 "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "attempts" INTEGER NOT NULL DEFAULT 0, "error" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "KnowledgeIngestionJob_status_availableAt_leaseExpiresAt_idx"
 ON "KnowledgeIngestionJob"("status", "availableAt", "leaseExpiresAt");

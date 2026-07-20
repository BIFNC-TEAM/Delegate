-- CreateEnum
CREATE TYPE "KnowledgeAssetKind" AS ENUM ('PDF', 'DOCX', 'TXT', 'MARKDOWN', 'URL', 'TEXT');

-- CreateEnum
CREATE TYPE "KnowledgeAssetStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "KnowledgeAssetVisibility" AS ENUM ('OWNER_ONLY', 'ORGANIZATION_SHARED', 'SELECTED_REPRESENTATIVES', 'PUBLIC_MATERIAL');

-- CreateEnum
CREATE TYPE "KnowledgeAssetUsageMode" AS ENUM ('QA_SOURCE', 'PUBLIC_MATERIAL', 'BOTH');

-- CreateEnum
CREATE TYPE "KnowledgeAssetReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KnowledgeProcessingLogLevel" AS ENUM ('INFO', 'WARNING', 'ERROR');

-- CreateTable
CREATE TABLE "KnowledgeAsset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" "KnowledgeAssetKind" NOT NULL,
    "status" "KnowledgeAssetStatus" NOT NULL DEFAULT 'PROCESSING',
    "visibility" "KnowledgeAssetVisibility" NOT NULL DEFAULT 'OWNER_ONLY',
    "title" TEXT NOT NULL,
    "originalFileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "sourceUrl" TEXT,
    "sourceText" TEXT,
    "extractedText" TEXT,
    "summary" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "autoTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "checksum" TEXT,
    "processingError" TEXT,
    "processingVersion" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "processedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeAssetRepresentative" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "usageMode" "KnowledgeAssetUsageMode" NOT NULL DEFAULT 'QA_SOURCE',
    "reviewStatus" "KnowledgeAssetReviewStatus" NOT NULL DEFAULT 'APPROVED',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeAssetRepresentative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeProcessingLog" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "level" "KnowledgeProcessingLogLevel" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeProcessingLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeAsset_ownerId_status_updatedAt_idx" ON "KnowledgeAsset"("ownerId", "status", "updatedAt");
CREATE INDEX "KnowledgeAsset_ownerId_kind_createdAt_idx" ON "KnowledgeAsset"("ownerId", "kind", "createdAt");
CREATE INDEX "KnowledgeAsset_ownerId_visibility_updatedAt_idx" ON "KnowledgeAsset"("ownerId", "visibility", "updatedAt");
CREATE UNIQUE INDEX "KnowledgeAssetRepresentative_assetId_representativeId_key" ON "KnowledgeAssetRepresentative"("assetId", "representativeId");
CREATE INDEX "KnowledgeAssetRepresentative_representativeId_enabled_updatedAt_idx" ON "KnowledgeAssetRepresentative"("representativeId", "enabled", "updatedAt");
CREATE INDEX "KnowledgeAssetRepresentative_assetId_reviewStatus_idx" ON "KnowledgeAssetRepresentative"("assetId", "reviewStatus");
CREATE INDEX "KnowledgeProcessingLog_assetId_createdAt_idx" ON "KnowledgeProcessingLog"("assetId", "createdAt");
CREATE INDEX "KnowledgeProcessingLog_level_createdAt_idx" ON "KnowledgeProcessingLog"("level", "createdAt");

-- AddForeignKey
ALTER TABLE "KnowledgeAsset" ADD CONSTRAINT "KnowledgeAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeAssetRepresentative" ADD CONSTRAINT "KnowledgeAssetRepresentative_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "KnowledgeAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeAssetRepresentative" ADD CONSTRAINT "KnowledgeAssetRepresentative_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeProcessingLog" ADD CONSTRAINT "KnowledgeProcessingLog_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "KnowledgeAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

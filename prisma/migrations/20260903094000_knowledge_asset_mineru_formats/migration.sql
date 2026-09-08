-- Extend workspace knowledge assets with the additional document families
-- supported by the MinerU ingestion boundary.
ALTER TYPE "KnowledgeAssetKind" ADD VALUE IF NOT EXISTS 'PPTX';
ALTER TYPE "KnowledgeAssetKind" ADD VALUE IF NOT EXISTS 'XLSX';
ALTER TYPE "KnowledgeAssetKind" ADD VALUE IF NOT EXISTS 'IMAGE';

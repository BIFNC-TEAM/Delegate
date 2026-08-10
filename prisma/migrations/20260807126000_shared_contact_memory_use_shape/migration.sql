-- The truth-ledger trigger now validates CONTACT_SHARED precisely, but the
-- table-level source-shape CHECK still lists only CONTACT_CHANNEL. Extend only
-- the CONTACT_MEMORY scope allowlist; all version/projection exclusivity and
-- the PUBLIC_KNOWLEDGE / REPRESENTATIVE_EXPERIENCE shapes remain unchanged.

BEGIN;

ALTER TABLE "MemoryUseItem"
  DROP CONSTRAINT "MemoryUseItem_source_shape_check";

ALTER TABLE "MemoryUseItem"
  ADD CONSTRAINT "MemoryUseItem_source_shape_check" CHECK (
    (
      "sourceKind" = 'PUBLIC_KNOWLEDGE'::"MemoryUseSourceKind"
      AND "publicKnowledgeProjectionId" IS NOT NULL
      AND "memoryScope" IS NULL
      AND "memoryVersionId" IS NULL
      AND "projectionItemId" IS NULL
    ) OR (
      "sourceKind" = 'CONTACT_MEMORY'::"MemoryUseSourceKind"
      AND "memoryScope" IN ('CONTACT_CHANNEL', 'CONTACT_SHARED')
      AND "memoryVersionId" IS NOT NULL
      AND "projectionItemId" IS NOT NULL
      AND "publicKnowledgeProjectionId" IS NULL
    ) OR (
      "sourceKind" = 'REPRESENTATIVE_EXPERIENCE'::"MemoryUseSourceKind"
      AND "memoryScope" = 'REPRESENTATIVE'::"MemoryScope"
      AND "memoryVersionId" IS NOT NULL
      AND "projectionItemId" IS NOT NULL
      AND "publicKnowledgeProjectionId" IS NULL
    )
  );

COMMIT;

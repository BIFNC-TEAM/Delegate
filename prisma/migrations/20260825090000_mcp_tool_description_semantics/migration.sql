BEGIN;

ALTER TABLE "McpToolDefinition"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "semanticMetadata" JSONB;

COMMENT ON COLUMN "McpToolDefinition"."description" IS
  'Sanitized, untrusted discovery text observed from MCP tools/list; never authority for effect or approval.';
COMMENT ON COLUMN "McpToolDefinition"."semanticMetadata" IS
  'Owner/server governed discovery metadata. Remote MCP annotations must never be copied into this field.';

COMMIT;

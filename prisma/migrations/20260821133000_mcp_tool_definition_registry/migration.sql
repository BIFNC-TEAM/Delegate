BEGIN;

CREATE TABLE "McpToolDefinition" (
  "id" TEXT NOT NULL,
  "bindingId" TEXT NOT NULL,
  "bindingRevision" INTEGER NOT NULL,
  "exactToolName" TEXT NOT NULL,
  "inputSchema" JSONB NOT NULL,
  "outputSchema" JSONB,
  "toolSchemaHash" CHAR(64) NOT NULL,
  "bindingDefinitionHash" CHAR(64) NOT NULL,
  "canonicalizationVersion" TEXT NOT NULL DEFAULT 'delegate-capability-v1',
  "observedAnnotations" JSONB,
  "availability" TEXT NOT NULL DEFAULT 'ready',
  "observedAt" TIMESTAMP(3) NOT NULL,
  "supersededAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "McpToolDefinition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "McpToolDefinition_binding_revision_tool_key"
  ON "McpToolDefinition"("bindingId", "bindingRevision", "exactToolName");
CREATE INDEX "McpToolDefinition_binding_availability_observed_idx"
  ON "McpToolDefinition"("bindingId", "availability", "observedAt");
CREATE INDEX "McpToolDefinition_toolSchemaHash_idx"
  ON "McpToolDefinition"("toolSchemaHash");
CREATE INDEX "McpToolDefinition_bindingDefinitionHash_idx"
  ON "McpToolDefinition"("bindingDefinitionHash");

ALTER TABLE "McpToolDefinition"
  ADD CONSTRAINT "McpToolDefinition_bindingId_fkey"
  FOREIGN KEY ("bindingId") REFERENCES "RepresentativeMcpBinding"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;

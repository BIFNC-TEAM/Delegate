ALTER TABLE "ToolExecution" ADD COLUMN "providerOperation" JSONB;
CREATE FUNCTION delegate_provider_operation_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."providerOperation" IS NOT NULL AND NEW."providerOperation" IS DISTINCT FROM OLD."providerOperation" THEN
    RAISE EXCEPTION 'provider operation contract is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER provider_operation_immutable BEFORE UPDATE OF "providerOperation" ON "ToolExecution"
FOR EACH ROW EXECUTE FUNCTION delegate_provider_operation_immutable();
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'MCP_PROVIDER_OUTCOME_OBSERVED';

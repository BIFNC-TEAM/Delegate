ALTER TABLE "ToolExecution" ADD COLUMN "sourceReceipt" JSONB;

CREATE FUNCTION delegate_execution_source_receipt_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."sourceReceipt" IS NOT NULL AND NEW."sourceReceipt" IS DISTINCT FROM OLD."sourceReceipt" THEN
    RAISE EXCEPTION 'execution source receipt is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER execution_source_receipt_immutable
BEFORE UPDATE OF "sourceReceipt" ON "ToolExecution"
FOR EACH ROW EXECUTE FUNCTION delegate_execution_source_receipt_immutable();

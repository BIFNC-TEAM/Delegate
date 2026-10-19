ALTER TABLE "ToolExecution" ADD COLUMN "actionIdentity" JSONB;
CREATE INDEX "ToolExecution_action_origin_idx" ON "ToolExecution" (("actionIdentity"->>'originMessageId')) WHERE "actionIdentity" IS NOT NULL;
CREATE FUNCTION delegate_action_identity_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."actionIdentity" IS NOT NULL AND NEW."actionIdentity" IS DISTINCT FROM OLD."actionIdentity" THEN
    RAISE EXCEPTION 'logical action identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER logical_action_identity_immutable BEFORE UPDATE OF "actionIdentity" ON "ToolExecution"
FOR EACH ROW EXECUTE FUNCTION delegate_action_identity_immutable();

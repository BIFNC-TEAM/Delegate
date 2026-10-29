-- Nullable for compatibility: no backfill or automatic expansion of existing scope.
ALTER TABLE "Representative" ADD COLUMN "agentBehavior" JSONB;

-- A legacy publisher must not silently drop an explicitly configured policy
-- during a rolling upgrade. Existing versions stay immutable and unchanged.
CREATE FUNCTION enforce_representative_agent_behavior_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE configured_policy JSONB;
BEGIN
  SELECT "agentBehavior" INTO configured_policy
    FROM "Representative" WHERE id = NEW."representativeId" FOR SHARE;
  IF configured_policy IS NOT NULL
     AND (NEW.snapshot -> 'agentBehavior') IS DISTINCT FROM configured_policy THEN
    RAISE EXCEPTION 'representative_agent_behavior_snapshot_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER representative_agent_behavior_snapshot_guard
BEFORE INSERT ON "RepresentativeVersion"
FOR EACH ROW EXECUTE FUNCTION enforce_representative_agent_behavior_snapshot();

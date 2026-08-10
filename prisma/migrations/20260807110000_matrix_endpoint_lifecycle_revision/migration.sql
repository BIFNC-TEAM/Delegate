BEGIN;

-- Assignment and lifecycle epochs intentionally serve different fences.
-- endpointAssignmentRevision changes only when the routed endpoint identity
-- changes; endpointLifecycleRevision changes whenever a Matrix endpoint is
-- paused, disconnected, or reactivated. Queued work can therefore retain room
-- history across a reconnect while still proving that it belongs to the
-- currently active lifecycle.
ALTER TABLE "RepresentativeChannelBinding"
ADD COLUMN "endpointLifecycleRevision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "RepresentativeChannelBinding"
ADD CONSTRAINT "RepresentativeChannelBinding_endpointLifecycleRevision_positive"
CHECK ("endpointLifecycleRevision" > 0);

-- Do not backfill historical private-channel messages. A NULL lifecycle
-- snapshot is deliberately unauthorised for new asynchronous work, so legacy
-- queued messages cannot be resurrected by the first reconnect after rollout.
ALTER TABLE "Message"
ADD COLUMN "channelLifecycleRevision" INTEGER;

CREATE OR REPLACE FUNCTION "enforce_matrix_endpoint_lifecycle_revision"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."endpointLifecycleRevision" < 1 THEN
    NEW."endpointLifecycleRevision" := 1;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Never permit a stale writer to move the lifecycle epoch backwards.
    IF NEW."endpointLifecycleRevision"
      < OLD."endpointLifecycleRevision"
    THEN
      NEW."endpointLifecycleRevision" :=
        OLD."endpointLifecycleRevision";
    END IF;

    -- Old application instances do not know this column and therefore copy
    -- OLD unchanged. Advance it in the database for every Matrix desired-state
    -- transition. A current writer may already send OLD + 1; using <= avoids a
    -- double increment while preserving any larger monotonic explicit value.
    IF NEW."kind"::text = 'MATRIX'
      AND OLD."desiredState" IS DISTINCT FROM NEW."desiredState"
      AND NEW."endpointLifecycleRevision"
        <= OLD."endpointLifecycleRevision"
    THEN
      NEW."endpointLifecycleRevision" :=
        OLD."endpointLifecycleRevision" + 1;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  "RepresentativeChannelBinding_matrix_lifecycle_revision_trigger"
ON "RepresentativeChannelBinding";

CREATE TRIGGER
  "RepresentativeChannelBinding_matrix_lifecycle_revision_trigger"
BEFORE INSERT OR UPDATE ON "RepresentativeChannelBinding"
FOR EACH ROW
EXECUTE FUNCTION "enforce_matrix_endpoint_lifecycle_revision"();

COMMIT;

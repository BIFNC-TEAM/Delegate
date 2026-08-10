BEGIN;

-- endpointAssignmentRevision identifies an endpoint assignment, not a
-- transport lifecycle transition. Reconnecting the same managed Matrix user
-- through the same Application Service must preserve verified room bindings;
-- changing the MXID or Application Service connection still advances the
-- immutable assignment epoch and isolates rooms from the prior assignment.
-- Telegram intentionally retains its existing reconnect epoch semantics.
CREATE OR REPLACE FUNCTION "enforce_endpoint_assignment_revision"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."endpointAssignmentRevision" < 1 THEN
    NEW."endpointAssignmentRevision" := 1;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."endpointAssignmentRevision"
      < OLD."endpointAssignmentRevision"
    THEN
      NEW."endpointAssignmentRevision" :=
        OLD."endpointAssignmentRevision";
    END IF;

    -- During a rolling deployment, an older application instance still
    -- writes revision + 1 when it reconnects an unchanged Matrix endpoint.
    -- Normalize only that exact legacy write shape; any other explicit
    -- revision increase remains a security-significant reassignment below.
    IF NEW."kind"::text = 'MATRIX'
      AND OLD."kind" IS NOT DISTINCT FROM NEW."kind"
      AND OLD."externalUserId" IS NOT DISTINCT FROM NEW."externalUserId"
      AND OLD."connectionId" IS NOT DISTINCT FROM NEW."connectionId"
      AND OLD."desiredState"::text = 'DISCONNECTED'
      AND NEW."desiredState"::text <> 'DISCONNECTED'
      AND NEW."endpointAssignmentRevision"
        = OLD."endpointAssignmentRevision" + 1
    THEN
      NEW."endpointAssignmentRevision" :=
        OLD."endpointAssignmentRevision";
    END IF;

    IF (
        NEW."kind"::text = 'MATRIX'
        AND (
          OLD."kind" IS DISTINCT FROM NEW."kind"
          OR OLD."externalUserId" IS DISTINCT FROM NEW."externalUserId"
          OR OLD."connectionId" IS DISTINCT FROM NEW."connectionId"
        )
      )
      OR (
        NEW."kind"::text = 'TELEGRAM'
        AND (
          OLD."kind" IS DISTINCT FROM NEW."kind"
          OR OLD."connectionId" IS DISTINCT FROM NEW."connectionId"
          OR OLD."telegramBotConnectionId"
            IS DISTINCT FROM NEW."telegramBotConnectionId"
          OR (
            OLD."desiredState"::text = 'DISCONNECTED'
            AND NEW."desiredState"::text <> 'DISCONNECTED'
          )
        )
      )
    THEN
      IF NEW."endpointAssignmentRevision"
        <= OLD."endpointAssignmentRevision"
      THEN
        NEW."endpointAssignmentRevision" :=
          OLD."endpointAssignmentRevision" + 1;
      END IF;
    END IF;

    IF NEW."kind"::text = 'MATRIX'
      AND (
        NEW."endpointAssignmentRevision"
        > OLD."endpointAssignmentRevision"
      )
    THEN
      UPDATE "ConversationChannelBinding"
      SET "metadata" =
        COALESCE("metadata", '{}'::jsonb)
        || jsonb_build_object(
          'securityState', 'ISOLATED',
          'isolationReason', 'matrix_identity_reassigned',
          'isolatedAt', CURRENT_TIMESTAMP
        )
      WHERE "representativeBindingId" = OLD."id"
        AND "kind" = 'MATRIX'
        AND "metadata"->>'securityState'
          IS DISTINCT FROM 'ISOLATED';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;

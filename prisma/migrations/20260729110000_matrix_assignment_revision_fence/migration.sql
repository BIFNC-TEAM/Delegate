BEGIN;

ALTER TABLE "RepresentativeChannelBinding"
ADD COLUMN "endpointAssignmentRevision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "ConversationChannelBinding"
ADD COLUMN "representativeAssignmentRevision" INTEGER;

UPDATE "RepresentativeChannelBinding"
SET "endpointAssignmentRevision" = 1
WHERE "kind" IN ('MATRIX', 'TELEGRAM');

UPDATE "ConversationChannelBinding"
SET "metadata" =
  COALESCE("metadata", '{}'::jsonb)
  || jsonb_build_object(
    'securityState', 'ISOLATED',
    'isolationReason', 'matrix_assignment_revision_migration',
    'isolatedAt', CURRENT_TIMESTAMP
  )
WHERE "kind" = 'MATRIX'
  AND "metadata"->>'securityState'
    IS DISTINCT FROM 'ISOLATED';

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

    IF (
        NEW."kind"::text = 'MATRIX'
        AND (
          OLD."kind" IS DISTINCT FROM NEW."kind"
          OR OLD."externalUserId" IS DISTINCT FROM NEW."externalUserId"
          OR OLD."connectionId" IS DISTINCT FROM NEW."connectionId"
          OR (
            OLD."desiredState"::text = 'DISCONNECTED'
            AND NEW."desiredState"::text <> 'DISCONNECTED'
          )
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

CREATE TRIGGER
  "RepresentativeChannelBinding_assignment_revision_trigger"
BEFORE INSERT OR UPDATE ON "RepresentativeChannelBinding"
FOR EACH ROW
EXECUTE FUNCTION "enforce_endpoint_assignment_revision"();

ALTER TABLE "RepresentativeChannelBinding"
ADD CONSTRAINT
  "RepresentativeChannelBinding_assignmentRevision_positive"
CHECK ("endpointAssignmentRevision" > 0);

-- Existing rooms predate the assignment epoch and cannot prove which historic
-- MXID/connection assignment created them (including an A -> B -> A cycle).
-- Their revision stays NULL and their persisted security state is ISOLATED;
-- a fresh direct invite creates a room binding carrying the current revision.
-- Existing Telegram conversations also retain NULL. They predate immutable
-- assignment epochs and therefore fail closed until a fresh inbound message
-- creates an epoch-scoped conversation and binding.

COMMIT;

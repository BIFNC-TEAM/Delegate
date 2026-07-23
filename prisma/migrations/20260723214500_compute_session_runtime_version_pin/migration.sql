-- Pin every new compute session to the published representative version whose
-- authority was evaluated when the session was created. The column remains
-- nullable so legacy rows with ambiguous or missing runtime context fail closed
-- in the broker instead of being assigned a guessed version.
ALTER TABLE "ComputeSession"
ADD COLUMN "representativeVersionId" TEXT;

WITH "sessionVersionCandidates" AS (
  SELECT
    "session"."id",
    "session"."generationRunId" IS NOT NULL AS "expectsRunVersion",
    "session"."delegationTaskId" IS NOT NULL AS "expectsTaskVersion",
    "run"."representativeVersionId" AS "runVersionId",
    "task"."representativeVersionId" AS "taskVersionId",
    COALESCE((
      (
        "session"."contactId" IS NULL
        OR (
          "sessionContact"."id" IS NOT NULL
          AND "sessionContact"."representativeId" = "session"."representativeId"
        )
      )
      AND (
        "session"."conversationId" IS NULL
        OR (
          "sessionConversation"."id" IS NOT NULL
          AND "sessionConversation"."representativeId" = "session"."representativeId"
          AND "sessionConversation"."contactId"
            IS NOT DISTINCT FROM "session"."contactId"
        )
      )
      AND (
        "session"."generationRunId" IS NULL
        OR (
          "run"."id" IS NOT NULL
          AND "run"."representativeVersionId" IS NOT NULL
          AND "run"."conversationId"
            IS NOT DISTINCT FROM "session"."conversationId"
          AND "run"."delegationTaskId"
            IS NOT DISTINCT FROM "session"."delegationTaskId"
          AND "runConversation"."representativeId" = "session"."representativeId"
          AND "runConversation"."contactId"
            IS NOT DISTINCT FROM "session"."contactId"
        )
      )
      AND (
        "session"."delegationTaskId" IS NULL
        OR (
          "task"."id" IS NOT NULL
          AND "task"."representativeVersionId" IS NOT NULL
          AND "task"."representativeId" = "session"."representativeId"
          AND "task"."contactId" IS NOT DISTINCT FROM "session"."contactId"
          AND "task"."originConversationId"
            IS NOT DISTINCT FROM "session"."conversationId"
        )
      )
    ), FALSE) AS "contextIsValid"
  FROM "ComputeSession" AS "session"
  LEFT JOIN "Contact" AS "sessionContact"
    ON "sessionContact"."id" = "session"."contactId"
  LEFT JOIN "Conversation" AS "sessionConversation"
    ON "sessionConversation"."id" = "session"."conversationId"
  LEFT JOIN "GenerationRun" AS "run"
    ON "run"."id" = "session"."generationRunId"
  LEFT JOIN "Conversation" AS "runConversation"
    ON "runConversation"."id" = "run"."conversationId"
  LEFT JOIN "DelegationTask" AS "task"
    ON "task"."id" = "session"."delegationTaskId"
  WHERE
    "session"."generationRunId" IS NOT NULL
    OR "session"."delegationTaskId" IS NOT NULL
)
UPDATE "ComputeSession" AS "session"
SET "representativeVersionId" = CASE
  WHEN
    "candidate"."expectsRunVersion"
    OR "candidate"."expectsTaskVersion"
  THEN CASE
    WHEN
      NOT "candidate"."contextIsValid"
      OR ("candidate"."expectsRunVersion" AND "candidate"."runVersionId" IS NULL)
      OR ("candidate"."expectsTaskVersion" AND "candidate"."taskVersionId" IS NULL)
      OR (
        "candidate"."runVersionId" IS NOT NULL
        AND "candidate"."taskVersionId" IS NOT NULL
        AND "candidate"."runVersionId" <> "candidate"."taskVersionId"
      )
    THEN NULL
    ELSE COALESCE(
      "candidate"."runVersionId",
      "candidate"."taskVersionId"
    )
  END
  ELSE NULL
END
FROM "sessionVersionCandidates" AS "candidate"
WHERE "candidate"."id" = "session"."id";

CREATE INDEX "ComputeSession_representativeVersionId_status_createdAt_idx"
ON "ComputeSession"("representativeVersionId", "status", "createdAt");

ALTER TABLE "ComputeSession"
ADD CONSTRAINT "ComputeSession_representativeVersionId_fkey"
FOREIGN KEY ("representativeVersionId")
REFERENCES "RepresentativeVersion"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

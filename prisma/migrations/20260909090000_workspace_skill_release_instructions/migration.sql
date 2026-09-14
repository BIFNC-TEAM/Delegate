ALTER TABLE "WorkspaceSkillRelease"
  ADD COLUMN "instructions" TEXT,
  ADD COLUMN "instructionsSha256" CHAR(64),
  ADD COLUMN "resources" JSONB;

ALTER TABLE "WorkspaceSkillRelease"
  ADD CONSTRAINT "WorkspaceSkillRelease_instructions_digest_pair_check"
  CHECK (
    ("instructions" IS NULL AND "instructionsSha256" IS NULL)
    OR ("instructions" IS NOT NULL AND "instructionsSha256" IS NOT NULL)
  );

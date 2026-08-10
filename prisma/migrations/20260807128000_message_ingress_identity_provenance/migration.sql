BEGIN;

-- Shared Contact Memory must be able to prove which exact verified account
-- and provider connection admitted an audience message. These references are
-- server-owned ingress provenance; legacy rows remain NULL and fail closed.
ALTER TABLE "Message"
  ADD COLUMN "sourceIdentityLinkId" TEXT,
  ADD COLUMN "sourceIdentityConnectionProofId" TEXT;

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_source_identity_proof_requires_link_check" CHECK (
    "sourceIdentityConnectionProofId" IS NULL
    OR "sourceIdentityLinkId" IS NOT NULL
  );

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_sourceIdentityLinkId_fkey"
  FOREIGN KEY ("sourceIdentityLinkId")
  REFERENCES "IdentityLink"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_sourceIdentityConnectionProofId_fkey"
  FOREIGN KEY ("sourceIdentityConnectionProofId")
  REFERENCES "IdentityLinkConnectionProof"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Message_sourceIdentityLinkId_idx"
  ON "Message"("sourceIdentityLinkId");

CREATE INDEX "Message_sourceIdentityConnectionProofId_idx"
  ON "Message"("sourceIdentityConnectionProofId");

CREATE OR REPLACE FUNCTION "protect_message_ingress_identity_provenance"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."sourceIdentityLinkId"
       IS DISTINCT FROM OLD."sourceIdentityLinkId"
     OR NEW."sourceIdentityConnectionProofId"
       IS DISTINCT FROM OLD."sourceIdentityConnectionProofId" THEN
    RAISE EXCEPTION
      'Message ingress identity provenance is immutable.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Message_ingress_identity_provenance_immutable_guard"
  BEFORE UPDATE OF
    "sourceIdentityLinkId",
    "sourceIdentityConnectionProofId"
  ON "Message"
  FOR EACH ROW
  EXECUTE FUNCTION "protect_message_ingress_identity_provenance"();

COMMIT;

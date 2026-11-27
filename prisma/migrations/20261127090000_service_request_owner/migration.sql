ALTER TABLE "ServiceRequest" ADD COLUMN "ownerId" TEXT;
-- Backfill development rows before restoring the existing immutability trigger.
ALTER TABLE "ServiceRequest" DISABLE TRIGGER "ServiceRequest_guard";
UPDATE "ServiceRequest" s SET "ownerId" = r."ownerId" FROM "Representative" r WHERE r.id = s."representativeId";
ALTER TABLE "ServiceRequest" ENABLE TRIGGER "ServiceRequest_guard";
ALTER TABLE "ServiceRequest" ALTER COLUMN "ownerId" SET NOT NULL;
CREATE INDEX "ServiceRequest_ownerId_createdAt_id_idx" ON "ServiceRequest"("ownerId", "createdAt", id);

CREATE OR REPLACE FUNCTION guard_service_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p "ServiceRequest";
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Service requests cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'pending' OR NEW.status = 'pending' OR
       (to_jsonb(NEW) - ARRAY['status','disabledReason','reply','resolvedAt']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status','disabledReason','reply','resolvedAt']) OR
       OLD.reply IS NOT NULL THEN
      RAISE EXCEPTION 'Service request content and terminal results are immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Conversation" c WHERE c.id = NEW."conversationId"
    AND c."representativeId" = NEW."representativeId" AND c."contactId" = NEW."contactId"
    AND c."audienceIdentityId" IS NOT DISTINCT FROM NEW."audienceIdentityId") OR
     NOT EXISTS (SELECT 1 FROM "RepresentativeVersion" v WHERE v.id = NEW."representativeVersionId" AND v."representativeId" = NEW."representativeId") THEN
    RAISE EXCEPTION 'Service request scope mismatch';
  END IF;
  IF NEW."parentId" IS NULL AND NOT EXISTS (SELECT 1 FROM "Representative" r WHERE r.id = NEW."representativeId" AND r."ownerId" = NEW."ownerId") THEN
    RAISE EXCEPTION 'Service request owner mismatch';
  END IF;
  IF NEW."parentId" IS NOT NULL THEN
    SELECT * INTO STRICT p FROM "ServiceRequest" WHERE id = NEW."parentId";
    IF p."ownerId" <> NEW."ownerId" OR p.status <> 'disabled' OR p."representativeId" <> NEW."representativeId" OR p."conversationId" <> NEW."conversationId"
      OR p."contactId" <> NEW."contactId" OR p."audienceIdentityId" IS DISTINCT FROM NEW."audienceIdentityId" THEN
      RAISE EXCEPTION 'Invalid service request parent';
    END IF;
  END IF;
  RETURN NEW;
END $$;

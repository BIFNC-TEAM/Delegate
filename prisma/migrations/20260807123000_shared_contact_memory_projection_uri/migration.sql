-- Extend the canonical projection-URI guard with the exact immutable
-- CONTACT_SHARED leaf. Do not accept a prefix, caller-selected target, or any
-- URI not derived from the locked namespace and canonical audience identity.

BEGIN;

CREATE OR REPLACE FUNCTION "memory_projection_canonical_uri_guard"()
RETURNS TRIGGER AS $$
DECLARE
  memory_record "GovernedMemory"%ROWTYPE;
  namespace_key TEXT;
  expected_uri TEXT;
BEGIN
  SELECT * INTO memory_record
    FROM "GovernedMemory"
   WHERE "id" = NEW."memoryId"
     AND "representativeId" = NEW."representativeId"
   FOR SHARE;
  SELECT "namespaceKey" INTO namespace_key
    FROM "RepresentativeMemoryPolicy"
   WHERE "representativeId" = NEW."representativeId"
   FOR SHARE;

  IF memory_record."id" IS NULL
     OR namespace_key IS NULL
     OR namespace_key !~ '^[A-Za-z0-9_-]{1,128}$'
     OR NEW."memoryId" !~ '^[A-Za-z0-9_-]{1,128}$'
     OR NEW."memoryVersionId" !~ '^[A-Za-z0-9_-]{1,128}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_canonical_uri_coordinates_check',
      MESSAGE = 'memory projection coordinates cannot form a canonical managed-user URI';
  END IF;

  IF memory_record."scope" = 'CONTACT_CHANNEL'::"MemoryScope" THEN
    IF memory_record."contactId" IS NULL
       OR memory_record."contactId" !~ '^[A-Za-z0-9_-]{1,128}$'
       OR memory_record."sourceChannel" IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryProjectionItem_canonical_uri_coordinates_check',
        MESSAGE = 'contact projection coordinates cannot form a canonical managed-user URI';
    END IF;
    expected_uri :=
      'viking://user/delegate-memory-' || namespace_key
      || '/memories/delegate/' || namespace_key
      || '/contacts/' || memory_record."contactId"
      || '/channels/' || lower(memory_record."sourceChannel"::TEXT)
      || '/memories/' || NEW."memoryId"
      || '/versions/' || NEW."memoryVersionId" || '.md';
  ELSIF memory_record."scope" = 'CONTACT_SHARED'::"MemoryScope" THEN
    IF memory_record."audienceIdentityId" IS NULL
       OR memory_record."audienceIdentityId" !~ '^[A-Za-z0-9_-]{1,128}$'
       OR memory_record."contactId" IS NOT NULL
       OR memory_record."sourceChannel" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryProjectionItem_canonical_uri_coordinates_check',
        MESSAGE = 'shared contact projection coordinates cannot form a canonical managed-user URI';
    END IF;
    expected_uri :=
      'viking://user/delegate-memory-' || namespace_key
      || '/memories/delegate/' || namespace_key
      || '/audience-identities/' || memory_record."audienceIdentityId"
      || '/contact-memory/memories/' || NEW."memoryId"
      || '/versions/' || NEW."memoryVersionId" || '.md';
  ELSIF memory_record."scope" = 'REPRESENTATIVE'::"MemoryScope" THEN
    expected_uri :=
      'viking://user/delegate-memory-' || namespace_key
      || '/memories/delegate/' || namespace_key
      || '/representative-experience/memories/' || NEW."memoryId"
      || '/versions/' || NEW."memoryVersionId" || '.md';
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_canonical_uri_coordinates_check',
      MESSAGE = 'unsupported memory scope cannot form a canonical managed-user URI';
  END IF;

  IF NEW."remoteUri" IS DISTINCT FROM expected_uri
     OR NEW."remoteUri" LIKE 'viking://agent/%'
     OR NEW."remoteUri" LIKE 'viking://user/memories/%' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryProjectionItem_canonical_uri_check',
      MESSAGE = 'projection URI must be the exact immutable managed-user version leaf';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;

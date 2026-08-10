-- Preserve the complete current truth-ledger guard and replace only its
-- CONTACT_MEMORY scope branch. CONTACT_CHANNEL keeps its exact contact/channel
-- rule; CONTACT_SHARED gets a distinct fail-closed canonical identity and
-- current consent rule. Aborting on a source mismatch prevents a future
-- migration-order change from silently removing any existing guard behavior.

BEGIN;

DO $migration$
DECLARE
  guard_definition TEXT;
  old_contact_scope_clause TEXT := $old$
    IF NEW."sourceKind" = 'CONTACT_MEMORY'::"MemoryUseSourceKind"
       AND (
         memory_record."scope" <> 'CONTACT_CHANNEL'::"MemoryScope"
         OR memory_record."contactId" IS DISTINCT FROM run_record."contactId"
         OR memory_record."sourceChannel" IS DISTINCT FROM run_record."sourceChannel"
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'MemoryUseItem_contact_scope_check',
        MESSAGE = 'contact memory use crossed contact or channel scope';
    END IF;
$old$;
  shared_contact_scope_clause TEXT := $new$
    IF NEW."sourceKind" = 'CONTACT_MEMORY'::"MemoryUseSourceKind" THEN
      IF memory_record."scope" = 'CONTACT_CHANNEL'::"MemoryScope" THEN
        IF memory_record."contactId" IS DISTINCT FROM run_record."contactId"
           OR memory_record."sourceChannel" IS DISTINCT FROM run_record."sourceChannel" THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'MemoryUseItem_contact_scope_check',
            MESSAGE = 'contact memory use crossed contact or channel scope';
        END IF;
      ELSIF memory_record."scope" = 'CONTACT_SHARED'::"MemoryScope" THEN
        IF memory_record."contactId" IS NOT NULL
           OR memory_record."sourceChannel" IS NOT NULL
           OR memory_record."audienceIdentityId" IS NULL
           OR version_record."deidentifiedAt" IS NULL
           OR btrim(COALESCE(version_record."deidentificationMethod", '')) = '' THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'MemoryUseItem_shared_contact_scope_check',
            MESSAGE = 'shared contact memory is not canonical and deidentified';
        END IF;

        PERFORM 1
          FROM "Contact" contact_record
          JOIN "AudienceIdentity" identity_record
            ON identity_record."id" = contact_record."audienceIdentityId"
         WHERE contact_record."id" = run_record."contactId"
           AND contact_record."representativeId" = run_record."representativeId"
           AND identity_record."id" = memory_record."audienceIdentityId"
           AND identity_record."status" = 'REGISTERED'::"AudienceIdentityStatus"
           AND identity_record."mergedIntoId" IS NULL
         FOR SHARE OF contact_record, identity_record;
        IF NOT FOUND THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'MemoryUseItem_shared_contact_identity_check',
            MESSAGE = 'shared contact memory crossed canonical audience identity scope';
        END IF;

        PERFORM 1
          FROM "RepresentativeMemoryPolicy" policy_record
          JOIN "ContactMemorySharingConsent" consent
            ON consent."representativeId" = policy_record."representativeId"
           AND consent."audienceIdentityId" = memory_record."audienceIdentityId"
           AND consent."policyRevision" = policy_record."revision"
         WHERE policy_record."representativeId" = run_record."representativeId"
           AND policy_record."longTermMemoryEnabled"
           AND policy_record."contactMemoryEnabled"
           AND policy_record."contactMemoryCrossChannelEnabled"
           AND consent."status" = 'GRANTED'::"ContactMemorySharingConsentStatus"
           AND consent."revokedAt" IS NULL
           AND consent."disclosureContractVersion"
                 = 'cross-channel-contact-memory-v1'
           AND consent."proofHash" ~ '^[0-9a-f]{64}$'
           AND consent."consentVersion" = (
             SELECT MAX(latest_consent."consentVersion")
               FROM "ContactMemorySharingConsent" latest_consent
              WHERE latest_consent."representativeId"
                      = policy_record."representativeId"
                AND latest_consent."audienceIdentityId"
                      = memory_record."audienceIdentityId"
                AND latest_consent."policyRevision" = policy_record."revision"
           )
         FOR SHARE OF policy_record, consent;
        IF NOT FOUND THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'MemoryUseItem_shared_contact_consent_check',
            MESSAGE = 'shared contact memory lacks current policy-bound consent';
        END IF;
      ELSE
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'MemoryUseItem_contact_scope_check',
          MESSAGE = 'contact memory use has an unsupported memory scope';
      END IF;
    END IF;
$new$;
BEGIN
  SELECT pg_get_functiondef('"memory_use_item_scope_guard"()'::regprocedure)
    INTO guard_definition;
  IF guard_definition IS NULL
     OR strpos(guard_definition, old_contact_scope_clause) = 0
     OR strpos(
       substr(
         guard_definition,
         strpos(guard_definition, old_contact_scope_clause)
           + length(old_contact_scope_clause)
       ),
       old_contact_scope_clause
     ) > 0 THEN
    RAISE EXCEPTION
      'Expected exactly one CONTACT_MEMORY scope clause before shared-memory migration.';
  END IF;
  EXECUTE replace(
    guard_definition,
    old_contact_scope_clause,
    shared_contact_scope_clause
  );
END;
$migration$;

COMMIT;

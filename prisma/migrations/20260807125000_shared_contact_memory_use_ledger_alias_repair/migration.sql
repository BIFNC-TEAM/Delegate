-- The 1240 guard preserved an existing PL/pgSQL `policy_record` variable and
-- also used `policy_record` as a SQL table alias inside the new shared-consent
-- query. PostgreSQL resolves that collision only when the branch executes.
-- Repair the installed function forward without changing any authorization
-- predicate or weakening the append-only truth-ledger guard.

BEGIN;

DO $migration$
DECLARE
  guard_definition TEXT;
  ambiguous_policy_query TEXT := $old$
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
$old$;
  unambiguous_policy_query TEXT := $new$
        PERFORM 1
          FROM "RepresentativeMemoryPolicy" shared_policy_record
          JOIN "ContactMemorySharingConsent" shared_consent_record
            ON shared_consent_record."representativeId"
                 = shared_policy_record."representativeId"
           AND shared_consent_record."audienceIdentityId"
                 = memory_record."audienceIdentityId"
           AND shared_consent_record."policyRevision"
                 = shared_policy_record."revision"
         WHERE shared_policy_record."representativeId"
                 = run_record."representativeId"
           AND shared_policy_record."longTermMemoryEnabled"
           AND shared_policy_record."contactMemoryEnabled"
           AND shared_policy_record."contactMemoryCrossChannelEnabled"
           AND shared_consent_record."status"
                 = 'GRANTED'::"ContactMemorySharingConsentStatus"
           AND shared_consent_record."revokedAt" IS NULL
           AND shared_consent_record."disclosureContractVersion"
                 = 'cross-channel-contact-memory-v1'
           AND shared_consent_record."proofHash" ~ '^[0-9a-f]{64}$'
           AND shared_consent_record."consentVersion" = (
             SELECT MAX(latest_shared_consent."consentVersion")
               FROM "ContactMemorySharingConsent" latest_shared_consent
              WHERE latest_shared_consent."representativeId"
                      = shared_policy_record."representativeId"
                AND latest_shared_consent."audienceIdentityId"
                      = memory_record."audienceIdentityId"
                AND latest_shared_consent."policyRevision"
                      = shared_policy_record."revision"
           )
         FOR SHARE OF shared_policy_record, shared_consent_record;
$new$;
BEGIN
  SELECT pg_get_functiondef('"memory_use_item_scope_guard"()'::regprocedure)
    INTO guard_definition;
  IF guard_definition IS NULL
     OR strpos(guard_definition, ambiguous_policy_query) = 0
     OR strpos(
       substr(
         guard_definition,
         strpos(guard_definition, ambiguous_policy_query)
           + length(ambiguous_policy_query)
       ),
       ambiguous_policy_query
     ) > 0 THEN
    RAISE EXCEPTION
      'Expected exactly one ambiguous shared consent policy query before alias repair.';
  END IF;
  EXECUTE replace(
    guard_definition,
    ambiguous_policy_query,
    unambiguous_policy_query
  );
END;
$migration$;

COMMIT;

-- Fail closed for pre-challenge sharing grants and make both disclosure and
-- confirmation provider events globally one-shot. Event hashes are derived
-- from a channel/connection/event namespaced key, so global uniqueness is the
-- narrowest database authority boundary.

BEGIN;

-- Freeze every authority and cleanup writer while the legacy snapshot is
-- classified. Without this lock, a challenge-backed grant could commit after
-- the mixed-authority preflight and have its memory swept as legacy.
LOCK TABLE
  "ContactMemorySharingChallenge",
  "ContactMemorySharingConsent",
  "GovernedMemory",
  "MemoryProjectionItem",
  "MemoryDeletionProof"
IN SHARE ROW EXCLUSIVE MODE;

CREATE UNIQUE INDEX "ContactMemorySharingChallenge_disclosureEventHash_key"
  ON "ContactMemorySharingChallenge"("disclosureEventHash");

CREATE UNIQUE INDEX "ContactMemorySharingConsent_confirmationEventHash_key"
  ON "ContactMemorySharingConsent"("confirmationEventHash");

CREATE TEMPORARY TABLE "_LegacyContactMemorySharingGrant" ON COMMIT DROP AS
SELECT
  consent."id",
  consent."representativeId",
  consent."audienceIdentityId"
FROM "ContactMemorySharingConsent" consent
WHERE consent."status" = 'GRANTED'::"ContactMemorySharingConsentStatus"
  AND (
    consent."challengeId" IS NULL
    OR consent."sourceEvidenceHash" IS NULL
    OR consent."confirmationEventHash" IS NULL
  );

-- A shared memory has no consentId coordinate. If a scope contains both an
-- old grant and a valid challenge-backed grant, there is no sound way to tell
-- which authority created each existing memory. Abort the whole migration so
-- an operator can reconcile that scope explicitly; never revoke the valid
-- grant or guess which memory to delete.
DO $legacy_contact_memory_sharing_mixed_authority_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "_LegacyContactMemorySharingGrant" legacy_grant
    JOIN "ContactMemorySharingConsent" authority_consent
      ON authority_consent."representativeId"
           = legacy_grant."representativeId"
     AND authority_consent."audienceIdentityId"
           = legacy_grant."audienceIdentityId"
     AND authority_consent."id" <> legacy_grant."id"
    JOIN "ContactMemorySharingChallenge" authority_challenge
      ON authority_challenge."id" = authority_consent."challengeId"
    WHERE authority_consent."status"
            = 'GRANTED'::"ContactMemorySharingConsentStatus"
      AND authority_consent."revokedAt" IS NULL
      AND authority_consent."sourceEvidenceHash" ~ '^[0-9a-f]{64}$'
      AND authority_consent."confirmationEventHash" ~ '^[0-9a-f]{64}$'
      AND authority_challenge."representativeId"
            = authority_consent."representativeId"
      AND authority_challenge."audienceIdentityId"
            = authority_consent."audienceIdentityId"
      AND authority_challenge."sourceChannel"
            = authority_consent."sourceChannel"
      AND authority_challenge."policyRevision"
            = authority_consent."policyRevision"
      AND authority_challenge."disclosureContractVersion"
            = authority_consent."disclosureContractVersion"
      AND authority_challenge."sourceEvidenceHash"
            = authority_consent."sourceEvidenceHash"
      AND authority_challenge."consumedAt" IS NOT NULL
      AND authority_challenge."consumedAt"
            <= authority_challenge."expiresAt"
      AND authority_challenge."revokedAt" IS NULL
      AND authority_consent."confirmationEventHash"
            <> authority_challenge."disclosureEventHash"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'ContactMemorySharingConsent_legacy_mixed_authority_preflight',
      MESSAGE = 'legacy and challenge-backed Contact Memory sharing authority coexist in one scope',
      DETAIL = 'Shared memories do not record which consent grant created them, so automatic cleanup would be ambiguous.',
      HINT = 'Reconcile the mixed scope explicitly, then rerun the migration; do not revoke challenge-backed grants or infer memory ownership.';
  END IF;
END;
$legacy_contact_memory_sharing_mixed_authority_preflight$;

CREATE TEMPORARY TABLE "_LegacyContactMemorySharingScope" ON COMMIT DROP AS
SELECT DISTINCT
  legacy_grant."representativeId",
  legacy_grant."audienceIdentityId"
FROM "_LegacyContactMemorySharingGrant" legacy_grant;

UPDATE "ContactMemorySharingConsent" consent
SET
  "status" = 'REVOKED'::"ContactMemorySharingConsentStatus",
  "revokedAt" = COALESCE(consent."revokedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
FROM "_LegacyContactMemorySharingGrant" legacy_grant
WHERE consent."id" = legacy_grant."id"
  AND consent."status" = 'GRANTED'::"ContactMemorySharingConsentStatus";

-- ACTIVE cannot transition directly to DELETE_PENDING. Stop recall first,
-- then enter the ordinary audited deletion lifecycle.
UPDATE "GovernedMemory" memory
SET
  "status" = 'SUPPRESSED'::"GovernedMemoryStatus",
  "recallDisabledAt" = COALESCE(memory."recallDisabledAt", CURRENT_TIMESTAMP),
  "suppressedAt" = COALESCE(memory."suppressedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
FROM "_LegacyContactMemorySharingScope" legacy_scope
WHERE memory."representativeId" = legacy_scope."representativeId"
  AND memory."audienceIdentityId" = legacy_scope."audienceIdentityId"
  AND memory."scope" = 'CONTACT_SHARED'::"MemoryScope"
  AND memory."status" = 'ACTIVE'::"GovernedMemoryStatus";

UPDATE "GovernedMemory" memory
SET
  "status" = 'DELETE_PENDING'::"GovernedMemoryStatus",
  "recallDisabledAt" = COALESCE(memory."recallDisabledAt", CURRENT_TIMESTAMP),
  "deleteRequestedAt" = COALESCE(memory."deleteRequestedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
FROM "_LegacyContactMemorySharingScope" legacy_scope
WHERE memory."representativeId" = legacy_scope."representativeId"
  AND memory."audienceIdentityId" = legacy_scope."audienceIdentityId"
  AND memory."scope" = 'CONTACT_SHARED'::"MemoryScope"
  AND memory."status" IN (
    'SUPPRESSED'::"GovernedMemoryStatus",
    'SUPERSEDED'::"GovernedMemoryStatus",
    'EXPIRED'::"GovernedMemoryStatus",
    'ARCHIVED'::"GovernedMemoryStatus"
  );

UPDATE "MemoryProjectionItem" projection
SET
  "status" = 'DELETE_PENDING'::"MemoryProjectionStatus",
  "deleteRequestedAt" = COALESCE(
    projection."deleteRequestedAt",
    CURRENT_TIMESTAMP
  ),
  "availableAt" = CURRENT_TIMESTAMP,
  "leaseToken" = NULL,
  "leaseExpiresAt" = NULL,
  "lastErrorCode" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "GovernedMemory" memory
JOIN "_LegacyContactMemorySharingScope" legacy_scope
  ON legacy_scope."representativeId" = memory."representativeId"
 AND legacy_scope."audienceIdentityId" = memory."audienceIdentityId"
WHERE projection."memoryId" = memory."id"
  AND memory."scope" = 'CONTACT_SHARED'::"MemoryScope"
  AND memory."status" = 'DELETE_PENDING'::"GovernedMemoryStatus"
  AND projection."status" IN (
    'DISABLED'::"MemoryProjectionStatus",
    'QUEUED'::"MemoryProjectionStatus",
    'PROJECTING'::"MemoryProjectionStatus",
    'RETRYING'::"MemoryProjectionStatus",
    'STAGED'::"MemoryProjectionStatus",
    'ACTIVE'::"MemoryProjectionStatus",
    'SUPERSEDED'::"MemoryProjectionStatus",
    'FAILED'::"MemoryProjectionStatus",
    'DELETE_FAILED'::"MemoryProjectionStatus"
  );

-- The proof contains only immutable identifiers and hashes; it never copies
-- Contact Memory text. The normal cleanup worker completes local/remote purge.
INSERT INTO "MemoryDeletionProof" (
  "id",
  "representativeId",
  "memoryId",
  "requestId",
  "requestedByActorId",
  "reasonCode",
  "contentHash",
  "recallBlockedAt",
  "cleanupStatus",
  "availableAt",
  "createdAt",
  "updatedAt"
)
SELECT
  'legacy-sharing-proof:' || memory."id",
  memory."representativeId",
  memory."id",
  'legacy-sharing-consent:' || memory."id",
  'system:migration:contact-memory-sharing',
  'legacy_contact_memory_sharing_consent_revoked',
  version."contentHash",
  memory."recallDisabledAt",
  'QUEUED'::"MemoryCleanupStatus",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "GovernedMemory" memory
JOIN "GovernedMemoryVersion" version
  ON version."id" = memory."currentVersionId"
 AND version."memoryId" = memory."id"
JOIN "_LegacyContactMemorySharingScope" legacy_scope
  ON legacy_scope."representativeId" = memory."representativeId"
 AND legacy_scope."audienceIdentityId" = memory."audienceIdentityId"
WHERE memory."scope" = 'CONTACT_SHARED'::"MemoryScope"
  AND memory."status" = 'DELETE_PENDING'::"GovernedMemoryStatus"
  AND NOT EXISTS (
    SELECT 1
    FROM "MemoryDeletionProof" existing_proof
    WHERE existing_proof."memoryId" = memory."id"
  );

ALTER TABLE "ContactMemorySharingConsent"
  VALIDATE CONSTRAINT "ContactMemorySharingConsent_challenge_shape_check";

COMMIT;

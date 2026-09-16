-- Atomically remap one verified Logto issuer to another after an operator has
-- proven that both origins serve the same tenant and has captured a restorable
-- backup plus the read-only account-identity preflight report.
--
-- Required psql variables:
--   source_issuer
--   target_issuer
--   expected_owner_count
--   expected_audience_count
--   expected_auth_identity_count
--
-- Example:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v source_issuer='https://old.example.com/oidc' \
--     -v target_issuer='https://new.example.com/oidc' \
--     -v expected_owner_count=10 \
--     -v expected_audience_count=4 \
--     -v expected_auth_identity_count=10 \
--     -f prisma/backfill/logto-issuer-cutover.sql

\set ON_ERROR_STOP on

\if :{?source_issuer}
\else
  \echo 'source_issuer is required.'
  \quit 2
\endif
\if :{?target_issuer}
\else
  \echo 'target_issuer is required.'
  \quit 2
\endif
\if :{?expected_owner_count}
\else
  \echo 'expected_owner_count is required.'
  \quit 2
\endif
\if :{?expected_audience_count}
\else
  \echo 'expected_audience_count is required.'
  \quit 2
\endif
\if :{?expected_auth_identity_count}
\else
  \echo 'expected_auth_identity_count is required.'
  \quit 2
\endif

BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;

SELECT pg_advisory_xact_lock(
  hashtextextended('delegate-logto-issuer-cutover', 0)
);

LOCK TABLE
  "OwnerIdentityLink",
  "IdentityLink",
  "AuthIdentity"
IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE logto_issuer_cutover_parameters (
  source_issuer TEXT NOT NULL,
  target_issuer TEXT NOT NULL,
  expected_owner_count INTEGER NOT NULL CHECK (expected_owner_count >= 0),
  expected_audience_count INTEGER NOT NULL CHECK (expected_audience_count >= 0),
  expected_auth_identity_count INTEGER NOT NULL CHECK (
    expected_auth_identity_count >= 0
  ),
  target_owner_count_before INTEGER NOT NULL DEFAULT 0,
  target_audience_count_before INTEGER NOT NULL DEFAULT 0,
  target_auth_identity_count_before INTEGER NOT NULL DEFAULT 0
) ON COMMIT DROP;

INSERT INTO logto_issuer_cutover_parameters (
  source_issuer,
  target_issuer,
  expected_owner_count,
  expected_audience_count,
  expected_auth_identity_count
)
VALUES (
  :'source_issuer',
  :'target_issuer',
  :'expected_owner_count'::INTEGER,
  :'expected_audience_count'::INTEGER,
  :'expected_auth_identity_count'::INTEGER
);

DO $cutover_preflight$
DECLARE
  parameters logto_issuer_cutover_parameters%ROWTYPE;
  actual_owner_count INTEGER;
  actual_audience_count INTEGER;
  actual_auth_identity_count INTEGER;
BEGIN
  SELECT * INTO STRICT parameters
  FROM logto_issuer_cutover_parameters;

  IF parameters.source_issuer = parameters.target_issuer THEN
    RAISE EXCEPTION 'source_issuer and target_issuer must be different.';
  END IF;
  IF parameters.source_issuer !~ '^https://[^[:space:]]+$'
    OR parameters.target_issuer !~ '^https://[^[:space:]]+$'
  THEN
    RAISE EXCEPTION 'Both issuers must be absolute HTTPS URLs without whitespace.';
  END IF;

  SELECT count(*) INTO actual_owner_count
  FROM "OwnerIdentityLink"
  WHERE "provider" = 'LOGTO'
    AND "issuer" = parameters.source_issuer;

  SELECT count(*) INTO actual_audience_count
  FROM "IdentityLink"
  WHERE "provider" = 'LOGTO'
    AND "issuer" = parameters.source_issuer;

  SELECT count(*) INTO actual_auth_identity_count
  FROM "AuthIdentity"
  WHERE "provider" = 'LOGTO'
    AND "issuer" = parameters.source_issuer;

  IF actual_owner_count <> parameters.expected_owner_count
    OR actual_audience_count <> parameters.expected_audience_count
    OR actual_auth_identity_count <> parameters.expected_auth_identity_count
  THEN
    RAISE EXCEPTION
      'Source counts changed: OwnerIdentityLink %, IdentityLink %, AuthIdentity %.',
      actual_owner_count,
      actual_audience_count,
      actual_auth_identity_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "OwnerIdentityLink" AS source_link
    INNER JOIN "OwnerIdentityLink" AS target_link
      ON target_link."provider" = source_link."provider"
      AND target_link."providerSubject" = source_link."providerSubject"
      AND target_link."issuer" = parameters.target_issuer
    WHERE source_link."provider" = 'LOGTO'
      AND source_link."issuer" = parameters.source_issuer
  ) OR EXISTS (
    SELECT 1
    FROM "IdentityLink" AS source_link
    INNER JOIN "IdentityLink" AS target_link
      ON target_link."provider" = source_link."provider"
      AND target_link."providerSubject" = source_link."providerSubject"
      AND target_link."issuer" = parameters.target_issuer
    WHERE source_link."provider" = 'LOGTO'
      AND source_link."issuer" = parameters.source_issuer
  ) OR EXISTS (
    SELECT 1
    FROM "AuthIdentity" AS source_identity
    INNER JOIN "AuthIdentity" AS target_identity
      ON target_identity."provider" = source_identity."provider"
      AND target_identity."subject" = source_identity."subject"
      AND target_identity."issuer" = parameters.target_issuer
    WHERE source_identity."provider" = 'LOGTO'
      AND source_identity."issuer" = parameters.source_issuer
  ) THEN
    RAISE EXCEPTION 'Target issuer already contains a conflicting principal.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "OwnerIdentityLink"
    WHERE "provider" = 'LOGTO'
      AND "issuer" = parameters.source_issuer
      AND NULLIF(btrim("metadata" ->> 'issuer'), '')
        IS DISTINCT FROM parameters.source_issuer
  ) OR EXISTS (
    SELECT 1
    FROM "IdentityLink"
    WHERE "provider" = 'LOGTO'
      AND "issuer" = parameters.source_issuer
      AND NULLIF(btrim("metadata" ->> 'issuer'), '')
        IS DISTINCT FROM parameters.source_issuer
  ) THEN
    RAISE EXCEPTION 'Stored issuer and verified metadata issuer do not match.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "IdentityLinkConnectionProof"
    WHERE "issuer" = parameters.source_issuer
  ) OR EXISTS (
    SELECT 1
    FROM "IdentityBindingChallenge"
    WHERE "issuer" = parameters.source_issuer
  ) THEN
    RAISE EXCEPTION
      'Dependent identity proof or challenge rows require explicit review.';
  END IF;

  UPDATE logto_issuer_cutover_parameters
  SET
    target_owner_count_before = (
      SELECT count(*)
      FROM "OwnerIdentityLink"
      WHERE "provider" = 'LOGTO'
        AND "issuer" = parameters.target_issuer
    ),
    target_audience_count_before = (
      SELECT count(*)
      FROM "IdentityLink"
      WHERE "provider" = 'LOGTO'
        AND "issuer" = parameters.target_issuer
    ),
    target_auth_identity_count_before = (
      SELECT count(*)
      FROM "AuthIdentity"
      WHERE "provider" = 'LOGTO'
        AND "issuer" = parameters.target_issuer
    );
END
$cutover_preflight$;

UPDATE "OwnerIdentityLink" AS link
SET
  "issuer" = parameters.target_issuer,
  "metadata" = jsonb_set(
    link."metadata",
    '{issuer}',
    to_jsonb(parameters.target_issuer),
    true
  ),
  "updatedAt" = now()
FROM logto_issuer_cutover_parameters AS parameters
WHERE link."provider" = 'LOGTO'
  AND link."issuer" = parameters.source_issuer;

UPDATE "IdentityLink" AS link
SET
  "issuer" = parameters.target_issuer,
  "metadata" = jsonb_set(
    link."metadata",
    '{issuer}',
    to_jsonb(parameters.target_issuer),
    true
  ),
  "updatedAt" = now()
FROM logto_issuer_cutover_parameters AS parameters
WHERE link."provider" = 'LOGTO'
  AND link."issuer" = parameters.source_issuer;

UPDATE "AuthIdentity" AS identity
SET
  "issuer" = parameters.target_issuer,
  "updatedAt" = now()
FROM logto_issuer_cutover_parameters AS parameters
WHERE identity."provider" = 'LOGTO'
  AND identity."issuer" = parameters.source_issuer;

DO $cutover_verify$
DECLARE
  parameters logto_issuer_cutover_parameters%ROWTYPE;
  remaining_source_count INTEGER;
  actual_target_owner_count INTEGER;
  actual_target_audience_count INTEGER;
  actual_target_auth_identity_count INTEGER;
BEGIN
  SELECT * INTO STRICT parameters
  FROM logto_issuer_cutover_parameters;

  SELECT
    (SELECT count(*) FROM "OwnerIdentityLink"
      WHERE "provider" = 'LOGTO'
        AND "issuer" = parameters.source_issuer)
    + (SELECT count(*) FROM "IdentityLink"
      WHERE "provider" = 'LOGTO'
        AND "issuer" = parameters.source_issuer)
    + (SELECT count(*) FROM "AuthIdentity"
      WHERE "provider" = 'LOGTO'
        AND "issuer" = parameters.source_issuer)
  INTO remaining_source_count;

  SELECT count(*) INTO actual_target_owner_count
  FROM "OwnerIdentityLink"
  WHERE "provider" = 'LOGTO'
    AND "issuer" = parameters.target_issuer;

  SELECT count(*) INTO actual_target_audience_count
  FROM "IdentityLink"
  WHERE "provider" = 'LOGTO'
    AND "issuer" = parameters.target_issuer;

  SELECT count(*) INTO actual_target_auth_identity_count
  FROM "AuthIdentity"
  WHERE "provider" = 'LOGTO'
    AND "issuer" = parameters.target_issuer;

  IF remaining_source_count <> 0
    OR actual_target_owner_count <>
      parameters.target_owner_count_before + parameters.expected_owner_count
    OR actual_target_audience_count <>
      parameters.target_audience_count_before + parameters.expected_audience_count
    OR actual_target_auth_identity_count <>
      parameters.target_auth_identity_count_before
        + parameters.expected_auth_identity_count
  THEN
    RAISE EXCEPTION 'Issuer cutover verification failed; transaction will roll back.';
  END IF;
END
$cutover_verify$;

SELECT
  'owner_identity_links_migrated' AS metric,
  expected_owner_count AS value
FROM logto_issuer_cutover_parameters
UNION ALL
SELECT
  'audience_identity_links_migrated',
  expected_audience_count
FROM logto_issuer_cutover_parameters
UNION ALL
SELECT
  'auth_identities_migrated',
  expected_auth_identity_count
FROM logto_issuer_cutover_parameters
ORDER BY metric;

COMMIT;

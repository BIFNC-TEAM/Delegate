-- Bounded, resumable issuer evidence backfill.
--
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v batch_size=500 \
--     -f prisma/backfill/logto-issuer-safe-legacy.sql
--
-- Rerun until both updated counts are zero. Rows without valid HTTP(S)
-- metadata evidence are intentionally untouched and remain preflight blockers.

\if :{?batch_size}
\else
  \set batch_size 500
\endif

WITH candidates AS (
  SELECT
    link."id",
    btrim(link."metadata" ->> 'issuer') AS evidenced_issuer
  FROM "OwnerIdentityLink" AS link
  WHERE link."provider" = 'LOGTO'::"OwnerIdentityLinkProvider"
    AND link."issuer" IS NULL
    AND NULLIF(btrim(link."metadata" ->> 'issuer'), '') IS NOT NULL
    AND btrim(link."metadata" ->> 'issuer') ~ '^https?://[^[:space:]]+$'
  ORDER BY link."id"
  LIMIT :batch_size
  FOR UPDATE SKIP LOCKED
),
updated AS (
  UPDATE "OwnerIdentityLink" AS link
  SET "issuer" = candidate.evidenced_issuer
  FROM candidates AS candidate
  WHERE link."id" = candidate."id"
    AND link."issuer" IS NULL
  RETURNING link."id"
)
SELECT 'owner_identity_links_updated' AS metric, count(*)::bigint AS value
FROM updated;

WITH candidates AS (
  SELECT
    link."id",
    btrim(link."metadata" ->> 'issuer') AS evidenced_issuer
  FROM "IdentityLink" AS link
  WHERE link."provider" = 'LOGTO'::"IdentityLinkProvider"
    AND lower(btrim(link."issuer")) = 'delegate'
    AND NULLIF(btrim(link."metadata" ->> 'issuer'), '') IS NOT NULL
    AND btrim(link."metadata" ->> 'issuer') ~ '^https?://[^[:space:]]+$'
  ORDER BY link."id"
  LIMIT :batch_size
  FOR UPDATE SKIP LOCKED
),
updated AS (
  UPDATE "IdentityLink" AS link
  SET "issuer" = candidate.evidenced_issuer
  FROM candidates AS candidate
  WHERE link."id" = candidate."id"
    AND lower(btrim(link."issuer")) = 'delegate'
  RETURNING link."id"
)
SELECT 'audience_identity_links_updated' AS metric, count(*)::bigint AS value
FROM updated;

-- Expand-only issuer-safe identity support.
--
-- The legacy provider/subject unique indexes intentionally remain in place.
-- They prevent two issuers from using the same subject until the read-only
-- preflight has proven that relaxing those constraints is safe.

ALTER TABLE "OwnerIdentityLink"
ADD COLUMN "issuer" TEXT;

-- Backfill is deliberately outside Prisma migrate deploy. Run the bounded,
-- resumable prisma/backfill/logto-issuer-safe-legacy.sql until both counts are
-- zero before deploying issuer-exact readers.

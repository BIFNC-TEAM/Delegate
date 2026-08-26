-- Preserve the proof-bound browser audience across the platform-scoped
-- Public Representatives AppSession. Existing rows remain nullable during the
-- expand/shadow window; enforce mode rejects an unbound public session and
-- requires a fresh login.
ALTER TABLE "AppSession"
  ADD COLUMN "publicAudienceId" VARCHAR(191);

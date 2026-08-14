-- Distributed admission counters for the public representative chat surface.
-- Scope keys are HMAC digests; raw client addresses and audience identifiers
-- are never persisted in the limiter table.
CREATE TABLE "PublicChatRateLimitBucket" (
  "scopeKey" VARCHAR(64) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "windowStartsAt" TIMESTAMP(3) NOT NULL,
  "windowEndsAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PublicChatRateLimitBucket_pkey" PRIMARY KEY ("scopeKey"),
  CONSTRAINT "PublicChatRateLimitBucket_count_nonnegative" CHECK ("count" >= 0),
  CONSTRAINT "PublicChatRateLimitBucket_window_valid" CHECK ("windowEndsAt" > "windowStartsAt")
);

CREATE INDEX "PublicChatRateLimitBucket_windowEndsAt_idx"
  ON "PublicChatRateLimitBucket"("windowEndsAt");

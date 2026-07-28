CREATE TABLE "TelegramBotRuntimeLease" (
    "telegramBotConnectionId" TEXT NOT NULL,
    "holderId" TEXT NOT NULL,
    "leaseToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL,
    "renewedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramBotRuntimeLease_pkey"
      PRIMARY KEY ("telegramBotConnectionId")
);

CREATE UNIQUE INDEX "TelegramBotRuntimeLease_leaseToken_key"
  ON "TelegramBotRuntimeLease"("leaseToken");

CREATE INDEX "TelegramBotRuntimeLease_expiresAt_idx"
  ON "TelegramBotRuntimeLease"("expiresAt");

CREATE INDEX "TelegramBotRuntimeLease_holderId_expiresAt_idx"
  ON "TelegramBotRuntimeLease"("holderId", "expiresAt");

ALTER TABLE "TelegramBotRuntimeLease"
  ADD CONSTRAINT "TelegramBotRuntimeLease_telegramBotConnectionId_fkey"
  FOREIGN KEY ("telegramBotConnectionId")
  REFERENCES "TelegramBotConnection"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

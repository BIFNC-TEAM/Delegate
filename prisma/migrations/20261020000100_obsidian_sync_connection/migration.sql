CREATE TABLE "ObsidianSyncConnection" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ObsidianSyncConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ObsidianSyncConnection_ownerId_key" ON "ObsidianSyncConnection"("ownerId");
CREATE INDEX "ObsidianSyncConnection_expiresAt_idx" ON "ObsidianSyncConnection"("expiresAt");
ALTER TABLE "ObsidianSyncConnection" ADD CONSTRAINT "ObsidianSyncConnection_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

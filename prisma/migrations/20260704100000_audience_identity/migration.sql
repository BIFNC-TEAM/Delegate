-- CreateEnum
CREATE TYPE "AudienceIdentityStatus" AS ENUM ('ANONYMOUS', 'REGISTERED', 'MERGED', 'DISABLED');

-- CreateEnum
CREATE TYPE "IdentityLinkProvider" AS ENUM ('WEB_ANONYMOUS', 'EMAIL', 'PHONE', 'TELEGRAM', 'PAYMENT_EXTERNAL_USER');

-- CreateTable
CREATE TABLE "AudienceIdentity" (
    "id" TEXT NOT NULL,
    "audienceKey" TEXT NOT NULL,
    "status" "AudienceIdentityStatus" NOT NULL DEFAULT 'ANONYMOUS',
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudienceIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityLink" (
    "id" TEXT NOT NULL,
    "audienceIdentityId" TEXT NOT NULL,
    "provider" "IdentityLinkProvider" NOT NULL,
    "providerSubject" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityLink_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "audienceIdentityId" TEXT,
ADD COLUMN     "channelUserId" TEXT,
ADD COLUMN     "sourceChannel" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "audienceIdentityId" TEXT,
ADD COLUMN     "channelThreadId" TEXT,
ADD COLUMN     "sourceChannel" TEXT;

-- AlterTable
ALTER TABLE "OpenVikingMemoryRecord" ADD COLUMN     "audienceIdentityId" TEXT;

-- AlterTable
ALTER TABLE "SandboxIdentity" ADD COLUMN     "audienceIdentityId" TEXT;

-- AlterTable
ALTER TABLE "UserWallet" ADD COLUMN     "audienceIdentityId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AudienceIdentity_audienceKey_key" ON "AudienceIdentity"("audienceKey");

-- CreateIndex
CREATE INDEX "AudienceIdentity_status_lastSeenAt_idx" ON "AudienceIdentity"("status", "lastSeenAt");

-- CreateIndex
CREATE INDEX "AudienceIdentity_mergedIntoId_idx" ON "AudienceIdentity"("mergedIntoId");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityLink_provider_providerSubject_key" ON "IdentityLink"("provider", "providerSubject");

-- CreateIndex
CREATE INDEX "IdentityLink_audienceIdentityId_provider_idx" ON "IdentityLink"("audienceIdentityId", "provider");

-- CreateIndex
CREATE INDEX "Contact_audienceIdentityId_updatedAt_idx" ON "Contact"("audienceIdentityId", "updatedAt");

-- CreateIndex
CREATE INDEX "Contact_representativeId_sourceChannel_channelUserId_idx" ON "Contact"("representativeId", "sourceChannel", "channelUserId");

-- CreateIndex
CREATE INDEX "Conversation_audienceIdentityId_lastMessageAt_idx" ON "Conversation"("audienceIdentityId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_representativeId_sourceChannel_channelThreadId_idx" ON "Conversation"("representativeId", "sourceChannel", "channelThreadId");

-- CreateIndex
CREATE INDEX "OpenVikingMemoryRecord_audienceIdentityId_createdAt_idx" ON "OpenVikingMemoryRecord"("audienceIdentityId", "createdAt");

-- CreateIndex
CREATE INDEX "SandboxIdentity_audienceIdentityId_updatedAt_idx" ON "SandboxIdentity"("audienceIdentityId", "updatedAt");

-- CreateIndex
CREATE INDEX "UserWallet_audienceIdentityId_updatedAt_idx" ON "UserWallet"("audienceIdentityId", "updatedAt");

-- AddForeignKey
ALTER TABLE "AudienceIdentity" ADD CONSTRAINT "AudienceIdentity_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "AudienceIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityLink" ADD CONSTRAINT "IdentityLink_audienceIdentityId_fkey" FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserWallet" ADD CONSTRAINT "UserWallet_audienceIdentityId_fkey" FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_audienceIdentityId_fkey" FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_audienceIdentityId_fkey" FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxIdentity" ADD CONSTRAINT "SandboxIdentity_audienceIdentityId_fkey" FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenVikingMemoryRecord" ADD CONSTRAINT "OpenVikingMemoryRecord_audienceIdentityId_fkey" FOREIGN KEY ("audienceIdentityId") REFERENCES "AudienceIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

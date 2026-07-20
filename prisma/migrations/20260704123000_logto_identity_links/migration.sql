-- AlterEnum
ALTER TYPE "IdentityLinkProvider" ADD VALUE 'LOGTO';

-- CreateEnum
CREATE TYPE "OwnerIdentityLinkProvider" AS ENUM ('LOGTO', 'EMAIL', 'PHONE', 'TELEGRAM');

-- CreateTable
CREATE TABLE "OwnerIdentityLink" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "provider" "OwnerIdentityLinkProvider" NOT NULL,
    "providerSubject" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerIdentityLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnerIdentityLink_provider_providerSubject_key" ON "OwnerIdentityLink"("provider", "providerSubject");

-- CreateIndex
CREATE INDEX "OwnerIdentityLink_ownerId_provider_idx" ON "OwnerIdentityLink"("ownerId", "provider");

-- AddForeignKey
ALTER TABLE "OwnerIdentityLink" ADD CONSTRAINT "OwnerIdentityLink_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

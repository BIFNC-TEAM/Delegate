-- CreateEnum
CREATE TYPE "SandboxProviderKind" AS ENUM ('DOCKER', 'DAYTONA');

-- CreateEnum
CREATE TYPE "SandboxIdentityStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETED');

-- CreateEnum
CREATE TYPE "SandboxLeaseStatus" AS ENUM ('STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'ERROR', 'ARCHIVED');

-- AlterEnum
ALTER TYPE "EventType" ADD VALUE 'SANDBOX_IDENTITY_CREATED';
ALTER TYPE "EventType" ADD VALUE 'SANDBOX_LEASE_STARTED';
ALTER TYPE "EventType" ADD VALUE 'SANDBOX_LEASE_STOPPED';
ALTER TYPE "EventType" ADD VALUE 'SANDBOX_LEASE_ERRORED';

-- CreateTable
CREATE TABLE "SandboxIdentity" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "provider" "SandboxProviderKind" NOT NULL DEFAULT 'DOCKER',
    "providerIdentityKey" TEXT,
    "status" "SandboxIdentityStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastUsedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SandboxLease" (
    "id" TEXT NOT NULL,
    "sandboxIdentityId" TEXT NOT NULL,
    "provider" "SandboxProviderKind" NOT NULL DEFAULT 'DOCKER',
    "providerSandboxId" TEXT,
    "status" "SandboxLeaseStatus" NOT NULL DEFAULT 'STARTING',
    "runnerLeaseId" TEXT,
    "containerId" TEXT,
    "sessionRoot" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "errorReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxLease_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ComputeSession" ADD COLUMN     "sandboxLeaseId" TEXT;

-- AlterTable
ALTER TABLE "BrowserSession" ADD COLUMN     "sandboxIdentityId" TEXT,
ADD COLUMN     "sandboxLeaseId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SandboxIdentity_representativeId_contactId_key" ON "SandboxIdentity"("representativeId", "contactId");

-- CreateIndex
CREATE INDEX "SandboxIdentity_representativeId_status_updatedAt_idx" ON "SandboxIdentity"("representativeId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "SandboxIdentity_contactId_updatedAt_idx" ON "SandboxIdentity"("contactId", "updatedAt");

-- CreateIndex
CREATE INDEX "SandboxLease_sandboxIdentityId_status_updatedAt_idx" ON "SandboxLease"("sandboxIdentityId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "SandboxLease_provider_status_lastUsedAt_idx" ON "SandboxLease"("provider", "status", "lastUsedAt");

-- CreateIndex
CREATE INDEX "SandboxLease_expiresAt_idx" ON "SandboxLease"("expiresAt");

-- CreateIndex
CREATE INDEX "SandboxLease_providerSandboxId_idx" ON "SandboxLease"("providerSandboxId");

-- CreateIndex
CREATE INDEX "ComputeSession_sandboxLeaseId_createdAt_idx" ON "ComputeSession"("sandboxLeaseId", "createdAt");

-- CreateIndex
CREATE INDEX "BrowserSession_sandboxIdentityId_updatedAt_idx" ON "BrowserSession"("sandboxIdentityId", "updatedAt");

-- CreateIndex
CREATE INDEX "BrowserSession_sandboxLeaseId_updatedAt_idx" ON "BrowserSession"("sandboxLeaseId", "updatedAt");

-- AddForeignKey
ALTER TABLE "SandboxIdentity" ADD CONSTRAINT "SandboxIdentity_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxIdentity" ADD CONSTRAINT "SandboxIdentity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxLease" ADD CONSTRAINT "SandboxLease_sandboxIdentityId_fkey" FOREIGN KEY ("sandboxIdentityId") REFERENCES "SandboxIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputeSession" ADD CONSTRAINT "ComputeSession_sandboxLeaseId_fkey" FOREIGN KEY ("sandboxLeaseId") REFERENCES "SandboxLease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserSession" ADD CONSTRAINT "BrowserSession_sandboxIdentityId_fkey" FOREIGN KEY ("sandboxIdentityId") REFERENCES "SandboxIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserSession" ADD CONSTRAINT "BrowserSession_sandboxLeaseId_fkey" FOREIGN KEY ("sandboxLeaseId") REFERENCES "SandboxLease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TYPE "SandboxProviderKind" ADD VALUE 'TENCENT';

CREATE TYPE "SandboxRuntimeClass" AS ENUM ('CODE', 'BROWSER');
CREATE TYPE "SandboxProviderOperationKind" AS ENUM ('CREATE');
CREATE TYPE "SandboxProviderOperationState" AS ENUM (
  'PENDING',
  'CALLED',
  'BOUND',
  'UNKNOWN',
  'FAILED',
  'QUARANTINED',
  'RESOLVED'
);

ALTER TABLE "Representative"
ADD COLUMN "sandboxTestEligible" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ComputeSession"
ADD COLUMN "runtimeClass" "SandboxRuntimeClass" NOT NULL DEFAULT 'CODE';

ALTER TABLE "SandboxIdentity"
ADD COLUMN "lifecycleEpoch" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "SandboxLease"
ADD COLUMN "runtimeClass" "SandboxRuntimeClass" NOT NULL DEFAULT 'CODE',
ADD COLUMN "identityLifecycleEpoch" INTEGER NOT NULL DEFAULT 1;

UPDATE "ComputeSession" AS session
SET "runtimeClass" = 'BROWSER'
WHERE EXISTS (
  SELECT 1
  FROM "BrowserSession" AS browser
  WHERE browser."computeSessionId" = session.id
);

UPDATE "SandboxLease" AS lease
SET "runtimeClass" = 'BROWSER'
WHERE EXISTS (
  SELECT 1
  FROM "BrowserSession" AS browser
  WHERE browser."sandboxLeaseId" = lease.id
);

CREATE TABLE "SandboxProviderOperation" (
  "id" TEXT NOT NULL,
  "sandboxLeaseId" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "creationKey" VARCHAR(64) NOT NULL,
  "provider" "SandboxProviderKind" NOT NULL,
  "operation" "SandboxProviderOperationKind" NOT NULL DEFAULT 'CREATE',
  "state" "SandboxProviderOperationState" NOT NULL DEFAULT 'PENDING',
  "providerOperationId" TEXT,
  "providerSandboxId" TEXT,
  "ownerTokenHash" VARCHAR(64),
  "ownerLeaseExpiresAt" TIMESTAMP(3),
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "lastErrorCode" TEXT,
  "calledAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SandboxProviderOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SandboxProviderOperation_creationKey_key"
ON "SandboxProviderOperation"("creationKey");

CREATE UNIQUE INDEX "SandboxProviderOperation_sandboxLeaseId_attemptNumber_operation_key"
ON "SandboxProviderOperation"("sandboxLeaseId", "attemptNumber", "operation");

CREATE INDEX "SandboxProviderOperation_state_deadlineAt_idx"
ON "SandboxProviderOperation"("state", "deadlineAt");

CREATE INDEX "SandboxProviderOperation_provider_providerOperationId_idx"
ON "SandboxProviderOperation"("provider", "providerOperationId");

CREATE INDEX "SandboxProviderOperation_ownerLeaseExpiresAt_idx"
ON "SandboxProviderOperation"("ownerLeaseExpiresAt");

ALTER TABLE "SandboxProviderOperation"
ADD CONSTRAINT "SandboxProviderOperation_sandboxLeaseId_fkey"
FOREIGN KEY ("sandboxLeaseId") REFERENCES "SandboxLease"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

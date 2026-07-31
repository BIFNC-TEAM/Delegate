CREATE TYPE "AudienceIdentityStatus" AS ENUM (
  'ANONYMOUS',
  'REGISTERED',
  'MERGED',
  'DISABLED'
);

CREATE TABLE "Owner" (
  "id" TEXT PRIMARY KEY,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "AudienceIdentity" (
  "id" TEXT PRIMARY KEY,
  "status" "AudienceIdentityStatus" NOT NULL DEFAULT 'ANONYMOUS',
  "mergedIntoId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Organization" (
  "id" TEXT PRIMARY KEY
);

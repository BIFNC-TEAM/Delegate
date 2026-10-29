CREATE TABLE "NotionConnection" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "workspaceName" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotionConnection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotionConnection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NotionConnection_ownerId_workspaceId_key" ON "NotionConnection"("ownerId", "workspaceId");
CREATE INDEX "NotionConnection_expiresAt_idx" ON "NotionConnection"("expiresAt");
CREATE TABLE "NotionOAuthState" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "browserHash" TEXT NOT NULL,
  "returnTo" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotionOAuthState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotionOAuthState_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "NotionOAuthState_expiresAt_idx" ON "NotionOAuthState"("expiresAt");

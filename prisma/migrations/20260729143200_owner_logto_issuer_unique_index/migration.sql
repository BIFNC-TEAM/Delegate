CREATE UNIQUE INDEX CONCURRENTLY "OwnerIdentityLink_provider_issuer_providerSubject_key"
  ON "OwnerIdentityLink"("provider", "issuer", "providerSubject")
  WHERE "issuer" IS NOT NULL;

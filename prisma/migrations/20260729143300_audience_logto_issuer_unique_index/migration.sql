CREATE UNIQUE INDEX CONCURRENTLY "IdentityLink_provider_issuer_providerSubject_key"
  ON "IdentityLink"("provider", "issuer", "providerSubject");

CREATE INDEX CONCURRENTLY "OwnerIdentityLink_provider_issuer_providerSubject_idx"
  ON "OwnerIdentityLink"("provider", "issuer", "providerSubject");

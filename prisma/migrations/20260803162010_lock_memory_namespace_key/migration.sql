-- Memory System T2: the server-generated namespace is an opaque URI segment.
-- Reject values that would require normalization so distinct representatives
-- can never collapse onto the same OpenViking recall root.

ALTER TABLE "RepresentativeMemoryPolicy"
  ADD CONSTRAINT "MemoryPolicy_namespace_key_canonical_check"
  CHECK ("namespaceKey" ~ '^[A-Za-z0-9_-]{1,128}$');

CREATE FUNCTION "representative_memory_namespace_key_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."namespaceKey" IS DISTINCT FROM OLD."namespaceKey" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'MemoryPolicy_namespace_key_immutable_check',
      MESSAGE = 'representative memory namespace key is immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RepresentativeMemoryPolicy_namespace_key_guard"
  BEFORE UPDATE ON "RepresentativeMemoryPolicy"
  FOR EACH ROW
  EXECUTE FUNCTION "representative_memory_namespace_key_guard"();

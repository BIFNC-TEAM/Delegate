-- One concurrent hot-table index per migration keeps recovery bounded.
CREATE UNIQUE INDEX CONCURRENTLY "RepresentativeVersion_id_rep_key"
  ON "RepresentativeVersion"("id", "representativeId");

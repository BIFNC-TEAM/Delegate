DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "MatrixVirtualUserBinding"
    WHERE "enabled" = TRUE
      AND "representativeId" IS NOT NULL
    GROUP BY "representativeId", "kind"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Matrix virtual-user migration blocked: multiple active bindings exist for one representative/kind';
  END IF;
END
$$;

CREATE UNIQUE INDEX
  "MatrixVirtualUserBinding_one_active_representative_kind_key"
ON "MatrixVirtualUserBinding" ("representativeId", "kind")
WHERE "enabled" = TRUE
  AND "representativeId" IS NOT NULL;

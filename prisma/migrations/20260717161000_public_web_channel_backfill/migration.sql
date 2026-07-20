INSERT INTO "RepresentativeChannelBinding" (
  "id", "representativeId", "kind", "externalUserId", "status",
  "displayName", "configuration", "createdAt", "updatedAt"
)
SELECT
  'public_web_' || md5(r."id"),
  r."id",
  'WEB'::"RepresentativeChannelKind",
  '/reps/' || r."slug",
  'CONNECTED',
  r."displayName",
  jsonb_build_object('publicMode', true, 'source', 'public_runtime_gate_backfill'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Representative" r
WHERE r."publicMode" = true
  AND r."lifecycleState" = 'PUBLISHED'::"RepresentativeLifecycleState"
  AND r."activeVersionId" IS NOT NULL
ON CONFLICT ("representativeId", "kind") DO NOTHING;

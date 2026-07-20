-- Backfill existing representatives and legacy chat records into the unified
-- conversation platform. All identifiers are deterministic, so this migration
-- is safe to replay in restored development databases.

UPDATE "Contact"
SET "externalUserId" = COALESCE("externalUserId", "channelUserId", "telegramUserId")
WHERE "externalUserId" IS NULL;

UPDATE "Conversation"
SET "externalConversationId" = COALESCE(
  "externalConversationId",
  "channelThreadId",
  "telegramChatId"
)
WHERE "externalConversationId" IS NULL;

INSERT INTO "RepresentativeChannelBinding" (
  "id", "representativeId", "kind", "externalUserId", "status",
  "displayName", "configuration", "createdAt", "updatedAt"
)
SELECT
  'backfill_rep_web_' || md5(r."id"),
  r."id",
  'WEB'::"RepresentativeChannelKind",
  '/reps/' || r."slug",
  'CONNECTED',
  r."displayName",
  jsonb_build_object('publicMode', true, 'source', 'backfill'),
  r."createdAt",
  CURRENT_TIMESTAMP
FROM "Representative" r
WHERE r."publicMode" = true
ON CONFLICT ("representativeId", "kind") DO NOTHING;

INSERT INTO "RepresentativeVersion" (
  "id", "representativeId", "versionNumber", "status", "snapshot",
  "changeSummary", "publishedBy", "publishedAt", "createdAt"
)
SELECT
  'backfill_rep_version_' || md5(r."id"),
  r."id",
  1,
  'PUBLISHED',
  jsonb_build_object(
    'identity', jsonb_build_object(
      'displayName', r."displayName",
      'roleSummary', r."roleSummary",
      'tone', r."tone",
      'avatarUrl', r."avatarUrl",
      'languages', r."languages"
    ),
    'publicMode', r."publicMode",
    'humanInLoop', r."humanInLoop",
    'conversation', jsonb_build_object(
      'freeReplyLimit', r."freeReplyLimit",
      'freeScope', r."freeScope",
      'paywalledIntents', r."paywalledIntents",
      'handoffWindowHours', r."handoffWindowHours",
      'handoffPrompt', r."handoffPrompt"
    ),
    'governance', jsonb_build_object(
      'allowedSkills', r."allowedSkills",
      'actionGate', r."actionGate"
    ),
    'knowledge', CASE WHEN kp."id" IS NULL THEN 'null'::jsonb ELSE jsonb_build_object(
      'identitySummary', kp."identitySummary",
      'faq', kp."faq",
      'materials', kp."materials",
      'policies', kp."policies"
    ) END,
    'pricing', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'type', p."type",
        'name', p."name",
        'starsAmount', p."starsAmount",
        'summary', p."summary",
        'includedReplies', p."includedReplies",
        'includesPriorityHandoff', p."includesPriorityHandoff"
      ) ORDER BY p."createdAt")
      FROM "PricingPlan" p
      WHERE p."representativeId" = r."id"
    ), '[]'::jsonb),
    'skills', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'slug', sp."slug",
        'version', sp."version",
        'enabled', rsp."enabled"
      ) ORDER BY sp."slug")
      FROM "RepresentativeSkillPack" rsp
      JOIN "SkillPack" sp ON sp."id" = rsp."skillPackId"
      WHERE rsp."representativeId" = r."id"
    ), '[]'::jsonb),
    'channels', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'kind', cb."kind",
        'status', cb."status",
        'externalUserId', cb."externalUserId"
      ) ORDER BY cb."kind")
      FROM "RepresentativeChannelBinding" cb
      WHERE cb."representativeId" = r."id"
    ), '[]'::jsonb)
  ),
  'Backfilled from the pre-versioned representative configuration.',
  'system:migration',
  r."updatedAt",
  r."updatedAt"
FROM "Representative" r
LEFT JOIN "KnowledgePack" kp ON kp."representativeId" = r."id"
WHERE r."publicMode" = true
  AND NOT EXISTS (
    SELECT 1 FROM "RepresentativeVersion" rv
    WHERE rv."representativeId" = r."id"
  );

UPDATE "Representative" r
SET
  "activeVersionId" = rv."id",
  "lifecycleState" = 'PUBLISHED'::"RepresentativeLifecycleState"
FROM "RepresentativeVersion" rv
WHERE rv."representativeId" = r."id"
  AND rv."versionNumber" = 1
  AND r."publicMode" = true
  AND r."activeVersionId" IS NULL;

INSERT INTO "ConversationEpisode" (
  "id", "conversationId", "representativeVersionId", "sequence", "status",
  "startedAt", "createdAt", "updatedAt"
)
SELECT
  'backfill_episode_' || md5(c."id"),
  c."id",
  r."activeVersionId",
  1,
  CASE lower(c."state")
    WHEN 'waiting_user' THEN 'WAITING_USER'::"ConversationEpisodeStatus"
    WHEN 'needs_human' THEN 'NEEDS_HUMAN'::"ConversationEpisodeStatus"
    WHEN 'waiting_on_owner' THEN 'NEEDS_HUMAN'::"ConversationEpisodeStatus"
    WHEN 'human_active' THEN 'HUMAN_ACTIVE'::"ConversationEpisodeStatus"
    WHEN 'resolved' THEN 'RESOLVED'::"ConversationEpisodeStatus"
    WHEN 'closed' THEN 'RESOLVED'::"ConversationEpisodeStatus"
    WHEN 'archived' THEN 'ARCHIVED'::"ConversationEpisodeStatus"
    WHEN 'failed' THEN 'FAILED'::"ConversationEpisodeStatus"
    ELSE 'ACTIVE'::"ConversationEpisodeStatus"
  END,
  c."createdAt",
  c."createdAt",
  CURRENT_TIMESTAMP
FROM "Conversation" c
JOIN "Representative" r ON r."id" = c."representativeId"
WHERE NOT EXISTS (
  SELECT 1 FROM "ConversationEpisode" ce
  WHERE ce."conversationId" = c."id"
);

UPDATE "Conversation" c
SET "activeEpisodeId" = ce."id"
FROM "ConversationEpisode" ce
WHERE ce."conversationId" = c."id"
  AND ce."sequence" = 1
  AND c."activeEpisodeId" IS NULL;

INSERT INTO "ConversationChannelBinding" (
  "id", "conversationId", "representativeBindingId", "kind",
  "externalConversationId", "externalThreadId", "metadata", "createdAt", "updatedAt"
)
SELECT
  'backfill_channel_' || md5(c."id"),
  c."id",
  rcb."id",
  CASE lower(COALESCE(c."sourceChannel", 'telegram'))
    WHEN 'web' THEN 'WEB'::"RepresentativeChannelKind"
    WHEN 'matrix' THEN 'MATRIX'::"RepresentativeChannelKind"
    ELSE 'TELEGRAM'::"RepresentativeChannelKind"
  END,
  COALESCE(c."externalConversationId", c."channelThreadId", c."telegramChatId"),
  NULL,
  jsonb_build_object('source', 'backfill'),
  c."createdAt",
  CURRENT_TIMESTAMP
FROM "Conversation" c
LEFT JOIN "RepresentativeChannelBinding" rcb
  ON rcb."representativeId" = c."representativeId"
 AND rcb."kind" = CASE lower(COALESCE(c."sourceChannel", 'telegram'))
   WHEN 'web' THEN 'WEB'::"RepresentativeChannelKind"
   WHEN 'matrix' THEN 'MATRIX'::"RepresentativeChannelKind"
   ELSE 'TELEGRAM'::"RepresentativeChannelKind"
 END
WHERE NOT EXISTS (
  SELECT 1 FROM "ConversationChannelBinding" ccb
  WHERE ccb."conversationId" = c."id"
);

INSERT INTO "ConversationParticipant" (
  "id", "conversationId", "kind", "participantId", "displayName", "joinedAt", "metadata"
)
SELECT
  'backfill_participant_audience_' || md5(c."id"),
  c."id",
  'AUDIENCE'::"ConversationParticipantKind",
  c."contactId",
  ct."displayName",
  c."createdAt",
  jsonb_build_object('source', 'backfill')
FROM "Conversation" c
JOIN "Contact" ct ON ct."id" = c."contactId"
ON CONFLICT ("conversationId", "kind", "participantId") DO NOTHING;

INSERT INTO "ConversationParticipant" (
  "id", "conversationId", "kind", "participantId", "displayName", "joinedAt", "metadata"
)
SELECT
  'backfill_participant_rep_' || md5(c."id"),
  c."id",
  'REPRESENTATIVE'::"ConversationParticipantKind",
  c."representativeId",
  r."displayName",
  c."createdAt",
  jsonb_build_object('source', 'backfill')
FROM "Conversation" c
JOIN "Representative" r ON r."id" = c."representativeId"
ON CONFLICT ("conversationId", "kind", "participantId") DO NOTHING;

INSERT INTO "Message" (
  "id", "conversationId", "episodeId", "channelBindingId", "senderType",
  "senderId", "senderDisplayName", "contentType", "text", "content",
  "deliveryStatus", "retentionExpiresAt", "createdAt", "updatedAt"
)
SELECT
  'backfill_message_' || md5(t."id"),
  t."conversationId",
  c."activeEpisodeId",
  ccb."id",
  CASE WHEN lower(t."direction") = 'inbound'
    THEN 'AUDIENCE'::"MessageSenderType"
    ELSE 'REPRESENTATIVE'::"MessageSenderType"
  END,
  CASE WHEN lower(t."direction") = 'inbound' THEN c."contactId" ELSE c."representativeId" END,
  CASE WHEN lower(t."direction") = 'inbound' THEN ct."displayName" ELSE r."displayName" END,
  'TEXT'::"MessageContentType",
  t."messageText",
  jsonb_strip_nulls(jsonb_build_object('intent', t."intent", 'summary', t."summary", 'source', 'legacy_turn')),
  'SENT'::"MessageDeliveryStatus",
  t."createdAt" + INTERVAL '180 days',
  t."createdAt",
  t."createdAt"
FROM "ConversationTurn" t
JOIN "Conversation" c ON c."id" = t."conversationId"
JOIN "Contact" ct ON ct."id" = c."contactId"
JOIN "Representative" r ON r."id" = c."representativeId"
LEFT JOIN "ConversationChannelBinding" ccb ON ccb."conversationId" = c."id"
WHERE NOT EXISTS (
  SELECT 1 FROM "Message" m
  WHERE m."id" = 'backfill_message_' || md5(t."id")
);

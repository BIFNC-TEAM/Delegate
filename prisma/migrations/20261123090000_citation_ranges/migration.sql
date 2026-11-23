-- CreateTable
CREATE TABLE "EpisodeCitationSource" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "identityScopeHash" VARCHAR(64) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "sourceKey" VARCHAR(64) NOT NULL,
    "sourceKind" VARCHAR(32) NOT NULL,
    "coordinate" JSONB NOT NULL,
    "versionKey" TEXT NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EpisodeCitationSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageCitationRange" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "start" INTEGER NOT NULL,
    "end" INTEGER NOT NULL,
    "bodyHash" VARCHAR(64) NOT NULL,

    CONSTRAINT "MessageCitationRange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageCitationRangeSource" (
    "rangeId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "episodeSourceId" TEXT NOT NULL,
    "acquisition" JSONB NOT NULL,

    CONSTRAINT "MessageCitationRangeSource_pkey" PRIMARY KEY ("rangeId","episodeSourceId")
);

-- CreateIndex
CREATE INDEX "EpisodeCitationSource_representativeId_episodeId_idx" ON "EpisodeCitationSource"("representativeId", "episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeCitationSource_episodeId_ordinal_key" ON "EpisodeCitationSource"("episodeId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeCitationSource_episodeId_sourceKey_key" ON "EpisodeCitationSource"("episodeId", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeCitationSource_id_episodeId_key" ON "EpisodeCitationSource"("id", "episodeId");

-- CreateIndex
CREATE INDEX "MessageCitationRange_messageId_start_idx" ON "MessageCitationRange"("messageId", "start");

-- CreateIndex
CREATE UNIQUE INDEX "MessageCitationRange_messageId_ordinal_key" ON "MessageCitationRange"("messageId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "MessageCitationRange_id_episodeId_key" ON "MessageCitationRange"("id", "episodeId");

-- CreateIndex
CREATE INDEX "MessageCitationRangeSource_episodeSourceId_idx" ON "MessageCitationRangeSource"("episodeSourceId");

-- AddForeignKey
ALTER TABLE "EpisodeCitationSource" ADD CONSTRAINT "EpisodeCitationSource_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "ConversationEpisode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageCitationRange" ADD CONSTRAINT "MessageCitationRange_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageCitationRangeSource" ADD CONSTRAINT "MessageCitationRangeSource_rangeId_episodeId_fkey" FOREIGN KEY ("rangeId", "episodeId") REFERENCES "MessageCitationRange"("id", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageCitationRangeSource" ADD CONSTRAINT "MessageCitationRangeSource_episodeSourceId_episodeId_fkey" FOREIGN KEY ("episodeSourceId", "episodeId") REFERENCES "EpisodeCitationSource"("id", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;


-- Bounds are checked against the final body in the application transaction.
ALTER TABLE "EpisodeCitationSource" ADD CONSTRAINT "EpisodeCitationSource_ordinal_check" CHECK ("ordinal" > 0);
ALTER TABLE "MessageCitationRange" ADD CONSTRAINT "MessageCitationRange_bounds_check" CHECK ("start" >= 0 AND "end" > "start" AND "ordinal" > 0);

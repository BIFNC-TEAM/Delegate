ALTER TABLE "RepresentativeMcpBinding"
ADD COLUMN "configRevision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "healthRequestGeneration" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "lastHealthObservationGeneration" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "lastHealthObservationStartedAt" TIMESTAMP(3);

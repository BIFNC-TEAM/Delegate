-- Manual and shadow memory extraction belonged to the retired human-review
-- console. Keep their rows for audit, but prevent any unfinished durable work
-- from activating memory after the owner disables automatic extraction.
UPDATE "MemoryExtractionRun"
   SET "status" = 'CANCELED'::"MemoryExtractionStatus",
       "leaseToken" = NULL,
       "leaseExpiresAt" = NULL,
       "finishedAt" = COALESCE("finishedAt", CURRENT_TIMESTAMP),
       "errorCode" = 'memory_extraction_trigger_retired',
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "trigger" IN (
       'MANUAL'::"MemoryExtractionTrigger",
       'SHADOW'::"MemoryExtractionTrigger",
       'SCHEDULED'::"MemoryExtractionTrigger"
     )
   AND "status" IN (
       'QUEUED'::"MemoryExtractionStatus",
       'RUNNING'::"MemoryExtractionStatus"
     );

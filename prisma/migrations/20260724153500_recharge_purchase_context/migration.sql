ALTER TABLE "RechargeOrder"
ADD COLUMN "representativeId" TEXT,
ADD COLUMN "productCode" TEXT;

CREATE INDEX "RechargeOrder_representativeId_status_createdAt_idx"
ON "RechargeOrder"("representativeId", "status", "createdAt");

ALTER TABLE "RechargeOrder"
ADD CONSTRAINT "RechargeOrder_representativeId_fkey"
FOREIGN KEY ("representativeId")
REFERENCES "Representative"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

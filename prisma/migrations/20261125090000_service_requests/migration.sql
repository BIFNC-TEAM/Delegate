-- AlterTable
ALTER TABLE "KnowledgePack" ADD COLUMN     "serviceBoundaries" JSONB;

-- CreateTable
CREATE TABLE "ServiceRequest" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "audienceIdentityId" TEXT,
    "representativeVersionId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "ruleIds" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "disabledReason" TEXT,
    "options" JSONB NOT NULL,
    "reply" JSONB,
    "parentId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ServiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequest_parentId_key" ON "ServiceRequest"("parentId");

-- CreateIndex
CREATE INDEX "ServiceRequest_representativeId_status_createdAt_id_idx" ON "ServiceRequest"("representativeId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "ServiceRequest_contactId_createdAt_id_idx" ON "ServiceRequest"("contactId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "ServiceRequest_audienceIdentityId_createdAt_id_idx" ON "ServiceRequest"("audienceIdentityId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequest_conversationId_idempotencyKey_key" ON "ServiceRequest"("conversationId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "ServiceRequest"
  ADD CONSTRAINT "ServiceRequest_direction_check" CHECK (direction IN ('visitor_to_owner','owner_to_visitor')),
  ADD CONSTRAINT "ServiceRequest_status_check" CHECK (status IN ('pending','accepted','rejected','disabled')),
  ADD CONSTRAINT "ServiceRequest_disabled_check" CHECK ((status = 'disabled') = ("disabledReason" IS NOT NULL)),
  ADD CONSTRAINT "ServiceRequest_content_check" CHECK (length(btrim(content)) > 0 AND length(content) <= 8000 AND length(summary) <= 2000),
  ADD CONSTRAINT "ServiceRequest_conversation_fk" FOREIGN KEY ("conversationId") REFERENCES "Conversation"(id) ON DELETE RESTRICT,
  ADD CONSTRAINT "ServiceRequest_version_fk" FOREIGN KEY ("representativeVersionId") REFERENCES "RepresentativeVersion"(id) ON DELETE RESTRICT;

CREATE FUNCTION guard_service_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p "ServiceRequest";
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Service requests cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'pending' OR NEW.status = 'pending' OR
       (to_jsonb(NEW) - ARRAY['status','disabledReason','reply','resolvedAt']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status','disabledReason','reply','resolvedAt']) OR
       OLD.reply IS NOT NULL THEN
      RAISE EXCEPTION 'Service request content and terminal results are immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Conversation" c WHERE c.id = NEW."conversationId"
    AND c."representativeId" = NEW."representativeId" AND c."contactId" = NEW."contactId"
    AND c."audienceIdentityId" IS NOT DISTINCT FROM NEW."audienceIdentityId") OR
     NOT EXISTS (SELECT 1 FROM "RepresentativeVersion" v WHERE v.id = NEW."representativeVersionId" AND v."representativeId" = NEW."representativeId") THEN
    RAISE EXCEPTION 'Service request scope mismatch';
  END IF;
  IF NEW."parentId" IS NOT NULL THEN
    SELECT * INTO STRICT p FROM "ServiceRequest" WHERE id = NEW."parentId";
    IF p.status <> 'disabled' OR p."representativeId" <> NEW."representativeId" OR p."conversationId" <> NEW."conversationId"
      OR p."contactId" <> NEW."contactId" OR p."audienceIdentityId" IS DISTINCT FROM NEW."audienceIdentityId" THEN
      RAISE EXCEPTION 'Invalid service request parent';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ServiceRequest_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceRequest"
  FOR EACH ROW EXECUTE FUNCTION guard_service_request();
-- CreateTable
CREATE TABLE "ServiceRequestNotification" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceRequestNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestNotification_requestId_key" ON "ServiceRequestNotification"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestNotification_messageId_key" ON "ServiceRequestNotification"("messageId");

-- CreateIndex
CREATE INDEX "ServiceRequestNotification_status_availableAt_idx" ON "ServiceRequestNotification"("status", "availableAt");

-- CreateTable
CREATE TABLE "ServiceRequestBatch" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceRequestBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestBatch_messageId_key" ON "ServiceRequestBatch"("messageId");

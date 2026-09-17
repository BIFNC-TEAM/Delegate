-- New representatives should participate in the authorized knowledge runtime
-- unless an owner explicitly disables it. Existing representative choices are
-- intentionally preserved.
ALTER TABLE "Representative"
ALTER COLUMN "openvikingEnabled" SET DEFAULT true;

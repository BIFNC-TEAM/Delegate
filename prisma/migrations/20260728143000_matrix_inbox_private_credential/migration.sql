-- Keep verifier material derived from a private-channel binding command out
-- of the untrusted Matrix event payload. Only Delegate writes this column.
ALTER TABLE "ChannelEventInbox"
ADD COLUMN "privateCredentialHash" CHAR(64);

ALTER TABLE "ChannelEventInbox"
ADD CONSTRAINT "ChannelEventInbox_privateCredentialHash_format"
CHECK (
  "privateCredentialHash" IS NULL
  OR "privateCredentialHash" ~ '^[a-f0-9]{64}$'
);

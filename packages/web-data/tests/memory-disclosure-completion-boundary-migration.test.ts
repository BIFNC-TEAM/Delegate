import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260806260000_private_channel_disclosure_completion_boundary/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("private-channel disclosure completion boundary migration", () => {
  it("uses the conversation-wide audience ingress sequence", () => {
    expect(migration).toContain(
      'message_record."conversationId" = NEW."conversationId"',
    );
    expect(migration).toContain(
      'message_record."senderType" = \'AUDIENCE\'::"MessageSenderType"',
    );
    expect(migration).toContain(
      'message_record."ingressSequence" IS NOT NULL',
    );
    expect(migration).not.toContain(
      'message_record."channelBindingId" = NEW."channelBindingId"',
    );
    expect(migration).toContain(
      'NEW."deliveredAfterIngressSequence"\n           IS DISTINCT FROM OLD."deliveredAfterIngressSequence"',
    );
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260806220000_private_channel_memory_ordering_and_reopen/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("private-channel disclosure ordering and policy reopen migration", () => {
  const exactMessageGuard = functionBlock(
    "memory_private_channel_disclosure_allows",
  );
  const scopeGuard = functionBlock(
    "memory_private_channel_disclosure_scope_allows",
  );
  const reenableGuard = functionBlock(
    "memory_projection_policy_reenable_allowed",
  );

  it("uses a server receive sequence and immutable first-message exclusion proof", () => {
    expect(migration).toContain(
      'CREATE TRIGGER "Message_private_channel_ingress_sequence_guard"',
    );
    expect(migration).toContain(
      "pg_advisory_xact_lock(hashtext(NEW.\"conversationId\"))",
    );
    expect(migration).toContain(
      'NEW."ingressSequence" := next_sequence',
    );
    expect(migration).toContain(
      'CREATE TABLE "MemoryChannelDisclosureActivation"',
    );
    expect(migration).toContain(
      'NEW."firstExcludedIngressSequence"\n          <> disclosure_record."deliveredAfterIngressSequence" + 1',
    );
    expect(exactMessageGuard).toContain(
      'input_message."ingressSequence"\n             > activation."firstExcludedIngressSequence"',
    );
    expect(exactMessageGuard).toContain(
      'activation."firstExcludedIngressSequence"\n             = disclosure."deliveredAfterIngressSequence" + 1',
    );
    expect(exactMessageGuard).not.toContain(
      'disclosure."deliveredAt" < input_message."createdAt"',
    );
  });

  it("requires the current delivered scope before restoring a private projection", () => {
    for (const coordinate of [
      'conversation_record."representativeId" = representative_id',
      'conversation_record."contactId" = contact_id',
      'disclosure."conversationId" = conversation_id',
      'disclosure."sourceChannel" = source_channel',
      'disclosure."policyRevision" = policy_revision',
      'disclosure."disclosureContractVersion" = disclosure_contract_version',
      'disclosure."channelBindingId" = binding."id"',
      'boundary_message."channelBindingId" = binding."id"',
    ]) {
      expect(scopeGuard).toContain(coordinate);
    }
    expect(reenableGuard).toContain(
      '"memory_private_channel_disclosure_scope_allows"(',
    );
    expect(reenableGuard).not.toContain(
      'candidate_record."sourceMessageId",\n          memory_record."sourceChannel"',
    );
    expect(reenableGuard).toContain(
      'candidate_record."sourceContactId" IS NOT DISTINCT FROM memory_record."contactId"',
    );
    expect(reenableGuard).toContain(
      'candidate_record."scopeChannel" IS NOT DISTINCT FROM memory_record."sourceChannel"',
    );
    expect(reenableGuard).toContain('FROM "MemoryDeletionProof"');
  });
});

function functionBlock(functionName: string) {
  const match = migration.match(new RegExp(
    `CREATE OR REPLACE FUNCTION "${functionName}"\\([\\s\\S]*?\\$\\$ LANGUAGE plpgsql(?: STABLE)?;`,
    "u",
  ));
  if (!match) throw new Error(`Missing function ${functionName}`);
  return match[0];
}

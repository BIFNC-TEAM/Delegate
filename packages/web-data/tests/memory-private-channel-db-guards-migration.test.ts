import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260806210000_enable_private_channel_memory/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const automaticRuntimeGuardMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260806120000_automatic_memory_runtime_guard_trust/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const projectionReenableRepairMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260806160000_memory_projection_policy_reenable_guard_repair/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("private-channel governed-memory database guards", () => {
  const disclosureGuard = functionBlock(
    migration,
    "memory_private_channel_disclosure_allows",
  );
  const projectionReenableGuard = functionBlock(
    migration,
    "memory_projection_policy_reenable_allowed",
  );

  it("binds a delivered disclosure to the exact input message and current channel epoch", () => {
    for (const coordinate of [
      'disclosure."representativeId" = representative_id',
      'disclosure."contactId" = contact_id',
      'disclosure."conversationId" = conversation_id',
      'disclosure."channelBindingId" = binding."id"',
      'disclosure."sourceChannel" = source_channel',
      'disclosure."policyRevision" = policy_revision',
      'disclosure."disclosureContractVersion" = disclosure_contract_version',
      'input_message."id" = input_message_id',
      'input_message."conversationId" = conversation_id',
      'binding."conversationId" = input_message."conversationId"',
      'binding."kind" = source_channel',
    ]) {
      expect(disclosureGuard).toContain(coordinate);
    }
    expect(disclosureGuard).toContain(
      'disclosure."representativeAssignmentRevision"\n             IS NOT DISTINCT FROM binding."representativeAssignmentRevision"',
    );
    expect(disclosureGuard).toContain(
      'disclosure."connectionId" IS NOT DISTINCT FROM binding."connectionId"',
    );
    expect(disclosureGuard).toContain(
      'disclosure."status" = \'DELIVERED\'::"MemoryDisclosureDeliveryStatus"',
    );
    expect(disclosureGuard).toContain(
      'disclosure."deliveredAt" < input_message."createdAt"',
    );
    expect(disclosureGuard).toContain(
      'disclosure."proofHash" ~ \'^[0-9a-f]{64}$\'',
    );
    expect(disclosureGuard).toContain(
      '\'MATRIX_MESSAGE\'::"MemoryDisclosureEvidenceKind"',
    );
    expect(disclosureGuard).toContain(
      '\'TELEGRAM_MESSAGE\'::"MemoryDisclosureEvidenceKind"',
    );
  });

  it("changes only the old Web-only injection clause and fails closed on drift", () => {
    const patchBlock = migration.match(
      /DO \$migration\$[\s\S]*?\$migration\$;/u,
    )?.[0];
    expect(patchBlock).toBeTruthy();
    expect(patchBlock).toContain(
      'run_record."sourceChannel" <> \'WEB\'::"RepresentativeChannelKind"',
    );
    expect(patchBlock).toContain(
      'run_record."sourceChannel" NOT IN (',
    );
    expect(patchBlock).toContain(
      'AND NOT policy_record."webRecallEnabled"',
    );
    expect(patchBlock).toContain(
      'NOT policy_record."matrixRecallEnabled"\n             OR NOT "memory_private_channel_disclosure_allows"(',
    );
    expect(patchBlock).toContain(
      'NOT policy_record."telegramRecallEnabled"\n             OR NOT "memory_private_channel_disclosure_allows"(',
    );
    expect(patchBlock).toContain('policy_record."revision"');
    expect(patchBlock).toContain("'private-channel-memory-v1'");
    expect(patchBlock).toContain(
      "Expected exactly one Web-only memory injection clause",
    );
    expect(patchBlock).toContain(
      "EXECUTE replace(guard_definition, web_only_clause, private_channel_clause)",
    );
    expect(patchBlock).not.toContain("DROP TRIGGER");
    expect(patchBlock).not.toContain("DROP FUNCTION");

    const oldClause = patchBlock?.match(
      /web_only_clause TEXT := \$old\$([\s\S]*?)\$old\$;/u,
    )?.[1];
    const newClause = patchBlock?.match(
      /private_channel_clause TEXT := \$new\$([\s\S]*?)\$new\$;/u,
    )?.[1];
    const oldGuard = functionBlock(
      automaticRuntimeGuardMigration,
      "memory_use_item_scope_guard",
    );
    expect(oldClause).toBeTruthy();
    expect(newClause).toBeTruthy();
    expect(oldGuard.split(oldClause!).length - 1).toBe(1);

    const migratedGuard = oldGuard.replace(oldClause!, newClause!);
    expect(migratedGuard.match(
      /run_record\."sourceChannel" <> 'WEB'::"RepresentativeChannelKind"/gu,
    )).toHaveLength(1);
    expect(migratedGuard).toMatch(
      /IF displayed_transition THEN[\s\S]*?run_record\."sourceChannel" <> 'WEB'::"RepresentativeChannelKind"[\s\S]*?MemoryUseItem_display_ack_check/u,
    );
    expect(migratedGuard).toContain(
      'OR NOT "memory_private_channel_disclosure_allows"(',
    );
    expect(constraintNames(migratedGuard)).toEqual(constraintNames(oldGuard));
  });

  it("allows policy re-enable for private Contact Memory only with channel flag and disclosure", () => {
    const previousProjectionGuard = functionBlock(
      projectionReenableRepairMigration,
      "memory_projection_policy_reenable_allowed",
    );
    expect(projectionReenableGuard).toContain(
      'memory_record."sourceChannel" = \'WEB\'::"RepresentativeChannelKind"',
    );
    expect(projectionReenableGuard).toContain(
      'AND policy_record."webRecallEnabled"',
    );
    expect(projectionReenableGuard).toContain(
      'memory_record."sourceChannel" IN (',
    );
    expect(projectionReenableGuard).toContain(
      'AND policy_record."matrixRecallEnabled"',
    );
    expect(projectionReenableGuard).toContain(
      'AND policy_record."telegramRecallEnabled"',
    );
    expect(projectionReenableGuard).toContain(
      'AND "memory_private_channel_disclosure_allows"(',
    );
    for (const sourceCoordinate of [
      'candidate_record."contactId" IS NOT DISTINCT FROM memory_record."contactId"',
      'candidate_record."sourceContactId" IS NOT DISTINCT FROM memory_record."contactId"',
      'candidate_record."scopeChannel" IS NOT DISTINCT FROM memory_record."sourceChannel"',
      'candidate_record."originChannel" IS NOT DISTINCT FROM memory_record."sourceChannel"',
      'candidate_record."sourceConversationId"',
      'candidate_record."sourceMessageId"',
    ]) {
      expect(projectionReenableGuard).toContain(sourceCoordinate);
    }
    for (const invariant of [
      'old_record."lane" = \'RECALL\'::"MemoryProjectionLane"',
      'new_record."provider" = old_record."provider"',
      'new_record."memoryVersionId" = old_record."memoryVersionId"',
      'new_record."contentHash" = old_record."contentHash"',
      'new_record."writeReceiptHash" IS NULL',
      'new_record."deleteReceiptHash" IS NULL',
      'FROM "MemoryDeletionProof"',
      'memory_record."recallDisabledAt" IS NULL',
      'policy_record."provider" = new_record."provider"',
      'policy_record."longTermMemoryEnabled"',
      'policy_record."representativeExperienceEnabled"',
    ]) {
      expect(previousProjectionGuard).toContain(invariant);
      expect(projectionReenableGuard).toContain(invariant);
    }
  });
});

function functionBlock(source: string, functionName: string) {
  const match = source.match(new RegExp(
    `CREATE OR REPLACE FUNCTION "${functionName}"\\([\\s\\S]*?\\$\\$ LANGUAGE plpgsql(?: STABLE)?;`,
    "u",
  ));
  if (!match) throw new Error(`Missing function ${functionName}`);
  return match[0];
}

function constraintNames(source: string) {
  return [...source.matchAll(/CONSTRAINT = '([^']+)'/gu)]
    .map((match) => match[1])
    .sort();
}

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const schema = readFileSync(
  new URL("../../../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260806110000_automatic_memory_policy_foundation/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const sharingConsentMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260807120000_cross_channel_contact_memory_consent_versions/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const sharingDeidentificationMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260807122000_shared_contact_memory_deidentification/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const sharingProjectionUriMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260807123000_shared_contact_memory_projection_uri/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const sharingUseLedgerMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260807124000_shared_contact_memory_use_ledger/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const sharingUseLedgerAliasRepairMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260807125000_shared_contact_memory_use_ledger_alias_repair/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const sharingUseShapeMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260807126000_shared_contact_memory_use_shape/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const sharingChallengeMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260807127000_contact_memory_sharing_one_time_challenge/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const sharingReplayFenceMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260807129000_contact_memory_sharing_replay_and_legacy_fence/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const sharingChallengeAuthorityMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260807130000_shared_contact_memory_challenge_authority_guards/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const sharingExactUseSourceMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260807131000_private_disclosure_v2_and_shared_exact_use_source/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const sharingForwardSecurityMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260807132000_shared_contact_memory_forward_security_repairs/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const extraction = readFileSync(
  new URL("../src/memory-extraction.ts", import.meta.url),
  "utf8",
);
const governance = readFileSync(
  new URL("../src/memory-governance.ts", import.meta.url),
  "utf8",
);

describe("automatic memory policy foundation", () => {
  it("adds automatic policy settings without changing existing behavior defaults", () => {
    const policy = modelBlock("RepresentativeMemoryPolicy");
    expect(policy).toContain("shortTermMemoryEnabled");
    expect(policy).toContain("@default(true)");
    expect(policy).toContain("contactMemoryCrossChannelEnabled");
    expect(policy).toContain("@default(false)");
    expect(migration).toContain(
      '"shortTermMemoryEnabled" BOOLEAN NOT NULL DEFAULT true',
    );
    expect(migration).toContain(
      '"contactMemoryCrossChannelEnabled" BOOLEAN NOT NULL DEFAULT false',
    );
  });

  it("records immutable versioned policy decisions beside legacy review rows", () => {
    const decision = modelBlock("MemoryPolicyDecision");
    for (const field of [
      "policyRevision",
      "policyVersion",
      "extractorVersion",
      "sourceHash",
      "outputHash",
      "confidence",
      "reasonCode",
      "decisionHash",
    ]) {
      expect(decision).toContain(field);
    }
    expect(enumBlock("MemoryPolicyDecisionOutcome")).toMatch(
      /EVIDENCE_RECORDED[\s\S]*ACTIVATED[\s\S]*UPDATED[\s\S]*UNCHANGED[\s\S]*BLOCKED[\s\S]*QUARANTINED[\s\S]*SKIPPED[\s\S]*INVALIDATED/u,
    );
    expect(migration).toContain("MemoryPolicyDecision_append_only_check");
    expect(migration).toContain('FROM "MemoryReviewDecision"');
    expect(migration).toContain('FROM "MemoryPolicyDecision"');
    expect(migration).toContain(
      "active memory requires a human or automatic acceptance decision",
    );
  });

  it("keeps shared contact memory fail-closed behind verified consent", () => {
    expect(enumBlock("MemoryScope")).toContain("CONTACT_SHARED");
    const consent = modelBlock("ContactMemorySharingConsent");
    for (const field of [
      "representativeId",
      "audienceIdentityId",
      "status",
      "grantedAt",
      "revokedAt",
      "policyRevision",
      "consentVersion",
      "disclosureContractVersion",
      "sourceChannel",
      "challengeId",
      "sourceEvidenceHash",
      "confirmationEventHash",
      "proofHash",
    ]) {
      expect(consent).toContain(field);
    }
    expect(consent).toContain(
      '@@unique([representativeId, audienceIdentityId, policyRevision, consentVersion], map: "ContactMemorySharingConsent_rep_identity_revision_version_key")',
    );
    expect(migration).toContain("GovernedMemory_active_shared_consent_check");
    expect(migration).toContain('identity_record."status" = \'REGISTERED\'');
    expect(migration).toContain('identity_link."verifiedAt" IS NOT NULL');
    expect(migration).toContain('identity_link."revokedAt" IS NULL');
    expect(sharingConsentMigration).toContain(
      "ContactMemorySharingConsent_current_grant_key",
    );
    expect(sharingConsentMigration).toContain(
      "GovernedMemory_active_shared_consent_contract_check",
    );
    expect(sharingConsentMigration).toContain(
      "ContactMemorySharingConsent_revocation_fence",
    );
    expect(sharingDeidentificationMigration).toContain(
      '"scope" IN (\'REPRESENTATIVE\', \'CONTACT_SHARED\')',
    );
    expect(sharingDeidentificationMigration).toContain(
      "GovernedMemoryVersion_deidentification_check",
    );
    expect(sharingProjectionUriMigration).toContain(
      'memory_record."scope" = \'CONTACT_SHARED\'::"MemoryScope"',
    );
    expect(sharingProjectionUriMigration).toContain(
      "'/audience-identities/' || memory_record.\"audienceIdentityId\"",
    );
    expect(sharingProjectionUriMigration).toContain(
      'NEW."remoteUri" IS DISTINCT FROM expected_uri',
    );
    expect(sharingProjectionUriMigration).toContain(
      "projection URI must be the exact immutable managed-user version leaf",
    );
    expect(sharingUseLedgerMigration).toContain(
      'memory_record."scope" = \'CONTACT_SHARED\'::"MemoryScope"',
    );
    expect(sharingUseLedgerMigration).toContain(
      'identity_record."id" = memory_record."audienceIdentityId"',
    );
    expect(sharingUseLedgerMigration).toContain(
      'consent."policyRevision" = policy_record."revision"',
    );
    expect(sharingUseLedgerMigration).toContain(
      "'cross-channel-contact-memory-v1'",
    );
    expect(sharingUseLedgerMigration).toContain(
      'consent."proofHash" ~ \'^[0-9a-f]{64}$\'',
    );
    expect(sharingUseLedgerAliasRepairMigration).toContain(
      'FROM "RepresentativeMemoryPolicy" shared_policy_record',
    );
    expect(sharingUseLedgerAliasRepairMigration).toContain(
      'JOIN "ContactMemorySharingConsent" shared_consent_record',
    );
    expect(sharingUseLedgerAliasRepairMigration).toContain(
      "guard_definition,\n    ambiguous_policy_query,\n    unambiguous_policy_query",
    );
    expect(sharingUseShapeMigration).toContain(
      '"memoryScope" IN (\'CONTACT_CHANNEL\', \'CONTACT_SHARED\')',
    );
    expect(sharingUseShapeMigration).toContain(
      '"sourceKind" = \'PUBLIC_KNOWLEDGE\'::"MemoryUseSourceKind"',
    );
    expect(sharingUseShapeMigration).toContain(
      '"sourceKind" = \'REPRESENTATIVE_EXPERIENCE\'::"MemoryUseSourceKind"',
    );
    expect(sharingUseShapeMigration).toContain(
      '"publicKnowledgeProjectionId" IS NULL',
    );
    const challenge = modelBlock("ContactMemorySharingChallenge");
    expect(challenge).toContain("tokenHash");
    expect(challenge).toContain("disclosureEventHash");
    expect(challenge).toContain("consumedAt");
    expect(challenge).toContain("revokedAt");
    expect(challenge).toContain("expiresAt");
    expect(sharingChallengeMigration).toContain(
      "ContactMemorySharingConsent_consumed_challenge_check",
    );
    expect(sharingChallengeMigration).toContain(
      'NEW."confirmationEventHash" = challenge_record."disclosureEventHash"',
    );
    expect(sharingReplayFenceMigration).toContain(
      "ContactMemorySharingChallenge_disclosureEventHash_key",
    );
    expect(sharingReplayFenceMigration).toContain(
      "ContactMemorySharingConsent_confirmationEventHash_key",
    );
    expect(sharingReplayFenceMigration).toContain(
      '"status" = \'REVOKED\'::"ContactMemorySharingConsentStatus"',
    );
    expect(sharingReplayFenceMigration).toContain(
      'memory."scope" = \'CONTACT_SHARED\'::"MemoryScope"',
    );
    expect(sharingReplayFenceMigration).toContain(
      '"status" = \'DELETE_PENDING\'::"MemoryProjectionStatus"',
    );
    expect(sharingReplayFenceMigration).toContain(
      'VALIDATE CONSTRAINT "ContactMemorySharingConsent_challenge_shape_check"',
    );
    expect(sharingChallengeAuthorityMigration).toContain(
      'authority_consent."challengeId" IS NOT NULL',
    );
    expect(sharingChallengeAuthorityMigration).toContain(
      'authority_consent."sourceEvidenceHash" ~ \'^[0-9a-f]{64}$\'',
    );
    expect(sharingChallengeAuthorityMigration).toContain(
      'authority_consent."confirmationEventHash" ~ \'^[0-9a-f]{64}$\'',
    );
    expect(sharingChallengeAuthorityMigration).toContain(
      'authority_challenge."consumedAt" IS NOT NULL',
    );
    expect(sharingChallengeAuthorityMigration).toContain(
      "GovernedMemory_active_shared_challenge_check",
    );
    expect(sharingChallengeAuthorityMigration).toContain(
      "MemoryProjectionItem_shared_challenge_check",
    );
    expect(sharingChallengeAuthorityMigration).toContain(
      "MemoryUseItem_shared_challenge_check",
    );
    expect(sharingExactUseSourceMigration).toContain(
      "Expected exactly two obsolete private-channel disclosure literals",
    );
    expect(sharingExactUseSourceMigration).toContain(
      "private-channel-memory-v2",
    );
    expect(sharingExactUseSourceMigration).toContain(
      "MemoryUseItem_shared_exact_source_check",
    );
    expect(sharingExactUseSourceMigration).toContain(
      'guarded_message."sourceIdentityLinkId"',
    );
    expect(sharingExactUseSourceMigration).toContain(
      'guarded_message."sourceIdentityConnectionProofId"',
    );
    const sourceEventClaim = modelBlock(
      "ContactMemorySharingSourceEventClaim",
    );
    expect(enumBlock("ContactMemorySharingSourceEventRole")).toMatch(
      /DISCLOSURE[\s\S]*CONFIRMATION/u,
    );
    expect(sourceEventClaim).toContain("eventHash");
    expect(sourceEventClaim).toContain("challengeId");
    expect(sourceEventClaim).toContain("consentId");
    expect(sourceEventClaim).toContain(
      '@@unique([challengeId, role], map: "ContactMemorySharingSourceEventClaim_challenge_role_key")',
    );
    expect(sharingForwardSecurityMigration).toContain(
      'PRIMARY KEY ("eventHash")',
    );
    expect(sharingForwardSecurityMigration).toContain(
      'ContactMemorySharingSourceEventClaim_shape_check',
    );
    expect(sharingForwardSecurityMigration).toContain(
      'JOIN "IdentityLinkConnectionProof" exact_proof',
    );
    expect(sharingForwardSecurityMigration).toContain(
      'JOIN "ConversationChannelBinding" exact_binding',
    );
    expect(sharingForwardSecurityMigration).toContain(
      'FOR SHARE OF\n       exact_run,\n       exact_message,\n       exact_link,\n       exact_proof,\n       exact_binding',
    );
    expect(sharingForwardSecurityMigration).toContain(
      'NOT "memory_use_item_authority_advances"(OLD, NEW)',
    );
    expect(sharingForwardSecurityMigration).toContain(
      '"consumedAt" >= "createdAt"',
    );
    expect(sharingForwardSecurityMigration).toContain(
      'NEW."grantedAt" < challenge_record."consumedAt"',
    );
    expect(sharingForwardSecurityMigration).toContain(
      "Expected exactly one obsolete private disclosure literal in memory_projection_policy_reenable_allowed",
    );
    expect(sharingForwardSecurityMigration).toContain(
      "private-channel-memory-v2",
    );
    expect(governance).toContain("closed-structured-contact-shared-v1");
    expect(extraction).toContain("createSharedContactMemoryCandidate");
  });

  it("requires corroborated deidentified representative evidence", () => {
    expect(extraction).toContain("distinctContacts.size < 2");
    expect(extraction).toContain("distinctConversations.size < 2");
    expect(extraction).toContain(
      "recordRepresentativeEvidencePolicyDecisionInTransaction",
    );
    expect(governance).toContain(
      "MemoryPolicyDecisionOutcome.EVIDENCE_RECORDED",
    );
    expect(extraction).toContain(
      "trigger: MemoryExtractionTrigger.CHANNEL_MESSAGE",
    );
    expect(extraction).toContain("memory_extraction_trigger_retired");
    expect(extraction).not.toContain(
      "trigger: { not: MemoryExtractionTrigger.SHADOW }",
    );
  });
});

function modelBlock(name: string) {
  const match = schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`, "u"));
  if (!match) throw new Error(`Missing model ${name}`);
  return match[0];
}

function enumBlock(name: string) {
  const match = schema.match(new RegExp(`enum ${name} \\{[\\s\\S]*?\\n\\}`, "u"));
  if (!match) throw new Error(`Missing enum ${name}`);
  return match[0];
}

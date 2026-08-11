import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const schemaPath = fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url));
const schema = readFileSync(schemaPath, "utf8");
const telegramBotMigration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../prisma/migrations/20260727123000_telegram_bot_connections/migration.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const matrixAssignmentRevisionMigration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../prisma/migrations/20260729110000_matrix_assignment_revision_fence/migration.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const matrixReconnectPreservationMigration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../prisma/migrations/20260807100000_matrix_reconnect_preserve_assignment/migration.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const matrixLifecycleRevisionMigration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../prisma/migrations/20260807110000_matrix_endpoint_lifecycle_revision/migration.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("conversation platform schema", () => {
  it("keeps legacy turns while adding the channel-neutral message model", () => {
    expect(schema).toContain("model ConversationTurn");
    expect(schema).toContain("model Message {");
    expect(schema).toContain("clientMessageId");
    expect(schema).toContain("externalMessageId");
    expect(schema).toContain("model MessageRevision");
    expect(schema).toContain("model MessageCitation");
  });

  it("models long-lived conversations with version-pinned episodes", () => {
    expect(schema).toContain("model ConversationEpisode");
    expect(schema).toContain("representativeVersionId String?");
    expect(schema).toContain("@@unique([conversationId, sequence])");
    expect(schema).toContain("model RepresentativeVersion");
    expect(schema).toContain("model RuntimePolicyOverlay");
  });

  it("adds durable inbox and outbox idempotency boundaries", () => {
    expect(schema).toContain("model ChannelEventInbox");
    expect(schema).toContain(
      "@@unique([kind, connectionId, externalEventId])",
    );
    expect(schema).toContain("model OutboxEvent");
    expect(schema).toMatch(/idempotencyKey\s+String/);
    expect(schema).toContain(
      "@@index([transport, connectionId, status, availableAt])",
    );
    expect(telegramBotMigration).toContain(
      '"ChatSession_legacy_telegramChatId_key"',
    );
    expect(telegramBotMigration).toContain(
      'WHERE "telegramBotConnectionId" IS NULL',
    );
    expect(telegramBotMigration).toContain(
      '"ChannelEventInbox_legacy_kind_externalEventId_key"',
    );
    expect(telegramBotMigration).toContain(
      'WHERE "connectionId" IS NULL',
    );
  });

  it("separates contacts, leads, read state, and internal collaboration", () => {
    expect(schema).toContain("model Lead {");
    expect(schema).toContain("enum LeadStatus");
    expect(schema).toContain("model ConversationReadState");
    expect(schema).toContain("@@unique([conversationId, operatorId])");
    expect(schema).toContain("model ConversationInternalNote");
    expect(schema).toMatch(/episodeId\s+String\?/);
  });

  it("stores Matrix virtual identities without source credentials", () => {
    const block = schema.match(/model MatrixVirtualUserBinding \{[\s\S]*?\n\}/)?.[0] || "";
    expect(block).toContain("matrixUserId");
    expect(block).toContain("representativeId");
    expect(block).toContain("ownerId");
    expect(block).not.toMatch(/password|accessToken|secret/i);
  });

  it("fences private-channel conversations with non-reusable endpoint assignment revisions", () => {
    const representativeBinding = schema.match(
      /model RepresentativeChannelBinding \{[\s\S]*?\n\}/,
    )?.[0] || "";
    const conversationBinding = schema.match(
      /model ConversationChannelBinding \{[\s\S]*?\n\}/,
    )?.[0] || "";
    expect(representativeBinding).toContain(
      "endpointAssignmentRevision Int",
    );
    expect(representativeBinding).toContain(
      "@default(1)",
    );
    expect(conversationBinding).toContain(
      "representativeAssignmentRevision",
    );
    expect(matrixAssignmentRevisionMigration).toContain(
      '"endpointAssignmentRevision"',
    );
    expect(matrixAssignmentRevisionMigration).toContain(
      '"representativeAssignmentRevision"',
    );
    expect(matrixAssignmentRevisionMigration).toContain(
      "enforce_endpoint_assignment_revision",
    );
    expect(matrixAssignmentRevisionMigration).toContain(
      '"telegramBotConnectionId"',
    );
    expect(matrixAssignmentRevisionMigration).toContain(
      "NEW.\"kind\"::text = 'TELEGRAM'",
    );
    expect(matrixAssignmentRevisionMigration).toContain(
      "assignmentRevision_positive",
    );
    expect(matrixAssignmentRevisionMigration).toContain(
      "matrix_assignment_revision_migration",
    );
    expect(matrixAssignmentRevisionMigration).toContain(
      "matrix_identity_reassigned",
    );
    expect(matrixAssignmentRevisionMigration).not.toMatch(
      /SET\s+"representativeAssignmentRevision"/i,
    );
  });

  it("preserves the Matrix assignment epoch across a same-endpoint reconnect", () => {
    const legacyReconnectClampStart =
      matrixReconnectPreservationMigration.indexOf(
        "-- During a rolling deployment",
      );
    const matrixBranchStart = matrixReconnectPreservationMigration.indexOf(
      "IF (\n        NEW.\"kind\"::text = 'MATRIX'",
      legacyReconnectClampStart,
    );
    const telegramBranchStart = matrixReconnectPreservationMigration.indexOf(
      "NEW.\"kind\"::text = 'TELEGRAM'",
      matrixBranchStart,
    );
    const conditionEnd = matrixReconnectPreservationMigration.indexOf(
      "THEN",
      telegramBranchStart,
    );
    const matrixAssignmentBranch = matrixReconnectPreservationMigration.slice(
      matrixBranchStart,
      telegramBranchStart,
    );
    const legacyReconnectClamp = matrixReconnectPreservationMigration.slice(
      legacyReconnectClampStart,
      matrixBranchStart,
    );
    const telegramAssignmentBranch =
      matrixReconnectPreservationMigration.slice(
        telegramBranchStart,
        conditionEnd,
      );

    expect(legacyReconnectClampStart).toBeGreaterThanOrEqual(0);
    expect(matrixBranchStart).toBeGreaterThan(legacyReconnectClampStart);
    expect(telegramBranchStart).toBeGreaterThan(matrixBranchStart);
    expect(conditionEnd).toBeGreaterThan(telegramBranchStart);
    expect(matrixAssignmentBranch).toContain(
      'OLD."externalUserId" IS DISTINCT FROM NEW."externalUserId"',
    );
    expect(matrixAssignmentBranch).toContain(
      'OLD."connectionId" IS DISTINCT FROM NEW."connectionId"',
    );
    expect(matrixAssignmentBranch).not.toContain("DISCONNECTED");
    expect(telegramAssignmentBranch).toContain(
      "OLD.\"desiredState\"::text = 'DISCONNECTED'",
    );
    expect(legacyReconnectClamp).toContain(
      'OLD."externalUserId" IS NOT DISTINCT FROM NEW."externalUserId"',
    );
    expect(legacyReconnectClamp).toContain(
      'OLD."connectionId" IS NOT DISTINCT FROM NEW."connectionId"',
    );
    expect(legacyReconnectClamp).toContain(
      "OLD.\"desiredState\"::text = 'DISCONNECTED'",
    );
    expect(legacyReconnectClamp).toContain(
      '= OLD."endpointAssignmentRevision" + 1',
    );
    expect(legacyReconnectClamp).toContain(
      'OLD."endpointAssignmentRevision";',
    );
  });

  it("separates Matrix endpoint lifecycle epochs from endpoint assignments", () => {
    const representativeBinding = schema.match(
      /model RepresentativeChannelBinding \{[\s\S]*?\n\}/,
    )?.[0] || "";
    const message = schema.match(/model Message \{[\s\S]*?\n\}/)?.[0] || "";

    expect(representativeBinding).toContain(
      "endpointLifecycleRevision  Int",
    );
    expect(representativeBinding).toContain("@default(1)");
    expect(message).toContain("channelLifecycleRevision");
    expect(message).toMatch(/channelLifecycleRevision\s+Int\?/);
    expect(matrixLifecycleRevisionMigration).toContain(
      'ADD COLUMN "endpointLifecycleRevision" INTEGER NOT NULL DEFAULT 1',
    );
    expect(matrixLifecycleRevisionMigration).toContain(
      'ADD COLUMN "channelLifecycleRevision" INTEGER',
    );
    expect(matrixLifecycleRevisionMigration).not.toMatch(
      /UPDATE\s+"Message"/i,
    );
    expect(matrixLifecycleRevisionMigration).toContain(
      "enforce_matrix_endpoint_lifecycle_revision",
    );
    expect(matrixLifecycleRevisionMigration).toContain(
      "OLD.\"desiredState\" IS DISTINCT FROM NEW.\"desiredState\"",
    );
    expect(matrixLifecycleRevisionMigration).toContain(
      'OLD."endpointLifecycleRevision" + 1',
    );
  });
});

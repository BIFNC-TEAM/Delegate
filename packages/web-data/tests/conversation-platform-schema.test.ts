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
    expect(schema).toContain("episodeId              String?");
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
});

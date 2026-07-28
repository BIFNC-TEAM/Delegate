import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const schemaPath = fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url));
const schema = readFileSync(schemaPath, "utf8");

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
    expect(schema).toContain("@@unique([kind, externalEventId])");
    expect(schema).toContain("model OutboxEvent");
    expect(schema).toMatch(/idempotencyKey\s+String/);
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
});

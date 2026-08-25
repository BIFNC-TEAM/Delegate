import { createHash } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  conversationFindFirst: vi.fn(),
  messageAttachmentFindFirst: vi.fn(),
  readArtifactObject: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: {
    conversation: { findFirst: mocks.conversationFindFirst },
    messageAttachment: { findFirst: mocks.messageAttachmentFindFirst },
  },
}));
vi.mock("../src/artifact-store", () => ({
  readArtifactObject: mocks.readArtifactObject,
}));

import {
  getConversationDetailSnapshot,
  getOwnerConversationAttachmentDownload,
} from "../src/conversation-platform";

const originalDatabaseUrl = process.env.DATABASE_URL;

describe("Owner Inbox conversation attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgresql://delegate.invalid/delegate";
    mocks.conversationFindFirst.mockResolvedValue({
      id: "conversation-1",
      state: "HUMAN_ACTIVE",
      sourceChannel: "web",
      contact: {
        id: "contact-1",
        displayName: "Visitor",
        username: null,
        stage: "QUALIFIED",
        role: "OTHER",
        isPaid: false,
      },
      representative: {
        slug: "representative",
        displayName: "Representative",
      },
      episodes: [],
      assignments: [],
      messages: [{
        id: "message-1",
        senderType: "AUDIENCE",
        senderDisplayName: "Visitor",
        text: "请查看附件",
        deliveryStatus: "SENT",
        editedAt: null,
        redactedAt: null,
        createdAt: new Date("2026-08-17T02:00:00.000Z"),
        citations: [],
        attachments: [{
          id: "attachment-1",
          fileName: "需求说明.pdf",
          mimeType: "application/pdf",
          sizeBytes: 5,
          objectKey: "conversation-inputs/attachment-1",
          externalUrl: null,
        }],
      }],
      turns: [],
      generationRuns: [],
      delegationTasks: [],
      internalNotes: [],
    });
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("returns attachment metadata and an Owner-scoped download URL without object keys", async () => {
    const detail = await getConversationDetailSnapshot(
      "representative",
      "conversation-1",
      "owner-1",
    );

    expect(detail?.messages[0]?.attachments).toEqual([{
      id: "attachment-1",
      fileName: "需求说明.pdf",
      mimeType: "application/pdf",
      sizeBytes: 5,
      downloadUrl:
        "/api/dashboard/representatives/representative/conversations/conversation-1/attachments/attachment-1",
    }]);
    expect(JSON.stringify(detail)).not.toContain("conversation-inputs/");
    expect(
      mocks.conversationFindFirst.mock.calls[0]?.[0]?.include?.messages?.include,
    ).toHaveProperty("attachments");
  });

  it("revalidates owner scope, size, and checksum before returning bytes", async () => {
    const body = Buffer.from("hello");
    mocks.messageAttachmentFindFirst.mockResolvedValue({
      fileName: "需求\n说明.pdf",
      mimeType: "application/pdf",
      sizeBytes: body.byteLength,
      objectKey: "conversation-inputs/attachment-1",
      checksum: createHash("sha256").update(body).digest("hex"),
    });
    mocks.readArtifactObject.mockResolvedValue({
      buffer: body,
      contentType: "application/pdf",
    });

    const download = await getOwnerConversationAttachmentDownload({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      attachmentId: "attachment-1",
      ownerId: "owner-1",
    });

    expect(download).toMatchObject({
      buffer: body,
      fileName: "需求_说明.pdf",
      mimeType: "application/pdf",
    });
    expect(mocks.messageAttachmentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "attachment-1",
          message: expect.objectContaining({
            conversationId: "conversation-1",
            conversation: {
              representative: {
                slug: "representative",
                ownerId: "owner-1",
              },
            },
          }),
        }),
      }),
    );
  });
});

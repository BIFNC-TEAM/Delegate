import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  createLedger: vi.fn(),
  transaction: vi.fn(),
  readArtifactObject: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: {
    artifact: {
      findFirst: mocks.findFirst,
      update: mocks.update,
    },
    ledgerEntry: { create: mocks.createLedger },
    $transaction: mocks.transaction,
  },
}));

vi.mock("../src/artifact-store", () => ({
  readArtifactObject: mocks.readArtifactObject,
}));

import { getPublicConversationArtifactDownload } from "../src/public-compute-artifacts";

describe("public compute artifact downloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockResolvedValue([]);
  });

  it("requires the representative and signed conversation audience to match", async () => {
    mocks.findFirst.mockResolvedValue(null);

    await expect(getPublicConversationArtifactDownload({
      representativeSlug: "sktone",
      artifactId: "artifact-1",
      audienceIdentityId: "identity-1",
    })).resolves.toBeNull();

    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "artifact-1",
        representative: { slug: "sktone" },
        conversation: { audienceIdentityId: "identity-1" },
      }),
    }));
    expect(mocks.readArtifactObject).not.toHaveBeenCalled();
  });

  it("returns the stored file and records download egress", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "artifact-1",
      representativeId: "rep-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      sessionId: "session-1",
      toolExecutionId: "execution-1",
      objectKey: "objects/file",
      mimeType: "text/plain; charset=utf-8",
      kind: "FILE",
      toolExecution: { requestedPath: "/workspace/notes/result.txt" },
    });
    mocks.readArtifactObject.mockResolvedValue({ buffer: Buffer.from("hello") });

    await expect(getPublicConversationArtifactDownload({
      representativeSlug: "sktone",
      artifactId: "artifact-1",
      audienceIdentityId: "identity-1",
    })).resolves.toMatchObject({
      mimeType: "text/plain; charset=utf-8",
      fileName: "result.txt",
      buffer: Buffer.from("hello"),
    });

    expect(mocks.readArtifactObject).toHaveBeenCalledWith("objects/file");
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "artifact-1" },
      data: expect.objectContaining({ downloadCount: { increment: 1 } }),
    }));
    expect(mocks.createLedger).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kind: "ARTIFACT_EGRESS",
        quantity: 5,
        conversationId: "conversation-1",
      }),
    }));
  });
});

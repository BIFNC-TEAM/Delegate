import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => {
  const prismaMock = {
    browserSession: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    browserNavigation: {
      upsert: vi.fn(),
    },
    eventAudit: {
      create: vi.fn(),
    },
  };

  return { mockPrisma: prismaMock };
});

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

describe("recordBrowserNavigation sandbox persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.browserSession.findFirst.mockResolvedValue({
      status: "ACTIVE",
      currentUrl: "https://previous.example/",
      currentTitle: "Previous",
      failureReason: null,
    });
    mockPrisma.browserSession.upsert.mockResolvedValue({
      id: "browser-session-2",
      representativeId: "rep-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      computeSessionId: "session-2",
      sandboxIdentityId: "identity-1",
      sandboxLeaseId: "lease-2",
    });
    mockPrisma.browserNavigation.upsert.mockResolvedValue({ id: "navigation-2" });
    mockPrisma.eventAudit.create.mockResolvedValue({ id: "event-1" });
  });

  it("uses the latest sandbox identity browser state when the new navigation fails early", async () => {
    const { recordBrowserNavigation } = await import("../src/browser-sessions");

    await recordBrowserNavigation({
      representativeId: "rep-1",
      representativeSlug: "rep",
      contactId: "contact-1",
      conversationId: "conversation-1",
      computeSessionId: "session-2",
      sandboxIdentityId: "identity-1",
      sandboxLeaseId: "lease-2",
      toolExecutionId: "execution-2",
      transportKind: "playwright",
      requestedUrl: "https://broken.example/",
      errorMessage: "timeout",
      status: "failed",
    });

    expect(mockPrisma.browserSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { sandboxIdentityId: "identity-1" },
      orderBy: [{ updatedAt: "desc" }],
    }));
    expect(mockPrisma.browserSession.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        sandboxIdentityId: "identity-1",
        sandboxLeaseId: "lease-2",
        currentUrl: "https://previous.example/",
      }),
    }));
    expect(mockPrisma.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          sandboxIdentityId: "identity-1",
          sandboxLeaseId: "lease-2",
        }),
      }),
    });
  });
});

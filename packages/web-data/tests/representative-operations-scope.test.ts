import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findConversationDetail: vi.fn(),
  findDirectoryItems: vi.fn(),
  findLocalOwner: vi.fn(),
  findRepresentativeOperations: vi.fn(),
  findRepresentativeSetup: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: {
    owner: {
      findFirst: mocks.findLocalOwner,
    },
    representative: {
      findFirst: mocks.findRepresentativeOperations,
      findUnique: mocks.findRepresentativeSetup,
      findMany: mocks.findDirectoryItems,
    },
    conversation: {
      findFirst: mocks.findConversationDetail,
    },
  },
}));

import {
  getConversationDetailSnapshot,
  getRepresentativeOperationsSnapshot,
  listConversationInboxSnapshot,
} from "../src/conversation-platform";
import {
  getRepresentativeRuntimeSetupSnapshot,
  listRepresentativeDirectoryItems,
} from "../src/representative-setup";

const originalDatabaseUrl = process.env.DATABASE_URL;

describe("owner-scoped representative dashboard reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgresql://delegate.invalid/delegate";
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("includes ownerId in the representative operations lookup", async () => {
    mocks.findRepresentativeOperations.mockResolvedValueOnce(null);

    await expect(
      getRepresentativeOperationsSnapshot({
        representativeSlug: "owner-a-representative",
        ownerId: "owner-a",
      }),
    ).resolves.toBeNull();

    expect(mocks.findRepresentativeOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          slug: "owner-a-representative",
          ownerId: "owner-a",
        },
        include: expect.objectContaining({
          owner: {
            select: {
              timezone: true,
            },
          },
        }),
      }),
    );
  });

  it("keeps inbox and conversation-detail lookups constrained to the explicit owner", async () => {
    mocks.findRepresentativeOperations.mockResolvedValueOnce(null);
    mocks.findConversationDetail.mockResolvedValueOnce(null);

    await expect(
      listConversationInboxSnapshot(
        "owner-a-representative",
        "owner-a",
        "owner-a",
      ),
    ).resolves.toBeNull();
    await expect(
      getConversationDetailSnapshot(
        "owner-a-representative",
        "conversation-1",
        "owner-a",
      ),
    ).resolves.toBeNull();

    expect(mocks.findRepresentativeOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          slug: "owner-a-representative",
          ownerId: "owner-a",
        },
      }),
    );
    expect(mocks.findConversationDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "conversation-1",
          representative: {
            slug: "owner-a-representative",
            ownerId: "owner-a",
          },
        },
      }),
    );
  });

  it("keeps the representative directory constrained to the explicit owner", async () => {
    mocks.findDirectoryItems.mockResolvedValueOnce([]);

    await expect(
      listRepresentativeDirectoryItems("owner-a"),
    ).resolves.toEqual([]);

    expect(mocks.findDirectoryItems).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: "owner-a" },
        include: expect.objectContaining({
          owner: {
            select: {
              displayName: true,
            },
          },
        }),
      }),
    );
    expect(mocks.findLocalOwner).not.toHaveBeenCalled();
  });

  it("selects only the Owner field used by public representative runtime reads", async () => {
    mocks.findRepresentativeSetup.mockResolvedValueOnce(null);

    await expect(
      getRepresentativeRuntimeSetupSnapshot("owner-a-representative"),
    ).resolves.toBeNull();

    expect(mocks.findRepresentativeSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: "owner-a-representative" },
        include: expect.objectContaining({
          owner: {
            select: {
              displayName: true,
            },
          },
        }),
      }),
    );
  });

  it("fails closed instead of serving demo data to an authenticated owner", async () => {
    delete process.env.DATABASE_URL;

    await expect(
      getRepresentativeOperationsSnapshot({
        representativeSlug: "lin-founder-rep",
        ownerId: "owner-a",
      }),
    ).rejects.toThrow("Representative operations are temporarily unavailable.");
    await expect(
      listRepresentativeDirectoryItems("owner-a"),
    ).rejects.toThrow("Representative directory is temporarily unavailable.");
    await expect(
      listConversationInboxSnapshot("lin-founder-rep", "owner-a", "owner-a"),
    ).rejects.toThrow("Conversation inbox is temporarily unavailable.");
    await expect(
      getConversationDetailSnapshot(
        "lin-founder-rep",
        "conversation-1",
        "owner-a",
      ),
    ).rejects.toThrow("Conversation detail is temporarily unavailable.");
  });

  it("does not fall back to demo operations when the scoped database lookup fails", async () => {
    mocks.findRepresentativeOperations.mockRejectedValueOnce(
      new Error("P1001: Can't reach database server"),
    );

    await expect(
      getRepresentativeOperationsSnapshot({
        representativeSlug: "owner-a-representative",
        ownerId: "owner-a",
      }),
    ).rejects.toThrow("Representative operations are temporarily unavailable.");
  });
});

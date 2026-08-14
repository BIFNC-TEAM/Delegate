import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  readKnowledgeSource: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: {
    knowledgeAsset: {
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
    },
  },
}));

vi.mock("../src/knowledge-storage", () => ({
  readKnowledgeSource: mocks.readKnowledgeSource,
}));

import {
  resolveGovernedPublicMaterialDeliveries,
  resolveGovernedPublicMaterialDownload,
} from "../src/public-material-delivery";

const issuedAt = new Date("2026-08-14T08:00:00.000Z");

describe("governed public material delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DATABASE_URL", "postgresql://test");
    vi.stubEnv("PUBLIC_MATERIAL_LINK_SECRET", "public-material-test-secret");
    vi.stubEnv("NEXT_PUBLIC_REPRESENTATIVE_URL", "https://reps.example.test");
    mocks.findMany.mockResolvedValue([{
      id: "asset-1",
      title: "公开指南",
      summary: "服务与交付说明",
      checksum: "sha256-v1",
      sourceObjectChecksum: null,
      processingVersion: 4,
      tags: ["服务"],
      autoTags: ["指南"],
      updatedAt: issuedAt,
    }]);
    mocks.findFirst.mockResolvedValue({
      title: "公开指南",
      originalFileName: "guide.pdf",
      mimeType: "application/pdf",
      sourceUrl: "https://cdn.example.test/guide.pdf",
      sourceObjectBucket: null,
      sourceObjectKey: null,
      sourceObjectChecksum: null,
      checksum: "sha256-v1",
      processingVersion: 4,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("issues a short-lived version-bound link and rechecks publication on download", async () => {
    const [delivery] = await resolveGovernedPublicMaterialDeliveries({
      representativeId: "rep-1",
      representativeSlug: "demo",
      queryText: "请发服务指南",
      now: issuedAt,
    });

    expect(delivery?.url).toMatch(
      /^https:\/\/reps\.example\.test\/reps\/demo\/materials\/asset-1\/download\?token=/,
    );
    const token = new URL(delivery!.url, "https://delegate.test")
      .searchParams.get("token")!;
    await expect(resolveGovernedPublicMaterialDownload({
      representativeSlug: "demo",
      assetId: "asset-1",
      token,
      now: new Date("2026-08-14T08:05:00.000Z"),
    })).resolves.toEqual({
      kind: "redirect",
      url: "https://cdn.example.test/guide.pdf",
      fileName: "guide.pdf",
      processingVersion: 4,
    });
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "asset-1",
        processingVersion: 4,
        representativeLinks: expect.any(Object),
      }),
    }));
  });

  it("rejects expired links before querying the asset", async () => {
    const [delivery] = await resolveGovernedPublicMaterialDeliveries({
      representativeId: "rep-1",
      representativeSlug: "demo",
      queryText: "指南",
      now: issuedAt,
    });
    const token = new URL(delivery!.url, "https://delegate.test")
      .searchParams.get("token")!;

    await expect(resolveGovernedPublicMaterialDownload({
      representativeSlug: "demo",
      assetId: "asset-1",
      token,
      now: new Date("2026-08-14T08:11:00.000Z"),
    })).rejects.toMatchObject({ statusCode: 410 });
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("invalidates an issued link when the published content checksum changes", async () => {
    const [delivery] = await resolveGovernedPublicMaterialDeliveries({
      representativeId: "rep-1",
      representativeSlug: "demo",
      queryText: "指南",
      now: issuedAt,
    });
    const token = new URL(delivery!.url, "https://delegate.test")
      .searchParams.get("token")!;
    mocks.findFirst.mockResolvedValueOnce({
      title: "公开指南",
      originalFileName: "guide.pdf",
      mimeType: "application/pdf",
      sourceUrl: "https://cdn.example.test/guide.pdf",
      sourceObjectBucket: null,
      sourceObjectKey: null,
      sourceObjectChecksum: null,
      checksum: "sha256-v2",
      processingVersion: 4,
    });

    await expect(resolveGovernedPublicMaterialDownload({
      representativeSlug: "demo",
      assetId: "asset-1",
      token,
      now: new Date("2026-08-14T08:05:00.000Z"),
    })).rejects.toMatchObject({ statusCode: 410 });
  });
});

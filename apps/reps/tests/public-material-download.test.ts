import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveGovernedPublicMaterialDownload: vi.fn(),
  PublicMaterialAccessError: class PublicMaterialAccessError extends Error {
    constructor(
      message: string,
      readonly statusCode: 403 | 404 | 410,
    ) {
      super(message);
    }
  },
}));

vi.mock("@delegate/web-data", () => ({
  PublicMaterialAccessError: mocks.PublicMaterialAccessError,
  resolveGovernedPublicMaterialDownload:
    mocks.resolveGovernedPublicMaterialDownload,
}));

import { GET } from "../app/reps/[slug]/materials/[assetId]/download/route";

describe("governed public material downloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires a signed token before resolving an asset", async () => {
    const response = await GET(
      new Request("https://delegate.test/reps/demo/materials/asset-1/download"),
      { params: Promise.resolve({ slug: "demo", assetId: "asset-1" }) },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.resolveGovernedPublicMaterialDownload).not.toHaveBeenCalled();
  });

  it("returns governed bytes with download and version headers", async () => {
    mocks.resolveGovernedPublicMaterialDownload.mockResolvedValue({
      kind: "bytes",
      bytes: new TextEncoder().encode("published material"),
      contentType: "text/plain",
      fileName: "guide.txt",
      processingVersion: 7,
    });

    const response = await GET(
      new Request("https://delegate.test/reps/demo/materials/asset-1/download?token=signed"),
      { params: Promise.resolve({ slug: "demo", assetId: "asset-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-delegate-material-version")).toBe("7");
    expect(response.headers.get("content-disposition")).toContain("guide.txt");
    expect(await response.text()).toBe("published material");
  });

  it("preserves stale-link failures and never caches them", async () => {
    mocks.resolveGovernedPublicMaterialDownload.mockRejectedValue(
      new mocks.PublicMaterialAccessError("Public material link is stale.", 410),
    );

    const response = await GET(
      new Request("https://delegate.test/reps/demo/materials/asset-1/download?token=stale"),
      { params: Promise.resolve({ slug: "demo", assetId: "asset-1" }) },
    );

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "Public material link is stale." });
  });
});

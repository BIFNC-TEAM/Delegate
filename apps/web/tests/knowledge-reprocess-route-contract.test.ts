import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  new URL(
    "../app/api/dashboard/knowledge-assets/[assetId]/actions/route.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("knowledge reprocess route contract", () => {
  it("returns before long OpenViking work and persists it for the background worker", () => {
    expect(routeSource).toContain('import { NextResponse } from "next/server"');
    expect(routeSource).toContain("queueKnowledgeAssetProcessing(ownerId, assetId)");
    expect(routeSource).toContain("await enqueueKnowledgeIngestion(ownerId, assetId)");
    expect(routeSource).toContain("{ status: 202 }");
    expect(routeSource).not.toMatch(
      /action === "reprocess"[\s\S]{0,100}\? await processKnowledgeAsset/u,
    );
  });
});

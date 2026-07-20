import { describe, expect, it } from "vitest";

import { saveRepresentativeSetupRequests } from "../app/dashboard/representative-setup-save";

describe("representative setup save requests", () => {
  it("starts knowledge binding persistence without waiting for the setup request", async () => {
    const calls: string[] = [];
    let releaseSetup!: () => void;
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/setup")) await setupGate;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const pending = saveRepresentativeSetupRequests({
      representativeSlug: "sktone",
      setup: { name: "SKTone" },
      knowledgeAssetIds: ["knowledge-1"],
      bindingChanged: true,
      fetchImpl,
    });

    await Promise.resolve();
    expect(calls).toEqual([
      "/api/dashboard/representatives/sktone/setup",
      "/api/dashboard/representatives/sktone/knowledge-assets",
    ]);

    releaseSetup();
    const result = await pending;
    expect(result.setupResponse.ok).toBe(true);
    expect(result.bindingResponse?.ok).toBe(true);
  });
});

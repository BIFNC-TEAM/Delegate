import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { saveRepresentativeSetupRequests } from "../app/dashboard/representative-setup-save";

describe("representative setup save requests", () => {
  it("waits for the setup CAS before persisting knowledge bindings", async () => {
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
    expect(calls).toEqual(["/api/dashboard/representatives/sktone/setup"]);

    releaseSetup();
    const result = await pending;
    expect(calls).toEqual([
      "/api/dashboard/representatives/sktone/setup",
      "/api/dashboard/representatives/sktone/knowledge-assets",
    ]);
    expect(result.setupResponse.ok).toBe(true);
    expect(result.bindingResponse?.ok).toBe(true);
    expect(result.bindingError).toBeNull();
  });

  it("does not persist knowledge bindings when the setup CAS conflicts", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({ code: "KNOWLEDGE_PACK_CONFLICT" }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    const result = await saveRepresentativeSetupRequests({
      representativeSlug: "sktone",
      setup: { name: "SKTone" },
      knowledgeAssetIds: ["knowledge-1"],
      bindingChanged: true,
      fetchImpl,
    });

    expect(calls).toEqual(["/api/dashboard/representatives/sktone/setup"]);
    expect(result.setupResponse.status).toBe(409);
    expect(result.bindingResponse).toBeNull();
    expect(result.bindingError).toBeNull();
  });

  it("preserves a successful setup response when the binding request rejects", async () => {
    const bindingFailure = new Error("network unavailable");
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ knowledgePackRevision: 8 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw bindingFailure;
    }) as typeof fetch;

    const result = await saveRepresentativeSetupRequests({
      representativeSlug: "sktone",
      setup: { knowledgePackRevision: 7 },
      knowledgeAssetIds: ["knowledge-1"],
      bindingChanged: true,
      fetchImpl,
    });

    expect(result.setupResponse.ok).toBe(true);
    expect(await result.setupResponse.json()).toEqual({ knowledgePackRevision: 8 });
    expect(result.bindingResponse).toBeNull();
    expect(result.bindingError).toBe(bindingFailure);
  });

  it("reloads the latest setup and shows an actionable message after a 409", () => {
    const source = readFileSync(
      new URL(
        "../app/dashboard/dashboard-representative-setup.tsx",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("response.status === 409");
    expect(source).toContain('failure.code === "KNOWLEDGE_PACK_CONFLICT"');
    expect(source).toContain("refreshSetupAfterConflict");
    expect(source).toContain("setDraft(cloneSnapshot(nextSnapshot))");
    expect(source).toContain("setError(t.setupConflictMessage)");
  });

  it("adopts the committed setup revision before reporting a binding failure", () => {
    const source = readFileSync(
      new URL(
        "../app/dashboard/dashboard-representative-setup.tsx",
        import.meta.url,
      ),
      "utf8",
    );

    const adoptRevision = source.indexOf("setSnapshot(nextSnapshot)");
    const transportFailure = source.indexOf("if (bindingError)");
    const bindingFailure = source.indexOf("if (bindingResponse && !bindingResponse.ok)");

    expect(adoptRevision).toBeGreaterThan(-1);
    expect(transportFailure).toBeGreaterThan(-1);
    expect(bindingFailure).toBeGreaterThan(-1);
    expect(adoptRevision).toBeLessThan(transportFailure);
    expect(adoptRevision).toBeLessThan(bindingFailure);
  });
});

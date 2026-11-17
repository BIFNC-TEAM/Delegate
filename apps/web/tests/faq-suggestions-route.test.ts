import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), assets: vi.fn(), generate: vi.fn() }));
vi.mock("../app/api/dashboard/auth", () => ({ requireDashboardApiOwnerSession: mocks.session, dashboardAuthErrorResponse: () => null }));
vi.mock("@delegate/web-data", () => ({ getFaqKnowledgeAssets: mocks.assets, KnowledgeLibraryError: class KnowledgeLibraryError extends Error { statusCode = 400; } }));
vi.mock("@delegate/model-runtime", () => ({ generateFaqSuggestions: mocks.generate }));
import { POST } from "../app/api/dashboard/faq-suggestions/route";
import { KnowledgeLibraryError } from "@delegate/web-data";
const request = (body: unknown) => new Request("http://localhost/api/dashboard/faq-suggestions", { method: "POST", body: JSON.stringify(body) });
const asset = (id: string) => ({ id, title: id, status: "READY", extractedText: "资料", updatedAt: new Date("2026-01-01"), processingVersion: 1 });
beforeEach(() => { vi.resetAllMocks(); mocks.session.mockResolvedValue({ ownerId: "owner" }); mocks.assets.mockImplementation(async (_owner, ids) => ids.map(asset)); mocks.generate.mockResolvedValue({ status: "success", sources: [{ status: "complete" }], suggestions: [{ question: "Q", answer: "A", sourceIds: ["a"] }] }); });
afterEach(() => vi.unstubAllEnvs());
describe("FAQ suggestions API", () => {
  it("requires an authenticated owner", async () => { mocks.session.mockResolvedValue(null); expect((await POST(request({ assetIds: [] }))).status).toBe(401); expect(mocks.assets).not.toHaveBeenCalled(); });
  it("rejects inaccessible assets before generation", async () => { mocks.assets.mockRejectedValue(new KnowledgeLibraryError("denied")); expect((await POST(request({ assetIds: ["a", "b"] }))).status).toBe(400); expect(mocks.generate).not.toHaveBeenCalled(); });
  it("returns a safe server error for database failures", async () => { mocks.assets.mockRejectedValue(new Error("database secret")); const response = await POST(request({ assetIds: ["a"] })); expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("database secret"); expect(mocks.generate).not.toHaveBeenCalled(); });
  it("checks all ids but generates only five", async () => { const ids = ["a", "b", "c", "d", "e", "f"]; const response = await POST(request({ assetIds: ids })); const data = await response.json(); expect(mocks.assets).toHaveBeenCalledWith("owner", ids, 5); expect(mocks.generate).toHaveBeenCalledTimes(5); expect(data.ignoredAssetIds).toEqual(["f"]); });
  it("rejects excessive count without invoking model", async () => { const response = await POST(request({ assetIds: ["a", "b", "c"], count: 17 })); expect(response.status).toBe(400); expect((await response.json()).maxCount).toBe(16); expect(mocks.generate).not.toHaveBeenCalled(); });
  it("returns a default FAQ with partial failure", async () => { mocks.generate.mockResolvedValueOnce({ status: "timeout", sources: [], suggestions: [] }); const response = await POST(request({ assetIds: ["a", "b"], representative: { description: "介绍" } })); const data = await response.json(); expect(data.status).toBe("partial_success"); expect(data.suggestions[0].answer).toBe("介绍"); });
  it("handles empty assets without a model call", async () => { const response = await POST(request({ assetIds: [], representative: { description: "介绍" } })); expect((await response.json()).suggestions).toHaveLength(1); expect(mocks.generate).not.toHaveBeenCalled(); });
  it("rejects duplicates and over 20 ids before lookup", async () => { expect((await POST(request({ assetIds: ["a", "a"] }))).status).toBe(400); expect((await POST(request({ assetIds: Array.from({ length: 21 }, (_, i) => String(i)) }))).status).toBe(400); expect(mocks.assets).not.toHaveBeenCalled(); });
  it("handles empty and truncated content and preserves snapshot metadata", async () => { mocks.assets.mockResolvedValue([ { ...asset("a"), extractedText: "" }, { ...asset("b"), extractedText: "😀".repeat(2001) } ]); mocks.generate.mockResolvedValue({ status: "success", sources: [{ status: "partial" }], suggestions: [] }); const data = await (await POST(request({ assetIds: ["a", "b"], representative: { description: "😀".repeat(501) } }))).json(); expect(data.results[0].usage).toBe("skipped"); expect(data.results[1]).toMatchObject({ usage: "partial", processingVersion: 1 }); expect(data.descriptionTruncated).toBe(true); expect(Array.from(data.suggestions[0].answer)).toHaveLength(500); });

  it("keeps other results when a model call throws", async () => { mocks.generate.mockRejectedValueOnce(new Error("secret")).mockResolvedValueOnce({ status: "success", sources: [{ status: "complete" }], suggestions: [] }); const response = await POST(request({ assetIds: ["a", "b"] })); const data = await response.json(); expect(data.status).toBe("partial_success"); expect(JSON.stringify(data)).not.toContain("secret"); });
  it("adds the default FAQ when all generations fail", async () => { mocks.generate.mockResolvedValue({ status: "timeout", sources: [], suggestions: [] }); const data = await (await POST(request({ assetIds: ["a"], representative: { description: "介绍" } }))).json(); expect(data.status).toBe("failed"); expect(data.suggestions[0].answer).toBe("介绍"); });
  it("does not return a default FAQ when an asset is unavailable", async () => { mocks.assets.mockRejectedValue(new KnowledgeLibraryError("denied")); const data = await (await POST(request({ assetIds: ["a"], representative: { description: "介绍" } }))).json(); expect(data.suggestions).toBeUndefined(); });

  it("bounds parallel calls and preserves result order", async () => { vi.stubEnv("FAQ_GENERATION_CONCURRENCY", "3"); let active = 0, peak = 0; mocks.generate.mockImplementation(async ({ sources }) => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return { status: "success", sources: [{ status: "complete" }], suggestions: [{ question: sources[0].id, answer: "A", sourceIds: [sources[0].id] }] }; }); const data = await (await POST(request({ assetIds: ["a", "b", "c", "d", "e"] }))).json(); expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(3); expect(data.results.map((r: {id: string}) => r.id)).toEqual(["a", "b", "c", "d", "e"]); });
  it.each([[1, 50], [3, 16], [5, 10]])("enforces count for %i usable assets", async (n, max) => { const ids = Array.from({ length: n }, (_, i) => String(i)); const response = await POST(request({ assetIds: ids, count: max + 1 })); expect(response.status).toBe(400); expect(mocks.generate).not.toHaveBeenCalled(); });

  it("returns the snapshot version read for generation", async () => { const original = asset("a"); mocks.assets.mockResolvedValue([original]); mocks.generate.mockImplementation(async () => { return { status: "success", sources: [{ status: "complete" }], suggestions: [] }; }); const data = await (await POST(request({ assetIds: ["a"] }))).json(); expect(data.results[0]).toMatchObject({ updatedAt: "2026-01-01T00:00:00.000Z", processingVersion: 1 }); });

  it("isolates five overlapping requests with multiple assets and applies a limit per request", async () => {
    vi.stubEnv("FAQ_GENERATION_CONCURRENCY", undefined);
    const groups = ["a", "b", "c", "d", "e"].map(prefix => [1, 2, 3, 4, 5].map(index => `${prefix}${index}`));
    const active: Record<string, number> = { a: 0, b: 0, c: 0, d: 0, e: 0 };
    const peaks: Record<string, number> = { a: 0, b: 0, c: 0, d: 0, e: 0 };
    let total = 0, totalPeak = 0;
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const initialCallsStarted = new Promise<void>(resolve => { reached = resolve; });
    mocks.generate.mockImplementation(async ({ sources }) => {
      const id: string = sources[0].id;
      const group = id[0]!;
      active[group] = active[group]! + 1;
      peaks[group] = Math.max(peaks[group]!, active[group]!);
      total++;
      totalPeak = Math.max(totalPeak, total);
      if (total === 25) reached();
      try {
        await gate;
        return { status: "success", sources: [{ status: "complete" }], suggestions: [{ question: id, answer: id, sourceIds: [id] }] };
      } finally {
        active[group] = active[group]! - 1;
        total--;
      }
    });
    const pending = groups.map(assetIds => POST(request({ assetIds })));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        initialCallsStarted,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Concurrent calls did not start")), 1000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      release();
    }
    const responses = await Promise.all(pending);
    const data = await Promise.all(responses.map(response => response.json()));
    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(peaks).toEqual({ a: 5, b: 5, c: 5, d: 5, e: 5 });
    expect(totalPeak).toBe(25);
    expect(mocks.generate).toHaveBeenCalledTimes(25);
    for (let i = 0; i < groups.length; i++) {
      expect(data[i].results.map((result: { id: string }) => result.id)).toEqual(groups[i]);
      expect(data[i].suggestions.map((item: { sourceIds: string[] }) => item.sourceIds[0])).toEqual(groups[i]);
    }
  });

});

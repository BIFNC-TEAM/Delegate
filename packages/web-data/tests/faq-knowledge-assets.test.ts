import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
import { getFaqKnowledgeAssets } from "../src/knowledge-library";
const row = (id: string, status = "READY") => ({ id, status, title: id, extractedText: "text", updatedAt: new Date(), processingVersion: 1 });
beforeEach(() => { vi.resetAllMocks(); mocks.transaction.mockImplementation(async (fn) => fn({ knowledgeAsset: { findMany: mocks.findMany } })); });
describe("FAQ knowledge asset authorization", () => {
  it("checks all metadata without bodies, then reads only the first five within one snapshot", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    mocks.findMany.mockResolvedValueOnce(ids.map(id => ({ id, status: "READY" }))).mockResolvedValueOnce(ids.slice(0, 5).reverse().map(id => row(id)));
    const result = await getFaqKnowledgeAssets("owner", ids, 5);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" });
    expect(mocks.findMany).toHaveBeenNthCalledWith(1, { where: { ownerId: "owner", id: { in: ids } }, select: { id: true, status: true } });
    expect(mocks.findMany).toHaveBeenNthCalledWith(2, { where: { ownerId: "owner", id: { in: ids.slice(0, 5) }, status: "READY" }, select: { id: true, title: true, extractedText: true, updatedAt: true, processingVersion: true } });
    expect(result.map(x => x.id)).toEqual(ids.slice(0, 5));
  });
  it.each([[row("a")], [row("a"), row("b", "PROCESSING")]])("rejects missing or non-ready assets before reading bodies", async (...rows) => {
    mocks.findMany.mockResolvedValueOnce(rows);
    await expect(getFaqKnowledgeAssets("owner", ["a", "b"], 5)).rejects.toThrow("unavailable");
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
  });
  it("fails closed if the second query does not return the full selected snapshot", async () => {
    mocks.findMany.mockResolvedValueOnce([row("a"), row("b")]).mockResolvedValueOnce([row("a")]);
    await expect(getFaqKnowledgeAssets("owner", ["a", "b"], 5)).rejects.toThrow("unavailable");
  });
  it("propagates database failures without classifying them as invalid assets", async () => {
    const failure = new Error("database unavailable"); mocks.findMany.mockRejectedValueOnce(failure);
    await expect(getFaqKnowledgeAssets("owner", ["a"], 5)).rejects.toBe(failure);
  });
  it("does not query the database for an empty selection", async () => {
    await expect(getFaqKnowledgeAssets("owner", [], 5)).resolves.toEqual([]); expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

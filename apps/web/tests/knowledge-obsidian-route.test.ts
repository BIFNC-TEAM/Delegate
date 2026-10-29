import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), resolve: vi.fn(), create: vi.fn(), find: vi.fn(), replace: vi.fn(), store: vi.fn(), remove: vi.fn(), process: vi.fn(), after: vi.fn(), names: vi.fn(), title: vi.fn(), get: vi.fn() }));
vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), after: mocks.after }));
vi.mock("@delegate/web-data", () => ({
  createKnowledgeAsset: mocks.create, findKnowledgeFileConflicts: mocks.find,
  replaceKnowledgeAssetSource: mocks.replace, storeKnowledgeSource: mocks.store, deleteKnowledgeSource: mocks.remove,
  processKnowledgeAsset: mocks.process, resolveKnowledgeLibraryOwnerId: mocks.resolve, listKnowledgeImportNames: mocks.names,
  resolveUniqueKnowledgeAssetTitle: mocks.title, getKnowledgeAsset: mocks.get,
  checksumKnowledgeSource: () => "a".repeat(64), detectKnowledgeFileKind: (name: string) => name.endsWith(".md") ? "markdown" : "pdf",
  KnowledgeLibraryError: class extends Error { constructor(message: string, public statusCode: number) { super(message); } },
}));
vi.mock("../app/api/dashboard/auth", () => ({
  requireDashboardApiOwnerSession: mocks.auth,
  dashboardAuthErrorResponse: (error: unknown) => error instanceof Error && error.message === "unauthorized" ? Response.json({ error: "unauthorized" }, { status: 401 }) : null,
}));
import { GET, POST } from "../app/api/dashboard/knowledge-assets/route";

const metadata = { sourcePath: "笔记库/产品/说明.md", properties: { tags: ["产品"], 成本: 100 }, referencedPaths: [], warnings: [] };
function upload(options: { metadata?: unknown; notion?: unknown; policy?: string; name?: string; visibility?: string; links?: unknown[] } = {}) {
  const form = new FormData();
  form.set("file", new File(["这是一份已经预览并确认的产品说明正文，属性不混入问答。"], options.name ?? "说明.md", { type: "text/markdown" }));
  if (options.metadata !== undefined) form.set("obsidianImport", JSON.stringify(options.metadata));
  if (options.notion !== undefined) form.set("notionImport", JSON.stringify(options.notion));
  form.set("conflictPolicy", options.policy ?? "skip_duplicates");
  if (options.visibility) form.set("visibility", options.visibility);
  form.set("representativeLinks", JSON.stringify(options.links ?? []));
  return new Request("http://localhost/api/dashboard/knowledge-assets", { method: "POST", body: form });
}

describe("Obsidian upload through the existing knowledge endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ ownerId: "owner-a", email: "owner@example.com" });
    mocks.resolve.mockResolvedValue("owner-a");
    mocks.find.mockResolvedValue({ exact: { id: "old" }, sameName: { id: "old" } });
    mocks.store.mockResolvedValue({ bucket: "private", objectKey: "owner-a/new", checksum: "a".repeat(64) });
    mocks.create.mockResolvedValue({ id: "new", originalFileName: "说明（2）.md", status: "processing" });
    mocks.names.mockResolvedValue([{ title: "说明", originalFileName: "说明.md" }]);
    mocks.get.mockResolvedValue({ id: "old" });
  });

  it("always creates a numbered copy, even for identical content and a replace request", async () => {
    const response = await POST(upload({ metadata, policy: "replace_existing" }));
    expect(response.status).toBe(201);
    expect((await response.json()).upload.outcome).toBe("created");
    expect(mocks.replace).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith("owner-a", expect.objectContaining({ visibility: "owner_only", representativeLinks: [], metadata: { obsidianImport: metadata } }), { processingMode: "deferred", numberFileName: true });
    await mocks.after.mock.calls[0]![0]();
    expect(mocks.process).toHaveBeenCalledWith("owner-a", "new");
  });

  it("uses exactly the same access and representative fields as other uploads", async () => {
    const links = [{ representativeId: "rep-a", enabled: true, reviewStatus: "approved", usageMode: "qa_source", priority: 50 }];
    expect((await POST(upload({ metadata, visibility: "selected_representatives", links }))).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith("owner-a", expect.objectContaining({ visibility: "selected_representatives", representativeLinks: links }), expect.anything());
  });

  it("leaves ordinary duplicate uploads unchanged", async () => {
    const response = await POST(upload());
    expect((await response.json()).upload.outcome).toBe("skipped_duplicate");
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.store).not.toHaveBeenCalled();
  });

  const notion = { pageId: "11111111-1111-4111-8111-111111111111", workspaceId: "workspace", workspaceName: "Test", sourceUrl: "https://www.notion.so/11111111111141118111111111111111", importedAt: "2026-10-27T00:00:00.000Z", warnings: [], incomplete: false };
  it("skips identical Notion content through the standard conflict policy", async () => {
    const response = await POST(upload({ notion }));
    expect((await response.json()).upload.outcome).toBe("skipped_duplicate");
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it("creates a numbered Notion copy only when requested, preserving provenance", async () => {
    expect((await POST(upload({ notion, policy: "keep_both" }))).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith("owner-a", expect.objectContaining({ metadata: { notionImport: notion }, sourceUrl: notion.sourceUrl }), { processingMode: "deferred", numberFileName: true });
  });
  it("passes Notion provenance through source replacement", async () => {
    mocks.replace.mockResolvedValue({ id: "old" });
    expect((await POST(upload({ notion, policy: "replace_existing" }))).status).toBe(200);
    expect(mocks.replace).toHaveBeenCalledWith("owner-a", "old", expect.objectContaining({ notionImport: notion }));
  });
  it("rejects mixed providers and private fields before storage", async () => {
    expect((await POST(upload({ notion, metadata }))).status).toBe(422);
    expect((await POST(upload({ notion: { ...notion, ciphertext: "private" } }))).status).toBe(422);
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it.each([
    { ...metadata, sourcePath: "../../private.md" },
    { ...metadata, visibility: "public_material" },
    { ...metadata, properties: { huge: "x".repeat(64_001) } },
  ])("rejects invalid source metadata before storage", async (invalid) => {
    expect((await POST(upload({ metadata: invalid }))).status).toBe(422);
    expect(mocks.store).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled();
  });

  it("does not accept attachments as Obsidian notes", async () => {
    expect((await POST(upload({ metadata, name: "attachment.pdf" }))).status).toBe(422);
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("scopes preview filenames to the authenticated owner", async () => {
    const response = await GET(new Request("http://localhost/api/dashboard/knowledge-assets?namesOnly=true"));
    expect(response.status).toBe(200); expect(mocks.names).toHaveBeenCalledWith("owner-a");
    mocks.auth.mockRejectedValue(new Error("unauthorized"));
    expect((await GET(new Request("http://localhost/api/dashboard/knowledge-assets?namesOnly=true"))).status).toBe(401);
    expect((await POST(upload({ metadata }))).status).toBe(401);
    expect(mocks.names).toHaveBeenCalledTimes(1); expect(mocks.store).not.toHaveBeenCalled();
  });
});

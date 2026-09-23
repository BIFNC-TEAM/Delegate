import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { knowledgeBrowserCaptureSchema } from "../../../packages/web-data/src/knowledge-web-capture";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), resolve: vi.fn(), replace: vi.fn(), process: vi.fn(), create: vi.fn(), after: vi.fn(),
}));
vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), after: mocks.after }));
vi.mock("@delegate/web-data", () => ({
  replaceFailedKnowledgeUrlWithBrowserCapture: mocks.replace,
  processKnowledgeAsset: mocks.process,
  resolveKnowledgeLibraryOwnerId: mocks.resolve,
  createKnowledgeAsset: mocks.create,
  knowledgeBrowserCaptureSchema,
  KnowledgeLibraryError: class extends Error { constructor(message: string, public statusCode: number) { super(message); } },
}));
vi.mock("../app/api/dashboard/auth", () => ({
  requireDashboardApiOwnerSession: mocks.auth,
  dashboardAuthErrorResponse: (error: unknown) => error instanceof Error && error.message === "unauthorized" ? Response.json({ error: "unauthorized" }, { status: 401 }) : null,
}));
import { POST as repair } from "../app/api/dashboard/knowledge-assets/[assetId]/browser-capture/route";
import { POST as create } from "../app/api/dashboard/knowledge-assets/route";
import { GET as download } from "../app/api/dashboard/knowledge-assets/browser-collector/route";
const capture = { format: "delegate-web-capture", version: 1, sourceUrl: "http://192.168.1.2/wiki", title: "内部资料", text: "这是已经由用户在浏览器中确认的内部资料正文，足够用于知识库导入。", capturedAt: "2026-09-23T00:00:00.000Z" };
const request = (body: unknown) => new Request("http://localhost/api/dashboard/knowledge-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("browser knowledge capture routes", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ ownerId: "owner-a" }); mocks.resolve.mockResolvedValue("owner-a"); mocks.replace.mockResolvedValue({ id: "asset-a", status: "processing" }); mocks.create.mockResolvedValue({ id: "asset-new", status: "processing" }); });

  it("repairs through authenticated owner scope and schedules indexing after response", async () => {
    const response = await repair(request(capture), { params: Promise.resolve({ assetId: "asset-a" }) });
    expect(response.status).toBe(202);
    expect(mocks.replace).toHaveBeenCalledWith("owner-a", "asset-a", capture);
    expect(mocks.process).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0]![0]();
    expect(mocks.process).toHaveBeenCalledWith("owner-a", "asset-a");
  });

  it("creates URL snapshots with trusted persistence coordinates excluded", async () => {
    const response = await create(request({ kind: "url", title: capture.title, browserCapture: capture, sourceUrl: "https://ignored.example", sourceObjectKey: "another-owner/key", sourceObjectBucket: "private" }));
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith("owner-a", expect.objectContaining({ sourceUrl: capture.sourceUrl, sourceText: capture.text, metadata: { ingestionMethod: "browser_capture", capturedAt: capture.capturedAt } }), { processingMode: "deferred" });
    expect(mocks.create.mock.calls[0]![1]).not.toHaveProperty("sourceObjectKey");
    expect(mocks.create.mock.calls[0]![1]).not.toHaveProperty("sourceObjectBucket");
  });

  it.each([{ ...capture, title: "百度安全验证" }, { ...capture, text: "" }, { ...capture, sourceUrl: "file:///tmp/private" }])("rejects invalid snapshots before asset creation", async (browserCapture) => {
    const response = await create(request({ kind: "url", title: "Imported", browserCapture }));
    expect(response.status).toBe(422);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("does not enqueue work when scope or asset validation fails", async () => {
    const { KnowledgeLibraryError } = await import("@delegate/web-data");
    mocks.replace.mockRejectedValueOnce(new KnowledgeLibraryError("Asset not found", 404));
    expect((await repair(request(capture), { params: Promise.resolve({ assetId: "other-owner" }) })).status).toBe(404);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("requires authentication before importing, repairing, or downloading", async () => {
    mocks.auth.mockRejectedValue(new Error("unauthorized"));
    expect((await create(request({ kind: "url", browserCapture: capture }))).status).toBe(401);
    expect((await repair(request(capture), { params: Promise.resolve({ assetId: "a" }) })).status).toBe(401);
    expect((await download()).status).toBe(401);
    expect(mocks.replace).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });

  it("downloads a complete, narrowly-permissioned extension bundle", async () => {
    const response = await download();
    expect(response.status).toBe(200);
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    for (const file of ["manifest.json", "popup.html", "popup.js", "popup.css", "capture.js", "README.txt"]) expect(zip.file(file)).not.toBeNull();
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    const compose = readFileSync(new URL("../../../compose.local.yml", import.meta.url), "utf8");
    expect(compose).toContain("./apps/web/public:/app/apps/web/public:ro");
    expect(manifest.permissions).toEqual(["activeTab", "scripting"]);
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("background");
    const source = await zip.file("capture.js")!.async("string");
    expect(source).not.toContain("document.cookie");
  });
});

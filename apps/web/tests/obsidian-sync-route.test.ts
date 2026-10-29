import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  session: vi.fn(), owner: vi.fn(), read: vi.fn(), status: vi.fn(), connect: vi.fn(),
}));
vi.mock("@delegate/web-data", () => ({ resolveKnowledgeLibraryOwnerId: mocks.owner }));
vi.mock("../app/api/dashboard/auth", () => ({
  requireDashboardApiOwnerSession: mocks.session,
  dashboardAuthErrorResponse: () => null,
}));
vi.mock("@delegate/web-data/obsidian-sync", () => ({
  SyncError: class extends Error {},
  getObsidianConnection: mocks.status, connectObsidian: mocks.connect,
  disconnectObsidian: vi.fn(), listObsidianVaults: vi.fn(), unlockObsidianVault: vi.fn(), readObsidianNotes: mocks.read,
}));
import { POST } from "../app/api/dashboard/obsidian-sync/route";
function request(body: object, origin = "http://localhost:3001") {
  return new Request("http://localhost:3001/api/dashboard/obsidian-sync", {
    method: "POST", headers: { "Content-Type": "application/json", host: "localhost:3001", origin },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ ownerId: "authenticated-owner" });
  mocks.owner.mockResolvedValue("authenticated-owner");
  mocks.read.mockResolvedValue({ notes: [], files: [] });
});
it("passes only an authenticated owner and explicit selection to the service", async () => {
  const response = await POST(request({ action: "download", connectionId: "c1", vaultId: "v1", selected: ["n1"] }));
  expect(response.status).toBe(200);
  expect(mocks.read).toHaveBeenCalledWith("authenticated-owner", "c1", "v1", ["n1"]);
  expect(response.headers.get("cache-control")).toContain("no-store");
});
it("does not call the downloader when listing metadata", async () => {
  await POST(request({ action: "notes", connectionId: "c1", vaultId: "v1" }));
  expect(mocks.read).toHaveBeenCalledWith("authenticated-owner", "c1", "v1");
});
it("rejects empty download selections and cross-origin mutations", async () => {
  expect((await POST(request({ action: "download", connectionId: "c1", vaultId: "v1", selected: [] }))).status).toBe(400);
  expect((await POST(request({ action: "status" }, "https://unrelated.example"))).status).toBe(403);
  expect(mocks.read).not.toHaveBeenCalled();
});
it("does not use a supplied owner identifier to bypass authentication", async () => {
  await POST(request({ action: "notes", ownerId: "victim", connectionId: "c1", vaultId: "v1" }));
  expect(mocks.read).toHaveBeenCalledWith("authenticated-owner", "c1", "v1");
});
it("rejects a demo without a database-backed owner", async () => {
  mocks.owner.mockResolvedValue(null);
  expect((await POST(request({ action: "status" }))).status).toBe(401);
  expect(mocks.status).not.toHaveBeenCalled();
});

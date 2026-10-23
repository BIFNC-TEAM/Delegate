import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), owner: vi.fn(), list: vi.fn(), download: vi.fn() }));
vi.mock("@delegate/web-data", () => ({ resolveKnowledgeLibraryOwnerId: mocks.owner }));
vi.mock("../app/api/dashboard/auth", () => ({ requireDashboardApiOwnerSession: mocks.session, dashboardAuthErrorResponse: () => null }));
vi.mock("@delegate/web-data/obsidian-publish", () => ({
  PublishError: class extends Error {}, readPublishPage: vi.fn(), createPublishReader: () => ({ list: mocks.list, download: mocks.download }),
}));
import { POST } from "../app/api/dashboard/obsidian-publish/route";
function request(body: object, origin = "http://localhost:3001") {
  return new Request("http://localhost:3001/api/dashboard/obsidian-publish", { method: "POST", headers: { "Content-Type": "application/json", host: "localhost:3001", origin }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.session.mockResolvedValue({ ownerId: "owner" }); mocks.owner.mockResolvedValue("owner");
  mocks.list.mockResolvedValue({ notes: [] }); mocks.download.mockResolvedValue({ files: [] });
});
it("lists without downloading and keeps responses private", async () => {
  const response = await POST(request({ action: "list", url: "https://publish.obsidian.md/test/" }));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
  expect(mocks.download).not.toHaveBeenCalled();
});
it("passes only the explicit selection to download", async () => {
  const url = "https://publish.obsidian.md/test/";
  expect((await POST(request({ action: "download", url, selected: [url + "A"] }))).status).toBe(200);
  expect(mocks.download).toHaveBeenCalledWith(url, [url + "A"]);
});
it("rejects requests without a resolved owner", async () => {
  mocks.owner.mockResolvedValue(null);
  expect((await POST(request({ action: "list", url: "https://publish.obsidian.md/test/" }))).status).toBe(401);
  expect(mocks.list).not.toHaveBeenCalled();
});
it("rejects cross-origin requests and empty selections", async () => {
  const url = "https://publish.obsidian.md/test/";
  expect((await POST(request({ action: "list", url }, "https://other.example"))).status).toBe(403);
  expect((await POST(request({ action: "download", url, selected: [] }))).status).toBe(400);
  expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
});

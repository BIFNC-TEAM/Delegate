import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), owner: vi.fn(), read: vi.fn(), list: vi.fn(), withNotion: vi.fn(), status: vi.fn(), connect: vi.fn(), cookie: vi.fn() }));
vi.mock("@delegate/web-data", () => ({ resolveKnowledgeLibraryOwnerId: mocks.owner }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: mocks.cookie }) }));
vi.mock("../app/api/dashboard/auth", () => ({ requireDashboardApiOwnerSession: mocks.session, dashboardAuthErrorResponse: () => null }));
vi.mock("@delegate/web-data/notion", () => ({ NotionError: class extends Error {}, beginNotionAuthorization: mocks.connect, listNotionConnections: mocks.status, disconnectNotion: vi.fn(), withNotion: mocks.withNotion }));
vi.mock("@delegate/web-data/notion-content", () => ({ listNotionPages: mocks.list, readNotionPage: mocks.read, listNotionRecords: vi.fn(), lookupNotionPage: vi.fn(), expandNotionPages: vi.fn() }));
import { POST } from "../app/api/dashboard/notion/route";
const id = "11111111-1111-4111-8111-111111111111";
function request(body: object, origin = "http://localhost:3001") {
  return new Request("http://localhost:3001/api/dashboard/notion", { method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.session.mockResolvedValue({ ownerId: "owner" }); mocks.owner.mockResolvedValue("owner");
  mocks.withNotion.mockImplementation(async (_owner, _id, fn) => fn("client", { workspaceId: "workspace", workspaceName: "Test" }));
});
afterEach(() => vi.unstubAllEnvs());
it("accepts the registered public origin behind an internal reverse-proxy URL", async () => {
  vi.stubEnv("NOTION_REDIRECT_URI", "https://delegate.example/api/dashboard/notion/callback");
  const req = new Request("http://dashboard:3001/api/dashboard/notion", { method: "POST", headers: { "Content-Type": "application/json", origin: "https://delegate.example" }, body: JSON.stringify({ action: "status" }) });
  expect((await POST(req)).status).toBe(200);
});
it("uses the authenticated owner and only the selected page", async () => {
  const response = await POST(request({ action: "read", connectionId: "connection", pageId: id, ownerId: "victim" }));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
  expect(mocks.withNotion.mock.calls[0]!.slice(0, 2)).toEqual(["owner", "connection"]);
  expect(mocks.read).toHaveBeenCalledWith("client", id, { workspaceId: "workspace", workspaceName: "Test" });
});
it("lists metadata without downloading bodies", async () => {
  expect((await POST(request({ action: "list", connectionId: "connection" }))).status).toBe(200);
  expect(mocks.list).toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
});
it("rejects cross-origin requests and invalid selections", async () => {
  expect((await POST(request({ action: "status" }, "https://other.example"))).status).toBe(403);
  expect((await POST(request({ action: "read", connectionId: "connection", pageId: "invalid" }))).status).toBe(400);
  expect((await POST(request({ action: "expand", connectionId: "connection", selected: [] }))).status).toBe(400);
  expect(mocks.withNotion).not.toHaveBeenCalled();
});
it("refuses demo access without a database-backed owner", async () => {
  mocks.owner.mockResolvedValue(null);
  expect((await POST(request({ action: "status" }))).status).toBe(401);
});
it("sets a short-lived HTTP-only browser binding for OAuth", async () => {
  mocks.connect.mockResolvedValue({ origin: "http://localhost:3001", url: "https://api.notion.com/v1/oauth/authorize" });
  expect((await POST(request({ action: "connect", representative: "lin-founder-rep" }))).status).toBe(200);
  expect(mocks.cookie).toHaveBeenCalledWith("delegate-notion-oauth", expect.any(String), expect.objectContaining({ httpOnly: true, sameSite: "lax", maxAge: 600, path: "/api/dashboard/notion" }));
});

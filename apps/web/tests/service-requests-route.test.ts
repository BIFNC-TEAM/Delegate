import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), actor: vi.fn(), execute: vi.fn(), query: vi.fn(), options: vi.fn() }));
vi.mock("../app/api/dashboard/auth", () => ({ requireDashboardRepresentativeAccess: mocks.auth, dashboardAuthErrorResponse: () => null }));
vi.mock("@delegate/model-runtime", () => ({ generateServiceRequestOptions: mocks.options }));
vi.mock("@delegate/web-data", () => ({
  getServiceRequestOwnerActor: mocks.actor, executeServiceRequestOperation: mocks.execute,
  queryServiceRequestOperation: mocks.query, serviceRequestPublicResult: (value: unknown) => value,
  ServiceRequestError: class extends Error {},
}));
import { GET, POST } from "../app/api/dashboard/representatives/[slug]/service-requests/route";
const context = () => ({ params: Promise.resolve({ slug: "test" }) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.mockResolvedValue({ ownerId: "owner" }); mocks.actor.mockResolvedValue({ role: "owner", ownerId: "owner", representativeId: "rep" });
  mocks.execute.mockResolvedValue({ id: "request" }); mocks.query.mockResolvedValue({ items: [] }); mocks.options.mockResolvedValue([{ id: "other", label: "其他" }]);
});
describe("service request owner HTTP route", () => {
  it("does not allow unauthenticated local-owner writes", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await POST(new Request("http://localhost/api", { method: "POST", body: "{}" }), context())).status).toBe(401);
    expect(mocks.actor).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("uses the authenticated owner and marks list responses private", async () => {
    const response = await GET(new Request("http://localhost/api?box=received"), context());
    expect(mocks.actor).toHaveBeenCalledWith("test", "owner");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("generates follow-up choices without replacing owner question", async () => {
    const body = { operation: "successor", mode: "follow_up", item: { content: "合作数量？" }, options: [{ id: "fake", label: "client" }] };
    await POST(new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body) }), context());
    expect(mocks.options).toHaveBeenCalledWith("合作数量？");
    expect(mocks.execute.mock.calls[0]![1]).toMatchObject({ item: { content: "合作数量？" }, options: [{ id: "other", label: "其他" }] });
  });
  it("rejects malformed JSON", async () => {
    expect((await POST(new Request("http://localhost/api", { method: "POST", body: "{" }), context())).status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ principal: vi.fn(), revalidate: vi.fn(), context: vi.fn(), execute: vi.fn(), query: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("../app/reps/[slug]/public-principal", () => ({ resolvePublicAudienceRequestPrincipal: mocks.principal, publicAudiencePrincipalErrorStatus: () => null, setPublicAudienceSessionCookie: vi.fn() }));
vi.mock("@delegate/web-data", () => ({
  getPublicRepresentativeRuntime: async () => ({ status: "available" }), getServiceRequestVisitorContext: mocks.context,
  executeServiceRequestOperation: mocks.execute, queryServiceRequestOperation: mocks.query,
  serviceRequestPublicResult: (value: unknown) => value, ServiceRequestError: class extends Error {},
}));
import { GET, POST } from "../app/reps/[slug]/service-requests/route";
const params = () => ({ params: Promise.resolve({ slug: "test" }) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.principal.mockResolvedValue({ principal: { audienceIdentityId: "verified" }, revalidate: mocks.revalidate, sessionState: {} });
  mocks.context.mockResolvedValue({ actor: { role: "visitor" } }); mocks.query.mockResolvedValue({ items: [] }); mocks.execute.mockResolvedValue({});
});
describe("service request visitor route", () => {
  it("takes identity from the signed principal, not query parameters", async () => {
    await GET(new Request("http://localhost/api?conversationId=conv&audienceIdentityId=forged"), params());
    expect(mocks.context).toHaveBeenCalledWith("test", "verified", "conv");
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
  });
  it("requires a conversation reference before business access", async () => {
    expect((await GET(new Request("http://localhost/api"), params())).status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it("does not dispatch a write if captured auth has been revoked", async () => {
    mocks.revalidate.mockRejectedValue(new Error("revoked"));
    await POST(new Request("http://localhost/api?conversationId=conv", { method: "POST", body: "{}" }), params());
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

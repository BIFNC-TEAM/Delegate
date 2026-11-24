import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  class CitationError extends Error { constructor(readonly status: number) { super("citation_error"); } }
  return { runtime: vi.fn(), principal: vi.fn(), sources: vi.fn(), cookie: vi.fn(), CitationError };
});
vi.mock("next/headers", () => ({ cookies: async () => ({ get: vi.fn() }) }));
vi.mock("@delegate/web-data", () => ({ getPublicRepresentativeRuntime: mocks.runtime, getPublicCitationSources: mocks.sources, PublicCitationSourceError: mocks.CitationError }));
vi.mock("../app/reps/[slug]/public-principal", () => ({ resolvePublicAudienceRequestPrincipal: mocks.principal,
  publicAudiencePrincipalErrorStatus: (error: unknown) => error instanceof Error && error.message === "unauthorized" ? 401 : null, setPublicAudienceSessionCookie: mocks.cookie }));
import { POST } from "../app/reps/[slug]/chat/citation-sources/route";
const request = (body: unknown) => new Request("http://localhost/reps/fixture/chat/citation-sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const call = (body: unknown = { messageId: "message", rangeId: "range" }) => POST(request(body), { params: Promise.resolve({ slug: "fixture" }) });
describe("read-only citation card route (simulated principal, not real HTTP)", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.runtime.mockResolvedValue({ status: "available" });
    mocks.principal.mockResolvedValue({ principal: { audienceIdentityId: "signed-identity", audienceId: "signed-visitor" }, sessionState: {} });
    mocks.sources.mockResolvedValue({ status: "available", sources: [{ title: "Public source", domain: "example.com", url: "https://example.com/" }] });
  });
  it("uses only verified session identity and returns private no-store metadata", async () => {
    const response = await call();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.sources).toHaveBeenCalledWith({ representativeSlug: "fixture", messageId: "message", rangeId: "range", audienceIdentityId: "signed-identity", audienceId: "signed-visitor" });
    expect(await response.json()).toMatchObject({ sources: [{ title: "Public source", url: "https://example.com/" }] });
  });
  it.each([null, {}, { messageId: "message", rangeId: "range", sourceIds: ["forged"] }, { messageId: "message", rangeId: "range", audienceIdentityId: "other" }])("rejects invalid or client-selected dependencies: %j", async body => {
    expect((await call(body)).status).toBe(400); expect(mocks.sources).not.toHaveBeenCalled();
  });
  it("requires a principal before any source read", async () => {
    mocks.principal.mockRejectedValue(new Error("unauthorized"));
    const response = await call(); expect(response.status).toBe(401); expect(mocks.sources).not.toHaveBeenCalled();
  });
  it("does not expose titles for missing/foreign ranges or unavailable sources", async () => {
    mocks.sources.mockRejectedValueOnce(new mocks.CitationError(404));
    const missing = await call(); expect(missing.status).toBe(404); expect(JSON.stringify(await missing.json())).not.toContain("Public source");
    mocks.sources.mockResolvedValueOnce({ status: "unavailable", sources: [] });
    expect(await (await call()).json()).toEqual({ status: "unavailable", sources: [] });
  });
  it("keeps paused representatives unavailable", async () => {
    mocks.runtime.mockResolvedValue({ status: "paused" }); expect((await call()).status).toBe(423); expect(mocks.sources).not.toHaveBeenCalled();
  });
});

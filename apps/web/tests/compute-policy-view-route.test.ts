import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), authorize: vi.fn(), authResponse: vi.fn() }));
vi.mock("@delegate/web-data", () => ({ getRepresentativeComputePolicyView: mocks.read }));
vi.mock("../app/api/dashboard/auth", () => ({ requireDashboardRepresentativeAccess: mocks.authorize, dashboardAuthErrorResponse: mocks.authResponse }));
import { GET } from "../app/api/dashboard/representatives/[slug]/compute/policy-view/route";
const request = () => GET(new Request("https://example.invalid/api/policy"), { params: Promise.resolve({ slug: "owned" }) });

describe("Owner-only compute policy route", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue({ ownerId: "owner" }); mocks.authResponse.mockReturnValue(null); });
  it("checks representative access before reading and returns private no-store", async () => {
    mocks.read.mockResolvedValue({ state: "unpublished", runtimeCeiling: null });
    const result = await request();
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith("owned"); expect(mocks.read).toHaveBeenCalledWith("owned");
    expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(mocks.read.mock.invocationCallOrder[0]!);
  });
  it("performs no policy read for unauthorized access", async () => {
    mocks.authorize.mockRejectedValue(new Error("forbidden")); mocks.authResponse.mockReturnValue(new Response("Forbidden", { status: 403 }));
    expect((await request()).status).toBe(403); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("does not expose private errors or fabricate policy after database failure", async () => {
    mocks.read.mockRejectedValue(new Error("SYNTHETIC_DATABASE_SECRET"));
    const result = await request(); expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("SYNTHETIC_DATABASE_SECRET");
  });
  it("returns 404 when the representative disappeared", async () => {
    mocks.read.mockResolvedValue(null); expect((await request()).status).toBe(404);
  });
});

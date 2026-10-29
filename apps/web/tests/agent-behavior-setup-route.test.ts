import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ update: vi.fn(), auth: vi.fn(), authError: vi.fn(), skillAccess: vi.fn() }));
vi.mock("@delegate/web-data", () => ({
  updateRepresentativeSetup: mocks.update, getRepresentativeSetupSnapshot: vi.fn(), maybeSyncRepresentativeOpenVikingResources: vi.fn(), assertOwnerCanManageSkills: mocks.skillAccess,
  RepresentativeSetupConflictError: class extends Error {},
}));
vi.mock("../app/api/dashboard/auth", () => ({ requireDashboardRepresentativeAccess: mocks.auth, authorizeDashboardRepresentativeAccess: vi.fn(), dashboardAuthErrorResponse: mocks.authError }));
vi.mock("next/server", async importOriginal => ({ ...await importOriginal<typeof import("next/server")>(), after: vi.fn() }));
import { PATCH } from "../app/api/dashboard/representatives/[slug]/setup/route";
const policy = { version: 1, answerScope: "open_public", knowledgePolicy: "owner_facts", commitmentPolicy: "information_only" };
const request = (body: unknown) => PATCH(new Request("https://example.invalid/setup", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ slug: "owned" }) });

describe("Owner-only answer policy setup input", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ ownerId: "owner" }); mocks.authError.mockReturnValue(null); mocks.update.mockResolvedValue({ slug: "owned" }); });
  it("forwards validated independent settings after owner authorization", async () => {
    expect((await request({ agentBehavior: policy })).status).toBe(200);
    expect(mocks.auth).toHaveBeenCalledWith("owned");
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ representativeSlug: "owned", changedBy: "owner", input: expect.objectContaining({ agentBehavior: policy }) }));
    expect(mocks.auth.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]!);
  });
  it.each([null, { ...policy, approvalRequired: false }, { ...policy, answerScope: "unrestricted" }])("rejects malformed or privilege-bearing policy without saving: %j", async agentBehavior => {
    expect((await request({ agentBehavior })).status).toBe(400); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not invent or clear configuration for older clients", async () => {
    expect((await request({})).status).toBe(200);
    expect(mocks.update.mock.calls[0]![0].input).not.toHaveProperty("agentBehavior");
  });
  it("performs no save for unauthorized callers", async () => {
    mocks.auth.mockRejectedValue(new Error("forbidden")); mocks.authError.mockReturnValue(new Response("forbidden", { status: 403 }));
    expect((await request({ agentBehavior: policy })).status).toBe(403); expect(mocks.update).not.toHaveBeenCalled();
  });
});

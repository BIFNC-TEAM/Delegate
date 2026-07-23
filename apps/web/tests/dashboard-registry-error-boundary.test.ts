import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const registryMocks = vi.hoisted(() => ({
  search: vi.fn(),
}));
const authMocks = vi.hoisted(() => ({
  requireOwnerSession: vi.fn(),
  errorResponse: vi.fn(),
}));

vi.mock("@delegate/registry", async (importOriginal) => ({
  ...await importOriginal<typeof import("@delegate/registry")>(),
  searchClawHubRepresentativeSkills: registryMocks.search,
}));
vi.mock("../app/api/dashboard/auth", () => ({
  requireDashboardApiOwnerSession: authMocks.requireOwnerSession,
  dashboardAuthErrorResponse: authMocks.errorResponse,
}));

import { GET } from "../app/api/registry/clawhub/skills/route";

describe("dashboard ClawHub registry error boundary", () => {
  beforeEach(() => {
    registryMocks.search.mockReset();
    authMocks.requireOwnerSession.mockReset();
    authMocks.requireOwnerSession.mockResolvedValue(null);
    authMocks.errorResponse.mockReset();
    authMocks.errorResponse.mockReturnValue(null);
  });

  it("returns a fixed 502 without exposing upstream details", async () => {
    registryMocks.search.mockRejectedValueOnce(
      new Error("GET https://clawhub.ai/api/search?token=secret timed out"),
    );

    const response = await GET(
      new Request("http://localhost/api/registry/clawhub/skills?query=calendar"),
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "ClawHub skill search is temporarily unavailable.",
    });
  });

  it("returns authorization failures before calling the upstream Registry", async () => {
    const authError = new Error("Authentication required.");
    authMocks.requireOwnerSession.mockRejectedValueOnce(authError);
    authMocks.errorResponse.mockImplementationOnce((error) =>
      error === authError
        ? Response.json({ error: "Authentication required." }, { status: 401 })
        : null,
    );

    const response = await GET(
      new Request("http://localhost/api/registry/clawhub/skills?query=calendar"),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "Authentication required." });
    expect(registryMocks.search).not.toHaveBeenCalled();
  });

  it("statically keeps owner auth ahead of the Registry request", () => {
    const source = readFileSync(
      new URL("../app/api/registry/clawhub/skills/route.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("requireDashboardApiOwnerSession");
    expect(source.indexOf("await requireDashboardApiOwnerSession()")).toBeLessThan(
      source.indexOf("await searchClawHubRepresentativeSkills"),
    );
    expect(source.indexOf("dashboardAuthErrorResponse(error)")).toBeLessThan(
      source.indexOf("ClawHub skill search is temporarily unavailable."),
    );
  });
});

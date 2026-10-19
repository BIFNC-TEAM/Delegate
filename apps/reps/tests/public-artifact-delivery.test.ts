import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ artifact: vi.fn(), principal: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: vi.fn() }) }));
vi.mock("@delegate/web-data", () => ({ getPublicRepresentativeRuntime: async () => ({ status: "available" }), getPublicConversationArtifactDownload: mocks.artifact }));
vi.mock("../app/reps/[slug]/public-principal", () => ({ resolvePublicAudienceRequestPrincipal: mocks.principal, publicAudiencePrincipalErrorStatus: () => null, setPublicAudienceSessionCookie: vi.fn() }));
import { GET } from "../app/reps/[slug]/chat/artifacts/[artifactId]/download/route";

describe("public artifact delivery headers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.principal.mockResolvedValue({ principal: { audienceIdentityId: "identity" }, sessionState: {} });
  });
  it.each(["text/html", "image/svg+xml", "application/octet-stream"])("does not render %s as active same-origin content", async mimeType => {
    mocks.artifact.mockResolvedValue({ mimeType, fileName: "fixture.html", buffer: Buffer.from("<script>window.fixture=true</script>") });
    const response = await GET(new Request("http://localhost/reps/rep/chat/artifacts/artifact/download?inline=1"), { params: Promise.resolve({ slug: "rep", artifactId: "artifact" }) });
    expect(response.headers.get("Content-Disposition")).toContain("attachment;");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
  it("keeps an authorized image preview available without allowing scripts", async () => {
    mocks.artifact.mockResolvedValue({ mimeType: "image/png", fileName: "screenshot.png", buffer: Buffer.from("synthetic-image") });
    const response = await GET(new Request("http://localhost/reps/rep/chat/artifacts/artifact/download?inline=1"), { params: Promise.resolve({ slug: "rep", artifactId: "artifact" }) });
    expect(response.headers.get("Content-Disposition")).toContain("inline;");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(response.headers.get("Content-Security-Policy")).not.toContain("allow-scripts");
    expect(mocks.artifact).toHaveBeenCalledWith({ representativeSlug: "rep", artifactId: "artifact", audienceIdentityId: "identity" });
  });
});

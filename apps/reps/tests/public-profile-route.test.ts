import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getRuntime: vi.fn() }));
vi.mock("@delegate/web-data", () => ({
  getPublicRepresentativeRuntime: mocks.getRuntime,
}));
import { GET } from "../app/reps/[slug]/profile/route";
const params = Promise.resolve({ slug: "test-agent" });
const request = new Request("http://localhost/reps/test-agent/profile?lang=zh");

describe("public native profile", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([
    ["paused", 423],
    ["not_found", 404],
    ["private", 404],
    ["unpublished", 404],
    ["web_disabled", 404],
  ])("gates %s representatives", async (status, code) => {
    mocks.getRuntime.mockResolvedValue({ status });
    const response = await GET(request, { params });
    expect(response.status).toBe(code);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).not.toHaveProperty("representative");
  });
  it("exposes only published public identity and disclosure fields", async () => {
    mocks.getRuntime.mockResolvedValue({
      status: "available",
      setup: {
        name: "Demo",
        ownerName: "Owner",
        tagline: "Public help",
        privateNotes: "PRIVATE",
        modelKey: "SECRET",
      },
      governedMemoryDisclosure: {
        enabled: false,
        shortTermMemoryEnabled: true,
        automaticExtractionEnabled: false,
        contactMemoryEnabled: false,
        contactMemoryCrossChannelEnabled: false,
        representativeExperienceEnabled: false,
        retentionDays: null,
        expiryAction: null,
        policyRevision: 3,
        fingerprint: "proof",
        privateField: "PRIVATE",
      },
    });
    const response = await GET(request, { params });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.schemaVersion).toBe(1);
    expect(mocks.getRuntime).toHaveBeenCalledWith("test-agent");
    expect(body.representative).toEqual({
      slug: "test-agent",
      name: "Demo",
      ownerName: "Owner",
      tagline: "Public help",
    });
    expect(body.memoryDisclosure).toEqual({
      policyRevision: 3,
      fingerprint: "proof",
    });
    expect(body.disclosureText).toContain("长期记忆当前未启用");
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE|SECRET/);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each([
    ["en", "Long-term memory is enabled."],
    ["zh", "长期记忆已启用。"],
    ["", "长期记忆已启用。"],
  ])(
    "renders the current memory disclosure for lang=%s",
    async (lang, expected) => {
      mocks.getRuntime.mockResolvedValue({
        status: "available",
        setup: { name: "Demo", ownerName: "Owner", tagline: "Public help" },
        governedMemoryDisclosure: {
          enabled: true,
          shortTermMemoryEnabled: true,
          automaticExtractionEnabled: true,
          contactMemoryEnabled: true,
          contactMemoryCrossChannelEnabled: false,
          representativeExperienceEnabled: false,
          retentionDays: 30,
          expiryAction: "DELETE",
          policyRevision: 4,
          fingerprint: "current-policy",
        },
      });
      const response = await GET(
        new Request(`http://localhost/reps/test-agent/profile?lang=${lang}`),
        { params },
      );
      const body = await response.json();
      expect(body.disclosureText).toContain(expected);
      expect(body.disclosureText).toContain("30");
      expect(body.memoryDisclosure).toEqual({
        policyRevision: 4,
        fingerprint: "current-policy",
      });
    },
  );
  it("does not expose internal failure details", async () => {
    mocks.getRuntime.mockRejectedValue(
      new Error("SECRET database configuration"),
    );
    const response = await GET(request, { params });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("SECRET");
  });
});

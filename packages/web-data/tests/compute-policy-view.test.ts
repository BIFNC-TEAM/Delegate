import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ findRepresentative: vi.fn(), findVersion: vi.fn() }));
vi.mock("../src/prisma", () => ({ prisma: { representative: { findUnique: db.findRepresentative }, representativeVersion: { findFirst: db.findVersion } } }));
import { getRepresentativeComputePolicyView } from "../src/compute-policy-view";

const modes = { exec: "allow", read: "allow", write: "allow", process: "allow", browser: "allow", mcp: "allow" };
const compute = { enabled: true, defaultPolicyMode: "allow", baseImage: "test-image", maxSessionMinutes: 15, autoApproveTokenLimit: 1000,
  artifactRetentionDays: 14, networkMode: "full", networkAllowlist: [], filesystemMode: "workspace_only", capabilityModes: modes };
function fixture() {
  const version = { id: "version-3", versionNumber: 3, publishedAt: new Date("2026-09-28T00:00:00Z"), snapshot: { compute: structuredClone(compute) } };
  const row = { id: "rep", slug: "test", activeVersion: version, computeEnabled: true, computeDefaultPolicyMode: "ALLOW", computeBaseImage: "test-image",
    computeMaxSessionMinutes: 15, computeAutoApproveTokenLimit: 1000, computeArtifactRetentionDays: 14, computeNetworkMode: "FULL", computeNetworkAllowlist: [],
    computeFilesystemMode: "WORKSPACE_ONLY", capabilityProfiles: [{ rules: Object.keys(modes).map(capability => ({ id: `rep_${capability}_owner_mode`, decision: "ALLOW" })) }], mcpBindings: [] };
  db.findRepresentative.mockResolvedValue(row); db.findVersion.mockResolvedValue(version);
  return { row, version };
}

describe("Owner compute policy view using the actual authority resolver", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("DATABASE_URL", "postgresql://synthetic-unused"); });
  afterEach(() => vi.unstubAllEnvs());
  it("shows a published ASK despite current draft ALLOW and pins the observed version", async () => {
    const { version } = fixture(); version.snapshot.compute.capabilityModes.browser = "ask";
    const view = await getRepresentativeComputePolicyView("test");
    expect(view).toMatchObject({ state: "ready", publishedVersion: { id: "version-3", number: 3 }, runtimeCeiling: { capabilityModes: { browser: "ask", exec: "allow" } }, codeExecution: { available: false, reason: "code_execution_profile_unverified" } });
    expect(db.findVersion).toHaveBeenCalledWith({ where: { id: "version-3", representativeId: "rep" } });
  });
  it("reflects a saved live restriction and token limit without requiring republishing", async () => {
    const { row } = fixture(); row.computeAutoApproveTokenLimit = 0;
    row.capabilityProfiles[0]!.rules.find(rule => rule.id.endsWith("browser_owner_mode"))!.decision = "DENY";
    const view = await getRepresentativeComputePolicyView("test");
    expect(view?.runtimeCeiling).toMatchObject({ autoApproveTokenLimit: 0, capabilityModes: { browser: "deny" } });
  });
  it("shows the real fail-closed legacy version ceiling", async () => {
    const { version } = fixture(); version.snapshot = {} as typeof version.snapshot;
    expect((await getRepresentativeComputePolicyView("test"))?.runtimeCeiling).toMatchObject({ enabled: false, defaultPolicyMode: "deny" });
  });
  it("returns unpublished with no fictional effective settings", async () => {
    fixture(); db.findRepresentative.mockResolvedValue({ id: "rep", activeVersion: null });
    expect(await getRepresentativeComputePolicyView("test")).toMatchObject({ state: "unpublished", runtimeCeiling: null, publishedVersion: null });
    expect(db.findVersion).not.toHaveBeenCalled();
  });
  it("reports missing database configuration as unavailable, never demo authority", async () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(await getRepresentativeComputePolicyView("test")).toMatchObject({ state: "unavailable", runtimeCeiling: null });
    expect(db.findRepresentative).not.toHaveBeenCalled();
  });
  it("does not use a different version if the pinned record disappears during the read", async () => {
    fixture(); db.findVersion.mockResolvedValue(null);
    expect(await getRepresentativeComputePolicyView("test")).toMatchObject({ state: "unavailable", publishedVersion: { id: "version-3" }, runtimeCeiling: null });
  });
  it("returns null for a missing representative", async () => {
    db.findRepresentative.mockResolvedValue(null);
    expect(await getRepresentativeComputePolicyView("missing")).toBeNull(); expect(db.findVersion).not.toHaveBeenCalled();
  });
});

import { readFileSync } from "node:fs";

import { WorkspaceSkillSignatureStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  buildBuiltinWorkspaceSkillReleaseData,
  reconcileBuiltinWorkspaceSkillReleases,
} from "../src/builtin-skill-releases";

describe("built-in workspace skill releases", () => {
  it("marks executable built-ins as platform-trusted with complete runtime metadata", () => {
    expect(buildBuiltinWorkspaceSkillReleaseData({
      version: "1.0.0",
      executesCode: true,
      instructions: "Read the declared spreadsheet input.",
      instructionsSha256: "a".repeat(64),
      resources: ["skill://builtin/spreadsheet-analysis/1.0.0"],
    })).toMatchObject({
      provenanceDigest: "a".repeat(64),
      signatureStatus: WorkspaceSkillSignatureStatus.VERIFIED,
      registryTrustSource: "delegate_builtin",
      registryVerified: true,
      registryTrustEligible: true,
      registryTrustEvidence: {
        source: "delegate_builtin",
        version: "1.0.0",
        instructionsSha256: "a".repeat(64),
      },
      runtimeRequirements: {
        requiredBins: ["python"],
        requiredEnv: [],
        optionalEnv: [],
        networkMode: "no_network",
      },
      instructions: "Read the declared spreadsheet input.",
      instructionsSha256: "a".repeat(64),
      resources: ["skill://builtin/spreadsheet-analysis/1.0.0"],
    });
  });

  it("reconciles stale installed releases without touching unrelated packages", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });

    await expect(reconcileBuiltinWorkspaceSkillReleases({
      workspaceSkillRelease: { updateMany },
    } as never)).resolves.toEqual({ catalogSize: 1, updated: 2 });

    expect(updateMany).toHaveBeenCalledOnce();
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        status: "INSTALLED",
        version: "1.0.0",
        install: { skillPack: { source: "BUILTIN", slug: "spreadsheet-analysis" } },
      },
      data: {
        signatureStatus: "VERIFIED",
        registryTrustEligible: true,
        instructionsSha256: "4f6ca29ba9636c9a175fc47922fe77e275013d3f24567d3656cd2bf302715d1c",
      },
    });
  });

  it("uses the shared metadata builder for new representatives and seed reconciliation", () => {
    const representativeSetup = readFileSync(
      new URL("../src/representative-setup.ts", import.meta.url),
      "utf8",
    );
    const seed = readFileSync(new URL("../../../prisma/seed.ts", import.meta.url), "utf8");

    expect(representativeSetup).toContain("buildBuiltinWorkspaceSkillReleaseData({");
    expect(seed).toContain("reconcileBuiltinWorkspaceSkillReleases(client)");
  });
});

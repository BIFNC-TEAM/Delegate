import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const representativeRoutesRoot = new URL(
  "../app/api/dashboard/representatives/[slug]",
  import.meta.url,
);
const workspaceSkillsRoutesRoot = new URL(
  "../app/api/dashboard/skills",
  import.meta.url,
);
const workspaceAuditRoute = new URL(
  "../app/api/dashboard/audit/route.ts",
  import.meta.url,
);
const representativeSetupRoute = new URL(
  "../app/api/dashboard/representatives/[slug]/setup/route.ts",
  import.meta.url,
);
const legacyRepresentativeSkillsRoutesRoot = new URL(
  "../app/api/dashboard/representatives/[slug]/skill-packs",
  import.meta.url,
);
const approvalDecisionRoute = new URL(
  "../app/api/dashboard/representatives/[slug]/compute/approvals/[approvalId]/route.ts",
  import.meta.url,
);
const dashboardApiAuth = new URL(
  "../app/api/dashboard/auth.ts",
  import.meta.url,
);
const representativeVersionMutationRoutes = [
  new URL(
    "../app/api/dashboard/representatives/[slug]/versions/route.ts",
    import.meta.url,
  ),
  new URL(
    "../app/api/dashboard/representatives/[slug]/versions/[versionId]/activate/route.ts",
    import.meta.url,
  ),
];
const computePolicyMutationRoutes = [
  new URL(
    "../app/api/dashboard/representatives/[slug]/compute/governance/route.ts",
    import.meta.url,
  ),
  new URL(
    "../app/api/dashboard/representatives/[slug]/compute/policy-overlays/route.ts",
    import.meta.url,
  ),
];

describe("dashboard representative API auth coverage", () => {
  it("requires owner representative access on every slug-scoped route", () => {
    const routeFiles = collectRouteFiles(fileURLToPath(representativeRoutesRoot));

    expect(routeFiles.length).toBeGreaterThan(20);
    for (const routeFile of routeFiles) {
      const source = readFileSync(routeFile, "utf8");
      expect(source, routeFile).toMatch(
        /authorizeDashboardRepresentativeAccess|requireDashboardRepresentativeAccess/,
      );
    }
  });

  it("requires representative access on workspace skill reads and mutations", () => {
    const routeFiles = collectRouteFiles(fileURLToPath(workspaceSkillsRoutesRoot));

    expect(routeFiles).toHaveLength(5);
    for (const routeFile of routeFiles) {
      const source = readFileSync(routeFile, "utf8");
      expect(source, routeFile).toContain("requireDashboardRepresentativeAccess");
    }
  });

  it("applies domain-specific mutation permissions to skills, policies, and approvals", () => {
    for (const routeFile of collectRouteFiles(fileURLToPath(workspaceSkillsRoutesRoot))) {
      expect(readFileSync(routeFile, "utf8"), routeFile).toContain("assertOwnerCanManageSkills");
    }
    expect(readFileSync(representativeSetupRoute, "utf8")).toContain(
      "assertOwnerCanManageSkills",
    );
    for (const routeFile of computePolicyMutationRoutes) {
      expect(readFileSync(routeFile, "utf8"), routeFile.pathname).toContain(
        "assertOwnerCanManageSkills",
      );
      expect(readFileSync(routeFile, "utf8"), routeFile.pathname).toContain(
        "requireDashboardRepresentativeAccess",
      );
    }
    for (const routeFile of representativeVersionMutationRoutes) {
      expect(readFileSync(routeFile, "utf8"), routeFile.pathname).toContain(
        "assertOwnerCanManageSkills",
      );
      expect(readFileSync(routeFile, "utf8"), routeFile.pathname).toContain(
        "requireDashboardRepresentativeAccess",
      );
    }
    for (
      const routeFile of collectRouteFiles(
        fileURLToPath(legacyRepresentativeSkillsRoutesRoot),
      )
    ) {
      expect(readFileSync(routeFile, "utf8"), routeFile).toContain(
        "assertOwnerCanManageSkills",
      );
      expect(readFileSync(routeFile, "utf8"), routeFile).toContain(
        "requireDashboardRepresentativeAccess",
      );
    }
    expect(readFileSync(approvalDecisionRoute, "utf8")).toContain(
      "assertOwnerCanResolveApproval",
    );
  });

  it("requires representative access on the workspace audit feed", () => {
    expect(readFileSync(workspaceAuditRoute, "utf8")).toContain(
      "requireDashboardRepresentativeAccess",
    );
  });

  it("rejects signed owner sessions that do not identify an owner", () => {
    const source = readFileSync(dashboardApiAuth, "utf8");
    expect(source).toContain("if (session?.ownerId?.trim())");
    expect(source).toContain("if (!session && !shouldRequireCreatorDashboardAuth())");
    expect(source).not.toContain("if (session || !shouldRequireCreatorDashboardAuth())");
  });

  it("bounds representative version change summaries before publishing", () => {
    const source = readFileSync(representativeVersionMutationRoutes[0]!, "utf8");
    expect(source).toContain('typeof body.changeSummary !== "string"');
    expect(source).toContain("changeSummary.length > 1000");
    expect(source).toContain("...(changeSummary ? { changeSummary } : {})");
  });
});

function collectRouteFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = join(directory, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      return collectRouteFiles(fullPath);
    }
    return entry === "route.ts" ? [fullPath] : [];
  });
}

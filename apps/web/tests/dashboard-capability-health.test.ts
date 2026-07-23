import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const healthRoute = readFileSync(
  new URL(
    "../app/api/dashboard/representatives/[slug]/capability-health/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const skillsRoute = readFileSync(
  new URL("../app/api/dashboard/skills/route.ts", import.meta.url),
  "utf8",
);
const releaseRoute = readFileSync(
  new URL(
    "../app/api/dashboard/skills/[installId]/releases/[releaseId]/route.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("dashboard capability health contract", () => {
  it("requires representative access and disables response caching", () => {
    expect(healthRoute).toContain("requireDashboardRepresentativeAccess");
    expect(healthRoute).toContain("getWorkspaceCapabilityHealthSnapshot");
    expect(healthRoute).toContain('"Cache-Control", "private, no-store"');
    expect(healthRoute).not.toContain("error.message");
    expect(healthRoute).toContain(
      '{ error: "Failed to load capability health." }',
    );
  });

  it("records registry and release-review failures after auth errors are excluded", () => {
    expect(skillsRoute).toContain("recordWorkspaceCapabilityOperationFailure");
    expect(skillsRoute).toContain('operation: "skill_registry_sync"');
    expect(releaseRoute).toContain(
      "recordWorkspaceCapabilityOperationFailure",
    );
    expect(releaseRoute).toContain('operation: "skill_release_review"');
    expect(skillsRoute.indexOf("dashboardAuthErrorResponse(error)")).toBeLessThan(
      skillsRoute.indexOf("recordWorkspaceCapabilityOperationFailure({"),
    );
    expect(
      releaseRoute.indexOf("dashboardAuthErrorResponse(error)"),
    ).toBeLessThan(
      releaseRoute.indexOf("recordWorkspaceCapabilityOperationFailure({"),
    );
  });
});

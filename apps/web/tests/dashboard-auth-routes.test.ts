import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const representativeRoutesRoot = new URL(
  "../app/api/dashboard/representatives/[slug]",
  import.meta.url,
);

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

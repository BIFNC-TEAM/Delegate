import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const component = readFileSync(
  new URL("../app/dashboard/dashboard-compute.tsx", import.meta.url),
  "utf8",
);
const route = readFileSync(
  new URL("../app/api/dashboard/representatives/[slug]/compute/mcp/[bindingId]/route.ts", import.meta.url),
  "utf8",
);
const collectionRoute = readFileSync(
  new URL("../app/api/dashboard/representatives/[slug]/compute/mcp/route.ts", import.meta.url),
  "utf8",
);
const routeErrors = readFileSync(
  new URL("../app/api/dashboard/representatives/[slug]/compute/mcp/errors.ts", import.meta.url),
  "utf8",
);
const dataSource = readFileSync(
  new URL("../../../packages/web-data/src/compute.ts", import.meta.url),
  "utf8",
);
const skillsComponent = readFileSync(
  new URL("../app/dashboard/dashboard-skills.tsx", import.meta.url),
  "utf8",
);

describe("dashboard MCP optimistic concurrency", () => {
  it("sends the loaded binding timestamp on edits", () => {
    expect(component).toContain("expectedUpdatedAt: binding.updatedAt");
    expect(component).toContain("{ expectedUpdatedAt: mcpForm.expectedUpdatedAt }");
  });

  it("maps stale writes to an explicit conflict response", () => {
    expect(route).toContain("mcpBindingApiErrorResponse");
    expect(routeErrors).toContain("McpBindingConflictError");
    expect(routeErrors).toContain("{ status: error.statusCode }");
  });

  it("claims updates by id, representative, and loaded timestamp", () => {
    expect(dataSource).toContain("updateMcpBindingWithOptimisticLock");
    expect(dataSource).toContain("updatedAt: expectedUpdatedAt");
    expect(dataSource).toContain("const existingBinding = mutation.previous");
  });

  it("loads editable bindings without depending on Compute Broker preflight", () => {
    expect(collectionRoute).toContain("getRepresentativeMcpBindingsSnapshot");
    expect(collectionRoute).not.toContain("getRepresentativeComputeSnapshot");
    expect(dataSource).toContain("export async function getRepresentativeMcpBindingsSnapshot");
  });

  it("enforces the single-attempt MCP contract across API, persistence, and UI", () => {
    expect(route).toContain("maxRetries: 0");
    expect(collectionRoute).toContain("maxRetries: 0");
    expect(route).not.toContain("body.maxRetries");
    expect(collectionRoute).not.toContain("body.maxRetries");
    expect(dataSource).toContain("maxRetries: 0");
    expect(component).toContain("Side-effect safe mode");
    expect(component).toContain("副作用安全模式");
    expect(component).not.toContain("value={mcpForm.maxRetries}");
    expect(skillsComponent).toContain("Side-effect safe mode");
    expect(skillsComponent).toContain("副作用安全模式");
    expect(skillsComponent).toContain("maxRetries: 0");
  });
});

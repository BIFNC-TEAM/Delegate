import { readFileSync } from "node:fs";

import {
  ComputeBrokerError,
  McpBindingConflictError,
  McpBindingOperationError,
  WorkspaceSkillOperationError,
} from "@delegate/web-data";
import { describe, expect, it } from "vitest";

import { computeApprovalApiErrorResponse } from "../app/api/dashboard/representatives/[slug]/compute/approvals/errors";
import { mcpBindingApiErrorResponse } from "../app/api/dashboard/representatives/[slug]/compute/mcp/errors";
import { workspaceSkillApiErrorResponse } from "../app/api/dashboard/skills/errors";

async function jsonBody(response: Response) {
  return await response.json() as Record<string, unknown>;
}

describe("dashboard capability API error boundaries", () => {
  it("returns classified workspace-skill errors without exposing their private detail", async () => {
    const response = workspaceSkillApiErrorResponse(
      new WorkspaceSkillOperationError({
        code: "workspace_skill_registry_unavailable",
        message: "Registry fetch failed at https://registry.invalid/?token=secret",
        publicMessage: "The Registry trust check is temporarily unavailable.",
        statusCode: 503,
      }),
      "Failed to install workspace skill.",
    );

    expect(response.status).toBe(503);
    expect(await jsonBody(response)).toEqual({
      error: "The Registry trust check is temporarily unavailable.",
      code: "workspace_skill_registry_unavailable",
    });
  });

  it("maps unknown workspace-skill failures to a fixed 500 response", async () => {
    const response = workspaceSkillApiErrorResponse(
      new Error("postgresql://owner:secret@db.internal/workspace"),
      "Failed to update workspace skill.",
    );

    expect(response.status).toBe(500);
    expect(await jsonBody(response)).toEqual({
      error: "Failed to update workspace skill.",
    });
  });

  it("preserves MCP validation and conflict semantics while masking unknown failures", async () => {
    const invalid = mcpBindingApiErrorResponse(
      new McpBindingOperationError("The MCP server URL is invalid.", 400),
      "Failed to update MCP binding.",
    );
    const conflict = mcpBindingApiErrorResponse(
      new McpBindingConflictError("private loaded revision: 2026-07-23T12:00:00Z"),
      "Failed to update MCP binding.",
    );
    const unknown = mcpBindingApiErrorResponse(
      new Error("connect ECONNREFUSED 10.0.0.4:5432"),
      "Failed to update MCP binding.",
    );

    expect(invalid.status).toBe(400);
    expect(await jsonBody(invalid)).toEqual({ error: "The MCP server URL is invalid." });
    expect(conflict.status).toBe(409);
    expect(await jsonBody(conflict)).toEqual({
      error: "MCP binding changed since it was loaded. Refresh and retry.",
    });
    expect(unknown.status).toBe(500);
    expect(await jsonBody(unknown)).toEqual({ error: "Failed to update MCP binding." });
  });

  it("returns only classified approval errors and masks unknown failures", async () => {
    const skill = computeApprovalApiErrorResponse(
      new WorkspaceSkillOperationError({
        code: "workspace_skill_conflict",
        message: "Private decision state: candidate abc123 is stale",
        publicMessage: "The skill decision changed. Refresh and retry.",
        statusCode: 409,
      }),
    );
    const compute = computeApprovalApiErrorResponse(
      new ComputeBrokerError(
        "approval_request_already_resolved",
        409,
        "Approval is no longer pending.",
      ),
    );
    const unknown = computeApprovalApiErrorResponse(
      new Error("COMPUTE_BROKER_INTERNAL_TOKEN=secret"),
    );

    expect(skill.status).toBe(409);
    expect(await jsonBody(skill)).toEqual({
      error: "The skill decision changed. Refresh and retry.",
      code: "workspace_skill_conflict",
    });
    expect(compute.status).toBe(409);
    expect(await jsonBody(compute)).toEqual({ error: "Approval is no longer pending." });
    expect(unknown.status).toBe(500);
    expect(await jsonBody(unknown)).toEqual({ error: "Failed to resolve compute approval." });
  });

  it("keeps authorization handling ahead of capability error mapping in every route", () => {
    const routePaths = [
      "../app/api/dashboard/skills/route.ts",
      "../app/api/dashboard/skills/[installId]/route.ts",
      "../app/api/dashboard/skills/[installId]/policy/route.ts",
      "../app/api/dashboard/skills/[installId]/bindings/route.ts",
      "../app/api/dashboard/skills/[installId]/releases/[releaseId]/route.ts",
      "../app/api/dashboard/representatives/[slug]/compute/mcp/route.ts",
      "../app/api/dashboard/representatives/[slug]/compute/mcp/[bindingId]/route.ts",
      "../app/api/dashboard/representatives/[slug]/compute/approvals/[approvalId]/route.ts",
    ];

    for (const routePath of routePaths) {
      const source = readFileSync(new URL(routePath, import.meta.url), "utf8");
      const authBoundary = source.indexOf("dashboardAuthErrorResponse(error)");
      const classifiedBoundary = Math.max(
        source.lastIndexOf("workspaceSkillApiErrorResponse("),
        source.lastIndexOf("mcpBindingApiErrorResponse("),
        source.lastIndexOf("computeApprovalApiErrorResponse("),
      );
      expect(authBoundary, routePath).toBeGreaterThanOrEqual(0);
      expect(classifiedBoundary, routePath).toBeGreaterThan(authBoundary);
      expect(source, routePath).not.toContain("error instanceof Error ? error.message");
    }
  });

  it("marks sensitive capability GET responses private and non-cacheable", () => {
    const routePaths = [
      "../app/api/dashboard/representatives/[slug]/compute/approvals/route.ts",
      "../app/api/dashboard/representatives/[slug]/compute/mcp/route.ts",
      "../app/api/dashboard/skills/route.ts",
      "../app/api/registry/clawhub/skills/route.ts",
    ];

    for (const routePath of routePaths) {
      const source = readFileSync(new URL(routePath, import.meta.url), "utf8");
      expect(source, routePath).toContain("withPrivateNoStore");
    }

    const approvalsSource = readFileSync(
      new URL(
        "../app/api/dashboard/representatives/[slug]/compute/approvals/route.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(approvalsSource).toContain('{ error: "Failed to load compute approvals." }');
    expect(approvalsSource).not.toContain("error instanceof Error ? error.message");
  });
});

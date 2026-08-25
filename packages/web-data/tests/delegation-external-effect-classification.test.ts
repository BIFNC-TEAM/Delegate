import { describe, expect, it, vi } from "vitest";

import {
  describeDelegationExternalEffect,
  resolveDelegationPlanMcpBindingsInTransaction,
} from "../src/delegation-tasks";

const base = {
  displayTarget: "test",
  hasPaidEntitlement: false,
  maxSteps: 1,
} as const;

describe("delegation external-effect classification", () => {
  it("records MCP calls before execution", () => {
    expect(describeDelegationExternalEffect({
      ...base,
      capability: "mcp",
      browserMode: "deterministic",
      allowMutations: false,
      bindingSlug: "calendar",
      toolName: "create_event",
      toolArguments: {},
    }, "Create event")).toMatchObject({
      type: "mcp_tool_call",
      action: "invoke",
    });
  });

  it("records native browser mutations before execution", () => {
    expect(describeDelegationExternalEffect({
      ...base,
      capability: "browser",
      browserMode: "native",
      allowMutations: true,
      url: "https://example.com/publish",
    }, "Publish page")).toEqual({
      type: "browser_mutation",
      target: "https://example.com/publish",
      action: "mutate",
      idempotencyPrefix: "browser-mutation-effect",
    });
  });

  it("does not create an external-effect ledger for read-only browsing", () => {
    expect(describeDelegationExternalEffect({
      ...base,
      capability: "browser",
      browserMode: "deterministic",
      allowMutations: false,
      url: "https://example.com",
    }, "Read page")).toBeNull();
  });

  it("resolves an MCP slug to the representative-owned binding id", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "binding-calendar",
      slug: "calendar",
    });

    const [planned] = await resolveDelegationPlanMcpBindingsInTransaction(
      { representativeMcpBinding: { findFirst } } as never,
      "rep-1",
      [{
        summary: "Create event",
        request: {
          ...base,
          capability: "mcp",
          browserMode: "deterministic",
          allowMutations: false,
          bindingSlug: "calendar",
          toolName: "create_event",
          toolArguments: {},
        },
      }],
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        representativeId: "rep-1",
        enabled: true,
        slug: "calendar",
      },
      select: { id: true, slug: true },
    });
    expect(planned?.request).toMatchObject({
      bindingId: "binding-calendar",
      bindingSlug: "calendar",
    });
  });

  it("fails closed when the requested MCP binding is not authoritative", async () => {
    await expect(resolveDelegationPlanMcpBindingsInTransaction(
      {
        representativeMcpBinding: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      } as never,
      "rep-1",
      [{
        summary: "Create event",
        request: {
          ...base,
          capability: "mcp",
          browserMode: "deterministic",
          allowMutations: false,
          bindingSlug: "missing",
          toolArguments: {},
        },
      }],
    )).rejects.toThrow("unavailable or not authorized");
  });
});

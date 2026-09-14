import { describe, expect, it } from "vitest";

import { resolveServerOwnedMcpCapabilityPolicy } from "../src/mcp-server-policy";

describe("server-owned MCP policy", () => {
  it("classifies only the pinned Open-Meteo schema as read-only", () => {
    const policy = resolveServerOwnedMcpCapabilityPolicy({
      serverUrl: "https://open-meteo.caseyjhand.com/mcp",
      transportKind: "streamable_http",
      toolName: "openmeteo_get_forecast",
      toolSchemaHash:
        "2840c6995fddbdcfcc96c3548add6fe4fa75aa44e0768368d41a05ba826c0af0",
    });
    expect(policy).toMatchObject({
      policyId: "delegate.mcp.openmeteo.read.v1",
      effect: { boundary: "external", mutation: "none" },
      idempotency: "naturally_idempotent",
    });
    expect(resolveServerOwnedMcpCapabilityPolicy({
      serverUrl: "https://open-meteo.caseyjhand.com/mcp",
      transportKind: "streamable_http",
      toolName: "openmeteo_get_forecast",
      toolSchemaHash: "0".repeat(64),
    })).toBeNull();
  });

  it("accepts a compatible trusted read-only schema revision without trusting arbitrary tools", () => {
    expect(resolveServerOwnedMcpCapabilityPolicy({
      serverUrl: "https://open-meteo.caseyjhand.com/mcp",
      transportKind: "streamable_http",
      toolName: "openmeteo_get_forecast",
      toolSchemaHash: "1".repeat(64),
      inputSchema: {
        type: "object",
        properties: {
          latitude: { type: "number" },
          longitude: { type: "number" },
          current_variables: { type: "array", items: { type: "string" } },
        },
        required: ["latitude", "longitude"],
        additionalProperties: false,
      },
    })).toMatchObject({
      effect: { mutation: "none" },
      idempotency: "naturally_idempotent",
    });

    expect(resolveServerOwnedMcpCapabilityPolicy({
      serverUrl: "https://open-meteo.caseyjhand.com/mcp",
      transportKind: "streamable_http",
      toolName: "openmeteo_get_forecast",
      toolSchemaHash: "2".repeat(64),
      inputSchema: {
        type: "object",
        properties: {
          latitude: { type: "string" },
          longitude: { type: "number" },
        },
        required: ["latitude", "longitude"],
        additionalProperties: false,
      },
    })).toBeNull();
  });

  it("rejects an unregistered endpoint even when the tool name matches", () => {
    expect(resolveServerOwnedMcpCapabilityPolicy({
      serverUrl: "https://untrusted.example/mcp",
      transportKind: "streamable_http",
      toolName: "read_wiki_contents",
      toolSchemaHash:
        "3fc0be2454d2c65d3ff7a7be36bb9fb4903931cbb9bfac6042696d0caf42cb00",
    })).toBeNull();
  });
});

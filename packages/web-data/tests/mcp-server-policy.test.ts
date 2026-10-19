import { describe, expect, it } from "vitest";

import { projectMcpModelInputSchema, resolveServerOwnedMcpCapabilityPolicy } from "../src/mcp-server-policy";
import { fixtureRecoveryContract } from "../../../apps/compute-broker/tests/mcp-recovery-fixture";

describe("server-owned MCP policy", () => {
  it("classifies the observed official general search schema as a public read independently of approval", () => {
    const input = { serverUrl: "https://dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp", transportKind: "streamable_http",
      toolName: "search_pro", toolSchemaHash: "372e44b4012735c63ae94e82ea6265b389d98a6902e0b8e9b98e28937bdf9d94" };
    expect(resolveServerOwnedMcpCapabilityPolicy(input)).toMatchObject({ effect: { mutation: "none" }, resultAccess: "public_snapshot", idempotency: "naturally_idempotent" });
    for (const changed of [{ toolSchemaHash: "0".repeat(64) }, { toolName: "other" }, { transportKind: "sse" }, { serverUrl: input.serverUrl + "?redirect=other" }, { serverUrl: "https://untrusted.example/mcp" }]) {
      expect(resolveServerOwnedMcpCapabilityPolicy({ ...input, ...changed })).toBeNull();
    }
  });
  it("keeps provider-managed keys out of the model schema without changing the pinned schema", () => {
    const schema = { type: "object", properties: { amount: { type: "number" }, request_key: { type: "string" } }, required: ["amount", "request_key"] };
    const projected = projectMcpModelInputSchema(schema, { policyId: "synthetic", classificationVersion: "v1", idempotency: "idempotency_key",
      effect: { boundary: "external", mutation: "write", reversibility: "unknown" }, recoveryContract: fixtureRecoveryContract() });
    expect(projected).toEqual({ type: "object", properties: { amount: { type: "number" } }, required: ["amount"] });
    expect(schema.required).toEqual(["amount", "request_key"]); expect(schema.properties.request_key).toEqual({ type: "string" });
  });
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
      recoveryContract: { mode: "natural_read" },
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

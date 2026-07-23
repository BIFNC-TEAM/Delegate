import { describe, expect, it } from "vitest";

import {
  assertMcpJsonPayload,
  assertMcpToolList,
} from "../src/mcp-payload-limits";
import { SessionError } from "../src/session-error";

const jsonLimits = {
  maxBytes: 128,
  maxDepth: 4,
  maxNodes: 20,
};

describe("MCP payload limits", () => {
  it("accepts bounded JSON-safe arguments", () => {
    expect(assertMcpJsonPayload(
      { city: "Shanghai", options: [true, 3, null] },
      jsonLimits,
      {
        invalid: "mcp_tool_arguments_invalid",
        tooLarge: "mcp_tool_arguments_too_large",
        statusCode: 413,
        invalidStatusCode: 400,
      },
    )).toBeGreaterThan(0);
  });

  it.each([
    { value: { missing: undefined }, label: "undefined" },
    { value: { invalid: Number.NaN }, label: "non-finite number" },
    { value: { invalid: BigInt(1) }, label: "bigint" },
    { value: new Date(), label: "non-plain object" },
  ])("rejects non-JSON-safe $label values", ({ value }) => {
    expect(() => assertMcpJsonPayload(value, jsonLimits, {
      invalid: "mcp_tool_arguments_invalid",
      tooLarge: "mcp_tool_arguments_too_large",
      statusCode: 413,
      invalidStatusCode: 400,
    })).toThrowError(new SessionError(400, "mcp_tool_arguments_invalid"));
  });

  it("rejects cycles, excessive depth, node counts, and serialized bytes", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cases = [
      cyclic,
      { a: { b: { c: { d: { e: true } } } } },
      { values: Array.from({ length: 30 }, (_, index) => index) },
      { text: "x".repeat(256) },
    ];

    for (const value of cases) {
      expect(() => assertMcpJsonPayload(value, jsonLimits, {
        invalid: "mcp_tool_arguments_invalid",
        tooLarge: "mcp_tool_arguments_too_large",
        statusCode: 413,
        invalidStatusCode: 400,
      })).toThrow();
    }
  });

  it("bounds the remote tool list by item count and serialized size", () => {
    expect(() => assertMcpToolList(
      { tools: [{ name: "one" }, { name: "two" }] },
      { ...jsonLimits, maxItems: 1 },
    )).toThrowError(new SessionError(502, "mcp_tool_list_too_large"));

    expect(() => assertMcpToolList(
      { tools: [{ name: "x".repeat(256) }] },
      { ...jsonLimits, maxItems: 10 },
    )).toThrowError(new SessionError(502, "mcp_tool_list_too_large"));
  });
});

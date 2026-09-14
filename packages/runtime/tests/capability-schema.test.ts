import { describe, expect, it } from "vitest";

import {
  assertSupportedCapabilitySchema,
  deriveCapabilitySchema,
  stableSha256,
} from "../src/capability-schema";

describe("capability schema", () => {
  it("derives closed model input without mutating the provider schema", () => {
    const source = {
      type: "object",
      properties: {
        request: {
          type: "object",
          properties: { question: { type: "string" } },
        },
      },
      required: ["request"],
      "x-provider-metadata": true,
    };

    expect(deriveCapabilitySchema(source, { closeObjects: true })).toEqual({
      type: "object",
      properties: {
        request: {
          type: "object",
          properties: { question: { type: "string" } },
          additionalProperties: false,
        },
      },
      required: ["request"],
      additionalProperties: false,
    });
    expect(source).not.toHaveProperty("additionalProperties");
  });

  it("drops annotations but rejects unsupported input constraints", () => {
    const source = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        count: { type: "integer", default: 5, examples: [1, 5] },
      },
    };

    expect(deriveCapabilitySchema(source, { closeObjects: true })).toEqual({
      type: "object",
      properties: { count: { type: "integer" } },
      additionalProperties: false,
    });
    expect(() => deriveCapabilitySchema({
      type: "object",
      properties: {
        value: { type: "string", not: { const: "blocked" } },
      },
    }, { closeObjects: true })).toThrow("unsupported keyword not");
  });

  it("projects executor output and validates the bounded result", () => {
    const source = {
      type: "object",
      properties: {
        values: {
          type: "object",
          propertyNames: { type: "string" },
          additionalProperties: {},
        },
      },
      anyOf: [
        { not: { required: ["error"] }, required: ["values"] },
        { required: ["error"] },
      ],
    };
    const derived = deriveCapabilitySchema(source, {
      closeObjects: false,
      dropUnsupportedOutputKeywords: true,
    });

    expect(derived).toEqual({
      type: "object",
      properties: {
        values: { type: "object", additionalProperties: {} },
      },
      anyOf: [{ required: ["values"] }, { required: ["error"] }],
    });
    expect(() => assertSupportedCapabilitySchema(
      { type: "object", properties: {} },
      "input",
      true,
    )).toThrow("additionalProperties=false");
  });

  it("projects provider nullable output types without weakening input schemas", () => {
    const source = {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              elevation: {
                type: ["number", "null"],
                description: "Provider may omit elevation.",
              },
            },
          },
        },
      },
      unevaluatedProperties: false,
    };

    const derived = deriveCapabilitySchema(source, {
      closeObjects: false,
      dropUnsupportedOutputKeywords: true,
    });

    expect(derived).toEqual({
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              elevation: {
                anyOf: [{ type: "number" }, { type: "null" }],
                description: "Provider may omit elevation.",
              },
            },
          },
        },
      },
    });
    expect(() => assertSupportedCapabilitySchema(
      derived,
      "provider output",
      false,
    )).not.toThrow();
    expect(() => deriveCapabilitySchema({
      type: "object",
      properties: { value: { type: ["string", "null"] } },
    }, { closeObjects: true })).toThrow("unsupported union type");
  });

  it("hashes equivalent object key orders identically", () => {
    expect(stableSha256({ alpha: 1, beta: 2 })).toBe(
      stableSha256({ beta: 2, alpha: 1 }),
    );
  });
});

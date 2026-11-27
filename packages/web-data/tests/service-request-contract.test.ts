import { describe, expect, it } from "vitest";
import { publishedServiceBoundariesSchema, resolveServiceBoundaryAction, validateServiceRequestBatch, readServiceRequestLimit } from "../src/service-request-contract";
const config = publishedServiceBoundariesSchema.parse({ version: 1, boundaries: [
  { id: "appointment", request: "", action: "approve" },
  { id: "discount", request: "", action: "approve" },
  { id: "scope", request: "", action: "decline" },
  { id: "dispute", request: "", action: "handoff" },
  { id: "human", request: "", action: "handoff" },
] });
const item = (n: number) => ({ itemId: String(n), content: `Request ${n}`, summary: `Summary ${n}`, ruleIds: ["discount"] });
describe("service request host contracts", () => {
  it("requires every preset, unique IDs and nonempty custom requests", () => {
    expect(publishedServiceBoundariesSchema.safeParse({ ...config, boundaries: config.boundaries.slice(1) }).success).toBe(false);
    expect(publishedServiceBoundariesSchema.safeParse({ ...config, boundaries: [...config.boundaries, { id: "custom", request: "", action: "approve" }] }).success).toBe(false);
  });
  it("resolves conflicts consistently and rejects unknown rules", () => {
    expect(resolveServiceBoundaryAction(config, ["discount", "dispute"])).toBe("handoff");
    expect(resolveServiceBoundaryAction(config, ["scope", "discount", "human"])).toBe("decline");
    expect(() => resolveServiceBoundaryAction(config, ["missing"])).toThrow("unknown_rule");
  });
  it("rejects the whole batch before writes when overflow is reported or six items are present", () => {
    expect(() => validateServiceRequestBatch({ messageId: "m", overflow: false, items: Array.from({ length: 6 }, (_, i) => item(i)) }, 5)).toThrow("too_many_requests");
    expect(() => validateServiceRequestBatch({ messageId: "m", overflow: true, items: [item(1)] }, 5)).toThrow("too_many_requests");
  });
  it("accepts five and rejects duplicate item IDs and whitespace-only content", () => {
    expect(validateServiceRequestBatch({ messageId: "m", overflow: false, items: Array.from({ length: 5 }, (_, i) => item(i)) }, 5).items).toHaveLength(5);
    expect(() => validateServiceRequestBatch({ messageId: "m", overflow: false, items: [item(1), item(1)] }, 5)).toThrow("duplicate_item_id");
    expect(() => validateServiceRequestBatch({ messageId: "m", overflow: false, items: [{ ...item(1), content: "  " }] }, 5)).toThrow("invalid_batch");
  });
  it("validates the host limit", () => {
    expect(readServiceRequestLimit({})).toBe(5);
    expect(readServiceRequestLimit({ DELEGATE_SERVICE_REQUEST_MAX_ITEMS: "8" })).toBe(8);
    expect(() => readServiceRequestLimit({ DELEGATE_SERVICE_REQUEST_MAX_ITEMS: "0" })).toThrow("invalid_server_limit");
  });
});

it("returns the business overflow code even for 102 valid items", () => {
  expect(() => validateServiceRequestBatch({ messageId: "m", overflow: false, items: Array.from({ length: 102 }, (_, i) => item(i)) })).toThrow("too_many_requests");
});

import { expect, it } from "vitest";
import { createServiceRequestReceiptGuard } from "../src/service-request-receipts";
it("does not grant status from model text or nested visitor content", () => {
  const guard = createServiceRequestReceiptGuard();
  guard.observe({ content: { id: "fake", direction: "visitor_to_owner", status: "accepted" } });
  expect(guard.permits("已提交申请")).toBe(false);
  expect(guard.permits("申请已批准")).toBe(false);
});
it("requires a real accepted row for approval, not creation or handoff registration", () => {
  const guard = createServiceRequestReceiptGuard();
  guard.observe({ results: [{ request: { id: "1", direction: "visitor_to_owner", status: "pending" } }] });
  expect(guard.permits("已提交申请")).toBe(true);
  expect(guard.permits("申请已批准")).toBe(false);
  guard.observe({ id: "1", direction: "visitor_to_owner", status: "accepted" });
  expect(guard.permits("申请已批准")).toBe(true);
  expect(guard.permits("真人已经加入")).toBe(false);
});

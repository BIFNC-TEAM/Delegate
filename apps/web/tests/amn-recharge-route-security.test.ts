import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createMockRechargeOrder: vi.fn(),
  completeMockRechargeOrder: vi.fn(),
  requireDashboardBillingAccess: vi.fn(),
  dashboardAuthErrorResponse: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  createMockRechargeOrder: mocks.createMockRechargeOrder,
  completeMockRechargeOrder: mocks.completeMockRechargeOrder,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  requireDashboardBillingAccess: mocks.requireDashboardBillingAccess,
  dashboardAuthErrorResponse: mocks.dashboardAuthErrorResponse,
}));

import { POST as createRecharge } from "../app/api/amn/recharges/route";
import { POST as completeRecharge } from "../app/api/amn/recharges/[id]/mock-success/route";

const originalNodeEnv = process.env["NODE_ENV"];

describe("generic AMN mock recharge API security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreEnv("NODE_ENV", "development");
    mocks.requireDashboardBillingAccess.mockResolvedValue({ ownerId: "owner-1" });
    mocks.dashboardAuthErrorResponse.mockReturnValue(null);
  });

  afterEach(() => {
    restoreEnv("NODE_ENV", originalNodeEnv);
    vi.restoreAllMocks();
  });

  it("is unavailable in production before authorization or wallet access", async () => {
    restoreEnv("NODE_ENV", "production");

    const createResponse = await createRecharge(new Request(
      "http://localhost/api/amn/recharges",
      {
        method: "POST",
        body: JSON.stringify({ externalUserId: "user-1", amountCents: 1000 }),
      },
    ));
    const completeResponse = await completeRecharge(
      new Request("http://localhost/api/amn/recharges/order-1/mock-success", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "order-1" }) },
    );

    expect(createResponse.status).toBe(404);
    expect(completeResponse.status).toBe(404);
    expect(createResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(completeResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireDashboardBillingAccess).not.toHaveBeenCalled();
    expect(mocks.createMockRechargeOrder).not.toHaveBeenCalled();
    expect(mocks.completeMockRechargeOrder).not.toHaveBeenCalled();
  });

  it("authorizes before parsing or creating a recharge order", async () => {
    const authError = new Error("Authentication required.");
    mocks.requireDashboardBillingAccess.mockRejectedValue(authError);
    mocks.dashboardAuthErrorResponse.mockImplementation((error) => {
      if (error !== authError) return null;
      const response = Response.json(
        { error: "Authentication required." },
        { status: 401 },
      );
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    });

    const response = await createRecharge(new Request(
      "http://localhost/api/amn/recharges",
      { method: "POST", body: "not-json" },
    ));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.createMockRechargeOrder).not.toHaveBeenCalled();
  });

  it("creates an order only after billing authorization", async () => {
    mocks.createMockRechargeOrder.mockResolvedValue({
      id: "order-1",
      status: "requires_payment",
    });

    const response = await createRecharge(new Request(
      "http://localhost/api/amn/recharges",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalUserId: "user-1", amountCents: 1000 }),
      },
    ));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireDashboardBillingAccess).toHaveBeenCalledOnce();
    expect(mocks.createMockRechargeOrder).toHaveBeenCalledWith({
      externalUserId: "user-1",
      amountCents: 1000,
    });
  });

  it("does not expose service exception details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.completeMockRechargeOrder.mockRejectedValue(
      new Error("postgres://wallet:secret@private-host/delegate"),
    );

    const response = await completeRecharge(
      new Request("http://localhost/api/amn/recharges/order-1/mock-success", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "order-1" }) },
    );
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toContain("Failed to complete mock recharge.");
    expect(body).not.toContain("secret");
    expect(body).not.toContain("private-host");
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === "undefined") {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

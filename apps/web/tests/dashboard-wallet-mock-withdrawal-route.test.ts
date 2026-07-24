import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approveWithdrawRequest: vi.fn(),
  markWithdrawRequestFailed: vi.fn(),
  markWithdrawRequestPaid: vi.fn(),
  rejectWithdrawRequest: vi.fn(),
  requireDashboardBillingAccess: vi.fn(),
  dashboardAuthErrorResponse: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  approveWithdrawRequest: mocks.approveWithdrawRequest,
  markWithdrawRequestFailed: mocks.markWithdrawRequestFailed,
  markWithdrawRequestPaid: mocks.markWithdrawRequestPaid,
  rejectWithdrawRequest: mocks.rejectWithdrawRequest,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  dashboardAuthErrorResponse: mocks.dashboardAuthErrorResponse,
  requireDashboardBillingAccess: mocks.requireDashboardBillingAccess,
}));

import { POST } from "../app/api/dashboard/wallet/withdrawals/[withdrawalId]/mock-action/route";

const originalNodeEnv = process.env["NODE_ENV"];

describe("local mock withdrawal action API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreEnv("NODE_ENV", "development");
    mocks.requireDashboardBillingAccess.mockResolvedValue({
      ownerId: "owner-1",
    });
    mocks.dashboardAuthErrorResponse.mockReturnValue(null);
  });

  afterEach(() => {
    restoreEnv("NODE_ENV", originalNodeEnv);
    vi.restoreAllMocks();
  });

  it("is unavailable in production before authorization or wallet access", async () => {
    restoreEnv("NODE_ENV", "production");

    const response = await postAction({
      action: "approve",
      idempotencyKey: "approve-1",
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireDashboardBillingAccess).not.toHaveBeenCalled();
    expect(mocks.approveWithdrawRequest).not.toHaveBeenCalled();
  });

  it("authorizes before parsing the action body", async () => {
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

    const response = await POST(
      new Request(
        "http://localhost/api/dashboard/wallet/withdrawals/withdraw-1/mock-action",
        { method: "POST", body: "not-json" },
      ),
      { params: Promise.resolve({ withdrawalId: "withdraw-1" }) },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.approveWithdrawRequest).not.toHaveBeenCalled();
  });

  it("derives owner and reviewer identity from the authenticated session", async () => {
    mocks.approveWithdrawRequest.mockResolvedValue({
      id: "withdraw-1",
      status: "approved",
    });

    const response = await postAction({
      action: "approve",
      idempotencyKey: "approve-1",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.approveWithdrawRequest).toHaveBeenCalledWith({
      ownerId: "owner-1",
      withdrawRequestId: "withdraw-1",
      reviewedBy: "local-mock:owner-1",
      idempotencyKey: "approve-1",
    });
  });

  it("rejects caller-supplied owner or reviewer fields", async () => {
    const response = await postAction({
      action: "approve",
      idempotencyKey: "approve-spoof",
      ownerId: "owner-2",
      reviewedBy: "platform-admin",
    });

    expect(response.status).toBe(400);
    expect(mocks.approveWithdrawRequest).not.toHaveBeenCalled();
  });

  it("forces mock payout identity and derives a stable provider reference", async () => {
    mocks.markWithdrawRequestPaid.mockResolvedValue({
      id: "withdraw-1",
      status: "paid",
    });

    const response = await postAction({
      action: "mark_paid",
      idempotencyKey: "pay-1",
    });

    expect(response.status).toBe(200);
    expect(mocks.markWithdrawRequestPaid).toHaveBeenCalledWith({
      ownerId: "owner-1",
      withdrawRequestId: "withdraw-1",
      provider: "MOCK",
      providerPayoutId: "mock:withdraw-1:pay-1",
      idempotencyKey: "pay-1",
    });
  });

  it("defaults mock payout failures to transient unless permanent is explicit", async () => {
    mocks.markWithdrawRequestFailed.mockResolvedValue({
      id: "withdraw-1",
      status: "failed",
    });

    await postAction({
      action: "mark_failed",
      idempotencyKey: "fail-transient",
      reason: "provider timeout",
    });
    await postAction({
      action: "mark_failed",
      idempotencyKey: "fail-permanent",
      reason: "beneficiary account closed",
      permanent: true,
    });

    expect(mocks.markWithdrawRequestFailed).toHaveBeenNthCalledWith(1, {
      ownerId: "owner-1",
      withdrawRequestId: "withdraw-1",
      reason: "provider timeout",
      permanent: false,
      idempotencyKey: "fail-transient",
    });
    expect(mocks.markWithdrawRequestFailed).toHaveBeenNthCalledWith(2, {
      ownerId: "owner-1",
      withdrawRequestId: "withdraw-1",
      reason: "beneficiary account closed",
      permanent: true,
      idempotencyKey: "fail-permanent",
    });
  });

  it("redacts unexpected service errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.rejectWithdrawRequest.mockRejectedValue(
      new Error("postgres://wallet:secret@private-host/delegate"),
    );

    const response = await postAction({
      action: "reject",
      idempotencyKey: "reject-1",
      reason: "identity mismatch",
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toContain("Failed to apply local mock withdrawal action.");
    expect(body).not.toContain("secret");
    expect(body).not.toContain("private-host");
  });
});

function postAction(body: Record<string, unknown>) {
  return POST(
    new Request(
      "http://localhost/api/dashboard/wallet/withdrawals/withdraw-1/mock-action",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ withdrawalId: "withdraw-1" }) },
  );
}

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === "undefined") {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

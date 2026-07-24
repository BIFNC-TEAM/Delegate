import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class WalletIdempotencyConflictError extends Error {
    constructor() {
      super("Idempotency key was already used for a different withdrawal request.");
    }
  }
  return {
    WalletIdempotencyConflictError,
    assertOwnerCanAccessRepresentative: vi.fn(),
    cancelWithdrawRequest: vi.fn(),
    createWithdrawRequest: vi.fn(),
    dashboardAuthErrorResponse: vi.fn(),
    requireDashboardRepresentativeBillingAccess: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  WalletIdempotencyConflictError: mocks.WalletIdempotencyConflictError,
  assertOwnerCanAccessRepresentative:
    mocks.assertOwnerCanAccessRepresentative,
  cancelWithdrawRequest: mocks.cancelWithdrawRequest,
  createWithdrawRequest: mocks.createWithdrawRequest,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  dashboardAuthErrorResponse: mocks.dashboardAuthErrorResponse,
  requireDashboardRepresentativeBillingAccess:
    mocks.requireDashboardRepresentativeBillingAccess,
}));

import { POST as cancelWithdrawal } from "../app/api/dashboard/wallet/withdrawals/[withdrawalId]/cancel/route";
import { POST as createWithdrawal } from "../app/api/dashboard/wallet/withdrawals/route";

describe("dashboard wallet withdrawal routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDashboardRepresentativeBillingAccess.mockResolvedValue({
      ownerId: "owner-1",
    });
    mocks.assertOwnerCanAccessRepresentative.mockResolvedValue({
      id: "rep-target-id",
      slug: "target",
      ownerId: "owner-1",
    });
    mocks.dashboardAuthErrorResponse.mockReturnValue(null);
    mocks.createWithdrawRequest.mockResolvedValue({
      id: "withdraw-1",
      status: "pending_review",
    });
    mocks.cancelWithdrawRequest.mockResolvedValue({
      id: "withdraw-1",
      status: "canceled",
    });
  });

  it("authorizes the active representative and resolves the target slug server-side", async () => {
    const response = await createWithdrawal(new Request(
      "http://localhost/api/dashboard/wallet/withdrawals?rep=active",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          representativeSlug: "target",
          amountCents: 1250,
          currency: "cny",
          idempotencyKey: "withdraw-ui-1",
        }),
      },
    ));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireDashboardRepresentativeBillingAccess)
      .toHaveBeenCalledWith("active");
    expect(mocks.assertOwnerCanAccessRepresentative).toHaveBeenCalledWith({
      ownerId: "owner-1",
      representativeSlug: "target",
    });
    expect(mocks.createWithdrawRequest).toHaveBeenCalledWith({
      ownerId: "owner-1",
      representativeId: "rep-target-id",
      amountCents: 1250,
      currency: "CNY",
      idempotencyKey: "withdraw-ui-1",
    });
    await expect(response.json()).resolves.toEqual({
      withdrawal: {
        id: "withdraw-1",
        status: "pending_review",
      },
    });
  });

  it("rejects invalid money and currency before mutating the wallet", async () => {
    const response = await createWithdrawal(new Request(
      "http://localhost/api/dashboard/wallet/withdrawals?rep=active",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          representativeSlug: "target",
          amountCents: 12.5,
          currency: "EUR",
          idempotencyKey: "withdraw-ui-invalid",
        }),
      },
    ));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.assertOwnerCanAccessRepresentative).not.toHaveBeenCalled();
    expect(mocks.createWithdrawRequest).not.toHaveBeenCalled();
  });

  it("returns safe business conflicts without exposing unexpected failures", async () => {
    mocks.createWithdrawRequest.mockRejectedValueOnce(
      new Error("Insufficient withdrawable creator balance."),
    );
    const conflict = await createWithdrawal(withdrawalRequest());
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: "Insufficient withdrawable creator balance.",
    });

    mocks.createWithdrawRequest.mockRejectedValueOnce(
      new Error(
        "An active withdrawal request already exists for this representative and currency.",
      ),
    );
    const active = await createWithdrawal(withdrawalRequest());
    expect(active.status).toBe(409);

    mocks.createWithdrawRequest.mockRejectedValueOnce(
      new Error("postgres://owner:secret@private/wallet"),
    );
    const failure = await createWithdrawal(withdrawalRequest());
    const failureBody = await failure.text();
    expect(failure.status).toBe(500);
    expect(failureBody).toContain("Failed to update the withdrawal request.");
    expect(failureBody).not.toContain("secret");
    expect(failureBody).not.toContain("private");
  });

  it("lets the authenticated owner cancel their own active withdrawal", async () => {
    const response = await cancelWithdrawal(
      new Request(
        "http://localhost/api/dashboard/wallet/withdrawals/withdraw-1/cancel?rep=active",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: "dashboard-cancel:withdraw-1",
          }),
        },
      ),
      { params: Promise.resolve({ withdrawalId: "withdraw-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireDashboardRepresentativeBillingAccess)
      .toHaveBeenCalledWith("active");
    expect(mocks.cancelWithdrawRequest).toHaveBeenCalledWith({
      ownerId: "owner-1",
      withdrawRequestId: "withdraw-1",
      reason: "Canceled by creator.",
      idempotencyKey: "dashboard-cancel:withdraw-1",
    });
  });

  it("keeps missing and illegal cancellation states private", async () => {
    mocks.cancelWithdrawRequest.mockRejectedValueOnce(
      new Error("Withdrawal request not found."),
    );
    const missing = await cancelWithdrawal(
      cancelRequest(),
      { params: Promise.resolve({ withdrawalId: "missing" }) },
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");

    mocks.cancelWithdrawRequest.mockRejectedValueOnce(
      new Error("Illegal withdrawal transition: PAID -> CANCELED."),
    );
    const paid = await cancelWithdrawal(
      cancelRequest(),
      { params: Promise.resolve({ withdrawalId: "paid" }) },
    );
    expect(paid.status).toBe(409);
  });
});

function withdrawalRequest() {
  return new Request(
    "http://localhost/api/dashboard/wallet/withdrawals?rep=active",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        representativeSlug: "target",
        amountCents: 1250,
        currency: "CNY",
        idempotencyKey: "withdraw-ui-1",
      }),
    },
  );
}

function cancelRequest() {
  return new Request(
    "http://localhost/api/dashboard/wallet/withdrawals/id/cancel?rep=active",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "dashboard-cancel:id",
      }),
    },
  );
}

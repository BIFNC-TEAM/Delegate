import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class WalletExceptionActionError extends Error {
    code: string;
    statusCode: number;

    constructor(
      code: string,
      message: string,
      statusCode: number,
    ) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
    }
  }
  return {
    WalletExceptionActionError,
    actOnWalletExceptionCase: vi.fn(),
    dashboardAuthErrorResponse: vi.fn(),
    listWalletExceptionCases: vi.fn(),
    requireDashboardRepresentativeBillingAccess: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  WalletExceptionActionError:
    mocks.WalletExceptionActionError,
  actOnWalletExceptionCase:
    mocks.actOnWalletExceptionCase,
  listWalletExceptionCases:
    mocks.listWalletExceptionCases,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  dashboardAuthErrorResponse:
    mocks.dashboardAuthErrorResponse,
  requireDashboardRepresentativeBillingAccess:
    mocks.requireDashboardRepresentativeBillingAccess,
}));

import { GET } from "../app/api/dashboard/wallet/exceptions/route";
import { POST } from "../app/api/dashboard/wallet/exceptions/[caseId]/actions/route";

describe("dashboard wallet exception queue routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dashboardAuthErrorResponse.mockReturnValue(null);
    mocks.requireDashboardRepresentativeBillingAccess
      .mockResolvedValue({ ownerId: "owner-1" });
    mocks.listWalletExceptionCases.mockResolvedValue([
      caseView(),
    ]);
    mocks.actOnWalletExceptionCase.mockResolvedValue({
      ...caseView(),
      status: "claimed",
      version: 1,
      claimedByCurrentOwner: true,
    });
  });

  it("returns the Owner queue without internal source identifiers", async () => {
    const response = await GET(
      new Request(
        "http://delegate.test/api/dashboard/wallet/exceptions?rep=alpha",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control"))
      .toBe("private, no-store");
    expect(mocks.requireDashboardRepresentativeBillingAccess)
      .toHaveBeenCalledWith("alpha");
    expect(mocks.listWalletExceptionCases).toHaveBeenCalledWith({
      ownerId: "owner-1",
      representativeSlug: "alpha",
    });
    const body = await response.json();
    expect(body).toEqual({ cases: [caseView()] });
    expect(JSON.stringify(body)).not.toContain("outbox");
    expect(JSON.stringify(body)).not.toContain("refundId");
    expect(JSON.stringify(body)).not.toContain("sourceId");
  });

  it("applies a strict action contract and returns the safe case view", async () => {
    const response = await POST(
      new Request(
        "http://delegate.test/api/dashboard/wallet/exceptions/case-1/actions?rep=alpha",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "claim",
            expectedVersion: 0,
            idempotencyKey: "claim-1",
          }),
        },
      ),
      { params: Promise.resolve({ caseId: "case-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control"))
      .toBe("private, no-store");
    expect(mocks.actOnWalletExceptionCase).toHaveBeenCalledWith({
      caseId: "case-1",
      ownerId: "owner-1",
      representativeSlug: "alpha",
      action: "claim",
      expectedVersion: 0,
      idempotencyKey: "claim-1",
    });
    await expect(response.json()).resolves.toEqual({
      case: {
        ...caseView(),
        status: "claimed",
        version: 1,
        claimedByCurrentOwner: true,
      },
    });

    const invalid = await POST(
      new Request(
        "http://delegate.test/api/dashboard/wallet/exceptions/case-1/actions?rep=alpha",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "claim",
            expectedVersion: 0,
            idempotencyKey: "claim-2",
            unexpected: true,
          }),
        },
      ),
      { params: Promise.resolve({ caseId: "case-1" }) },
    );
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("cache-control"))
      .toBe("private, no-store");
  });

  it("maps action conflicts to stable private errors", async () => {
    mocks.actOnWalletExceptionCase.mockRejectedValueOnce(
      new mocks.WalletExceptionActionError(
        "wallet_exception_version_conflict",
        "The exception changed. Refresh before trying again.",
        409,
      ),
    );

    const response = await POST(
      actionRequest(),
      { params: Promise.resolve({ caseId: "case-1" }) },
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control"))
      .toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      code: "wallet_exception_version_conflict",
      error: "The exception changed. Refresh before trying again.",
    });
  });

  it("logs and returns only stable codes for unexpected failures", async () => {
    const consoleError = vi.spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.listWalletExceptionCases.mockRejectedValueOnce(
      new Error("database secret owner-123"),
    );
    mocks.actOnWalletExceptionCase.mockRejectedValueOnce(
      new Error("outbox payload secret"),
    );

    const getResponse = await GET(
      new Request(
        "http://delegate.test/api/dashboard/wallet/exceptions?rep=alpha",
      ),
    );
    const postResponse = await POST(
      actionRequest(),
      { params: Promise.resolve({ caseId: "case-1" }) },
    );

    expect(getResponse.status).toBe(500);
    expect(postResponse.status).toBe(500);
    expect(getResponse.headers.get("cache-control"))
      .toBe("private, no-store");
    expect(postResponse.headers.get("cache-control"))
      .toBe("private, no-store");
    const getBody = await getResponse.json();
    const postBody = await postResponse.json();
    expect(getBody).toEqual({
      code: "wallet_exception_queue_failed",
      error: "The wallet exception queue could not be loaded.",
    });
    expect(postBody).toEqual({
      code: "wallet_exception_action_failed",
      error: "The wallet exception action could not be applied.",
    });
    const logs = JSON.stringify(consoleError.mock.calls);
    expect(logs).toContain("wallet_exception_queue_failed");
    expect(logs).toContain("wallet_exception_action_failed");
    expect(logs).not.toContain("owner-123");
    expect(logs).not.toContain("payload secret");
    consoleError.mockRestore();
  });
});

function actionRequest() {
  return new Request(
    "http://delegate.test/api/dashboard/wallet/exceptions/case-1/actions?rep=alpha",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "claim",
        expectedVersion: 0,
        idempotencyKey: "claim-1",
      }),
    },
  );
}

function caseView() {
  return {
    id: "case-1",
    kind: "payment_reconciliation",
    reasonCode: "wechat_order_reconciliation_dead_letter",
    severity: "critical",
    status: "open",
    version: 0,
    representativeSlug: "beta",
    representativeName: "Beta",
    currency: "CNY",
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    retryable: true,
    claimedByCurrentOwner: false,
  };
}

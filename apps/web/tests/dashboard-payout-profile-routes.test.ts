import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CreatorPayoutProfileError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly statusCode: 400 | 403 | 404 | 409,
    ) {
      super(message);
    }
  }
  class PayoutDestinationCredentialError extends Error {}
  return {
    CreatorPayoutProfileError,
    PayoutDestinationCredentialError,
    activate: vi.fn(),
    createDestination: vi.fn(),
    disable: vi.fn(),
    getProfile: vi.fn(),
    requireBilling: vi.fn(),
    review: vi.fn(),
    submitProfile: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  CreatorPayoutProfileError: mocks.CreatorPayoutProfileError,
  PayoutDestinationCredentialError:
    mocks.PayoutDestinationCredentialError,
  activatePayoutDestinationLocally: mocks.activate,
  createTokenizedPayoutDestination: mocks.createDestination,
  disablePayoutDestinationLocally: mocks.disable,
  getCreatorPayoutProfile: mocks.getProfile,
  reviewCreatorPayoutProfileLocally: mocks.review,
  submitCreatorPayoutProfile: mocks.submitProfile,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  dashboardAuthErrorResponse: vi.fn(() => null),
  requireDashboardBillingAccess: mocks.requireBilling,
}));

import {
  GET,
  POST as submitProfile,
} from "../app/api/dashboard/wallet/payout-profile/route";
import { POST as applyMockAction } from "../app/api/dashboard/wallet/payout-profile/mock/route";

const profile = {
  id: "profile-1",
  subjectType: "owner",
  status: "pending_verification",
  version: 0,
  verifiedAt: null,
  rejectionReasonCode: null,
  suspendedAt: null,
  destinations: [],
};

describe("dashboard payout profile routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "test");
    mocks.requireBilling.mockResolvedValue({
      actor: "owner",
      ownerId: "owner-1",
    });
    mocks.getProfile.mockResolvedValue(profile);
    mocks.submitProfile.mockResolvedValue(profile);
    mocks.createDestination.mockResolvedValue({
      ...profile,
      destinations: [{
        id: "destination-1",
        maskedLabel: "微信账户 · 尾号 12",
      }],
    });
    mocks.review.mockResolvedValue(profile);
    mocks.activate.mockResolvedValue(profile);
    mocks.disable.mockResolvedValue(profile);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a private owner-scoped read model without credential material", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getProfile).toHaveBeenCalledWith({ ownerId: "owner-1" });
    const body = await response.text();
    expect(body).toContain("profile-1");
    expect(body).not.toMatch(
      /credentialCiphertext|credentialFingerprint|recipientToken/,
    );
  });

  it("strictly parses profile submission and forwards header idempotency", async () => {
    const response = await submitProfile(new Request(
      "http://localhost/api/dashboard/wallet/payout-profile",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "submit-profile-1",
          "X-Request-Id": "request-1",
        },
        body: JSON.stringify({ expectedVersion: 0 }),
      },
    ));

    expect(response.status).toBe(201);
    expect(mocks.submitProfile).toHaveBeenCalledWith({
      ownerId: "owner-1",
      expectedVersion: 0,
      idempotencyKey: "submit-profile-1",
    });
    await expect(response.json()).resolves.toMatchObject({
      profile: { id: "profile-1" },
      requestId: "request-1",
    });

    const invalid = await submitProfile(new Request(
      "http://localhost/api/dashboard/wallet/payout-profile",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: 0,
          ownerId: "spoofed-owner",
        }),
      },
    ));
    expect(invalid.status).toBe(400);
    expect(mocks.submitProfile).toHaveBeenCalledTimes(1);
  });

  it("keeps tokenized setup local-only and never echoes the token", async () => {
    const token = "opaque-provider-recipient-token";
    const response = await applyMockAction(new Request(
      "http://localhost/api/dashboard/wallet/payout-profile/mock",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "destination-1",
        },
        body: JSON.stringify({
          action: "create_destination",
          profileId: "profile-1",
          expectedProfileVersion: 0,
          recipientToken: token,
          providerMaskedLabel: "微信账户 · 尾号 12",
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.createDestination).toHaveBeenCalledWith({
      ownerId: "owner-1",
      profileId: "profile-1",
      expectedProfileVersion: 0,
      recipientToken: token,
      providerMaskedLabel: "微信账户 · 尾号 12",
      idempotencyKey: "destination-1",
    });
    expect(await response.text()).not.toContain(token);

    vi.stubEnv("NODE_ENV", "production");
    mocks.requireBilling.mockClear();
    const hidden = await applyMockAction(new Request(
      "https://delegate.example/api/dashboard/wallet/payout-profile/mock",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_destination" }),
      },
    ));
    expect(hidden.status).toBe(404);
    expect(mocks.requireBilling).not.toHaveBeenCalled();
  });

  it("uses server-derived owner and local reviewer identity", async () => {
    const response = await applyMockAction(new Request(
      "http://localhost/api/dashboard/wallet/payout-profile/mock",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "review-1",
        },
        body: JSON.stringify({
          action: "review",
          profileId: "profile-1",
          destinationId: "destination-1",
          decision: "approve",
          expectedProfileVersion: 1,
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.review).toHaveBeenCalledWith({
      ownerId: "owner-1",
      profileId: "profile-1",
      destinationId: "destination-1",
      decision: "approve",
      actorId: "local-mock:owner-1",
      expectedProfileVersion: 1,
      idempotencyKey: "review-1",
    });
  });
});

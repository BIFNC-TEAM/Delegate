import { AuthIdentityStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { runLogtoIdentityReconciliation } from "../src/logto-reconciliation";

const env = {
  LOGTO_ENDPOINT: "https://auth.example.com",
  LOGTO_MANAGEMENT_APP_ID: "app-id",
  LOGTO_MANAGEMENT_APP_SECRET: "app-secret",
};

describe("Logto Management API reconciliation", () => {
  it("stays disabled without M2M credentials", async () => {
    await expect(runLogtoIdentityReconciliation({ env: {} })).resolves.toEqual({
      enabled: false,
      processed: false,
      remoteUsers: 0,
      localIdentities: 0,
      suspended: 0,
      reactivated: 0,
      deletionPending: 0,
      unchanged: 0,
      revokedSessions: 0,
    });
  });

  it("repairs suspended, reactivated, and deleted local identities only after a complete remote listing", async () => {
    const dependencies = fixture();

    await expect(runLogtoIdentityReconciliation(
      { env, now: new Date("2026-08-26T04:00:00.000Z") },
      dependencies,
    )).resolves.toEqual({
      enabled: true,
      processed: true,
      remoteUsers: 3,
      localIdentities: 4,
      suspended: 1,
      reactivated: 1,
      deletionPending: 1,
      unchanged: 1,
      revokedSessions: 3,
    });
    expect(dependencies.applyState.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ providerSubject: "user-suspend", state: "SUSPENDED" }),
      expect.objectContaining({ providerSubject: "user-reactivate", state: "ACTIVE" }),
      expect.objectContaining({ providerSubject: "user-delete", state: "DELETED" }),
      expect.objectContaining({ providerSubject: "user-unchanged", state: "ACTIVE" }),
    ]);
    expect(dependencies.loadLocalIdentities).toHaveBeenCalledWith(
      "https://auth.example.com/oidc",
      new Date("2026-08-26T04:00:00.000Z"),
    );
    expect(dependencies.checkpointSucceeded).toHaveBeenCalledTimes(1);
  });

  it("records a failed checkpoint and never infers deletion from a partial remote failure", async () => {
    const dependencies = fixture();
    dependencies.listRemoteUsers.mockRejectedValue(
      new Error("Logto Management API users request failed with status 503."),
    );

    await expect(runLogtoIdentityReconciliation(
      { env, now: new Date("2026-08-26T04:00:00.000Z") },
      dependencies,
    )).rejects.toThrow("status 503");
    expect(dependencies.applyState).not.toHaveBeenCalled();
    expect(dependencies.checkpointFailed).toHaveBeenCalledWith(
      expect.any(Date),
      "logto_management_users_failed",
    );
  });
});

function fixture() {
  return {
    listRemoteUsers: vi.fn(async () => [
      { id: "user-suspend", isSuspended: true, updatedAt: 1 },
      { id: "user-reactivate", isSuspended: false, updatedAt: 2 },
      { id: "user-unchanged", isSuspended: false, updatedAt: 3 },
    ]),
    loadLocalIdentities: vi.fn(async () => [
      {
        issuer: "https://auth.example.com/oidc",
        subject: "user-suspend",
        status: AuthIdentityStatus.ACTIVE,
      },
      {
        issuer: "https://auth.example.com/oidc",
        subject: "user-reactivate",
        status: AuthIdentityStatus.SUSPENDED,
      },
      {
        issuer: "https://auth.example.com/oidc",
        subject: "user-delete",
        status: AuthIdentityStatus.ACTIVE,
      },
      {
        issuer: "https://auth.example.com/oidc",
        subject: "user-unchanged",
        status: AuthIdentityStatus.ACTIVE,
      },
    ]),
    applyState: vi.fn(async (input: { state: string; providerSubject: string }) => {
      if (input.providerSubject === "user-suspend") {
        return { status: "processed" as const, effect: "SUSPENDED" as const, revokedSessions: 1 };
      }
      if (input.providerSubject === "user-reactivate") {
        return { status: "processed" as const, effect: "REACTIVATED" as const, revokedSessions: 0 };
      }
      if (input.providerSubject === "user-delete") {
        return { status: "processed" as const, effect: "DELETION_PENDING" as const, revokedSessions: 2 };
      }
      return { status: "processed" as const, effect: "NO_CHANGE" as const, revokedSessions: 0 };
    }),
    checkpointStarted: vi.fn(async () => undefined),
    checkpointSucceeded: vi.fn(async () => undefined),
    checkpointFailed: vi.fn(async () => undefined),
  };
}

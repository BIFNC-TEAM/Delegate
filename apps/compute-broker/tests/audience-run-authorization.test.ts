import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@delegate/web-data", () => ({
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE:
    "agent-wallet:service-credit:v1",
  verifyAgentUsageEntitlementReservation: vi.fn(),
}));

const baseInput = {
  requestedBy: "audience",
  representativeId: "rep-1",
  contactId: "contact-1",
  conversationId: "conversation-1",
  generationRunId: "run-1",
} as const;

function activeIdentity() {
  return {
    id: "audience-1",
    status: "REGISTERED",
    mergedIntoId: null,
  };
}

function generationRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    status: "PROCESSING",
    conversationId: "conversation-1",
    runtimePolicySnapshot: null,
    conversation: {
      id: "conversation-1",
      representativeId: "rep-1",
      contactId: "contact-1",
      audienceIdentityId: "audience-1",
      audienceIdentity: activeIdentity(),
      contact: {
        id: "contact-1",
        audienceIdentityId: "audience-1",
        audienceIdentity: activeIdentity(),
      },
    },
    ...overrides,
  };
}

function activePlanAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-account-1",
    audienceIdentityId: "audience-1",
    representativeId: "rep-1",
    productCode: "plan:pass",
    status: "ACTIVE",
    reservedUnits: 1,
    expiresAt: null,
    ...overrides,
  };
}

function planEntry(
  action: "reserve" | "consume" | "release",
  overrides: Record<string, unknown> = {},
) {
  const account = activePlanAccount();
  return {
    id: `entry-${action}`,
    entitlementAccountId: account.id,
    generationRunId: "run-1",
    kind:
      action === "reserve"
        ? "RESERVE"
        : action === "consume"
          ? "CONSUME"
          : "RELEASE",
    units: 1,
    reservedAfter: action === "reserve" ? 1 : 0,
    idempotencyKey: `conversation-entitlement:run-1:1:${action}`,
    createdAt: new Date(`2026-07-24T00:00:0${action === "reserve" ? 1 : 2}.000Z`),
    entitlementAccount: account,
    ...overrides,
  };
}

function createClient(params: {
  run?: ReturnType<typeof generationRun> | null;
  entries?: Array<ReturnType<typeof planEntry>>;
  account?: ReturnType<typeof activePlanAccount> | null;
} = {}) {
  return {
    generationRun: {
      findUnique: vi.fn().mockResolvedValue(
        params.run === undefined ? generationRun() : params.run,
      ),
    },
    serviceEntitlementLedgerEntry: {
      findMany: vi.fn().mockResolvedValue(params.entries ?? []),
    },
    serviceEntitlementAccount: {
      findUnique: vi.fn().mockResolvedValue(params.account ?? null),
    },
  };
}

describe("audience generation-run authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not require a run authorization for owner or system sessions", async () => {
    const { requireAudienceGenerationRunAuthorization } =
      await import("../src/entitlements");
    const client = createClient();

    await expect(
      requireAudienceGenerationRunAuthorization(
        { ...baseInput, requestedBy: "owner" },
        client as never,
      ),
    ).resolves.toBeNull();
    expect(client.generationRun.findUnique).not.toHaveBeenCalled();
  });

  it("requires generationRunId for every audience session", async () => {
    const { requireAudienceGenerationRunAuthorization } =
      await import("../src/entitlements");

    await expect(
      requireAudienceGenerationRunAuthorization(
        { ...baseInput, generationRunId: null },
        createClient() as never,
      ),
    ).rejects.toThrow("audience_generation_run_required");
  });

  it("does not treat legacy conversation unlock fields as authorization", async () => {
    const { requireAudienceGenerationRunAuthorization } =
      await import("../src/entitlements");
    const client = createClient({
      run: generationRun({
        conversation: {
          ...generationRun().conversation,
          passUnlockedAt: new Date(),
          deepHelpUnlockedAt: new Date(),
        },
      }),
    });

    await expect(
      requireAudienceGenerationRunAuthorization(baseInput, client as never),
    ).rejects.toThrow("audience_generation_run_authorization_denied");
  });

  it("accepts only an active owned run's server-stored free marker", async () => {
    const { requireAudienceGenerationRunAuthorization } =
      await import("../src/entitlements");
    const client = createClient({
      run: generationRun({
        runtimePolicySnapshot: { billingMode: "free" },
      }),
    });
    const verifier = vi.fn();

    await expect(
      requireAudienceGenerationRunAuthorization(
        baseInput,
        client as never,
        verifier,
      ),
    ).resolves.toEqual({
      kind: "free",
      audienceIdentityId: "audience-1",
      generationRunId: "run-1",
      representativeId: "rep-1",
      productCode: null,
      activePlanTier: undefined,
      hasPaidEntitlement: false,
    });
    expect(verifier).not.toHaveBeenCalled();
    expect(
      client.serviceEntitlementLedgerEntry.findMany,
    ).not.toHaveBeenCalled();
  });

  it("accepts an active wallet reservation only after exact dual-ledger verification", async () => {
    const { requireAudienceGenerationRunAuthorization } =
      await import("../src/entitlements");
    const client = createClient({
      run: generationRun({
        runtimePolicySnapshot: {
          billingMode: "service_credit",
          walletReservation: {
            usageChargeId: "usage-1",
            tokenAmount: 2,
          },
        },
      }),
      account: activePlanAccount({
        id: "wallet-account-1",
        productCode: "agent-wallet:service-credit:v1",
        reservedUnits: 2,
      }),
    });
    const verifier = vi.fn().mockResolvedValue({
      usageChargeId: "usage-1",
      entitlementAccountId: "wallet-account-1",
      audienceIdentityId: "audience-1",
      representativeId: "rep-1",
      generationRunId: "run-1",
      reserveGenerationRunId: "run-1",
      tokenAmount: 2,
      productCode: "agent-wallet:service-credit:v1",
      reserveLedgerEntryId: "wallet-reserve-1",
    });

    await expect(
      requireAudienceGenerationRunAuthorization(
        baseInput,
        client as never,
        verifier,
      ),
    ).resolves.toMatchObject({
      kind: "wallet",
      audienceIdentityId: "audience-1",
      generationRunId: "run-1",
      activePlanTier: "pass",
    });
    expect(verifier).toHaveBeenCalledWith({
      usageChargeId: "usage-1",
      representativeId: "rep-1",
      generationRunId: "run-1",
      audienceIdentityId: "audience-1",
      tokenAmount: 2,
    });
  });

  it.each([
    ["a terminal wallet snapshot", "service_credit_settled"],
    ["a transferred wallet snapshot", "service_credit_transferred"],
    ["a released wallet snapshot", "service_credit_released"],
    ["an unknown billing snapshot", "legacy_paid"],
  ])("denies %s", async (_label, billingMode) => {
    const { requireAudienceGenerationRunAuthorization } =
      await import("../src/entitlements");
    const client = createClient({
      run: generationRun({
        runtimePolicySnapshot: {
          billingMode,
          walletReservation: {
            usageChargeId: "usage-1",
            tokenAmount: 1,
          },
        },
      }),
    });
    const verifier = vi.fn();

    await expect(
      requireAudienceGenerationRunAuthorization(
        baseInput,
        client as never,
        verifier,
      ),
    ).rejects.toThrow("audience_generation_run_authorization_denied");
    expect(verifier).not.toHaveBeenCalled();
  });

  it("accepts a transferred wallet reservation whose immutable reserve belongs to an earlier run", async () => {
    const { requireAudienceGenerationRunAuthorization } =
      await import("../src/entitlements");
    const client = createClient({
      run: generationRun({
        runtimePolicySnapshot: {
          billingMode: "service_credit",
          walletReservation: {
            usageChargeId: "usage-1",
            tokenAmount: 1,
          },
        },
      }),
      account: activePlanAccount({
        id: "wallet-account-1",
        productCode: "agent-wallet:service-credit:v1",
      }),
    });
    const verifier = vi.fn().mockResolvedValue({
      usageChargeId: "usage-1",
      entitlementAccountId: "wallet-account-1",
      audienceIdentityId: "audience-1",
      representativeId: "rep-1",
      generationRunId: "run-1",
      reserveGenerationRunId: "run-step-1",
      tokenAmount: 1,
      productCode: "agent-wallet:service-credit:v1",
      reserveLedgerEntryId: "wallet-reserve-1",
    });

    await expect(
      requireAudienceGenerationRunAuthorization(
        baseInput,
        client as never,
        verifier,
      ),
    ).resolves.toMatchObject({
      kind: "wallet",
      generationRunId: "run-1",
    });
  });

  it("does not let an unknown billing mode fall back to a plan ledger", async () => {
    const { requireAudienceGenerationRunAuthorization } =
      await import("../src/entitlements");
    const client = createClient({
      run: generationRun({
        runtimePolicySnapshot: { billingMode: "legacy_paid" },
      }),
      entries: [planEntry("reserve")],
    });

    await expect(
      requireAudienceGenerationRunAuthorization(baseInput, client as never),
    ).rejects.toThrow("audience_generation_run_authorization_denied");
    expect(
      client.serviceEntitlementLedgerEntry.findMany,
    ).not.toHaveBeenCalled();
  });

  it("accepts the latest active run-scoped plan reservation", async () => {
    const { requireAudienceGenerationRunAuthorization } =
      await import("../src/entitlements");
    const releasedReserve = planEntry("reserve");
    const released = planEntry("release");
    const active = planEntry("reserve", {
      id: "entry-reserve-2",
      idempotencyKey: "conversation-entitlement:run-1:2:reserve",
      createdAt: new Date("2026-07-24T00:00:03.000Z"),
      entitlementAccount: activePlanAccount({ productCode: "plan:deep_help" }),
    });
    active.entitlementAccountId = active.entitlementAccount.id;
    const client = createClient({
      entries: [releasedReserve, released, active],
    });

    await expect(
      requireAudienceGenerationRunAuthorization(baseInput, client as never),
    ).resolves.toMatchObject({
      kind: "plan",
      productCode: "plan:deep_help",
      activePlanTier: "deep_help",
    });
  });

  it.each(["consume", "release"] as const)(
    "denies a plan reservation after %s",
    async (terminalAction) => {
      const { requireAudienceGenerationRunAuthorization } =
        await import("../src/entitlements");
      const client = createClient({
        entries: [planEntry("reserve"), planEntry(terminalAction)],
      });

      await expect(
        requireAudienceGenerationRunAuthorization(baseInput, client as never),
      ).rejects.toThrow("audience_generation_run_authorization_denied");
    },
  );

  it("denies a new plan attempt after an earlier reservation was consumed", async () => {
    const { requireAudienceGenerationRunAuthorization } =
      await import("../src/entitlements");
    const secondReserve = planEntry("reserve", {
      id: "entry-reserve-2",
      idempotencyKey: "conversation-entitlement:run-1:2:reserve",
      createdAt: new Date("2026-07-24T00:00:03.000Z"),
    });
    const client = createClient({
      entries: [
        planEntry("reserve"),
        planEntry("consume"),
        secondReserve,
      ],
    });

    await expect(
      requireAudienceGenerationRunAuthorization(baseInput, client as never),
    ).rejects.toThrow("audience_generation_run_authorization_denied");
  });

  it("denies expired, frozen, and coordinate-mismatched plan accounts", async () => {
    const { requireAudienceGenerationRunAuthorization } =
      await import("../src/entitlements");
    const badAccounts = [
      activePlanAccount({ expiresAt: new Date("2000-01-01T00:00:00.000Z") }),
      activePlanAccount({ status: "FROZEN" }),
      activePlanAccount({ audienceIdentityId: "audience-other" }),
      activePlanAccount({ representativeId: "rep-other" }),
    ];

    for (const account of badAccounts) {
      const reserve = planEntry("reserve", {
        entitlementAccountId: account.id,
        entitlementAccount: account,
      });
      await expect(
        requireAudienceGenerationRunAuthorization(
          baseInput,
          createClient({ entries: [reserve] }) as never,
        ),
      ).rejects.toThrow("audience_generation_run_authorization_denied");
    }
  });

  it.each(["QUEUED", "COMPLETED", "FAILED", "CANCELED"])(
    "denies run status %s before reading any entitlement",
    async (status) => {
      const { requireAudienceGenerationRunAuthorization } =
        await import("../src/entitlements");
      const client = createClient({ run: generationRun({ status }) });

      await expect(
        requireAudienceGenerationRunAuthorization(baseInput, client as never),
      ).rejects.toThrow("audience_generation_run_authorization_denied");
      expect(
        client.serviceEntitlementLedgerEntry.findMany,
      ).not.toHaveBeenCalled();
    },
  );

  it("denies identity, contact, conversation, and representative mismatches", async () => {
    const { requireAudienceGenerationRunAuthorization } =
      await import("../src/entitlements");
    const mismatchedRuns = [
      generationRun({ conversationId: "conversation-other" }),
      generationRun({
        conversation: {
          ...generationRun().conversation,
          representativeId: "rep-other",
        },
      }),
      generationRun({
        conversation: {
          ...generationRun().conversation,
          contactId: "contact-other",
        },
      }),
      generationRun({
        conversation: {
          ...generationRun().conversation,
          audienceIdentityId: "audience-other",
        },
      }),
    ];

    for (const run of mismatchedRuns) {
      await expect(
        requireAudienceGenerationRunAuthorization(
          baseInput,
          createClient({ run }) as never,
        ),
      ).rejects.toThrow("audience_generation_run_authorization_denied");
    }
  });
});

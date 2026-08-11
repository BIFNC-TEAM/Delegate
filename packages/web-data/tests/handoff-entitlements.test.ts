import {
  BillingHandoffAllowance,
  BillingHandoffServiceLevel,
  HandoffEntitlementReservationState,
  HandoffEntitlementGrantStatus,
  HandoffStatus,
  RechargeOrderStatus,
  RepresentativeHandoffAccessMode,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  acceptConversationHandoffInTransaction,
  acceptHandoffRequestInTransaction,
  createOrReuseHandoffRequestInTransaction,
  getPurchasedHandoffEntitlementSummary,
  grantPurchasedHandoffEntitlement,
  resolveHandoffRequestInTransaction,
} from "../src/handoff-entitlements";

describe("purchased handoff entitlements", () => {
  it("grants limited access from the paid snapshot exactly once", async () => {
    const paidAt = new Date("2026-08-01T02:03:04.000Z");
    const client = new FakeHandoffEntitlementClient([
      paidServiceOrder({
        id: "recharge_limited",
        paidAt,
        allowance: "LIMITED",
        units: 3,
        serviceLevel: "PRIORITY",
        validityDays: 30,
      }),
    ]);

    const first = await grantPurchasedHandoffEntitlement(
      { rechargeOrderId: "recharge_limited" },
      client,
    );
    const replay = await grantPurchasedHandoffEntitlement(
      { rechargeOrderId: "recharge_limited" },
      client,
    );

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      rechargeOrderId: "recharge_limited",
      audienceIdentityId: "audience_1",
      representativeId: "rep_1",
      allowance: "LIMITED",
      serviceLevel: "PRIORITY",
      grantedUses: 3,
      remainingUses: 3,
      reservedUses: 0,
      consumedUses: 0,
      status: "ACTIVE",
      startsAt: paidAt.toISOString(),
      expiresAt: "2026-08-31T02:03:04.000Z",
    });
    expect(client.grants).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(1);
    expect(client.ledgerEntries[0]).toMatchObject({
      kind: "GRANT",
      uses: 3,
      remainingAfter: 3,
      reservedAfter: 0,
      consumedAfter: 0,
      idempotencyKey: "handoff-grant:recharge_limited",
    });
  });

  it("summarizes limited and unlimited active grants", async () => {
    const client = new FakeHandoffEntitlementClient([
      paidServiceOrder({
        id: "recharge_standard",
        allowance: "LIMITED",
        units: 2,
        serviceLevel: "STANDARD",
      }),
      paidServiceOrder({
        id: "recharge_unlimited",
        allowance: "UNLIMITED",
        units: null,
        serviceLevel: "PRIORITY",
      }),
    ]);
    await grantPurchasedHandoffEntitlement(
      { rechargeOrderId: "recharge_standard" },
      client,
    );
    await grantPurchasedHandoffEntitlement(
      { rechargeOrderId: "recharge_unlimited" },
      client,
    );

    const summary = await getPurchasedHandoffEntitlementSummary(
      { audienceIdentityId: "audience_1", representativeId: "rep_1" },
      client,
    );

    expect(summary).toMatchObject({
      hasUnlimited: true,
      limitedRemainingUses: 2,
      highestServiceLevel: "PRIORITY",
    });
    expect(summary.activeGrants).toHaveLength(2);
    expect(client.ledgerEntries[1]).toMatchObject({
      uses: 1,
      remainingAfter: null,
      metadata: expect.objectContaining({ unlimited: true }),
    });
  });

  it("does not create a grant for a service package with no handoff", async () => {
    const client = new FakeHandoffEntitlementClient([
      paidServiceOrder({
        id: "recharge_none",
        allowance: "NONE",
        units: null,
        serviceLevel: null,
        validityDays: null,
      }),
    ]);

    await expect(
      grantPurchasedHandoffEntitlement(
        { rechargeOrderId: "recharge_none" },
        client,
      ),
    ).resolves.toBeNull();
    expect(client.grants).toHaveLength(0);
    expect(client.ledgerEntries).toHaveLength(0);
  });

  it("does not expose a grant before its paid start time", async () => {
    const client = new FakeHandoffEntitlementClient([
      paidServiceOrder({
        id: "recharge_future",
        paidAt: new Date("2099-08-01T00:00:00.000Z"),
        allowance: "LIMITED",
        units: 2,
        serviceLevel: "PRIORITY",
      }),
    ]);
    await grantPurchasedHandoffEntitlement(
      { rechargeOrderId: "recharge_future" },
      client,
    );

    const summary = await getPurchasedHandoffEntitlementSummary(
      { audienceIdentityId: "audience_1", representativeId: "rep_1" },
      client,
    );

    expect(summary.activeGrants).toHaveLength(0);
    expect(summary.highestServiceLevel).toBeNull();
  });
});

describe("handoff request entitlement state machine", () => {
  it("reserves priority access before standard access and pins service level", async () => {
    const client = new FakeRuntimeHandoffClient({
      handoffAccessMode: RepresentativeHandoffAccessMode.PACKAGE_REQUIRED,
      grants: [
        runtimeGrant({
          id: "grant_standard",
          serviceLevel: BillingHandoffServiceLevel.STANDARD,
          expiresAt: new Date("2026-10-01T00:00:00.000Z"),
        }),
        runtimeGrant({
          id: "grant_priority",
          serviceLevel: BillingHandoffServiceLevel.PRIORITY,
          expiresAt: new Date("2026-11-01T00:00:00.000Z"),
        }),
      ],
    });

    const result = await client.transaction((tx) =>
      createOrReuseHandoffRequestInTransaction(requestDraft(), tx)
    );

    expect(result).toMatchObject({ outcome: "created", access: "package" });
    expect(result.request).toMatchObject({
      handoffEntitlementGrantId: "grant_priority",
      entitlementReservationState: "RESERVED",
      serviceLevelSnapshot: "PRIORITY",
      recommendedPriority: 67,
    });
    expect(client.grant("grant_priority")).toMatchObject({
      remainingUses: 1,
      reservedUses: 1,
      consumedUses: 0,
    });
    expect(client.grant("grant_standard")).toMatchObject({
      remainingUses: 2,
      reservedUses: 0,
    });
    expect(client.ledger).toEqual([
      expect.objectContaining({
        kind: "RESERVE",
        idempotencyKey: `handoff:${result.request!.id}:reserve`,
        remainingAfter: 1,
        reservedAfter: 1,
        consumedAfter: 0,
      }),
    ]);
  });

  it("reserves unlimited access without fabricating a remaining counter", async () => {
    const client = new FakeRuntimeHandoffClient({
      handoffAccessMode: RepresentativeHandoffAccessMode.PACKAGE_REQUIRED,
      grants: [runtimeGrant({
        id: "grant_unlimited",
        allowance: BillingHandoffAllowance.UNLIMITED,
        grantedUses: null,
        remainingUses: null,
      })],
    });

    const result = await client.transaction((tx) =>
      createOrReuseHandoffRequestInTransaction(requestDraft(), tx)
    );

    expect(result.request).not.toBeNull();
    expect(client.grant("grant_unlimited")).toMatchObject({
      remainingUses: null,
      reservedUses: 1,
      consumedUses: 0,
    });
  });

  it("consumes a limited reservation exactly once and exhausts the grant", async () => {
    const client = new FakeRuntimeHandoffClient({
      handoffAccessMode: RepresentativeHandoffAccessMode.PACKAGE_REQUIRED,
      grants: [runtimeGrant({
        id: "grant_last_use",
        grantedUses: 1,
        remainingUses: 1,
      })],
    });
    const reserved = await client.transaction((tx) =>
      createOrReuseHandoffRequestInTransaction(requestDraft(), tx)
    );
    if (!reserved.request) throw new Error("expected reserved request");

    const first = await client.transaction((tx) =>
      acceptHandoffRequestInTransaction({
        handoffRequestId: reserved.request!.id,
      }, tx)
    );
    const replay = await client.transaction((tx) =>
      acceptHandoffRequestInTransaction({
        handoffRequestId: reserved.request!.id,
      }, tx)
    );

    expect(first).toMatchObject({
      status: "ACCEPTED",
      entitlementReservationState: "CONSUMED",
      entitlementConsumedAt: expect.any(Date),
    });
    expect(replay).toEqual(first);
    expect(client.grant("grant_last_use")).toMatchObject({
      remainingUses: 0,
      reservedUses: 0,
      consumedUses: 1,
      status: "EXHAUSTED",
    });
    expect(client.ledger.map((row) => row.kind)).toEqual([
      "RESERVE",
      "CONSUME",
    ]);
  });

  it("releases a reservation exactly once while preserving consumed uses", async () => {
    const client = new FakeRuntimeHandoffClient({
      handoffAccessMode: RepresentativeHandoffAccessMode.PACKAGE_REQUIRED,
      grants: [runtimeGrant({ id: "grant_release" })],
    });
    const reserved = await client.transaction((tx) =>
      createOrReuseHandoffRequestInTransaction(requestDraft(), tx)
    );
    if (!reserved.request) throw new Error("expected reserved request");

    const first = await client.transaction((tx) =>
      resolveHandoffRequestInTransaction({
        handoffRequestId: reserved.request!.id,
        status: HandoffStatus.DECLINED,
        reason: "owner_declined",
      }, tx)
    );
    const replay = await client.transaction((tx) =>
      resolveHandoffRequestInTransaction({
        handoffRequestId: reserved.request!.id,
        status: HandoffStatus.DECLINED,
        reason: "owner_declined",
      }, tx)
    );

    expect(first).toMatchObject({
      status: "DECLINED",
      entitlementReservationState: "RELEASED",
      entitlementReleasedAt: expect.any(Date),
    });
    expect(replay).toEqual(first);
    expect(client.grant("grant_release")).toMatchObject({
      remainingUses: 2,
      reservedUses: 0,
      consumedUses: 0,
    });
    expect(client.ledger.map((row) => row.kind)).toEqual([
      "RESERVE",
      "RELEASE",
    ]);
  });

  it("closes an accepted request without restoring the consumed use", async () => {
    const client = new FakeRuntimeHandoffClient({
      handoffAccessMode: RepresentativeHandoffAccessMode.PACKAGE_REQUIRED,
      grants: [runtimeGrant({
        id: "grant_consumed_close",
        grantedUses: 1,
        remainingUses: 1,
      })],
    });
    const reserved = await client.transaction((tx) =>
      createOrReuseHandoffRequestInTransaction(requestDraft(), tx)
    );
    if (!reserved.request) throw new Error("expected reserved request");
    await client.transaction((tx) =>
      acceptHandoffRequestInTransaction({
        handoffRequestId: reserved.request!.id,
      }, tx)
    );

    const closed = await client.transaction((tx) =>
      resolveHandoffRequestInTransaction({
        handoffRequestId: reserved.request!.id,
        status: HandoffStatus.CLOSED,
        reason: "operator_returned_to_ai",
      }, tx)
    );

    expect(closed).toMatchObject({
      status: "CLOSED",
      entitlementReservationState: "CONSUMED",
    });
    expect(client.grant("grant_consumed_close")).toMatchObject({
      remainingUses: 0,
      reservedUses: 0,
      consumedUses: 1,
      status: "EXHAUSTED",
    });
    expect(client.ledger.map((row) => row.kind)).toEqual([
      "RESERVE",
      "CONSUME",
    ]);
  });

  it("does not create a placeholder request without a paid entitlement", async () => {
    const client = new FakeRuntimeHandoffClient({
      handoffAccessMode: RepresentativeHandoffAccessMode.PACKAGE_REQUIRED,
    });

    const result = await client.transaction((tx) =>
      createOrReuseHandoffRequestInTransaction(requestDraft(), tx)
    );

    expect(result).toEqual({
      outcome: "entitlement_required",
      request: null,
    });
    expect(client.requests).toHaveLength(0);
    expect(client.ledger).toHaveLength(0);
  });

  it("serializes concurrent creation and reserves only one use", async () => {
    const client = new FakeRuntimeHandoffClient({
      handoffAccessMode: RepresentativeHandoffAccessMode.PACKAGE_REQUIRED,
      grants: [runtimeGrant({ id: "grant_concurrent" })],
    });

    const [first, second] = await Promise.all([
      client.transaction((tx) =>
        createOrReuseHandoffRequestInTransaction(requestDraft(), tx)
      ),
      client.transaction((tx) =>
        createOrReuseHandoffRequestInTransaction(requestDraft(), tx)
      ),
    ]);

    expect([first.outcome, second.outcome].sort()).toEqual([
      "created",
      "reused",
    ]);
    expect(first.request?.id).toBe(second.request?.id);
    expect(client.requests).toHaveLength(1);
    expect(client.grant("grant_concurrent")).toMatchObject({
      remainingUses: 1,
      reservedUses: 1,
    });
    expect(client.advisoryLockCalls).toBe(2);
  });

  it("honors a purchased grant after live handoff settings are disabled", async () => {
    const client = new FakeRuntimeHandoffClient({
      humanInLoop: false,
      handoffAccessMode: RepresentativeHandoffAccessMode.FREE,
      grants: [runtimeGrant({
        id: "grant_late_payment",
        grantedUses: 1,
        remainingUses: 1,
      })],
    });

    const reserved = await client.transaction((tx) =>
      createOrReuseHandoffRequestInTransaction(requestDraft(), tx)
    );
    expect(reserved).toMatchObject({
      outcome: "created",
      access: "package",
      request: {
        handoffEntitlementGrantId: "grant_late_payment",
        entitlementReservationState: "RESERVED",
      },
    });

    const accepted = await client.transaction((tx) =>
      acceptConversationHandoffInTransaction({
        conversationId: "conversation_1",
        representativeId: "rep_1",
      }, tx)
    );
    expect(accepted).toMatchObject({
      status: "ACCEPTED",
      entitlementReservationState: "CONSUMED",
    });
    expect(client.grant("grant_late_payment")).toMatchObject({
      remainingUses: 0,
      reservedUses: 0,
      consumedUses: 1,
      status: "EXHAUSTED",
    });
  });
});

type HandoffOrder = ReturnType<typeof paidServiceOrder>;

function paidServiceOrder(input: {
  id: string;
  paidAt?: Date;
  allowance: "NONE" | "LIMITED" | "UNLIMITED";
  units: number | null;
  serviceLevel: "STANDARD" | "PRIORITY" | null;
  validityDays?: number | null;
}) {
  return {
    id: input.id,
    representativeId: "rep_1",
    billingPriceVersionId: `price_${input.id}`,
    productKindSnapshot: "SERVICE_PACKAGE",
    handoffAllowanceSnapshot: input.allowance,
    handoffUnitsSnapshot: input.units,
    handoffServiceLevelSnapshot: input.serviceLevel,
    handoffValidityDaysSnapshot:
      input.validityDays === undefined ? 30 : input.validityDays,
    status: RechargeOrderStatus.PAID,
    paidAt: input.paidAt ?? new Date("2026-08-01T00:00:00.000Z"),
    userWallet: { audienceIdentityId: "audience_1" },
  };
}

type HandoffGrant = {
  id: string;
  rechargeOrderId: string;
  audienceIdentityId: string;
  representativeId: string;
  billingPriceVersionId: string;
  allowance: BillingHandoffAllowance;
  serviceLevel: BillingHandoffServiceLevel;
  grantedUses: number | null;
  remainingUses: number | null;
  reservedUses: number;
  consumedUses: number;
  status: HandoffEntitlementGrantStatus;
  startsAt: Date;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

class FakeHandoffEntitlementClient {
  grants: HandoffGrant[] = [];
  ledgerEntries: Array<Record<string, unknown>> = [];

  constructor(private readonly orders: HandoffOrder[]) {}

  rechargeOrder = {
    findUnique: async (args: any) =>
      this.orders.find((order) => order.id === args.where.id) ?? null,
  };

  handoffEntitlementGrant = {
    findUnique: async (args: any) =>
      this.grants.find(
        (grant) => grant.rechargeOrderId === args.where.rechargeOrderId,
      ) ?? null,
    findMany: async (args: any) =>
      this.grants.filter(
        (grant) =>
          grant.audienceIdentityId === args.where.audienceIdentityId &&
          grant.representativeId === args.where.representativeId &&
          grant.status === args.where.status &&
          grant.startsAt <= args.where.startsAt.lte &&
          grant.expiresAt !== null &&
          grant.expiresAt > args.where.expiresAt.gt,
      ),
    create: async (args: any) => {
      const grant: HandoffGrant = {
        id: `handoff_grant_${this.grants.length + 1}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...args.data,
      };
      this.grants.push(grant);
      return grant;
    },
  };

  handoffEntitlementLedgerEntry = {
    create: async (args: any) => {
      const row = {
        id: `handoff_ledger_${this.ledgerEntries.length + 1}`,
        ...args.data,
      };
      this.ledgerEntries.push(row);
      return row;
    },
  };
}

function requestDraft() {
  return {
    representativeId: "rep_1",
    contactId: "contact_1",
    conversationId: "conversation_1",
    episodeId: "episode_1",
    reason: "User requested a human",
    summary: "The user needs owner follow-up.",
    recommendedPriority: 67,
    recommendedOwnerAction: "Review and take over.",
  };
}

function runtimeGrant(overrides: Partial<HandoffGrant> = {}): HandoffGrant {
  return {
    id: "grant_1",
    rechargeOrderId: "recharge_1",
    audienceIdentityId: "audience_1",
    representativeId: "rep_1",
    billingPriceVersionId: "price_1",
    allowance: BillingHandoffAllowance.LIMITED,
    serviceLevel: BillingHandoffServiceLevel.STANDARD,
    grantedUses: 2,
    remainingUses: 2,
    reservedUses: 0,
    consumedUses: 0,
    status: HandoffEntitlementGrantStatus.ACTIVE,
    startsAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

class FakeRuntimeHandoffClient {
  grants: HandoffGrant[];
  requests: Array<Record<string, any>> = [];
  ledger: Array<Record<string, any>> = [];
  advisoryLockCalls = 0;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    handoffAccessMode: RepresentativeHandoffAccessMode;
    humanInLoop?: boolean;
    grants?: HandoffGrant[];
  }) {
    this.grants = options.grants?.map((grant) => ({ ...grant })) ?? [];
  }

  async transaction<T>(operation: (tx: never) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release = () => {};
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation(this as never);
    } finally {
      release();
    }
  }

  grant(id: string): HandoffGrant {
    const grant = this.grants.find((candidate) => candidate.id === id);
    if (!grant) throw new Error(`missing grant ${id}`);
    return grant;
  }

  $executeRaw = async () => {
    this.advisoryLockCalls += 1;
    return 0;
  };

  contact = {
    findUnique: async ({ where }: any) =>
      where.id === "contact_1"
        ? {
            representativeId: "rep_1",
            audienceIdentityId: "audience_1",
          }
        : null,
  };

  representative = {
    findUnique: async ({ where }: any) =>
      where.id === "rep_1"
        ? {
            humanInLoop: this.options.humanInLoop ?? true,
            handoffAccessMode: this.options.handoffAccessMode,
          }
        : null,
  };

  conversation = {
    findUnique: async ({ where }: any) =>
      where.id === "conversation_1"
        ? {
            id: "conversation_1",
            representativeId: "rep_1",
            contactId: "contact_1",
            audienceIdentityId: "audience_1",
            representative: {
              humanInLoop: this.options.humanInLoop ?? true,
              handoffAccessMode: this.options.handoffAccessMode,
            },
          }
        : null,
  };

  handoffRequest = {
    findFirst: async ({ where }: any) =>
      this.requests.find((request) => this.requestMatches(request, where))
        ?? null,
    findUnique: async ({ where }: any) =>
      this.requests.find((request) => request.id === where.id) ?? null,
    findUniqueOrThrow: async ({ where }: any) => {
      const request = this.requests.find((candidate) => candidate.id === where.id);
      if (!request) throw new Error(`missing request ${where.id}`);
      return request;
    },
    create: async ({ data }: any) => {
      const now = new Date();
      const request = {
        id: `handoff_${this.requests.length + 1}`,
        representativeId: data.representativeId,
        contactId: data.contactId,
        audienceIdentityId: data.audienceIdentityId ?? null,
        conversationId: data.conversationId ?? null,
        episodeId: data.episodeId ?? null,
        intakeSubmissionId: data.intakeSubmissionId ?? null,
        handoffEntitlementGrantId: data.handoffEntitlementGrantId ?? null,
        reason: data.reason,
        summary: data.summary,
        recommendedPriority: data.recommendedPriority,
        recommendedOwnerAction: data.recommendedOwnerAction,
        status: data.status ?? HandoffStatus.OPEN,
        entitlementReservationState:
          data.entitlementReservationState ?? null,
        serviceLevelSnapshot: data.serviceLevelSnapshot ?? null,
        entitlementReservedAt: data.entitlementReservedAt ?? null,
        entitlementConsumedAt: data.entitlementConsumedAt ?? null,
        entitlementReleasedAt: data.entitlementReleasedAt ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.requests.push(request);
      return request;
    },
    update: async ({ where, data }: any) => {
      const request = this.requests.find((candidate) => candidate.id === where.id);
      if (!request) throw new Error(`missing request ${where.id}`);
      Object.assign(request, data, { updatedAt: new Date() });
      return request;
    },
  };

  handoffEntitlementGrant = {
    findMany: async ({ where }: any) =>
      this.grants
        .filter((grant) =>
          grant.audienceIdentityId === where.audienceIdentityId
          && grant.representativeId === where.representativeId
          && grant.status === where.status
          && grant.startsAt <= where.startsAt.lte
          && grant.expiresAt !== null
          && grant.expiresAt > where.expiresAt.gt
          && (
            grant.allowance === BillingHandoffAllowance.UNLIMITED
            || (grant.remainingUses ?? 0) > 0
          )
        )
        .sort((left, right) => {
          const serviceDifference = serviceRank(right.serviceLevel)
            - serviceRank(left.serviceLevel);
          if (serviceDifference) return serviceDifference;
          return left.expiresAt!.getTime() - right.expiresAt!.getTime();
        }),
    findUniqueOrThrow: async ({ where }: any) => ({ ...this.grant(where.id) }),
    updateMany: async ({ where, data }: any) => {
      const grant = this.grants.find((candidate) => candidate.id === where.id);
      if (!grant || !this.grantMatches(grant, where)) return { count: 0 };
      applyAtomicNumber(grant, "remainingUses", data.remainingUses);
      applyAtomicNumber(grant, "reservedUses", data.reservedUses);
      applyAtomicNumber(grant, "consumedUses", data.consumedUses);
      if (data.status) grant.status = data.status;
      grant.updatedAt = new Date();
      return { count: 1 };
    },
  };

  handoffEntitlementLedgerEntry = {
    create: async ({ data }: any) => {
      if (this.ledger.some((row) => row.idempotencyKey === data.idempotencyKey)) {
        throw new Error("duplicate ledger idempotency key");
      }
      const row = { id: `ledger_${this.ledger.length + 1}`, ...data };
      this.ledger.push(row);
      return row;
    },
  };

  private requestMatches(request: Record<string, any>, where: any): boolean {
    return (
      (!where.representativeId
        || request.representativeId === where.representativeId)
      && (!where.contactId || request.contactId === where.contactId)
      && (where.audienceIdentityId === undefined
        || request.audienceIdentityId === where.audienceIdentityId)
      && (!where.conversationId
        || request.conversationId === where.conversationId)
      && (!where.status?.in || where.status.in.includes(request.status))
    );
  }

  private grantMatches(grant: HandoffGrant, where: any): boolean {
    return (
      (!where.status || grant.status === where.status)
      && (!where.allowance || grant.allowance === where.allowance)
      && (!where.startsAt?.lte || grant.startsAt <= where.startsAt.lte)
      && (!where.expiresAt?.gt
        || (grant.expiresAt !== null && grant.expiresAt > where.expiresAt.gt))
      && (!where.remainingUses?.gt
        || (grant.remainingUses ?? 0) > where.remainingUses.gt)
      && (!where.reservedUses?.gt
        || grant.reservedUses > where.reservedUses.gt)
    );
  }
}

function serviceRank(level: BillingHandoffServiceLevel): number {
  return level === BillingHandoffServiceLevel.PRIORITY ? 2 : 1;
}

function applyAtomicNumber(
  row: Record<string, any>,
  key: "remainingUses" | "reservedUses" | "consumedUses",
  mutation: { increment?: number; decrement?: number } | undefined,
) {
  if (!mutation) return;
  const current = row[key];
  if (typeof current !== "number") return;
  row[key] = current + (mutation.increment ?? 0) - (mutation.decrement ?? 0);
}

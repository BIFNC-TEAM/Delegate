import {
  ReliableEventStatus,
  WalletExceptionCaseStatus,
  WalletExceptionSeverity,
  WalletExceptionSourceType,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  actOnWalletExceptionCase,
  listWalletExceptionCases,
  syncWeChatPayWalletExceptionCases,
  WalletExceptionActionError,
} from "../src/wallet-exceptions";
import type { prisma } from "../src/prisma";

const fixedNow = new Date("2026-07-28T10:00:00.000Z");

describe("wallet exception owner queue", () => {
  it("uses rep only as an Owner billing anchor and lists all of that Owner's representatives", async () => {
    const first = exceptionCase({
      id: "case-a",
      representativeId: "rep-a",
      representativeSlug: "alpha",
      representativeName: "Alpha",
    });
    const second = exceptionCase({
      id: "case-b",
      representativeId: "rep-b",
      representativeSlug: "beta",
      representativeName: "Beta",
    });
    const findMany = vi.fn(async () => [first, second]);
    const client = {
      representative: {
        findFirst: vi.fn(async () => ({ id: "rep-a" })),
      },
      walletExceptionCase: { findMany },
    };

    const cases = await listWalletExceptionCases({
      ownerId: "owner-1",
      representativeSlug: "alpha",
      client: client as unknown as typeof prisma,
    });

    expect(cases.map((item) => item.representativeSlug))
      .toEqual(["alpha", "beta"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ownerId: "owner-1",
          status: { not: WalletExceptionCaseStatus.RESOLVED },
        },
      }),
    );
    expect(JSON.stringify(cases)).not.toContain("outbox-1");
    expect(JSON.stringify(cases)).not.toContain("refund-1");
  });

  it("does not create owner cases from unmatched provider events", async () => {
    const upsert = vi.fn(async () => undefined);
    const client = {
      outboxEvent: {
        findMany: vi.fn(async () => []),
      },
      rechargeOrder: {
        findMany: vi.fn(async () => []),
      },
      rechargeRefund: {
        findMany: vi.fn(async () => []),
      },
      walletExceptionCase: {
        findMany: vi.fn(async () => []),
        upsert,
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      paymentProviderEvent: {
        findMany: vi.fn(async () => {
          throw new Error(
            "unmatched events must not be owner-scoped",
          );
        }),
      },
    };

    await expect(
      syncWeChatPayWalletExceptionCases({
        client: client as unknown as typeof prisma,
        now: fixedNow,
      }),
    ).resolves.toEqual({ detected: 0, resolved: 0 });
    expect(upsert).not.toHaveBeenCalled();
    expect(client.paymentProviderEvent.findMany)
      .not.toHaveBeenCalled();
  });
});

describe("wallet exception actions", () => {
  it("allows a billing anchor to claim another representative's case and replays the same action before version checks", async () => {
    const fake = new WalletExceptionFake();
    const request = {
      caseId: fake.caseState.id,
      ownerId: "owner-1",
      representativeSlug: "alpha",
      action: "claim" as const,
      expectedVersion: 0,
      idempotencyKey: "claim-once",
    };

    const first = await actOnWalletExceptionCase(request, {
      client: fake.client(),
      now: fixedNow,
    });
    const replay = await actOnWalletExceptionCase(request, {
      client: fake.client(),
      now: fixedNow,
    });

    expect(first).toMatchObject({
      status: "claimed",
      version: 1,
      representativeSlug: "beta",
      claimedByCurrentOwner: true,
    });
    expect(replay).toEqual(first);
    expect(fake.actions).toHaveLength(1);
  });

  it("enforces CAS and the claim-before-retry/acknowledge state machine", async () => {
    const fake = new WalletExceptionFake();

    await expect(
      actOnWalletExceptionCase({
        caseId: fake.caseState.id,
        ownerId: "owner-1",
        representativeSlug: "alpha",
        action: "retry",
        expectedVersion: 0,
        idempotencyKey: "retry-without-claim",
      }, {
        client: fake.client(),
        now: fixedNow,
      }),
    ).rejects.toMatchObject({
      code: "wallet_exception_state_conflict",
      statusCode: 409,
    });
    expect(fake.outboxUpdates).toHaveLength(0);

    await actOnWalletExceptionCase({
      caseId: fake.caseState.id,
      ownerId: "owner-1",
      representativeSlug: "alpha",
      action: "claim",
      expectedVersion: 0,
      idempotencyKey: "claim",
    }, {
      client: fake.client(),
      now: fixedNow,
    });

    await expect(
      actOnWalletExceptionCase({
        caseId: fake.caseState.id,
        ownerId: "owner-1",
        representativeSlug: "alpha",
        action: "acknowledge",
        expectedVersion: 0,
        idempotencyKey: "stale-ack",
        note: "reviewed",
      }, {
        client: fake.client(),
        now: fixedNow,
      }),
    ).rejects.toMatchObject({
      code: "wallet_exception_version_conflict",
      statusCode: 409,
    });
    expect(fake.actions).toHaveLength(1);
  });

  it("retries only the exactly bound failed Outbox without any ledger mutation", async () => {
    const fake = new WalletExceptionFake({
      status: WalletExceptionCaseStatus.CLAIMED,
      claimedByOwnerId: "owner-1",
      version: 3,
    });

    const result = await actOnWalletExceptionCase({
      caseId: fake.caseState.id,
      ownerId: "owner-1",
      representativeSlug: "alpha",
      action: "retry",
      expectedVersion: 3,
      idempotencyKey: "retry-exact-outbox",
    }, {
      client: fake.client(),
      now: fixedNow,
    });

    expect(result).toMatchObject({
      status: "claimed",
      version: 4,
      retryable: false,
    });
    expect(fake.outboxUpdates).toEqual([
      {
        where: {
          id: "outbox-1",
          status: {
            in: [
              ReliableEventStatus.FAILED,
              ReliableEventStatus.DEAD_LETTER,
            ],
          },
        },
        data: {
          status: ReliableEventStatus.PENDING,
          attemptCount: 0,
          availableAt: fixedNow,
          processedAt: null,
          lastError: null,
        },
      },
    ]);
    expect(fake.ledgerMutationCount).toBe(0);
  });

  it("returns not-found across Owner boundaries", async () => {
    const fake = new WalletExceptionFake();

    await expect(
      actOnWalletExceptionCase({
        caseId: fake.caseState.id,
        ownerId: "owner-2",
        representativeSlug: "other-owner-rep",
        action: "claim",
        expectedVersion: 0,
        idempotencyKey: "cross-owner",
      }, {
        client: fake.client(),
        now: fixedNow,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WalletExceptionActionError>>({
        code: "wallet_exception_not_found",
        statusCode: 404,
      }),
    );
    expect(fake.actions).toHaveLength(0);
  });
});

class WalletExceptionFake {
  caseState: ReturnType<typeof exceptionCase>;
  outbox: {
    id: string;
    status: ReliableEventStatus;
    eventType: string;
    aggregateType: string;
    aggregateId: string;
  } = {
    id: "outbox-1",
    status: ReliableEventStatus.DEAD_LETTER,
    eventType: "wechat_pay.order.reconcile",
    aggregateType: "recharge_order",
    aggregateId: "order-1",
  };
  actions: Array<{
    caseId: string;
    actorOwnerId: string;
    action: string;
    idempotencyKey: string;
    expectedVersion: number;
    resultingVersion: number;
    note: string | null;
  }> = [];
  outboxUpdates: unknown[] = [];
  ledgerMutationCount = 0;

  constructor(
    overrides: Partial<ReturnType<typeof exceptionCase>> = {},
  ) {
    this.caseState = exceptionCase(overrides);
    this.caseState.outboxEvent = this.outbox;
  }

  client(): typeof prisma {
    const self = this;
    const tx = {
      representative: {
        findFirst: vi.fn(async (args: {
          where: { slug: string; ownerId: string };
        }) => {
          if (
            args.where.ownerId === "owner-1"
            && args.where.slug === "alpha"
          ) {
            return { id: "rep-a" };
          }
          if (
            args.where.ownerId === "owner-2"
            && args.where.slug === "other-owner-rep"
          ) {
            return { id: "rep-other" };
          }
          return null;
        }),
      },
      rechargeOrder: {
        findFirst: vi.fn(async (args: {
          where: {
            id: string;
            representative: { ownerId: string };
          };
        }) => (
          args.where.id === "order-1"
          && args.where.representative.ownerId === "owner-1"
            ? { id: "order-1" }
            : null
        )),
      },
      walletExceptionAction: {
        findUnique: vi.fn(async (args: {
          where: {
            actorOwnerId_idempotencyKey: {
              actorOwnerId: string;
              idempotencyKey: string;
            };
          };
        }) => self.actions.find((action) =>
          action.actorOwnerId
            === args.where.actorOwnerId_idempotencyKey.actorOwnerId
          && action.idempotencyKey
            === args.where.actorOwnerId_idempotencyKey.idempotencyKey,
        ) ?? null),
        create: vi.fn(async (args: {
          data: (typeof self.actions)[number];
        }) => {
          self.actions.push(args.data);
          return args.data;
        }),
      },
      walletExceptionCase: {
        findFirst: vi.fn(async (args: {
          where: { id: string; ownerId: string };
        }) => (
          args.where.id === self.caseState.id
          && args.where.ownerId === self.caseState.ownerId
            ? self.caseState
            : null
        )),
        updateMany: vi.fn(async (args: {
          where: {
            id: string;
            ownerId: string;
            representativeId: string;
            version: number;
          };
          data: Record<string, unknown>;
        }) => {
          if (
            args.where.id !== self.caseState.id
            || args.where.ownerId !== self.caseState.ownerId
            || args.where.representativeId
              !== self.caseState.representativeId
            || args.where.version !== self.caseState.version
          ) {
            return { count: 0 };
          }
          for (const [key, value] of Object.entries(args.data)) {
            if (
              key === "version"
              && typeof value === "object"
              && value !== null
              && "increment" in value
            ) {
              self.caseState.version += Number(value.increment);
            } else {
              Object.assign(self.caseState, { [key]: value });
            }
          }
          self.caseState.updatedAt = fixedNow;
          return { count: 1 };
        }),
      },
      outboxEvent: {
        updateMany: vi.fn(async (args: {
          where: {
            id: string;
            status: { in: ReliableEventStatus[] };
          };
          data: {
            status: ReliableEventStatus;
          };
        }) => {
          self.outboxUpdates.push(args);
          if (
            args.where.id !== self.outbox.id
            || !args.where.status.in.includes(self.outbox.status)
          ) {
            return { count: 0 };
          }
          self.outbox.status = args.data.status;
          return { count: 1 };
        }),
      },
    };
    return {
      ...tx,
      $transaction: async (
        operation: (client: typeof tx) => Promise<unknown>,
      ) => operation(tx),
    } as unknown as typeof prisma;
  }
}

function exceptionCase(
  overrides: {
    id?: string;
    representativeId?: string;
    representativeSlug?: string;
    representativeName?: string;
    status?: WalletExceptionCaseStatus;
    claimedByOwnerId?: string | null;
    version?: number;
  } = {},
) {
  return {
    id: overrides.id ?? "case-1",
    ownerId: "owner-1",
    representativeId:
      overrides.representativeId ?? "rep-b",
    currency: "CNY",
    kind: "payment_reconciliation",
    reasonCode: "wechat_order_reconciliation_dead_letter",
    sourceType:
      WalletExceptionSourceType.ORDER_RECONCILIATION_OUTBOX,
    sourceId: "outbox-1",
    outboxEventId: "outbox-1",
    rechargeRefundId: null,
    status: overrides.status ?? WalletExceptionCaseStatus.OPEN,
    severity: WalletExceptionSeverity.CRITICAL,
    claimedByOwnerId: overrides.claimedByOwnerId ?? null,
    claimedAt: overrides.claimedByOwnerId ? fixedNow : null,
    acknowledgedByOwnerId: null,
    acknowledgedAt: null,
    note: null,
    version: overrides.version ?? 0,
    firstDetectedAt: fixedNow,
    lastDetectedAt: fixedNow,
    resolvedAt: null,
    createdAt: fixedNow,
    updatedAt: fixedNow,
    representative: {
      slug: overrides.representativeSlug ?? "beta",
      displayName:
        overrides.representativeName ?? "Beta",
    },
    outboxEvent: {
      id: "outbox-1",
      status:
        ReliableEventStatus.DEAD_LETTER as ReliableEventStatus,
      eventType: "wechat_pay.order.reconcile",
      aggregateType: "recharge_order",
      aggregateId: "order-1",
    },
    rechargeRefund: null,
  };
}

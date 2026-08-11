import {
  BillingHandoffAllowance,
  BillingProductKind,
  BillingRefundPolicy,
  HandoffEntitlementGrantStatus,
  HandoffEntitlementLedgerKind,
  BillingHandoffServiceLevel,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  commercialRefundPolicyConflictReason,
  freezeHandoffGrantForRefund,
  handoffGrantRefundConflictReason,
  refundHandoffGrant,
  restoreHandoffGrantAfterFailedRefund,
} from "../src/commercial-refund-entitlements";

describe("commercial refund handoff entitlements", () => {
  it("routes forced tip refunds to explicit manual reconciliation", () => {
    expect(
      commercialRefundPolicyConflictReason({
        productKindSnapshot: BillingProductKind.TIP,
        refundPolicySnapshot: BillingRefundPolicy.NON_REFUNDABLE,
      }),
    ).toBe(
      "wechat_refund_tip_non_refundable_manual_reversal_required",
    );
    expect(
      commercialRefundPolicyConflictReason({
        productKindSnapshot: BillingProductKind.SERVICE_PACKAGE,
        refundPolicySnapshot: BillingRefundPolicy.FULL_WHEN_UNUSED,
      }),
    ).toBeNull();
  });

  it("refuses reserved or consumed handoff benefits", () => {
    expect(
      handoffGrantRefundConflictReason(
        grantFixture({ reservedUses: 1 }),
      ),
    ).toBe("wechat_refund_handoff_reserved");
    expect(
      handoffGrantRefundConflictReason(
        grantFixture({
          consumedUses: 1,
          remainingUses: 1,
        }),
      ),
    ).toBe("wechat_refund_handoff_already_consumed");
  });

  it("freezes an unused grant and emits a terminal refund receipt", async () => {
    const client = new FakeCommercialRefundClient();

    const frozen = await freezeHandoffGrantForRefund(
      client as never,
      "order_1",
    );
    expect(frozen?.status).toBe(HandoffEntitlementGrantStatus.FROZEN);

    await refundHandoffGrant(
      client as never,
      "order_1",
      "refund_1",
    );
    await refundHandoffGrant(
      client as never,
      "order_1",
      "refund_1",
    );
    expect(client.grant.status).toBe(
      HandoffEntitlementGrantStatus.REFUNDED,
    );
    expect(client.ledger).toEqual([
      expect.objectContaining({
        grantId: "grant_1",
        kind: HandoffEntitlementLedgerKind.REFUND,
        uses: 2,
        remainingAfter: 2,
        reservedAfter: 0,
        consumedAfter: 0,
        idempotencyKey: "handoff-grant:grant_1:refund:refund_1",
      }),
    ]);
  });

  it("restores a failed refund to EXPIRED and closes the expiry ledger", async () => {
    const client = new FakeCommercialRefundClient({
      status: HandoffEntitlementGrantStatus.FROZEN,
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await restoreHandoffGrantAfterFailedRefund(
      client as never,
      "refund_1",
      new Date("2026-01-02T00:00:00.000Z"),
    );
    await restoreHandoffGrantAfterFailedRefund(
      client as never,
      "refund_1",
      new Date("2026-01-02T00:00:00.000Z"),
    );

    expect(client.grant.status).toBe(
      HandoffEntitlementGrantStatus.EXPIRED,
    );
    expect(client.ledger).toEqual([
      expect.objectContaining({
        kind: HandoffEntitlementLedgerKind.EXPIRE,
        idempotencyKey: "handoff-grant:grant_1:expire",
      }),
    ]);
  });

  it("keeps historical orders without a handoff grant compatible", async () => {
    const client = new FakeCommercialRefundClient({ missingGrant: true });
    await expect(
      refundHandoffGrant(
        client as never,
        "order_1",
        "refund_1",
      ),
    ).resolves.toBeUndefined();
    expect(client.ledger).toHaveLength(0);
  });
});

type GrantRow = {
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

function grantFixture(overrides: Partial<GrantRow> = {}): GrantRow {
  return {
    id: "grant_1",
    rechargeOrderId: "order_1",
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
    startsAt: new Date("2025-01-01T00:00:00.000Z"),
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

class FakeCommercialRefundClient {
  grant: GrantRow;
  ledger: Array<Record<string, unknown>> = [];
  missingGrant: boolean;

  constructor(
    options: Partial<GrantRow> & { missingGrant?: boolean } = {},
  ) {
    this.missingGrant = options.missingGrant ?? false;
    const { missingGrant: _missingGrant, ...grantOverrides } = options;
    this.grant = grantFixture(grantOverrides);
  }

  rechargeRefund = {
    findUnique: async () => ({ rechargeOrderId: "order_1" }),
    count: async () => 0,
  };

  handoffEntitlementGrant = {
    findUnique: async () => (this.missingGrant ? null : { ...this.grant }),
    updateMany: async (args: any) => {
      if (this.missingGrant || this.grant.id !== args.where.id) {
        return { count: 0 };
      }
      const statuses = args.where.status?.in;
      if (
        statuses
          ? !statuses.includes(this.grant.status)
          : args.where.status
            ? this.grant.status !== args.where.status
            : false
      ) {
        return { count: 0 };
      }
      if (
        typeof args.where.reservedUses === "number"
        && this.grant.reservedUses !== args.where.reservedUses
      ) {
        return { count: 0 };
      }
      if (
        typeof args.where.consumedUses === "number"
        && this.grant.consumedUses !== args.where.consumedUses
      ) {
        return { count: 0 };
      }
      Object.assign(this.grant, args.data);
      return { count: 1 };
    },
  };

  handoffEntitlementLedgerEntry = {
    findFirst: async (args: any) =>
      this.ledger.find(
        (entry) =>
          entry.grantId === args.where.grantId
          && entry.kind === args.where.kind,
      ) ?? null,
    create: async (args: any) => {
      this.ledger.push({ ...args.data });
      return args.data;
    },
  };
}

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  unitUpsert: vi.fn(),
  unitFindUnique: vi.fn(),
  unitUpdate: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock("../src/prisma", () => {
  const tx = {
    $executeRaw: mocks.executeRaw,
    billableUnit: {
      findUnique: mocks.unitFindUnique,
      update: mocks.unitUpdate,
    },
  };
  return {
    prisma: {
      billableUnit: {
        upsert: mocks.unitUpsert,
        findUnique: mocks.unitFindUnique,
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    },
  };
});

describe("BillableUnit lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.unitUpsert.mockImplementation(async ({ create }) => ({ id: "unit-1", status: "PENDING_RESERVATION", ...create }));
    mocks.unitUpdate.mockImplementation(async ({ data }) => ({ id: "unit-1", ...data }));
  });

  it("pins payer, entitlement account, product, price, and purpose", async () => {
    const { createBillableUnit } = await import("../src/billable-units");
    await createBillableUnit(unitInput());
    expect(mocks.unitUpsert).toHaveBeenCalledWith({
      where: { idempotencyKey: "billing:plan-1" },
      create: expect.objectContaining({
        productId: "product-1",
        pricingVersionId: "price-v1",
        representativeId: "rep-1",
        payerAccountId: "payer-1",
        entitlementAccountId: "entitlement-1",
        authorizedPurposeHash: "c".repeat(64),
      }),
      update: {},
    });
  });

  it("reserves once for one exact owner", async () => {
    mocks.unitFindUnique.mockResolvedValue({
      id: "unit-1",
      status: "PENDING_RESERVATION",
    });
    const { reserveBillableUnit } = await import("../src/billable-units");
    await reserveBillableUnit({
      unitId: "unit-1",
      ownerType: "generation_run",
      ownerId: "run-1",
      reservationReference: "reservation-1",
    });
    expect(mocks.unitUpdate).toHaveBeenCalledWith({
      where: { id: "unit-1" },
      data: expect.objectContaining({
        status: "RESERVED",
        reservationOwnerType: "generation_run",
        reservationOwnerId: "run-1",
      }),
    });
  });

  it("rejects transfer across payer, product, price, or purpose boundaries", async () => {
    mocks.unitFindUnique.mockResolvedValue({
      id: "unit-1",
      status: "RESERVED",
      payerAccountId: "payer-1",
      entitlementAccountId: "entitlement-1",
      productId: "product-1",
      pricingVersionId: "price-v1",
      authorizedPurposeHash: "c".repeat(64),
      reservationOwnerType: "generation_run",
      reservationOwnerId: "run-1",
    });
    const { transferBillableUnit } = await import("../src/billable-units");
    await expect(transferBillableUnit({
      unitId: "unit-1",
      fromOwnerType: "generation_run",
      fromOwnerId: "run-1",
      toOwnerType: "delegation_task",
      toOwnerId: "task-1",
      payerAccountId: "payer-other",
      entitlementAccountId: "entitlement-1",
      productId: "product-1",
      pricingVersionId: "price-v1",
      authorizedPurposeHash: `sha256:${"c".repeat(64)}`,
    })).rejects.toThrow("changed its payer");
    expect(mocks.unitUpdate).not.toHaveBeenCalled();
  });

  it("holds an uncertain unit for reconciliation instead of settling", async () => {
    mocks.unitFindUnique.mockResolvedValue({ id: "unit-1", status: "TRANSFERRED" });
    const { holdBillableUnitForReconciliation } = await import("../src/billable-units");
    await holdBillableUnitForReconciliation("unit-1");
    expect(mocks.unitUpdate).toHaveBeenCalledWith({
      where: { id: "unit-1" },
      data: expect.objectContaining({ status: "HELD_FOR_RECONCILIATION" }),
    });
  });
});

function unitInput() {
  return {
    planId: "plan-1",
    productId: "product-1",
    pricingVersionId: "price-v1",
    priceSnapshotHash: `sha256:${"a".repeat(64)}`,
    representativeId: "rep-1",
    payerAccountId: "payer-1",
    entitlementAccountId: "entitlement-1",
    unitKind: "conversation_service",
    quantity: 1,
    scope: "plan" as const,
    referenceIds: ["plan-1"],
    completionRule: "all_references_succeeded",
    settlementTrigger: "provider_accepted",
    idempotencyKey: "billing:plan-1",
    billingPolicySnapshotHash: `sha256:${"b".repeat(64)}`,
    authorizedPurposeHash: `sha256:${"c".repeat(64)}`,
  };
}

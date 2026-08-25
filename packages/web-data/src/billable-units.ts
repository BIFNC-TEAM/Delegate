import { BillableUnitStatus, Prisma } from "@prisma/client";

import { prisma } from "./prisma";

export type CreateBillableUnitInput = {
  planId: string;
  actionId?: string | null;
  goalId?: string | null;
  deliverableId?: string | null;
  productId: string;
  pricingVersionId: string;
  priceSnapshotHash: string;
  representativeId: string;
  payerAccountId: string;
  entitlementAccountId: string;
  unitKind: string;
  quantity: number;
  scope: "plan" | "goal" | "action" | "deliverable";
  referenceIds: string[];
  completionRule: string;
  settlementTrigger: string;
  idempotencyKey: string;
  billingPolicySnapshotHash: string;
  authorizedPurposeHash: string;
};

export async function createBillableUnit(input: CreateBillableUnitInput) {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    throw new Error("BillableUnit quantity must be a positive safe integer.");
  }
  for (const [label, value] of [
    ["priceSnapshotHash", input.priceSnapshotHash],
    ["billingPolicySnapshotHash", input.billingPolicySnapshotHash],
    ["authorizedPurposeHash", input.authorizedPurposeHash],
  ] as const) {
    if (!/^(?:sha256:)?[a-f0-9]{64}$/u.test(value)) {
      throw new Error(`BillableUnit ${label} must be a SHA-256 hash.`);
    }
  }
  return prisma.billableUnit.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    create: {
      ...input,
      actionId: input.actionId ?? null,
      goalId: input.goalId ?? null,
      deliverableId: input.deliverableId ?? null,
      priceSnapshotHash: stripHash(input.priceSnapshotHash),
      billingPolicySnapshotHash: stripHash(input.billingPolicySnapshotHash),
      authorizedPurposeHash: stripHash(input.authorizedPurposeHash),
      referenceIds: [...new Set(input.referenceIds)].sort(),
    },
    update: {},
  });
}

export async function reserveBillableUnit(input: {
  unitId: string;
  ownerType: "generation_run" | "delegation_task";
  ownerId: string;
  reservationReference: string;
}) {
  return transitionUnit(input.unitId, async (tx, unit, now) => {
    if (unit.status === BillableUnitStatus.RESERVED
      && unit.reservationOwnerType === input.ownerType
      && unit.reservationOwnerId === input.ownerId
      && unit.reservationReference === input.reservationReference) return unit;
    if (unit.status !== BillableUnitStatus.PENDING_RESERVATION) {
      throw new Error("BillableUnit is not available for reservation.");
    }
    return tx.billableUnit.update({
      where: { id: unit.id },
      data: {
        status: BillableUnitStatus.RESERVED,
        reservationOwnerType: input.ownerType,
        reservationOwnerId: input.ownerId,
        reservationReference: input.reservationReference,
        reservedAt: now,
      },
    });
  });
}

export async function transferBillableUnit(input: {
  unitId: string;
  fromOwnerType: string;
  fromOwnerId: string;
  toOwnerType: "generation_run" | "delegation_task";
  toOwnerId: string;
  payerAccountId: string;
  entitlementAccountId: string;
  productId: string;
  pricingVersionId: string;
  authorizedPurposeHash: string;
}) {
  return transitionUnit(input.unitId, async (tx, unit, now) => {
    if (
      unit.payerAccountId !== input.payerAccountId
      || unit.entitlementAccountId !== input.entitlementAccountId
      || unit.productId !== input.productId
      || unit.pricingVersionId !== input.pricingVersionId
      || unit.authorizedPurposeHash !== stripHash(input.authorizedPurposeHash)
    ) {
      throw new Error("BillableUnit transfer changed its payer, product, price, or authorized purpose.");
    }
    if (
      unit.status !== BillableUnitStatus.RESERVED
      || unit.reservationOwnerType !== input.fromOwnerType
      || unit.reservationOwnerId !== input.fromOwnerId
    ) {
      throw new Error("BillableUnit transfer source does not own the reservation.");
    }
    return tx.billableUnit.update({
      where: { id: unit.id },
      data: {
        status: BillableUnitStatus.TRANSFERRED,
        reservationOwnerType: input.toOwnerType,
        reservationOwnerId: input.toOwnerId,
        transferredAt: now,
      },
    });
  });
}

export async function settleBillableUnit(unitId: string) {
  return terminalTransition(unitId, {
    allowed: [BillableUnitStatus.RESERVED, BillableUnitStatus.TRANSFERRED, BillableUnitStatus.SETTLEMENT_PENDING],
    status: BillableUnitStatus.SETTLED,
    timestamp: "settledAt",
  });
}

export async function releaseBillableUnit(unitId: string) {
  return terminalTransition(unitId, {
    allowed: [BillableUnitStatus.PENDING_RESERVATION, BillableUnitStatus.RESERVED, BillableUnitStatus.TRANSFERRED],
    status: BillableUnitStatus.RELEASED,
    timestamp: "releasedAt",
  });
}

export async function holdBillableUnitForReconciliation(unitId: string) {
  return terminalTransition(unitId, {
    allowed: [BillableUnitStatus.RESERVED, BillableUnitStatus.TRANSFERRED, BillableUnitStatus.SETTLEMENT_PENDING],
    status: BillableUnitStatus.HELD_FOR_RECONCILIATION,
    timestamp: "reconciliationHeldAt",
  });
}

async function terminalTransition(
  unitId: string,
  input: {
    allowed: BillableUnitStatus[];
    status: BillableUnitStatus;
    timestamp: "settledAt" | "releasedAt" | "reconciliationHeldAt";
  },
) {
  return transitionUnit(unitId, async (tx, unit, now) => {
    if (unit.status === input.status) return unit;
    if (!input.allowed.includes(unit.status)) {
      throw new Error(`BillableUnit cannot transition from ${unit.status} to ${input.status}.`);
    }
    return tx.billableUnit.update({
      where: { id: unit.id },
      data: {
        status: input.status,
        [input.timestamp]: now,
      },
    });
  });
}

async function transitionUnit<T>(
  unitId: string,
  transition: (
    tx: Prisma.TransactionClient,
    unit: NonNullable<Awaited<ReturnType<typeof prisma.billableUnit.findUnique>>>,
    now: Date,
  ) => Promise<T>,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${unitId}))`;
    const unit = await tx.billableUnit.findUnique({ where: { id: unitId } });
    if (!unit) throw new Error("BillableUnit not found.");
    return transition(tx, unit, new Date());
  });
}

function stripHash(value: string) {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}

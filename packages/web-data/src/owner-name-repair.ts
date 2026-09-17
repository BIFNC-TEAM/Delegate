import { createHash, randomUUID } from "node:crypto";

import { EventType, Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

import { prisma } from "./prisma";

const text = z.string().trim().min(1);
const repairTargetSchema = z.object({
  ownerId: text.max(191),
  issuer: text.max(2048),
  subject: text.max(255),
  // Supplied by the operator after checking the exact Logto user. Never infer
  // this from an email address, another account, or an unverified token.
  displayName: text.max(160),
}).strict();

const ownerSnapshotSchema = z.object({
  displayName: z.string(),
  accountDisplayName: z.string().nullable(),
  accountId: z.string().nullable(),
  settingsVersion: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
}).strict();

export const ownerNameRepairPlanSchema = z.object({
  version: z.literal(1),
  repairId: z.uuid(),
  databaseTarget: text,
  target: repairTargetSchema,
  expected: ownerSnapshotSchema,
}).strict();

export type OwnerNameRepairPlan = z.infer<typeof ownerNameRepairPlanSchema>;
type RepairClient = Pick<PrismaClient, "owner" | "$transaction">;

/** Read-only preview. This is an operator workflow, not a login-time heuristic. */
export async function previewOwnerNameRepair(
  targetInput: unknown,
  databaseTarget: string,
  client: RepairClient = prisma,
): Promise<OwnerNameRepairPlan> {
  const target = repairTargetSchema.parse(targetInput);
  const owner = await client.owner.findFirst({
    where: {
      id: target.ownerId,
      identityLinks: {
        some: { provider: "LOGTO", issuer: target.issuer, providerSubject: target.subject },
      },
    },
    select: {
      displayName: true,
      accountDisplayName: true,
      accountId: true,
      settingsVersion: true,
      updatedAt: true,
    },
  });
  if (!owner) throw new Error("owner_name_repair_identity_not_found");
  if (owner.displayName !== `Creator ${target.subject.slice(0, 8)}`) {
    throw new Error("owner_name_repair_not_generated_name");
  }
  if (owner.displayName === target.displayName) {
    throw new Error("owner_name_repair_no_change");
  }
  return ownerNameRepairPlanSchema.parse({
    version: 1,
    repairId: randomUUID(),
    databaseTarget,
    target,
    expected: { ...owner, updatedAt: owner.updatedAt.toISOString() },
  });
}

/** Apply only the reviewed snapshot; any intervening change requires a new preview. */
export async function applyOwnerNameRepair(
  planInput: unknown,
  databaseTarget: string,
  client: RepairClient = prisma,
): Promise<{ status: "applied" | "already_applied"; ownerId: string }> {
  const plan = ownerNameRepairPlanSchema.parse(planInput);
  if (plan.databaseTarget !== databaseTarget) {
    throw new Error("owner_name_repair_database_mismatch");
  }
  if (
    plan.expected.displayName !== `Creator ${plan.target.subject.slice(0, 8)}`
    || plan.expected.displayName === plan.target.displayName
  ) {
    throw new Error("owner_name_repair_not_generated_name");
  }
  const idempotencyKey = `owner-name-repair:${plan.repairId}`;
  const requestHash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  return client.$transaction(async (tx) => {
    const replay = await tx.eventAudit.findUnique({
      where: { ownerId_idempotencyKey: { ownerId: plan.target.ownerId, idempotencyKey } },
      select: { type: true, requestHash: true },
    });
    if (replay) {
      if (replay.type !== EventType.OWNER_PROFILE_UPDATED || replay.requestHash !== requestHash) {
        throw new Error("owner_name_repair_idempotency_conflict");
      }
      return { status: "already_applied", ownerId: plan.target.ownerId };
    }
    const updated = await tx.owner.updateMany({
      where: {
        id: plan.target.ownerId,
        ...plan.expected,
        updatedAt: new Date(plan.expected.updatedAt),
        identityLinks: {
          some: {
            provider: "LOGTO",
            issuer: plan.target.issuer,
            providerSubject: plan.target.subject,
          },
        },
      },
      data: {
        displayName: plan.target.displayName,
        settingsVersion: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new Error("owner_name_repair_snapshot_conflict");
    await tx.eventAudit.create({
      data: {
        ownerId: plan.target.ownerId,
        type: EventType.OWNER_PROFILE_UPDATED,
        idempotencyKey,
        requestHash,
        payload: {
          actorId: "owner-name-repair-cli",
          requestId: plan.repairId,
          source: "reviewed_generated_owner_name_repair",
          changedFields: ["ownerDisplayName"],
          expectedVersion: plan.expected.settingsVersion,
          resultingVersion: plan.expected.settingsVersion + 1,
        },
      },
    });
    return { status: "applied", ownerId: plan.target.ownerId };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

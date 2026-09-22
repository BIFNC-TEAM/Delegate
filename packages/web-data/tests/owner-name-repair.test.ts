import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { applyOwnerNameRepair, previewOwnerNameRepair } from "../src/owner-name-repair";
import { ownerNameRepairDatabaseTarget, parseOwnerNameRepairArgs } from "../../../scripts/repair-owner-name";

const target = {
  ownerId: "owner-1",
  issuer: "https://auth.example.com/oidc",
  subject: "legacy-user-1",
  displayName: "registered_user",
};

function fixture() {
  const owner = {
    displayName: "Creator legacy-u",
    accountDisplayName: "My chosen nickname",
    accountId: "account-1",
    settingsVersion: 3,
    updatedAt: new Date("2026-09-17T00:00:00Z"),
  };
  const tx = {
    owner: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    eventAudit: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const database = {
    owner: { findFirst: vi.fn().mockResolvedValue(owner) },
    $transaction: vi.fn(async (operation) => operation(tx)),
  };
  return { owner, tx, database, client: database as unknown as PrismaClient };
}

describe("reviewed historical Owner name repair", () => {
  it("previews a session-bound Owner without mutating any data", async () => {
    const f = fixture();
    const plan = await previewOwnerNameRepair(target, "test-db", f.client);
    expect(plan).toMatchObject({ target, expected: { ...f.owner, updatedAt: f.owner.updatedAt.toISOString() } });
    expect(f.database.owner.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: target.ownerId,
        identityLinks: { some: { provider: "LOGTO", issuer: target.issuer, providerSubject: target.subject } },
      },
    }));
    expect(f.database.$transaction).not.toHaveBeenCalled();
  });

  it("updates only the public Owner name and version, with exact identity and snapshot guards", async () => {
    const f = fixture();
    const plan = await previewOwnerNameRepair(target, "test-db", f.client);
    expect(await applyOwnerNameRepair(plan, "test-db", f.client)).toEqual({ status: "applied", ownerId: target.ownerId });
    expect(f.tx.owner.updateMany).toHaveBeenCalledWith({
      where: {
        id: target.ownerId, ...f.owner,
        identityLinks: { some: { provider: "LOGTO", issuer: target.issuer, providerSubject: target.subject } },
      },
      data: { displayName: target.displayName, settingsVersion: { increment: 1 } },
    });
    const audit = f.tx.eventAudit.create.mock.calls[0]![0];
    expect(audit.data.payload.changedFields).toEqual(["ownerDisplayName"]);
    expect(JSON.stringify(audit)).not.toContain(target.displayName);
    expect(JSON.stringify(audit)).not.toContain(f.owner.accountDisplayName);
    expect(f.database.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("rejects wrong or missing principal matches at preview", async () => {
    const f = fixture();
    f.database.owner.findFirst.mockResolvedValue(null);
    await expect(previewOwnerNameRepair(target, "test-db", f.client)).rejects.toThrow("identity_not_found");
  });

  it("refuses to replace an existing custom public name", async () => {
    const f = fixture();
    f.owner.displayName = "Custom public identity";
    await expect(previewOwnerNameRepair(target, "test-db", f.client)).rejects.toThrow("not_generated_name");
  });

  it("refuses plans for a different database before starting a transaction", async () => {
    const f = fixture();
    const plan = await previewOwnerNameRepair(target, "test-db", f.client);
    await expect(applyOwnerNameRepair(plan, "other-db", f.client)).rejects.toThrow("database_mismatch");
    expect(f.database.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a stale snapshot without creating a success audit", async () => {
    const f = fixture();
    const plan = await previewOwnerNameRepair(target, "test-db", f.client);
    f.tx.owner.updateMany.mockResolvedValue({ count: 0 });
    await expect(applyOwnerNameRepair(plan, "test-db", f.client)).rejects.toThrow("snapshot_conflict");
    expect(f.tx.eventAudit.create).not.toHaveBeenCalled();
  });

  it("allows retry of the identical completed plan without another update", async () => {
    const f = fixture();
    const plan = await previewOwnerNameRepair(target, "test-db", f.client);
    await applyOwnerNameRepair(plan, "test-db", f.client);
    f.tx.eventAudit.findUnique.mockResolvedValue(f.tx.eventAudit.create.mock.calls[0]![0].data);
    f.tx.owner.updateMany.mockClear();
    expect(await applyOwnerNameRepair(plan, "test-db", f.client)).toMatchObject({ status: "already_applied" });
    expect(f.tx.owner.updateMany).not.toHaveBeenCalled();
    await expect(applyOwnerNameRepair({ ...plan, target: { ...target, displayName: "Other" } }, "test-db", f.client))
      .rejects.toThrow("idempotency_conflict");
  });

  it("propagates database and audit failures", async () => {
    const f = fixture();
    const plan = await previewOwnerNameRepair(target, "test-db", f.client);
    f.tx.eventAudit.create.mockRejectedValue(new Error("audit unavailable"));
    await expect(applyOwnerNameRepair(plan, "test-db", f.client)).rejects.toThrow("audit unavailable");
  });

  it.each(["", "   ", 42, null])("rejects invalid replacement names: %j", async (displayName) => {
    const f = fixture();
    await expect(previewOwnerNameRepair({ ...target, displayName }, "test-db", f.client)).rejects.toThrow();
    expect(f.database.owner.findFirst).not.toHaveBeenCalled();
  });

  it("binds preview and apply to host, port, database and schema without storing credentials", () => {
    const key = ownerNameRepairDatabaseTarget("postgresql://user:secret@localhost:5432/test?schema=public");
    expect(key).toBe(ownerNameRepairDatabaseTarget("postgresql://user:new-secret@localhost/test"));
    expect(key).not.toBe(ownerNameRepairDatabaseTarget("postgresql://user:secret@localhost/production"));
    expect(key).not.toBe(ownerNameRepairDatabaseTarget("postgresql://user:secret@localhost/test?schema=other"));
    expect(key).not.toContain("secret");
    expect(() => ownerNameRepairDatabaseTarget(undefined)).toThrow("DATABASE_URL is required");
  });

  it("requires explicit preview or apply with the exact argument count", () => {
    expect(parseOwnerNameRepairArgs(["preview", "target.json", "plan.json"]).mode).toBe("preview");
    expect(parseOwnerNameRepairArgs(["apply", "plan.json"]).mode).toBe("apply");
    for (const args of [[], ["apply"], ["preview", "target.json"], ["apply", "plan.json", "extra"]]) {
      expect(() => parseOwnerNameRepairArgs(args)).toThrow("Usage:");
    }
  });
});

import { beforeEach, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(), count: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn(),
  readVault: vi.fn(), unlock: vi.fn(), logout: vi.fn(),
}));
vi.mock("../src/prisma", () => ({ prisma: { obsidianSyncConnection: mocks } }));
vi.mock("@delegate/obsidian-sync", async importOriginal => ({
  ...await importOriginal<object>(), readVault: mocks.readVault, unlock: mocks.unlock, logout: mocks.logout,
}));
import { seal } from "../src/obsidian-sync/credentials";
import { getObsidianConnection, readObsidianNotes, unlockObsidianVault, cleanupExpiredObsidianConnections } from "../src/obsidian-sync/service";

beforeEach(() => {
  vi.resetAllMocks();
  process.env.OBSIDIAN_SYNC_CREDENTIAL_KEY = randomBytes(32).toString("base64");
  mocks.count.mockResolvedValue(1);
  mocks.deleteMany.mockResolvedValue({ count: 1 });
  mocks.findUnique.mockImplementation(async ({ where }: { where: { ownerId: string } }) =>
    where.ownerId !== "owner-a" ? null : {
      id: "connection-a", ownerId: "owner-a", expiresAt: new Date(Date.now() + 60_000), revision: 0,
      ciphertext: seal({ token: "secret", email: "test@example.com", vaults: { vault1: { id: "vault1" } } }, "owner-a", "connection-a"),
    });
  mocks.readVault.mockResolvedValue({ notes: [], files: [{ text: "private body" }] });
});
it("does not permit another owner to reuse a connection", async () => {
  await expect(readObsidianNotes("owner-b", "connection-a", "vault1", ["1"])).rejects.toMatchObject({ code: "EXPIRED" });
  expect(mocks.readVault).not.toHaveBeenCalled();
});
it("does not release downloaded bodies after disconnect", async () => {
  mocks.count.mockResolvedValue(0);
  await expect(readObsidianNotes("owner-a", "connection-a", "vault1", ["1"])).rejects.toMatchObject({ code: "EXPIRED" });
});
it("requires explicit vault unlock", async () => {
  await expect(readObsidianNotes("owner-a", "connection-a", "vault2", ["1"])).rejects.toMatchObject({ code: "LOCKED" });
  expect(mocks.readVault).not.toHaveBeenCalled();
});
it("rejects expired connections and deletes their secrets", async () => {
  mocks.findUnique.mockResolvedValue({ id: "old", expiresAt: new Date(0) });
  expect(await getObsidianConnection("owner-a")).toBeNull();
  expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: "old" } });
});
it("a concurrent disconnect cannot resurrect an unlocked connection", async () => {
  mocks.unlock.mockResolvedValue({ id: "vault2" });
  mocks.updateMany.mockResolvedValue({ count: 0 });
  await expect(unlockObsidianVault("owner-a", "connection-a", "vault2", "password")).rejects.toMatchObject({ code: "CHANGED" });
});
it("deletes expired encrypted rows even when remote logout fails", async () => {
  mocks.findMany.mockResolvedValue([{
    id: "connection-a", ownerId: "owner-a", revision: 0,
    ciphertext: seal({ token: "secret" }, "owner-a", "connection-a"),
  }]);
  mocks.logout.mockRejectedValue(new Error("offline"));
  await cleanupExpiredObsidianConnections();
  expect(mocks.deleteMany).toHaveBeenCalled();
});

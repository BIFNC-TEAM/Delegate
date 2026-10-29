import { randomUUID } from "node:crypto";
import * as adapter from "@delegate/obsidian-sync";
import { prisma } from "../prisma";
import { assertCredentialKey, seal, unseal } from "./credentials";

export { SyncError } from "@delegate/obsidian-sync";
type Credentials = {
  token: string; email: string;
  vaults: Record<string, adapter.UnlockedVault>;
};
const WEEK = 7 * 24 * 60 * 60 * 1000;

export async function cleanupExpiredObsidianConnections() {
  // Delete ciphertext first. Remote logout is best effort and never extends retention.
  const rows = await prisma.obsidianSyncConnection.findMany({
    where: { expiresAt: { lte: new Date() } }, take: 100,
  });
  for (const row of rows) {
    const deleted = await prisma.obsidianSyncConnection.deleteMany({ where: { id: row.id, revision: row.revision } });
    if (deleted.count) {
      try { await adapter.logout(unseal<Credentials>(row.ciphertext, row.ownerId, row.id).token); }
      catch { /* Local secrets are already removed; do not log credential-bearing errors. */ }
    }
  }
}

async function load(ownerId: string, connectionId?: string) {
  const row = await prisma.obsidianSyncConnection.findUnique({ where: { ownerId } });
  if (!row || row.expiresAt.getTime() <= Date.now() || (connectionId && row.id !== connectionId)) {
    if (row && row.expiresAt.getTime() <= Date.now()) {
      await prisma.obsidianSyncConnection.deleteMany({ where: { id: row.id } });
    }
    throw new adapter.SyncError("EXPIRED");
  }
  return { row, credentials: unseal<Credentials>(row.ciphertext, ownerId, row.id) };
}
async function ensureActive(ownerId: string, connectionId: string) {
  const found = await prisma.obsidianSyncConnection.count({
    where: { ownerId, id: connectionId, expiresAt: { gt: new Date() } },
  });
  if (!found) throw new adapter.SyncError("EXPIRED");
}

export async function getObsidianConnection(ownerId: string) {
  try {
    const { row, credentials } = await load(ownerId);
    return { id: row.id, email: credentials.email, expiresAt: row.expiresAt.toISOString() };
  } catch (error) {
    if (error instanceof adapter.SyncError && error.code === "EXPIRED") return null;
    throw error;
  }
}

export async function connectObsidian(ownerId: string, email: string, password: string, mfa?: string) {
  assertCredentialKey();
  if (await getObsidianConnection(ownerId)) throw new adapter.SyncError("CHANGED");
  const identity = await adapter.login(email, password, mfa);
  const id = randomUUID();
  try {
    await prisma.obsidianSyncConnection.create({ data: {
      id, ownerId, expiresAt: new Date(Date.now() + WEEK),
      ciphertext: seal({ token: identity.token, email: identity.email, vaults: {} }, ownerId, id),
    } });
  } catch (error) {
    await adapter.logout(identity.token);
    throw error;
  }
  return getObsidianConnection(ownerId);
}

export async function disconnectObsidian(ownerId: string, connectionId: string) {
  const { row, credentials } = await load(ownerId, connectionId);
  await prisma.obsidianSyncConnection.deleteMany({ where: { ownerId, id: row.id } });
  await adapter.logout(credentials.token);
}

export async function listObsidianVaults(ownerId: string, connectionId: string) {
  const { credentials } = await load(ownerId, connectionId);
  const vaults = await adapter.listVaults(credentials.token);
  await ensureActive(ownerId, connectionId);
  return vaults.map(vault => ({ ...vault, unlocked: Boolean(credentials.vaults[vault.id]) }));
}

export async function unlockObsidianVault(ownerId: string, connectionId: string, vaultId: string, password: string) {
  const { row, credentials } = await load(ownerId, connectionId);
  const vault = await adapter.unlock(credentials.token, vaultId, password);
  credentials.vaults[vaultId] = vault;
  const updated = await prisma.obsidianSyncConnection.updateMany({
    where: { ownerId, id: row.id, revision: row.revision, expiresAt: { gt: new Date() } },
    data: { ciphertext: seal(credentials, ownerId, row.id), revision: { increment: 1 } },
  });
  if (!updated.count) throw new adapter.SyncError("CHANGED");
}

export async function readObsidianNotes(
  ownerId: string, connectionId: string, vaultId: string, selected: readonly string[] = [],
) {
  const { credentials } = await load(ownerId, connectionId);
  if (!Object.hasOwn(credentials.vaults, vaultId)) throw new adapter.SyncError("LOCKED");
  const result = await adapter.readVault(credentials.token, credentials.vaults[vaultId]!, selected);
  // Disconnect/reconnect or expiration while the request was running must not release bodies.
  await ensureActive(ownerId, connectionId);
  return result;
}

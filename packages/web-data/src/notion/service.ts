import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { prisma } from "../prisma";
import { NotionClient } from "./client";
import { notionFetch } from "./transport";
import { NotionError } from "./types";
export { NotionError } from "./types";

const WEEK = 7 * 86400_000;
export const stateHash = (value: string) => createHash("sha256").update(value).digest("hex");
function config() {
  const clientId = process.env.NOTION_CLIENT_ID;
  const secret = process.env.NOTION_CLIENT_SECRET;
  const redirect = process.env.NOTION_REDIRECT_URI;
  const key = Buffer.from(process.env.NOTION_CREDENTIAL_KEY ?? "", "base64");
  if (!clientId || !secret || !redirect || key.length !== 32) throw new NotionError("CONFIG", "Notion 导入尚未配置。 / Notion is not configured.");
  const url = new URL(redirect);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) throw new NotionError("CONFIG", "Notion 回调地址无效。 / Invalid callback URL.");
  return { clientId, secret, redirect, key };
}
type Tokens = { access_token: string; refresh_token?: string };
export function sealNotion(value: Tokens, owner: string, id: string) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", config().key, iv);
  cipher.setAAD(Buffer.from(`notion:v1:${owner}:${id}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64")).join(".");
}
export function unsealNotion(value: string, owner: string, id: string): Tokens {
  try {
    const [iv, tag, ciphertext] = value.split(".").map(part => Buffer.from(part, "base64"));
    const cipher = createDecipheriv("aes-256-gcm", config().key, iv!);
    cipher.setAAD(Buffer.from(`notion:v1:${owner}:${id}`)); cipher.setAuthTag(tag!);
    return JSON.parse(Buffer.concat([cipher.update(ciphertext!), cipher.final()]).toString("utf8"));
  } catch { throw new NotionError("CONFIG", "无法解密 Notion 连接，请联系管理员。 / Connection decryption failed."); }
}
async function tokenRequest(body: unknown, endpoint = "token") {
  const settings = config();
  const response = await notionFetch(`https://api.notion.com/v1/oauth/${endpoint}`, {
    method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Basic ${Buffer.from(`${settings.clientId}:${settings.secret}`).toString("base64")}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new NotionError("AUTH", "Notion 授权失败，请重新连接。 / Authorization failed. Reconnect.");
  return response.status === 204 ? {} : await response.json();
}
export async function beginNotionAuthorization(ownerId: string, browser: string, returnTo: string) {
  const settings = config();
  const token = randomBytes(32).toString("base64url");
  // Only an internal dashboard URL is persisted, never an arbitrary redirect.
  const target = new URL(returnTo, "http://internal");
  if (target.origin !== "http://internal" || target.pathname !== "/dashboard") throw new NotionError("STATE", "Invalid return URL.");
  await prisma.notionOAuthState.deleteMany({ where: { ownerId, browserHash: stateHash(browser) } });
  await prisma.notionOAuthState.create({ data: { id: stateHash(token), ownerId, browserHash: stateHash(browser), returnTo: target.pathname + target.search, expiresAt: new Date(Date.now() + 10 * 60_000) } });
  const url = new URL("https://api.notion.com/v1/oauth/authorize");
  url.search = new URLSearchParams({ client_id: settings.clientId, response_type: "code", owner: "user", redirect_uri: settings.redirect, state: token }).toString();
  return { url: url.href, origin: new URL(settings.redirect).origin };
}
export async function finishNotionAuthorization(state: string, browser: string, currentOwner: string | null, code: string | null) {
  const row = await prisma.notionOAuthState.findUnique({ where: { id: stateHash(state) } });
  if (!row || (currentOwner !== null && row.ownerId !== currentOwner) || row.browserHash !== stateHash(browser) || row.expiresAt.getTime() <= Date.now()) throw new NotionError("STATE", "授权请求已失效，请重新连接。 / Authorization expired.");
  const ownerId = row.ownerId;
  const consumed = await prisma.notionOAuthState.deleteMany({ where: { id: row.id } });
  if (!consumed.count) throw new NotionError("STATE", "授权已使用。 / Authorization already used.");
  if (!code) return { returnTo: row.returnTo, success: false };
  const data = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: config().redirect });
  if (!data.access_token || !data.workspace_id) throw new NotionError("AUTH", "Notion 授权响应无效。 / Invalid authorization response.");
  const id = randomUUID();
  // New identity on reauthorization invalidates reads that started on old tokens.
  await prisma.$transaction(async tx => {
    await tx.notionConnection.deleteMany({ where: { ownerId, workspaceId: data.workspace_id } });
    await tx.notionConnection.create({ data: { id, ownerId, workspaceId: data.workspace_id,
      workspaceName: String(data.workspace_name ?? "Notion").slice(0, 512),
      ciphertext: sealNotion({ access_token: data.access_token, refresh_token: data.refresh_token }, ownerId, id), expiresAt: new Date(Date.now() + WEEK) } });
  });
  return { returnTo: row.returnTo, success: true };
}
export async function cleanupExpiredNotionConnections() {
  await prisma.notionOAuthState.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  await prisma.notionConnection.deleteMany({ where: { expiresAt: { lte: new Date() } } });
}
export async function listNotionConnections(ownerId: string) {
  config();
  await prisma.notionConnection.deleteMany({ where: { ownerId, expiresAt: { lte: new Date() } } });
  return prisma.notionConnection.findMany({ where: { ownerId }, orderBy: { createdAt: "asc" }, select: { id: true, workspaceId: true, workspaceName: true, expiresAt: true } });
}
async function load(ownerId: string, id: string) {
  const row = await prisma.notionConnection.findFirst({ where: { id, ownerId, expiresAt: { gt: new Date() } } });
  if (!row) throw new NotionError("AUTH", "连接已过期或断开，请重新授权。 / Connection expired or disconnected.");
  return row;
}
export async function disconnectNotion(ownerId: string, id: string) {
  const row = await load(ownerId, id);
  await prisma.notionConnection.deleteMany({ where: { id, ownerId } });
  // Local disconnection is authoritative even if Notion cannot be reached.
  try { await tokenRequest({ token: unsealNotion(row.ciphertext, ownerId, id).access_token }, "revoke"); } catch { /* No token-bearing errors logged. */ }
}
export async function withNotion<T>(ownerId: string, id: string, operation: (client: NotionClient, row: Awaited<ReturnType<typeof load>>) => Promise<T>, signal?: AbortSignal): Promise<T> {
  let row = await load(ownerId, id);
  let result: T;
  try { result = await operation(new NotionClient(unsealNotion(row.ciphertext, ownerId, id).access_token, signal), row); }
  catch (error) {
    if (!(error instanceof NotionError) || error.code !== "AUTH") throw error;
    // Serialize refreshes across processes. Recheck revision after obtaining the lock.
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "NotionConnection" WHERE "id" = ${id} AND "ownerId" = ${ownerId} FOR UPDATE`;
      const current = await tx.notionConnection.findFirst({ where: { id, ownerId, expiresAt: { gt: new Date() } } });
      if (!current) throw error;
      if (current.revision !== row.revision) return;
      const tokens = unsealNotion(current.ciphertext, ownerId, id);
      if (!tokens.refresh_token) throw error;
      const next = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
      if (!next.access_token || !next.refresh_token) throw error;
      await tx.notionConnection.update({ where: { id }, data: { ciphertext: sealNotion({ access_token: next.access_token, refresh_token: next.refresh_token }, ownerId, id), revision: { increment: 1 } } });
    }, { timeout: 40_000, maxWait: 45_000 });
    row = await load(ownerId, id);
    result = await operation(new NotionClient(unsealNotion(row.ciphertext, ownerId, id).access_token, signal), row);
  }
  await load(ownerId, id); // Do not release content after disconnect or expiry.
  return result;
}

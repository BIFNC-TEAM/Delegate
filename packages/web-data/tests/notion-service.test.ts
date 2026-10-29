import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({
  state: { findUnique: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  connection: { findFirst: vi.fn(), deleteMany: vi.fn(), create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  transaction: vi.fn(), query: vi.fn(),
}));
vi.mock("../src/prisma", () => ({ prisma: { notionOAuthState: db.state, notionConnection: db.connection, $transaction: db.transaction } }));
import { beginNotionAuthorization, finishNotionAuthorization, sealNotion, unsealNotion, stateHash, withNotion, cleanupExpiredNotionConnections } from "../src/notion/service";
import { NotionError } from "../src/notion/types";
const transport = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NOTION_CLIENT_ID", "test-client"); vi.stubEnv("NOTION_CLIENT_SECRET", "test-secret");
  vi.stubEnv("NOTION_REDIRECT_URI", "http://localhost:3001/api/dashboard/notion/callback");
  vi.stubEnv("NOTION_CREDENTIAL_KEY", randomBytes(32).toString("base64"));
  vi.stubGlobal("fetch", transport);
  db.state.deleteMany.mockResolvedValue({ count: 1 });
  db.connection.deleteMany.mockResolvedValue({ count: 1 });
  db.transaction.mockImplementation(fn => fn({ notionConnection: db.connection, $queryRaw: db.query }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function oauthRow() {
  return { id: stateHash("state"), ownerId: "owner", browserHash: stateHash("browser"), expiresAt: new Date(Date.now() + 60_000), returnTo: "/dashboard?view=knowledge" };
}
function connectionRow() {
  return { id: "connection", ownerId: "owner", revision: 0, expiresAt: new Date(Date.now() + 60_000), ciphertext: sealNotion({ access_token: "access", refresh_token: "refresh" }, "owner", "connection") };
}
it("encrypts credentials with owner and connection binding", () => {
  const value = sealNotion({ access_token: "private-token" }, "owner", "connection");
  expect(value).not.toContain("private-token");
  expect(unsealNotion(value, "owner", "connection")).toEqual({ access_token: "private-token" });
  expect(() => unsealNotion(value, "another", "connection")).toThrow();
  expect(() => unsealNotion(value, "owner", "another")).toThrow();
});
it("generates random OAuth state, stores its hash, and rejects external return URLs", async () => {
  const result = await beginNotionAuthorization("owner", "browser", "/dashboard?view=knowledge");
  const url = new URL(result.url); const state = url.searchParams.get("state")!;
  expect(url.origin).toBe("https://api.notion.com");
  expect(db.state.create.mock.calls[0]![0].data).toMatchObject({ id: stateHash(state), ownerId: "owner", browserHash: stateHash("browser") });
  await expect(beginNotionAuthorization("owner", "browser", "https://other.example/dashboard")).rejects.toMatchObject({ code: "STATE" });
});
it.each(["wrong-browser", "wrong-owner", "expired", "replayed"])("rejects %s OAuth callbacks before token exchange", async variant => {
  const row = oauthRow();
  if (variant === "expired") row.expiresAt = new Date(0);
  db.state.findUnique.mockResolvedValue(row);
  if (variant === "replayed") db.state.deleteMany.mockResolvedValue({ count: 0 });
  await expect(finishNotionAuthorization("state", variant === "wrong-browser" ? "other" : "browser", variant === "wrong-owner" ? "other" : "owner", "code")).rejects.toMatchObject({ code: "STATE" });
  expect(transport).not.toHaveBeenCalled();
});
it("stores an encrypted seven-day workspace connection after successful authorization", async () => {
  db.state.findUnique.mockResolvedValue(oauthRow());
  transport.mockResolvedValue(Response.json({ access_token: "access", refresh_token: "refresh", workspace_id: "workspace", workspace_name: "Workspace" }));
  const before = Date.now();
  expect(await finishNotionAuthorization("state", "browser", "owner", "code")).toMatchObject({ success: true });
  const data = db.connection.create.mock.calls[0]![0].data;
  expect(data.expiresAt.getTime() - before).toBeGreaterThanOrEqual(7 * 86400_000);
  expect(data.expiresAt.getTime() - before).toBeLessThan(7 * 86400_000 + 1000);
  expect(unsealNotion(data.ciphertext, "owner", data.id)).toEqual({ access_token: "access", refresh_token: "refresh" });
  expect(db.connection.deleteMany).toHaveBeenCalledWith({ where: { ownerId: "owner", workspaceId: "workspace" } });
});
it("consumes a cancelled authorization without token exchange", async () => {
  db.state.findUnique.mockResolvedValue(oauthRow());
  expect(await finishNotionAuthorization("state", "browser", "owner", null)).toMatchObject({ success: false });
  expect(transport).not.toHaveBeenCalled();
});
it("scopes every read to the owner and refuses stale/disconnected connections", async () => {
  db.connection.findFirst.mockResolvedValue(null);
  const operation = vi.fn();
  await expect(withNotion("other", "connection", operation)).rejects.toMatchObject({ code: "AUTH" });
  expect(db.connection.findFirst).toHaveBeenCalledWith({ where: { id: "connection", ownerId: "other", expiresAt: { gt: expect.any(Date) } } });
  expect(operation).not.toHaveBeenCalled();
});
it("does not release a completed download after disconnect", async () => {
  db.connection.findFirst.mockResolvedValueOnce(connectionRow()).mockResolvedValueOnce(null);
  await expect(withNotion("owner", "connection", async () => "private-body")).rejects.toMatchObject({ code: "AUTH" });
});
it("serializes refresh, updates tokens, and keeps the original seven-day expiry", async () => {
  db.connection.findFirst.mockResolvedValue(connectionRow());
  transport.mockResolvedValue(Response.json({ access_token: "new-access", refresh_token: "new-refresh" }));
  const operation = vi.fn().mockRejectedValueOnce(new NotionError("AUTH", "expired")).mockResolvedValueOnce("content");
  expect(await withNotion("owner", "connection", operation)).toBe("content");
  expect(db.query).toHaveBeenCalled();
  const data = db.connection.update.mock.calls[0]![0].data;
  expect(data).not.toHaveProperty("expiresAt");
  expect(unsealNotion(data.ciphertext, "owner", "connection")).toEqual({ access_token: "new-access", refresh_token: "new-refresh" });
});
it("expires only connections and OAuth states, without deleting imported knowledge", async () => {
  await cleanupExpiredNotionConnections();
  expect(db.connection.deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lte: expect.any(Date) } } });
  expect(db.state.deleteMany).toHaveBeenCalled();
});

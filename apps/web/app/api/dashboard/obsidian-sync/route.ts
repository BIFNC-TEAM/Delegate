import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveKnowledgeLibraryOwnerId } from "@delegate/web-data";
import {
  SyncError, getObsidianConnection, connectObsidian, disconnectObsidian,
  listObsidianVaults, unlockObsidianVault, readObsidianNotes,
} from "@delegate/web-data/obsidian-sync";
import { dashboardAuthErrorResponse, requireDashboardApiOwnerSession } from "../auth";

export const runtime = "nodejs";
export const maxDuration = 120;
const id = z.string().min(1).max(128);
const connection = { connectionId: id };
const vault = { ...connection, vaultId: id };
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }),
  z.object({ action: z.literal("connect"), email: z.email().max(320), password: z.string().min(1).max(1024), mfa: z.string().max(32).optional() }),
  z.object({ action: z.literal("disconnect"), ...connection }),
  z.object({ action: z.literal("vaults"), ...connection }),
  z.object({ action: z.literal("unlock"), ...vault, password: z.string().max(1024) }),
  z.object({ action: z.literal("notes"), ...vault }),
  z.object({ action: z.literal("download"), ...vault, selected: z.array(id).min(1).max(1000) }),
]);
const messages: Record<SyncError["code"], string> = {
  MFA_REQUIRED: "请输入 Obsidian 两步验证验证码。 / Enter your Obsidian verification code.",
  AUTH_FAILED: "登录失败，请检查账号信息或稍后重试。 / Sign-in failed. Check your credentials or retry.",
  LOCKED: "请输入正确的笔记库密码。 / Enter the correct vault password.",
  NOT_FOUND: "笔记库不可访问，请刷新列表。 / Vault unavailable. Refresh the list.",
  EXPIRED: "连接已过期或断开，请重新连接。 / Connection expired. Reconnect your account.",
  CHANGED: "连接或笔记已变化，请刷新后重试。 / Connection or notes changed. Refresh and retry.",
  LIMIT: "所选笔记超出导入限制，请减少选择或拆分笔记。 / Selection exceeds import limits.",
  UNAVAILABLE: "Sync 导入服务未就绪，请联系管理员。 / Sync import is not configured.",
  NETWORK: "无法读取 Obsidian，请稍后重试。 / Unable to read Obsidian. Please retry.",
};
const json = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store", "Pragma": "no-cache" },
});

export async function POST(request: Request) {
  try {
    // All actions use JSON and same-origin requests, including local development.
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.headers.get("host")) return json({ error: "Invalid origin." }, 403);
    if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "JSON required." }, 415);
    const session = await requireDashboardApiOwnerSession();
    const ownerId = await resolveKnowledgeLibraryOwnerId(session?.ownerId, request.headers.get("x-delegate-representative"));
    if (!ownerId) return json({ error: "Authentication required." }, 401);
    if (Number(request.headers.get("content-length") ?? 0) > 150_000) return json({ error: "Request too large." }, 413);
    const body = await request.text();
    if (body.length > 150_000) return json({ error: "Request too large." }, 413);
    const input = schema.parse(JSON.parse(body));
    switch (input.action) {
      case "status": return json({ connection: await getObsidianConnection(ownerId) });
      case "connect": return json({ connection: await connectObsidian(ownerId, input.email, input.password, input.mfa) });
      case "disconnect":
        await disconnectObsidian(ownerId, input.connectionId);
        return json({ connection: null });
      case "vaults": return json({ vaults: await listObsidianVaults(ownerId, input.connectionId) });
      case "unlock":
        await unlockObsidianVault(ownerId, input.connectionId, input.vaultId, input.password);
        return json({ unlocked: true });
      case "notes": return json(await readObsidianNotes(ownerId, input.connectionId, input.vaultId));
      case "download": return json(await readObsidianNotes(ownerId, input.connectionId, input.vaultId, input.selected));
    }
  } catch (error) {
    const auth = dashboardAuthErrorResponse(error);
    if (auth) return auth;
    if (error instanceof SyncError) return json({ code: error.code, error: messages[error.code] }, error.code === "UNAVAILABLE" ? 503 : 422);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "Invalid request." }, 400);
    return json({ error: "Sync 导入暂时失败，请重试。 / Sync import failed. Please retry." }, 500);
  }
}

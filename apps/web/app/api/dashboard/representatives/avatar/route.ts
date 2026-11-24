import { NextResponse } from "next/server";
import {
  AvatarUploadError,
  MAX_AVATAR_FILE_BYTES,
  storeOwnerAvatar,
} from "@delegate/web-data/owner-avatar-storage";
import {
  dashboardAuthErrorResponse,
  requireDashboardApiOwnerSession,
} from "../../auth";
import { withPrivateNoStore } from "../../../private-response";

export async function POST(request: Request) {
  const reply = (body: unknown, status = 200) =>
    withPrivateNoStore(NextResponse.json(body, { status }));
  try {
    const session = await requireDashboardApiOwnerSession();
    if (!session?.ownerId) return reply({ error: "请先登录后上传头像。" }, 401);
    if (Number(request.headers.get("content-length")) > MAX_AVATAR_FILE_BYTES)
      return reply({ error: "头像不能超过 5 MB。" }, 413);
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: "请选择头像文件。" }, 400);
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_AVATAR_FILE_BYTES) {
          void reader.cancel().catch(() => {});
          return reply({ error: "头像不能超过 5 MB。" }, 413);
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const stored = await storeOwnerAvatar(
      session.ownerId,
      Buffer.concat(parts),
    );
    return reply({ url: stored.url });
  } catch (error) {
    return (
      dashboardAuthErrorResponse(error) ??
      reply(
        {
          error:
            error instanceof AvatarUploadError
              ? error.message
              : "头像上传失败，请重试。",
        },
        error instanceof AvatarUploadError ? error.status : 500,
      )
    );
  }
}

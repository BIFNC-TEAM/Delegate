import type { Metadata } from "next";

import { sanitizeCreatorReturnTo } from "../../../auth-guard";

export const metadata: Metadata = {
  title: "Account access · Delegate",
  robots: {
    index: false,
    follow: false,
  },
};

type AuthErrorReason =
  | "creator_access_required"
  | "login_failed"
  | "signed_out";

export default async function CreatorAuthErrorPage({
  searchParams,
}: {
  searchParams?: Promise<{ reason?: string; returnTo?: string }>;
}) {
  const params = searchParams ? await searchParams : undefined;
  const reason = normalizeReason(params?.reason);
  const denied = reason === "creator_access_required";
  const signedOut = reason === "signed_out";
  const loginHref = `/auth/login?returnTo=${encodeURIComponent(
    sanitizeCreatorReturnTo(params?.returnTo),
  )}`;

  return (
    <main className="creator-auth-error-shell dashboard-v2-shell">
      <section className="creator-auth-error-card" aria-labelledby="auth-error-title">
        <div className="creator-auth-error-brand">
          <span aria-hidden="true">D</span>
          <div>
            <strong>Delegate</strong>
            <small>Creator control plane</small>
          </div>
        </div>

        <p className="creator-auth-error-code">
          {denied
            ? "ACCESS · INVITATION REQUIRED"
            : signedOut
              ? "SESSION · SIGNED OUT"
              : "AUTH · ACTION REQUIRED"}
        </p>
        <h1 id="auth-error-title">
          {denied
            ? "此账号尚未开通 Creator 权限"
            : signedOut
              ? "已退出当前 Delegate 会话"
              : "登录暂未完成"}
        </h1>
        <p className="creator-auth-error-lead">
          {denied
            ? "你的 Logto 账号已通过验证，但尚未被邀请进入 Delegate Dashboard。"
            : signedOut
              ? "这个浏览器中的 Dashboard 会话已清除，并已在 Delegate 侧撤销。"
              : "Delegate 无法完成本次登录。请稍后重试；若问题持续，请联系管理员。"}
        </p>
        <p className="creator-auth-error-translation">
          {denied
            ? "Your identity is verified, but Creator Dashboard access requires an explicit invitation."
            : signedOut
              ? "The Dashboard session in this browser has been cleared and revoked by Delegate."
              : "Delegate could not complete this sign-in. Try again or contact an administrator."}
        </p>

        <div className="creator-auth-error-boundary">
          <strong>{signedOut ? "退出范围" : "身份与权限边界"}</strong>
          <p>
            {signedOut
              ? "本次操作只退出 Delegate 的当前浏览器会话；Logto 中央会话和其他应用会话不会在此步骤中结束。"
              : "登录成功只确认账号身份，不会自动授予 Creator、Workspace 或业务数据访问权限。"}
          </p>
        </div>

        <div className="creator-auth-error-actions">
          <a href={loginHref}>
            {signedOut
              ? "重新登录 · Sign in again"
              : "重新检查权限 · Check again"}
          </a>
          <p>
            {denied
              ? "管理员完成邀请后，可使用同一账号重新登录。"
              : signedOut
                ? "只有在你明确选择重新登录后，Delegate 才会再次使用 Logto 会话。"
                : "请重新发起登录；若问题持续，请联系管理员。"}
          </p>
        </div>
      </section>
    </main>
  );
}

function normalizeReason(reason: string | undefined): AuthErrorReason {
  if (reason === "creator_access_required" || reason === "signed_out") {
    return reason;
  }
  return "login_failed";
}

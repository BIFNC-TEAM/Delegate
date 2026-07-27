"use client";

import { useEffect, useState, useTransition } from "react";

import type { Locale } from "@delegate/web-ui";

type BindingSnapshot = {
  provider: "TELEGRAM" | "MATRIX";
  providerSubject: string;
  issuer: string;
  verifiedAt: string | null;
};

type BindingInstruction = {
  provider: "telegram" | "matrix";
  command: string;
  expiresAt: string;
};

export function RepresentativeIdentityBindingPanel({
  locale,
  representativeSlug,
}: {
  locale: Locale;
  representativeSlug: string;
}) {
  const zh = locale === "zh";
  const [bindings, setBindings] = useState<BindingSnapshot[]>([]);
  const [matrixUserId, setMatrixUserId] = useState("");
  const [instruction, setInstruction] = useState<BindingInstruction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    void fetch(`/reps/${representativeSlug}/identity-bindings`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await extractError(response));
        return response.json() as Promise<{ bindings: BindingSnapshot[] }>;
      })
      .then((payload) => {
        if (active) setBindings(payload.bindings);
      })
      .catch((nextError: unknown) => {
        if (active) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : zh
                ? "读取绑定状态失败。"
                : "Unable to load bindings.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [representativeSlug, zh]);

  function createBinding(provider: "telegram" | "matrix") {
    setError(null);
    setInstruction(null);
    startTransition(() => {
      void fetch(`/reps/${representativeSlug}/identity-bindings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          ...(provider === "matrix" ? { providerSubject: matrixUserId } : {}),
        }),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(await extractError(response));
          return response.json() as Promise<BindingInstruction>;
        })
        .then(setInstruction)
        .catch((nextError: unknown) => {
          setError(
            nextError instanceof Error
              ? nextError.message
              : zh
                ? "生成绑定命令失败。"
                : "Unable to create a binding command.",
          );
        });
    });
  }

  return (
    <div className="setup-stack">
      {bindings.length ? (
        <div className="chip-row" aria-label={zh ? "已绑定账户" : "Linked accounts"}>
          {bindings.map((binding) => (
            <span className="chip chip-safe" key={`${binding.provider}:${binding.providerSubject}`}>
              {binding.provider === "TELEGRAM" ? "Telegram" : "Matrix"} ·{" "}
              {binding.providerSubject}
            </span>
          ))}
        </div>
      ) : (
        <p className="footer-note">
          {zh
            ? "目前没有绑定的私聊账户。"
            : "No private-channel account is linked yet."}
        </p>
      )}

      <div className="setup-grid">
        <article className="representative-capability-card">
          <strong>Telegram</strong>
          <p>
            {zh
              ? "把当前登录的 Delegate 账号与 Telegram 私聊身份关联，Web 充值余额和服务权益会保持一致。系统会生成一次性命令，请只在 Delegate Bot 私聊中发送。"
              : "Link the signed-in Delegate account to your Telegram private-chat identity so Web balance and service entitlements stay aligned. A one-time command will be created for the Delegate Bot private chat."}
          </p>
          <button
            className="button-secondary"
            disabled={isPending}
            onClick={() => createBinding("telegram")}
            type="button"
          >
            {zh ? "绑定我的 Telegram 账号" : "Link my Telegram account"}
          </button>
        </article>

        <article className="representative-capability-card">
          <strong>Matrix</strong>
          <p>
            {zh
              ? "先填写完整 MXID，再把一次性命令发送到与代表的未加密私聊房间。"
              : "Enter your full MXID, then send the one-time command in the unencrypted direct room with the representative."}
          </p>
          <label className="field-stack">
            <span className="field-hint">{zh ? "Matrix 用户 ID" : "Matrix user ID"}</span>
            <input
              autoComplete="username"
              className="text-input"
              onChange={(event) => setMatrixUserId(event.target.value)}
              placeholder="@alice:example.org"
              spellCheck={false}
              value={matrixUserId}
            />
          </label>
          <button
            className="button-secondary"
            disabled={isPending || !matrixUserId.trim()}
            onClick={() => createBinding("matrix")}
            type="button"
          >
            {zh ? "生成 Matrix 绑定命令" : "Create Matrix command"}
          </button>
        </article>
      </div>

      {instruction ? (
        <div className="status-banner status-success">
          <strong>
            {instruction.provider === "telegram"
              ? zh
                ? "复制命令并在 Delegate Bot 私聊中发送"
                : "Copy and send this command in the Delegate Bot private chat"
              : zh
                ? "请在对应 Matrix 私聊中发送以下命令"
                : "Send this command in the matching Matrix private chat"}
          </strong>
          <pre className="artifact-preview">{instruction.command}</pre>
          <p className="footer-note">
            {zh ? "一次性命令将在 " : "This one-time command expires at "}
            {new Date(instruction.expiresAt).toLocaleString(
              zh ? "zh-CN" : "en-US",
            )}
            {zh ? " 失效。" : "."}
          </p>
        </div>
      ) : null}

      {error ? <div className="status-banner status-error">{error}</div> : null}
    </div>
  );
}

async function extractError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return payload?.error || response.statusText;
}

"use client";

import { useEffect, useState } from "react";

import type { Locale } from "@delegate/web-ui";

type BindingSnapshot = {
  provider: "TELEGRAM" | "MATRIX";
  providerSubject: string;
  issuer: string;
  connectionId: string | null;
  verifiedAt: string | null;
};

type TelegramBotEndpoint = {
  botId: string;
  username: string | null;
};

type BindingInstruction = {
  provider: "telegram" | "matrix";
  command: string;
  expiresAt: string;
  scope: {
    issuer: string;
    connectionId: string;
  };
  telegramBot?: TelegramBotEndpoint;
};

type BindingCapabilities = {
  telegram: boolean;
  matrix: boolean;
};

type BindingStatePayload = {
  bindings: BindingSnapshot[];
  capabilities: BindingCapabilities;
  telegramBot: TelegramBotEndpoint | null;
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
  const [telegramBot, setTelegramBot] =
    useState<TelegramBotEndpoint | null>(null);
  const [capabilities, setCapabilities] =
    useState<BindingCapabilities | null>(null);
  const [matrixUserId, setMatrixUserId] = useState("");
  const [instruction, setInstruction] = useState<BindingInstruction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingProvider, setCreatingProvider] =
    useState<"telegram" | "matrix" | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [revokingKey, setRevokingKey] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchBindingState(representativeSlug)
      .then((payload) => {
        if (active) {
          setBindings(payload.bindings);
          setCapabilities(payload.capabilities);
          setTelegramBot(payload.telegramBot);
        }
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

  useEffect(() => {
    if (!instruction) return;
    let active = true;
    const expiresAt = Date.parse(instruction.expiresAt);
    const poll = async () => {
      if (!active) return;
      if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
        setInstruction(null);
        setCopiedCommand(null);
        setError(
          zh
            ? "一次性绑定命令已过期，请重新生成。"
            : "The one-time binding command expired. Create a new one.",
        );
        return;
      }
      try {
        const payload = await fetchBindingState(representativeSlug);
        if (!active) return;
        setBindings(payload.bindings);
        setCapabilities(payload.capabilities);
        setTelegramBot(payload.telegramBot);
        const expectedProvider =
          instruction.provider === "telegram" ? "TELEGRAM" : "MATRIX";
        const completed = payload.bindings.some(
          (binding) =>
            binding.provider === expectedProvider
            && binding.issuer === instruction.scope.issuer
            && binding.connectionId === instruction.scope.connectionId,
        );
        if (completed) {
          setInstruction(null);
          setCopiedCommand(null);
          setNotice(
            zh
              ? "绑定成功。这个私聊账号现在会使用当前 Delegate 账号的余额和服务权益。"
              : "Linked. This private-chat account now uses the current Delegate balance and service entitlements.",
          );
        }
      } catch {
        // A transient refresh failure must not discard the still-valid command.
      }
    };
    const timer = window.setInterval(() => {
      void poll();
    }, 2_000);
    void poll();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [instruction, representativeSlug, zh]);

  function createBinding(provider: "telegram" | "matrix") {
    if (creatingProvider) return;
    setError(null);
    setNotice(null);
    setInstruction(null);
    setCopiedCommand(null);
    setCreatingProvider(provider);
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
      .then((nextInstruction) => {
        setInstruction(nextInstruction);
        if (nextInstruction.telegramBot) {
          setTelegramBot(nextInstruction.telegramBot);
        }
      })
      .catch((nextError: unknown) => {
        setError(
          nextError instanceof Error
            ? nextError.message
            : zh
              ? "生成绑定命令失败。"
              : "Unable to create a binding command.",
        );
      })
      .finally(() => {
        setCreatingProvider((current) =>
          current === provider ? null : current,
        );
      });
  }

  async function copyBindingCommand() {
    if (!instruction) return;
    try {
      await navigator.clipboard.writeText(instruction.command);
      setCopiedCommand(instruction.command);
      setError(null);
    } catch {
      setError(
        zh
          ? "复制失败，请手动选择并复制命令。"
          : "Copy failed. Select and copy the command manually.",
      );
    }
  }

  function revokeBinding(binding: BindingSnapshot) {
    if (!binding.connectionId) {
      setError(
        zh
          ? "该旧版绑定缺少连接范围，无法安全解除；请先重新绑定到当前渠道。"
          : "This legacy binding has no connection scope and cannot be safely unlinked. Bind it to the current channel first.",
      );
      return;
    }
    const key = bindingKey(binding);
    const target =
      binding.provider === "TELEGRAM"
        ? telegramBindingTarget(binding, telegramBot)
        : binding.connectionId;
    const confirmed = window.confirm(
      binding.provider === "TELEGRAM"
        ? zh
          ? `解除后，此 Telegram 账号在 ${target} 下将不再对应当前 Delegate 账号。如果同一个 Bot 被多个数字代表共用，这些代表都会受影响。历史消息、余额和订单不会删除。继续吗？`
          : `This Telegram account will no longer map to the current Delegate account on ${target}. If several representatives share that Bot, all of them are affected. History, balance, and orders are preserved. Continue?`
        : zh
          ? `解除后，此 Matrix 账号在连接 ${target} 下将不再对应当前 Delegate 账号；共用该连接的代表都会受影响。历史消息、余额和订单不会删除。继续吗？`
          : `This Matrix account will no longer map to the current Delegate account on connection ${target}; representatives sharing it are affected. History, balance, and orders are preserved. Continue?`,
    );
    if (!confirmed) return;

    setError(null);
    setNotice(null);
    setRevokingKey(key);
    void fetch(`/reps/${representativeSlug}/identity-bindings`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: binding.provider.toLowerCase(),
        providerSubject: binding.providerSubject,
        issuer: binding.issuer,
        connectionId: binding.connectionId,
      }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await extractError(response));
        return response.json() as Promise<{ changed: boolean }>;
      })
      .then(() => {
        setBindings((current) =>
          current.filter((candidate) => bindingKey(candidate) !== key),
        );
        setNotice(
          zh
            ? "已解除该渠道连接。历史消息、余额和订单均已保留；如需恢复，请重新生成并发送一次性绑定命令。"
            : "The channel connection is unlinked. History, balance, and orders are preserved; create and send a new one-time command to restore it.",
        );
      })
      .catch((nextError: unknown) => {
        setError(
          nextError instanceof Error
            ? nextError.message
            : zh
              ? "解除绑定失败。"
              : "Unable to unlink this connection.",
        );
      })
      .finally(() => {
        setRevokingKey((current) => (current === key ? null : current));
      });
  }

  return (
    <div className="setup-stack">
      {bindings.length ? (
        <div className="chip-row" aria-label={zh ? "已绑定账户" : "Linked accounts"}>
          {bindings.map((binding) => {
            const key = bindingKey(binding);
            return (
              <span className="identity-binding-item" key={key}>
                <span className="chip chip-safe">
                  {binding.provider === "TELEGRAM" ? "Telegram" : "Matrix"} ·{" "}
                  {binding.providerSubject}
                  {binding.provider === "TELEGRAM" ? (
                    <>
                      {" · "}
                      {telegramBindingTarget(binding, telegramBot)}
                      {telegramBot?.botId === binding.connectionId
                        ? zh
                          ? " · 当前代表"
                          : " · Current representative"
                        : null}
                    </>
                  ) : (
                    <>
                      {" · "}
                      {binding.connectionId
                        ?? (zh ? "旧版绑定，需重新绑定" : "Legacy binding; rebind required")}
                    </>
                  )}
                </span>
                <button
                  aria-label={
                    zh
                      ? `解除 ${binding.provider === "TELEGRAM" ? "Telegram" : "Matrix"} 连接`
                      : `Unlink ${binding.provider === "TELEGRAM" ? "Telegram" : "Matrix"} connection`
                  }
                  className="identity-binding-unlink"
                  disabled={
                    binding.connectionId === null
                    || revokingKey !== null
                    || creatingProvider !== null
                  }
                  onClick={() => revokeBinding(binding)}
                  type="button"
                >
                  {binding.connectionId === null
                    ? zh
                      ? "需重新绑定"
                      : "Rebind required"
                    : revokingKey === key
                    ? zh
                      ? "解除中…"
                      : "Unlinking…"
                    : zh
                      ? "解除绑定"
                      : "Unlink"}
                </button>
              </span>
            );
          })}
        </div>
      ) : (
        <p className="footer-note">
          {zh
            ? "目前没有绑定的私聊账户。"
            : "No private-channel account is linked yet."}
        </p>
      )}

      <div className="setup-grid">
        {capabilities?.telegram ? (
          <article className="representative-capability-card">
          <strong>Telegram</strong>
          <p>
            {zh
              ? "把当前登录的 Delegate 账号与 Telegram 私聊身份关联，Web 充值余额和服务权益会保持一致。系统会明确显示当前代表使用的目标 Bot，请只在该 Bot 私聊中发送一次性命令。"
              : "Link the signed-in Delegate account to your Telegram private-chat identity so Web balance and service entitlements stay aligned. The exact Bot for this representative will be shown with the one-time command."}
          </p>
          <button
            className="button-secondary"
            disabled={creatingProvider !== null}
            onClick={() => createBinding("telegram")}
            type="button"
          >
            {creatingProvider === "telegram"
              ? zh
                ? "生成中…"
                : "Creating…"
              : zh
                ? "绑定我的 Telegram 账号"
                : "Link my Telegram account"}
          </button>
          </article>
        ) : null}

        {capabilities?.matrix ? (
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
            disabled={creatingProvider !== null || !matrixUserId.trim()}
            onClick={() => createBinding("matrix")}
            type="button"
          >
            {creatingProvider === "matrix"
              ? zh
                ? "生成中…"
                : "Creating…"
              : zh
                ? "生成 Matrix 绑定命令"
                : "Create Matrix command"}
          </button>
          </article>
        ) : null}
      </div>

      {capabilities
      && !capabilities.telegram
      && !capabilities.matrix ? (
        <p className="footer-note">
          {zh
            ? "当前代表暂未开放可绑定的私聊渠道。"
            : "This representative has no linkable private-chat channel yet."}
        </p>
      ) : null}

      {instruction ? (
        <div className="status-banner status-success">
          <strong>
            {instruction.provider === "telegram"
              ? zh
                ? `复制命令并发送给 ${
                    instruction.telegramBot
                      ? telegramBotLabel(instruction.telegramBot)
                      : "当前代表的 Telegram Bot"
                  }`
                : `Copy and send this command to ${
                    instruction.telegramBot
                      ? telegramBotLabel(instruction.telegramBot)
                      : "this representative's Telegram Bot"
                  }`
              : zh
                ? "请在对应 Matrix 私聊中发送以下命令"
                : "Send this command in the matching Matrix private chat"}
          </strong>
          <pre className="artifact-preview">{instruction.command}</pre>
          <div className="chip-row">
            <button
              className="button-secondary"
              disabled={copiedCommand === instruction.command}
              onClick={() => void copyBindingCommand()}
              type="button"
            >
              {copiedCommand === instruction.command
                ? zh
                  ? "已复制"
                  : "Copied"
                : zh
                  ? "复制命令"
                  : "Copy command"}
            </button>
            {instruction.provider === "telegram"
            && instruction.telegramBot?.username ? (
              <a
                className="button-secondary"
                href={telegramBotUrl(
                  instruction.telegramBot,
                  representativeSlug,
                )}
                rel="noreferrer"
                target="_blank"
              >
                {zh
                  ? `打开 ${telegramBotLabel(instruction.telegramBot)}`
                  : `Open ${telegramBotLabel(instruction.telegramBot)}`}
              </a>
            ) : null}
          </div>
          <p className="footer-note">
            {zh ? "一次性命令将在 " : "This one-time command expires at "}
            {new Date(instruction.expiresAt).toLocaleString(
              zh ? "zh-CN" : "en-US",
            )}
            {zh ? " 失效。" : "."}
          </p>
        </div>
      ) : null}

      {notice ? <div className="status-banner status-success">{notice}</div> : null}
      {error ? <div className="status-banner status-error">{error}</div> : null}
    </div>
  );
}

function bindingKey(binding: BindingSnapshot): string {
  return [
    binding.provider,
    binding.providerSubject,
    binding.issuer,
    binding.connectionId,
  ].join(":");
}

function telegramBindingTarget(
  binding: BindingSnapshot,
  currentBot: TelegramBotEndpoint | null,
): string {
  return currentBot?.botId === binding.connectionId
    ? telegramBotLabel(currentBot)
    : binding.connectionId
      ? `Bot ID ${binding.connectionId}`
      : "Legacy Telegram binding";
}

function telegramBotLabel(bot: TelegramBotEndpoint): string {
  return bot.username ? `@${bot.username}` : `Bot ID ${bot.botId}`;
}

function telegramBotUrl(
  bot: TelegramBotEndpoint,
  representativeSlug: string,
): string {
  if (!bot.username) return "https://t.me";
  const payload = `rep_${representativeSlug}`;
  return /^[A-Za-z0-9_-]{1,64}$/.test(payload)
    ? `https://t.me/${bot.username}?start=${payload}`
    : `https://t.me/${bot.username}`;
}

async function extractError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return payload?.error || response.statusText;
}

async function fetchBindingState(
  representativeSlug: string,
): Promise<BindingStatePayload> {
  const response = await fetch(
    `/reps/${representativeSlug}/identity-bindings`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(await extractError(response));
  return response.json() as Promise<BindingStatePayload>;
}

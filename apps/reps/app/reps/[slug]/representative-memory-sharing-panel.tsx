"use client";

import { useEffect, useRef, useState } from "react";

import type { Locale } from "@delegate/web-ui";

type MemorySharingState = {
  supported: boolean;
  policyEnabled: boolean;
  active: boolean;
  contractVersion: string;
  grantedAt: string | null;
  sourceChannel: "WEB" | "MATRIX" | "TELEGRAM" | null;
  blockedReason: string | null;
  challengeToken: string | null;
  challengeExpiresAt: string | null;
};

export function RepresentativeMemorySharingPanel({
  locale,
  representativeSlug,
}: {
  locale: Locale;
  representativeSlug: string;
}) {
  const zh = locale === "zh";
  const [state, setState] = useState<MemorySharingState | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmingRevocation, setConfirmingRevocation] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operationGenerationRef = useRef(0);

  useEffect(() => {
    const operationGeneration = operationGenerationRef.current + 1;
    operationGenerationRef.current = operationGeneration;
    setLoading(true);
    setState(null);
    setConfirmed(false);
    setConfirmingRevocation(false);
    setNotice(null);
    setError(null);
    void fetchMemorySharingState(representativeSlug)
      .then((payload) => {
        if (operationGenerationRef.current !== operationGeneration) return;
        setState(payload);
      })
      .catch((nextError: unknown) => {
        if (operationGenerationRef.current !== operationGeneration) return;
        setError(
          nextError instanceof Error
            ? nextError.message
            : zh
              ? "读取跨渠道记忆授权状态失败。"
              : "Unable to load cross-channel memory consent.",
        );
      })
      .finally(() => {
        if (operationGenerationRef.current === operationGeneration) {
          setLoading(false);
        }
      });
  }, [loadAttempt, representativeSlug, zh]);

  function grantConsent() {
    if (
      saving
      || !confirmed
      || !state?.supported
      || !state.policyEnabled
      || state.active
      || state.contractVersion === "unavailable"
      || !state.challengeToken
    ) {
      return;
    }
    const operationGeneration = operationGenerationRef.current;
    setSaving(true);
    setNotice(null);
    setError(null);
    void mutateMemorySharingState(representativeSlug, {
      method: "POST",
      body: JSON.stringify({
        challengeToken: state.challengeToken,
      }),
    })
      .then((payload) => {
        if (operationGenerationRef.current !== operationGeneration) return;
        setState(payload);
        setConfirmed(false);
        setNotice(
          zh
            ? "跨渠道联系人记忆已启用，只会在当前数字代表下、同一已验证身份的已绑定渠道间共享。"
            : "Cross-channel contact memory is on only for this representative and channels linked to the same verified identity.",
        );
      })
      .catch((nextError: unknown) => {
        if (operationGenerationRef.current !== operationGeneration) return;
        setError(
          nextError instanceof Error
            ? nextError.message
            : zh
              ? "启用跨渠道记忆失败。"
              : "Unable to enable cross-channel memory.",
        );
      })
      .finally(() => {
        if (operationGenerationRef.current === operationGeneration) {
          setSaving(false);
        }
      });
  }

  function revokeConsent() {
    if (saving || !state?.active) return;
    const operationGeneration = operationGenerationRef.current;
    setSaving(true);
    setNotice(null);
    setError(null);
    void mutateMemorySharingState(representativeSlug, { method: "DELETE" })
      .then((payload) => {
        if (operationGenerationRef.current !== operationGeneration) return;
        setState(payload);
        setConfirmingRevocation(false);
        setNotice(
          zh
            ? "共享召回已立即停止；已有共享记忆正在异步清理。账号绑定、历史消息、订单与权益不会删除。"
            : "Shared recall stopped immediately and existing shared memory is being removed asynchronously. Account links, message history, orders, and entitlements are unchanged.",
        );
      })
      .catch((nextError: unknown) => {
        if (operationGenerationRef.current !== operationGeneration) return;
        setError(
          nextError instanceof Error
            ? nextError.message
            : zh
              ? "撤回跨渠道记忆授权失败。"
              : "Unable to withdraw cross-channel memory consent.",
        );
      })
      .finally(() => {
        if (operationGenerationRef.current === operationGeneration) {
          setSaving(false);
        }
      });
  }

  return (
    <article className="representative-capability-card">
      <div className="setup-stack">
        <div>
          <div className="chip-row">
            <strong>
              {zh ? "跨渠道联系人记忆" : "Cross-channel contact memory"}
            </strong>
            {state ? (
              <span className={`chip${state.active ? " chip-safe" : ""}`}>
                {memorySharingStatus(state, zh)}
              </span>
            ) : null}
          </div>
          <p>
            {zh
              ? "启用后，这个数字代表可以在已验证且绑定到同一 Delegate 身份的 Web、Matrix 与 Telegram 私聊中延续与你有关的安全、最小化联系人记忆。未验证账号、其他联系人和其他数字代表始终隔离。"
              : "When enabled, this representative may continue safe, minimized contact memory across Web, Matrix, and Telegram private chats linked to the same verified Delegate identity. Unverified accounts, other contacts, and other representatives remain isolated."}
          </p>
        </div>

        <div className="status-banner">
          <strong>{zh ? "记住什么" : "What may be remembered"}</strong>
          <p>
            {zh
              ? "仅限通过安全策略的偏好、目标、约束和完成服务所需的必要背景。共享范围只覆盖当前数字代表。"
              : "Only preferences, goals, constraints, and necessary service context that pass safety policy. Sharing is limited to this representative."}
          </p>
          <strong>{zh ? "永远不共享什么" : "What is never shared"}</strong>
          <p>
            {zh
              ? "原始聊天全文、Owner 私有备注、Compute 原始产物、凭据，以及付款、余额、退款和权益事实不会进入跨渠道记忆。"
              : "Raw chat transcripts, Owner private notes, raw Compute outputs, credentials, and payment, balance, refund, or entitlement facts never enter cross-channel memory."}
          </p>
          <strong>{zh ? "如何撤回" : "How withdrawal works"}</strong>
          <p>
            {zh
              ? "你可以随时撤回。系统会立即停止共享召回，并异步删除已投影的共享记忆；各渠道历史消息、账号绑定、订单和权益不受影响。"
              : "You can withdraw at any time. Shared recall stops immediately and projected shared memory is removed asynchronously; channel history, account links, orders, and entitlements are not affected."}
          </p>
        </div>

        {loading ? (
          <p className="footer-note" role="status">
            {zh ? "正在读取授权状态…" : "Loading consent status…"}
          </p>
        ) : error && !state ? (
          <div className="status-banner status-error" role="alert">
            <span>{error}</span>
            <div className="chip-row">
              <button
                className="button-secondary"
                onClick={() => setLoadAttempt((current) => current + 1)}
                type="button"
              >
                {zh ? "重试" : "Retry"}
              </button>
            </div>
          </div>
        ) : state?.active ? (
          <div className="setup-stack">
            <p className="footer-note">
              {zh ? "授权已生效" : "Consent is active"}
              {state.grantedAt
                ? ` · ${new Date(state.grantedAt).toLocaleString(
                    zh ? "zh-CN" : "en-US",
                  )}`
                : ""}
            </p>
            {confirmingRevocation ? (
              <div className="status-banner" role="alert">
                <strong>
                  {zh
                    ? "确认停止并删除跨渠道联系人记忆？"
                    : "Stop and remove cross-channel contact memory?"}
                </strong>
                <p>
                  {zh
                    ? "确认后共享召回会立即停止，远端投影将异步清理。此操作不会删除聊天记录或账户绑定。"
                    : "Shared recall will stop immediately and remote projections will be removed asynchronously. Chat history and account links will remain."}
                </p>
                <div className="chip-row">
                  <button
                    className="button-secondary"
                    disabled={saving}
                    onClick={() => setConfirmingRevocation(false)}
                    type="button"
                  >
                    {zh ? "取消" : "Cancel"}
                  </button>
                  <button
                    className="button-primary"
                    disabled={saving}
                    onClick={revokeConsent}
                    type="button"
                  >
                    {saving
                      ? zh
                        ? "正在停止…"
                        : "Stopping…"
                      : zh
                        ? "确认停止并删除"
                        : "Confirm stop and remove"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="chip-row">
                <button
                  className="button-secondary"
                  disabled={saving}
                  onClick={() => setConfirmingRevocation(true)}
                  type="button"
                >
                  {zh
                    ? "停止并删除跨渠道记忆"
                    : "Stop and remove cross-channel memory"}
                </button>
              </div>
            )}
          </div>
        ) : state?.supported && state.policyEnabled ? (
          <div className="setup-stack">
            <label className="toggle-row">
              <input
                checked={confirmed}
                disabled={
                  saving
                  || state.contractVersion === "unavailable"
                  || !state.challengeToken
                }
                onChange={(event) => setConfirmed(event.target.checked)}
                type="checkbox"
              />
              <span>
                {zh
                  ? "我已阅读并明确同意上述跨渠道共享范围与删除方式。"
                  : "I have read and explicitly agree to the sharing scope and deletion behavior above."}
              </span>
            </label>
            <p className="footer-note">
              {zh ? "授权条款版本：" : "Consent terms version: "}
              <span className="chip">{state.contractVersion}</span>
            </p>
            <div className="chip-row">
              <button
                className="button-primary"
                disabled={
                  saving
                  || !confirmed
                  || state.contractVersion === "unavailable"
                  || !state.challengeToken
                }
                onClick={grantConsent}
                type="button"
              >
                {saving
                  ? zh
                    ? "正在启用…"
                    : "Enabling…"
                  : zh
                    ? "允许跨渠道联系人记忆"
                    : "Allow cross-channel contact memory"}
              </button>
            </div>
          </div>
        ) : state ? (
          <div className="status-banner" role="status">
            <strong>
              {zh
                ? "当前暂不能启用跨渠道记忆"
                : "Cross-channel memory is not available right now"}
            </strong>
            <p>{memorySharingBlockedCopy(state.blockedReason, zh)}</p>
          </div>
        ) : null}

        {notice ? (
          <div className="status-banner status-success" role="status">
            {notice}
          </div>
        ) : null}
        {error && state ? (
          <div className="status-banner status-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function memorySharingStatus(state: MemorySharingState, zh: boolean): string {
  if (state.active) return zh ? "已启用" : "Enabled";
  if (!state.supported) return zh ? "暂不支持" : "Unsupported";
  if (!state.policyEnabled) return zh ? "代表未启用" : "Not enabled by representative";
  return zh ? "等待你的同意" : "Your consent is required";
}

function memorySharingBlockedCopy(
  reason: string | null,
  zh: boolean,
): string {
  const copy: Record<string, { zh: string; en: string }> = {
    policy_disabled: {
      zh: "这个数字代表当前未启用长期记忆。",
      en: "This representative has not enabled long-term memory.",
    },
    identity_ineligible: {
      zh: "需要先登录并验证当前 Delegate 身份，再绑定需要共享的私聊账户。",
      en: "Sign in and verify this Delegate identity, then link the private-chat accounts you want to use.",
    },
    consent_missing: {
      zh: "需要你明确确认当前跨渠道记忆授权条款。",
      en: "You need to explicitly confirm the current cross-channel memory terms.",
    },
    consent_stale: {
      zh: "以前的授权已失效，请查看当前条款并重新确认。",
      en: "Previous consent is no longer current. Review and confirm the current terms.",
    },
    contact_memory_disabled: {
      zh: "这个数字代表当前未启用联系人记忆。",
      en: "This representative has not enabled contact memory.",
    },
    cross_channel_disabled: {
      zh: "这个数字代表当前未开放联系人记忆跨渠道共享。",
      en: "This representative has not enabled cross-channel contact memory.",
    },
    identity_not_registered: {
      zh: "需要先登录并使用已注册的 Delegate 身份。",
      en: "Sign in with a registered Delegate identity first.",
    },
    verified_identity_required: {
      zh: "需要先验证当前身份，并绑定需要共享的私聊账户。",
      en: "Verify this identity and link the private-chat accounts you want to use.",
    },
    consent_required: {
      zh: "需要你明确确认最新授权条款。",
      en: "You need to confirm the latest consent terms.",
    },
    contract_stale: {
      zh: "授权条款已更新，请刷新后重新确认。",
      en: "The consent terms changed. Refresh and confirm them again.",
    },
    representative_not_found: {
      zh: "当前数字代表不可用。",
      en: "This representative is unavailable.",
    },
  };
  const selected = reason ? copy[reason] : undefined;
  return selected
    ? zh
      ? selected.zh
      : selected.en
    : zh
      ? "当前状态不满足安全共享条件，请稍后刷新或检查账户绑定。"
      : "The safe-sharing requirements are not currently met. Refresh later or check your account links.";
}

async function fetchMemorySharingState(
  representativeSlug: string,
): Promise<MemorySharingState> {
  return mutateMemorySharingState(representativeSlug, {
    method: "GET",
    cache: "no-store",
  });
}

async function mutateMemorySharingState(
  representativeSlug: string,
  init: RequestInit,
): Promise<MemorySharingState> {
  const requestInit: RequestInit = init.body === undefined
    ? init
    : {
        ...init,
        headers: { "Content-Type": "application/json" },
      };
  const response = await fetch(
    `/reps/${representativeSlug}/memory-sharing`,
    requestInit,
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(payload?.error || response.statusText);
  }
  return response.json() as Promise<MemorySharingState>;
}

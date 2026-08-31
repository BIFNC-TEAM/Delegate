"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  const [confirmingRevocation, setConfirmingRevocation] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operationGenerationRef = useRef(0);
  const revocationDialogRef = useRef<HTMLDivElement>(null);
  const revocationCancelRef = useRef<HTMLButtonElement>(null);
  const sharingToggleRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(saving);

  savingRef.current = saving;

  useEffect(() => {
    const operationGeneration = operationGenerationRef.current + 1;
    operationGenerationRef.current = operationGeneration;
    setLoading(true);
    setState(null);
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

  useEffect(() => {
    if (!confirmingRevocation) return;
    const parentModal = sharingToggleRef.current?.closest<HTMLElement>(
      ".representative-profile-modal",
    );
    const parentWasInert = parentModal?.hasAttribute("inert") ?? false;
    parentModal?.setAttribute("inert", "");
    revocationCancelRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!savingRef.current) setConfirmingRevocation(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        revocationDialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      if (!parentWasInert) parentModal?.removeAttribute("inert");
      sharingToggleRef.current?.focus();
    };
  }, [confirmingRevocation]);

  function grantConsent() {
    if (
      saving
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
        setNotice(
          zh
            ? "跨渠道联系人记忆已开启。"
            : "Cross-channel Contact Memory is on.",
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
      .then(() => fetchMemorySharingState(representativeSlug))
      .then((payload) => {
        if (operationGenerationRef.current !== operationGeneration) return;
        setState(payload);
        setConfirmingRevocation(false);
        setNotice(
          zh
            ? "已关闭，共享记忆正在清理。"
            : "Turned off. Shared memory is being removed.",
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
            {state && !state.active ? (
              <span className="chip">
                {memorySharingInactiveStatus(state, zh)}
              </span>
            ) : null}
          </div>
          <p>
            {zh
              ? "仅在绑定至同一已验证 Delegate 身份的 Web、Matrix 和 Telegram 私聊间使用。未验证账号、其他联系人及其他对外代理保持隔离。开关仅由你控制，默认开启。"
              : "Used only across Web, Matrix, and Telegram private chats linked to the same verified Delegate identity. Unverified accounts, other contacts, and other representatives remain isolated. Only you control this switch; it defaults on."}
          </p>
        </div>

        <label className="toggle-row">
          <input
            checked={state ? state.active : true}
            disabled={
              loading
              || saving
              || !state?.supported
              || !state.policyEnabled
              || (
                !state.active
                && (
                  state.contractVersion === "unavailable"
                  || !state.challengeToken
                )
              )
            }
            onChange={(event) => {
              if (event.target.checked) grantConsent();
              else setConfirmingRevocation(true);
            }}
            ref={sharingToggleRef}
            role="switch"
            type="checkbox"
          />
          <span>
            {zh
              ? "跨已验证渠道使用联系人记忆"
              : "Use Contact Memory across verified channels"}
          </span>
        </label>

        <div className="status-banner">
          <strong>{zh ? "记住什么" : "What may be remembered"}</strong>
          <p>
            {zh
              ? "偏好、目标、约束及完成服务所需的必要背景，仅供当前对外代理使用。"
              : "Preferences, goals, constraints, and necessary service context, for this representative only."}
          </p>
          <strong>{zh ? "永远不共享什么" : "What is never shared"}</strong>
          <p>
            {zh
              ? "原始聊天、Owner 私有备注、Compute 原始产物、凭据，以及付款、余额、退款和权益信息。"
              : "Raw chats, Owner private notes, raw Compute outputs, credentials, and payment, balance, refund, or entitlement information."}
          </p>
          <strong>{zh ? "如何撤回" : "How withdrawal works"}</strong>
          <p>
            {zh
              ? "关闭后立即停止共享召回，并异步清理共享记忆；历史消息、账号绑定、订单和权益不受影响。"
              : "Turning it off stops shared recall immediately and removes shared memory asynchronously; history, account links, orders, and entitlements are unaffected."}
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
          </div>
        ) : state?.supported && state.policyEnabled ? (
          <div className="setup-stack">
            <p className="footer-note">
              {state.blockedReason === "user_disabled"
                ? zh
                  ? "已关闭，可随时重新开启。"
                  : "Off. You can turn it on again at any time."
                : zh
                  ? "需要重新确认当前授权条款。"
                  : "The current consent terms need to be confirmed again."}
              {" "}{zh ? "条款版本：" : "Terms version: "}
              <span className="chip">{state.contractVersion}</span>
            </p>
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

      {confirmingRevocation && typeof document !== "undefined"
        ? createPortal(
            <div
              aria-describedby="memory-revocation-dialog-description"
              aria-labelledby="memory-revocation-dialog-title"
              aria-modal="true"
              className="representative-memory-confirmation-modal"
              role="alertdialog"
            >
              <button
                aria-label={zh ? "取消并关闭确认弹窗" : "Cancel and close confirmation"}
                className="representative-memory-confirmation-backdrop"
                disabled={saving}
                onClick={() => setConfirmingRevocation(false)}
                tabIndex={-1}
                type="button"
              />
              <div
                className="representative-memory-confirmation-card"
                ref={revocationDialogRef}
              >
                <span className="representative-memory-confirmation-eyebrow">
                  {zh ? "联系人记忆授权" : "CONTACT MEMORY CONSENT"}
                </span>
                <h2 id="memory-revocation-dialog-title">
                  {zh
                    ? "停止并删除跨渠道联系人记忆？"
                    : "Stop and remove cross-channel Contact Memory?"}
                </h2>
                <p id="memory-revocation-dialog-description">
                  {zh
                    ? "共享召回会立即停止，已投影的共享记忆将异步清理。聊天记录、账号绑定、订单和权益不会被删除。"
                    : "Shared recall will stop immediately and projected shared memory will be removed asynchronously. Chat history, account links, orders, and entitlements will not be deleted."}
                </p>
                <div className="representative-memory-confirmation-actions">
                  <button
                    className="button-secondary"
                    disabled={saving}
                    onClick={() => setConfirmingRevocation(false)}
                    ref={revocationCancelRef}
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
            </div>,
            document.body,
          )
        : null}
    </article>
  );
}

function memorySharingInactiveStatus(
  state: MemorySharingState,
  zh: boolean,
): string {
  if (!state.supported) return zh ? "暂不支持" : "Unsupported";
  if (!state.policyEnabled) return zh ? "当前不可用" : "Currently unavailable";
  if (state.blockedReason === "user_disabled") return zh ? "你已关闭" : "Turned off by you";
  return zh ? "等待你的同意" : "Your consent is required";
}

function memorySharingBlockedCopy(
  reason: string | null,
  zh: boolean,
): string {
  const copy: Record<string, { zh: string; en: string }> = {
    policy_disabled: {
      zh: "当前暂不提供联系人长期记忆能力，因此无法跨渠道使用。",
      en: "Contact long-term memory is currently unavailable, so it cannot be used across channels.",
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
    user_disabled: {
      zh: "已关闭，可随时重新开启。",
      en: "Off. You can turn it on again at any time.",
    },
    contact_memory_disabled: {
      zh: "当前暂不提供联系人记忆能力。",
      en: "Contact Memory is currently unavailable.",
    },
    cross_channel_disabled: {
      zh: "当前运行环境暂不支持跨渠道联系人记忆。",
      en: "Cross-channel Contact Memory is not supported in the current runtime.",
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
      zh: "当前对外代理不可用。",
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

"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type { Locale } from "@delegate/web-ui";

type PayoutDestination = {
  id: string;
  kind: "wechat_pay";
  status:
    | "pending_verification"
    | "verified"
    | "active"
    | "rejected"
    | "disabled"
    | "replaced";
  currency: "CNY";
  maskedLabel: string;
  coolingOffUntil: string | null;
  verifiedAt: string | null;
  activatedAt: string | null;
  disabledAt: string | null;
  replacedAt: string | null;
};

type PayoutProfile = {
  id: string;
  subjectType: "owner" | "organization";
  status: "pending_verification" | "verified" | "rejected" | "suspended";
  version: number;
  verifiedAt: string | null;
  rejectionReasonCode: string | null;
  suspendedAt: string | null;
  destinations: PayoutDestination[];
};

type PayoutProfilePayload = {
  profile: PayoutProfile | null;
  capabilities?: {
    tokenizedDestinationSetup?: boolean;
    localMockOperations?: boolean;
    productionPayoutExecution?: boolean;
  };
};

export function DashboardPayoutProfile({
  locale,
  onChanged,
}: {
  locale: Locale;
  onChanged: () => void;
}) {
  const zh = locale === "zh";
  const [payload, setPayload] = useState<PayoutProfilePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [recipientToken, setRecipientToken] = useState("");
  const [maskedLabel, setMaskedLabel] = useState("");
  const idempotencyKeysRef = useRef(new Map<string, string>());

  const loadProfile = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/dashboard/wallet/payout-profile", {
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(await extractPayoutError(response));
      const next = (await response.json()) as PayoutProfilePayload;
      if (!signal?.aborted) setPayload(next);
    } catch (nextError) {
      if (signal?.aborted) return;
      setError(
        nextError instanceof Error
          ? nextError.message
          : zh
            ? "收款档案暂时无法加载。"
            : "The payout profile could not load.",
      );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [zh]);

  useEffect(() => {
    const controller = new AbortController();
    void loadProfile(controller.signal);
    return () => controller.abort();
  }, [loadProfile]);

  async function submitProfile() {
    await mutateProfile(
      "submit-profile",
      "/api/dashboard/wallet/payout-profile",
      {
        ...(payload?.profile
          ? { expectedVersion: payload.profile.version }
          : {}),
      },
      zh ? "收款档案已提交审核。" : "Payout profile submitted for review.",
    );
  }

  async function createDestination(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const profile = payload?.profile;
    if (!profile || !recipientToken.trim() || !maskedLabel.trim()) return;
    const changed = await mutateProfile(
      "create-destination",
      "/api/dashboard/wallet/payout-profile/mock",
      {
        action: "create_destination",
        profileId: profile.id,
        expectedProfileVersion: profile.version,
        recipientToken,
        providerMaskedLabel: maskedLabel,
      },
      zh
        ? "本地演示收款目的地已加密保存，等待模拟审核。"
        : "The local demo destination is encrypted and awaiting mock review.",
    );
    if (changed) {
      setRecipientToken("");
      setMaskedLabel("");
    }
  }

  async function applyDestinationAction(
    destination: PayoutDestination,
    action: "review" | "activate" | "disable",
  ) {
    const profile = payload?.profile;
    if (!profile) return;
    await mutateProfile(
      `${action}:${destination.id}`,
      "/api/dashboard/wallet/payout-profile/mock",
      action === "review"
        ? {
            action,
            profileId: profile.id,
            destinationId: destination.id,
            decision: "approve",
            expectedProfileVersion: profile.version,
          }
        : {
            action,
            profileId: profile.id,
            destinationId: destination.id,
            expectedProfileVersion: profile.version,
          },
      action === "review"
        ? zh ? "本地模拟审核已通过。" : "Local mock verification passed."
        : action === "activate"
          ? zh ? "本地演示收款目的地已激活。" : "Local demo destination activated."
          : zh ? "本地演示收款目的地已停用。" : "Local demo destination disabled.",
    );
  }

  async function mutateProfile(
    operation: string,
    endpoint: string,
    body: Record<string, unknown>,
    successMessage: string,
  ) {
    const idempotencyKey =
      idempotencyKeysRef.current.get(operation)
      ?? `dashboard-payout:${crypto.randomUUID()}`;
    idempotencyKeysRef.current.set(operation, idempotencyKey);
    setSubmitting(operation);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await extractPayoutError(response));
      const next = (await response.json()) as {
        profile: PayoutProfile;
      };
      idempotencyKeysRef.current.delete(operation);
      setPayload((current) => ({
        profile: next.profile,
        ...(current?.capabilities
          ? { capabilities: current.capabilities }
          : {}),
      }));
      setNotice(successMessage);
      onChanged();
      return true;
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : zh
            ? "收款档案更新失败。"
            : "The payout profile update failed.",
      );
      return false;
    } finally {
      setSubmitting(null);
    }
  }

  const profile = payload?.profile ?? null;
  const localMock = Boolean(payload?.capabilities?.localMockOperations);
  const activeDestination = profile?.destinations.find(
    (destination) => destination.status === "active",
  ) ?? null;

  return (
    <section
      aria-busy={loading || Boolean(submitting)}
      className="dashboard-v2-panel wallet-payout-profile"
      id="wallet-payout-profile"
    >
      <header>
        <div>
          <p>CREATOR PAYOUT PROFILE</p>
          <h2>{zh ? "收款档案" : "Payout profile"}</h2>
        </div>
        <span className={`wallet-status is-${payoutProfileTone(profile)}`}>
          {payoutProfileStatusLabel(profile, locale)}
        </span>
      </header>

      {loading ? (
        <p className="dashboard-v2-panel-description">
          {zh ? "正在核对收款主体与目的地…" : "Checking payout subject and destination…"}
        </p>
      ) : error && !payload ? (
        <div className="skills-banner is-error" role="alert">
          <span>{error}</span>
          <button
            className="dashboard-v2-button-secondary"
            onClick={() => void loadProfile()}
            type="button"
          >
            {zh ? "重试" : "Retry"}
          </button>
        </div>
      ) : (
        <>
          <div className="wallet-payout-profile-grid">
            <PayoutFact
              label={zh ? "收款主体" : "Payout subject"}
              value={
                profile?.subjectType === "organization"
                  ? zh ? "当前 Organization" : "Current organization"
                  : zh ? "当前 Owner" : "Current owner"
              }
            />
            <PayoutFact label={zh ? "币种" : "Currency"} value="CNY" mono />
            <PayoutFact
              label={zh ? "默认目的地" : "Default destination"}
              value={activeDestination?.maskedLabel ?? "—"}
            />
            <PayoutFact
              label={zh ? "验证时间" : "Verified"}
              value={
                profile?.verifiedAt
                  ? new Intl.DateTimeFormat(
                      locale === "zh" ? "zh-CN" : "en-US",
                      { dateStyle: "medium", timeStyle: "short" },
                    ).format(new Date(profile.verifiedAt))
                  : "—"
              }
            />
          </div>

          {!profile ? (
            <div className="wallet-payout-profile-empty">
              <p>
                {zh
                  ? "先建立收款主体档案，再绑定由支付机构签发的收款 token。这里不会接收银行卡号、支付密码或证件内容。"
                  : "Create the payout subject first, then bind a provider-issued recipient token. Bank-card numbers, payment passwords, and identity documents are never accepted here."}
              </p>
              <button
                className="dashboard-v2-button-primary"
                disabled={Boolean(submitting)}
                onClick={() => void submitProfile()}
                type="button"
              >
                {submitting
                  ? zh ? "提交中…" : "Submitting…"
                  : zh ? "建立收款档案" : "Create payout profile"}
              </button>
            </div>
          ) : (
            <>
              <div className="wallet-payout-destination-list">
                {profile.destinations.map((destination) => (
                  <article key={destination.id}>
                    <div>
                      <strong>{destination.maskedLabel}</strong>
                      <span>
                        WeChat Pay · {destination.currency} ·{" "}
                        {payoutDestinationStatusLabel(destination.status, locale)}
                      </span>
                      {destination.coolingOffUntil ? (
                        <small>
                          {zh ? "冷静期至 " : "Cooling-off until "}
                          {new Intl.DateTimeFormat(
                            locale === "zh" ? "zh-CN" : "en-US",
                            { dateStyle: "medium", timeStyle: "short" },
                          ).format(new Date(destination.coolingOffUntil))}
                        </small>
                      ) : null}
                    </div>
                    {localMock ? (
                      <div>
                        {destination.status === "pending_verification" ? (
                          <button
                            className="dashboard-v2-button-secondary"
                            disabled={Boolean(submitting)}
                            onClick={() =>
                              void applyDestinationAction(destination, "review")}
                            type="button"
                          >
                            {zh ? "模拟审核通过" : "Mock verify"}
                          </button>
                        ) : destination.status === "verified" ? (
                          <button
                            className="dashboard-v2-button-secondary"
                            disabled={
                              Boolean(submitting)
                              || Boolean(
                                destination.coolingOffUntil
                                && new Date(destination.coolingOffUntil).getTime()
                                  > Date.now(),
                              )
                            }
                            onClick={() =>
                              void applyDestinationAction(destination, "activate")}
                            type="button"
                          >
                            {zh ? "模拟激活" : "Mock activate"}
                          </button>
                        ) : destination.status === "active" ? (
                          <button
                            className="dashboard-v2-button-secondary"
                            disabled={Boolean(submitting)}
                            onClick={() =>
                              void applyDestinationAction(destination, "disable")}
                            type="button"
                          >
                            {zh ? "停用演示目的地" : "Disable demo destination"}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>

              {localMock ? (
                <form
                  className="wallet-payout-local-form"
                  onSubmit={(event) => void createDestination(event)}
                >
                  <div>
                    <strong>{zh ? "本地业务闭环" : "Local business closure"}</strong>
                    <span>
                      {zh
                        ? "仅在非生产环境模拟支付机构 tokenization 与人工审核。"
                        : "Simulates provider tokenization and manual review outside production only."}
                    </span>
                  </div>
                  <label>
                    <span>{zh ? "支付机构 recipient token" : "Provider recipient token"}</span>
                    <input
                      autoComplete="off"
                      onChange={(event) => setRecipientToken(event.target.value)}
                      type="password"
                      value={recipientToken}
                    />
                  </label>
                  <label>
                    <span>{zh ? "支付机构脱敏标签" : "Provider masked label"}</span>
                    <input
                      onChange={(event) => setMaskedLabel(event.target.value)}
                      placeholder={zh ? "微信账户 · 尾号 12" : "WeChat account · ending 12"}
                      value={maskedLabel}
                    />
                  </label>
                  <button
                    className="dashboard-v2-button-secondary"
                    disabled={
                      Boolean(submitting)
                      || !recipientToken.trim()
                      || !maskedLabel.trim()
                    }
                    type="submit"
                  >
                    {submitting === "create-destination"
                      ? zh ? "加密保存中…" : "Encrypting…"
                      : zh ? "添加本地演示目的地" : "Add local demo destination"}
                  </button>
                </form>
              ) : (
                <div className="skills-trust-note">
                  <strong>{zh ? "生产绑定尚未开放" : "Production binding is not open"}</strong>
                  <span>
                    {zh
                      ? "需要先接入微信支付的收款确认/tokenization 流程。完成前页面保持只读，不提供银行卡或证件输入。"
                      : "WeChat recipient confirmation/tokenization must be integrated first. Until then this surface stays read-only and exposes no bank or identity-document fields."}
                  </span>
                </div>
              )}
            </>
          )}

          {notice ? <div className="skills-banner is-success" role="status">{notice}</div> : null}
          {error && payload ? <div className="skills-banner is-error" role="alert">{error}</div> : null}
          <footer>
            <span>
              {zh
                ? "提现申请会锁定当时的脱敏目的地快照；换绑不会改写历史申请。"
                : "Each withdrawal locks its masked destination snapshot; later replacement never rewrites history."}
            </span>
            <span>
              {zh
                ? "生产人工审核与真实打款需要独立 Operator 权限，Creator 不能自审。"
                : "Production review and payout require separate Operator access; Creators cannot self-approve."}
            </span>
          </footer>
        </>
      )}
    </section>
  );
}

function PayoutFact({
  label,
  mono = false,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong className={mono ? "is-mono" : undefined}>{value}</strong>
    </div>
  );
}

function payoutProfileStatusLabel(
  profile: PayoutProfile | null,
  locale: Locale,
) {
  const zh = locale === "zh";
  if (!profile) return zh ? "未配置" : "Not configured";
  const labels = {
    pending_verification: zh ? "待审核" : "Pending review",
    verified: zh ? "已验证" : "Verified",
    rejected: zh ? "已拒绝" : "Rejected",
    suspended: zh ? "已暂停" : "Suspended",
  };
  return labels[profile.status];
}

function payoutDestinationStatusLabel(
  status: PayoutDestination["status"],
  locale: Locale,
) {
  const zh = locale === "zh";
  return {
    pending_verification: zh ? "待审核" : "Pending review",
    verified: zh ? "已验证待激活" : "Verified, awaiting activation",
    active: zh ? "当前有效" : "Active",
    rejected: zh ? "已拒绝" : "Rejected",
    disabled: zh ? "已停用" : "Disabled",
    replaced: zh ? "已替换" : "Replaced",
  }[status];
}

function payoutProfileTone(profile: PayoutProfile | null) {
  if (!profile) return "neutral";
  if (profile.status === "verified") return "success";
  if (profile.status === "rejected" || profile.status === "suspended") {
    return "error";
  }
  return "warning";
}

async function extractPayoutError(response: Response) {
  const payload = await response.json().catch(() => null) as {
    error?: unknown;
  } | null;
  return typeof payload?.error === "string"
    ? payload.error
    : `payout_profile_${response.status}`;
}

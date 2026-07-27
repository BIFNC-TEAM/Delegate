"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { QRCodeSVG } from "qrcode.react";

import { pickCopy, type Locale } from "@delegate/web-ui";

import {
  publishPublicWalletUpdate,
  selectCurrentPublicWalletActivity,
  type PublicWalletStateSnapshot,
} from "./public-wallet-client";

type RechargeOrderSnapshot = {
  id: string;
  amountCents: number;
  currency: string;
  provider: string;
  status: string;
  checkoutUrl: string | null;
  cashBalanceCents: number;
};

type TokenPurchaseSnapshot = {
  id: string;
  tokenAmount: number;
  remainingTokenAmount: number;
  availableTokenAmount: number;
  reservedTokenAmount: number;
  currency: string;
};

type PurchaseReversalSnapshot = {
  purchaseId: string;
  tokenAmount: number;
  remainingTokenAmount: number;
  reversedAmountCents: number;
  cashBalanceCents: number;
  currency: string;
  status: string;
};

type UserAgentWalletBalance = {
  availableTokenAmount: number;
  reservedTokenAmount: number;
};

type WeChatPaymentStatus = {
  status: "pending" | "paid" | "closed" | "refunded" | "failed";
};

type RechargeMutation = "create" | "mock-pay" | "return" | null;

type RechargeIntent = {
  amountCents: number;
  idempotencyKey: string;
};

export function RepresentativeRechargePanel({
  audienceAuthenticated,
  continuationChannel,
  loginHref,
  representativeSlug,
  locale,
  paymentMode,
}: {
  audienceAuthenticated: boolean;
  continuationChannel?: "telegram";
  loginHref: string;
  representativeSlug: string;
  locale: Locale;
  paymentMode: "mock" | "wechat";
}) {
  const t = pickCopy(locale, copy);
  const [amountCents, setAmountCents] = useState(2000);
  const [order, setOrder] = useState<RechargeOrderSnapshot | null>(null);
  const [purchase, setPurchase] = useState<TokenPurchaseSnapshot | null>(null);
  const [reversal, setReversal] = useState<PurchaseReversalSnapshot | null>(null);
  const [walletState, setWalletState] =
    useState<PublicWalletStateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [isCheckoutUrlCopied, setIsCheckoutUrlCopied] = useState(false);
  const [mutation, setMutation] = useState<RechargeMutation>(null);
  const mutationLockRef = useRef(false);
  const rechargeIntentRef = useRef<RechargeIntent | null>(null);
  const isMutating = mutation !== null;
  const [telegramBindingStatus, setTelegramBindingStatus] = useState<
    "checking" | "required" | "ready"
  >(
    continuationChannel === "telegram" && audienceAuthenticated
      ? "checking"
      : continuationChannel === "telegram"
        ? "required"
        : "ready",
  );

  const refreshTelegramBinding = useCallback(async () => {
    if (continuationChannel !== "telegram" || !audienceAuthenticated) {
      setTelegramBindingStatus("required");
      return;
    }
    setTelegramBindingStatus("checking");
    setError(null);
    try {
      const response = await fetch(
        `/reps/${representativeSlug}/identity-bindings`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error(await extractError(response));
      }
      const payload = (await response.json()) as {
        readiness?: { telegram?: boolean };
      };
      setTelegramBindingStatus(
        payload.readiness?.telegram === true ? "ready" : "required",
      );
    } catch (nextError) {
      setTelegramBindingStatus("required");
      setError(
        nextError instanceof Error
          ? nextError.message
          : t.bindingCheckError,
      );
    }
  }, [
    audienceAuthenticated,
    continuationChannel,
    representativeSlug,
    t.bindingCheckError,
  ]);

  useEffect(() => {
    if (continuationChannel === "telegram" && audienceAuthenticated) {
      void refreshTelegramBinding();
    }
  }, [
    audienceAuthenticated,
    continuationChannel,
    refreshTelegramBinding,
  ]);

  const rechargeReady =
    audienceAuthenticated
    && (
      continuationChannel !== "telegram"
      || telegramBindingStatus === "ready"
    );

  const applyWalletState = useCallback((
    snapshot: PublicWalletStateSnapshot,
  ) => {
    const activity = selectCurrentPublicWalletActivity(snapshot);
    setWalletState(snapshot);
    setOrder(activity.order
      ? {
          id: activity.order.id,
          amountCents: activity.order.amountCents,
          currency: activity.order.currency,
          provider: activity.order.provider,
          status: activity.order.status,
          checkoutUrl: activity.order.checkoutUrl,
          cashBalanceCents: snapshot.summary.cashBalanceCents,
        }
      : null);
    setPurchase(activity.purchase
      ? {
          id: activity.purchase.id,
          tokenAmount: activity.purchase.tokenAmount,
          remainingTokenAmount: activity.purchase.remainingTokenAmount,
          availableTokenAmount: snapshot.summary.serviceCreditsAvailable,
          reservedTokenAmount: snapshot.summary.serviceCreditsReserved,
          currency: activity.purchase.currency,
        }
      : null);
    setReversal(activity.refund
      ? {
          purchaseId: activity.refund.purchaseId,
          tokenAmount: activity.refund.tokenAmount,
          remainingTokenAmount:
            activity.purchase?.remainingTokenAmount ?? 0,
          reversedAmountCents: activity.refund.amountCents,
          cashBalanceCents: snapshot.summary.cashBalanceCents,
          currency: activity.refund.currency,
          status: activity.refund.status,
        }
      : null);
    publishPublicWalletUpdate({
      representativeSlug,
      serviceCreditsAvailable: snapshot.summary.serviceCreditsAvailable,
      serviceCreditsReserved: snapshot.summary.serviceCreditsReserved,
    });
  }, [representativeSlug]);

  const refreshWalletState = useCallback(async (
    signal?: AbortSignal,
  ) => {
    const response = await fetch(
      `/reps/${representativeSlug}/recharge?currency=CNY`,
      {
        cache: "no-store",
        headers: { Accept: "application/json" },
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      throw new Error(await extractError(response));
    }
    const snapshot = (await response.json()) as PublicWalletStateSnapshot;
    applyWalletState(snapshot);
  }, [applyWalletState, representativeSlug]);

  useEffect(() => {
    if (!audienceAuthenticated) {
      setIsRestoring(false);
      setWalletState(null);
      return;
    }
    const controller = new AbortController();
    setIsRestoring(true);
    void refreshWalletState(controller.signal)
      .catch((nextError: unknown) => {
        if (
          nextError instanceof DOMException
          && nextError.name === "AbortError"
        ) {
          return;
        }
        setError(nextError instanceof Error ? nextError.message : t.loadError);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsRestoring(false);
        }
      });
    return () => controller.abort();
  }, [audienceAuthenticated, refreshWalletState, t.loadError]);

  useEffect(() => {
    if (
      paymentMode !== "wechat"
      || !order?.id
      || order?.status !== "requires_payment"
    ) {
      return;
    }
    const orderId = order.id;
    const controller = new AbortController();
    let requestInFlight = false;
    const reconcile = async () => {
      if (requestInFlight || controller.signal.aborted) {
        return;
      }
      requestInFlight = true;
      try {
        const response = await fetch(
          `/reps/${representativeSlug}/recharge/${orderId}/wechat-status`,
          {
            method: "POST",
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          return;
        }
        const result = (await response.json()) as WeChatPaymentStatus;
        if (result.status === "paid") {
          await refreshWalletState(controller.signal);
          return;
        }
        if (result.status !== "pending") {
          setOrder((current) => current?.id === orderId
            ? {
                ...current,
                status:
                  result.status === "closed"
                    ? "canceled"
                    : result.status,
                checkoutUrl: null,
              }
            : current);
        }
      } catch (nextError) {
        if (
          !(nextError instanceof DOMException)
          || nextError.name !== "AbortError"
        ) {
          // A transient provider query failure should not discard the QR code
          // or create a false payment failure. The next interval retries.
        }
      } finally {
        requestInFlight = false;
      }
    };

    void reconcile();
    const poll = window.setInterval(() => {
      void reconcile();
    }, 5_000);
    return () => {
      controller.abort();
      window.clearInterval(poll);
    };
  }, [
    order?.id,
    order?.status,
    paymentMode,
    refreshWalletState,
    representativeSlug,
  ]);

  async function restoreAfterMutation() {
    try {
      await refreshWalletState();
    } catch {
      setError(t.refreshError);
    }
  }

  function createRechargeOrder() {
    if (!rechargeReady || !beginMutation("create")) {
      return;
    }
    setError(null);
    const existingIntent = rechargeIntentRef.current;
    const intent =
      existingIntent?.amountCents === amountCents
        ? existingIntent
        : {
            amountCents,
            idempotencyKey: randomId(),
          };
    rechargeIntentRef.current = intent;
    void (async () => {
        const response = await fetch(`/reps/${representativeSlug}/recharge`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            amountCents: intent.amountCents,
            idempotencyKey: intent.idempotencyKey,
            ...(continuationChannel
              ? { continuationChannel }
              : {}),
          }),
        });

        if (!response.ok) {
          throw new Error(await extractError(response));
        }

        const payload = (await response.json()) as { rechargeOrder: RechargeOrderSnapshot };
        setOrder(payload.rechargeOrder);
        setIsCheckoutUrlCopied(false);
        setPurchase(null);
        setReversal(null);
        rechargeIntentRef.current = null;
        await restoreAfterMutation();
      })()
      .catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : t.createError);
      })
      .finally(endMutation);
  }

  function copyCheckoutUrl() {
    if (!order?.checkoutUrl) {
      return;
    }
    if (!navigator.clipboard) {
      setError(t.copyError);
      return;
    }
    void navigator.clipboard.writeText(order.checkoutUrl)
      .then(() => setIsCheckoutUrlCopied(true))
      .catch(() => setError(t.copyError));
  }

  function completeMockPayment() {
    if (!order || !beginMutation("mock-pay")) {
      return;
    }
    setError(null);
    void (async () => {
        const response = await fetch(
          `/reps/${representativeSlug}/recharge/${order.id}/mock-success`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              amountCents: order.amountCents,
            }),
          },
        );

        if (!response.ok) {
          throw new Error(await extractError(response));
        }

        const payload = (await response.json()) as {
          rechargeOrder: RechargeOrderSnapshot;
          tokenPurchase: TokenPurchaseSnapshot;
        };
        setOrder(payload.rechargeOrder);
        setPurchase(payload.tokenPurchase);
        setReversal(null);
        publishPublicWalletUpdate({
          representativeSlug,
          serviceCreditsAvailable: payload.tokenPurchase.availableTokenAmount,
          serviceCreditsReserved: payload.tokenPurchase.reservedTokenAmount,
        });
        await restoreAfterMutation();
      })()
      .catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : t.payError);
      })
      .finally(endMutation);
  }

  function returnUnusedCredits() {
    if (
      !order
      || !purchase
      || purchase.remainingTokenAmount <= 0
      || !beginMutation("return")
    ) {
      return;
    }
    setError(null);
    void (async () => {
        const response = await fetch(
          `/reps/${representativeSlug}/recharge/${order.id}/mock-reversal`,
          { method: "POST" },
        );
        if (!response.ok) {
          throw new Error(await extractError(response));
        }
        const payload = (await response.json()) as {
          reversal: PurchaseReversalSnapshot;
          walletBalance: UserAgentWalletBalance | null;
        };
        const availableTokenAmount =
          payload.walletBalance?.availableTokenAmount ?? 0;
        const reservedTokenAmount =
          payload.walletBalance?.reservedTokenAmount ?? 0;
        setReversal(payload.reversal);
        setOrder((current) => current
          ? { ...current, cashBalanceCents: payload.reversal.cashBalanceCents }
          : current);
        setPurchase((current) => current
          ? {
              ...current,
              remainingTokenAmount: payload.reversal.remainingTokenAmount,
              availableTokenAmount,
              reservedTokenAmount,
            }
          : current);
        publishPublicWalletUpdate({
          representativeSlug,
          serviceCreditsAvailable: availableTokenAmount,
          serviceCreditsReserved: reservedTokenAmount,
        });
        await restoreAfterMutation();
      })()
      .catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : t.returnError);
      })
      .finally(endMutation);
  }

  function beginMutation(nextMutation: Exclude<RechargeMutation, null>) {
    if (mutationLockRef.current) {
      return false;
    }
    mutationLockRef.current = true;
    setMutation(nextMutation);
    return true;
  }

  function endMutation() {
    mutationLockRef.current = false;
    setMutation(null);
  }

  return (
    <div className="setup-stack">
      <p className="footer-note">{t.identityNote}</p>

      {!audienceAuthenticated ? (
        <div className="status-banner">
          <strong>{t.loginRequiredTitle}</strong>
          <p>{t.loginRequiredDetail}</p>
          <a className="button-secondary" href={loginHref}>
            {t.loginAction}
          </a>
        </div>
      ) : null}

      {continuationChannel === "telegram" && audienceAuthenticated ? (
        <div
          className={
            telegramBindingStatus === "ready"
              ? "status-banner status-success"
              : "status-banner"
          }
        >
          <strong>
            {telegramBindingStatus === "ready"
              ? t.telegramBindingReadyTitle
              : t.telegramBindingRequiredTitle}
          </strong>
          <p>
            {telegramBindingStatus === "ready"
              ? t.telegramBindingReadyDetail
              : t.telegramBindingRequiredDetail}
          </p>
          {telegramBindingStatus !== "ready" ? (
            <div className="button-row">
              <a className="button-secondary" href="#identity-bindings">
                {t.openBindingsAction}
              </a>
              <button
                className="button-secondary"
                disabled={telegramBindingStatus === "checking"}
                onClick={() => void refreshTelegramBinding()}
                type="button"
              >
                {telegramBindingStatus === "checking"
                  ? t.checkingBinding
                  : t.checkBindingAction}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {audienceAuthenticated && isRestoring ? (
        <div className="status-banner" role="status">
          <strong>{t.restoring}</strong>
        </div>
      ) : audienceAuthenticated && walletState ? (
        <div className="status-banner" role="status">
          <strong>{t.walletSummaryTitle}</strong>
          <p>
            {t.balanceLabel}
            {formatMoney(
              walletState.summary.cashBalanceCents,
              walletState.summary.currency,
            )}
            {" · "}
            {t.creditsAvailableLabel}
            {walletState.summary.serviceCreditsAvailable}
            {" · "}
            {t.creditsReservedLabel}
            {walletState.summary.serviceCreditsReserved}
            {" · "}
            {t.creditsConsumedLabel}
            {walletState.summary.serviceCreditsConsumed}
          </p>
          <p className="footer-note">
            {t.recordSummary(
              walletState.orders.length,
              walletState.purchases.length,
              walletState.refunds.length,
            )}
          </p>
        </div>
      ) : null}

      <div className="button-row button-row-stretch">
        {[500, 2000, 10000].map((preset) => (
          <button
            className={amountCents === preset ? "button-primary" : "button-secondary"}
            disabled={isMutating || isRestoring || !rechargeReady}
            key={preset}
            onClick={() => {
              setAmountCents(preset);
              if (
                rechargeIntentRef.current
                && rechargeIntentRef.current.amountCents !== preset
              ) {
                rechargeIntentRef.current = null;
              }
            }}
            type="button"
          >
            {formatMoney(preset, "CNY")}
          </button>
        ))}
      </div>

      <button
        className="button-primary button-block"
        disabled={isMutating || isRestoring || !rechargeReady}
        onClick={createRechargeOrder}
        type="button"
      >
        {mutation === "create"
          ? t.creating
          : paymentMode === "wechat"
            ? t.wechatCreateAction
            : t.createAction}
      </button>

      {order ? (
        <div className="status-banner status-success">
          <strong>{t.latestOrder}</strong>
          <p>
            {formatMoney(order.amountCents, order.currency)} · {order.status} · {t.balanceLabel}
            {formatMoney(order.cashBalanceCents, order.currency)}
          </p>
          {order.status === "requires_payment" && paymentMode === "mock" ? (
            <button
              className="button-secondary"
              disabled={isMutating || isRestoring}
              onClick={completeMockPayment}
              type="button"
            >
              {t.mockPayAction}
            </button>
          ) : null}
          {order.status === "requires_payment"
            && paymentMode === "wechat"
            && order.checkoutUrl ? (
              <div className="representative-wechat-checkout">
                <QRCodeSVG
                  bgColor="#FFFFFF"
                  fgColor="#111827"
                  includeMargin
                  level="M"
                  size={216}
                  title={t.wechatQrTitle}
                  value={order.checkoutUrl}
                />
                <div>
                  <strong>{t.wechatQrTitle}</strong>
                  <p>{t.wechatQrDetail}</p>
                  <div className="button-row">
                    <a
                      className="button-primary"
                      href={order.checkoutUrl}
                    >
                      {t.openWechatAction}
                    </a>
                    <button
                      className="button-secondary"
                      onClick={copyCheckoutUrl}
                      type="button"
                    >
                      {isCheckoutUrlCopied
                        ? t.checkoutUrlCopied
                        : t.copyCheckoutUrl}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          {purchase ? (
            <>
              <p>
                {t.creditsLabel}
                <strong>{purchase.availableTokenAmount}</strong>
                {" · "}
                {t.creditsScope}
              </p>
              {purchase.remainingTokenAmount > 0
                && paymentMode === "mock" ? (
                  <button
                    className="button-secondary"
                    disabled={
                      isMutating
                      || isRestoring
                      || purchase.reservedTokenAmount > 0
                    }
                    onClick={returnUnusedCredits}
                    type="button"
                  >
                    {mutation === "return"
                      ? t.returning
                      : t.returnUnusedAction}
                  </button>
                ) : null}
              {purchase.reservedTokenAmount > 0 ? (
                <p className="footer-note">{t.reservedReturnHint}</p>
              ) : null}
            </>
          ) : null}
          {reversal ? (
            <p>
              <strong>{t.returnedTitle}</strong>
              {" · "}
              {t.returnedDetail(
                reversal.tokenAmount,
                reversal.reversedAmountCents,
                reversal.currency,
                reversal.cashBalanceCents,
              )}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="status-banner status-error">{error}</div> : null}
      <p className="footer-note">
        {paymentMode === "wechat"
          ? t.wechatDisclaimer
          : t.disclaimer}
      </p>
    </div>
  );
}

async function extractError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? response.statusText;
}

function randomId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function formatMoney(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

const copy = {
  zh: {
    identityNote: "充值和服务额度会记入当前已登录的 Delegate 账户；绑定后 Web、Telegram 和 Matrix 共用同一份权益。这里只读取当前代表的 CNY 钱包状态。",
    restoring: "正在恢复当前钱包状态…",
    loadError: "钱包状态恢复失败。",
    refreshError: "操作已完成，但最新钱包状态暂时无法刷新，请重新加载页面。",
    walletSummaryTitle: "当前钱包状态",
    creditsAvailableLabel: "可用额度 ",
    creditsReservedLabel: "预留额度 ",
    creditsConsumedLabel: "已消费额度 ",
    recordSummary: (orders: number, purchases: number, refunds: number) =>
      `最近记录：${orders} 笔订单 · ${purchases} 笔购买 · ${refunds} 笔未使用额度退回`,
    loginRequiredTitle: "请先登录 Delegate 账户",
    loginRequiredDetail: "充值属于账户级操作，不会再记入临时浏览器身份。",
    loginAction: "登录 / 注册",
    telegramBindingRequiredTitle: "请先绑定当前 Telegram 账户",
    telegramBindingRequiredDetail: "在上方“跨渠道身份”生成 /bind 命令，发送给当前 Bot 后再回来检查。",
    telegramBindingReadyTitle: "Telegram 身份已绑定",
    telegramBindingReadyDetail: "本次充值会进入与当前 Telegram 账户对应的同一个 Delegate 账户。",
    openBindingsAction: "打开身份绑定",
    checkBindingAction: "重新检查",
    checkingBinding: "检查中...",
    bindingCheckError: "Telegram 绑定状态检查失败。",
    createAction: "创建充值单",
    wechatCreateAction: "生成微信支付二维码",
    creating: "处理中...",
    createError: "创建充值单失败。",
    payError: "模拟支付失败。",
    latestOrder: "最近一笔充值单",
    balanceLabel: "当前余额 ",
    mockPayAction: "模拟支付成功",
    wechatQrTitle: "微信扫码支付",
    wechatQrDetail: "请使用微信扫描二维码。支付完成后，本页会自动刷新余额和当前代表服务额度。",
    openWechatAction: "在微信中打开",
    copyCheckoutUrl: "复制支付链接",
    checkoutUrlCopied: "已复制",
    copyError: "支付链接复制失败，请直接扫描二维码。",
    creditsLabel: "当前代表可用服务额度 ",
    creditsScope: "仅限当前数字代表",
    returnUnusedAction: "退回本次未使用额度",
    returning: "退回中...",
    returnError: "未使用额度退回失败。",
    reservedReturnHint: "有额度正在服务请求中，结算或释放后才能退回。",
    returnedTitle: "未使用额度已退回站内余额",
    returnedDetail: (
      tokens: number,
      amountCents: number,
      currency: string,
      cashBalanceCents: number,
    ) => `${tokens} 额度 · ${formatMoney(amountCents, currency)} · 站内余额 ${formatMoney(cashBalanceCents, currency)}`,
    disclaimer: "当前是仅限开发环境的演示支付入口：可以验证创建充值单、模拟支付、自动购买当前代表服务额度、付费继续和未使用额度退回站内余额，但不会真实扣款或原路退款。下一真实收款渠道为微信支付；Stripe 已延期。Delegate 不处理银行卡号或支付密码。",
    wechatDisclaimer: "当前使用微信 Native 支付。Delegate 只保存订单、金额和验签后的最小资金凭据，不接触微信支付密码；支付成功后会为当前数字代表自动购买服务额度。真实退款和自动提现仍未开放。",
  },
  en: {
    identityNote: "Recharge and service credits are attached to the signed-in Delegate account. Linked Web, Telegram, and Matrix identities share the same entitlements. This panel reads only this representative's CNY wallet state.",
    restoring: "Restoring the current wallet state…",
    loadError: "Failed to restore wallet state.",
    refreshError: "The operation completed, but the latest wallet state could not be refreshed. Reload the page to try again.",
    walletSummaryTitle: "Current wallet state",
    creditsAvailableLabel: "available credits ",
    creditsReservedLabel: "reserved credits ",
    creditsConsumedLabel: "consumed credits ",
    recordSummary: (orders: number, purchases: number, refunds: number) =>
      `Recent records: ${orders} orders · ${purchases} purchases · ${refunds} unused-credit returns`,
    loginRequiredTitle: "Sign in to your Delegate account",
    loginRequiredDetail: "Recharge is account-bound and is never attached to a temporary browser identity.",
    loginAction: "Sign in / register",
    telegramBindingRequiredTitle: "Link this Telegram account first",
    telegramBindingRequiredDetail: "Create a /bind command in Cross-channel identity above, send it to this Bot, then check again.",
    telegramBindingReadyTitle: "Telegram identity linked",
    telegramBindingReadyDetail: "This recharge will reach the same Delegate account used by the current Telegram identity.",
    openBindingsAction: "Open identity linking",
    checkBindingAction: "Check again",
    checkingBinding: "Checking...",
    bindingCheckError: "Unable to check the Telegram identity link.",
    createAction: "Create recharge order",
    wechatCreateAction: "Generate WeChat Pay QR",
    creating: "Working...",
    createError: "Failed to create recharge order.",
    payError: "Failed to simulate payment.",
    latestOrder: "Latest recharge order",
    balanceLabel: "Current balance ",
    mockPayAction: "Simulate payment success",
    wechatQrTitle: "Scan with WeChat Pay",
    wechatQrDetail: "Scan this QR code in WeChat. This page will refresh the wallet and representative-scoped service credits after payment.",
    openWechatAction: "Open in WeChat",
    copyCheckoutUrl: "Copy payment link",
    checkoutUrlCopied: "Copied",
    copyError: "The payment link could not be copied. Please scan the QR code.",
    creditsLabel: "Service credits available for this representative ",
    creditsScope: "scoped to this Digital Representative",
    returnUnusedAction: "Return unused credits",
    returning: "Returning...",
    returnError: "Failed to return unused credits.",
    reservedReturnHint: "Credits reserved by an active service request can be returned after settlement or release.",
    returnedTitle: "Unused credits returned to wallet cash",
    returnedDetail: (
      tokens: number,
      amountCents: number,
      currency: string,
      cashBalanceCents: number,
    ) => `${tokens} credits · ${formatMoney(amountCents, currency)} · wallet cash ${formatMoney(cashBalanceCents, currency)}`,
    disclaimer: "This development-only demo validates order creation, simulated payment, representative-scoped credit purchase, paid continuation, and returning unused credits to wallet cash without a real charge or provider refund. WeChat Pay is the next live collection channel; Stripe is deferred. Delegate does not handle card numbers or payment passwords.",
    wechatDisclaimer: "This checkout uses WeChat Pay Native. Delegate stores only the order, amount, and minimal verified payment evidence; it never handles a WeChat payment password. Successful payment automatically purchases service credits for this Digital Representative. Live refunds and automated payouts remain unavailable.",
  },
} as const;

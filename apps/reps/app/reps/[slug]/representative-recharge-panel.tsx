"use client";

import { useCallback, useEffect, useState, useTransition } from "react";

import { pickCopy, type Locale } from "@delegate/web-ui";

import { publishPublicWalletUpdate } from "./public-wallet-client";

type RechargeOrderSnapshot = {
  id: string;
  externalUserId: string;
  amountCents: number;
  currency: string;
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

export function RepresentativeRechargePanel({
  audienceAuthenticated,
  continuationChannel,
  loginHref,
  representativeSlug,
  locale,
}: {
  audienceAuthenticated: boolean;
  continuationChannel?: "telegram";
  loginHref: string;
  representativeSlug: string;
  locale: Locale;
}) {
  const t = pickCopy(locale, copy);
  const [amountCents, setAmountCents] = useState(2000);
  const [order, setOrder] = useState<RechargeOrderSnapshot | null>(null);
  const [purchase, setPurchase] = useState<TokenPurchaseSnapshot | null>(null);
  const [reversal, setReversal] = useState<PurchaseReversalSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [telegramBindingStatus, setTelegramBindingStatus] = useState<
    "checking" | "required" | "ready"
  >(
    continuationChannel === "telegram" && audienceAuthenticated
      ? "checking"
      : continuationChannel === "telegram"
        ? "required"
        : "ready",
  );
  const [isPending, startTransition] = useTransition();
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

  function createRechargeOrder() {
    setError(null);
    startTransition(() => {
      void (async () => {
        const response = await fetch(`/reps/${representativeSlug}/recharge`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            amountCents,
            idempotencyKey: `public_recharge:${representativeSlug}:${Date.now()}:${randomId()}`,
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
        setPurchase(null);
        setReversal(null);
      })().catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : t.createError);
      });
    });
  }

  function completeMockPayment() {
    if (!order) {
      return;
    }
    setError(null);
    startTransition(() => {
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
      })().catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : t.payError);
      });
    });
  }

  function returnUnusedCredits() {
    if (!order || !purchase || purchase.remainingTokenAmount <= 0) {
      return;
    }
    setError(null);
    startTransition(() => {
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
      })().catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : t.returnError);
      });
    });
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

      <div className="button-row button-row-stretch">
        {[500, 2000, 10000].map((preset) => (
          <button
            className={amountCents === preset ? "button-primary" : "button-secondary"}
            key={preset}
            onClick={() => setAmountCents(preset)}
            type="button"
          >
            {formatMoney(preset, "CNY")}
          </button>
        ))}
      </div>

      <button
        className="button-primary button-block"
        disabled={isPending || !rechargeReady}
        onClick={createRechargeOrder}
        type="button"
      >
        {isPending ? t.creating : t.createAction}
      </button>

      {order ? (
        <div className="status-banner status-success">
          <strong>{t.orderCreated}</strong>
          <p>
            {formatMoney(order.amountCents, order.currency)} · {order.status} · {t.balanceLabel}
            {formatMoney(order.cashBalanceCents, order.currency)}
          </p>
          {order.status === "requires_payment" ? (
            <button
              className="button-secondary"
              disabled={isPending}
              onClick={completeMockPayment}
              type="button"
            >
              {t.mockPayAction}
            </button>
          ) : null}
          {purchase ? (
            <>
              <p>
                {t.creditsLabel}
                <strong>{purchase.availableTokenAmount}</strong>
                {" · "}
                {t.creditsScope}
              </p>
              {purchase.remainingTokenAmount > 0 ? (
                <button
                  className="button-secondary"
                  disabled={isPending || purchase.reservedTokenAmount > 0}
                  onClick={returnUnusedCredits}
                  type="button"
                >
                  {isPending ? t.returning : t.returnUnusedAction}
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
      <p className="footer-note">{t.disclaimer}</p>
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
    identityNote: "充值和服务额度会记入当前已登录的 Delegate 账户；绑定后 Web、Telegram 和 Matrix 共用同一份权益。",
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
    creating: "处理中...",
    createError: "创建充值单失败。",
    payError: "模拟支付失败。",
    orderCreated: "充值单已创建",
    balanceLabel: "当前余额 ",
    mockPayAction: "模拟支付成功",
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
    disclaimer: "当前是演示支付入口：可以验证创建充值单、模拟支付、自动购买当前代表服务额度、付费继续和未使用额度退回站内余额，但不会真实扣款或原路退款。正式上线后会接入 Stripe、微信或支付宝；Delegate 不处理银行卡号或支付密码。",
  },
  en: {
    identityNote: "Recharge and service credits are attached to the signed-in Delegate account. Linked Web, Telegram, and Matrix identities share the same entitlements.",
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
    creating: "Working...",
    createError: "Failed to create recharge order.",
    payError: "Failed to simulate payment.",
    orderCreated: "Recharge order created",
    balanceLabel: "Current balance ",
    mockPayAction: "Simulate payment success",
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
    disclaimer: "This demo flow validates order creation, simulated payment, representative-scoped credit purchase, paid continuation, and returning unused credits to wallet cash without a real charge or provider refund. Live collection will use Stripe, WeChat, or Alipay; Delegate does not handle card numbers or payment passwords.",
  },
} as const;

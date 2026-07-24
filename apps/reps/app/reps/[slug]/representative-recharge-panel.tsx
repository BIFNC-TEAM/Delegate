"use client";

import { useState, useTransition } from "react";

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
  representativeSlug,
  locale,
}: {
  representativeSlug: string;
  locale: Locale;
}) {
  const t = pickCopy(locale, copy);
  const [amountCents, setAmountCents] = useState(2000);
  const [order, setOrder] = useState<RechargeOrderSnapshot | null>(null);
  const [purchase, setPurchase] = useState<TokenPurchaseSnapshot | null>(null);
  const [reversal, setReversal] = useState<PurchaseReversalSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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
        disabled={isPending}
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
    identityNote: "充值会自动记到当前浏览器里的同一个匿名身份上，不需要再手填用户 ID。",
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
    identityNote: "Recharge is attached to this browser's current anonymous identity, so no separate user ID is needed.",
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

"use client";

import { useState, useTransition } from "react";

import { pickCopy, type Locale } from "@delegate/web-ui";

type RechargeOrderSnapshot = {
  id: string;
  externalUserId: string;
  amountCents: number;
  currency: string;
  status: string;
  checkoutUrl: string | null;
  cashBalanceCents: number;
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

        const payload = (await response.json()) as { rechargeOrder: RechargeOrderSnapshot };
        setOrder(payload.rechargeOrder);
      })().catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : t.payError);
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
    disclaimer: "当前是演示支付入口：可以验证创建充值单、模拟支付成功、余额入账这条链路，但不会真实扣款。正式上线后会接入 Stripe、微信或支付宝；Delegate 不处理银行卡号或支付密码。",
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
    disclaimer: "This is a demo payment entry: it validates order creation, simulated payment success, and balance crediting without charging real money. Live collection will use Stripe, WeChat, or Alipay; Delegate does not handle card numbers or payment passwords.",
  },
} as const;

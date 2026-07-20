"use client";

import { useEffect, useState } from "react";

import {
  DashboardPanelFrame,
  DashboardSignalStrip,
  DashboardSurface,
  DashboardSurfaceGrid,
  pickCopy,
  type Locale,
} from "@delegate/web-ui";

type AgentWalletDashboardSnapshot = {
  representative: {
    slug: string;
    displayName: string;
    ownerId: string;
    ownerVerificationStatus: string;
  };
  agentWallet: {
    id: string | null;
    currency: string;
    tokenBalance: number;
    totalPurchasedTokens: number;
    totalConsumedTokens: number;
    tokenUnitPriceCents: number;
    creatorRevenueShareBps: number;
  };
  creatorBalances: {
    pendingCents: number;
    withdrawableCents: number;
    frozenCents: number;
    withdrawnCents: number;
  };
  withdrawRequests: Array<{
    id: string;
    amountCents: number;
    currency: string;
    status: string;
    requestedAt: string;
  }>;
  recentLedgerEntries: Array<{
    id: string;
    accountType: string;
    entryKind: string;
    amountCents: number;
    tokenAmount: number;
    currency: string;
    notes: string | null;
    createdAt: string;
  }>;
};

export function DashboardWallet({
  representativeSlug,
  locale,
}: {
  representativeSlug: string;
  locale: Locale;
}) {
  const t = pickCopy(locale, copy);
  const [snapshot, setSnapshot] = useState<AgentWalletDashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`/api/dashboard/representatives/${representativeSlug}/wallet`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await extractError(response));
        }
        return response.json() as Promise<AgentWalletDashboardSnapshot>;
      })
      .then((nextSnapshot) => {
        if (!cancelled) {
          setSnapshot(nextSnapshot);
        }
      })
      .catch((nextError: unknown) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : t.loadError);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [representativeSlug, t.loadError]);

  if (!snapshot) {
    return (
      <section className="section">
        <article className="dashboard-highlight-card">
          <p className="panel-title">{t.loadingTitle}</p>
          <h3>{t.loadingHeadline}</h3>
          <p>{error ?? t.loadingCopy}</p>
        </article>
      </section>
    );
  }

  const signalCards = [
    {
      label: t.cards.tokenBalance,
      value: formatNumber(snapshot.agentWallet.tokenBalance),
      detail: t.cards.tokenBalanceDetail,
      tone: "accent" as const,
    },
    {
      label: t.cards.withdrawable,
      value: formatMoney(snapshot.creatorBalances.withdrawableCents, snapshot.agentWallet.currency),
      detail: t.cards.withdrawableDetail,
      tone: "safe" as const,
    },
    {
      label: t.cards.pending,
      value: formatMoney(snapshot.creatorBalances.pendingCents, snapshot.agentWallet.currency),
      detail: t.cards.pendingDetail,
    },
    {
      label: t.cards.frozen,
      value: formatMoney(snapshot.creatorBalances.frozenCents, snapshot.agentWallet.currency),
      detail: t.cards.frozenDetail,
    },
  ];

  return (
    <DashboardPanelFrame
      eyebrow={t.eyebrow}
      id="wallet"
      summary={t.summary(snapshot.representative.displayName)}
      title={t.title}
    >
      <div className="dashboard-panel-hero">
        <article className="dashboard-highlight-card dashboard-highlight-card-primary">
          <p className="panel-title">{t.heroKicker}</p>
          <h3>{t.heroTitle}</h3>
          <p>{t.heroCopy}</p>
          <div className="chip-row">
            <span className="chip">{snapshot.representative.displayName}</span>
            <span className="chip chip-safe">{snapshot.representative.ownerVerificationStatus}</span>
            <span className="chip">{t.revenueShare(snapshot.agentWallet.creatorRevenueShareBps)}</span>
          </div>
        </article>

        <DashboardSignalStrip cards={signalCards} />
      </div>

      {error ? <div className="status-banner status-error">{error}</div> : null}

      <DashboardSurfaceGrid>
        <DashboardSurface
          eyebrow={t.agentWalletEyebrow}
          meta={<span className="chip">{snapshot.agentWallet.currency}</span>}
          title={t.agentWalletTitle}
        >
          <div className="row-list">
            <WalletMetric label={t.totalPurchased} value={formatNumber(snapshot.agentWallet.totalPurchasedTokens)} />
            <WalletMetric label={t.totalConsumed} value={formatNumber(snapshot.agentWallet.totalConsumedTokens)} />
            <WalletMetric
              label={t.unitPrice}
              value={formatMoney(snapshot.agentWallet.tokenUnitPriceCents, snapshot.agentWallet.currency)}
            />
            <WalletMetric
              label={t.withdrawn}
              value={formatMoney(snapshot.creatorBalances.withdrawnCents, snapshot.agentWallet.currency)}
            />
          </div>
        </DashboardSurface>

        <DashboardSurface
          eyebrow={t.withdrawEyebrow}
          meta={<span className="chip">{t.withdrawCount(snapshot.withdrawRequests.length)}</span>}
          title={t.withdrawTitle}
        >
          <div className="row-list">
            {snapshot.withdrawRequests.length ? (
              snapshot.withdrawRequests.map((request) => (
                <div className="skill-row" key={request.id}>
                  <div>
                    <strong>{formatMoney(request.amountCents, request.currency)}</strong>
                    <p>{request.status}</p>
                    <div className="chip-row">
                      <span className="chip">{formatTimestamp(request.requestedAt, locale)}</span>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">{t.noWithdrawRequests}</p>
            )}
          </div>
        </DashboardSurface>

        <DashboardSurface
          eyebrow={t.ledgerEyebrow}
          meta={<span className="chip">{t.ledgerCount(snapshot.recentLedgerEntries.length)}</span>}
          title={t.ledgerTitle}
        >
          <div className="row-list">
            {snapshot.recentLedgerEntries.length ? (
              snapshot.recentLedgerEntries.map((entry) => (
                <div className="skill-row" key={entry.id}>
                  <div>
                    <strong>{entry.entryKind}</strong>
                    <p>
                      {formatMoney(entry.amountCents, entry.currency)} · {entry.tokenAmount} {t.creditUnit}
                    </p>
                    <div className="chip-row">
                      <span className="chip">{entry.accountType}</span>
                      <span className="chip">{formatTimestamp(entry.createdAt, locale)}</span>
                    </div>
                    {entry.notes ? <p className="footer-note">{entry.notes}</p> : null}
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">{t.noLedgerEntries}</p>
            )}
          </div>
        </DashboardSurface>
      </DashboardSurfaceGrid>
    </DashboardPanelFrame>
  );
}

function WalletMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="skill-row">
      <div>
        <strong>{label}</strong>
        <p>{value}</p>
      </div>
    </div>
  );
}

async function extractError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? response.statusText;
}

function formatMoney(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatTimestamp(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

const copy = {
  zh: {
    eyebrow: "代表钱包",
    title: "钱包、分成和提现",
    summary: (name: string) => `${name} 的代表钱包账本视图。`,
    loadingTitle: "正在加载钱包",
    loadingHeadline: "正在核对服务额度、收益和提现队列",
    loadingCopy: "如果这里一直不动，可能是本地数据库还没有钱包数据。",
    loadError: "加载钱包失败。",
    heroKicker: "Money plane",
    heroTitle: "把用户充值、服务额度和创作者提现放在一张账本上。",
    heroCopy: "这里先给主理人看清楚余额和流向：哪些额度还没用，哪些收益待释放，哪些钱已经可以申请提现。当前提现只会创建审核请求并冻结余额，不会自动打款。",
    revenueShare: (bps: number) => `Creator ${bps / 100}%`,
    cards: {
      tokenBalance: "服务额度",
      tokenBalanceDetail: "当前代表还能用于继续服务的额度。",
      withdrawable: "可提现",
      withdrawableDetail: "creator 已释放、可申请提现的钱。",
      pending: "待释放",
      pendingDetail: "用户已购买，但还没随服务消耗释放。",
      frozen: "提现冻结",
      frozenDetail: "已进入 WithdrawRequest 审核队列、暂不可重复申请的金额。",
    },
    agentWalletEyebrow: "代表账户",
    agentWalletTitle: "代表钱包参数",
    totalPurchased: "累计购买额度",
    totalConsumed: "累计消耗额度",
    unitPrice: "额度单价",
    withdrawn: "已提现",
    withdrawEyebrow: "Payout queue",
    withdrawTitle: "提现请求（不自动打款）",
    withdrawCount: (count: number) => `${count} 条`,
    noWithdrawRequests: "还没有提现请求；当前版本只创建请求并冻结余额，后续再接 Stripe Connect、支付宝转账或微信商家转账。",
    ledgerEyebrow: "账本记录",
    ledgerTitle: "最近钱包账本",
    ledgerCount: (count: number) => `${count} 条`,
    noLedgerEntries: "还没有钱包流水。",
    creditUnit: "额度",
  },
  en: {
    eyebrow: "Representative Wallet",
    title: "Wallet, revenue share, and withdrawals",
    summary: (name: string) => `Representative wallet ledger view for ${name}.`,
    loadingTitle: "Loading wallet",
    loadingHeadline: "Checking service credits, earnings, and withdrawal queue",
    loadingCopy: "If this keeps loading, the local database may not have wallet data yet.",
    loadError: "Failed to load wallet.",
    heroKicker: "Money plane",
    heroTitle: "Keep user recharge, service credits, and creator withdrawals on one ledger.",
    heroCopy: "This view gives creators the money picture first: unused credits, pending earnings, withdrawable balance, and payout review. Withdrawals are currently request-and-freeze only; no automatic payout is sent.",
    revenueShare: (bps: number) => `Creator ${bps / 100}%`,
    cards: {
      tokenBalance: "Service credits",
      tokenBalanceDetail: "Credits this representative can still spend on continued service.",
      withdrawable: "Withdrawable",
      withdrawableDetail: "Creator earnings released and ready to request.",
      pending: "Pending",
      pendingDetail: "Purchased by users, not released until service is consumed.",
      frozen: "Frozen",
      frozenDetail: "Funds locked for WithdrawRequest review so they cannot be requested twice.",
    },
    agentWalletEyebrow: "Representative account",
    agentWalletTitle: "Representative wallet parameters",
    totalPurchased: "Total purchased credits",
    totalConsumed: "Total consumed credits",
    unitPrice: "Credit unit price",
    withdrawn: "Withdrawn",
    withdrawEyebrow: "Payout queue",
    withdrawTitle: "Withdrawal requests, no automatic payout yet",
    withdrawCount: (count: number) => `${count} rows`,
    noWithdrawRequests: "No withdrawal requests yet; this version creates the request and freezes balance before Stripe Connect, Alipay transfer, or WeChat merchant transfer is wired.",
    ledgerEyebrow: "Ledger trail",
    ledgerTitle: "Recent wallet ledger",
    ledgerCount: (count: number) => `${count} rows`,
    noLedgerEntries: "No wallet ledger entries yet.",
    creditUnit: "credits",
  },
} as const;

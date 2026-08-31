"use client";

import { useEffect, useState, useTransition } from "react";

import {
  DashboardPanelFrame,
  DashboardSignalStrip,
  DashboardSurface,
  DashboardSurfaceGrid,
  pickCopy,
  type Locale,
} from "@delegate/web-ui";

type DashboardOverviewSnapshot = {
  representative: {
    slug: string;
    displayName: string;
    roleSummary: string;
  };
  metrics: Array<{
    label: string;
    value: string;
    detail: string;
  }>;
  wallet: {
    starsBalance: number;
  };
  workflowEngine: {
    configured: "local_runner" | "temporal";
    effective: "local_runner" | "temporal";
    temporalReady: boolean;
    queueName: string;
    fallbackReason?: string;
  };
  workflowMetrics: Array<{
    label: string;
    value: string;
    detail: string;
  }>;
  handoffRequests: Array<{
    id: string;
    who: string;
    why: string;
    score: "High" | "Medium" | "Low";
    status: "open" | "reviewing" | "accepted" | "declined" | "closed";
    recommendedOwnerAction: string;
    requestType: string;
    isPaid: boolean;
    requestedAt: string;
  }>;
  recentInvoices: Array<{
    id: string;
    who: string;
    planName: string;
    planType: "free" | "pass" | "deep_help" | "sponsor";
    starsAmount: number;
    status: "pending" | "paid" | "fulfilled" | "refunded" | "failed" | "canceled";
    createdAt: string;
    paidAt?: string;
    invoiceLink?: string;
  }>;
  recentWorkflows: Array<{
    id: string;
    kind: "handoff_follow_up" | "approval_expiration";
    engine: "local_runner" | "temporal";
    status: "queued" | "running" | "completed" | "failed" | "canceled";
    enginePhase?:
      | "dispatch_pending"
      | "waiting_timer"
      | "activity_running"
      | "retry_backoff"
      | "cancel_requested"
      | "completed"
      | "failed"
      | "canceled";
    scheduledAt: string;
    nextWakeAt?: string;
    externalWorkflowId?: string;
    externalRunId?: string;
    cancelRequestedAt?: string;
    completedAt?: string;
    detail: string;
  }>;
};

const statusLabel = {
  open: "open",
  reviewing: "reviewing",
  accepted: "accepted",
  declined: "declined",
  closed: "closed",
} as const;

export function DashboardOverview({
  representativeSlug,
  locale,
}: {
  representativeSlug: string;
  locale: Locale;
}) {
  const t = pickCopy(locale, copy);
  const [snapshot, setSnapshot] = useState<DashboardOverviewSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void refreshOverview(representativeSlug, locale, setSnapshot, setError);
  }, [representativeSlug, locale]);

  const openHandoffCount = snapshot
    ? snapshot.handoffRequests.filter((item) => item.status === "open" || item.status === "reviewing")
        .length
    : 0;
  const signalCards = snapshot
    ? [
        {
          label: t.signalCards.openHandoffsLabel,
          value: `${openHandoffCount}`,
          detail: t.signalCards.openHandoffsDetail,
          tone: "accent" as const,
        },
        {
          label: t.signalCards.starsLiveLabel,
          value: `${snapshot.wallet.starsBalance}`,
          detail: t.signalCards.starsLiveDetail,
          tone: "safe" as const,
        },
        {
          label: t.signalCards.recentInvoicesLabel,
          value: `${snapshot.recentInvoices.length}`,
          detail: t.signalCards.recentInvoicesDetail,
        },
      ]
    : [];

  function handleStatusChange(
    handoffId: string,
    nextStatus: DashboardOverviewSnapshot["handoffRequests"][number]["status"],
    label: string,
  ) {
    setBusyKey(`${handoffId}:${nextStatus}`);
    setError(null);
    setMessage(null);

    startTransition(() => {
      void (async () => {
        const response = await fetch(
          `/api/dashboard/representatives/${representativeSlug}/handoffs/${handoffId}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ status: nextStatus }),
          },
        );

        if (!response.ok) {
          throw new Error(await extractError(response));
        }

        await refreshOverview(representativeSlug, locale, setSnapshot, setError);
        setMessage(t.statusSaved(label, statusLabel[nextStatus]));
      })()
        .catch((nextError: unknown) => {
          setError(nextError instanceof Error ? nextError.message : t.updateError);
        })
        .finally(() => {
          setBusyKey(null);
        });
    });
  }

  if (!snapshot) {
    return (
      <section className="section">
        <article className="dashboard-highlight-card">
          <p className="panel-title">{t.loadingTitle}</p>
          <h3>{t.loadingHeadline}</h3>
          <p>{t.loadingCopy}</p>
        </article>
      </section>
    );
  }

  return (
    <DashboardPanelFrame
      eyebrow={t.ownerViewEyebrow}
      id="overview"
      summary={t.summary(snapshot.representative.displayName)}
      title={t.panelTitle}
    >
      <div className="dashboard-panel-hero">
        <article className="dashboard-highlight-card dashboard-highlight-card-primary">
          <p className="panel-title">{t.heroKicker}</p>
          <h3>{t.heroTitle}</h3>
          <p>{snapshot.representative.roleSummary}</p>
          <div className="chip-row">
            <span className="chip">{snapshot.representative.displayName}</span>
            <span className="chip chip-safe">{t.starsLiveChip(snapshot.wallet.starsBalance)}</span>
            <span className="chip">{t.activeHandoffsChip(openHandoffCount)}</span>
          </div>
        </article>

        <DashboardSignalStrip cards={signalCards} />
      </div>

      {message ? <div className="status-banner status-success">{message}</div> : null}
      {error ? <div className="status-banner status-error">{error}</div> : null}

      <DashboardSignalStrip
        cards={snapshot.metrics.map((metric, index) => ({
          label: metric.label,
          value: metric.value,
          detail: metric.detail,
          tone: index === 0 ? ("accent" as const) : "default",
        }))}
      />

      {snapshot.workflowMetrics.length ? (
        <div className="dashboard-subsection-stack">
          <div className="dashboard-inline-section-heading">
            <div>
              <p className="eyebrow">{t.workflowEyebrow}</p>
              <h3>{t.workflowTitle}</h3>
            </div>
            <p className="section-copy">{t.workflowCopy}</p>
          </div>
          <DashboardSignalStrip
            cards={snapshot.workflowMetrics.map((metric) => ({
              label: metric.label,
              value: metric.value,
              detail: metric.detail,
              tone: "accent" as const,
            }))}
          />
        </div>
      ) : null}

      <DashboardSurfaceGrid>
        <DashboardSurface
          eyebrow={t.handoffEyebrow}
          meta={<span className="chip chip-safe">{t.activeChip(openHandoffCount)}</span>}
          title={t.handoffTitle}
        >
          <div className="row-list">
            {snapshot.handoffRequests.length ? (
              snapshot.handoffRequests.map((item) => (
                <div className="skill-row" key={item.id}>
                  <div>
                    <strong>{item.who}</strong>
                    <p>{item.why}</p>
                    <div className="chip-row">
                      <span className="chip">{item.score}</span>
                      <span className="chip">{item.requestType}</span>
                      <span className="chip">{item.status}</span>
                      {item.isPaid ? <span className="chip chip-safe">{t.paidLabel}</span> : null}
                    </div>
                    <p className="footer-note">{t.ownerActionLabel(item.recommendedOwnerAction)}</p>
                  </div>

                  <div className="button-row button-row-stretch">
                    {buildNextStatusActions(item.status).map((action) => (
                      <button
                        className={action.emphasis === "primary" ? "button-primary" : "button-secondary"}
                        disabled={isPending || busyKey === `${item.id}:${action.status}`}
                        key={action.status}
                        onClick={() => handleStatusChange(item.id, action.status, item.who)}
                        title={translateActionHint(locale, action.label)}
                        type="button"
                      >
                        {busyKey === `${item.id}:${action.status}` ? t.saving : translateActionLabel(locale, action.label)}
                      </button>
                    ))}
                  </div>
                  {buildNextStatusActions(item.status).length ? (
                    <p className="footer-note">{t.handoffButtonHint}</p>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="muted">{t.noHandoffs}</p>
            )}
          </div>
        </DashboardSurface>

        <DashboardSurface
          eyebrow={t.billingEyebrow}
          meta={<span className="chip">{t.invoicesChip(snapshot.recentInvoices.length)}</span>}
          title={t.billingTitle}
        >
          <div className="row-list">
            {snapshot.recentInvoices.length ? (
              snapshot.recentInvoices.map((invoice) => (
                <div className="skill-row" key={invoice.id}>
                  <div>
                    <strong>
                      {invoice.who} · {invoice.planName}
                    </strong>
                    <p>
                      {invoice.starsAmount} Stars · {invoice.status}
                    </p>
                    <div className="chip-row">
                      <span className="chip">{invoice.planType}</span>
                      <span className="chip">{formatTimestamp(invoice.createdAt, locale)}</span>
                      {invoice.paidAt ? (
                        <span className="chip chip-safe">{formatTimestamp(invoice.paidAt, locale)}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="button-row button-row-stretch">
                    {isUsableInvoiceLink(invoice.invoiceLink) ? (
                      <a className="button-secondary" href={invoice.invoiceLink} target="_blank" rel="noreferrer">
                        {t.openInvoice}
                      </a>
                    ) : (
                      <span className="chip">{t.invoiceRecordOnly}</span>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">{t.noInvoices}</p>
            )}
          </div>
        </DashboardSurface>

        <DashboardSurface
          eyebrow={t.workflowEyebrow}
          meta={
            <div className="chip-row">
              <span className="chip">{t.workflowChip(snapshot.recentWorkflows.length)}</span>
              <span className="chip chip-safe">{t.workflowEngineChip(snapshot.workflowEngine.effective)}</span>
            </div>
          }
          title={t.workflowQueueTitle}
        >
          <div className="row-list">
            {snapshot.recentWorkflows.length ? (
              snapshot.recentWorkflows.map((workflow) => (
                <div className="skill-row" key={workflow.id}>
                  <div>
                    <strong>{workflow.kind}</strong>
                    <p>{workflow.detail}</p>
                    <div className="chip-row">
                      <span className="chip">{t.workflowEngineChip(workflow.engine)}</span>
                      <span className="chip">{workflow.status}</span>
                      {workflow.enginePhase ? (
                        <span className="chip">{t.workflowPhaseChip(workflow.enginePhase)}</span>
                      ) : null}
                      <span className="chip">{t.scheduledAtChip(formatTimestamp(workflow.scheduledAt, locale))}</span>
                      {workflow.nextWakeAt ? (
                        <span className="chip chip-safe">{t.nextWakeAtChip(formatTimestamp(workflow.nextWakeAt, locale))}</span>
                      ) : null}
                      {workflow.cancelRequestedAt ? (
                        <span className="chip">{t.cancelRequestedChip(formatTimestamp(workflow.cancelRequestedAt, locale))}</span>
                      ) : null}
                      {workflow.completedAt ? (
                        <span className="chip chip-safe">{formatTimestamp(workflow.completedAt, locale)}</span>
                      ) : null}
                    </div>
                    {workflow.externalWorkflowId || workflow.externalRunId ? (
                      <p className="footer-note">
                        {[
                          workflow.externalWorkflowId
                            ? t.workflowIdLabel(compactWorkflowId(workflow.externalWorkflowId))
                            : null,
                          workflow.externalRunId
                            ? t.workflowRunIdLabel(compactWorkflowId(workflow.externalRunId))
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">{t.noWorkflows}</p>
            )}
          </div>
        </DashboardSurface>
      </DashboardSurfaceGrid>
    </DashboardPanelFrame>
  );
}

function buildNextStatusActions(
  status: DashboardOverviewSnapshot["handoffRequests"][number]["status"],
): Array<{
  status: DashboardOverviewSnapshot["handoffRequests"][number]["status"];
  label: string;
  emphasis: "primary" | "secondary";
}> {
  switch (status) {
    case "open":
      return [
        { status: "reviewing", label: "Review", emphasis: "secondary" },
        { status: "accepted", label: "Accept", emphasis: "primary" },
        { status: "declined", label: "Decline", emphasis: "secondary" },
      ];
    case "reviewing":
      return [
        { status: "accepted", label: "Accept", emphasis: "primary" },
        { status: "closed", label: "Close", emphasis: "secondary" },
      ];
    case "accepted":
      return [{ status: "closed", label: "Close", emphasis: "secondary" }];
    case "declined":
    case "closed":
    default:
      return [];
  }
}

async function refreshOverview(
  representativeSlug: string,
  locale: Locale,
  setSnapshot: (value: DashboardOverviewSnapshot) => void,
  setError: (value: string | null) => void,
) {
  const response = await fetch(`/api/dashboard/representatives/${representativeSlug}/overview?lang=${locale}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await extractError(response));
  }

  const payload = (await response.json()) as DashboardOverviewSnapshot;
  setSnapshot(payload);
  setError(null);
}

async function extractError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    if (payload.error) {
      return payload.error;
    }
  } catch {
    // ignore
  }
  return `${response.status} ${response.statusText}`;
}

function formatTimestamp(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function compactWorkflowId(value: string): string {
  if (value.length <= 28) {
    return value;
  }

  return `${value.slice(0, 16)}...${value.slice(-8)}`;
}

function translateActionLabel(locale: Locale, label: string): string {
  if (locale === "en") {
    switch (label) {
      case "Review":
        return "Review first";
      case "Accept":
        return "Accept handoff";
      case "Decline":
        return "Decline request";
      case "Close":
        return "Close item";
      default:
        return label;
    }
  }

  switch (label) {
    case "Review":
      return "先评估";
    case "Accept":
      return "接受并接手";
    case "Decline":
      return "拒绝并关闭";
    case "Close":
      return "关闭事项";
    default:
      return label;
  }
}

function translateActionHint(locale: Locale, label: string): string {
  if (locale === "en") {
    switch (label) {
      case "Review":
        return "Mark this handoff as being reviewed before deciding.";
      case "Accept":
        return "Accept the handoff so the owner can follow up.";
      case "Decline":
        return "Decline the request and remove it from the active queue.";
      case "Close":
        return "Close the item after it no longer needs owner action.";
      default:
        return label;
    }
  }

  switch (label) {
    case "Review":
      return "先标记为正在评估，之后再决定是否接手。";
    case "Accept":
      return "接受后代表主人需要继续人工跟进。";
    case "Decline":
      return "拒绝后这条请求会从待处理队列关闭。";
    case "Close":
      return "确认不再需要处理后关闭这条事项。";
    default:
      return label;
  }
}

function isUsableInvoiceLink(value: string | undefined): value is string {
  if (!value) {
    return false;
  }

  return !value.includes("t.me/invoice/");
}

const copy = {
  zh: {
    signalCards: {
      openHandoffsLabel: "待处理请求",
      openHandoffsDetail: "当前值得主人优先判断与接手的请求数。",
      starsLiveLabel: "代表余额",
      starsLiveDetail: "当前可用于网页服务的余额信号。",
      recentInvoicesLabel: "最近付款",
      recentInvoicesDetail: "最近的网页续用、付款记录和充值意图信号。",
    },
    statusSaved: (label: string, status: string) => `${label} 现在是 ${status}。`,
    updateError: "更新待处理请求状态失败。",
    loadingTitle: "概览加载中",
    loadingHeadline: "正在读取控制台最新快照。",
    loadingCopy: "会先加载指标、人工转接收件箱和代表余额记录。",
    ownerViewEyebrow: "运营总览",
    summary: (name: string) => `${name} 的控制台先展示高频信号，再进入人工接手、付款和钱包细节。`,
    panelTitle: "先看今天的运营脉冲，再判断代表钱包、续用和人工接手状态。",
    heroKicker: "代表经营状态",
    heroTitle: "主人需要看到这个对外代理是否还在赚钱、消耗和等待接手。",
    starsLiveChip: (stars: number) => `${stars} Stars`,
    activeHandoffsChip: (count: number) => `${count} 个待接手`,
    workflowEyebrow: "后台定时任务",
    workflowTitle: "跨时间的事情，要能排队、超时、补跑，而不是靠人记得。",
    workflowCopy: "审批过期和人工接手跟进现在会进入后台定时任务，不再只是一次性函数调用。",
    handoffEyebrow: "待处理请求",
    activeChip: (count: number) => `${count} active`,
    handoffTitle: "人工转接收件箱",
    paidLabel: "已付费",
    ownerActionLabel: (value: string) => `建议动作：${value}`,
    handoffButtonHint: "先评估不会关闭请求；接受代表主人要接手跟进；拒绝或关闭会移出待处理队列。",
    saving: "保存中...",
    noHandoffs: "当前没有待处理的人工接手请求。",
    billingEyebrow: "付款 / 余额",
    invoicesChip: (count: number) => `${count} 笔付款`,
    billingTitle: "最近网页续用和付款记录",
    openInvoice: "查看发票",
    invoiceRecordOnly: "仅付款记录",
    noInvoices: "还没有任何付款记录。",
    workflowChip: (count: number) => `${count} 条后台任务`,
    workflowEngineChip: (engine: "local_runner" | "temporal") =>
      engine === "temporal" ? "可靠定时" : "本地定时",
    workflowPhaseChip: (phase: NonNullable<DashboardOverviewSnapshot["recentWorkflows"][number]["enginePhase"]>) =>
      `阶段：${phase}`,
    scheduledAtChip: (value: string) => `计划 ${value}`,
    nextWakeAtChip: (value: string) => `下次唤醒 ${value}`,
    cancelRequestedChip: (value: string) => `请求取消 ${value}`,
    workflowIdLabel: (value: string) => `任务ID: ${value}`,
    workflowRunIdLabel: (value: string) => `运行ID: ${value}`,
    workflowQueueTitle: "最近后台任务",
    noWorkflows: "当前还没有后台定时任务记录。",
  },
  en: {
    signalCards: {
      openHandoffsLabel: "Needs follow-up",
      openHandoffsDetail: "Requests that deserve direct human review right now.",
      starsLiveLabel: "Representative balance",
      starsLiveDetail: "Balance signal available for web service continuation.",
      recentInvoicesLabel: "Recent payments",
      recentInvoicesDetail: "The latest web continuation, payment records, and recharge-intent signals.",
    },
    statusSaved: (label: string, status: string) => `${label} is now ${status}.`,
    updateError: "Failed to update follow-up status.",
    loadingTitle: "Loading overview",
    loadingHeadline: "Fetching the latest console snapshot.",
    loadingCopy: "Metrics, follow-up requests, and representative balance records load first.",
    ownerViewEyebrow: "Operations overview",
    summary: (name: string) => `${name}'s console surfaces high-frequency signal before human follow-up, payment, and wallet detail.`,
    panelTitle: "Read today's operating pulse before judging representative wallet, continuation, and human follow-up state.",
    heroKicker: "Representative operating state",
    heroTitle: "Owners need to know whether this Digital Representative is earning, consuming, or waiting for intervention.",
    starsLiveChip: (stars: number) => `${stars} Stars`,
    activeHandoffsChip: (count: number) => `${count} active follow-ups`,
    workflowEyebrow: "Background timers",
    workflowTitle: "Anything that spans time should queue, expire, and recover instead of relying on memory.",
    workflowCopy: "Approval expiry and human follow-up now flow through durable background timers instead of one-off function calls.",
    handoffEyebrow: "Follow-up queue",
    activeChip: (count: number) => `${count} active`,
    handoffTitle: "Human follow-up queue",
    paidLabel: "paid",
    ownerActionLabel: (value: string) => `Suggested action: ${value}`,
    handoffButtonHint: "Review keeps the request open; accept means a human follow-up; decline or close removes it from the active queue.",
    saving: "Saving...",
    noHandoffs: "There are no follow-up requests waiting right now.",
    billingEyebrow: "Payments / Balance",
    invoicesChip: (count: number) => `${count} payments`,
    billingTitle: "Recent web continuation and payment records",
    openInvoice: "View invoice",
    invoiceRecordOnly: "Payment record only",
    noInvoices: "There are no payment records yet.",
    workflowChip: (count: number) => `${count} background tasks`,
    workflowEngineChip: (engine: "local_runner" | "temporal") =>
      engine === "temporal" ? "Reliable timer" : "Local timer",
    workflowPhaseChip: (phase: NonNullable<DashboardOverviewSnapshot["recentWorkflows"][number]["enginePhase"]>) =>
      `phase: ${phase}`,
    scheduledAtChip: (value: string) => `scheduled ${value}`,
    nextWakeAtChip: (value: string) => `next wake ${value}`,
    cancelRequestedChip: (value: string) => `cancel requested ${value}`,
    workflowIdLabel: (value: string) => `taskId: ${value}`,
    workflowRunIdLabel: (value: string) => `runId: ${value}`,
    workflowQueueTitle: "Recent background tasks",
    noWorkflows: "There are no background timer records yet.",
  },
} as const;

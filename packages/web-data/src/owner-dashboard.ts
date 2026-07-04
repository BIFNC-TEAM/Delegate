import { demoRepresentative } from "@delegate/domain";
import { getWorkflowEngineConfig } from "@delegate/workflows";
import {
  HandoffStatus,
  InvoiceStatus,
  PricingPlanType,
  Prisma,
} from "@prisma/client";

import {
  getRepresentativeOpenVikingOverviewMetrics,
  maybeStoreHandoffPatternFromStatusChange,
} from "./openviking";
import { prisma } from "./prisma";

export type DashboardOverviewSnapshot = {
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
    sponsorPoolCredit: number;
    balanceCredits: number;
  };
  openVikingMetrics: Array<{
    label: string;
    value: string;
    detail: string;
  }>;
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
    kind: "handoff_follow_up" | "approval_expiration" | "creator_training_review";
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

const overviewArgs = Prisma.validator<Prisma.RepresentativeDefaultArgs>()({
  include: {
    owner: {
      include: {
        wallet: true,
      },
    },
    handoffRequests: {
      include: {
        contact: true,
      },
      orderBy: [{ recommendedPriority: "desc" }, { createdAt: "desc" }],
      take: 8,
    },
    invoices: {
      include: {
        contact: true,
      },
      orderBy: [{ createdAt: "desc" }],
      take: 8,
    },
    workflowRuns: {
      orderBy: [{ createdAt: "desc" }],
      take: 8,
    },
  },
});

type RepresentativeOverviewRecord = Prisma.RepresentativeGetPayload<{
  include: typeof overviewArgs.include;
}>;

let demoFallbackOverviewSnapshot: DashboardOverviewSnapshot | null = null;

export async function getDashboardOverviewSnapshot(
  representativeSlug: string,
  locale: "zh" | "en" = "zh",
): Promise<DashboardOverviewSnapshot | null> {
  if (shouldUseStaticFallbackMode(representativeSlug)) {
    return cloneDashboardOverviewSnapshot(getOrCreateDemoFallbackOverviewSnapshot(locale));
  }

  try {
    const representative = await prisma.representative.findUnique({
      where: { slug: representativeSlug },
      ...overviewArgs,
    });

    if (!representative) {
      return null;
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [
      [
        todayConversationCount,
        openHandoffCount,
        paidInvoiceCount,
        pendingWorkflowCount,
        dispatchPendingWorkflowCount,
        waitingTimerWorkflowCount,
        cancelRequestedWorkflowCount,
        failedWorkflowCount,
      ],
      openVikingMetrics,
    ] =
      await Promise.all([
        prisma.$transaction([
          prisma.conversation.count({
            where: {
              representativeId: representative.id,
              createdAt: {
                gte: startOfToday,
              },
            },
          }),
          prisma.handoffRequest.count({
            where: {
              representativeId: representative.id,
              status: {
                in: [HandoffStatus.OPEN, HandoffStatus.REVIEWING],
              },
            },
          }),
          prisma.invoice.count({
            where: {
              representativeId: representative.id,
              status: {
                in: [InvoiceStatus.PAID, InvoiceStatus.FULFILLED],
              },
            },
          }),
          prisma.workflowRun.count({
            where: {
              representativeId: representative.id,
              status: {
                in: ["QUEUED", "RUNNING"],
              },
            },
          }),
          prisma.workflowRun.count({
            where: {
              representativeId: representative.id,
              enginePhase: "DISPATCH_PENDING",
            },
          }),
          prisma.workflowRun.count({
            where: {
              representativeId: representative.id,
              enginePhase: "WAITING_TIMER",
            },
          }),
          prisma.workflowRun.count({
            where: {
              representativeId: representative.id,
              enginePhase: "CANCEL_REQUESTED",
            },
          }),
          prisma.workflowRun.count({
            where: {
              representativeId: representative.id,
              status: "FAILED",
            },
          }),
        ]),
        getRepresentativeOpenVikingOverviewMetrics(representative.slug),
      ]);

    const wallet = representative.owner.wallet;
    const paidBreakdown = buildPaidBreakdown(representative.invoices);
    const workflowEngine = getWorkflowEngineConfig(process.env);

    return {
      representative: {
        slug: representative.slug,
        displayName: representative.displayName,
        roleSummary: representative.roleSummary,
      },
      metrics: [
        {
          label: locale === "zh" ? "今日新会话" : "New conversations",
          value: String(todayConversationCount),
          detail: todayConversationCount > 0
            ? locale === "zh"
              ? "已进入真实会话表统计"
              : "Now counted from real conversation rows."
            : locale === "zh"
              ? "今天还没有新的 inbound 会话"
              : "No new inbound conversations yet today.",
        },
        {
          label: locale === "zh" ? "已确认付费" : "Confirmed payments",
          value: String(paidInvoiceCount),
          detail:
            paidBreakdown ||
            (locale === "zh"
              ? "还没有完成的 Stars 付费记录"
              : "No completed Stars payments yet."),
        },
        {
          label: locale === "zh" ? "待人工评估" : "Pending owner review",
          value: String(openHandoffCount),
          detail: openHandoffCount > 0
            ? locale === "zh"
              ? "包含 open 与 reviewing 状态的收件项"
              : "Includes inbox items in open and reviewing states."
            : locale === "zh"
              ? "当前 owner inbox 已清空"
              : "The owner inbox is currently clear.",
        },
        {
          label: locale === "zh" ? "Stars 余额" : "Stars balance",
          value: wallet ? String(wallet.starsBalance) : "0",
          detail: wallet
            ? `sponsor pool ${wallet.sponsorPoolCredit} · credits ${wallet.balanceCredits}`
            : locale === "zh"
              ? "还没有 owner wallet 记录"
              : "No owner wallet record yet.",
        },
      ],
      wallet: {
        starsBalance: wallet?.starsBalance ?? 0,
        sponsorPoolCredit: wallet?.sponsorPoolCredit ?? 0,
        balanceCredits: wallet?.balanceCredits ?? 0,
      },
      openVikingMetrics: openVikingMetrics
        ? [
            {
              label: locale === "zh" ? "OpenViking resources" : "OpenViking resources",
              value: String(openVikingMetrics.resourcesSynced),
              detail:
                locale === "zh"
                  ? "最近一次成功同步的公开资源数"
                  : "Public resources from the most recent successful sync.",
            },
            {
              label: locale === "zh" ? "Memories today" : "Memories today",
              value: String(openVikingMetrics.memoriesCapturedToday),
              detail:
                locale === "zh"
                  ? "今天写入的公开安全记忆摘要"
                  : "Public-safe memory summaries captured today.",
            },
            {
              label: locale === "zh" ? "Commits today" : "Commits today",
              value: String(openVikingMetrics.sessionsCommittedToday),
              detail:
                locale === "zh"
                  ? "今天完成的 OpenViking session commit 次数"
                  : "OpenViking session commits completed today.",
            },
            {
              label: locale === "zh" ? "Recalls today" : "Recalls today",
              value: String(openVikingMetrics.recallsUsedToday),
              detail:
                locale === "zh"
                  ? "今天真正注入回复链路的 recall 次数"
                  : "Recall operations actually injected into response flow today.",
            },
            {
              label: locale === "zh" ? "Sync failures" : "Sync failures",
              value: String(openVikingMetrics.syncFailures),
              detail:
                locale === "zh"
                  ? "累计失败的 sync job 数量"
                  : "Cumulative failed sync jobs.",
            },
            {
              label: "Health",
              value: openVikingMetrics.lastHealthCheckResult,
              detail:
                locale === "zh"
                  ? "最近一次 OpenViking health check 结果"
                  : "Most recent OpenViking health check result.",
            },
          ]
        : [],
      workflowEngine: {
        configured: workflowEngine.configuredEngine,
        effective: workflowEngine.effectiveEngine,
        temporalReady: workflowEngine.temporalReady,
        queueName:
          workflowEngine.effectiveEngine === "temporal"
            ? workflowEngine.temporalTaskQueue ?? workflowEngine.localQueueName
            : workflowEngine.localQueueName,
        ...(workflowEngine.fallbackReason ? { fallbackReason: workflowEngine.fallbackReason } : {}),
      },
      workflowMetrics: [
        {
          label: locale === "zh" ? "活跃工作流" : "Pending workflows",
          value: String(pendingWorkflowCount),
          detail:
            pendingWorkflowCount > 0
              ? locale === "zh"
                ? "统计 queued 与 running，包含已经在 Temporal 里等待 timer 的任务"
                : "Counts queued and running rows, including Temporal executions waiting on timers."
              : locale === "zh"
                ? "当前没有活跃的耐久工作流"
                : "No durable workflow jobs are currently active.",
        },
        {
          label: locale === "zh" ? "等待分发" : "Dispatch pending",
          value: String(dispatchPendingWorkflowCount),
          detail:
            dispatchPendingWorkflowCount > 0
              ? locale === "zh"
                ? "Postgres 已写入 START intent，等待 dispatcher 交给引擎"
                : "Postgres has START intent rows waiting for dispatcher delivery."
              : locale === "zh"
                ? "没有等待分发的 workflow command"
                : "No workflow commands are waiting for start dispatch.",
        },
        {
          label: locale === "zh" ? "Timer 等待中" : "Waiting on timer",
          value: String(waitingTimerWorkflowCount),
          detail:
            waitingTimerWorkflowCount > 0
              ? locale === "zh"
                ? "Temporal execution 已启动，正在等 scheduledAt"
                : "Temporal executions have started and are waiting for scheduledAt."
              : locale === "zh"
                ? "没有正在等待 timer 的 Temporal workflow"
                : "No Temporal workflows are currently sleeping on timers.",
        },
        {
          label: locale === "zh" ? "取消投递中" : "Cancel requested",
          value: String(cancelRequestedWorkflowCount),
          detail:
            cancelRequestedWorkflowCount > 0
              ? locale === "zh"
                ? "业务状态已取消，正在等待 Temporal cancel cleanup"
                : "Business state is canceled while Temporal cleanup is being delivered."
              : locale === "zh"
                ? "没有等待 cancel cleanup 的 workflow"
                : "No workflow cancellations are awaiting engine cleanup.",
        },
        {
          label: locale === "zh" ? "工作流引擎" : "Workflow engine",
          value: workflowEngine.effectiveEngine === "temporal" ? "temporal" : "local",
          detail:
            workflowEngine.configuredEngine === workflowEngine.effectiveEngine
              ? locale === "zh"
                ? `当前队列：${workflowEngine.effectiveEngine === "temporal" ? workflowEngine.temporalTaskQueue ?? "temporal" : workflowEngine.localQueueName}`
                : `Active queue: ${workflowEngine.effectiveEngine === "temporal" ? workflowEngine.temporalTaskQueue ?? "temporal" : workflowEngine.localQueueName}`
              : locale === "zh"
                ? `已从 ${workflowEngine.configuredEngine} 回退到本地 runner：${workflowEngine.fallbackReason ?? "fallback"}`
                : `Fell back from ${workflowEngine.configuredEngine} to local runner: ${workflowEngine.fallbackReason ?? "fallback"}`,
        },
        {
          label: locale === "zh" ? "失败工作流" : "Failed workflows",
          value: String(failedWorkflowCount),
          detail:
            failedWorkflowCount > 0
              ? locale === "zh"
                ? "需要检查失败原因并决定是否重试"
                : "Inspect failures and decide whether to retry."
              : locale === "zh"
                ? "最近没有 workflow 失败"
                : "No recent workflow failures.",
        },
      ],
      handoffRequests: representative.handoffRequests.map((handoff) => ({
        id: handoff.id,
        who: handoff.contact.displayName ?? handoff.contact.username ?? handoff.contact.telegramUserId,
        why: handoff.summary,
        score: mapPriorityToLabel(handoff.recommendedPriority),
        status: normalizeHandoffStatus(handoff.status),
        recommendedOwnerAction: handoff.recommendedOwnerAction,
        requestType: handoff.reason,
        isPaid: handoff.contact.isPaid,
        requestedAt: handoff.createdAt.toISOString(),
      })),
      recentInvoices: representative.invoices.map((invoice) => ({
        id: invoice.id,
        who: invoice.contact.displayName ?? invoice.contact.username ?? invoice.contact.telegramUserId,
        planName: invoice.title,
        planType: mapPricingPlanTypeFromDb(invoice.planType),
        starsAmount: invoice.starsAmount,
        status: mapInvoiceStatus(invoice.status),
        createdAt: invoice.createdAt.toISOString(),
        ...(invoice.paidAt ? { paidAt: invoice.paidAt.toISOString() } : {}),
        ...(invoice.invoiceLink ? { invoiceLink: invoice.invoiceLink } : {}),
      })),
      recentWorkflows: representative.workflowRuns.map((workflowRun) => ({
        id: workflowRun.id,
        kind: normalizeWorkflowKind(workflowRun.kind),
        engine: workflowRun.engine === "TEMPORAL" ? "temporal" : "local_runner",
        status: normalizeWorkflowStatus(workflowRun.status),
        ...(workflowRun.enginePhase ? { enginePhase: normalizeWorkflowEnginePhase(workflowRun.enginePhase) } : {}),
        scheduledAt: workflowRun.scheduledAt.toISOString(),
        ...(workflowRun.nextWakeAt ? { nextWakeAt: workflowRun.nextWakeAt.toISOString() } : {}),
        ...(workflowRun.externalWorkflowId ? { externalWorkflowId: workflowRun.externalWorkflowId } : {}),
        ...(workflowRun.externalRunId ? { externalRunId: workflowRun.externalRunId } : {}),
        ...(workflowRun.cancelRequestedAt ? { cancelRequestedAt: workflowRun.cancelRequestedAt.toISOString() } : {}),
        ...(workflowRun.completedAt ? { completedAt: workflowRun.completedAt.toISOString() } : {}),
        detail:
          typeof workflowRun.lastError === "string" && workflowRun.lastError.length > 0
            ? workflowRun.lastError
            : typeof workflowRun.output === "object" &&
                workflowRun.output &&
                "outcome" in workflowRun.output &&
                typeof workflowRun.output.outcome === "string"
              ? workflowRun.output.outcome
              : describeWorkflowRun(workflowRun.kind, locale),
      })),
    };
  } catch (error) {
    if (shouldUseDemoFallback(error, representativeSlug)) {
      return cloneDashboardOverviewSnapshot(getOrCreateDemoFallbackOverviewSnapshot(locale));
    }
    throw error;
  }
}

function normalizeWorkflowKind(
  value: RepresentativeOverviewRecord["workflowRuns"][number]["kind"],
): DashboardOverviewSnapshot["recentWorkflows"][number]["kind"] {
  switch (value) {
    case "HANDOFF_FOLLOW_UP":
      return "handoff_follow_up";
    case "CREATOR_TRAINING_REVIEW":
      return "creator_training_review";
    case "APPROVAL_EXPIRATION":
    default:
      return "approval_expiration";
  }
}

function describeWorkflowRun(
  value: RepresentativeOverviewRecord["workflowRuns"][number]["kind"],
  locale: "zh" | "en",
): string {
  switch (value) {
    case "HANDOFF_FOLLOW_UP":
      return locale === "zh" ? "等待 owner 跟进 handoff" : "Waiting for owner handoff follow-up.";
    case "CREATOR_TRAINING_REVIEW":
      return locale === "zh" ? "等待生成训练建议" : "Waiting to build training suggestions.";
    case "APPROVAL_EXPIRATION":
    default:
      return locale === "zh" ? "等待审批超时检查" : "Waiting for approval expiry check.";
  }
}

export async function setHandoffRequestStatus(params: {
  representativeSlug: string;
  handoffId: string;
  status: "open" | "reviewing" | "accepted" | "declined" | "closed";
}): Promise<DashboardOverviewSnapshot["handoffRequests"][number]> {
  if (shouldUseStaticFallbackMode(params.representativeSlug)) {
    return setDemoFallbackHandoffStatus(params.handoffId, params.status);
  }

  try {
    const handoff = await prisma.handoffRequest.findFirst({
      where: {
        id: params.handoffId,
        representative: {
          slug: params.representativeSlug,
        },
      },
      include: {
        contact: true,
      },
    });

    if (!handoff) {
      throw new Error("Handoff request not found.");
    }

    const updated = await prisma.$transaction(async (tx) => {
      const nextHandoff = await tx.handoffRequest.update({
        where: { id: handoff.id },
        data: {
          status: mapHandoffStatusToDb(params.status),
        },
        include: {
          contact: true,
        },
      });

      if (params.status === "accepted" || params.status === "declined" || params.status === "closed") {
        await cancelHandoffWorkflowsTx(tx, {
          handoffId: nextHandoff.id,
          resolvedAt: new Date(),
          outcome: "canceled_after_handoff_resolution",
        });
      }

      return nextHandoff;
    });

    await maybeStoreHandoffPatternFromStatusChange({
      representativeSlug: params.representativeSlug,
      handoffId: updated.id,
      nextStatus: params.status,
    });

    return {
      id: updated.id,
      who: updated.contact.displayName ?? updated.contact.username ?? updated.contact.telegramUserId,
      why: updated.summary,
      score: mapPriorityToLabel(updated.recommendedPriority),
      status: normalizeHandoffStatus(updated.status),
      recommendedOwnerAction: updated.recommendedOwnerAction,
      requestType: updated.reason,
      isPaid: updated.contact.isPaid,
      requestedAt: updated.createdAt.toISOString(),
    };
  } catch (error) {
    if (shouldUseDemoFallback(error, params.representativeSlug)) {
      return setDemoFallbackHandoffStatus(params.handoffId, params.status);
    }
    throw error;
  }
}

function getOrCreateDemoFallbackOverviewSnapshot(locale: "zh" | "en"): DashboardOverviewSnapshot {
  if (!demoFallbackOverviewSnapshot) {
    const now = new Date();
    const hoursAgo = (value: number) => new Date(now.getTime() - value * 60 * 60 * 1000).toISOString();

    demoFallbackOverviewSnapshot = {
      representative: {
        slug: demoRepresentative.slug,
        displayName: demoRepresentative.name,
        roleSummary: demoRepresentative.tagline,
      },
      metrics: [],
      wallet: {
        starsBalance: 2060,
        sponsorPoolCredit: 1200,
        balanceCredits: 240,
      },
      openVikingMetrics: [],
      workflowEngine: {
        configured: "local_runner",
        effective: "local_runner",
        temporalReady: false,
        queueName: "local:workflow-runner",
      },
      workflowMetrics: [],
      handoffRequests: [
        {
          id: "demo-handoff-acme",
          who: "Acme AI",
          why: "想谈一周内启动的自动化合作，预算已说明。",
          score: "High",
          status: "open",
          recommendedOwnerAction: "Review budget and decide whether to accept a founder call.",
          requestType: "collaboration",
          isPaid: true,
          requestedAt: hoursAgo(2),
        },
        {
          id: "demo-handoff-creator",
          who: "Creator Podcast",
          why: "媒体采访请求，需要 founder 本人确认档期。",
          score: "Medium",
          status: "reviewing",
          recommendedOwnerAction: "Confirm availability for a podcast recording slot.",
          requestType: "media",
          isPaid: false,
          requestedAt: hoursAgo(5),
        },
        {
          id: "demo-handoff-refund",
          who: "匿名用户",
          why: "要求退款，触发 ask-first 规则。",
          score: "High",
          status: "open",
          recommendedOwnerAction: "Approve or decline refund before sending a human response.",
          requestType: "refund",
          isPaid: true,
          requestedAt: hoursAgo(6),
        },
      ],
      recentInvoices: [
        {
          id: "demo-invoice-pass",
          who: "Acme AI",
          planName: "Pass",
          planType: "pass",
          starsAmount: 180,
          status: "paid",
          createdAt: hoursAgo(13),
          paidAt: hoursAgo(12),
          invoiceLink: "https://t.me/invoice/acme-pass",
        },
        {
          id: "demo-invoice-deep-help",
          who: "匿名用户",
          planName: "Deep Help",
          planType: "deep_help",
          starsAmount: 680,
          status: "paid",
          createdAt: hoursAgo(21),
          paidAt: hoursAgo(20),
          invoiceLink: "https://t.me/invoice/refund-deep-help",
        },
        {
          id: "demo-invoice-sponsor",
          who: "Community Angel",
          planName: "Sponsor",
          planType: "sponsor",
          starsAmount: 1200,
          status: "fulfilled",
          createdAt: hoursAgo(2),
          paidAt: hoursAgo(1),
          invoiceLink: "https://t.me/invoice/sponsor-pool",
        },
      ],
      recentWorkflows: [
        {
          id: "demo-workflow-handoff",
          kind: "handoff_follow_up",
          engine: "local_runner",
          status: "queued",
          enginePhase: "dispatch_pending",
          scheduledAt: hoursAgo(-18),
          nextWakeAt: hoursAgo(-18),
          detail: "owner_follow_up_due",
        },
        {
          id: "demo-workflow-approval",
          kind: "approval_expiration",
          engine: "local_runner",
          status: "completed",
          enginePhase: "completed",
          scheduledAt: hoursAgo(3),
          completedAt: hoursAgo(2.5),
          detail: "approval_expired",
        },
      ],
    };
  }

  demoFallbackOverviewSnapshot.representative.roleSummary =
    locale === "zh"
      ? demoRepresentative.tagline
      : "Answers public questions, qualifies demand, collects intake, and hands off when needed.";
  demoFallbackOverviewSnapshot.handoffRequests = [
    {
      id: "demo-handoff-acme",
      who: "Acme AI",
      why:
        locale === "zh"
          ? "想谈一周内启动的自动化合作，预算已说明。"
          : "Wants to discuss an automation engagement starting within a week and already shared budget.",
      score: "High",
      status: "open",
      recommendedOwnerAction:
        locale === "zh"
          ? "查看预算并决定是否安排 founder 通话。"
          : "Review the budget and decide whether to accept a founder call.",
      requestType: "collaboration",
      isPaid: true,
      requestedAt: demoFallbackOverviewSnapshot.handoffRequests[0]?.requestedAt ?? new Date().toISOString(),
    },
    {
      id: "demo-handoff-creator",
      who: "Creator Podcast",
      why:
        locale === "zh"
          ? "媒体采访请求，需要 founder 本人确认档期。"
          : "Media interview request that needs founder approval for scheduling.",
      score: "Medium",
      status: "reviewing",
      recommendedOwnerAction:
        locale === "zh"
          ? "确认是否有播客录制档期。"
          : "Confirm whether there is a viable podcast recording slot.",
      requestType: "media",
      isPaid: false,
      requestedAt: demoFallbackOverviewSnapshot.handoffRequests[1]?.requestedAt ?? new Date().toISOString(),
    },
    {
      id: "demo-handoff-refund",
      who: locale === "zh" ? "匿名用户" : "Anonymous user",
      why:
        locale === "zh"
          ? "要求退款，触发 ask-first 规则。"
          : "Asked for a refund and triggered the ask-first policy.",
      score: "High",
      status: "open",
      recommendedOwnerAction:
        locale === "zh"
          ? "先决定是否退款，再发人工回复。"
          : "Approve or decline the refund before sending a human response.",
      requestType: "refund",
      isPaid: true,
      requestedAt: demoFallbackOverviewSnapshot.handoffRequests[2]?.requestedAt ?? new Date().toISOString(),
    },
  ];
  demoFallbackOverviewSnapshot.recentInvoices = [
    {
      id: "demo-invoice-pass",
      who: "Acme AI",
      planName: "Pass",
      planType: "pass",
      starsAmount: 180,
      status: "paid",
      createdAt: demoFallbackOverviewSnapshot.recentInvoices[0]?.createdAt ?? new Date().toISOString(),
      ...(demoFallbackOverviewSnapshot.recentInvoices[0]?.paidAt
        ? { paidAt: demoFallbackOverviewSnapshot.recentInvoices[0].paidAt }
        : {}),
      invoiceLink: "https://t.me/invoice/acme-pass",
    },
    {
      id: "demo-invoice-deep-help",
      who: locale === "zh" ? "匿名用户" : "Anonymous user",
      planName: "Deep Help",
      planType: "deep_help",
      starsAmount: 680,
      status: "paid",
      createdAt: demoFallbackOverviewSnapshot.recentInvoices[1]?.createdAt ?? new Date().toISOString(),
      ...(demoFallbackOverviewSnapshot.recentInvoices[1]?.paidAt
        ? { paidAt: demoFallbackOverviewSnapshot.recentInvoices[1].paidAt }
        : {}),
      invoiceLink: "https://t.me/invoice/refund-deep-help",
    },
    {
      id: "demo-invoice-sponsor",
      who: "Community Angel",
      planName: "Sponsor",
      planType: "sponsor",
      starsAmount: 1200,
      status: "fulfilled",
      createdAt: demoFallbackOverviewSnapshot.recentInvoices[2]?.createdAt ?? new Date().toISOString(),
      ...(demoFallbackOverviewSnapshot.recentInvoices[2]?.paidAt
        ? { paidAt: demoFallbackOverviewSnapshot.recentInvoices[2].paidAt }
        : {}),
      invoiceLink: "https://t.me/invoice/sponsor-pool",
    },
  ];

  demoFallbackOverviewSnapshot.metrics =
    locale === "zh"
      ? [
          { label: "今日新会话", value: "4", detail: "1 个来自群组 mention，3 个来自私聊" },
          { label: "已确认付费", value: "3", detail: "1 Pass，1 Deep Help，1 Sponsor" },
          { label: "待人工评估", value: "3", detail: "2 个合作，1 个退款" },
          { label: "Stars 余额", value: "2060", detail: "sponsor pool 1200 · credits 240" },
        ]
      : [
          { label: "New conversations", value: "4", detail: "1 from group mentions, 3 from private chat" },
          { label: "Confirmed payments", value: "3", detail: "1 Pass, 1 Deep Help, 1 Sponsor" },
          { label: "Pending owner review", value: "3", detail: "2 collaboration requests, 1 refund" },
          { label: "Stars balance", value: "2060", detail: "sponsor pool 1200 · credits 240" },
        ];
  demoFallbackOverviewSnapshot.openVikingMetrics =
    locale === "zh"
      ? [
          { label: "OpenViking resources", value: "5", detail: "最近一次公开知识同步写入了 5 份资源" },
          { label: "Memories today", value: "3", detail: "今天写入了 3 条公开安全记忆摘要" },
          { label: "Commits today", value: "4", detail: "今天完成了 4 次 session commit" },
          { label: "Recalls today", value: "9", detail: "今天有 9 次 recall 被注入回复链路" },
          { label: "Sync failures", value: "0", detail: "当前 demo 没有失败的 sync job" },
          { label: "Health", value: "healthy", detail: "OpenViking demo health check 正常" },
        ]
      : [
          { label: "OpenViking resources", value: "5", detail: "5 public resources were written in the latest sync." },
          { label: "Memories today", value: "3", detail: "3 public-safe memory summaries were captured today." },
          { label: "Commits today", value: "4", detail: "4 session commits completed today." },
          { label: "Recalls today", value: "9", detail: "9 recalls were injected into response flow today." },
          { label: "Sync failures", value: "0", detail: "There are no failed sync jobs in the demo right now." },
          { label: "Health", value: "healthy", detail: "OpenViking demo health check is healthy." },
        ];
  demoFallbackOverviewSnapshot.workflowMetrics =
    locale === "zh"
      ? [
          { label: "活跃工作流", value: "1", detail: "还有 1 条 handoff 跟进任务处于 active 状态" },
          { label: "等待分发", value: "1", detail: "demo 中有 1 条 workflow 等待 runner 分发" },
          { label: "Timer 等待中", value: "0", detail: "demo 当前没有 Temporal timer 正在等待" },
          { label: "取消投递中", value: "0", detail: "demo 当前没有 cancel cleanup" },
          { label: "工作流引擎", value: "local", detail: "当前使用内置 workflow runner 队列" },
          { label: "失败工作流", value: "0", detail: "最近没有 workflow 失败" },
        ]
      : [
          { label: "Pending workflows", value: "1", detail: "1 handoff follow-up job is active." },
          { label: "Dispatch pending", value: "1", detail: "1 demo workflow is waiting for runner dispatch." },
          { label: "Waiting on timer", value: "0", detail: "No demo Temporal timer is currently sleeping." },
          { label: "Cancel requested", value: "0", detail: "No demo workflow cancel cleanup is pending." },
          { label: "Workflow engine", value: "local", detail: "Currently using the built-in workflow runner queue." },
          { label: "Failed workflows", value: "0", detail: "No recent workflow failures." },
        ];
  demoFallbackOverviewSnapshot.recentWorkflows = [
    {
      id: "demo-workflow-handoff",
      kind: "handoff_follow_up",
      engine: "local_runner",
      status: "queued",
      enginePhase: "dispatch_pending",
      scheduledAt:
        demoFallbackOverviewSnapshot.recentWorkflows[0]?.scheduledAt ?? new Date().toISOString(),
      nextWakeAt:
        demoFallbackOverviewSnapshot.recentWorkflows[0]?.nextWakeAt ?? new Date().toISOString(),
      detail: "owner_follow_up_due",
    },
    {
      id: "demo-workflow-approval",
      kind: "approval_expiration",
      engine: "local_runner",
      status: "completed",
      enginePhase: "completed",
      scheduledAt:
        demoFallbackOverviewSnapshot.recentWorkflows[1]?.scheduledAt ?? new Date().toISOString(),
      completedAt:
        demoFallbackOverviewSnapshot.recentWorkflows[1]?.completedAt ?? new Date().toISOString(),
      detail: "approval_expired",
    },
  ];

  return demoFallbackOverviewSnapshot;
}

function setDemoFallbackHandoffStatus(
  handoffId: string,
  status: DashboardOverviewSnapshot["handoffRequests"][number]["status"],
): DashboardOverviewSnapshot["handoffRequests"][number] {
  const snapshot = getOrCreateDemoFallbackOverviewSnapshot("zh");
  const handoff = snapshot.handoffRequests.find((entry) => entry.id === handoffId);

  if (!handoff) {
    throw new Error("Handoff request not found.");
  }

  handoff.status = status;
  return { ...handoff };
}

function cloneDashboardOverviewSnapshot(
  snapshot: DashboardOverviewSnapshot,
): DashboardOverviewSnapshot {
  return {
    representative: { ...snapshot.representative },
    metrics: snapshot.metrics.map((metric) => ({ ...metric })),
    wallet: { ...snapshot.wallet },
    openVikingMetrics: snapshot.openVikingMetrics.map((metric) => ({ ...metric })),
    workflowEngine: { ...snapshot.workflowEngine },
    handoffRequests: snapshot.handoffRequests.map((request) => ({ ...request })),
    recentInvoices: snapshot.recentInvoices.map((invoice) => ({ ...invoice })),
    workflowMetrics: snapshot.workflowMetrics.map((metric) => ({ ...metric })),
    recentWorkflows: snapshot.recentWorkflows.map((workflow) => ({ ...workflow })),
  };
}

function buildPaidBreakdown(
  invoices: RepresentativeOverviewRecord["invoices"],
): string {
  const relevant = invoices.filter((invoice) =>
    invoice.status === InvoiceStatus.PAID || invoice.status === InvoiceStatus.FULFILLED,
  );

  if (relevant.length === 0) {
    return "";
  }

  const counts = new Map<PricingPlanType, number>();
  for (const invoice of relevant) {
    counts.set(invoice.planType, (counts.get(invoice.planType) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([planType, count]) => `${count} ${mapPricingPlanTypeFromDb(planType)}`)
    .join("，");
}

function mapPriorityToLabel(value: number): "High" | "Medium" | "Low" {
  if (value >= 85) {
    return "High";
  }
  if (value >= 60) {
    return "Medium";
  }
  return "Low";
}

async function cancelHandoffWorkflowsTx(
  tx: Prisma.TransactionClient,
  params: {
    handoffId: string;
    resolvedAt: Date;
    outcome: string;
  },
) {
  const workflows = await tx.workflowRun.findMany({
    where: {
      handoffRequestId: params.handoffId,
      status: {
        in: ["QUEUED", "RUNNING"],
      },
    },
    select: {
      id: true,
      engine: true,
      externalWorkflowId: true,
    },
  });

  for (const workflow of workflows) {
    const needsTemporalCancel =
      workflow.engine === "TEMPORAL" && Boolean(workflow.externalWorkflowId);

    await tx.workflowRun.update({
      where: { id: workflow.id },
      data: {
        status: "CANCELED",
        enginePhase: needsTemporalCancel ? "CANCEL_REQUESTED" : "CANCELED",
        nextWakeAt: null,
        completedAt: params.resolvedAt,
        cancelRequestedAt: params.resolvedAt,
        lastObservedAt: params.resolvedAt,
        lastEngineError: null,
        output: {
          outcome: params.outcome,
        },
      },
    });

    if (needsTemporalCancel) {
      await tx.workflowCommandOutbox.create({
        data: {
          workflowRunId: workflow.id,
          commandType: "CANCEL",
          payload: {
            source: params.outcome,
            requestedAt: params.resolvedAt.toISOString(),
          },
        },
      });
    }
  }
}

function normalizeHandoffStatus(
  value: HandoffStatus,
): DashboardOverviewSnapshot["handoffRequests"][number]["status"] {
  switch (value) {
    case HandoffStatus.REVIEWING:
      return "reviewing";
    case HandoffStatus.ACCEPTED:
      return "accepted";
    case HandoffStatus.DECLINED:
      return "declined";
    case HandoffStatus.CLOSED:
      return "closed";
    case HandoffStatus.OPEN:
    default:
      return "open";
  }
}

function normalizeWorkflowStatus(
  value: RepresentativeOverviewRecord["workflowRuns"][number]["status"],
): DashboardOverviewSnapshot["recentWorkflows"][number]["status"] {
  switch (value) {
    case "RUNNING":
      return "running";
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELED":
      return "canceled";
    default:
      return "queued";
  }
}

function normalizeWorkflowEnginePhase(
  value: NonNullable<RepresentativeOverviewRecord["workflowRuns"][number]["enginePhase"]>,
): NonNullable<DashboardOverviewSnapshot["recentWorkflows"][number]["enginePhase"]> {
  switch (value) {
    case "WAITING_TIMER":
      return "waiting_timer";
    case "ACTIVITY_RUNNING":
      return "activity_running";
    case "RETRY_BACKOFF":
      return "retry_backoff";
    case "CANCEL_REQUESTED":
      return "cancel_requested";
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELED":
      return "canceled";
    case "DISPATCH_PENDING":
    default:
      return "dispatch_pending";
  }
}

function mapHandoffStatusToDb(
  value: DashboardOverviewSnapshot["handoffRequests"][number]["status"],
): HandoffStatus {
  switch (value) {
    case "reviewing":
      return HandoffStatus.REVIEWING;
    case "accepted":
      return HandoffStatus.ACCEPTED;
    case "declined":
      return HandoffStatus.DECLINED;
    case "closed":
      return HandoffStatus.CLOSED;
    case "open":
    default:
      return HandoffStatus.OPEN;
  }
}

function mapPricingPlanTypeFromDb(
  value: PricingPlanType,
): DashboardOverviewSnapshot["recentInvoices"][number]["planType"] {
  switch (value) {
    case PricingPlanType.PASS:
      return "pass";
    case PricingPlanType.DEEP_HELP:
      return "deep_help";
    case PricingPlanType.SPONSOR:
      return "sponsor";
    case PricingPlanType.FREE:
    default:
      return "free";
  }
}

function mapInvoiceStatus(
  value: InvoiceStatus,
): DashboardOverviewSnapshot["recentInvoices"][number]["status"] {
  switch (value) {
    case InvoiceStatus.PAID:
      return "paid";
    case InvoiceStatus.FULFILLED:
      return "fulfilled";
    case InvoiceStatus.REFUNDED:
      return "refunded";
    case InvoiceStatus.FAILED:
      return "failed";
    case InvoiceStatus.CANCELED:
      return "canceled";
    case InvoiceStatus.PENDING:
    default:
      return "pending";
  }
}

function shouldUseDemoFallback(error: unknown, representativeSlug: string): boolean {
  return representativeSlug === demoRepresentative.slug && isPrismaUnavailableError(error);
}

function shouldUseStaticFallbackMode(representativeSlug: string): boolean {
  return representativeSlug === demoRepresentative.slug && !process.env.DATABASE_URL?.trim();
}

function isPrismaUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Can't reach database server") ||
    error.message.includes("Environment variable not found: DATABASE_URL") ||
    error.message.includes("P1001")
  );
}

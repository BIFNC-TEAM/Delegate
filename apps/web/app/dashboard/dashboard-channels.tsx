"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ManagedChannelBinding,
  OwnerChannelManagementSnapshot,
} from "@delegate/web-data";
import type { Locale } from "@delegate/web-ui";

type ChannelRow = {
  representativeId: string;
  representativeSlug: string;
  representativeName: string;
  lifecycleState: string;
  isActiveRepresentative: boolean;
  channel: ManagedChannelBinding;
};

export function DashboardChannels({
  activeSlug,
  locale,
}: {
  activeSlug: string;
  locale: Locale;
}) {
  const zh = locale === "zh";
  const [snapshot, setSnapshot] = useState<OwnerChannelManagementSnapshot | null>(null);
  const [selectedRepresentative, setSelectedRepresentative] = useState("all");
  const [loading, setLoading] = useState(true);
  const [settled, setSettled] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);

  const loadChannels = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++requestSequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/dashboard/channels", {
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(await extractError(response));
      const nextSnapshot = (await response.json()) as OwnerChannelManagementSnapshot;
      if (signal?.aborted || requestSequenceRef.current !== requestId) return;
      setSnapshot(nextSnapshot);
      setSettled(true);
    } catch (nextError) {
      if (signal?.aborted || requestSequenceRef.current !== requestId) return;
      setSettled(true);
      setError(
        nextError instanceof Error
          ? nextError.message
          : zh
            ? "渠道状态加载失败。"
            : "Failed to load channel status.",
      );
    } finally {
      if (!signal?.aborted && requestSequenceRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [zh]);

  useEffect(() => {
    const controller = new AbortController();
    void loadChannels(controller.signal);
    return () => controller.abort();
  }, [loadChannels]);

  const rows = useMemo(() => {
    const flattened = (snapshot?.representatives ?? []).flatMap((representative) =>
      representative.channels.map((channel) => ({
        representativeId: representative.id,
        representativeSlug: representative.slug,
        representativeName: representative.name,
        lifecycleState: representative.lifecycleState,
        isActiveRepresentative: representative.slug === activeSlug,
        channel,
      })),
    );
    return selectedRepresentative === "all"
      ? flattened
      : flattened.filter((row) => row.representativeSlug === selectedRepresentative);
  }, [activeSlug, selectedRepresentative, snapshot]);

  async function performAction(
    row: ChannelRow,
    action: "connect" | "pause" | "resume" | "health",
  ) {
    const bindingId = row.channel.bindingId;
    const canProvisionChannel =
      action === "connect"
      && !bindingId
      && (
        row.channel.kind === "MATRIX"
        || row.channel.kind === "TELEGRAM"
      );
    if (
      snapshot?.dataSource !== "database"
      || (!bindingId && !canProvisionChannel)
    ) return;
    const actionKey = bindingId
      ? `${bindingId}:${action}`
      : `${row.representativeId}:${row.channel.kind}:connect`;
    const requestId = createRequestId();
    setBusyKey(actionKey);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        action === "connect"
          ? "/api/dashboard/channels"
          : action === "health"
          ? `/api/dashboard/channels/${encodeURIComponent(bindingId!)}/health`
          : `/api/dashboard/channels/${encodeURIComponent(bindingId!)}`,
        {
          method: action === "health" || action === "connect" ? "POST" : "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": requestId,
            "X-Request-Id": requestId,
          },
          ...(action === "health"
            ? {}
            : action === "connect"
              ? {
                  body: JSON.stringify({
                    channel: row.channel.kind,
                    representativeId: row.representativeId,
                  }),
                }
            : {
                body: JSON.stringify({
                  desiredState: action === "pause" ? "PAUSED" : "ACTIVE",
                }),
              }),
        },
      );
      if (!response.ok) throw new Error(await extractError(response));
      setNotice(
        action === "connect"
            ? row.channel.kind === "TELEGRAM"
              ? zh
              ? `${row.representativeName} 已启用部署级共享 Telegram Bot；访客现在可在公开代表页绑定自己的 Telegram 账号。`
              : `${row.representativeName} now uses the deployment-wide shared Telegram Bot; visitors can link their Telegram accounts from the public representative page.`
            : zh
              ? `${row.representativeName} 的 Matrix 受管用户已创建；现在可从 Matrix 客户端邀请该 MXID。`
              : `Managed Matrix user created for ${row.representativeName}; invite the MXID from a Matrix client.`
          : action === "health"
          ? zh
            ? `${row.representativeName} 的${channelLabel(row.channel, locale)}健康状态已刷新。`
            : `${channelLabel(row.channel, locale)} health refreshed for ${row.representativeName}.`
          : action === "pause"
            ? zh
              ? `${row.representativeName} 的${channelLabel(row.channel, locale)}已暂停。`
              : `${channelLabel(row.channel, locale)} paused for ${row.representativeName}.`
            : zh
              ? `${row.representativeName} 的${channelLabel(row.channel, locale)}已恢复。`
              : `${channelLabel(row.channel, locale)} resumed for ${row.representativeName}.`,
      );
      await loadChannels();
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : zh
            ? "渠道操作失败。"
            : "Channel action failed.",
      );
    } finally {
      setBusyKey(null);
    }
  }

  const initialLoading = !settled;

  return (
    <>
      <header className="dashboard-v2-page-header channels-page-header">
        <div>
          <p>CHANNELS / 09</p>
          <h1>
            {zh
              ? "清楚看到每个来源渠道、实际传输路径与运行证据。"
              : "See every source channel, transport path, and operating signal clearly."}
          </h1>
          <span>
            {zh
              ? "Web、Matrix 与 Telegram 始终按来源分别呈现。Telegram 当前通过部署级共享 Bot 启用，但每个数字代表仍有独立绑定、会话和运行状态；经 Matrix 传输时会明确标注。"
              : "Web, Matrix, and Telegram remain distinct sources. Telegram currently uses one deployment-wide shared Bot, while every representative keeps an independent binding, conversation history, and operating state; Matrix transport is labeled explicitly."}
          </span>
        </div>
        <div className="dashboard-v2-page-actions">
          <button
            className="dashboard-v2-button-secondary"
            disabled={loading || Boolean(busyKey)}
            onClick={() => void loadChannels()}
            type="button"
          >
            {loading && !initialLoading
              ? zh
                ? "刷新中…"
                : "Refreshing…"
              : zh
                ? "刷新全部状态"
                : "Refresh all status"}
          </button>
        </div>
      </header>

      <div
        aria-busy={initialLoading || loading || Boolean(busyKey)}
        className="dashboard-module-content channels-module"
      >
        {error && !initialLoading ? (
          <div className="skills-banner is-error" role="alert">
            <span>{error}</span>
            <button
              className="dashboard-v2-button-secondary"
              disabled={loading || Boolean(busyKey)}
              onClick={() => void loadChannels()}
              type="button"
            >
              {zh ? "重试" : "Retry"}
            </button>
          </div>
        ) : null}
        {notice ? (
          <div className="channels-notice" role="status">
            <span>{notice}</span>
            <button
              aria-label={zh ? "关闭提示" : "Dismiss notice"}
              onClick={() => setNotice(null)}
              type="button"
            >
              ×
            </button>
          </div>
        ) : null}

        {initialLoading ? (
          <section
            aria-live="polite"
            className="dashboard-v2-panel skills-loading"
            role="status"
          >
            <p>{zh ? "正在读取工作区渠道绑定…" : "Loading workspace channel bindings…"}</p>
          </section>
        ) : (
          <>
            {snapshot?.dataSource === "demo-empty" ? (
              <div className="channels-demo-note" role="note">
                <strong>{zh ? "未连接数据库" : "Database not connected"}</strong>
                <span>
                  {zh
                    ? "这里只呈现真实的空状态；连接数据库并创建渠道绑定后才能执行暂停、恢复和健康检查。"
                    : "This is an honest empty state. Connect the database and create bindings before running channel actions."}
                </span>
              </div>
            ) : null}

            <section className="dashboard-v2-metric-grid channels-metrics">
              <ChannelMetric
                detail={zh ? "当前 Owner 的全部代表" : "All representatives owned by this account"}
                label={zh ? "数字代表" : "Representatives"}
                tone="teal"
                value={snapshot?.metrics.representatives ?? 0}
              />
              <ChannelMetric
                detail={zh ? "存在持久化绑定且未断开" : "Persisted bindings not marked disconnected"}
                label={zh ? "已连接绑定" : "Connected bindings"}
                value={snapshot?.metrics.connectedBindings ?? 0}
              />
              <ChannelMetric
                detail={zh ? "实时策略阻止新的渠道处理" : "Live policy blocks new channel handling"}
                label={zh ? "已暂停" : "Paused"}
                tone="indigo"
                value={snapshot?.metrics.pausedBindings ?? 0}
              />
              <ChannelMetric
                detail={zh ? "降级、不健康或存在最近错误" : "Degraded, unhealthy, or reporting an error"}
                label={zh ? "需要处理" : "Needs attention"}
                tone="warning"
                value={snapshot?.metrics.attentionBindings ?? 0}
              />
            </section>

            <section className="dashboard-v2-panel channels-table-panel">
              <header>
                <div>
                  <p>{zh ? "来源绑定" : "SOURCE BINDINGS"}</p>
                  <h2>{zh ? "渠道运行状态" : "Channel operations"}</h2>
                </div>
                <label className="channels-representative-filter">
                  <span>{zh ? "代表" : "Representative"}</span>
                  <select
                    onChange={(event) => setSelectedRepresentative(event.target.value)}
                    value={selectedRepresentative}
                  >
                    <option value="all">{zh ? "全部代表" : "All representatives"}</option>
                    {snapshot?.representatives.map((representative) => (
                      <option key={representative.id} value={representative.slug}>
                        {representative.name}
                      </option>
                    ))}
                  </select>
                </label>
              </header>
              <p className="dashboard-v2-panel-description">
                {zh
                  ? "健康刷新检查绑定配置和最近 24 小时的持久化收发记录；它不会伪装成外部服务实时探测。暂停与恢复会立即写入实时渠道策略并保留审计记录。"
                  : "Health refresh checks binding configuration and persisted delivery history from the last 24 hours; it does not pretend to be a live provider probe. Pause and resume update live channel policy and are audited."}
              </p>

              <div className="dashboard-v2-table-scroll">
                <table className="dashboard-v2-table channels-table">
                  <thead>
                    <tr>
                      <th>{zh ? "数字代表" : "Representative"}</th>
                      <th>{zh ? "来源 / 传输" : "Source / transport"}</th>
                      <th>{zh ? "期望状态" : "Desired state"}</th>
                      <th>{zh ? "健康 / 旧状态" : "Health / legacy"}</th>
                      <th>{zh ? "外部身份" : "External identity"}</th>
                      <th>{zh ? "最近收发" : "Recent ingress / egress"}</th>
                      <th>{zh ? "操作" : "Actions"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <ChannelTableRow
                        busyKey={busyKey}
                        key={`${row.representativeId}:${row.channel.kind}`}
                        locale={locale}
                        onAction={(action) => void performAction(row, action)}
                        readOnly={snapshot?.dataSource !== "database"}
                        row={row}
                      />
                    ))}
                    {!rows.length ? (
                      <tr>
                        <td className="channels-empty-cell" colSpan={7}>
                          {zh
                            ? "当前筛选范围内没有数字代表。"
                            : "No representatives match the current filter."}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              <footer className="channels-table-footer">
                <span>
                  {zh
                    ? `${rows.length} 条来源状态 · 最近刷新 ${formatTimestamp(snapshot?.generatedAt ?? null, locale)}`
                    : `${rows.length} source states · refreshed ${formatTimestamp(snapshot?.generatedAt ?? null, locale)}`}
                </span>
                <span>
                  {zh
                    ? "状态均使用文字表达，颜色仅用于辅助扫描。"
                    : "Every status is written in text; color only supports scanning."}
                </span>
              </footer>
            </section>
          </>
        )}
      </div>
    </>
  );
}

function ChannelTableRow({
  busyKey,
  locale,
  onAction,
  readOnly,
  row,
}: {
  busyKey: string | null;
  locale: Locale;
  onAction: (action: "connect" | "pause" | "resume" | "health") => void;
  readOnly: boolean;
  row: ChannelRow;
}) {
  const zh = locale === "zh";
  const channel = row.channel;
  const stateAction = channel.desiredState === "ACTIVE" ? "pause" : "resume";
  const stateBusy = busyKey === `${channel.bindingId}:${stateAction}`;
  const healthBusy = busyKey === `${channel.bindingId}:health`;
  const unavailable = !channel.bindingId || readOnly;
  const connectBusy =
    busyKey === `${row.representativeId}:${channel.kind}:connect`;
  const canProvisionChannel =
    !readOnly
    && !channel.bindingId
    && (
      channel.kind === "MATRIX"
      || channel.kind === "TELEGRAM"
    );
  const usesSharedTelegramBot =
    Boolean(channel.bindingId)
    && channel.kind === "TELEGRAM"
    && channel.sourceProvider === "TELEGRAM"
    && channel.transport === "TELEGRAM";

  return (
    <tr className={row.isActiveRepresentative ? "is-active-representative" : undefined}>
      <td>
        <span className="channels-representative">
          <i>{row.representativeName.slice(0, 1).toUpperCase()}</i>
          <span>
            <strong>{row.representativeName}</strong>
            <small>
              {row.representativeSlug} · {lifecycleLabel(row.lifecycleState, locale)}
              {row.isActiveRepresentative ? ` · ${zh ? "当前代表" : "current"}` : ""}
            </small>
          </span>
        </span>
      </td>
      <td>
        <span className="channels-route">
          <strong>{channelLabel(channel, locale)}</strong>
          <small>
            {zh ? "来源" : "Source"} {channel.sourceProvider}
            {" · "}
            {zh ? "传输" : "Transport"} {channel.transport}
          </small>
        </span>
      </td>
      <td>
        <StatusChip kind="desired" locale={locale} value={channel.desiredState} />
      </td>
      <td>
        <span className="channels-health-stack">
          <StatusChip kind="health" locale={locale} value={channel.healthStatus} />
          <small>
            {zh ? "旧状态" : "Legacy"} · {channel.legacyStatus ?? "—"}
          </small>
          <small>
            {zh ? "检查" : "Checked"} · {formatTimestamp(channel.lastHealthCheckAt, locale)}
          </small>
          {channel.lastError ? <em title={channel.lastError}>{channel.lastError}</em> : null}
        </span>
      </td>
      <td>
        <span className="channels-external-identity">
          <strong>
            {usesSharedTelegramBot
              ? zh
                ? "共享 Bot 已启用"
                : "Shared Bot enabled"
              : channel.externalIdentity.displayName ?? (zh ? "未命名" : "Unnamed")}
          </strong>
          <small title={channel.externalIdentity.id ?? undefined}>
            {channel.externalIdentity.id ?? (zh ? "未配置外部身份" : "No external identity")}
          </small>
        </span>
      </td>
      <td>
        <span className="channels-activity">
          <ChannelActivity
            activity={channel.recentIngress}
            direction="Ingress"
            locale={locale}
          />
          <ChannelActivity
            activity={channel.recentEgress}
            direction="Egress"
            locale={locale}
          />
        </span>
      </td>
      <td>
        <span className="channels-actions">
          {canProvisionChannel ? (
            <button
              className="dashboard-v2-button-secondary"
              disabled={Boolean(busyKey)}
              onClick={() => onAction("connect")}
              type="button"
            >
              {connectBusy
                ? zh
                  ? "创建中…"
                  : "Creating…"
                : zh
                  ? channel.kind === "TELEGRAM"
                    ? "启用共享 Telegram Bot"
                    : "创建 Matrix 用户"
                  : channel.kind === "TELEGRAM"
                    ? "Enable shared Telegram Bot"
                    : "Create Matrix user"}
            </button>
          ) : null}
          <button
            className="dashboard-v2-button-secondary"
            disabled={unavailable || Boolean(busyKey)}
            onClick={() => onAction(stateAction)}
            type="button"
          >
            {stateBusy
              ? zh
                ? "处理中…"
                : "Working…"
              : stateAction === "resume"
                ? zh
                  ? "恢复"
                  : "Resume"
                : zh
                  ? "暂停"
                  : "Pause"}
          </button>
          <button
            className="dashboard-v2-button-secondary"
            disabled={unavailable || Boolean(busyKey)}
            onClick={() => onAction("health")}
            type="button"
          >
            {healthBusy
              ? zh
                ? "检查中…"
                : "Checking…"
              : zh
                ? "刷新健康"
                : "Refresh health"}
          </button>
          {!channel.bindingId && !canProvisionChannel ? (
            <small>{zh ? "尚未创建绑定" : "Binding not created"}</small>
          ) : null}
          {usesSharedTelegramBot ? (
            <small>
              {zh
                ? "当前代表独立绑定到部署级共享 Bot"
                : "This representative has its own binding to the deployment-wide shared Bot"}
            </small>
          ) : null}
        </span>
      </td>
    </tr>
  );
}

function ChannelActivity({
  activity,
  direction,
  locale,
}: {
  activity: ManagedChannelBinding["recentIngress"];
  direction: "Ingress" | "Egress";
  locale: Locale;
}) {
  const zh = locale === "zh";
  if (!activity) {
    return (
      <span>
        <strong>{direction}</strong>
        <small>{zh ? "暂无持久化事件" : "No persisted event"}</small>
      </span>
    );
  }
  return (
    <span>
      <strong>
        {direction} · {activity.eventType}
      </strong>
      <small>
        {activity.status} · {formatTimestamp(activity.occurredAt, locale)}
      </small>
      {activity.error ? <em title={activity.error}>{activity.error}</em> : null}
    </span>
  );
}

function StatusChip({
  kind,
  locale,
  value,
}: {
  kind: "desired" | "health";
  locale: Locale;
  value: string;
}) {
  return (
    <span className={`channels-status is-${value.toLowerCase()}`}>
      {kind === "desired"
        ? desiredStateLabel(value, locale)
        : healthStatusLabel(value, locale)}
    </span>
  );
}

function ChannelMetric({
  detail,
  label,
  tone = "neutral",
  value,
}: {
  detail: string;
  label: string;
  tone?: "neutral" | "teal" | "indigo" | "warning";
  value: number;
}) {
  return (
    <article className={`dashboard-v2-metric-card is-${tone}`}>
      <div>
        <span>{label}</span>
        <i />
      </div>
      <strong>{String(value).padStart(2, "0")}</strong>
      <p>{detail}</p>
    </article>
  );
}

function channelLabel(channel: ManagedChannelBinding, locale: Locale) {
  const zh = locale === "zh";
  if (channel.sourceProvider === "TELEGRAM" && channel.routedViaMatrix) {
    return zh ? "Telegram · 经 Matrix" : "Telegram · via Matrix";
  }
  const labels = {
    WEB: zh ? "Web 公开入口" : "Web public entry",
    MATRIX: "Matrix",
    TELEGRAM: "Telegram",
  };
  return labels[channel.sourceProvider];
}

function desiredStateLabel(value: string, locale: Locale) {
  const labels: Record<string, [string, string]> = {
    ACTIVE: ["运行中", "Active"],
    PAUSED: ["已暂停", "Paused"],
    DISCONNECTED: ["未连接", "Disconnected"],
  };
  return labels[value]?.[locale === "zh" ? 0 : 1] ?? value;
}

function healthStatusLabel(value: string, locale: Locale) {
  const labels: Record<string, [string, string]> = {
    UNKNOWN: ["未知", "Unknown"],
    HEALTHY: ["健康", "Healthy"],
    DEGRADED: ["已降级", "Degraded"],
    UNHEALTHY: ["不健康", "Unhealthy"],
  };
  return labels[value]?.[locale === "zh" ? 0 : 1] ?? value;
}

function lifecycleLabel(value: string, locale: Locale) {
  const labels: Record<string, [string, string]> = {
    DRAFT: ["草稿", "Draft"],
    CONFIGURING: ["配置中", "Configuring"],
    READY: ["待发布", "Ready"],
    PUBLISHED: ["已发布", "Published"],
    PAUSED: ["代表已暂停", "Representative paused"],
    ARCHIVED: ["已归档", "Archived"],
  };
  return labels[value]?.[locale === "zh" ? 0 : 1] ?? value;
}

function formatTimestamp(value: string | null, locale: Locale) {
  if (!value) return locale === "zh" ? "暂无" : "Never";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function createRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `channel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function extractError(response: Response) {
  const payload = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return typeof payload?.error === "string"
    ? payload.error
    : `Request failed (${response.status}).`;
}

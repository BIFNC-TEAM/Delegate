"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ManagedChannelBinding,
  OwnerChannelManagementSnapshot,
  OwnerTelegramBotConnectionSummary,
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

type TelegramBotDialogState = {
  row: ChannelRow;
};

type TelegramBotLifecycleIntent =
  | "rotate"
  | "disable"
  | "revoke"
  | "unassign"
  | null;

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
  const [telegramDialog, setTelegramDialog] =
    useState<TelegramBotDialogState | null>(null);
  const [telegramDialogMode, setTelegramDialogMode] =
    useState<"existing" | "add">("existing");
  const [selectedTelegramBotId, setSelectedTelegramBotId] = useState("");
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [telegramBotLabel, setTelegramBotLabel] = useState("");
  const [telegramLifecycleIntent, setTelegramLifecycleIntent] =
    useState<TelegramBotLifecycleIntent>(null);
  const [telegramRevokeConfirmation, setTelegramRevokeConfirmation] =
    useState("");
  const [telegramDialogError, setTelegramDialogError] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);
  const busyKeyRef = useRef<string | null>(null);
  const telegramDialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  busyKeyRef.current = busyKey;

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

  const closeTelegramDialog = useCallback(() => {
    setTelegramDialog(null);
    setTelegramBotToken("");
    setTelegramBotLabel("");
    setTelegramLifecycleIntent(null);
    setTelegramRevokeConfirmation("");
    setTelegramDialogError(null);
    const previousFocus = previousFocusRef.current;
    previousFocusRef.current = null;
    window.setTimeout(() => previousFocus?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!telegramDialog) return;
    const dialog = telegramDialogRef.current;
    const focusable = dialog?.querySelector<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled])",
    );
    focusable?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (busyKeyRef.current) return;
        event.preventDefault();
        closeTelegramDialog();
        return;
      }
      if (event.key === "Tab" && dialog) {
        const controls = [
          ...dialog.querySelectorAll<HTMLElement>(
            "button:not([disabled]), input:not([disabled]), select:not([disabled])",
          ),
        ];
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [closeTelegramDialog, telegramDialog]);

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

  const telegramBots = snapshot?.telegramBots ?? [];
  const selectedTelegramBot =
    telegramBots.find((bot) => bot.id === selectedTelegramBotId) ?? null;
  const selectedTelegramBotAssignable =
    selectedTelegramBot?.status === "ACTIVE"
    && selectedTelegramBot.verificationStatus === "VERIFIED";
  const selectedTelegramBotIsCurrent =
    Boolean(
      selectedTelegramBot
      && telegramDialog?.row.channel.telegramBotConnectionId
        === selectedTelegramBot.id,
    );
  const telegramRevokeConfirmationLabel = selectedTelegramBot
    ? selectedTelegramBot.username
      ? `@${selectedTelegramBot.username}`
      : selectedTelegramBot.botId
    : "";

  function openTelegramDialog(row: ChannelRow) {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const currentConnectionId = row.channel.telegramBotConnectionId ?? "";
    const currentBot = telegramBots.find(
      (bot) => bot.id === currentConnectionId,
    );
    const firstAssignableBot = telegramBots.find(
      (bot) =>
        bot.status === "ACTIVE"
        && bot.verificationStatus === "VERIFIED",
    );
    setSelectedTelegramBotId(
      currentBot?.id
      || firstAssignableBot?.id
      || telegramBots[0]?.id
      || "",
    );
    setTelegramDialogMode(telegramBots.length ? "existing" : "add");
    setTelegramBotToken("");
    setTelegramBotLabel("");
    setTelegramLifecycleIntent(null);
    setTelegramRevokeConfirmation("");
    setTelegramDialogError(null);
    setTelegramDialog({ row });
  }

  async function saveTelegramBotAssignment() {
    if (!telegramDialog || snapshot?.dataSource !== "database") return;
    let telegramBotConnectionId = selectedTelegramBotId;
    if (telegramDialogMode === "add" && !telegramBotToken.trim()) {
      setTelegramDialogError(
        zh
          ? "请输入从 BotFather 获取的完整 Bot Token。"
          : "Enter the full Bot token from BotFather.",
      );
      return;
    }
    if (
      telegramDialogMode === "existing"
      && (
        !telegramBotConnectionId
        || !selectedTelegramBotAssignable
      )
    ) {
      setTelegramDialogError(
        zh
          ? "请选择一个已验证且处于活动状态的 Bot。"
          : "Select a verified, active Bot.",
      );
      return;
    }

    const actionKey = `${telegramDialog.row.representativeId}:TELEGRAM:assign`;
    setBusyKey(actionKey);
    setTelegramDialogError(null);
    setError(null);
    setNotice(null);
    try {
      if (telegramDialogMode === "add") {
        const token = telegramBotToken.trim();
        const label = telegramBotLabel.trim();
        setTelegramBotToken("");
        const createRequestIdValue = createRequestId();
        const createResponse = await fetch(
          "/api/dashboard/channels/telegram-bots",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": createRequestIdValue,
              "X-Request-Id": createRequestIdValue,
            },
            body: JSON.stringify({
              token,
              ...(label ? { label } : {}),
            }),
          },
        );
        if (!createResponse.ok) {
          throw new Error(await extractError(createResponse));
        }
        const created = (await createResponse.json()) as {
          connection?: { id?: unknown };
        };
        if (typeof created.connection?.id !== "string") {
          throw new Error(
            zh
              ? "Bot 已验证，但服务未返回可绑定的连接标识。请刷新后重试。"
              : "The Bot was verified, but no assignable connection id was returned. Refresh and try again.",
          );
        }
        telegramBotConnectionId = created.connection.id;
      }

      const assignRequestIdValue = createRequestId();
      const assignResponse = await fetch("/api/dashboard/channels", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": assignRequestIdValue,
          "X-Request-Id": assignRequestIdValue,
        },
        body: JSON.stringify({
          channel: "TELEGRAM",
          representativeId: telegramDialog.row.representativeId,
          telegramBotConnectionId,
        }),
      });
      if (!assignResponse.ok) {
        throw new Error(await extractError(assignResponse));
      }
      const selectedBot =
        telegramBots.find((bot) => bot.id === telegramBotConnectionId) ?? null;
      setNotice(
        zh
          ? `${telegramDialog.row.representativeName} 已绑定到 ${
              selectedBot ? telegramBotDisplayName(selectedBot) : "已验证的 Telegram Bot"
            }；其他数字代表的 Bot 配置不受影响。`
          : `${telegramDialog.row.representativeName} is now assigned to ${
              selectedBot ? telegramBotDisplayName(selectedBot) : "the verified Telegram Bot"
            }. Other representatives are unchanged.`,
      );
      await loadChannels();
      closeTelegramDialog();
    } catch (nextError) {
      setTelegramDialogError(
        nextError instanceof Error
          ? nextError.message
          : zh
            ? "Telegram Bot 配置失败。"
            : "Failed to configure the Telegram Bot.",
      );
    } finally {
      setBusyKey(null);
    }
  }

  function beginTelegramLifecycleAction(intent: Exclude<TelegramBotLifecycleIntent, null>) {
    if (!selectedTelegramBot && intent !== "unassign") return;
    setTelegramLifecycleIntent(intent);
    setTelegramDialogError(null);
    setTelegramRevokeConfirmation("");
    setTelegramBotToken("");
    setTelegramBotLabel(
      intent === "rotate"
        ? selectedTelegramBot?.label ?? ""
        : "",
    );
  }

  function cancelTelegramLifecycleAction() {
    setTelegramLifecycleIntent(null);
    setTelegramDialogError(null);
    setTelegramRevokeConfirmation("");
    setTelegramBotToken("");
    setTelegramBotLabel("");
  }

  async function performTelegramBotLifecycle(
    action: "rotate" | "disable" | "resume" | "revoke",
  ) {
    if (!selectedTelegramBot || snapshot?.dataSource !== "database") return;
    if (action === "rotate" && !telegramBotToken.trim()) {
      setTelegramDialogError(
        zh
          ? "请输入这个 Bot 的新 BotFather Token。"
          : "Enter the new BotFather token for this Bot.",
      );
      return;
    }
    if (
      action === "revoke"
      && telegramRevokeConfirmation.trim() !== telegramRevokeConfirmationLabel
    ) {
      setTelegramDialogError(
        zh
          ? `请输入 ${telegramRevokeConfirmationLabel} 以确认撤销。`
          : `Enter ${telegramRevokeConfirmationLabel} to confirm revocation.`,
      );
      return;
    }

    const requestId = createRequestId();
    const actionKey = `telegram-bot:${selectedTelegramBot.id}:${action}`;
    const token = action === "rotate" ? telegramBotToken.trim() : "";
    const label = action === "rotate" ? telegramBotLabel.trim() : "";
    setBusyKey(actionKey);
    setTelegramDialogError(null);
    setError(null);
    setNotice(null);
    if (action === "rotate") setTelegramBotToken("");
    try {
      const response = await fetch(
        `/api/dashboard/channels/telegram-bots/${encodeURIComponent(selectedTelegramBot.id)}`,
        {
          method: action === "revoke" ? "DELETE" : "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": requestId,
            "X-Request-Id": requestId,
          },
          ...(action === "revoke"
            ? {}
            : {
                body: JSON.stringify({
                  action,
                  ...(action === "rotate"
                    ? {
                        token,
                        label: label || null,
                      }
                    : {}),
                }),
              }),
        },
      );
      if (!response.ok) throw new Error(await extractError(response));

      const botName = telegramBotDisplayName(selectedTelegramBot);
      const noticeByAction = {
        rotate: zh
          ? `${botName} 的凭据已安全更新；运行实例会自动加载新版本。`
          : `${botName}'s credential was updated securely. Runtimes will load the new revision automatically.`,
        disable: zh
          ? `${botName} 已停用；引用它的 ${selectedTelegramBot.referenceCount} 个代表将停止新的 Telegram 处理。`
          : `${botName} is disabled. Its ${selectedTelegramBot.referenceCount} representative assignment(s) will stop new Telegram processing.`,
        resume: zh
          ? `${botName} 已恢复；已启用的代表绑定会重新进入运行状态。`
          : `${botName} is active again. Enabled representative assignments will resume.`,
        revoke: zh
          ? `${botName} 已撤销，凭据已清除，并已从所有数字代表解绑。`
          : `${botName} was revoked, its credential was cleared, and all representative assignments were removed.`,
      } as const;
      setNotice(noticeByAction[action]);
      await loadChannels();
      if (action === "revoke") {
        closeTelegramDialog();
      } else {
        cancelTelegramLifecycleAction();
      }
    } catch (nextError) {
      setTelegramDialogError(
        nextError instanceof Error
          ? nextError.message
          : zh
            ? "Telegram Bot 生命周期操作失败。"
            : "Telegram Bot lifecycle operation failed.",
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function unassignTelegramBotFromRepresentative() {
    const bindingId = telegramDialog?.row.channel.bindingId;
    if (
      !telegramDialog
      || !bindingId
      || !selectedTelegramBotIsCurrent
      || snapshot?.dataSource !== "database"
    ) return;
    const requestId = createRequestId();
    setBusyKey(`${bindingId}:unassign`);
    setTelegramDialogError(null);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/dashboard/channels/${encodeURIComponent(bindingId)}?telegramBotConnectionId=${encodeURIComponent(selectedTelegramBot!.id)}`,
        {
          method: "DELETE",
          headers: {
            "Idempotency-Key": requestId,
            "X-Request-Id": requestId,
          },
        },
      );
      if (!response.ok) throw new Error(await extractError(response));
      setNotice(
        zh
          ? `${telegramDialog.row.representativeName} 已与 ${telegramBotDisplayName(selectedTelegramBot!)} 解绑；其他数字代表不受影响。`
          : `${telegramDialog.row.representativeName} was unassigned from ${telegramBotDisplayName(selectedTelegramBot!)}. Other representatives are unchanged.`,
      );
      await loadChannels();
      closeTelegramDialog();
    } catch (nextError) {
      setTelegramDialogError(
        nextError instanceof Error
          ? nextError.message
          : zh
            ? "解除 Telegram Bot 绑定失败。"
            : "Failed to unassign the Telegram Bot.",
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function performAction(
    row: ChannelRow,
    action: "connect" | "pause" | "resume" | "health",
  ) {
    const bindingId = row.channel.bindingId;
    const canProvisionChannel =
      action === "connect"
      && !bindingId
      && row.channel.kind === "MATRIX";
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
          ? zh
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
              ? "Web、Matrix 与 Telegram 始终按来源分别呈现。每个数字代表都能选择独立 Telegram Bot，也可以安全复用工作区内已验证的同一个 Bot；经 Matrix 传输时会明确标注。"
              : "Web, Matrix, and Telegram remain distinct sources. Each representative can use a different Telegram Bot or safely reuse a verified workspace Bot; Matrix transport is labeled explicitly."}
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
                      <th>{zh ? "渠道端点" : "Channel endpoint"}</th>
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
                        onConfigureTelegram={() => openTelegramDialog(row)}
                        readOnly={snapshot?.dataSource !== "database"}
                        row={row}
                        telegramBots={telegramBots}
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

      {telegramDialog ? (
        <div
          className="channels-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && !busyKey) {
              closeTelegramDialog();
            }
          }}
          role="presentation"
        >
          <section
            aria-describedby="telegram-bot-dialog-description"
            aria-labelledby="telegram-bot-dialog-title"
            aria-modal="true"
            className="channels-bot-dialog"
            ref={telegramDialogRef}
            role="dialog"
          >
            <header>
              <div>
                <p>TELEGRAM BOT</p>
                <h2 id="telegram-bot-dialog-title">
                  {zh
                    ? `为 ${telegramDialog.row.representativeName} 配置 Bot`
                    : `Configure a Bot for ${telegramDialog.row.representativeName}`}
                </h2>
              </div>
              <button
                aria-label={zh ? "关闭 Telegram Bot 配置" : "Close Telegram Bot configuration"}
                className="channels-dialog-close"
                disabled={Boolean(busyKey)}
                onClick={closeTelegramDialog}
                type="button"
              >
                ×
              </button>
            </header>
            <p
              className="dashboard-v2-panel-description"
              id="telegram-bot-dialog-description"
            >
              {zh
                ? "选择工作区已有 Bot，或使用 BotFather Token 添加并验证一个新 Bot。切换只影响当前数字代表；同一个 Bot 可以被多个代表复用。"
                : "Choose an existing workspace Bot, or add and verify one with a BotFather token. Switching affects only this representative, and one Bot can be reused by multiple representatives."}
            </p>

            <div
              aria-label={zh ? "Telegram Bot 配置方式" : "Telegram Bot configuration mode"}
              className="channels-dialog-mode"
              role="group"
            >
              <button
                aria-pressed={telegramDialogMode === "existing"}
                className={telegramDialogMode === "existing" ? "is-active" : undefined}
                disabled={!telegramBots.length || Boolean(busyKey)}
                onClick={() => {
                  setTelegramDialogMode("existing");
                  cancelTelegramLifecycleAction();
                }}
                type="button"
              >
                {zh
                  ? `选择已有 Bot（${telegramBots.length}）`
                  : `Existing Bots (${telegramBots.length})`}
              </button>
              <button
                aria-pressed={telegramDialogMode === "add"}
                className={telegramDialogMode === "add" ? "is-active" : undefined}
                disabled={Boolean(busyKey)}
                onClick={() => {
                  setTelegramDialogMode("add");
                  cancelTelegramLifecycleAction();
                }}
                type="button"
              >
                {zh ? "添加新 Bot" : "Add new Bot"}
              </button>
            </div>

            {telegramDialogMode === "existing" ? (
              <div
                aria-label={zh ? "已验证 Telegram Bot" : "Verified Telegram Bots"}
                className="channels-bot-options"
                role="radiogroup"
              >
                {telegramBots.map((bot) => {
                  const isCurrent =
                    telegramDialog.row.channel.telegramBotConnectionId === bot.id;
                  const assignable =
                    bot.status === "ACTIVE"
                    && bot.verificationStatus === "VERIFIED";
                  return (
                    <label
                      className={[
                        selectedTelegramBotId === bot.id ? "is-selected" : "",
                        assignable ? "" : "is-unavailable",
                      ].filter(Boolean).join(" ") || undefined}
                      key={bot.id}
                    >
                      <input
                        checked={selectedTelegramBotId === bot.id}
                        disabled={Boolean(busyKey)}
                        name="telegramBotConnection"
                        onChange={() => {
                          setSelectedTelegramBotId(bot.id);
                          cancelTelegramLifecycleAction();
                        }}
                        type="radio"
                        value={bot.id}
                      />
                      <span>
                        <strong>
                          {telegramBotDisplayName(bot)}
                          {isCurrent ? ` · ${zh ? "当前" : "current"}` : ""}
                        </strong>
                        <small>
                          {bot.label ? `${bot.label} · ` : ""}
                          Bot ID {bot.botId} ·{" "}
                          {zh
                            ? `${bot.referenceCount} 个代表使用`
                            : usedByRepresentativesLabel(bot.referenceCount)}
                        </small>
                      </span>
                      <span>
                        <TelegramBotVerificationStatus bot={bot} locale={locale} />
                        <small>
                          {zh
                            ? `${telegramBotStatusLabel(bot.status, locale)} · ${healthStatusLabel(bot.healthStatus, locale)} · ${bot.activeReferenceCount} 个运行中`
                            : `${telegramBotStatusLabel(bot.status, locale)} · ${healthStatusLabel(bot.healthStatus, locale)} · ${bot.activeReferenceCount} active`}
                        </small>
                      </span>
                    </label>
                  );
                })}
                {!telegramBots.length ? (
                  <div className="channels-bot-empty">
                    <strong>{zh ? "还没有可选 Bot" : "No Bots available"}</strong>
                    <p>
                      {zh
                        ? "切换到“添加新 Bot”，先验证 BotFather Token。"
                        : "Open “Add new Bot” and verify a BotFather token first."}
                    </p>
                  </div>
                ) : null}
                {selectedTelegramBot ? (
                  <section
                    aria-label={zh ? "所选 Bot 生命周期管理" : "Selected Bot lifecycle management"}
                    className="channels-bot-management"
                  >
                    <header>
                      <span>
                        <small>{zh ? "工作区级 Bot 操作" : "Workspace Bot operations"}</small>
                        <strong>{telegramBotDisplayName(selectedTelegramBot)}</strong>
                      </span>
                      <span>
                        <StatusChip
                          kind="telegram"
                          locale={locale}
                          value={selectedTelegramBot.status}
                        />
                        <small>
                          {zh
                            ? `${selectedTelegramBot.referenceCount} 个代表引用`
                            : `${selectedTelegramBot.referenceCount} representative assignment(s)`}
                        </small>
                      </span>
                    </header>

                    {telegramLifecycleIntent === null ? (
                      <div className="channels-bot-management-actions">
                        <button
                          className="dashboard-v2-button-secondary"
                          disabled={
                            Boolean(busyKey)
                            || selectedTelegramBot.status === "REVOKED"
                          }
                          onClick={() => beginTelegramLifecycleAction("rotate")}
                          type="button"
                        >
                          {zh ? "更新 Token" : "Rotate token"}
                        </button>
                        {selectedTelegramBot.status === "DISABLED" ? (
                          <button
                            className="dashboard-v2-button-secondary"
                            disabled={Boolean(busyKey)}
                            onClick={() => void performTelegramBotLifecycle("resume")}
                            type="button"
                          >
                            {zh ? "恢复 Bot" : "Resume Bot"}
                          </button>
                        ) : (
                          <button
                            className="dashboard-v2-button-secondary"
                            disabled={
                              Boolean(busyKey)
                              || selectedTelegramBot.status !== "ACTIVE"
                            }
                            onClick={() => beginTelegramLifecycleAction("disable")}
                            type="button"
                          >
                            {zh ? "停用 Bot" : "Disable Bot"}
                          </button>
                        )}
                        {selectedTelegramBotIsCurrent
                          && telegramDialog.row.channel.bindingId ? (
                            <button
                              className="dashboard-v2-button-secondary"
                              disabled={Boolean(busyKey)}
                              onClick={() => beginTelegramLifecycleAction("unassign")}
                              type="button"
                            >
                              {zh ? "从此代表解绑" : "Unassign from this representative"}
                            </button>
                          ) : null}
                        <button
                          className="channels-button-danger"
                          disabled={
                            Boolean(busyKey)
                            || selectedTelegramBot.status === "REVOKED"
                          }
                          onClick={() => beginTelegramLifecycleAction("revoke")}
                          type="button"
                        >
                          {zh ? "撤销 Bot" : "Revoke Bot"}
                        </button>
                      </div>
                    ) : null}

                    {telegramLifecycleIntent === "rotate" ? (
                      <div className="channels-bot-lifecycle-form">
                        <p>
                          {zh
                            ? "新 Token 必须仍属于同一个 Telegram Bot。验证成功后旧凭据会立即销毁；停用状态不会被自动恢复。"
                            : "The new token must belong to the same Telegram Bot. The old credential is destroyed after verification, and a disabled Bot remains disabled."}
                        </p>
                        <div className="channels-bot-form">
                          <label>
                            <span>{zh ? "连接名称（可选）" : "Connection label (optional)"}</span>
                            <input
                              autoComplete="off"
                              disabled={Boolean(busyKey)}
                              maxLength={100}
                              onChange={(event) => setTelegramBotLabel(event.target.value)}
                              value={telegramBotLabel}
                            />
                          </label>
                          <label>
                            <span>{zh ? "新的 BotFather Token" : "New BotFather token"}</span>
                            <input
                              autoComplete="new-password"
                              disabled={Boolean(busyKey)}
                              maxLength={512}
                              onChange={(event) => setTelegramBotToken(event.target.value)}
                              placeholder="123456789:AA…"
                              spellCheck={false}
                              type="password"
                              value={telegramBotToken}
                            />
                          </label>
                        </div>
                        <div className="channels-bot-confirm-actions">
                          <button
                            className="dashboard-v2-button-secondary"
                            disabled={Boolean(busyKey)}
                            onClick={cancelTelegramLifecycleAction}
                            type="button"
                          >
                            {zh ? "取消" : "Cancel"}
                          </button>
                          <button
                            className="dashboard-v2-button-primary"
                            disabled={Boolean(busyKey) || !telegramBotToken.trim()}
                            onClick={() => void performTelegramBotLifecycle("rotate")}
                            type="button"
                          >
                            {busyKey
                              ? zh
                                ? "验证中…"
                                : "Verifying…"
                              : zh
                                ? "验证并更新"
                                : "Verify and rotate"}
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {telegramLifecycleIntent === "disable" ? (
                      <LifecycleConfirmation
                        busy={Boolean(busyKey)}
                        confirmLabel={zh ? "确认停用" : "Disable Bot"}
                        description={
                          zh
                            ? `停用后，引用此 Bot 的 ${selectedTelegramBot.referenceCount} 个代表会立即停止新的 Telegram 处理。之后可以恢复。`
                            : `Disabling stops new Telegram processing for ${selectedTelegramBot.referenceCount} representative assignment(s). You can resume it later.`
                        }
                        locale={locale}
                        onCancel={cancelTelegramLifecycleAction}
                        onConfirm={() => void performTelegramBotLifecycle("disable")}
                        tone="warning"
                      />
                    ) : null}

                    {telegramLifecycleIntent === "unassign" ? (
                      <LifecycleConfirmation
                        busy={Boolean(busyKey)}
                        confirmLabel={zh ? "确认解绑" : "Unassign"}
                        description={
                          zh
                            ? `只解除 ${telegramDialog.row.representativeName} 与此 Bot 的关联；其他代表和 Bot 凭据保持不变。`
                            : `Only ${telegramDialog.row.representativeName} is unassigned. Other representatives and the Bot credential remain unchanged.`
                        }
                        locale={locale}
                        onCancel={cancelTelegramLifecycleAction}
                        onConfirm={() => void unassignTelegramBotFromRepresentative()}
                        tone="warning"
                      />
                    ) : null}

                    {telegramLifecycleIntent === "revoke" ? (
                      <div className="channels-bot-revoke-confirmation" role="alert">
                        <strong>{zh ? "这是不可恢复的工作区级操作" : "This workspace-level action cannot be undone"}</strong>
                        <p>
                          {zh
                            ? `系统会销毁凭据并从 ${selectedTelegramBot.referenceCount} 个代表解绑。若要重新使用，必须在 BotFather 生成新 Token 并重新添加。`
                            : `The credential will be destroyed and ${selectedTelegramBot.referenceCount} representative assignment(s) will be removed. Reuse requires a new BotFather token and a new connection.`}
                        </p>
                        <label>
                          <span>
                            {zh
                              ? `输入 ${telegramRevokeConfirmationLabel} 以确认`
                              : `Enter ${telegramRevokeConfirmationLabel} to confirm`}
                          </span>
                          <input
                            autoComplete="off"
                            disabled={Boolean(busyKey)}
                            onChange={(event) =>
                              setTelegramRevokeConfirmation(event.target.value)}
                            spellCheck={false}
                            value={telegramRevokeConfirmation}
                          />
                        </label>
                        <div className="channels-bot-confirm-actions">
                          <button
                            className="dashboard-v2-button-secondary"
                            disabled={Boolean(busyKey)}
                            onClick={cancelTelegramLifecycleAction}
                            type="button"
                          >
                            {zh ? "取消" : "Cancel"}
                          </button>
                          <button
                            className="channels-button-danger is-solid"
                            disabled={
                              Boolean(busyKey)
                              || telegramRevokeConfirmation.trim()
                                !== telegramRevokeConfirmationLabel
                            }
                            onClick={() => void performTelegramBotLifecycle("revoke")}
                            type="button"
                          >
                            {busyKey
                              ? zh
                                ? "撤销中…"
                                : "Revoking…"
                              : zh
                                ? "永久撤销 Bot"
                                : "Revoke Bot permanently"}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </section>
                ) : null}
              </div>
            ) : (
              <div className="channels-bot-form">
                <label>
                  <span>{zh ? "连接名称（可选）" : "Connection label (optional)"}</span>
                  <input
                    autoComplete="off"
                    disabled={Boolean(busyKey)}
                    maxLength={100}
                    onChange={(event) => setTelegramBotLabel(event.target.value)}
                    placeholder={zh ? "例如：SKTone 客服 Bot" : "For example: SKTone support Bot"}
                    value={telegramBotLabel}
                  />
                </label>
                <label>
                  <span>BotFather Token</span>
                  <input
                    autoComplete="new-password"
                    disabled={Boolean(busyKey)}
                    maxLength={512}
                    onChange={(event) => setTelegramBotToken(event.target.value)}
                    placeholder="123456789:AA…"
                    spellCheck={false}
                    type="password"
                    value={telegramBotToken}
                  />
                </label>
                <div className="channels-token-boundary" role="note">
                  <strong>{zh ? "凭据边界" : "Credential boundary"}</strong>
                  <span>
                    {zh
                      ? "Token 仅用于服务端验证和加密保存，页面不会再次显示。请勿粘贴到聊天、日志或代表知识库。"
                      : "The token is used only for server-side verification and encrypted storage. It is never shown again; do not paste it into chats, logs, or representative knowledge."}
                  </span>
                </div>
              </div>
            )}

            {telegramDialogError ? (
              <div className="skills-banner is-error" role="alert">
                {telegramDialogError}
              </div>
            ) : null}

            <footer>
              <span>
                {telegramDialogMode === "existing"
                  ? zh
                    ? "复用 Bot 不会合并不同代表的会话或运行状态。"
                    : "Reusing a Bot does not merge representative conversations or operating state."
                  : zh
                    ? "验证成功后会立即用于当前数字代表。"
                    : "After verification, the Bot is assigned to this representative."}
              </span>
              <div>
                <button
                  className="dashboard-v2-button-secondary"
                  disabled={Boolean(busyKey)}
                  onClick={closeTelegramDialog}
                  type="button"
                >
                  {zh ? "取消" : "Cancel"}
                </button>
                <button
                  className="dashboard-v2-button-primary"
                  disabled={
                    Boolean(busyKey)
                    || (
                      telegramDialogMode === "existing"
                        ? !selectedTelegramBotAssignable
                        : !telegramBotToken.trim()
                    )
                  }
                  onClick={() => void saveTelegramBotAssignment()}
                  type="button"
                >
                  {busyKey
                    ? zh
                      ? "处理中…"
                      : "Working…"
                    : telegramDialogMode === "add"
                      ? zh
                        ? "验证并用于此代表"
                        : "Verify and assign"
                      : telegramDialog.row.channel.telegramBotConnectionId
                          === selectedTelegramBotId
                        ? zh
                          ? "保持当前 Bot"
                          : "Keep current Bot"
                        : zh
                          ? "切换到所选 Bot"
                          : "Switch to selected Bot"}
                </button>
              </div>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

function ChannelTableRow({
  busyKey,
  locale,
  onAction,
  onConfigureTelegram,
  readOnly,
  row,
  telegramBots,
}: {
  busyKey: string | null;
  locale: Locale;
  onAction: (action: "connect" | "pause" | "resume" | "health") => void;
  onConfigureTelegram: () => void;
  readOnly: boolean;
  row: ChannelRow;
  telegramBots: OwnerTelegramBotConnectionSummary[];
}) {
  const zh = locale === "zh";
  const channel = row.channel;
  const stateAction = channel.desiredState === "ACTIVE" ? "pause" : "resume";
  const stateBusy = busyKey === `${channel.bindingId}:${stateAction}`;
  const healthBusy = busyKey === `${channel.bindingId}:health`;
  const assignedTelegramBot =
    channel.kind === "TELEGRAM"
      ? telegramBots.find(
          (bot) => bot.id === channel.telegramBotConnectionId,
        ) ?? null
      : null;
  const telegramConfigured =
    channel.kind !== "TELEGRAM" || Boolean(assignedTelegramBot);
  const unavailable = !channel.bindingId || !telegramConfigured || readOnly;
  const connectBusy =
    busyKey === `${row.representativeId}:${channel.kind}:connect`;
  const telegramAssignBusy =
    busyKey === `${row.representativeId}:TELEGRAM:assign`;
  const canProvisionChannel =
    !readOnly
    && !channel.bindingId
    && channel.kind === "MATRIX";

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
          {channel.kind === "TELEGRAM" && assignedTelegramBot ? (
            <>
              <strong>{telegramBotDisplayName(assignedTelegramBot)}</strong>
              <small title={assignedTelegramBot.botId}>
                {assignedTelegramBot.label
                  ? `${assignedTelegramBot.label} · `
                  : ""}
                Bot ID {assignedTelegramBot.botId} ·{" "}
                {zh
                  ? `${assignedTelegramBot.referenceCount} 个代表使用`
                  : usedByRepresentativesLabel(assignedTelegramBot.referenceCount)}
              </small>
              <TelegramBotVerificationStatus
                bot={assignedTelegramBot}
                locale={locale}
              />
              <small>
                {zh ? "Bot 健康" : "Bot health"} ·{" "}
                {healthStatusLabel(assignedTelegramBot.healthStatus, locale)}
              </small>
            </>
          ) : (
            <>
              <strong>
                {channel.externalIdentity.displayName
                  ?? (zh ? "未命名" : "Unnamed")}
              </strong>
              <small title={channel.externalIdentity.id ?? undefined}>
                {channel.externalIdentity.id
                  ?? (zh ? "未配置外部身份" : "No external identity")}
              </small>
            </>
          )}
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
          {channel.kind === "TELEGRAM" && !readOnly ? (
            <button
              className="dashboard-v2-button-secondary"
              disabled={Boolean(busyKey)}
              onClick={onConfigureTelegram}
              type="button"
            >
              {telegramAssignBusy
                ? zh
                  ? "保存中…"
                  : "Saving…"
                : assignedTelegramBot
                  ? zh
                    ? "切换 Bot"
                    : "Switch Bot"
                  : zh
                    ? "配置 Bot"
                    : "Configure Bot"}
            </button>
          ) : null}
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
                  ? "创建 Matrix 用户"
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
          {(
            (!channel.bindingId && !canProvisionChannel)
            || (channel.kind === "TELEGRAM" && !assignedTelegramBot)
          ) ? (
            <small>
              {channel.kind === "TELEGRAM"
                ? zh
                  ? "选择或添加一个已验证 Bot 后即可启用"
                  : "Select or add a verified Bot to enable this channel"
                : zh
                  ? "尚未创建绑定"
                  : "Binding not created"}
            </small>
          ) : null}
          {assignedTelegramBot ? (
            <small>
              {zh
                ? `此 Bot 同时服务 ${assignedTelegramBot.referenceCount} 个代表；当前行的暂停与健康状态仍独立。`
                : `This Bot serves ${assignedTelegramBot.referenceCount} representative(s); pause and health remain independent for this row.`}
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

function LifecycleConfirmation({
  busy,
  confirmLabel,
  description,
  locale,
  onCancel,
  onConfirm,
  tone,
}: {
  busy: boolean;
  confirmLabel: string;
  description: string;
  locale: Locale;
  onCancel: () => void;
  onConfirm: () => void;
  tone: "warning";
}) {
  const zh = locale === "zh";
  return (
    <div className={`channels-bot-lifecycle-confirmation is-${tone}`} role="alert">
      <p>{description}</p>
      <div className="channels-bot-confirm-actions">
        <button
          className="dashboard-v2-button-secondary"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          {zh ? "取消" : "Cancel"}
        </button>
        <button
          className="dashboard-v2-button-primary"
          disabled={busy}
          onClick={onConfirm}
          type="button"
        >
          {busy
            ? zh
              ? "处理中…"
              : "Working…"
            : confirmLabel}
        </button>
      </div>
    </div>
  );
}

function StatusChip({
  kind,
  locale,
  value,
}: {
  kind: "desired" | "health" | "telegram";
  locale: Locale;
  value: string;
}) {
  return (
    <span className={`channels-status is-${value.toLowerCase()}`}>
      {kind === "desired"
        ? desiredStateLabel(value, locale)
        : kind === "health"
          ? healthStatusLabel(value, locale)
          : telegramBotStatusLabel(value, locale)}
    </span>
  );
}

function TelegramBotVerificationStatus({
  bot,
  locale,
}: {
  bot: OwnerTelegramBotConnectionSummary;
  locale: Locale;
}) {
  const normalized = bot.verificationStatus.trim().toUpperCase() || "UNKNOWN";
  const labels: Record<string, [string, string]> = {
    VERIFIED: ["已验证", "Verified"],
    PENDING: ["待验证", "Verification pending"],
    INVALID: ["凭据无效", "Invalid credentials"],
    UNAVAILABLE: ["暂不可用", "Unavailable"],
    UNKNOWN: ["待验证", "Verification pending"],
  };
  return (
    <span
      className={`channels-bot-verification is-${normalized.toLowerCase()}`}
      title={bot.lastError ?? undefined}
    >
      {labels[normalized]?.[locale === "zh" ? 0 : 1] ?? normalized}
    </span>
  );
}

function telegramBotDisplayName(bot: OwnerTelegramBotConnectionSummary) {
  const username = bot.username?.trim().replace(/^@/, "");
  if (username) return `@${username}`;
  return bot.label?.trim() || bot.displayName?.trim() || `Bot ${bot.botId}`;
}

function usedByRepresentativesLabel(count: number) {
  return `${count} representative${count === 1 ? "" : "s"} use this Bot`;
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

function telegramBotStatusLabel(value: string, locale: Locale) {
  const labels: Record<string, [string, string]> = {
    PENDING_CREDENTIAL: ["待配置凭据", "Credential pending"],
    ACTIVE: ["Bot 运行中", "Bot active"],
    DISABLED: ["Bot 已停用", "Bot disabled"],
    REVOKED: ["Bot 已撤销", "Bot revoked"],
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

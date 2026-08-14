"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { DashboardSurface, type Locale } from "@delegate/web-ui";

import {
  loadMemorySettings,
  MemorySettingsRequestError,
  updateMemorySettings,
  type MemorySettings,
  type MemorySettingsPolicy,
} from "./dashboard-memory-settings-api";

const copy = {
  zh: {
    eyebrow: "MEMORY / 06",
    title: "记忆配置",
    summary: "记忆只在当前数字代表内配置。此页设置保存后立即作为实时运行策略生效，无需发布代表版本；公开知识仍由知识库管理。",
    loading: "正在加载真实记忆设置…",
    unavailable: "记忆设置暂时不可用，页面不会用默认值覆盖服务端状态。",
    retry: "重新加载",
    saved: "记忆设置已保存并立即生效。",
    conflict: "设置已被其他操作更新，已重新载入最新版本；请确认后再次保存。",
    conflictReloadFailed: "设置已被其他操作更新，但最新版本重新载入失败；为避免覆盖服务端状态，请先重新加载。",
    saveFailed: "保存失败，请重新读取最新设置后再试。",
    basicTitle: "基础策略",
    basicDetail: "自动策略只让通过作用域与安全检查的结构化结果生效；不确定、敏感或越权内容会被阻止，不进入召回。",
    autoExtract: "启用自动提取与应用",
    autoExtractDetail: "自动总结联系人记忆与代表经验，不再进入人工审批；关闭后不会从新消息产生长期记忆。",
    longTerm: "启用长期记忆",
    longTermDetail: "将允许保留的联系人记忆与代表经验保存到长期记忆，并按保留策略管理。",
    shortTerm: "启用短期记忆",
    shortTermDetail: "仅使用当前会话最近消息作为上下文，不写入 OpenViking，也不跨会话保留。",
    contactMemory: "启用联系人记忆",
    contactDetail: "默认仅限当前联系人、当前代表和来源渠道；支付、凭据、私密备注与原始聊天不得进入。",
    crossChannel: "跨渠道连续性",
    crossChannelMode: "用户授权控制",
    crossChannelDetail: "Dashboard 不提供开关。Owner 只配置联系人记忆和各渠道能力；已验证用户默认开启跨渠道联系人记忆，并可在公开代表页随时关闭。匿名、未验证或已关闭的用户始终保持渠道隔离。",
    requiresLongTerm: "前置条件：请先启用长期记忆。",
    requiresContactMemory: "前置条件：请先启用联系人记忆。",
    requiresMemoryType: "前置条件：请先启用联系人记忆或代表经验。",
    requiresAutoExtract: "前置条件：请先启用自动提取与应用。",
    crossChannelUnavailable: "当前运行时尚未提供安全的跨渠道共享能力；各渠道仍会独立隔离记忆。",
    representativeExperience: "启用代表经验",
    representativeDetail: "只沉淀去标识化、可复用的服务模式；联系人事实、原始会话与交易事实不会成为代表经验。",
    channelsTitle: "渠道能力",
    channelsDetail: "配置 Web、Matrix 和 Telegram 是否支持记忆召回与提取。用户是否允许跨渠道延续联系人记忆不在 Dashboard 中配置。",
    channel: "渠道",
    recall: "召回",
    extraction: "提取",
    supported: "支持",
    enabled: "已启用",
    disabled: "已关闭",
    unsupported: "暂不支持",
    channelLocalDetail: "仅用于当前渠道中的当前联系人与当前代表；首次使用前会展示记忆说明。",
    unsupportedDetail: "当前运行时尚未接入该渠道的记忆召回或提取能力。",
    retentionTitle: "保留策略",
    retentionDetail: "到期先停止召回，再按所选行为执行可审计的归档或异步清理；缩短期限也会压缩现有有效记忆的最晚保留时间。",
    retentionDays: "保存期限（天）",
    expiryAction: "到期行为",
    archive: "归档（停止召回）",
    delete: "删除（异步物理清理）",
    confirmDeleteExpiry: "到期行为改为删除后，过期记忆会停止召回并进入异步物理清理。确认保存吗？",
    confirmDisable: "关闭长期记忆会关闭联系人记忆、代表经验及对应的召回和自动提取。短期会话上下文不受影响。确认保存吗？",
    advancedTitle: "高级设置",
    advancedDetail: "Postgres 是权威库存，OpenViking 是可重建投影。这里只展示真实连接配置、投影与对账能力；托管用户、命名空间和每个记忆版本的 URI 均由服务端动态生成并锁定。",
    syncTitle: "OpenViking 同步",
    syncTruth: "Provider 连接配置、投影运行与库存对账能力分别报告。同步采用幂等投影、失败重试和定期对账；删除会先停止召回，再异步清理远端投影。",
    providerConnection: "连接配置",
    projectionStatus: "投影同步",
    inventoryCoverage: "库存覆盖",
    inventoryCapability: "库存对账能力",
    inventoryCapabilityLimited: "仅核对已知投影；当前 OpenViking 版本不支持带稳定游标的完整远端库存枚举。",
    inventoryCapabilityFull: "支持完整远端库存枚举与已知投影校验。",
    queuedCount: "等待同步",
    activeCount: "有效投影",
    retryingCount: "重试中",
    failedCount: "失败",
    deletePendingCount: "待清理",
    lastProjectedAt: "最近投影",
    lastReconciledAt: "最近对账",
    reconciliationInterval: "对账周期",
    retryStrategy: "重试策略",
    lastErrorCode: "最近运行错误",
    notReported: "未报告",
    minutes: "分钟",
    provider: "Provider",
    recallLimit: "单次召回上限",
    recallThreshold: "最低召回阈值",
    namespace: "命名空间",
    managedUser: "托管用户",
    managedUserFallback: "由服务端代表命名空间派生，尚未报告具体值",
    dynamicUriRule: "动态 URI 规则",
    dynamicUriValue: "按代表、联系人或共享身份、记忆范围和版本动态生成",
    serverManaged: "服务端管理",
    revision: "设置版本",
    updatedAt: "最后更新",
    notConfigured: "尚未保存",
    save: "保存记忆设置",
    saving: "保存中…",
    openKnowledge: "打开知识库",
  },
  en: {
    eyebrow: "MEMORY / 06",
    title: "Memory settings",
    summary: "Memory is configured only within this digital representative. Saving here applies the live runtime policy immediately without publishing a representative version; public knowledge remains in the Knowledge Library.",
    loading: "Loading live memory settings…",
    unavailable: "Memory settings are unavailable. The page will not overwrite server state with defaults.",
    retry: "Reload",
    saved: "Memory settings saved and applied immediately.",
    conflict: "Another action changed these settings. The latest version is loaded; review it and save again.",
    conflictReloadFailed: "Another action changed these settings, but the latest version could not be reloaded. Reload before saving to avoid overwriting server state.",
    saveFailed: "Save failed. Reload the latest settings and try again.",
    basicTitle: "Basic policy",
    basicDetail: "Automatic policy activates only structured results that pass scope and safety checks. Uncertain, sensitive, or out-of-scope content remains blocked from recall.",
    autoExtract: "Enable automatic extraction and application",
    autoExtractDetail: "Automatically summarizes Contact Memory and Representative Experience without a human approval queue. Disabling it stops new long-term memory extraction.",
    longTerm: "Enable long-term memory",
    longTermDetail: "Stores eligible Contact Memory and Representative Experience as long-term memory under the retention policy.",
    shortTerm: "Enable short-term memory",
    shortTermDetail: "Uses recent messages from the current conversation only. It is not written to OpenViking or retained across conversations.",
    contactMemory: "Enable Contact Memory",
    contactDetail: "Isolated to the current contact, representative, and source channel by default. Payments, credentials, private notes, and raw chats are excluded.",
    crossChannel: "Cross-channel continuity",
    crossChannelMode: "User-controlled consent",
    crossChannelDetail: "Dashboard does not provide a switch. Owners configure Contact Memory and channel capability only. Cross-channel Contact Memory defaults on for verified users, who can turn it off at any time from the public representative page. Anonymous, unverified, or opted-out users remain isolated.",
    requiresLongTerm: "Prerequisite: enable long-term memory first.",
    requiresContactMemory: "Prerequisite: enable Contact Memory first.",
    requiresMemoryType: "Prerequisite: enable Contact Memory or Representative Experience first.",
    requiresAutoExtract: "Prerequisite: enable automatic extraction and application first.",
    crossChannelUnavailable: "The runtime does not yet provide safe cross-channel sharing. Memory remains isolated within each channel.",
    representativeExperience: "Enable Representative Experience",
    representativeDetail: "Keeps only de-identified, reusable service patterns. Contact facts, raw conversations, and transaction truth never become representative experience.",
    channelsTitle: "Channel capability",
    channelsDetail: "Configure whether Web, Matrix, and Telegram support memory recall and extraction. A user's permission to continue Contact Memory across channels is not configured in Dashboard.",
    channel: "Channel",
    recall: "Recall",
    extraction: "Extraction",
    supported: "Supported",
    enabled: "Enabled",
    disabled: "Off",
    unsupported: "Not supported",
    channelLocalDetail: "Used only for the current contact and representative in this channel. A memory disclosure is shown before first use.",
    unsupportedDetail: "The current runtime has not connected memory recall or extraction for this channel.",
    retentionTitle: "Retention policy",
    retentionDetail: "Expiry stops recall first, then performs the selected auditable archive or asynchronous cleanup. Shortening retention also caps the remaining lifetime of active memory.",
    retentionDays: "Retention (days)",
    expiryAction: "Expiry action",
    archive: "Archive (recall disabled)",
    delete: "Delete (asynchronous physical cleanup)",
    confirmDeleteExpiry: "Changing expiry to delete stops recall and queues asynchronous physical cleanup. Save this policy?",
    confirmDisable: "Turning off long-term memory disables Contact Memory, Representative Experience, and their recall and extraction. Short-term conversation context is unaffected. Save this change?",
    advancedTitle: "Advanced settings",
    advancedDetail: "Postgres is authoritative inventory and OpenViking is a rebuildable projection. This page reports connection configuration, projection, and reconciliation capability truth; managed users, namespaces, and per-version URIs are generated and locked by the server.",
    syncTitle: "OpenViking synchronization",
    syncTruth: "Provider connection configuration, projection operation, and inventory reconciliation capability are reported separately. Synchronization is idempotent with retry and periodic reconciliation; deletion blocks recall before remote cleanup.",
    providerConnection: "Connection configuration",
    projectionStatus: "Projection synchronization",
    inventoryCoverage: "Inventory coverage",
    inventoryCapability: "Inventory reconciliation capability",
    inventoryCapabilityLimited: "Known projections are verified; this OpenViking version cannot enumerate complete remote inventory with a stable cursor.",
    inventoryCapabilityFull: "Complete remote inventory enumeration and known-projection verification are supported.",
    queuedCount: "Queued",
    activeCount: "Active projections",
    retryingCount: "Retrying",
    failedCount: "Failed",
    deletePendingCount: "Pending cleanup",
    lastProjectedAt: "Last projection",
    lastReconciledAt: "Last reconciliation",
    reconciliationInterval: "Reconciliation interval",
    retryStrategy: "Retry strategy",
    lastErrorCode: "Latest operational error",
    notReported: "Not reported",
    minutes: "minutes",
    provider: "Provider",
    recallLimit: "Recall limit",
    recallThreshold: "Minimum recall threshold",
    namespace: "Namespace",
    managedUser: "Managed user",
    managedUserFallback: "Derived from the server-managed representative namespace; no value reported yet",
    dynamicUriRule: "Dynamic URI rule",
    dynamicUriValue: "Generated per representative, contact or shared identity, memory scope, and version",
    serverManaged: "Server managed",
    revision: "Settings revision",
    updatedAt: "Last updated",
    notConfigured: "Not saved yet",
    save: "Save memory settings",
    saving: "Saving…",
    openKnowledge: "Open Knowledge Library",
  },
} as const;

const memoryChannelKeys = ["web", "matrix", "telegram"] as const;

export function DashboardRepresentativeMemorySettings({
  locale,
  representativeSlug,
}: {
  locale: Locale;
  representativeSlug: string;
}) {
  const t = copy[locale];
  const [snapshot, setSnapshot] = useState<MemorySettings | null>(null);
  const [draft, setDraft] = useState<MemorySettingsPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    setLoading(true);
    setSnapshot(null);
    setDraft(null);
    setError(null);
    const result = await requestMemorySettingsReload(representativeSlug, signal);
    if (signal?.aborted) return false;
    if (!result.success) {
      setError(t.unavailable);
      setLoading(false);
      return false;
    }
    setSnapshot(result.settings);
    setDraft(policyFromSettings(result.settings));
    setLoading(false);
    return true;
  }, [representativeSlug, t.unavailable]);

  useEffect(() => {
    const controller = new AbortController();
    setNotice(null);
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const dirty = useMemo(() => Boolean(
    snapshot && draft
    && JSON.stringify(policyFromSettings(snapshot)) !== JSON.stringify(draft),
  ), [draft, snapshot]);

  function updateDraft(mutator: (value: MemorySettingsPolicy) => MemorySettingsPolicy) {
    setDraft((current) => current ? mutator(clonePolicy(current)) : current);
    setNotice(null);
    setError(null);
  }

  function updateBasic(
    key: keyof MemorySettingsPolicy["basic"],
    enabled: boolean,
  ) {
    updateDraft((current) => {
      const next = clonePolicy(current);
      next.basic[key] = enabled;
      if (key === "longTermMemoryEnabled" && !enabled) {
        next.basic.contactMemoryEnabled = false;
        next.basic.contactMemoryCrossChannelEnabled = false;
        next.basic.representativeExperienceEnabled = false;
        next.basic.autoExtract = false;
        for (const channel of memoryChannelKeys) {
          next.channels[channel] = {
            recallEnabled: false,
            extractEnabled: false,
          };
        }
      }
      if (key === "contactMemoryEnabled" && !enabled) {
        next.basic.contactMemoryCrossChannelEnabled = false;
        if (!next.basic.representativeExperienceEnabled) {
          next.basic.autoExtract = false;
          for (const channel of memoryChannelKeys) {
            next.channels[channel].extractEnabled = false;
          }
        }
      }
      if (key === "contactMemoryEnabled" && enabled) {
        next.basic.contactMemoryCrossChannelEnabled = true;
      }
      if (
        (key === "contactMemoryEnabled" || key === "representativeExperienceEnabled")
        && !next.basic.contactMemoryEnabled
        && !next.basic.representativeExperienceEnabled
      ) {
        for (const channel of memoryChannelKeys) {
          next.channels[channel].recallEnabled = false;
        }
      }
      if (key === "autoExtract" && !enabled) {
        for (const channel of memoryChannelKeys) {
          next.channels[channel].extractEnabled = false;
        }
      }
      return next;
    });
  }

  async function save() {
    if (!snapshot || !draft || !dirty) return;
    if (
      snapshot.basic.longTermMemoryEnabled
      && !draft.basic.longTermMemoryEnabled
      && !window.confirm(t.confirmDisable)
    ) return;
    if (
      snapshot.retention.expiryAction !== "DELETE"
      && draft.retention.expiryAction === "DELETE"
      && !window.confirm(t.confirmDeleteExpiry)
    ) return;
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const response = await updateMemorySettings(
        representativeSlug,
        snapshot.revision,
        normalizePolicy(draft),
      );
      setSnapshot(response.settings);
      setDraft(policyFromSettings(response.settings));
      setNotice(t.saved);
    } catch (saveError) {
      if (saveError instanceof MemorySettingsRequestError && saveError.status === 409) {
        const reloaded = await reload();
        setError(reloaded ? t.conflict : t.conflictReloadFailed);
      } else {
        setError(t.saveFailed);
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading || (!snapshot && !error)) {
    return (
      <DashboardSurface eyebrow={t.eyebrow} title={t.title} tone="accent">
        <div className="representative-memory-settings-loading" role="status">
          <span className="representative-memory-settings-spinner" aria-hidden="true" />
          <strong>{t.loading}</strong>
        </div>
      </DashboardSurface>
    );
  }

  if (!snapshot || !draft) {
    return (
      <DashboardSurface eyebrow={t.eyebrow} title={t.title} tone="accent">
        <div className="representative-memory-settings-error" role="alert">
          <p>{error ?? t.unavailable}</p>
          <button className="button-secondary" onClick={() => void reload()} type="button">{t.retry}</button>
        </div>
      </DashboardSurface>
    );
  }

  const anyMemoryType = draft.basic.contactMemoryEnabled
    || draft.basic.representativeExperienceEnabled;
  const longTermDisabledReason = !draft.basic.longTermMemoryEnabled
    ? t.requiresLongTerm
    : undefined;
  const memoryTypeDisabledReason = !draft.basic.longTermMemoryEnabled
    ? t.requiresLongTerm
    : !anyMemoryType
      ? t.requiresMemoryType
      : undefined;
  const extractionDisabledReason = memoryTypeDisabledReason
    ?? (!draft.basic.autoExtract ? t.requiresAutoExtract : undefined);
  const crossChannelSupported = snapshot.basic.contactMemoryCrossChannelSupported === true;
  const sync = snapshot.advanced.sync;
  const syncPresentation = resolveOpenVikingSyncPresentation(sync);
  const knowledgeHref = `/dashboard?${new URLSearchParams({
    view: "knowledge",
    rep: representativeSlug,
    lang: locale,
  }).toString()}`;

  return (
    <DashboardSurface
      eyebrow={t.eyebrow}
      meta={<span className="chip chip-safe">{t.revision} {snapshot.revision}</span>}
      title={t.title}
      tone="accent"
    >
      <p className="representative-memory-settings-summary">{t.summary}</p>
      {notice ? <p className="representative-memory-settings-notice" role="status">{notice}</p> : null}
      {error ? <p className="representative-memory-settings-error" role="alert">{error}</p> : null}

      <div className="representative-memory-settings-groups">
        <SettingsGroup detail={t.basicDetail} title={t.basicTitle}>
          <div className="representative-memory-settings-toggle-list">
            <PolicyToggle checked={draft.basic.autoExtract} detail={t.autoExtractDetail} disabled={Boolean(memoryTypeDisabledReason)} disabledReason={memoryTypeDisabledReason} label={t.autoExtract} onChange={(checked) => updateBasic("autoExtract", checked)} />
            <PolicyToggle checked={draft.basic.contactMemoryEnabled} detail={t.contactDetail} disabled={Boolean(longTermDisabledReason)} disabledReason={longTermDisabledReason} label={t.contactMemory} onChange={(checked) => updateBasic("contactMemoryEnabled", checked)} />
            <PolicyToggle checked={draft.basic.representativeExperienceEnabled} detail={t.representativeDetail} disabled={Boolean(longTermDisabledReason)} disabledReason={longTermDisabledReason} label={t.representativeExperience} onChange={(checked) => updateBasic("representativeExperienceEnabled", checked)} />
            <PolicyToggle checked={draft.basic.longTermMemoryEnabled} detail={t.longTermDetail} label={t.longTerm} onChange={(checked) => updateBasic("longTermMemoryEnabled", checked)} />
            <PolicyToggle checked={draft.basic.shortTermMemoryEnabled} detail={t.shortTermDetail} label={t.shortTerm} onChange={(checked) => updateBasic("shortTermMemoryEnabled", checked)} />
          </div>
        </SettingsGroup>

        <SettingsGroup detail={t.channelsDetail} title={t.channelsTitle}>
          <aside className="representative-memory-settings-consent-note">
            <div>
              <strong>{t.crossChannel}</strong>
              <span className="chip chip-safe">{t.crossChannelMode}</span>
            </div>
            <p>{crossChannelSupported ? t.crossChannelDetail : t.crossChannelUnavailable}</p>
          </aside>
          <div className="representative-memory-settings-channel-table">
            <div className="is-heading"><span>{t.channel}</span><span>{t.recall}</span><span>{t.extraction}</span></div>
            {memoryChannelKeys.map((channel) => {
              const support = snapshot.channels[channel];
              const capability = draft.channels[channel];
              return (
                <ChannelSettingsRow
                  channel={channel === "web" ? "Web" : channel === "matrix" ? "Matrix" : "Telegram"}
                  detail={support.recallSupported || support.extractSupported
                    ? t.channelLocalDetail
                    : t.unsupportedDetail}
                  extractDisabled={Boolean(extractionDisabledReason)}
                  extractDisabledReason={extractionDisabledReason}
                  extractEnabled={capability.extractEnabled}
                  extractSupported={support.extractSupported}
                  key={channel}
                  locale={locale}
                  onExtract={(checked) => updateDraft((current) => ({
                    ...current,
                    channels: {
                      ...current.channels,
                      [channel]: {
                        ...current.channels[channel],
                        extractEnabled: checked,
                      },
                    },
                  }))}
                  onRecall={(checked) => updateDraft((current) => ({
                    ...current,
                    channels: {
                      ...current.channels,
                      [channel]: {
                        ...current.channels[channel],
                        recallEnabled: checked,
                      },
                    },
                  }))}
                  recallDisabled={Boolean(memoryTypeDisabledReason)}
                  recallDisabledReason={memoryTypeDisabledReason}
                  recallEnabled={capability.recallEnabled}
                  recallSupported={support.recallSupported}
                />
              );
            })}
          </div>
        </SettingsGroup>

        <SettingsGroup detail={t.retentionDetail} title={t.retentionTitle} wide>
          <div className="representative-memory-settings-fields">
            <label className="field-stack">
              <span>{t.retentionDays}</span>
              <input className="text-input" max={3650} min={1} onChange={(event) => updateDraft((current) => ({ ...current, retention: { ...current.retention, days: Number(event.target.value || 1) } }))} type="number" value={draft.retention.days} />
            </label>
            <label className="field-stack">
              <span>{t.expiryAction}</span>
              <select className="text-input" onChange={(event) => updateDraft((current) => ({ ...current, retention: { ...current.retention, expiryAction: event.target.value as "ARCHIVE" | "DELETE" } }))} value={draft.retention.expiryAction}>
                <option value="ARCHIVE">{t.archive}</option>
                <option value="DELETE">{t.delete}</option>
              </select>
            </label>
          </div>
        </SettingsGroup>

        <SettingsGroup detail={t.advancedDetail} title={t.advancedTitle} wide>
          <section className="representative-memory-sync-status" aria-labelledby="memory-sync-title">
            <header>
              <div>
                <h4 id="memory-sync-title">{t.syncTitle}</h4>
                <p>{t.syncTruth}</p>
              </div>
              <span className={`representative-memory-sync-chip ${syncStatusTone(syncPresentation.operationalStatus)}`}>
                {formatOperationalStatus(syncPresentation.operationalStatus, locale, t.notReported)}
              </span>
            </header>
            <dl>
              <SyncFact label={t.providerConnection} value={formatConnectionStatus(syncPresentation.connectionStatus, locale, t.notReported)} />
              <SyncFact label={t.projectionStatus} value={formatOperationalStatus(syncPresentation.operationalStatus, locale, t.notReported)} />
              <SyncFact label={t.inventoryCoverage} value={formatInventoryCoverage(sync?.inventoryCoverage, locale, t.notReported)} />
              <SyncFact
                label={t.inventoryCapability}
                value={syncPresentation.inventoryCapability === "LIMITED"
                  ? t.inventoryCapabilityLimited
                  : syncPresentation.inventoryCapability === "FULL"
                    ? t.inventoryCapabilityFull
                    : t.notReported}
                wide
              />
              <SyncFact label={t.queuedCount} value={formatReportedNumber(sync?.queuedCount, t.notReported)} />
              <SyncFact label={t.activeCount} value={formatReportedNumber(sync?.activeCount, t.notReported)} />
              <SyncFact label={t.retryingCount} value={formatReportedNumber(sync?.retryingCount, t.notReported)} />
              <SyncFact label={t.failedCount} value={formatReportedNumber(sync?.failedCount, t.notReported)} />
              <SyncFact label={t.deletePendingCount} value={formatReportedNumber(sync?.deletePendingCount, t.notReported)} />
              <SyncFact label={t.lastProjectedAt} value={formatOptionalDate(sync?.lastProjectedAt, locale, t.notReported)} />
              <SyncFact label={t.lastReconciledAt} value={formatOptionalDate(sync?.lastReconciledAt, locale, t.notReported)} />
              <SyncFact label={t.reconciliationInterval} value={sync?.reconciliationIntervalMinutes == null ? t.notReported : `${sync.reconciliationIntervalMinutes} ${t.minutes}`} />
              <SyncFact label={t.retryStrategy} value={sync?.retryStrategy?.trim() || t.notReported} />
              <SyncFact label={t.lastErrorCode} value={syncPresentation.actionableErrorCode || t.notReported} />
            </dl>
          </section>
          <div className="representative-memory-settings-fields">
            <label className="field-stack"><span>{t.provider}</span><input className="text-input" disabled value={draft.advanced.provider} /></label>
            <label className="field-stack"><span>{t.recallLimit} · {t.serverManaged}</span><input className="text-input" disabled type="number" value={draft.advanced.recallLimit} /></label>
            <label className="field-stack"><span>{t.recallThreshold} · {t.serverManaged}</span><input className="text-input" disabled type="number" value={draft.advanced.recallThreshold} /></label>
            <label className="field-stack"><span>{t.managedUser} · {t.serverManaged}</span><input className="text-input" disabled value={snapshot.advanced.managedUserId?.trim() || t.managedUserFallback} /></label>
            <label className="field-stack"><span>{t.namespace} · {t.serverManaged}</span><input className="text-input" disabled value={snapshot.advanced.managedNamespace?.trim() || t.notReported} /></label>
            <label className="field-stack"><span>{t.dynamicUriRule} · {t.serverManaged}</span><input className="text-input" disabled value={formatManagedUriStrategy(snapshot.advanced.managedUriStrategy, t.dynamicUriValue, t.notReported)} /></label>
          </div>
        </SettingsGroup>
      </div>

      <div className="representative-memory-settings-meta">
        <span>{t.updatedAt}: {snapshot.updatedAt ? formatDate(snapshot.updatedAt, locale) : t.notConfigured}</span>
      </div>
      <div className="dashboard-action-bar representative-memory-settings-actions">
        <button className="button-primary" disabled={saving || !dirty} onClick={() => void save()} type="button">{saving ? t.saving : t.save}</button>
        <Link className="button-secondary" href={knowledgeHref}>{t.openKnowledge}</Link>
      </div>
    </DashboardSurface>
  );
}

function SettingsGroup({ children, detail, title, wide = false }: { children: ReactNode; detail: string; title: string; wide?: boolean }) {
  return <section className={`representative-memory-settings-group${wide ? " is-wide" : ""}`}><header><h3>{title}</h3><p>{detail}</p></header>{children}</section>;
}

function SyncFact({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <div className={wide ? "is-wide" : undefined}><dt>{label}</dt><dd>{value}</dd></div>;
}

function PolicyToggle({ checked, detail, disabled = false, disabledReason, label, onChange }: { checked: boolean; detail?: string; disabled?: boolean; disabledReason?: string | undefined; label: string; onChange: (checked: boolean) => void }) {
  return <label className="representative-memory-settings-toggle"><input checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} type="checkbox" /><span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}{disabled && disabledReason ? <small className="representative-memory-settings-disabled-reason">{disabledReason}</small> : null}</span></label>;
}

function ChannelSettingsRow({ channel, detail, extractDisabled, extractDisabledReason, extractEnabled, extractSupported, locale, onExtract, onRecall, recallDisabled, recallDisabledReason, recallEnabled, recallSupported }: { channel: "Web" | "Matrix" | "Telegram"; detail?: string; extractDisabled: boolean; extractDisabledReason?: string | undefined; extractEnabled: boolean; extractSupported: boolean; locale: Locale; onExtract: (checked: boolean) => void; onRecall: (checked: boolean) => void; recallDisabled: boolean; recallDisabledReason?: string | undefined; recallEnabled: boolean; recallSupported: boolean }) {
  const t = copy[locale];
  const recallIsDisabled = recallDisabled || !recallSupported;
  const extractIsDisabled = extractDisabled || !extractSupported;
  return <div className="representative-memory-settings-channel-row"><div><span className={`representative-memory-settings-channel is-${channel.toLowerCase()}`}>{channel}</span><small>{detail ?? (recallSupported || extractSupported ? t.supported : t.unsupported)}</small></div><label><input checked={recallEnabled} disabled={recallIsDisabled} onChange={(event) => onRecall(event.target.checked)} type="checkbox" /><span>{capabilityLabel(recallSupported, recallEnabled, t)}{recallIsDisabled && recallDisabledReason ? <small className="representative-memory-settings-disabled-reason">{recallDisabledReason}</small> : null}</span></label><label><input checked={extractEnabled} disabled={extractIsDisabled} onChange={(event) => onExtract(event.target.checked)} type="checkbox" /><span>{capabilityLabel(extractSupported, extractEnabled, t)}{extractIsDisabled && extractDisabledReason ? <small className="representative-memory-settings-disabled-reason">{extractDisabledReason}</small> : null}</span></label></div>;
}

export function policyFromSettings(settings: MemorySettings): MemorySettingsPolicy {
  const longTermMemoryEnabled = settings.basic.longTermMemoryEnabled;
  const contactMemoryEnabled = longTermMemoryEnabled
    && settings.basic.contactMemoryEnabled;
  const representativeExperienceEnabled = longTermMemoryEnabled
    && settings.basic.representativeExperienceEnabled;
  const anyLongTermMemory = contactMemoryEnabled || representativeExperienceEnabled;
  const autoExtract = anyLongTermMemory && settings.basic.autoExtract;
  return {
    basic: {
      longTermMemoryEnabled,
      shortTermMemoryEnabled: Boolean(settings.basic.shortTermMemoryEnabled),
      contactMemoryEnabled,
      contactMemoryCrossChannelEnabled: contactMemoryEnabled
        && settings.basic.contactMemoryCrossChannelSupported === true,
      representativeExperienceEnabled,
      autoExtract,
    },
    channels: {
      web: {
        recallEnabled: (contactMemoryEnabled || representativeExperienceEnabled)
          && settings.channels.web.recallEnabled,
        extractEnabled: autoExtract && settings.channels.web.extractEnabled,
      },
      matrix: {
        recallEnabled: anyLongTermMemory && settings.channels.matrix.recallEnabled,
        extractEnabled: autoExtract && settings.channels.matrix.extractEnabled,
      },
      telegram: {
        recallEnabled: anyLongTermMemory && settings.channels.telegram.recallEnabled,
        extractEnabled: autoExtract && settings.channels.telegram.extractEnabled,
      },
    },
    retention: { ...settings.retention },
    advanced: {
      provider: "openviking",
      recallLimit: settings.advanced.recallLimit,
      recallThreshold: settings.advanced.recallThreshold,
    },
  };
}

function clonePolicy(policy: MemorySettingsPolicy): MemorySettingsPolicy {
  return {
    basic: { ...policy.basic },
    channels: {
      web: { ...policy.channels.web },
      matrix: { ...policy.channels.matrix },
      telegram: { ...policy.channels.telegram },
    },
    retention: { ...policy.retention },
    advanced: { ...policy.advanced },
  };
}

function normalizePolicy(policy: MemorySettingsPolicy): MemorySettingsPolicy {
  const next = clonePolicy(policy);
  next.retention.days = Math.min(3650, Math.max(1, Math.trunc(next.retention.days)));
  next.advanced.recallLimit = Math.min(20, Math.max(1, Math.trunc(next.advanced.recallLimit)));
  next.advanced.recallThreshold = Math.min(1, Math.max(0, next.advanced.recallThreshold));
  if (!next.basic.longTermMemoryEnabled) {
    next.basic.contactMemoryEnabled = false;
    next.basic.contactMemoryCrossChannelEnabled = false;
    next.basic.representativeExperienceEnabled = false;
    next.basic.autoExtract = false;
    for (const channel of memoryChannelKeys) {
      next.channels[channel] = {
        recallEnabled: false,
        extractEnabled: false,
      };
    }
  }
  if (!next.basic.contactMemoryEnabled) {
    next.basic.contactMemoryCrossChannelEnabled = false;
  } else {
    next.basic.contactMemoryCrossChannelEnabled = true;
  }
  if (!next.basic.contactMemoryEnabled && !next.basic.representativeExperienceEnabled) {
    next.basic.autoExtract = false;
    for (const channel of memoryChannelKeys) {
      next.channels[channel].recallEnabled = false;
    }
  }
  if (!next.basic.autoExtract) {
    for (const channel of memoryChannelKeys) {
      next.channels[channel].extractEnabled = false;
    }
  }
  return next;
}

export async function requestMemorySettingsReload(
  representativeSlug: string,
  signal?: AbortSignal,
): Promise<{ success: true; settings: MemorySettings } | { success: false }> {
  try {
    const settings = await loadMemorySettings(representativeSlug, signal);
    return signal?.aborted ? { success: false } : { success: true, settings };
  } catch {
    return { success: false };
  }
}

function formatDate(value: string, locale: Locale) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatOptionalDate(
  value: string | null | undefined,
  locale: Locale,
  fallback: string,
) {
  return value?.trim() ? formatDate(value, locale) : fallback;
}

function formatReportedNumber(value: number | null | undefined, fallback: string) {
  return Number.isFinite(value) ? String(value) : fallback;
}

function formatManagedUriStrategy(
  value: string | null | undefined,
  perVersionLabel: string,
  fallback: string,
) {
  const strategy = value?.trim().toUpperCase();
  if (strategy === "PER_MEMORY_VERSION") return perVersionLabel;
  return strategy || fallback;
}

type OpenVikingSync = NonNullable<MemorySettings["advanced"]["sync"]>;

export function resolveOpenVikingSyncPresentation(sync: OpenVikingSync | null) {
  if (!sync) {
    return {
      connectionStatus: null,
      operationalStatus: null,
      inventoryCapability: null,
      actionableErrorCode: null,
    } as const;
  }

  const legacyStatus = sync.providerStatus?.trim().toUpperCase() || null;
  const explicitCapabilityCode = sync.capabilityCode?.trim() || null;
  const lastErrorCode = sync.lastErrorCode?.trim() || null;
  const capabilityCode = explicitCapabilityCode
    ?? (lastErrorCode === "openviking_inventory_no_snapshot_cursor"
      ? lastErrorCode
      : null);
  const inventoryCoverage = sync.inventoryCoverage?.trim().toUpperCase();
  const inventoryCapability = capabilityCode
    ? "LIMITED"
    : inventoryCoverage === "FULL"
      ? "FULL"
      : inventoryCoverage === "KNOWN_PROJECTIONS_ONLY"
        ? "LIMITED"
        : null;
  const connectionStatus = sync.connectionStatus?.trim().toUpperCase()
    || inferLegacyConnectionStatus(legacyStatus);
  const operationalStatus = sync.operationalStatus?.trim().toUpperCase()
    || inferLegacyOperationalStatus(
      sync,
      legacyStatus,
      inventoryCapability === "LIMITED",
    );

  return {
    connectionStatus,
    operationalStatus,
    inventoryCapability,
    actionableErrorCode: lastErrorCode && lastErrorCode !== capabilityCode
      ? lastErrorCode
      : null,
  } as const;
}

function inferLegacyConnectionStatus(legacyStatus: string | null) {
  if (!legacyStatus) return null;
  if (legacyStatus === "DISABLED") return "DISABLED";
  if (legacyStatus === "FAILED" || legacyStatus === "UNAVAILABLE") {
    return "UNAVAILABLE";
  }
  return "CONFIGURED";
}

function inferLegacyOperationalStatus(
  sync: OpenVikingSync,
  legacyStatus: string | null,
  hasInventoryCapabilityLimit: boolean,
) {
  if (legacyStatus === "FAILED" || legacyStatus === "UNAVAILABLE") return "FAILED";
  if (sync.failedCount > 0 || legacyStatus === "DEGRADED") return "DEGRADED";
  if (sync.retryingCount > 0 || sync.queuedCount > 0) return "AVAILABLE";
  if (sync.activeCount > 0) return "HEALTHY";
  if (legacyStatus === "PARTIAL" && !hasInventoryCapabilityLimit) return "DEGRADED";
  if (legacyStatus === "HEALTHY" || legacyStatus === "AVAILABLE") return legacyStatus;
  return "IDLE";
}

function formatConnectionStatus(
  value: string | null | undefined,
  locale: Locale,
  fallback: string,
) {
  const status = value?.trim().toUpperCase();
  const labels: Record<string, [string, string]> = {
    CONFIGURED: ["已配置", "Configured"],
    HEALTHY: ["已连接", "Connected"],
    AVAILABLE: ["已连接", "Connected"],
    MISCONFIGURED: ["配置异常", "Misconfigured"],
    UNAVAILABLE: ["不可用", "Unavailable"],
    DISABLED: ["已关闭", "Disabled"],
    FAILED: ["失败", "Failed"],
  };
  const label = status ? labels[status] : undefined;
  return label ? label[locale === "zh" ? 0 : 1] : fallback;
}

function formatOperationalStatus(
  value: string | null | undefined,
  locale: Locale,
  fallback: string,
) {
  const status = value?.trim().toUpperCase();
  const labels: Record<string, [string, string]> = {
    HEALTHY: ["正常", "Healthy"],
    AVAILABLE: ["可用", "Available"],
    IDLE: ["空闲", "Idle"],
    DEGRADED: ["需要关注", "Needs attention"],
    FAILED: ["失败", "Failed"],
  };
  const label = status ? labels[status] : undefined;
  return label ? label[locale === "zh" ? 0 : 1] : fallback;
}

function formatInventoryCoverage(
  value: string | null | undefined,
  locale: Locale,
  fallback: string,
) {
  const coverage = value?.trim().toUpperCase();
  if (coverage === "FULL") return locale === "zh" ? "完整" : "Full";
  if (coverage === "PARTIAL") return locale === "zh" ? "部分" : "Partial";
  if (coverage === "KNOWN_PROJECTIONS_ONLY") {
    return locale === "zh" ? "仅已知投影" : "Known projections only";
  }
  return fallback;
}

function syncStatusTone(value: string | null | undefined) {
  const status = value?.trim().toUpperCase();
  if (status === "HEALTHY" || status === "AVAILABLE") return "is-success";
  if (status === "DEGRADED") return "is-warning";
  if (status === "FAILED" || status === "UNAVAILABLE") return "is-error";
  return "is-neutral";
}

function capabilityLabel(
  supported: boolean,
  enabled: boolean,
  labels: { supported: string; enabled: string; disabled: string; unsupported: string },
) {
  if (!supported) return labels.unsupported;
  return `${labels.supported} · ${enabled ? labels.enabled : labels.disabled}`;
}

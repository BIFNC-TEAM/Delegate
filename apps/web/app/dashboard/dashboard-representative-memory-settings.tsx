"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { DashboardSurface, type Locale } from "@delegate/web-ui";

import {
  loadMemorySettings,
  MemoryDashboardRequestError,
  updateMemorySettings,
  type MemorySettings,
  type MemorySettingsPolicy,
} from "./dashboard-memory-api";

const copy = {
  zh: {
    eyebrow: "MEMORY POLICY / 06",
    title: "记忆策略、渠道能力与保留边界",
    summary: "这里只管理联系人记忆与代表经验。公开知识继续在知识库中编辑和发布。",
    loading: "正在加载真实记忆设置…",
    unavailable: "记忆设置暂时不可用，页面不会用默认值覆盖服务端状态。",
    retry: "重新加载",
    saved: "记忆设置已保存。",
    conflict: "设置已被其他操作更新，已重新载入最新版本；请确认后再次保存。",
    conflictReloadFailed: "设置已被其他操作更新，但最新版本重新载入失败；为避免覆盖服务端状态，请先重新加载。",
    saveFailed: "保存失败，请重新读取最新设置后再试。",
    basicTitle: "基础策略",
    basicDetail: "关闭长期记忆会同时关闭依赖它的记忆类型、召回和提取能力。",
    longTerm: "启用长期记忆",
    contactMemory: "启用联系人记忆",
    contactDetail: "只允许当前联系人 + 当前代表范围内召回。",
    representativeExperience: "启用代表经验",
    representativeDetail: "必须去标识化并经人工审核后才能召回。",
    autoExtract: "启用自动提取",
    autoExtractDetail: "Web 自动提取仅为联系人记忆创建候选，不会自动批准；未启用联系人记忆时始终关闭。",
    channelsTitle: "渠道能力",
    channelsDetail: "支持状态来自真实运行时能力；未支持的渠道不能开启。",
    channel: "渠道",
    recall: "召回",
    extraction: "提取",
    supported: "支持",
    unsupported: "暂不支持",
    disclosureUnavailable: "首次发送前的记忆披露尚未实现，因此召回与提取均保持关闭。",
    retentionTitle: "保留策略",
    retentionDetail: "到期先停止召回，再按所选行为执行可审计的归档或异步清理。",
    retentionDays: "保存期限（天）",
    expiryAction: "到期行为",
    archive: "归档（可恢复）",
    delete: "删除（异步物理清理）",
    confirmDeleteExpiry: "到期行为改为删除后，过期记忆会停止召回并进入异步物理清理。确认保存吗？",
    confirmDisable: "关闭长期记忆会关闭所有记忆召回和提取。确认保存吗？",
    advancedTitle: "高级设置",
    advancedDetail: "Provider 和检索阈值用于诊断与调优；命名空间和检索目标由服务端生成并锁定。",
    provider: "Provider",
    recallLimit: "单次召回上限",
    recallThreshold: "最低召回阈值",
    namespace: "命名空间",
    target: "检索目标",
    serverManaged: "服务端管理",
    revision: "设置版本",
    updatedAt: "最后更新",
    notConfigured: "尚未保存",
    save: "保存记忆设置",
    saving: "保存中…",
    openMemory: "打开记忆系统",
    openKnowledge: "打开知识库",
  },
  en: {
    eyebrow: "MEMORY POLICY / 06",
    title: "Memory policy, channel capability, and retention",
    summary: "This page manages Contact Memory and Representative Experience only. Public knowledge remains edited and published in the Knowledge Library.",
    loading: "Loading live memory settings…",
    unavailable: "Memory settings are unavailable. The page will not overwrite server state with defaults.",
    retry: "Reload",
    saved: "Memory settings saved.",
    conflict: "Another action changed these settings. The latest version is loaded; review it and save again.",
    conflictReloadFailed: "Another action changed these settings, but the latest version could not be reloaded. Reload before saving to avoid overwriting server state.",
    saveFailed: "Save failed. Reload the latest settings and try again.",
    basicTitle: "Basic policy",
    basicDetail: "Turning off long-term memory also turns off dependent memory types, recall, and extraction.",
    longTerm: "Enable long-term memory",
    contactMemory: "Enable Contact Memory",
    contactDetail: "Recall is isolated to the current contact and representative.",
    representativeExperience: "Enable Representative Experience",
    representativeDetail: "It must be de-identified and manually reviewed before recall.",
    autoExtract: "Enable automatic extraction",
    autoExtractDetail: "Web automatic extraction creates Contact Memory candidates only and never approves them. It remains off unless Contact Memory is enabled.",
    channelsTitle: "Channel capability",
    channelsDetail: "Support reflects live runtime capability. Unsupported channels cannot be enabled.",
    channel: "Channel",
    recall: "Recall",
    extraction: "Extraction",
    supported: "Supported",
    unsupported: "Not supported",
    disclosureUnavailable: "Pre-send memory disclosure is not implemented, so recall and extraction remain off.",
    retentionTitle: "Retention policy",
    retentionDetail: "Expiry stops recall first, then performs the selected auditable archive or asynchronous cleanup.",
    retentionDays: "Retention (days)",
    expiryAction: "Expiry action",
    archive: "Archive (reversible)",
    delete: "Delete (asynchronous physical cleanup)",
    confirmDeleteExpiry: "Changing expiry to delete stops recall and queues asynchronous physical cleanup. Save this policy?",
    confirmDisable: "Turning off long-term memory disables all memory recall and extraction. Save this change?",
    advancedTitle: "Advanced settings",
    advancedDetail: "Provider and recall thresholds support diagnostics and tuning. Namespace and retrieval target are generated and locked by the server.",
    provider: "Provider",
    recallLimit: "Recall limit",
    recallThreshold: "Minimum recall threshold",
    namespace: "Namespace",
    target: "Retrieval target",
    serverManaged: "Server managed",
    revision: "Settings revision",
    updatedAt: "Last updated",
    notConfigured: "Not saved yet",
    save: "Save memory settings",
    saving: "Saving…",
    openMemory: "Open Memory System",
    openKnowledge: "Open Knowledge Library",
  },
} as const;

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
        next.basic.representativeExperienceEnabled = false;
        next.basic.autoExtract = false;
        next.channels.web = { recallEnabled: false, extractEnabled: false };
      }
      if (key === "contactMemoryEnabled" && !enabled) {
        next.basic.autoExtract = false;
        next.channels.web.extractEnabled = false;
      }
      if (
        (key === "contactMemoryEnabled" || key === "representativeExperienceEnabled")
        && !next.basic.contactMemoryEnabled
        && !next.basic.representativeExperienceEnabled
      ) {
        next.channels.web.recallEnabled = false;
      }
      if (key === "autoExtract" && !enabled) {
        next.channels.web.extractEnabled = false;
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
      if (saveError instanceof MemoryDashboardRequestError && saveError.status === 409) {
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
          <span className="memory-system-spinner" aria-hidden="true" />
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
  const memoryHref = `/dashboard?${new URLSearchParams({
    view: "memory",
    rep: representativeSlug,
    lang: locale,
  }).toString()}`;
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
            <PolicyToggle checked={draft.basic.longTermMemoryEnabled} label={t.longTerm} onChange={(checked) => updateBasic("longTermMemoryEnabled", checked)} />
            <PolicyToggle checked={draft.basic.contactMemoryEnabled} detail={t.contactDetail} disabled={!draft.basic.longTermMemoryEnabled} label={t.contactMemory} onChange={(checked) => updateBasic("contactMemoryEnabled", checked)} />
            <PolicyToggle checked={draft.basic.representativeExperienceEnabled} detail={t.representativeDetail} disabled={!draft.basic.longTermMemoryEnabled} label={t.representativeExperience} onChange={(checked) => updateBasic("representativeExperienceEnabled", checked)} />
            <PolicyToggle checked={draft.basic.autoExtract} detail={t.autoExtractDetail} disabled={!draft.basic.longTermMemoryEnabled || !draft.basic.contactMemoryEnabled} label={t.autoExtract} onChange={(checked) => updateBasic("autoExtract", checked)} />
          </div>
        </SettingsGroup>

        <SettingsGroup detail={t.channelsDetail} title={t.channelsTitle}>
          <div className="representative-memory-settings-channel-table">
            <div className="is-heading"><span>{t.channel}</span><span>{t.recall}</span><span>{t.extraction}</span></div>
            <ChannelSettingsRow
              channel="Web"
              extractEnabled={draft.channels.web.extractEnabled}
              extractSupported={snapshot.channels.web.extractSupported}
              onExtract={(checked) => updateDraft((current) => ({ ...current, channels: { ...current.channels, web: { ...current.channels.web, extractEnabled: checked } } }))}
              onRecall={(checked) => updateDraft((current) => ({ ...current, channels: { ...current.channels, web: { ...current.channels.web, recallEnabled: checked } } }))}
              recallEnabled={draft.channels.web.recallEnabled}
              recallSupported={snapshot.channels.web.recallSupported}
              recallDisabled={!draft.basic.longTermMemoryEnabled || !anyMemoryType}
              extractDisabled={!draft.basic.contactMemoryEnabled || !draft.basic.autoExtract}
              locale={locale}
            />
            {(["matrix", "telegram"] as const).map((channel) => (
              <ChannelSettingsRow
                channel={channel === "matrix" ? "Matrix" : "Telegram"}
                detail={t.disclosureUnavailable}
                extractDisabled
                extractEnabled={false}
                extractSupported={snapshot.channels[channel].extractSupported}
                key={channel}
                locale={locale}
                onExtract={() => undefined}
                onRecall={() => undefined}
                recallDisabled
                recallEnabled={false}
                recallSupported={snapshot.channels[channel].recallSupported}
              />
            ))}
          </div>
        </SettingsGroup>

        <SettingsGroup detail={t.retentionDetail} title={t.retentionTitle}>
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

        <SettingsGroup detail={t.advancedDetail} title={t.advancedTitle}>
          <div className="representative-memory-settings-fields">
            <label className="field-stack"><span>{t.provider}</span><input className="text-input" disabled value={draft.advanced.provider} /></label>
            <label className="field-stack"><span>{t.recallLimit}</span><input className="text-input" max={20} min={1} onChange={(event) => updateDraft((current) => ({ ...current, advanced: { ...current.advanced, recallLimit: Number(event.target.value || 1) } }))} type="number" value={draft.advanced.recallLimit} /></label>
            <label className="field-stack"><span>{t.recallThreshold}</span><input className="text-input" max={1} min={0} onChange={(event) => updateDraft((current) => ({ ...current, advanced: { ...current.advanced, recallThreshold: Number(event.target.value || 0) } }))} step="0.01" type="number" value={draft.advanced.recallThreshold} /></label>
            <label className="field-stack"><span>{t.namespace}</span><input className="text-input" disabled value={t.serverManaged} /></label>
            <label className="field-stack"><span>{t.target}</span><input className="text-input" disabled value={t.serverManaged} /></label>
          </div>
        </SettingsGroup>
      </div>

      <div className="representative-memory-settings-meta">
        <span>{t.updatedAt}: {snapshot.updatedAt ? formatDate(snapshot.updatedAt, locale) : t.notConfigured}</span>
      </div>
      <div className="dashboard-action-bar representative-memory-settings-actions">
        <button className="button-primary" disabled={saving || !dirty} onClick={() => void save()} type="button">{saving ? t.saving : t.save}</button>
        <Link className="button-secondary" href={memoryHref}>{t.openMemory}</Link>
        <Link className="button-secondary" href={knowledgeHref}>{t.openKnowledge}</Link>
      </div>
    </DashboardSurface>
  );
}

function SettingsGroup({ children, detail, title }: { children: ReactNode; detail: string; title: string }) {
  return <section className="representative-memory-settings-group"><header><h3>{title}</h3><p>{detail}</p></header>{children}</section>;
}

function PolicyToggle({ checked, detail, disabled = false, label, onChange }: { checked: boolean; detail?: string; disabled?: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <label className="representative-memory-settings-toggle"><input checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} type="checkbox" /><span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span></label>;
}

function ChannelSettingsRow({ channel, detail, extractDisabled, extractEnabled, extractSupported, locale, onExtract, onRecall, recallDisabled, recallEnabled, recallSupported }: { channel: "Web" | "Matrix" | "Telegram"; detail?: string; extractDisabled: boolean; extractEnabled: boolean; extractSupported: boolean; locale: Locale; onExtract: (checked: boolean) => void; onRecall: (checked: boolean) => void; recallDisabled: boolean; recallEnabled: boolean; recallSupported: boolean }) {
  const t = copy[locale];
  return <div className="representative-memory-settings-channel-row"><div><span className={`memory-system-channel is-${channel.toLowerCase()}`}>{channel}</span><small>{detail ?? (recallSupported || extractSupported ? t.supported : t.unsupported)}</small></div><label><input checked={recallEnabled} disabled={recallDisabled || !recallSupported} onChange={(event) => onRecall(event.target.checked)} type="checkbox" /><span>{recallSupported ? t.supported : t.unsupported}</span></label><label><input checked={extractEnabled} disabled={extractDisabled || !extractSupported} onChange={(event) => onExtract(event.target.checked)} type="checkbox" /><span>{extractSupported ? t.supported : t.unsupported}</span></label></div>;
}

export function policyFromSettings(settings: MemorySettings): MemorySettingsPolicy {
  const longTermMemoryEnabled = settings.basic.longTermMemoryEnabled;
  const contactMemoryEnabled = longTermMemoryEnabled
    && settings.basic.contactMemoryEnabled;
  const representativeExperienceEnabled = longTermMemoryEnabled
    && settings.basic.representativeExperienceEnabled;
  const autoExtract = contactMemoryEnabled && settings.basic.autoExtract;
  return {
    basic: {
      longTermMemoryEnabled,
      contactMemoryEnabled,
      representativeExperienceEnabled,
      autoExtract,
    },
    channels: {
      web: {
        recallEnabled: (contactMemoryEnabled || representativeExperienceEnabled)
          && settings.channels.web.recallEnabled,
        extractEnabled: autoExtract && settings.channels.web.extractEnabled,
      },
      matrix: { recallEnabled: false, extractEnabled: false },
      telegram: { recallEnabled: false, extractEnabled: false },
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
      matrix: { recallEnabled: false, extractEnabled: false },
      telegram: { recallEnabled: false, extractEnabled: false },
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
  next.channels.matrix = { recallEnabled: false, extractEnabled: false };
  next.channels.telegram = { recallEnabled: false, extractEnabled: false };
  if (!next.basic.longTermMemoryEnabled) {
    next.basic.contactMemoryEnabled = false;
    next.basic.representativeExperienceEnabled = false;
  }
  if (!next.basic.contactMemoryEnabled) next.basic.autoExtract = false;
  if (!next.basic.contactMemoryEnabled && !next.basic.representativeExperienceEnabled) {
    next.channels.web.recallEnabled = false;
  }
  if (!next.basic.autoExtract) next.channels.web.extractEnabled = false;
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

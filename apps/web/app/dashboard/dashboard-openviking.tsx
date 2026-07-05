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

type OpenVikingSnapshot = {
  representativeSlug: string;
  enabled: boolean;
  agentId: string;
  agentIdOverride?: string;
  autoRecall: boolean;
  autoCapture: boolean;
  captureMode: "semantic" | "keyword";
  recallLimit: number;
  recallScoreThreshold: number;
  targetUri: string;
  resourceSyncEnabled: boolean;
  lastSyncAt?: string;
  lastSyncStatus: string;
  lastSyncItemCount: number;
  lastSyncError?: string;
  health: {
    status: "healthy" | "degraded" | "disabled";
    detail: string;
    mode: "local" | "remote";
    baseUrl: string;
    consoleUrl?: string;
  };
  recentSyncJobs: Array<{
    id: string;
    status: string;
    itemCount: number;
    error?: string;
    startedAt: string;
    finishedAt?: string;
  }>;
  recentCommitTraces: Array<{
    id: string;
    sessionId: string;
    sessionKey?: string;
    reason: string;
    status: string;
    memoriesExtracted?: number;
    createdAt: string;
    error?: string;
  }>;
};

type RecallTrace = {
  id: string;
  queryText: string;
  recalledUri: string;
  contextType: string;
  layer: string;
  score: number;
  createdAt: string;
};

type MemoryPreview = {
  id: string;
  uri: string;
  scope: string;
  category: string;
  summary: string;
  sourceKind: string;
  createdAt: string;
  contact?: {
    id: string;
    displayName: string;
  };
};

export function DashboardOpenViking({
  representativeSlug,
  locale,
}: {
  representativeSlug: string;
  locale: Locale;
}) {
  const t = pickCopy(locale, copy);
  const [snapshot, setSnapshot] = useState<OpenVikingSnapshot | null>(null);
  const [recallTraces, setRecallTraces] = useState<RecallTrace[]>([]);
  const [memories, setMemories] = useState<MemoryPreview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void refreshAll(representativeSlug, setSnapshot, setRecallTraces, setMemories, setError);
  }, [representativeSlug]);

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

  function triggerSync(trigger: "manual" | "retry") {
    setBusyKey(trigger);
    setMessage(null);
    setError(null);

    startTransition(() => {
      void (async () => {
        const response = await fetch(
          `/api/dashboard/representatives/${representativeSlug}/openviking/sync`,
          {
            method: "POST",
          },
        );

        if (!response.ok) {
          throw new Error(await extractError(response));
        }

        await refreshAll(representativeSlug, setSnapshot, setRecallTraces, setMemories, setError);
        setMessage(trigger === "retry" ? t.retryDone : t.resynced);
      })()
        .catch((nextError: unknown) => {
          setError(nextError instanceof Error ? nextError.message : t.syncError);
        })
        .finally(() => {
          setBusyKey(null);
        });
    });
  }

  return (
    <DashboardPanelFrame
      eyebrow={t.panelEyebrow}
      id="memory"
      summary={t.panelSummary}
      title={t.panelTitle}
    >
      <div className="dashboard-panel-hero">
        <article className="dashboard-highlight-card dashboard-highlight-card-primary">
          <p className="panel-title">{t.heroKicker}</p>
          <h3>{snapshot.enabled ? t.heroEnabled : t.heroDisabled}</h3>
          <p>{snapshot.health.detail}</p>
          <div className="chip-row">
            <span className="chip">{snapshot.health.mode}</span>
            <span
              className={
                snapshot.health.status === "healthy"
                  ? "chip chip-safe"
                  : snapshot.health.status === "disabled"
                    ? "chip"
                    : "chip chip-danger"
              }
            >
              {snapshot.health.status}
            </span>
            <span className="chip">{snapshot.lastSyncStatus}</span>
          </div>
        </article>

        <DashboardSignalStrip
          cards={[
            {
              label: "Agent ID",
              value: snapshot.agentIdOverride ?? snapshot.agentId,
              detail: t.agentIdDetail,
              tone: "accent" as const,
            },
            {
              label: t.recallLimitLabel,
              value: `${snapshot.recallLimit}`,
              detail: t.recallLimitDetail,
            },
            {
              label: t.captureModeLabel,
              value: snapshot.captureMode,
              detail: t.captureModeDetail,
              tone: snapshot.autoCapture ? ("safe" as const) : "default",
            },
            {
              label: t.syncedItemsLabel,
              value: `${snapshot.lastSyncItemCount}`,
              detail: t.syncedItemsDetail,
            },
          ]}
        />
      </div>

      {message ? <div className="status-banner status-success">{message}</div> : null}
      {error ? <div className="status-banner status-error">{error}</div> : null}

      <div className="dashboard-action-bar">
        <button
          className="button-primary"
          disabled={isPending || busyKey === "manual"}
          onClick={() => triggerSync("manual")}
          type="button"
        >
          {busyKey === "manual" ? t.syncing : t.resync}
        </button>
        <button
          className="button-secondary"
          disabled={isPending || busyKey === "retry"}
          onClick={() => triggerSync("retry")}
          type="button"
        >
          {busyKey === "retry" ? t.retrying : t.retry}
        </button>
        {snapshot.health.consoleUrl ? (
          <a
            className="button-secondary"
            href={snapshot.health.consoleUrl}
            rel="noreferrer"
            target="_blank"
          >
            {t.openConsole}
          </a>
        ) : null}
      </div>

      <DashboardSignalStrip
        cards={[
          {
            label: "Health",
            value: snapshot.health.status,
            detail: snapshot.health.detail,
            tone:
              snapshot.health.status === "healthy"
                ? ("safe" as const)
                : snapshot.health.status === "degraded"
                  ? ("accent" as const)
                  : "default",
          },
          {
            label: t.autoRecallLabel,
            value: snapshot.autoRecall ? t.enabled : t.off,
            detail: t.autoRecallDetail,
          },
          {
            label: t.autoCaptureLabel,
            value: snapshot.autoCapture ? t.enabled : t.off,
            detail: t.autoCaptureDetail,
          },
          {
            label: t.targetUriLabel,
            value: snapshot.targetUri,
            detail: t.targetUriDetail,
          },
        ]}
      />

      <DashboardSurfaceGrid columns={2}>
        <DashboardSurface
          eyebrow={t.syncEyebrow}
          meta={<span className="chip">{snapshot.recentSyncJobs.length} jobs</span>}
          title={t.syncTitle}
        >
          <div className="row-list">
            {snapshot.recentSyncJobs.length ? (
              snapshot.recentSyncJobs.map((job) => (
                <div className="skill-row" key={job.id}>
                  <div>
                    <strong>{job.status}</strong>
                    <p>
                      {job.itemCount} items · started {formatTimestamp(job.startedAt)}
                    </p>
                    <p className="footer-note">
                      {job.finishedAt ? `${t.finishedAt} ${formatTimestamp(job.finishedAt)}` : t.stillRunning}
                    </p>
                    {job.error ? <p className="footer-note">{t.errorLabel(job.error)}</p> : null}
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">{t.noSyncJobs}</p>
            )}
          </div>
        </DashboardSurface>

        <DashboardSurface
          eyebrow={t.commitEyebrow}
          meta={<span className="chip">{snapshot.recentCommitTraces.length} traces</span>}
          title={t.commitTitle}
        >
          <div className="row-list">
            {snapshot.recentCommitTraces.length ? (
              snapshot.recentCommitTraces.map((trace) => (
                <div className="skill-row" key={trace.id}>
                  <div>
                    <strong>{trace.reason}</strong>
                    <p>
                      {trace.status} · session {trace.sessionId}
                    </p>
                    <div className="chip-row">
                      <span className="chip">{formatTimestamp(trace.createdAt)}</span>
                      {typeof trace.memoriesExtracted === "number" ? (
                        <span className="chip chip-safe">{t.memoriesChip(trace.memoriesExtracted)}</span>
                      ) : null}
                    </div>
                    {trace.sessionKey ? (
                      <p className="footer-note">{t.sessionKeyLabel(trace.sessionKey)}</p>
                    ) : null}
                    {trace.error ? <p className="footer-note">{t.errorLabel(trace.error)}</p> : null}
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">{t.noCommitTraces}</p>
            )}
          </div>
        </DashboardSurface>

        <DashboardSurface
          eyebrow={t.recallEyebrow}
          meta={<span className="chip">{recallTraces.length} traces</span>}
          title={t.recallTitle}
        >
          <div className="row-list">
            {recallTraces.length ? (
              recallTraces.map((trace) => (
                <div className="skill-row" key={trace.id}>
                  <div>
                    <strong>{trace.queryText}</strong>
                    <p>{trace.recalledUri}</p>
                    <div className="chip-row">
                      <span className="chip">{trace.contextType}</span>
                      <span className="chip">{trace.layer}</span>
                      <span className="chip chip-safe">{trace.score.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">{t.noRecallTraces}</p>
            )}
          </div>
        </DashboardSurface>

        <DashboardSurface
          eyebrow={t.memoryEyebrow}
          meta={<span className="chip">{memories.length} memories</span>}
          title={t.memoryTitle}
        >
          <div className="row-list">
            {memories.length ? (
              memories.map((memory) => (
                <div className="skill-row" key={memory.id}>
                  <div>
                    <strong>
                      {memory.contact ? `${memory.contact.displayName} · ` : ""}
                      {memory.category}
                    </strong>
                    <p>{memory.summary}</p>
                    <div className="chip-row">
                      <span className="chip">{memory.scope}</span>
                      <span className="chip">{memory.sourceKind}</span>
                      <span className="chip">{formatTimestamp(memory.createdAt)}</span>
                    </div>
                    <p className="footer-note">{memory.uri}</p>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">{t.noMemories}</p>
            )}
          </div>
        </DashboardSurface>
      </DashboardSurfaceGrid>
    </DashboardPanelFrame>
  );
}

async function refreshAll(
  representativeSlug: string,
  setSnapshot: (value: OpenVikingSnapshot) => void,
  setRecallTraces: (value: RecallTrace[]) => void,
  setMemories: (value: MemoryPreview[]) => void,
  setError: (value: string | null) => void,
) {
  const [snapshotResponse, tracesResponse, memoriesResponse] = await Promise.all([
    fetch(`/api/dashboard/representatives/${representativeSlug}/openviking`, {
      cache: "no-store",
    }),
    fetch(`/api/dashboard/representatives/${representativeSlug}/openviking/recall-traces`, {
      cache: "no-store",
    }),
    fetch(`/api/dashboard/representatives/${representativeSlug}/openviking/memories`, {
      cache: "no-store",
    }),
  ]);

  if (!snapshotResponse.ok) {
    setError(await extractError(snapshotResponse));
    return;
  }

  if (!tracesResponse.ok) {
    setError(await extractError(tracesResponse));
    return;
  }

  if (!memoriesResponse.ok) {
    setError(await extractError(memoriesResponse));
    return;
  }

  const snapshot = (await snapshotResponse.json()) as OpenVikingSnapshot;
  const tracesPayload = (await tracesResponse.json()) as { traces: RecallTrace[] };
  const memoriesPayload = (await memoriesResponse.json()) as { memories: MemoryPreview[] };

  setSnapshot(snapshot);
  setRecallTraces(tracesPayload.traces);
  setMemories(memoriesPayload.memories);
  setError(null);
}

async function extractError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `Request failed with status ${response.status}.`;
  } catch {
    return `Request failed with status ${response.status}.`;
  }
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

const copy = {
  zh: {
    loadingTitle: "记忆控制台加载中",
    loadingHeadline: "正在读取 OpenViking 的 sync、recall、commit 和 memory preview。",
    loadingCopy: "完成后会优先展示健康状态和最近的运行痕迹。",
    retryDone: "重试同步已完成。",
    resynced: "代表公开知识已重新同步。",
    syncError: "OpenViking 同步失败。",
    panelEyebrow: "OpenViking Console",
    panelSummary: "这里展示 OpenViking 最近的资源同步、recall provenance、session commit 和记忆摘要。",
    panelTitle: "把 recall / commit / memory preview 变成 owner 可操作的控制面板",
    heroKicker: "Memory runtime",
    heroEnabled: "这层记忆已经接到代表工作流里。",
    heroDisabled: "这层记忆目前处于关闭状态。",
    agentIdDetail: "代表级的 session 和记忆命名空间标识。",
    recallLimitLabel: "Recall limit",
    recallLimitDetail: "默认一次回复可召回的上下文数量上限。",
    captureModeLabel: "Capture mode",
    captureModeDetail: "当前的自动记忆提取模式。",
    syncedItemsLabel: "Synced items",
    syncedItemsDetail: "最近一次知识同步写入的资源数量。",
    syncing: "同步中...",
    resync: "重新同步公开知识",
    retrying: "重试中...",
    retry: "重试失败同步",
    openConsole: "打开 OpenViking 控制台",
    autoRecallLabel: "Auto recall",
    enabled: "启用",
    off: "关闭",
    autoRecallDetail: "是否在回复前自动召回代表级上下文。",
    autoCaptureLabel: "Auto capture",
    autoCaptureDetail: "是否在关键会话节点自动提交公开安全记忆。",
    targetUriLabel: "Target URI",
    targetUriDetail: "当前资源同步与召回默认使用的命名空间前缀。",
    syncEyebrow: "Sync",
    syncTitle: "最近 sync jobs",
    finishedAt: "完成于",
    stillRunning: "仍在运行",
    errorLabel: (value: string) => `错误: ${value}`,
    noSyncJobs: "还没有任何 OpenViking sync job。",
    commitEyebrow: "Commit",
    commitTitle: "最近 commit traces",
    memoriesChip: (count: number) => `${count} memories`,
    sessionKeyLabel: (value: string) => `Session key: ${value}`,
    noCommitTraces: "还没有任何 OpenViking commit trace。",
    recallEyebrow: "Recall",
    recallTitle: "最近 recall traces",
    noRecallTraces: "还没有任何 recall provenance 记录。",
    memoryEyebrow: "Memory preview",
    memoryTitle: "已提取记忆预览",
    noMemories: "还没有任何可展示的公开安全记忆摘要。",
  },
  en: {
    loadingTitle: "Loading memory console",
    loadingHeadline: "Fetching OpenViking sync, recall, commit, and memory preview data.",
    loadingCopy: "Health and recent runtime traces appear first.",
    retryDone: "Retry sync completed.",
    resynced: "Representative knowledge re-synced.",
    syncError: "OpenViking sync failed.",
    panelEyebrow: "OpenViking Console",
    panelSummary: "This panel shows recent OpenViking resource sync, recall provenance, session commits, and memory summaries.",
    panelTitle: "Turn recall, commit, and memory preview into an owner-operable control surface",
    heroKicker: "Memory runtime",
    heroEnabled: "This memory layer is active in the representative workflow.",
    heroDisabled: "This memory layer is currently disabled.",
    agentIdDetail: "Representative-level session and memory namespace identifier.",
    recallLimitLabel: "Recall limit",
    recallLimitDetail: "How many context items may be recalled before a response by default.",
    captureModeLabel: "Capture mode",
    captureModeDetail: "The current automatic memory extraction mode.",
    syncedItemsLabel: "Synced items",
    syncedItemsDetail: "Resources written in the most recent knowledge sync.",
    syncing: "Syncing...",
    resync: "Resync public knowledge",
    retrying: "Retrying...",
    retry: "Retry failed sync",
    openConsole: "Open OpenViking Console",
    autoRecallLabel: "Auto recall",
    enabled: "Enabled",
    off: "Off",
    autoRecallDetail: "Whether representative-scoped context is recalled automatically before responses.",
    autoCaptureLabel: "Auto capture",
    autoCaptureDetail: "Whether public-safe memory is committed automatically at key workflow points.",
    targetUriLabel: "Target URI",
    targetUriDetail: "Namespace prefix used by sync and recall flows.",
    syncEyebrow: "Sync",
    syncTitle: "Recent sync jobs",
    finishedAt: "Finished",
    stillRunning: "Still running",
    errorLabel: (value: string) => `Error: ${value}`,
    noSyncJobs: "There are no OpenViking sync jobs yet.",
    commitEyebrow: "Commit",
    commitTitle: "Recent commit traces",
    memoriesChip: (count: number) => `${count} memories`,
    sessionKeyLabel: (value: string) => `Session key: ${value}`,
    noCommitTraces: "There are no OpenViking commit traces yet.",
    recallEyebrow: "Recall",
    recallTitle: "Recent recall traces",
    noRecallTraces: "There is no recall provenance yet.",
    memoryEyebrow: "Memory preview",
    memoryTitle: "Extracted memory preview",
    noMemories: "There are no public-safe memory summaries to preview yet.",
  },
} as const;

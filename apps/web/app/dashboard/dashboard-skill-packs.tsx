"use client";

import type { FormEvent } from "react";
import { useEffect, useState, useTransition } from "react";

import {
  DashboardPanelFrame,
  DashboardSignalStrip,
  DashboardSurface,
  DashboardSurfaceGrid,
  pickCopy,
  type Locale,
} from "@delegate/web-ui";

type DashboardSkillPack = {
  linkId: string;
  id: string;
  slug: string;
  displayName: string;
  source: "builtin" | "owner_upload" | "clawhub";
  summary: string;
  version?: string;
  sourceUrl?: string;
  ownerHandle?: string;
  verificationTier?: string;
  capabilityTags: string[];
  executesCode: boolean;
  enabled: boolean;
  installStatus: "available" | "installed" | "update_available";
  installedAt?: string;
};

type DashboardSnapshot = {
  representative: {
    slug: string;
    displayName: string;
    roleSummary: string;
    groupActivation: "mention_only" | "reply_or_mention" | "always";
    humanInLoop: boolean;
    publicMode: boolean;
  };
  skillPacks: DashboardSkillPack[];
};

type SearchResponse = {
  results: Array<Omit<DashboardSkillPack, "linkId" | "enabled" | "installStatus" | "installedAt"> & {
    enabled: boolean;
    installStatus: "available" | "installed" | "update_available";
  }>;
};

export function DashboardSkillPacks({
  representativeSlug,
  locale,
}: {
  representativeSlug: string;
  locale: Locale;
}) {
  const t = pickCopy(locale, copy);
  const groupActivationLabels =
    locale === "zh"
      ? {
          mention_only: "仅 mention",
          reply_or_mention: "reply 或 mention",
          always: "始终响应",
        }
      : {
          mention_only: "mention only",
          reply_or_mention: "reply or mention",
          always: "always on",
        };
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [results, setResults] = useState<SearchResponse["results"]>([]);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void Promise.all([refreshSnapshot(representativeSlug, setSnapshot, setError), loadResults("")]).catch(
      (nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : t.loadError);
      },
    );
  }, [representativeSlug, t.loadError]);

  const enabledCount = snapshot?.skillPacks.filter((skillPack) => skillPack.enabled).length ?? 0;
  const builtinCount =
    snapshot?.skillPacks.filter((skillPack) => skillPack.source === "builtin").length ?? 0;
  const clawHubCount =
    snapshot?.skillPacks.filter((skillPack) => skillPack.source === "clawhub").length ?? 0;
  const signalCards = snapshot
    ? [
        {
          label: t.signalCards.trackedLabel,
          value: `${snapshot.skillPacks.length}`,
          detail: t.signalCards.trackedDetail,
          tone: "accent" as const,
        },
        {
          label: t.signalCards.enabledLabel,
          value: `${enabledCount}`,
          detail: t.signalCards.enabledDetail,
          tone: "safe" as const,
        },
        {
          label: "ClawHub",
          value: `${clawHubCount}`,
          detail: t.signalCards.clawHubDetail,
        },
        {
          label: t.signalCards.searchResultsLabel,
          value: `${results.length}`,
          detail: t.signalCards.searchResultsDetail,
        },
      ]
    : [];

  async function loadResults(nextQuery: string) {
    const searchParams = new URLSearchParams();
    if (nextQuery.trim()) {
      searchParams.set("query", nextQuery.trim());
    }

    const response = await fetch(`/api/registry/clawhub/skills?${searchParams.toString()}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(await extractError(response));
    }

    const payload = (await response.json()) as SearchResponse;
    setResults(payload.results);
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    startTransition(() => {
      void loadResults(query).catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : t.searchError);
      });
    });
  }

  function handleInstall(skillPackSlug: string) {
    setBusyKey(`install:${skillPackSlug}`);
    setMessage(null);
    setError(null);
    startTransition(() => {
      void (async () => {
        const response = await fetch(
          `/api/dashboard/representatives/${representativeSlug}/skill-packs`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ skillPackSlug }),
          },
        );
        if (!response.ok) {
          throw new Error(await extractError(response));
        }

        await Promise.all([
          refreshSnapshot(representativeSlug, setSnapshot, setError),
          loadResults(query),
        ]);
        setMessage(t.installedMessage(skillPackSlug, representativeSlug));
      })()
        .catch((nextError: unknown) => {
          setError(nextError instanceof Error ? nextError.message : t.installError);
        })
        .finally(() => {
          setBusyKey(null);
        });
    });
  }

  function handleToggle(linkId: string, nextEnabled: boolean, label: string) {
    setBusyKey(`toggle:${linkId}`);
    setMessage(null);
    setError(null);
    startTransition(() => {
      void (async () => {
        const response = await fetch(
          `/api/dashboard/representatives/${representativeSlug}/skill-packs/${linkId}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ enabled: nextEnabled }),
          },
        );

        if (!response.ok) {
          throw new Error(await extractError(response));
        }

        await refreshSnapshot(representativeSlug, setSnapshot, setError);
        setMessage(`${nextEnabled ? t.enabled : t.disabled} ${label}.`);
      })()
        .catch((nextError: unknown) => {
          setError(nextError instanceof Error ? nextError.message : t.toggleError);
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
      eyebrow={t.panelEyebrow}
      id="skills"
      summary={t.panelSummary}
      title={t.panelTitle}
    >
      <div className="dashboard-panel-hero">
        <article className="dashboard-highlight-card dashboard-highlight-card-primary">
          <p className="panel-title">{t.heroKicker}</p>
          <h3>{snapshot.representative.displayName}</h3>
          <p>{snapshot.representative.roleSummary}</p>
          <div className="chip-row">
            <span className="chip">{t.trackedPacks(snapshot.skillPacks.length)}</span>
            <span className="chip chip-safe">
              {groupActivationLabels[snapshot.representative.groupActivation]}
            </span>
            <span className="chip">
              {snapshot.representative.humanInLoop ? t.humanLoopOn : t.humanLoopOff}
            </span>
          </div>
        </article>

        <DashboardSignalStrip cards={signalCards} />
      </div>

      {message ? <div className="status-banner status-success">{message}</div> : null}
      {error ? <div className="status-banner status-error">{error}</div> : null}

      <DashboardSignalStrip
        cards={[
          {
            label: t.builtInLabel,
            value: `${builtinCount}`,
            detail: t.builtInDetail,
          },
          {
            label: t.groupActivationLabel,
            value: groupActivationLabels[snapshot.representative.groupActivation],
            detail: t.groupActivationDetail,
            tone: "safe" as const,
          },
          {
            label: t.publicModeLabel,
            value: snapshot.representative.publicMode ? t.publicLabel : t.privateLabel,
            detail: t.publicModeDetail,
          },
          {
            label: t.humanLoopLabel,
            value: snapshot.representative.humanInLoop ? t.enabled : t.off,
            detail: t.humanLoopDetail,
            tone: snapshot.representative.humanInLoop ? ("safe" as const) : "default",
          },
        ]}
      />

      <DashboardSurfaceGrid>
        <DashboardSurface
          eyebrow={t.currentWorkspaceEyebrow}
          meta={<span className="chip chip-safe">{t.enabledChip(enabledCount)}</span>}
          title={t.currentWorkspaceTitle}
        >
          <div className="row-list">
            {snapshot.skillPacks.length ? (
              snapshot.skillPacks.map((skillPack) => (
                <div className="skill-row" key={skillPack.linkId}>
                  <div>
                    <strong>{skillPack.displayName}</strong>
                    <p>{skillPack.summary}</p>
                    <div className="chip-row">
                      <span className="chip">{skillPack.source}</span>
                      <span className="chip">{skillPack.installStatus}</span>
                      {skillPack.version ? <span className="chip">v{skillPack.version}</span> : null}
                      {skillPack.verificationTier ? (
                        <span className="chip chip-safe">{skillPack.verificationTier}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="button-row button-row-stretch">
                    {skillPack.sourceUrl ? (
                      <a className="button-secondary" href={skillPack.sourceUrl} target="_blank" rel="noreferrer">
                        {t.viewSource}
                      </a>
                    ) : null}
                    <button
                      className={skillPack.enabled ? "button-secondary" : "button-primary"}
                      disabled={isPending || busyKey === `toggle:${skillPack.linkId}`}
                      onClick={() =>
                        handleToggle(skillPack.linkId, !skillPack.enabled, skillPack.displayName)
                      }
                      type="button"
                    >
                      {busyKey === `toggle:${skillPack.linkId}`
                        ? t.saving
                        : skillPack.enabled
                          ? t.disable
                          : t.enable}
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">{t.noTrackedPacks}</p>
            )}
          </div>
        </DashboardSurface>

        <DashboardSurface
          eyebrow={t.expansionEyebrow}
          meta={<span className="chip">{results.length} results</span>}
          title={t.expansionTitle}
        >

          <form className="search-form" onSubmit={handleSearchSubmit}>
            <input
              className="text-input"
              name="query"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t.searchPlaceholder}
              value={query}
            />
            <button className="button-primary" disabled={isPending} type="submit">
              {isPending ? t.searching : t.search}
            </button>
          </form>

          <div className="row-list">
            {results.map((result) => {
              const alreadyTracked = snapshot?.skillPacks.some(
                (skillPack) =>
                  skillPack.source === result.source && skillPack.slug === result.slug,
              );

              return (
                <div className="skill-row" key={`${result.source}:${result.slug}`}>
                  <div>
                    <strong>{result.displayName}</strong>
                    <p>{result.summary}</p>
                    <div className="chip-row">
                      <span className="chip">{result.source}</span>
                      {result.version ? <span className="chip">v{result.version}</span> : null}
                      {result.ownerHandle ? <span className="chip">@{result.ownerHandle}</span> : null}
                    </div>
                  </div>
                  <div className="button-row button-row-stretch">
                    {result.sourceUrl ? (
                      <a className="button-secondary" href={result.sourceUrl} target="_blank" rel="noreferrer">
                        {t.open}
                      </a>
                    ) : null}
                    <button
                      className="button-primary"
                      disabled={
                        isPending || alreadyTracked || busyKey === `install:${result.slug}`
                      }
                      onClick={() => handleInstall(result.slug)}
                      type="button"
                    >
                      {alreadyTracked
                        ? t.tracked
                        : busyKey === `install:${result.slug}`
                          ? t.installing
                          : t.install}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </DashboardSurface>
      </DashboardSurfaceGrid>
    </DashboardPanelFrame>
  );
}

async function refreshSnapshot(
  representativeSlug: string,
  setSnapshot: (value: DashboardSnapshot) => void,
  setError: (value: string | null) => void,
) {
  const response = await fetch(`/api/dashboard/representatives/${representativeSlug}/skill-packs`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(await extractError(response));
  }

  const payload = (await response.json()) as DashboardSnapshot;
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

const copy = {
  zh: {
    loadError: "加载 dashboard 数据失败。",
    searchError: "搜索 ClawHub 失败。",
    installedMessage: (slug: string, rep: string) => `已为 ${rep} 安装 ${slug}。`,
    installError: "安装技能包失败。",
    signalCards: {
      trackedLabel: "Tracked packs",
      trackedDetail: "当前代表已经纳入治理范围的技能包总数。",
      enabledLabel: "Enabled",
      enabledDetail: "这些 pack 才真正进入代表运行时。",
      clawHubDetail: "来自 ClawHub 的扩展来源，需要显式启用。",
      searchResultsLabel: "Search results",
      searchResultsDetail: "当前搜索面板返回的可安装候选。",
    },
    enabled: "启用",
    disabled: "停用",
    toggleError: "更新技能包状态失败。",
    loadingTitle: "技能加载中",
    loadingHeadline: "正在读取代表已安装的 skill packs 和 ClawHub 搜索结果。",
    loadingCopy: "完成后会先展示当前代表已追踪的 pack，再给出扩展入口。",
    panelEyebrow: "Skill Packs",
    panelSummary: "这里只安装来源和元数据，不执行远程代码。每个 pack 都需要显式启用，才会进入代表运行时。",
    panelTitle: "从 ClawHub 发现技能包，再按代表边界启用",
    heroKicker: "Representative boundary",
    trackedPacks: (count: number) => `${count} packs tracked`,
    humanLoopOn: "human in loop",
    humanLoopOff: "ai only",
    builtInLabel: "Built in",
    builtInDetail: "内建能力包，默认更稳定更可控。",
    groupActivationLabel: "Group activation",
    groupActivationDetail: "群组里默认采用的谨慎触发策略。",
    publicModeLabel: "Public mode",
    publicLabel: "Public",
    privateLabel: "Private",
    publicModeDetail: "是否以公开代表模式对外开放。",
    humanLoopLabel: "Human loop",
    off: "关闭",
    humanLoopDetail: "高价值升级是否可以转入人工接手。",
    currentWorkspaceEyebrow: "Current workspace",
    enabledChip: (count: number) => `${count} enabled`,
    currentWorkspaceTitle: "Installed on this representative",
    viewSource: "查看来源",
    saving: "保存中...",
    disable: "停用",
    enable: "启用",
    noTrackedPacks: "还没有任何已追踪的技能包。",
    expansionEyebrow: "Expansion",
    expansionTitle: "在 ClawHub 上发现",
    searchPlaceholder: "搜索代表技能包",
    searching: "搜索中...",
    search: "搜索",
    open: "打开",
    tracked: "已追踪",
    installing: "安装中...",
    install: "安装",
  },
  en: {
    loadError: "Failed to load dashboard data.",
    searchError: "Failed to search ClawHub.",
    installedMessage: (slug: string, rep: string) => `Installed ${slug} for ${rep}.`,
    installError: "Failed to install the selected skill pack.",
    signalCards: {
      trackedLabel: "Tracked packs",
      trackedDetail: "The total number of packs already governed by this representative.",
      enabledLabel: "Enabled",
      enabledDetail: "Only these packs actually enter the representative runtime.",
      clawHubDetail: "Expansion sources discovered from ClawHub that still require explicit enablement.",
      searchResultsLabel: "Search results",
      searchResultsDetail: "Installable candidates returned by the current search.",
    },
    enabled: "Enabled",
    disabled: "Disabled",
    toggleError: "Failed to update representative skill pack state.",
    loadingTitle: "Loading skills",
    loadingHeadline: "Fetching tracked skill packs and ClawHub search results.",
    loadingCopy: "The dashboard will show what this representative already governs before showing expansion candidates.",
    panelEyebrow: "Skill Packs",
    panelSummary: "Delegate installs source metadata here, not remote execution. Every pack must be explicitly enabled before it enters the representative runtime.",
    panelTitle: "Discover skill packs on ClawHub, then enable them inside representative boundaries",
    heroKicker: "Representative boundary",
    trackedPacks: (count: number) => `${count} packs tracked`,
    humanLoopOn: "human in loop",
    humanLoopOff: "ai only",
    builtInLabel: "Built in",
    builtInDetail: "Builtin packs are usually the most stable and controllable.",
    groupActivationLabel: "Group activation",
    groupActivationDetail: "The conservative default policy used inside groups.",
    publicModeLabel: "Public mode",
    publicLabel: "Public",
    privateLabel: "Private",
    publicModeDetail: "Whether this representative is publicly available.",
    humanLoopLabel: "Human loop",
    off: "Off",
    humanLoopDetail: "Whether high-value escalations can move into direct owner handling.",
    currentWorkspaceEyebrow: "Current workspace",
    enabledChip: (count: number) => `${count} enabled`,
    currentWorkspaceTitle: "Installed on this representative",
    viewSource: "View source",
    saving: "Saving...",
    disable: "Disable",
    enable: "Enable",
    noTrackedPacks: "No tracked skill packs yet.",
    expansionEyebrow: "Expansion",
    expansionTitle: "Discover on ClawHub",
    searchPlaceholder: "Search representative skill packs",
    searching: "Searching...",
    search: "Search",
    open: "Open",
    tracked: "Tracked",
    installing: "Installing...",
    install: "Install",
  },
} as const;

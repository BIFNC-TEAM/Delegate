"use client";

import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Locale } from "@delegate/web-ui";

import { getGovernedContextSyncPresentation } from "./dashboard-governed-context-status";

type TrainingSource = {
  id: string;
  kind: "url" | "pdf" | "text" | "notion" | "drive" | "website";
  status: "draft" | "active" | "disabled" | "failed";
  title: string;
  updatedAt: string;
};

type FeedbackSignal = {
  id: string;
  signalType: "approve" | "correction" | "do_not_say" | "suggested_answer";
  publicSafe: boolean;
  createdAt: string;
};

type TrainingSuggestion = {
  id: string;
  sourceId: string | null;
  feedbackSignalId: string | null;
  suggestionType:
    | "faq_update"
    | "policy_update"
    | "material_update"
    | "tone_rule"
    | "skill_recommendation"
    | "knowledge_gap";
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "private"
    | "published"
    | "superseded";
  title: string;
  draftPayload: unknown;
  riskLevel: string;
  createdAt: string;
};

type TrainingVersion = {
  id: string;
  title: string;
  status: "published" | "rolled_back";
  ownerReviewed: boolean;
  publishedAt: string;
  rolledBackAt: string | null;
};

type TrainingWorkflow = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  scheduledAt: string;
  createdAt: string;
};

type TrainingSnapshot = {
  sources: TrainingSource[];
  feedbackSignals: FeedbackSignal[];
  suggestions: TrainingSuggestion[];
  versions: TrainingVersion[];
  latestWorkflow: TrainingWorkflow | null;
  summary: {
    availableSourceCount: number;
    pendingFeedbackCount: number;
    pendingSuggestionCount: number;
    appliedVersionCount: number;
  };
};

type GovernedContextSettings = {
  enabled: boolean;
  autoRecall: boolean;
  recallLimit: number;
  recallScoreThreshold: number;
  publicKnowledgeSyncAvailable: boolean;
  lastSyncAt?: string;
  lastSyncStatus: string;
  lastSyncItemCount: number;
};

type GovernedMemory = {
  id: string;
  contactDisplayLabel: string;
  summary: string;
  status: "ACTIVE" | "SUPPRESSED" | "DELETE_PENDING" | "DELETED" | "DELETE_FAILED";
  createdAt: string;
};

type GovernanceSnapshot = {
  settings: GovernedContextSettings;
  memories: GovernedMemory[];
  usageCount: number;
};

type SourceKind = "url" | "text";
type ReviewAction = "approve" | "reject" | "private";
type MemoryAction = "suppress" | "delete" | "retry";

export function DashboardTraining({
  representativeSlug,
  locale,
}: {
  representativeSlug: string;
  locale: Locale;
}) {
  const zh = locale === "zh";
  const t = zh ? zhCopy : enCopy;
  const [snapshot, setSnapshot] = useState<TrainingSnapshot | null>(null);
  const [governance, setGovernance] = useState<GovernanceSnapshot | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [governanceLoading, setGovernanceLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [governanceBusyKey, setGovernanceBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [governanceError, setGovernanceError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sourceKind, setSourceKind] = useState<SourceKind>("url");
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceValue, setSourceValue] = useState("");
  const [knowledgeGapAnswers, setKnowledgeGapAnswers] = useState<Record<string, string>>({});

  const refresh = useCallback(async (showRefreshState = true) => {
    if (showRefreshState) setRefreshing(true);
    try {
      const nextSnapshot = await fetchTrainingSnapshot(
        representativeSlug,
        locale,
        t.loadingError,
      );
      setSnapshot(nextSnapshot);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t.loadingError);
    } finally {
      setInitialLoading(false);
      if (showRefreshState) setRefreshing(false);
    }
  }, [locale, representativeSlug, t.loadingError]);

  const refreshGovernance = useCallback(async (showRefreshState = true) => {
    if (showRefreshState) setGovernanceLoading(true);
    try {
      const nextGovernance = await fetchGovernanceSnapshot(representativeSlug);
      setGovernance(nextGovernance);
      setGovernanceError(null);
    } catch {
      setGovernanceError(t.governanceLoadingError);
    } finally {
      setGovernanceLoading(false);
    }
  }, [representativeSlug, t.governanceLoadingError]);

  useEffect(() => {
    setSnapshot(null);
    setGovernance(null);
    setInitialLoading(true);
    setGovernanceLoading(true);
    setError(null);
    setGovernanceError(null);
    setNotice(null);
    setKnowledgeGapAnswers({});
    void refresh(false);
    void refreshGovernance(false);
  }, [refresh, refreshGovernance]);

  const workflowActive =
    snapshot?.latestWorkflow?.status === "queued"
    || snapshot?.latestWorkflow?.status === "running";

  useEffect(() => {
    if (!workflowActive) return;
    const timer = window.setInterval(() => {
      void refresh(false);
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [refresh, workflowActive]);

  const rollbackCandidateId = useMemo(
    () => snapshot?.versions.find((version) => version.status === "published")?.id ?? null,
    [snapshot?.versions],
  );

  async function generateSuggestions() {
    setBusyKey("generate");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${representativeSlug}/training/workflows`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(
          await extractTrainingError(response, locale, t.generationError),
        );
      }
      await refresh(false);
      setNotice(t.generationQueued);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t.generationError);
    } finally {
      setBusyKey(null);
    }
  }

  async function reviewSuggestion(
    suggestion: TrainingSuggestion,
    action: ReviewAction,
  ) {
    const knowledgeGapAnswer =
      suggestion.suggestionType === "knowledge_gap"
        ? knowledgeGapAnswers[suggestion.id]
          ?? readExistingKnowledgeGapAnswer(suggestion.draftPayload)
        : "";
    if (
      action === "approve"
      && suggestion.suggestionType === "knowledge_gap"
      && !isKnowledgeGapAnswerReady(knowledgeGapAnswer)
    ) {
      setError(t.knowledgeGapAnswerRequired);
      return;
    }
    if (
      action === "approve"
      && !window.confirm(t.approveConfirmation)
    ) {
      return;
    }

    const key = `review:${suggestion.id}:${action}`;
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${representativeSlug}/training/suggestions/${suggestion.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            ...(action === "approve" && suggestion.suggestionType === "knowledge_gap"
              ? {
                  editedDraftPayload: buildKnowledgeGapDraftPayload(
                    suggestion,
                    knowledgeGapAnswer,
                  ),
                }
              : {}),
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await extractTrainingError(response, locale, t.reviewError),
        );
      }
      await refresh(false);
      setKnowledgeGapAnswers((current) => {
        const next = { ...current };
        delete next[suggestion.id];
        return next;
      });
      setNotice(action === "approve" ? t.appliedNotice : t.reviewedNotice);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t.reviewError);
    } finally {
      setBusyKey(null);
    }
  }

  async function rollbackVersion(version: TrainingVersion) {
    if (!window.confirm(t.rollbackConfirmation)) return;
    const key = `rollback:${version.id}`;
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${representativeSlug}/training/versions/${version.id}/rollback`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(
          await extractTrainingError(response, locale, t.rollbackError),
        );
      }
      await refresh(false);
      setNotice(t.rollbackNotice);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t.rollbackError);
    } finally {
      setBusyKey(null);
    }
  }

  async function submitSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTitle = sourceTitle.trim();
    const normalizedValue = sourceValue.trim();
    if (!normalizedTitle || !normalizedValue) {
      setError(t.sourceRequired);
      return;
    }

    setBusyKey("source");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${representativeSlug}/training/sources`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: sourceKind,
            title: normalizedTitle,
            ...(sourceKind === "url"
              ? { locator: normalizedValue }
              : { contentText: normalizedValue }),
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await extractTrainingError(response, locale, t.sourceError),
        );
      }
      setSourceTitle("");
      setSourceValue("");
      await refresh(false);
      setNotice(t.sourceAdded);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t.sourceError);
    } finally {
      setBusyKey(null);
    }
  }

  async function updateProjection(enabled: boolean) {
    if (!governance) return;
    setGovernanceBusyKey("projection");
    setGovernanceError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${representativeSlug}/openviking`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
            autoRecall: governance.settings.autoRecall,
            autoCapture: false,
            recallLimit: governance.settings.recallLimit,
            recallScoreThreshold: governance.settings.recallScoreThreshold,
          }),
        },
      );
      if (!response.ok) throw new Error(await extractError(response));
      await refreshGovernance(false);
      setNotice(enabled ? t.projectionEnabledNotice : t.projectionDisabledNotice);
    } catch {
      setGovernanceError(t.projectionUpdateError);
    } finally {
      setGovernanceBusyKey(null);
    }
  }

  async function resyncPublishedContext() {
    setGovernanceBusyKey("sync");
    setGovernanceError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${representativeSlug}/openviking/sync`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await extractError(response));
      const nextSettings = await response.json() as GovernedContextSettings;
      await refreshGovernance(false);
      const syncState = getGovernedContextSyncPresentation(
        nextSettings.lastSyncStatus,
        locale,
      );
      if (syncState.outcome === "success" || syncState.outcome === "in_progress") {
        setNotice(syncState.actionMessage);
      } else {
        setGovernanceError(syncState.actionMessage);
      }
    } catch {
      setGovernanceError(t.syncError);
    } finally {
      setGovernanceBusyKey(null);
    }
  }

  async function manageMemory(memory: GovernedMemory, action: MemoryAction) {
    if (action === "suppress" && !window.confirm(t.suppressConfirmation)) return;
    if (action === "delete" && !window.confirm(t.deleteConfirmation)) return;

    const key = `memory:${memory.id}:${action}`;
    setGovernanceBusyKey(key);
    setGovernanceError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${representativeSlug}/openviking/memories/${memory.id}`,
        action === "delete"
          ? { method: "DELETE" }
          : {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action }),
            },
      );
      if (!response.ok) throw new Error(await extractError(response));
      await refreshGovernance(false);
      setNotice(
        action === "suppress"
          ? t.memorySuppressedNotice
          : action === "retry"
            ? t.memoryRetryNotice
            : t.memoryDeletedNotice,
      );
    } catch {
      setGovernanceError(
        action === "retry" ? t.memoryRetryError : t.memoryUpdateError,
      );
    } finally {
      setGovernanceBusyKey(null);
    }
  }

  if (initialLoading && !snapshot) {
    return (
      <section aria-live="polite" className="dashboard-v2-panel representative-development-loading" role="status">
        <span className="representative-development-spinner" aria-hidden="true" />
        <div>
          <strong>{t.loadingTitle}</strong>
          <p>{t.loadingDetail}</p>
        </div>
      </section>
    );
  }

  if (!snapshot) {
    return (
      <section className="dashboard-v2-panel representative-development-loading" role="alert">
        <div>
          <strong>{t.loadingError}</strong>
          <p>{error}</p>
        </div>
        <button className="dashboard-v2-button-secondary" onClick={() => void refresh()} type="button">
          {t.retry}
        </button>
      </section>
    );
  }

  return (
    <div className="representative-development-page">
      <header className="dashboard-v2-page-header representative-development-header">
        <div>
          <p>REPRESENTATIVE DEVELOPMENT / 07</p>
          <h1>{t.title}</h1>
          <span>{t.summary}</span>
        </div>
        <div className="dashboard-v2-page-actions">
          <button
            className="dashboard-v2-button-secondary"
            disabled={refreshing || governanceLoading || busyKey !== null || governanceBusyKey !== null}
            onClick={() => {
              void refresh();
              void refreshGovernance();
            }}
            type="button"
          >
            {refreshing || governanceLoading ? t.refreshing : t.refresh}
          </button>
          <button
            className="dashboard-v2-button-primary"
            disabled={busyKey !== null || workflowActive}
            onClick={() => void generateSuggestions()}
            type="button"
          >
            {busyKey === "generate" || workflowActive ? t.generating : t.generate}
          </button>
        </div>
      </header>

      <section className="representative-development-trust" aria-label={t.boundaryLabel}>
        <strong>{t.boundaryLabel}</strong>
        <span>{t.boundaryOne}</span>
        <span>{t.boundaryTwo}</span>
        <span>{t.boundaryThree}</span>
      </section>

      {notice ? <p className="representative-development-notice is-success" role="status">{notice}</p> : null}
      {error ? <p className="representative-development-notice is-error" role="alert">{error}</p> : null}

      <section className="dashboard-v2-metric-grid representative-development-metrics">
        <MetricCard
          detail={t.pendingSuggestionsDetail}
          label={t.pendingSuggestions}
          tone={snapshot.summary.pendingSuggestionCount > 0 ? "indigo" : "teal"}
          value={snapshot.summary.pendingSuggestionCount}
        />
        <MetricCard
          detail={t.pendingFeedbackDetail}
          label={t.pendingFeedback}
          tone="default"
          value={snapshot.summary.pendingFeedbackCount}
        />
        <MetricCard
          detail={t.sourcesDetail}
          label={t.sources}
          tone="teal"
          value={snapshot.summary.availableSourceCount}
        />
        <MetricCard
          detail={t.revisionsDetail}
          label={t.revisions}
          tone="default"
          value={snapshot.summary.appliedVersionCount}
        />
      </section>

      <div className="representative-development-layout">
        <section className="dashboard-v2-panel representative-development-queue">
          <header>
            <div>
              <p>{t.queueEyebrow}</p>
              <h2>{t.queueTitle}</h2>
            </div>
            <span className="representative-development-count">
              {snapshot.suggestions.length}
            </span>
          </header>
          <p className="dashboard-v2-panel-description">{t.queueDescription}</p>

          {snapshot.suggestions.length ? (
            <div className="representative-development-suggestion-list">
              {snapshot.suggestions.map((suggestion) => {
                const preview = buildSuggestionPreview(suggestion, locale);
                const sourceLabel = getSuggestionSourceLabel(suggestion, locale);
                const knowledgeGapAnswer =
                  suggestion.suggestionType === "knowledge_gap"
                    ? knowledgeGapAnswers[suggestion.id]
                      ?? readExistingKnowledgeGapAnswer(suggestion.draftPayload)
                    : "";
                return (
                  <article className="representative-development-suggestion" key={suggestion.id}>
                    <header>
                      <div>
                        <div className="representative-development-tags">
                          <span>{suggestionTypeLabel(suggestion.suggestionType, locale)}</span>
                          <span>{sourceLabel}</span>
                        </div>
                        <h3>{suggestion.title}</h3>
                      </div>
                      <span className={`representative-development-risk is-${normalizeRisk(suggestion.riskLevel)}`}>
                        {riskLabel(suggestion.riskLevel, locale)}
                      </span>
                    </header>
                    <div className="representative-development-preview">
                      <span>{preview.target}</span>
                      <strong>{preview.title}</strong>
                      <p>{preview.body}</p>
                    </div>
                    {suggestion.suggestionType === "knowledge_gap" ? (
                      <label className="representative-development-answer-editor">
                        <span>{t.knowledgeGapAnswerLabel}</span>
                        <textarea
                          onChange={(event) => {
                            const answer = event.target.value;
                            setKnowledgeGapAnswers((current) => ({
                              ...current,
                              [suggestion.id]: answer,
                            }));
                          }}
                          placeholder={t.knowledgeGapAnswerPlaceholder}
                          rows={4}
                          value={knowledgeGapAnswer}
                        />
                        <small>{t.knowledgeGapAnswerHelp}</small>
                      </label>
                    ) : null}
                    <footer>
                      <small>{formatDate(suggestion.createdAt, locale)}</small>
                      <div>
                        <button
                          className="dashboard-v2-button-secondary"
                          disabled={busyKey !== null}
                          onClick={() => void reviewSuggestion(suggestion, "reject")}
                          type="button"
                        >
                          {t.reject}
                        </button>
                        <button
                          className="dashboard-v2-button-secondary"
                          disabled={busyKey !== null}
                          onClick={() => void reviewSuggestion(suggestion, "private")}
                          type="button"
                        >
                          {t.keepPrivate}
                        </button>
                        <button
                          className="dashboard-v2-button-primary"
                          disabled={
                            busyKey !== null
                            || (
                              suggestion.suggestionType === "knowledge_gap"
                              && !isKnowledgeGapAnswerReady(knowledgeGapAnswer)
                            )
                          }
                          onClick={() => void reviewSuggestion(suggestion, "approve")}
                          type="button"
                        >
                          {busyKey === `review:${suggestion.id}:approve`
                            ? t.applying
                            : t.applyToDraft}
                        </button>
                      </div>
                    </footer>
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyState
              action={
                <button
                  className="dashboard-v2-button-secondary"
                  disabled={busyKey !== null || workflowActive}
                  onClick={() => void generateSuggestions()}
                  type="button"
                >
                  {workflowActive ? t.generating : t.generate}
                </button>
              }
              copy={t.queueEmptyCopy}
              title={t.queueEmptyTitle}
            />
          )}
        </section>

        <aside className="representative-development-side">
          <section className="dashboard-v2-panel is-indigo representative-development-workflow">
            <header>
              <div>
                <p>{t.workflowEyebrow}</p>
                <h2>{t.workflowTitle}</h2>
              </div>
              <span className={`representative-development-workflow-status is-${snapshot.latestWorkflow?.status ?? "idle"}`}>
                {workflowLabel(snapshot.latestWorkflow?.status ?? "idle", locale)}
              </span>
            </header>
            <p className="dashboard-v2-panel-description">{t.workflowDescription}</p>
            <dl>
              <div>
                <dt>{t.lastRun}</dt>
                <dd>
                  {snapshot.latestWorkflow
                    ? formatDate(snapshot.latestWorkflow.scheduledAt, locale)
                    : t.neverRun}
                </dd>
              </div>
              <div>
                <dt>{t.reviewRule}</dt>
                <dd>{t.ownerRequired}</dd>
              </div>
            </dl>
          </section>

          <section className="dashboard-v2-panel representative-development-sources">
            <header>
              <div>
                <p>{t.sourcesEyebrow}</p>
                <h2>{t.sourcesTitle}</h2>
              </div>
            </header>
            <p className="dashboard-v2-panel-description">{t.sourcesDescription}</p>
            <details>
              <summary>{t.addSource}</summary>
              <form onSubmit={submitSource}>
                <label>
                  <span>{t.sourceKind}</span>
                  <select
                    onChange={(event) => setSourceKind(event.target.value as SourceKind)}
                    value={sourceKind}
                  >
                    <option value="url">URL</option>
                    <option value="text">{t.textSource}</option>
                  </select>
                </label>
                <label>
                  <span>{t.sourceTitleLabel}</span>
                  <input
                    onChange={(event) => setSourceTitle(event.target.value)}
                    placeholder={t.sourceTitlePlaceholder}
                    value={sourceTitle}
                  />
                </label>
                <label>
                  <span>{sourceKind === "url" ? t.sourceUrl : t.sourceText}</span>
                  <textarea
                    onChange={(event) => setSourceValue(event.target.value)}
                    placeholder={sourceKind === "url" ? "https://…" : t.sourceTextPlaceholder}
                    rows={sourceKind === "url" ? 2 : 4}
                    value={sourceValue}
                  />
                </label>
                <button
                  className="dashboard-v2-button-secondary"
                  disabled={busyKey !== null}
                  type="submit"
                >
                  {busyKey === "source" ? t.addingSource : t.saveSource}
                </button>
              </form>
            </details>
            <div className="representative-development-source-list">
              {snapshot.sources.slice(0, 5).map((source) => (
                <div key={source.id}>
                  <span className={`is-${source.status}`} aria-hidden="true" />
                  <div>
                    <strong>{source.title}</strong>
                    <small>
                      {sourceKindLabel(source.kind, locale)}
                      {" · "}
                      {sourceStatusLabel(source.status, locale)}
                    </small>
                  </div>
                </div>
              ))}
              {!snapshot.sources.length ? <p>{t.noSources}</p> : null}
            </div>
          </section>
        </aside>
      </div>

      <section
        aria-labelledby="representative-development-governance-title"
        className="dashboard-v2-panel representative-development-governance"
      >
        <header>
          <div>
            <p>{t.governanceEyebrow}</p>
            <h2 id="representative-development-governance-title">{t.governanceTitle}</h2>
          </div>
          <button
            className="dashboard-v2-button-secondary"
            disabled={
              governanceBusyKey !== null
              || !governance?.settings.enabled
              || !governance.settings.publicKnowledgeSyncAvailable
            }
            onClick={() => void resyncPublishedContext()}
            type="button"
          >
            {governanceBusyKey === "sync" ? t.syncing : t.resync}
          </button>
        </header>
        <p className="dashboard-v2-panel-description">{t.governanceDescription}</p>

        {governanceError ? (
          <div className="representative-development-governance-error" role="alert">
            <span>{governanceError}</span>
            <button
              className="dashboard-v2-button-secondary"
              disabled={governanceLoading || governanceBusyKey !== null}
              onClick={() => void refreshGovernance()}
              type="button"
            >
              {t.retry}
            </button>
          </div>
        ) : null}

        {governanceLoading && !governance ? (
          <div
            aria-live="polite"
            className="representative-development-governance-loading"
            role="status"
          >
            <span className="representative-development-spinner" aria-hidden="true" />
            <span>{t.governanceLoading}</span>
          </div>
        ) : governance ? (
          <>
            <div className="representative-development-governance-metrics">
              <article>
                <span>{t.projectionStatus}</span>
                <strong>
                  {governance.settings.enabled ? t.projectionOn : t.projectionOff}
                </strong>
                <button
                  aria-checked={governance.settings.enabled}
                  className={`representative-development-projection-toggle${
                    governance.settings.enabled ? " is-on" : ""
                  }`}
                  disabled={governanceBusyKey !== null}
                  onClick={() => void updateProjection(!governance.settings.enabled)}
                  role="switch"
                  type="button"
                >
                  <span aria-hidden="true" />
                  {governance.settings.enabled ? t.turnProjectionOff : t.turnProjectionOn}
                </button>
              </article>
              <article>
                <span>{t.syncStatus}</span>
                <strong>
                  {getGovernedContextSyncPresentation(
                    governance.settings.lastSyncStatus,
                    locale,
                  ).label}
                </strong>
                <small>
                  {governance.settings.lastSyncAt
                    ? formatDate(governance.settings.lastSyncAt, locale)
                    : t.notSynced}
                </small>
              </article>
              <article>
                <span>{t.publishedItemCount}</span>
                <strong>{String(governance.settings.lastSyncItemCount).padStart(2, "0")}</strong>
                <small>{t.publishedItemDetail}</small>
              </article>
              <article>
                <span>{t.usageCount}</span>
                <strong>{String(governance.usageCount).padStart(2, "0")}</strong>
                <small>{t.usageCountDetail}</small>
              </article>
            </div>

            <div className="representative-development-capture-boundary">
              <span aria-hidden="true">✓</span>
              <div>
                <strong>{t.automaticCaptureOff}</strong>
                <p>{t.automaticCaptureDetail}</p>
              </div>
            </div>

            {!governance.settings.publicKnowledgeSyncAvailable ? (
              <p className="representative-development-sync-unavailable">
                {t.syncUnavailable}
              </p>
            ) : null}

            <div className="representative-development-memory-section">
              <header>
                <div>
                  <h3>{t.memoryTitle}</h3>
                  <p>{t.memoryDescription}</p>
                </div>
                <span>{governance.memories.length}</span>
              </header>
              {governance.memories.length ? (
                <div className="representative-development-memory-list">
                  {governance.memories.map((memory) => (
                    <article key={memory.id}>
                      <div className="representative-development-memory-copy">
                        <div>
                          <span
                            className={`representative-development-memory-status is-${memory.status.toLowerCase()}`}
                          >
                            {memoryStatusLabel(memory.status, locale)}
                          </span>
                          <small>
                            {memory.contactDisplayLabel
                              ? normalizeContactName(memory.contactDisplayLabel, locale)
                              : t.unnamedContact}
                            {" · "}
                            {formatDate(memory.createdAt, locale)}
                          </small>
                        </div>
                        <p>
                          {memory.summary.trim()
                            ? memory.summary
                            : memoryEmptySummary(memory.status, locale)}
                        </p>
                      </div>
                      <div className="representative-development-memory-actions">
                        {memory.status === "ACTIVE" ? (
                          <button
                            className="dashboard-v2-button-secondary"
                            disabled={governanceBusyKey !== null}
                            onClick={() => void manageMemory(memory, "suppress")}
                            type="button"
                          >
                            {governanceBusyKey === `memory:${memory.id}:suppress`
                              ? t.suppressingMemory
                              : t.suppressMemory}
                          </button>
                        ) : null}
                        {memory.status === "ACTIVE" || memory.status === "SUPPRESSED" ? (
                          <button
                            className="dashboard-v2-button-secondary"
                            disabled={governanceBusyKey !== null}
                            onClick={() => void manageMemory(memory, "delete")}
                            type="button"
                          >
                            {governanceBusyKey === `memory:${memory.id}:delete`
                              ? t.deletingMemory
                              : t.deleteMemory}
                          </button>
                        ) : null}
                        {memory.status === "DELETE_FAILED" ? (
                          <button
                            className="dashboard-v2-button-secondary"
                            disabled={governanceBusyKey !== null}
                            onClick={() => void manageMemory(memory, "retry")}
                            type="button"
                          >
                            {governanceBusyKey === `memory:${memory.id}:retry`
                              ? t.retryingMemory
                              : t.retryMemoryDeletion}
                          </button>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState copy={t.memoryEmptyCopy} title={t.memoryEmptyTitle} />
              )}
            </div>
          </>
        ) : null}
      </section>

      <section className="dashboard-v2-panel representative-development-revisions">
        <header>
          <div>
            <p>{t.revisionsEyebrow}</p>
            <h2>{t.revisionsTitle}</h2>
          </div>
          <a
            className="dashboard-v2-button-secondary"
            href={`/dashboard?view=representatives&rep=${encodeURIComponent(representativeSlug)}&lang=${locale}`}
          >
            {t.publishRepresentative}
          </a>
        </header>
        <p className="dashboard-v2-panel-description">{t.revisionsDescription}</p>
        <div className="representative-development-release-note">
          <strong>{t.notLiveTitle}</strong>
          <span>{t.notLiveCopy}</span>
        </div>
        {snapshot.versions.length ? (
          <div className="representative-development-version-list">
            {snapshot.versions.map((version) => (
              <article key={version.id}>
                <div>
                  <span className={`is-${version.status}`} aria-hidden="true" />
                  <div>
                    <strong>{version.title}</strong>
                    <small>
                      {versionStatusLabel(version.status, locale)}
                      {" · "}
                      {formatDate(version.publishedAt, locale)}
                      {version.ownerReviewed ? ` · ${t.ownerReviewed}` : ""}
                    </small>
                  </div>
                </div>
                {version.id === rollbackCandidateId ? (
                  <button
                    className="dashboard-v2-button-secondary"
                    disabled={busyKey !== null}
                    onClick={() => void rollbackVersion(version)}
                    type="button"
                  >
                    {busyKey === `rollback:${version.id}` ? t.rollingBack : t.rollback}
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <EmptyState copy={t.revisionsEmptyCopy} title={t.revisionsEmptyTitle} />
        )}
      </section>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: number;
  detail: string;
  tone: "default" | "teal" | "indigo";
}) {
  return (
    <article className={`dashboard-v2-metric-card is-${tone}`}>
      <div><span>{label}</span><i /></div>
      <strong>{String(value).padStart(2, "0")}</strong>
      <p>{detail}</p>
    </article>
  );
}

function EmptyState({
  title,
  copy,
  action,
}: {
  title: string;
  copy: string;
  action?: ReactNode;
}) {
  return (
    <div className="representative-development-empty">
      <span aria-hidden="true">◇</span>
      <strong>{title}</strong>
      <p>{copy}</p>
      {action}
    </div>
  );
}

async function fetchTrainingSnapshot(
  representativeSlug: string,
  locale: Locale,
  fallbackError: string,
): Promise<TrainingSnapshot> {
  const response = await fetch(
    `/api/dashboard/representatives/${representativeSlug}/training`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(
      await extractTrainingError(response, locale, fallbackError),
    );
  }
  return await response.json() as TrainingSnapshot;
}

async function fetchGovernanceSnapshot(
  representativeSlug: string,
): Promise<GovernanceSnapshot> {
  const root = `/api/dashboard/representatives/${representativeSlug}/openviking`;
  const [settingsResponse, memoriesResponse, usageResponse] = await Promise.all([
    fetch(root, { cache: "no-store" }),
    fetch(`${root}/memories`, { cache: "no-store" }),
    fetch(`${root}/recall-traces`, { cache: "no-store" }),
  ]);
  if (!settingsResponse.ok || !memoriesResponse.ok || !usageResponse.ok) {
    throw new Error("Governed context is unavailable.");
  }

  const settings = await settingsResponse.json() as GovernedContextSettings;
  const memoryBody = await memoriesResponse.json() as { memories?: GovernedMemory[] };
  const usageBody = await usageResponse.json() as {
    usage?: {
      today?: number;
      total?: number;
    };
  };
  return {
    settings,
    memories: Array.isArray(memoryBody.memories) ? memoryBody.memories : [],
    usageCount:
      typeof usageBody.usage?.total === "number"
        ? Math.max(0, usageBody.usage.total)
        : 0,
  };
}

async function extractError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? response.statusText;
}

async function extractTrainingError(
  response: Response,
  locale: Locale,
  fallback: string,
): Promise<string> {
  const body = await response.json().catch(() => null) as {
    code?: string;
  } | null;
  const zhMessages: Record<string, string> = {
    TRAINING_NOT_FOUND: "相关养成记录不存在，请刷新后重试。",
    SUGGESTION_NOT_PENDING: "这条建议已经处理，请刷新后查看当前状态。",
    REVISION_NOT_LATEST: "只能撤销最新且仍然生效的养成修订。",
    REVISION_HISTORY_AMBIGUOUS: "养成修订历史无法唯一确认，请先发布一条新修订后再撤销。",
    KNOWLEDGE_DRAFT_CHANGED: "知识草稿已发生变化，请刷新并确认最新内容后再撤销。",
    SAFETY_REVIEW_FAILED: "这条建议未通过服务端安全检查，未写入知识草稿。",
    CREATOR_ANSWER_REQUIRED: "请先填写经过 Owner 核实的真实答案，再批准这条知识缺口。",
    INVALID_TRAINING_REQUEST: "请求内容不完整或不受支持，请检查后重试。",
  };
  const enMessages: Record<string, string> = {
    TRAINING_NOT_FOUND: "The development record was not found. Refresh and try again.",
    SUGGESTION_NOT_PENDING: "This suggestion has already been reviewed. Refresh to see its current state.",
    REVISION_NOT_LATEST: "Only the latest active development revision can be reverted.",
    REVISION_HISTORY_AMBIGUOUS: "The development history is ambiguous. Publish a new revision before reverting.",
    KNOWLEDGE_DRAFT_CHANGED: "The knowledge draft has changed. Refresh and review the latest content before reverting.",
    SAFETY_REVIEW_FAILED: "This suggestion did not pass the server-side safety review and was not applied.",
    CREATOR_ANSWER_REQUIRED: "Add a real Owner-verified answer before approving this knowledge gap.",
    INVALID_TRAINING_REQUEST: "The request is incomplete or unsupported. Review it and try again.",
  };
  return (locale === "zh" ? zhMessages : enMessages)[body?.code ?? ""] ?? fallback;
}

function buildSuggestionPreview(
  suggestion: TrainingSuggestion,
  locale: Locale,
): { target: string; title: string; body: string } {
  const payload = isRecord(suggestion.draftPayload) ? suggestion.draftPayload : {};
  const type = suggestion.suggestionType;
  const fallbackTitle = suggestionTypeLabel(type, locale);
  const title =
    readText(payload.title)
    || readText(payload.question)
    || fallbackTitle;
  if (type === "knowledge_gap") {
    const answer = readExistingKnowledgeGapAnswer(payload);
    return {
      target: locale === "zh" ? "需要 Owner 提供答案" : "Owner answer required",
      title,
      body:
        answer
        || (
          locale === "zh"
            ? "这个问题曾重复出现，但目前没有经过 Owner 核实的公开答案。"
            : "This question has repeated, but there is no owner-verified public answer yet."
        ),
    };
  }
  const body =
    readText(payload.summary)
    || readText(payload.rule)
    || readText(payload.question)
    || (locale === "zh" ? "等待 Owner 审核具体修改。" : "Awaiting owner review.");
  const target =
    type === "faq_update"
      ? (locale === "zh" ? "拟加入 FAQ 草稿" : "Proposed FAQ draft")
      : type === "material_update"
        ? (locale === "zh" ? "拟加入公开资料草稿" : "Proposed public material draft")
        : type === "policy_update" || type === "tone_rule"
          ? (locale === "zh" ? "拟加入规则草稿" : "Proposed policy draft")
          : (locale === "zh" ? "拟加入能力建议" : "Proposed capability note");
  return { target, title, body };
}

function buildKnowledgeGapDraftPayload(
  suggestion: TrainingSuggestion,
  answer: string,
) {
  const payload = isRecord(suggestion.draftPayload) ? suggestion.draftPayload : {};
  const question = readText(payload.question) || suggestion.title;
  return {
    ...payload,
    kind: "faq",
    question,
    title: question,
    summary: answer.trim(),
  };
}

function readExistingKnowledgeGapAnswer(value: unknown) {
  const payload = isRecord(value) ? value : {};
  const answer = readText(payload.summary) || readText(payload.answer);
  return isKnowledgeGapAnswerReady(answer) ? answer : "";
}

function isKnowledgeGapAnswerReady(value: string) {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized.length < 2) return false;
  return !(
    normalized.startsWith("needs a creator-approved answer")
    || normalized === "creator-approved training update."
    || normalized === "creator-approved training update"
    || normalized === "awaiting owner review."
    || normalized === "awaiting owner review"
    || normalized.includes("等待 owner 审核")
    || normalized.includes("待 owner 填写")
    || normalized.includes("请 owner 填写")
  );
}

function getSuggestionSourceLabel(suggestion: TrainingSuggestion, locale: Locale) {
  if (suggestion.sourceId) return locale === "zh" ? "Owner 资料" : "Owner source";
  if (suggestion.feedbackSignalId) return locale === "zh" ? "Owner 反馈" : "Owner feedback";
  return locale === "zh" ? "重复未回答问题" : "Repeated unanswered question";
}

function suggestionTypeLabel(type: TrainingSuggestion["suggestionType"], locale: Locale) {
  const zhLabels: Record<TrainingSuggestion["suggestionType"], string> = {
    faq_update: "FAQ 更新",
    policy_update: "规则更新",
    material_update: "资料更新",
    tone_rule: "表达边界",
    skill_recommendation: "能力建议",
    knowledge_gap: "知识缺口",
  };
  const enLabels: Record<TrainingSuggestion["suggestionType"], string> = {
    faq_update: "FAQ update",
    policy_update: "Policy update",
    material_update: "Material update",
    tone_rule: "Language boundary",
    skill_recommendation: "Capability suggestion",
    knowledge_gap: "Knowledge gap",
  };
  return (locale === "zh" ? zhLabels : enLabels)[type];
}

function normalizeRisk(risk: string) {
  const normalized = risk.trim().toLowerCase();
  return normalized === "high" || normalized === "medium" ? normalized : "low";
}

function riskLabel(risk: string, locale: Locale) {
  const normalized = normalizeRisk(risk);
  if (locale === "zh") {
    return normalized === "high" ? "高风险" : normalized === "medium" ? "中风险" : "低风险";
  }
  return normalized === "high" ? "High risk" : normalized === "medium" ? "Medium risk" : "Low risk";
}

function workflowLabel(status: TrainingWorkflow["status"] | "idle", locale: Locale) {
  const zhLabels = {
    idle: "尚未运行",
    queued: "等待整理",
    running: "正在整理",
    completed: "已完成",
    failed: "失败",
    canceled: "已取消",
  };
  const enLabels = {
    idle: "Not run",
    queued: "Queued",
    running: "Organizing",
    completed: "Completed",
    failed: "Failed",
    canceled: "Canceled",
  };
  return (locale === "zh" ? zhLabels : enLabels)[status];
}

function sourceKindLabel(kind: TrainingSource["kind"], locale: Locale) {
  if (kind === "text") return locale === "zh" ? "文本" : "Text";
  if (kind === "website") return locale === "zh" ? "网站" : "Website";
  return kind.toUpperCase();
}

function sourceStatusLabel(status: TrainingSource["status"], locale: Locale) {
  const zhLabels = { draft: "待整理", active: "已采用", disabled: "已停用", failed: "处理失败" };
  const enLabels = { draft: "Ready to organize", active: "Applied", disabled: "Disabled", failed: "Failed" };
  return (locale === "zh" ? zhLabels : enLabels)[status];
}

function versionStatusLabel(status: TrainingVersion["status"], locale: Locale) {
  if (locale === "zh") return status === "published" ? "已写入知识草稿" : "已撤销";
  return status === "published" ? "Applied to knowledge draft" : "Reverted";
}

function memoryStatusLabel(status: GovernedMemory["status"], locale: Locale) {
  const zhLabels: Record<GovernedMemory["status"], string> = {
    ACTIVE: "可使用",
    SUPPRESSED: "已停用",
    DELETE_PENDING: "删除中",
    DELETED: "已删除",
    DELETE_FAILED: "删除未完成",
  };
  const enLabels: Record<GovernedMemory["status"], string> = {
    ACTIVE: "Available",
    SUPPRESSED: "Disabled",
    DELETE_PENDING: "Deleting",
    DELETED: "Deleted",
    DELETE_FAILED: "Deletion incomplete",
  };
  return (locale === "zh" ? zhLabels : enLabels)[status];
}

function memoryEmptySummary(status: GovernedMemory["status"], locale: Locale) {
  if (status === "DELETE_PENDING" || status === "DELETE_FAILED" || status === "DELETED") {
    return locale === "zh"
      ? "内容已清除，不再用于代表回答。"
      : "Content cleared and no longer used in representative replies.";
  }
  return locale === "zh" ? "没有可显示的记忆摘要。" : "No memory summary is available.";
}

function normalizeContactName(value: string, locale: Locale) {
  const normalized = value.trim();
  if (/^web visitor$/i.test(normalized) || /^unknown audience$/i.test(normalized)) {
    return locale === "zh" ? "匿名访客" : "Anonymous visitor";
  }
  return normalized || (locale === "zh" ? "匿名访客" : "Anonymous visitor");
}

function formatDate(value: string, locale: Locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

const zhCopy = {
  loadingTitle: "正在读取养成状态",
  loadingDetail: "加载资料来源、Owner 反馈、待审核建议和修订记录。",
  loadingError: "养成页面暂时无法加载",
  retry: "重试",
  title: "让代表持续进步，但每次改变都由你确认。",
  summary: "把资料、纠错和重复未回答的问题整理成待审核建议。批准后先进入知识草稿；发布新的代表版本后才影响公开回答。",
  refresh: "刷新",
  refreshing: "刷新中…",
  generate: "生成改进建议",
  generating: "正在整理…",
  generationQueued: "改进建议整理任务已加入队列。",
  generationError: "无法生成改进建议。",
  boundaryLabel: "养成边界",
  boundaryOne: "访客原始对话不会自动成为公开知识",
  boundaryTwo: "非公开反馈不会生成共享建议",
  boundaryThree: "每项修改必须由 Owner 审核",
  pendingSuggestions: "待审核建议",
  pendingSuggestionsDetail: "需要 Owner 明确处理",
  pendingFeedback: "待整理反馈",
  pendingFeedbackDetail: "尚未整理的纠错与边界",
  sources: "可用输入来源",
  sourcesDetail: "未停用且处理正常",
  revisions: "已应用修订",
  revisionsDetail: "已写入知识草稿",
  queueEyebrow: "REVIEW QUEUE",
  queueTitle: "待审核改进建议",
  queueDescription: "先看建议将修改什么，再决定写入知识草稿、仅内部保留或拒绝。这里的批准不会直接改变公开回答。",
  queueEmptyTitle: "当前没有待审核建议",
  queueEmptyCopy: "添加一条确认可用的资料，或运行一次整理任务。没有真实输入时不会生成示例建议。",
  knowledgeGapAnswerLabel: "Owner 核实后的公开答案",
  knowledgeGapAnswerPlaceholder: "填写准确、可公开使用的真实答案…",
  knowledgeGapAnswerHelp: "未填写或仍是占位文案时不能批准；答案只会先写入知识草稿。",
  knowledgeGapAnswerRequired: "请先填写经过核实的真实答案，再批准这条知识缺口。",
  reject: "拒绝",
  keepPrivate: "仅保留内部",
  applyToDraft: "批准并写入知识草稿",
  applying: "正在写入…",
  approveConfirmation: "批准后会修改知识草稿，但不会自动发布到公开代表。确认继续吗？",
  appliedNotice: "建议已写入知识草稿。请发布新的代表版本后再让它影响公开回答。",
  reviewedNotice: "建议已处理。",
  reviewError: "无法处理这条建议。",
  workflowEyebrow: "ORGANIZATION RUN",
  workflowTitle: "最近一次整理",
  workflowDescription: "系统只整理候选建议；是否采用始终由 Owner 决定。",
  lastRun: "运行时间",
  neverRun: "尚未运行",
  reviewRule: "生效规则",
  ownerRequired: "Owner 审核后进入知识草稿",
  sourcesEyebrow: "INPUT SOURCES",
  sourcesTitle: "改进输入",
  sourcesDescription: "只添加你确认可用于代表知识草稿的公开资料。访客原始对话不是资料源。",
  addSource: "添加 URL 或文本",
  sourceKind: "来源类型",
  textSource: "文本",
  sourceTitleLabel: "标题",
  sourceTitlePlaceholder: "例如：退款政策",
  sourceUrl: "URL",
  sourceText: "公开文本",
  sourceTextPlaceholder: "粘贴确认可用于代表知识草稿的内容…",
  saveSource: "保存输入来源",
  addingSource: "保存中…",
  sourceRequired: "请填写来源标题和内容。",
  sourceAdded: "输入来源已保存。运行整理任务后才会生成待审核建议。",
  sourceError: "无法保存输入来源。",
  noSources: "还没有改进输入来源。",
  governanceEyebrow: "MEMORY & USE",
  governanceTitle: "记忆与使用",
  governanceDescription: "控制已发布内容如何提供给代表，并管理可用于个性化回答的受治理记忆。这里只显示业务状态和摘要。",
  governanceLoading: "正在读取记忆与使用状态…",
  governanceLoadingError: "记忆与使用状态暂时无法加载。",
  projectionStatus: "投影开关",
  projectionOn: "已开启",
  projectionOff: "已关闭",
  turnProjectionOn: "开启投影",
  turnProjectionOff: "关闭投影",
  projectionEnabledNotice: "已开启发布内容投影。",
  projectionDisabledNotice: "已关闭发布内容投影。",
  projectionUpdateError: "无法更新投影开关。",
  syncStatus: "同步状态",
  notSynced: "尚未同步",
  publishedItemCount: "已发布项数",
  publishedItemDetail: "最近一次同步的公开内容",
  usageCount: "使用记录数量",
  usageCountDetail: "近期回答采用上下文的记录",
  resync: "重新同步",
  syncing: "同步中…",
  syncError: "无法重新同步，请稍后重试。",
  syncUnavailable: "当前暂不能重新同步；已有状态与受治理记忆仍可查看和管理。",
  automaticCaptureOff: "自动捕获：关闭",
  automaticCaptureDetail: "不自动从聊天沉淀。只有经过明确治理的内容才会出现在这里。",
  memoryTitle: "受治理记忆",
  memoryDescription: "按用户显示安全摘要。你可以停用记忆，或彻底删除并在失败时重试。",
  unnamedContact: "匿名访客",
  suppressMemory: "停用",
  suppressingMemory: "停用中…",
  deleteMemory: "删除",
  deletingMemory: "删除中…",
  retryMemoryDeletion: "重试删除",
  retryingMemory: "重试中…",
  suppressConfirmation: "停用后，这条记忆将不再用于代表回答。确认停用吗？",
  deleteConfirmation: "删除后，记忆内容会立即清除且无法恢复。确认删除吗？",
  memorySuppressedNotice: "记忆已停用，不会再用于代表回答。",
  memoryDeletedNotice: "记忆内容已清除，并已提交删除。",
  memoryRetryNotice: "已重新尝试删除。",
  memoryUpdateError: "无法更新这条记忆。",
  memoryRetryError: "删除仍未完成，请稍后重试。",
  memoryEmptyTitle: "还没有受治理记忆",
  memoryEmptyCopy: "系统不会自动从聊天沉淀记忆。经过明确治理的用户上下文会显示在这里。",
  revisionsEyebrow: "REVISION HISTORY",
  revisionsTitle: "养成修订记录",
  revisionsDescription: "记录每次写入知识草稿的变更。只有最新且之后未被其他编辑修改的修订可以安全撤销。",
  publishRepresentative: "前往发布代表版本",
  notLiveTitle: "知识草稿尚不等于公开版本",
  notLiveCopy: "完成审核后，请在“数字代表”中发布新版本；公开页面和新会话才会使用这些修改。",
  revisionsEmptyTitle: "还没有养成修订",
  revisionsEmptyCopy: "Owner 批准建议并写入知识草稿后，修订记录会显示在这里。",
  ownerReviewed: "Owner 审核",
  rollback: "撤销最近修订",
  rollingBack: "正在撤销…",
  rollbackConfirmation: "仅当知识草稿此后没有其他修改时才能撤销。确认撤销最近一次养成修订吗？",
  rollbackNotice: "最近一次养成修订已撤销。",
  rollbackError: "无法撤销修订；知识草稿可能已发生更新，请刷新检查。",
} as const;

const enCopy = {
  loadingTitle: "Loading representative development",
  loadingDetail: "Reading sources, owner feedback, review suggestions, and revisions.",
  loadingError: "Representative Development is temporarily unavailable",
  retry: "Retry",
  title: "Help the representative improve, with every change under your review.",
  summary: "Organize sources, corrections, and repeated unanswered questions into reviewable suggestions. Approval updates the knowledge draft first; public replies change only after a new representative version is released.",
  refresh: "Refresh",
  refreshing: "Refreshing…",
  generate: "Generate improvement suggestions",
  generating: "Organizing…",
  generationQueued: "The improvement-suggestion run is queued.",
  generationError: "Could not generate improvement suggestions.",
  boundaryLabel: "Development boundaries",
  boundaryOne: "Raw visitor conversations do not automatically become public knowledge",
  boundaryTwo: "Non-public feedback cannot create shared suggestions",
  boundaryThree: "Every change requires owner review",
  pendingSuggestions: "Pending suggestions",
  pendingSuggestionsDetail: "Require an explicit owner decision",
  pendingFeedback: "Feedback to organize",
  pendingFeedbackDetail: "Corrections and boundaries not yet organized",
  sources: "Available inputs",
  sourcesDetail: "Enabled and processing normally",
  revisions: "Applied revisions",
  revisionsDetail: "Written to the knowledge draft",
  queueEyebrow: "REVIEW QUEUE",
  queueTitle: "Improvement suggestions to review",
  queueDescription: "Inspect what each suggestion changes, then apply it to the knowledge draft, keep it private, or reject it. Approval here does not directly change public replies.",
  queueEmptyTitle: "No suggestions are waiting",
  queueEmptyCopy: "Add a confirmed source or run an organization cycle. No sample suggestions appear without real inputs.",
  knowledgeGapAnswerLabel: "Owner-verified public answer",
  knowledgeGapAnswerPlaceholder: "Enter an accurate answer that may be used publicly…",
  knowledgeGapAnswerHelp: "Approval stays disabled for a blank or placeholder answer. The answer is written to the knowledge draft first.",
  knowledgeGapAnswerRequired: "Add a verified real answer before approving this knowledge gap.",
  reject: "Reject",
  keepPrivate: "Keep private",
  applyToDraft: "Approve into knowledge draft",
  applying: "Applying…",
  approveConfirmation: "Approval changes the knowledge draft but does not publish it to the public representative. Continue?",
  appliedNotice: "The suggestion was added to the knowledge draft. Release a new representative version before it affects public replies.",
  reviewedNotice: "The suggestion was reviewed.",
  reviewError: "Could not review this suggestion.",
  workflowEyebrow: "ORGANIZATION RUN",
  workflowTitle: "Latest organization run",
  workflowDescription: "The system only organizes candidate changes. The owner always decides whether to use them.",
  lastRun: "Run time",
  neverRun: "Never run",
  reviewRule: "Activation rule",
  ownerRequired: "Owner review writes to the knowledge draft",
  sourcesEyebrow: "INPUT SOURCES",
  sourcesTitle: "Improvement inputs",
  sourcesDescription: "Add only public material you have confirmed may be used in the representative's knowledge draft. Raw visitor conversations are not sources.",
  addSource: "Add a URL or text",
  sourceKind: "Source type",
  textSource: "Text",
  sourceTitleLabel: "Title",
  sourceTitlePlaceholder: "For example: refund policy",
  sourceUrl: "URL",
  sourceText: "Public text",
  sourceTextPlaceholder: "Paste content confirmed for the representative's knowledge draft…",
  saveSource: "Save input source",
  addingSource: "Saving…",
  sourceRequired: "Enter both a source title and content.",
  sourceAdded: "The input source was saved. Run organization to create reviewable suggestions.",
  sourceError: "Could not save the input source.",
  noSources: "No improvement inputs yet.",
  governanceEyebrow: "MEMORY & USE",
  governanceTitle: "Memory & Use",
  governanceDescription: "Control how released content supports the representative and manage governed memories available for personalized replies. Only business-safe statuses and summaries appear here.",
  governanceLoading: "Loading memory and usage status…",
  governanceLoadingError: "Memory and usage status is temporarily unavailable.",
  projectionStatus: "Projection",
  projectionOn: "On",
  projectionOff: "Off",
  turnProjectionOn: "Turn projection on",
  turnProjectionOff: "Turn projection off",
  projectionEnabledNotice: "Released-content projection is on.",
  projectionDisabledNotice: "Released-content projection is off.",
  projectionUpdateError: "Could not update projection.",
  syncStatus: "Sync status",
  notSynced: "Not synced yet",
  publishedItemCount: "Published items",
  publishedItemDetail: "Public content in the latest sync",
  usageCount: "Usage records",
  usageCountDetail: "Recent replies that used governed context",
  resync: "Resync",
  syncing: "Syncing…",
  syncError: "Could not resync. Try again later.",
  syncUnavailable: "Resync is temporarily unavailable. Existing status and governed memories remain manageable.",
  automaticCaptureOff: "Automatic capture: Off",
  automaticCaptureDetail: "Chats are not automatically turned into memory. Only explicitly governed content appears here.",
  memoryTitle: "Governed memories",
  memoryDescription: "Review safe summaries by user. Disable a memory, delete it permanently, or retry an incomplete deletion.",
  unnamedContact: "Anonymous visitor",
  suppressMemory: "Disable",
  suppressingMemory: "Disabling…",
  deleteMemory: "Delete",
  deletingMemory: "Deleting…",
  retryMemoryDeletion: "Retry deletion",
  retryingMemory: "Retrying…",
  suppressConfirmation: "This memory will no longer support representative replies. Disable it?",
  deleteConfirmation: "Deletion immediately clears the memory content and cannot be undone. Delete it?",
  memorySuppressedNotice: "The memory is disabled and will no longer support replies.",
  memoryDeletedNotice: "The memory content was cleared and deletion was submitted.",
  memoryRetryNotice: "Deletion was retried.",
  memoryUpdateError: "Could not update this memory.",
  memoryRetryError: "Deletion is still incomplete. Try again later.",
  memoryEmptyTitle: "No governed memories yet",
  memoryEmptyCopy: "Chats are not automatically turned into memory. Explicitly governed user context will appear here.",
  revisionsEyebrow: "REVISION HISTORY",
  revisionsTitle: "Development revisions",
  revisionsDescription: "Tracks each change written to the knowledge draft. Only the latest revision can be reverted, and only while no later edit has changed the draft.",
  publishRepresentative: "Release a representative version",
  notLiveTitle: "The knowledge draft is not the public version",
  notLiveCopy: "After review, release a new version in Representatives. The public page and new conversations will then use the changes.",
  revisionsEmptyTitle: "No development revisions yet",
  revisionsEmptyCopy: "Revisions appear here after the owner approves a suggestion into the knowledge draft.",
  ownerReviewed: "Owner reviewed",
  rollback: "Revert latest revision",
  rollingBack: "Reverting…",
  rollbackConfirmation: "This works only if the knowledge draft has not changed since this revision. Revert the latest development revision?",
  rollbackNotice: "The latest development revision was reverted.",
  rollbackError: "The revision could not be reverted. The knowledge draft may have changed; refresh and review it.",
} as const;

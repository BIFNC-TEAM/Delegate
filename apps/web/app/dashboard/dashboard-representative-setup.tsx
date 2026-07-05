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

type InquiryIntent =
  | "faq"
  | "collaboration"
  | "pricing"
  | "materials"
  | "scheduling"
  | "handoff"
  | "refund"
  | "discount"
  | "candidate"
  | "media"
  | "support"
  | "restricted"
  | "unknown";

type GroupActivation = "mention_only" | "reply_or_mention" | "always";
type KnowledgeDocumentKind =
  | "bio"
  | "faq"
  | "policy"
  | "pricing"
  | "case_study"
  | "deck"
  | "calendar"
  | "download";

type KnowledgeDocument = {
  id: string;
  title: string;
  kind: KnowledgeDocumentKind;
  summary: string;
  url?: string | undefined;
};

type PricingPlan = {
  tier: "free" | "pass" | "deep_help" | "sponsor";
  name: string;
  stars: number;
  summary: string;
  includedReplies: number;
  includesPriorityHandoff: boolean;
};

type ComputePolicyMode = "allow" | "ask" | "deny";
type ComputeNetworkMode = "no_network" | "allowlist" | "full";
type ComputeFilesystemMode = "workspace_only" | "read_only_workspace" | "ephemeral_full";

type RepresentativeSetupSnapshot = {
  id: string;
  slug: string;
  ownerName: string;
  name: string;
  tagline: string;
  tone: string;
  languages: string[];
  groupActivation: GroupActivation;
  publicMode: boolean;
  humanInLoop: boolean;
  contract: {
    freeReplyLimit: number;
    freeScope: InquiryIntent[];
    paywalledIntents: InquiryIntent[];
    handoffWindowHours: number;
  };
  pricing: PricingPlan[];
  knowledgePack: {
    identitySummary: string;
    faq: KnowledgeDocument[];
    materials: KnowledgeDocument[];
    policies: KnowledgeDocument[];
  };
  handoffPrompt: string;
  compute: {
    enabled: boolean;
    defaultPolicyMode: ComputePolicyMode;
    baseImage: string;
    maxSessionMinutes: number;
    autoApproveBudgetCents: number;
    artifactRetentionDays: number;
    networkMode: ComputeNetworkMode;
    networkAllowlist: string[];
    filesystemMode: ComputeFilesystemMode;
  };
};

type RepresentativeOpenVikingSnapshot = {
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
};

function getGroupActivationLabels(locale: Locale): Record<GroupActivation, string> {
  return locale === "zh"
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
}

function getIntentOptions(locale: Locale): Array<{ value: InquiryIntent; label: string }> {
  return locale === "zh"
    ? [
        { value: "faq", label: "FAQ" },
        { value: "materials", label: "资料" },
        { value: "pricing", label: "报价" },
        { value: "collaboration", label: "合作" },
        { value: "scheduling", label: "预约" },
        { value: "handoff", label: "人工转接" },
        { value: "candidate", label: "招聘" },
        { value: "media", label: "媒体" },
        { value: "support", label: "支持" },
        { value: "unknown", label: "未知问题" },
      ]
    : [
        { value: "faq", label: "FAQ" },
        { value: "materials", label: "Materials" },
        { value: "pricing", label: "Pricing" },
        { value: "collaboration", label: "Collaboration" },
        { value: "scheduling", label: "Scheduling" },
        { value: "handoff", label: "Human handoff" },
        { value: "candidate", label: "Candidate" },
        { value: "media", label: "Media" },
        { value: "support", label: "Support" },
        { value: "unknown", label: "Unknown" },
      ];
}

function getMaterialKindOptions(locale: Locale): Array<{ value: KnowledgeDocumentKind; label: string }> {
  return locale === "zh"
    ? [
        { value: "deck", label: "演示材料" },
        { value: "case_study", label: "案例" },
        { value: "download", label: "下载资料" },
        { value: "calendar", label: "日程入口" },
        { value: "pricing", label: "价格页" },
      ]
    : [
        { value: "deck", label: "Deck" },
        { value: "case_study", label: "Case study" },
        { value: "download", label: "Download" },
        { value: "calendar", label: "Calendar" },
        { value: "pricing", label: "Pricing" },
      ];
}

function getPricingTierLabels(locale: Locale): Record<PricingPlan["tier"], string> {
  if (locale === "zh") {
    return {
      free: "Free",
      pass: "Pass",
      deep_help: "Deep Help",
      sponsor: "Sponsor",
    };
  }

  return {
    free: "Free",
    pass: "Pass",
    deep_help: "Deep Help",
    sponsor: "Sponsor",
  };
}

function getComputePolicyModeLabels(locale: Locale): Record<ComputePolicyMode, string> {
  return locale === "zh"
    ? {
        allow: "默认放行",
        ask: "默认审批",
        deny: "默认拒绝",
      }
    : {
        allow: "allow by default",
        ask: "ask by default",
        deny: "deny by default",
      };
}

function getComputeNetworkModeLabels(locale: Locale): Record<ComputeNetworkMode, string> {
  return locale === "zh"
    ? {
        no_network: "无网络",
        allowlist: "Allowlist",
        full: "完全联网",
      }
    : {
        no_network: "no network",
        allowlist: "allowlist",
        full: "full network",
      };
}

function formatNetworkAllowlistInput(value: string[]): string {
  return value.join("\n");
}

function parseNetworkAllowlistInput(value: string): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];

  for (const rawLine of value.split(/\r?\n/)) {
    const normalized = rawLine.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    entries.push(normalized);
  }

  return entries.slice(0, 50);
}

function getComputeFilesystemModeLabels(locale: Locale): Record<ComputeFilesystemMode, string> {
  return locale === "zh"
    ? {
        workspace_only: "仅 workspace",
        read_only_workspace: "只读 workspace",
        ephemeral_full: "完全临时环境",
      }
    : {
        workspace_only: "workspace only",
        read_only_workspace: "read-only workspace",
        ephemeral_full: "ephemeral full sandbox",
      };
}

type SetupSectionId = "basics" | "contract" | "pricing" | "knowledge" | "compute" | "memory";

const setupSections: Array<{
  id: SetupSectionId;
  step: string;
  label: string;
  blurb: string;
}> = [
  {
    id: "basics",
    step: "01",
    label: "Basics",
    blurb: "先定义代表身份、语气和群组触发规则。",
  },
  {
    id: "contract",
    step: "02",
    label: "Contract",
    blurb: "明确免费范围、付费边界和人工介入时窗。",
  },
  {
    id: "pricing",
    step: "03",
    label: "Pricing",
    blurb: "把四档产品包和优先级讲清楚。",
  },
  {
    id: "knowledge",
    step: "04",
    label: "Knowledge",
    blurb: "整理 FAQ、资料和政策，让 bot 先读结构化公开知识。",
  },
  {
    id: "compute",
    step: "05",
    label: "Compute",
    blurb: "配置隔离 compute plane 的预算、镜像和执行边界。",
  },
  {
    id: "memory",
    step: "06",
    label: "Memory",
    blurb: "最后再配置 OpenViking 这层进阶记忆和资源同步。",
  },
];

const setupSectionsEn: Array<{
  id: SetupSectionId;
  step: string;
  label: string;
  blurb: string;
}> = [
  {
    id: "basics",
    step: "01",
    label: "Basics",
    blurb: "Define identity, voice, and group activation rules first.",
  },
  {
    id: "contract",
    step: "02",
    label: "Contract",
    blurb: "Make the free scope, paywalls, and review window explicit.",
  },
  {
    id: "pricing",
    step: "03",
    label: "Pricing",
    blurb: "Explain the four access layers and their escalation value.",
  },
  {
    id: "knowledge",
    step: "04",
    label: "Knowledge",
    blurb: "Organize FAQ, materials, and policy before the bot improvises.",
  },
  {
    id: "compute",
    step: "05",
    label: "Compute",
    blurb: "Set the budget, image, and execution boundary for the isolated compute plane.",
  },
  {
    id: "memory",
    step: "06",
    label: "Memory",
    blurb: "Configure advanced OpenViking memory and sync last.",
  },
];

export function DashboardRepresentativeSetup({
  representativeSlug,
  locale,
}: {
  representativeSlug: string;
  locale: Locale;
}) {
  const t = pickCopy(locale, setupCopy);
  const localizedGroupActivationLabels = getGroupActivationLabels(locale);
  const localizedComputePolicyModeLabels = getComputePolicyModeLabels(locale);
  const localizedComputeNetworkModeLabels = getComputeNetworkModeLabels(locale);
  const localizedComputeFilesystemModeLabels = getComputeFilesystemModeLabels(locale);
  const intentOptions = getIntentOptions(locale);
  const materialKindOptions = getMaterialKindOptions(locale);
  const pricingTierLabels = getPricingTierLabels(locale);
  const [snapshot, setSnapshot] = useState<RepresentativeSetupSnapshot | null>(null);
  const [draft, setDraft] = useState<RepresentativeSetupSnapshot | null>(null);
  const [openVikingSnapshot, setOpenVikingSnapshot] =
    useState<RepresentativeOpenVikingSnapshot | null>(null);
  const [openVikingDraft, setOpenVikingDraft] =
    useState<RepresentativeOpenVikingSnapshot | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SetupSectionId>("basics");
  const [isPending, startTransition] = useTransition();
  const localizedSetupSections = locale === "zh" ? setupSections : setupSectionsEn;

  useEffect(() => {
    void Promise.all([
      refreshSetup(representativeSlug, setSnapshot, setDraft, setError),
      refreshOpenViking(representativeSlug, setOpenVikingSnapshot, setOpenVikingDraft, setError),
    ]);
  }, [representativeSlug]);

  useEffect(() => {
    setActiveSection("basics");
  }, [representativeSlug]);

  function updateDraft(mutator: (value: RepresentativeSetupSnapshot) => RepresentativeSetupSnapshot) {
    setDraft((current) => (current ? mutator(cloneSnapshot(current)) : current));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!draft) {
      return;
    }

    setMessage(null);
    setError(null);

    startTransition(() => {
      void (async () => {
        const response = await fetch(`/api/dashboard/representatives/${representativeSlug}/setup`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(draft),
        });

        if (!response.ok) {
          throw new Error(await extractError(response));
        }

        const nextSnapshot = (await response.json()) as RepresentativeSetupSnapshot;
        setSnapshot(nextSnapshot);
        setDraft(cloneSnapshot(nextSnapshot));
        setMessage(t.savedMessage);
      })().catch((nextError: unknown) => {
        setError(
          nextError instanceof Error
            ? nextError.message
            : t.saveError,
        );
      });
    });
  }

  function updateOpenVikingDraft(
    mutator: (value: RepresentativeOpenVikingSnapshot) => RepresentativeOpenVikingSnapshot,
  ) {
    setOpenVikingDraft((current) => (current ? mutator({ ...current }) : current));
  }

  function handleOpenVikingSubmit() {
    if (!openVikingDraft) {
      return;
    }

    setBusyKey("openviking:save");
    setMessage(null);
    setError(null);

    startTransition(() => {
      void (async () => {
        const response = await fetch(
          `/api/dashboard/representatives/${representativeSlug}/openviking`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              enabled: openVikingDraft.enabled,
              agentIdOverride: openVikingDraft.agentIdOverride,
              autoRecall: openVikingDraft.autoRecall,
              autoCapture: openVikingDraft.autoCapture,
              captureMode: openVikingDraft.captureMode,
              recallLimit: openVikingDraft.recallLimit,
              recallScoreThreshold: openVikingDraft.recallScoreThreshold,
              targetUri: openVikingDraft.targetUri,
            }),
          },
        );

        if (!response.ok) {
          throw new Error(await extractError(response));
        }

        const nextSnapshot = (await response.json()) as RepresentativeOpenVikingSnapshot;
        setOpenVikingSnapshot(nextSnapshot);
        setOpenVikingDraft(cloneOpenVikingSnapshot(nextSnapshot));
        setMessage(t.memorySavedMessage);
      })()
        .catch((nextError: unknown) => {
          setError(
            nextError instanceof Error
              ? nextError.message
              : t.memorySaveError,
        );
        })
        .finally(() => {
          setBusyKey(null);
        });
    });
  }

  function handleOpenVikingSync() {
    setBusyKey("openviking:sync");
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

        const nextSnapshot = (await response.json()) as RepresentativeOpenVikingSnapshot;
        setOpenVikingSnapshot(nextSnapshot);
        setOpenVikingDraft(cloneOpenVikingSnapshot(nextSnapshot));
        setMessage(t.memorySyncedMessage);
      })()
        .catch((nextError: unknown) => {
          setError(
            nextError instanceof Error
              ? nextError.message
              : t.memorySyncError,
        );
        })
        .finally(() => {
          setBusyKey(null);
        });
    });
  }

  if (!draft) {
    return (
      <section className="section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Representative Setup</p>
            <h2>{t.loadingHeadline}</h2>
          </div>
          <p className="section-copy">{t.loadingCopy}</p>
        </div>
      </section>
    );
  }

  const activeSectionIndex = Math.max(
    0,
    localizedSetupSections.findIndex((section) => section.id === activeSection),
  );
  const currentSection = localizedSetupSections[activeSectionIndex]!;
  const totalKnowledgeItems =
    draft.knowledgePack.faq.length +
    draft.knowledgePack.materials.length +
    draft.knowledgePack.policies.length;
  const setupSignalCards = [
    {
      label: t.signalCards.languagesLabel,
      value: `${draft.languages.length}`,
      detail: t.signalCards.languagesDetail,
      tone: "accent" as const,
    },
    {
      label: t.signalCards.freeRepliesLabel,
      value: `${draft.contract.freeReplyLimit}`,
      detail: t.signalCards.freeRepliesDetail,
      tone: "safe" as const,
    },
    {
      label: t.signalCards.pricingTiersLabel,
      value: `${draft.pricing.length}`,
      detail: t.signalCards.pricingTiersDetail,
    },
    {
      label: t.signalCards.knowledgeItemsLabel,
      value: `${totalKnowledgeItems}`,
      detail: t.signalCards.knowledgeItemsDetail,
    },
  ];
  const currentStepCards = buildSetupStepCards(
    draft,
    currentSection,
    openVikingDraft,
    locale,
    localizedGroupActivationLabels,
    localizedComputePolicyModeLabels,
    localizedComputeNetworkModeLabels,
    localizedComputeFilesystemModeLabels,
  );

  return (
    <DashboardPanelFrame
      eyebrow={t.panelEyebrow}
      id="setup"
      summary={t.panelSummary(snapshot?.name ?? draft.name)}
      title={t.panelTitle}
    >
      {message ? <div className="status-banner status-success">{message}</div> : null}
      {error ? <div className="status-banner status-error">{error}</div> : null}

      <div className="dashboard-panel-hero">
        <article className="dashboard-highlight-card dashboard-highlight-card-primary">
          <p className="panel-title">{t.identityKicker}</p>
          <h3>{draft.name}</h3>
          <p>{draft.tagline}</p>
          <div className="chip-row">
            <span className="chip">{draft.ownerName}</span>
            <span className="chip chip-safe">{localizedGroupActivationLabels[draft.groupActivation]}</span>
            <span className="chip">{draft.publicMode ? t.publicLabel : t.privateLabel}</span>
            <span className="chip">{draft.humanInLoop ? "ai + human" : "ai only"}</span>
          </div>
        </article>
        <DashboardSignalStrip cards={setupSignalCards} />
      </div>

      <DashboardSurfaceGrid>
        <DashboardSurface
          eyebrow={t.launchEyebrow}
          meta={<span className="chip chip-safe">{draft.slug}</span>}
          title={t.launchTitle}
          tone="accent"
        >
          <div className="setup-stepper-shell">
            <nav aria-label="Representative setup steps" className="setup-stepper">
              {localizedSetupSections.map((section, index) => {
                const isActive = section.id === activeSection;
                const isComplete = index < activeSectionIndex;

                return (
                  <button
                    className={
                      isActive
                        ? "setup-step-button setup-step-button-active"
                        : isComplete
                          ? "setup-step-button setup-step-button-complete"
                          : "setup-step-button"
                    }
                    key={section.id}
                    onClick={() => setActiveSection(section.id)}
                    type="button"
                  >
                    <span className="setup-step-number">{section.step}</span>
                    <strong>{section.label}</strong>
                    <span>{section.blurb}</span>
                  </button>
                );
              })}
            </nav>

            <article className="setup-step-summary">
              <div>
                <p className="panel-title">{t.currentStepLabel}</p>
                <h3>{currentSection.label}</h3>
                <p>{currentSection.blurb}</p>
              </div>
              <div className="chip-row">
                <span className="chip">
                  {activeSectionIndex + 1} / {localizedSetupSections.length}
                </span>
                <span className="chip chip-safe">{draft.slug}</span>
              </div>
            </article>
          </div>
        </DashboardSurface>

        <DashboardSurface
          eyebrow={t.stepPreviewEyebrow}
          meta={
            <span className="chip">
              {activeSectionIndex + 1} / {localizedSetupSections.length}
            </span>
          }
          title={t.stepPreviewTitle(currentSection.label)}
        >
          <div>
            <p className="section-copy">{t.stepPreviewCopy}</p>
          </div>
          <DashboardSignalStrip cards={currentStepCards} />
        </DashboardSurface>
      </DashboardSurfaceGrid>

      <form className="setup-stack" onSubmit={handleSubmit}>
        {activeSection === "basics" || activeSection === "contract" ? (
          <DashboardSurfaceGrid columns={1}>
            {activeSection === "basics" ? (
              <DashboardSurface
                eyebrow={t.basicsEyebrow}
                meta={
                  <div className="chip-row">
                    <span className="chip">{localizedGroupActivationLabels[draft.groupActivation]}</span>
                    <span className="chip">{draft.publicMode ? t.publicLabel : t.privateLabel}</span>
                    <span className="chip">{draft.humanInLoop ? t.aiHumanLabel : t.aiOnlyLabel}</span>
                  </div>
                }
                title={t.basicsTitle}
                tone="accent"
              >
                <div className="setup-grid">
                  <label className="field-stack">
                    <span>{t.ownerName}</span>
                    <input
                      className="text-input"
                      onChange={(event) =>
                        updateDraft((value) => ({ ...value, ownerName: event.target.value }))
                      }
                      value={draft.ownerName}
                    />
                  </label>

              <label className="field-stack">
                <span>{t.representativeName}</span>
                <input
                  className="text-input"
                  onChange={(event) =>
                    updateDraft((value) => ({ ...value, name: event.target.value }))
                  }
                  value={draft.name}
                />
              </label>

              <label className="field-stack field-span-full">
                <span>{t.tagline}</span>
                <input
                  className="text-input"
                  onChange={(event) =>
                    updateDraft((value) => ({ ...value, tagline: event.target.value }))
                  }
                  value={draft.tagline}
                />
              </label>

              <label className="field-stack field-span-full">
                <span>{t.tone}</span>
                <textarea
                  className="text-input textarea-input"
                  onChange={(event) =>
                    updateDraft((value) => ({ ...value, tone: event.target.value }))
                  }
                  rows={3}
                  value={draft.tone}
                />
              </label>

              <label className="field-stack">
                <span>{t.languages}</span>
                <input
                  className="text-input"
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      languages: parseCommaSeparatedList(event.target.value),
                    }))
                  }
                  value={draft.languages.join(", ")}
                />
              </label>

              <label className="field-stack">
                <span>{t.groupActivation}</span>
                <select
                  className="text-input"
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      groupActivation: event.target.value as GroupActivation,
                    }))
                  }
                  value={draft.groupActivation}
                >
                  {Object.entries(localizedGroupActivationLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="field-stack field-span-full">
                <span>{t.mode}</span>
                <div className="toggle-grid">
                  <label className="toggle-row">
                    <input
                      checked={draft.publicMode}
                      onChange={(event) =>
                        updateDraft((value) => ({ ...value, publicMode: event.target.checked }))
                      }
                      type="checkbox"
                    />
                    <span>{t.publicMode}</span>
                  </label>
                  <label className="toggle-row">
                    <input
                      checked={draft.humanInLoop}
                      onChange={(event) =>
                        updateDraft((value) => ({
                          ...value,
                          humanInLoop: event.target.checked,
                        }))
                      }
                      type="checkbox"
                    />
                    <span>{t.humanInLoop}</span>
                  </label>
                </div>
              </div>

                  <label className="field-stack field-span-full">
                    <span>{t.handoffPrompt}</span>
                    <textarea
                      className="text-input textarea-input"
                      onChange={(event) =>
                        updateDraft((value) => ({ ...value, handoffPrompt: event.target.value }))
                      }
                      rows={4}
                      value={draft.handoffPrompt}
                    />
                  </label>
                </div>
              </DashboardSurface>
            ) : null}

            {activeSection === "contract" ? (
              <DashboardSurface
                eyebrow={t.contractEyebrow}
                title={t.contractTitle}
              >
                <div className="setup-grid">
                  <label className="field-stack">
                    <span>{t.freeReplyLimit}</span>
                    <input
                      className="text-input"
                      min={1}
                      onChange={(event) =>
                        updateDraft((value) => ({
                          ...value,
                          contract: {
                            ...value.contract,
                            freeReplyLimit: Number(event.target.value || 0),
                          },
                        }))
                      }
                      type="number"
                      value={draft.contract.freeReplyLimit}
                    />
                  </label>

              <label className="field-stack">
                <span>{t.handoffWindow}</span>
                <input
                  className="text-input"
                  min={1}
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      contract: {
                        ...value.contract,
                        handoffWindowHours: Number(event.target.value || 0),
                      },
                    }))
                  }
                  type="number"
                  value={draft.contract.handoffWindowHours}
                />
              </label>

              <div className="field-stack field-span-full">
                <span>{t.freeScope}</span>
                <div className="checkbox-grid">
                  {intentOptions.map((intent) => (
                    <label className="toggle-row" key={`free-${intent.value}`}>
                      <input
                        checked={draft.contract.freeScope.includes(intent.value)}
                        onChange={(event) =>
                          updateDraft((value) => ({
                            ...value,
                            contract: {
                              ...value.contract,
                              freeScope: toggleIntent(
                                value.contract.freeScope,
                                intent.value,
                                event.target.checked,
                              ),
                            },
                          }))
                        }
                        type="checkbox"
                      />
                      <span>{intent.label}</span>
                    </label>
                  ))}
                </div>
              </div>

                  <div className="field-stack field-span-full">
                    <span>{t.paywalledIntents}</span>
                    <div className="checkbox-grid">
                      {intentOptions.map((intent) => (
                        <label className="toggle-row" key={`paid-${intent.value}`}>
                          <input
                            checked={draft.contract.paywalledIntents.includes(intent.value)}
                            onChange={(event) =>
                              updateDraft((value) => ({
                                ...value,
                                contract: {
                                  ...value.contract,
                                  paywalledIntents: toggleIntent(
                                    value.contract.paywalledIntents,
                                    intent.value,
                                    event.target.checked,
                                  ),
                                },
                              }))
                            }
                            type="checkbox"
                          />
                          <span>{intent.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </DashboardSurface>
            ) : null}
          </DashboardSurfaceGrid>
        ) : null}

        {activeSection === "pricing" ? (
          <DashboardSurface
            eyebrow={t.pricingEyebrow}
            title={t.pricingTitle}
          >
            <div className="pricing-editor-grid">
              {draft.pricing.map((plan) => (
                <div className="panel setup-plan-card" key={plan.tier}>
                  <div className="chip-row">
                    <span className="chip chip-safe">{pricingTierLabels[plan.tier]}</span>
                  </div>
                  <div className="setup-grid compact-grid">
                  <label className="field-stack">
                    <span>{t.nameLabel}</span>
                    <input
                      className="text-input"
                      onChange={(event) =>
                        updateDraft((value) => ({
                          ...value,
                          pricing: value.pricing.map((entry) =>
                            entry.tier === plan.tier
                              ? { ...entry, name: event.target.value }
                              : entry,
                          ),
                        }))
                      }
                      value={plan.name}
                    />
                  </label>

                  <label className="field-stack">
                    <span>{t.starsLabel}</span>
                    <input
                      className="text-input"
                      min={0}
                      onChange={(event) =>
                        updateDraft((value) => ({
                          ...value,
                          pricing: value.pricing.map((entry) =>
                            entry.tier === plan.tier
                              ? { ...entry, stars: Number(event.target.value || 0) }
                              : entry,
                          ),
                        }))
                      }
                      type="number"
                      value={plan.stars}
                    />
                  </label>

                  <label className="field-stack">
                    <span>{t.repliesLabel}</span>
                    <input
                      className="text-input"
                      min={0}
                      onChange={(event) =>
                        updateDraft((value) => ({
                          ...value,
                          pricing: value.pricing.map((entry) =>
                            entry.tier === plan.tier
                              ? { ...entry, includedReplies: Number(event.target.value || 0) }
                              : entry,
                          ),
                        }))
                      }
                      type="number"
                      value={plan.includedReplies}
                    />
                  </label>

                  <label className="field-stack field-span-full">
                    <span>{t.summaryLabel}</span>
                    <textarea
                      className="text-input textarea-input"
                      onChange={(event) =>
                        updateDraft((value) => ({
                          ...value,
                          pricing: value.pricing.map((entry) =>
                            entry.tier === plan.tier
                              ? { ...entry, summary: event.target.value }
                              : entry,
                          ),
                        }))
                      }
                      rows={3}
                      value={plan.summary}
                    />
                  </label>

                    <label className="toggle-row">
                      <input
                        checked={plan.includesPriorityHandoff}
                        onChange={(event) =>
                          updateDraft((value) => ({
                            ...value,
                            pricing: value.pricing.map((entry) =>
                              entry.tier === plan.tier
                                ? {
                                    ...entry,
                                    includesPriorityHandoff: event.target.checked,
                                  }
                                : entry,
                            ),
                          }))
                        }
                        type="checkbox"
                      />
                      <span>{t.priorityHandoff}</span>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </DashboardSurface>
        ) : null}

        {activeSection === "knowledge" ? (
          <DashboardSurface
            eyebrow={t.knowledgeEyebrow}
            title={t.knowledgeTitle}
          >
            <div className="setup-stack">
              <label className="field-stack">
                <span>{t.identitySummary}</span>
                <textarea
                  className="text-input textarea-input"
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      knowledgePack: {
                        ...value.knowledgePack,
                        identitySummary: event.target.value,
                      },
                    }))
                  }
                  rows={4}
                  value={draft.knowledgePack.identitySummary}
                />
              </label>

              <KnowledgeDocumentEditor
                documents={draft.knowledgePack.faq}
                fixedKind="faq"
                labels={t.documentEditor}
                onChange={(documents) =>
                  updateDraft((value) => ({
                    ...value,
                    knowledgePack: {
                      ...value.knowledgePack,
                      faq: documents,
                    },
                  }))
                }
                title="FAQ"
              />

              <KnowledgeDocumentEditor
                documents={draft.knowledgePack.materials}
                kindOptions={materialKindOptions}
                labels={t.documentEditor}
                onChange={(documents) =>
                  updateDraft((value) => ({
                    ...value,
                    knowledgePack: {
                      ...value.knowledgePack,
                      materials: documents,
                    },
                  }))
                }
                title={t.materialsTitle}
              />

              <KnowledgeDocumentEditor
                documents={draft.knowledgePack.policies}
                fixedKind="policy"
                labels={t.documentEditor}
                onChange={(documents) =>
                  updateDraft((value) => ({
                    ...value,
                    knowledgePack: {
                      ...value.knowledgePack,
                      policies: documents,
                    },
                  }))
                }
                title={t.policiesTitle}
              />
            </div>
          </DashboardSurface>
        ) : null}

        {activeSection === "compute" ? (
          <DashboardSurface
            eyebrow={t.computeEyebrow}
            meta={
              <div className="chip-row">
                <span
                  className={draft.compute.enabled ? "chip chip-safe" : "chip chip-danger"}
                >
                  {draft.compute.enabled ? "enabled" : "disabled"}
                </span>
                <span className="chip">
                  {localizedComputePolicyModeLabels[draft.compute.defaultPolicyMode]}
                </span>
                <span className="chip">
                  {localizedComputeNetworkModeLabels[draft.compute.networkMode]}
                </span>
              </div>
            }
            title={t.computeTitle}
            tone="accent"
          >
            <div className="setup-grid">
              <div className="field-stack field-span-full">
                <span>{t.togglesLabel}</span>
                <div className="toggle-grid">
                  <label className="toggle-row">
                    <input
                      checked={draft.compute.enabled}
                      onChange={(event) =>
                        updateDraft((value) => ({
                          ...value,
                          compute: {
                            ...value.compute,
                            enabled: event.target.checked,
                          },
                        }))
                      }
                      type="checkbox"
                    />
                    <span>{t.enableCompute}</span>
                  </label>
                </div>
              </div>

              <label className="field-stack">
                <span>{t.defaultPolicyMode}</span>
                <select
                  className="text-input"
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      compute: {
                        ...value.compute,
                        defaultPolicyMode: event.target.value as ComputePolicyMode,
                      },
                    }))
                  }
                  value={draft.compute.defaultPolicyMode}
                >
                  {Object.entries(localizedComputePolicyModeLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field-stack">
                <span>{t.baseImage}</span>
                <input
                  className="text-input"
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      compute: {
                        ...value.compute,
                        baseImage: event.target.value,
                      },
                    }))
                  }
                  value={draft.compute.baseImage}
                />
              </label>

              <label className="field-stack">
                <span>{t.maxSessionMinutes}</span>
                <input
                  className="text-input"
                  min={5}
                  max={240}
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      compute: {
                        ...value.compute,
                        maxSessionMinutes: Number(event.target.value || 5),
                      },
                    }))
                  }
                  type="number"
                  value={draft.compute.maxSessionMinutes}
                />
              </label>

              <label className="field-stack">
                <span>{t.autoApproveBudget}</span>
                <input
                  className="text-input"
                  min={0}
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      compute: {
                        ...value.compute,
                        autoApproveBudgetCents: Number(event.target.value || 0),
                      },
                    }))
                  }
                  type="number"
                  value={draft.compute.autoApproveBudgetCents}
                />
              </label>

              <label className="field-stack">
                <span>{t.artifactRetentionDays}</span>
                <input
                  className="text-input"
                  min={1}
                  max={365}
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      compute: {
                        ...value.compute,
                        artifactRetentionDays: Number(event.target.value || 1),
                      },
                    }))
                  }
                  type="number"
                  value={draft.compute.artifactRetentionDays}
                />
              </label>

              <label className="field-stack">
                <span>{t.networkMode}</span>
                <select
                  className="text-input"
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      compute: {
                        ...value.compute,
                        networkMode: event.target.value as ComputeNetworkMode,
                      },
                    }))
                  }
                  value={draft.compute.networkMode}
                >
                  {Object.entries(localizedComputeNetworkModeLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field-stack field-stack-wide">
                <span>{t.networkAllowlist}</span>
                <textarea
                  className="text-area"
                  disabled={draft.compute.networkMode !== "allowlist"}
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      compute: {
                        ...value.compute,
                        networkAllowlist: parseNetworkAllowlistInput(event.target.value),
                      },
                    }))
                  }
                  placeholder={t.networkAllowlistPlaceholder}
                  rows={4}
                  value={formatNetworkAllowlistInput(draft.compute.networkAllowlist)}
                />
                <small className="field-hint">{t.networkAllowlistHint}</small>
              </label>

              <label className="field-stack">
                <span>{t.filesystemMode}</span>
                <select
                  className="text-input"
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      compute: {
                        ...value.compute,
                        filesystemMode: event.target.value as ComputeFilesystemMode,
                      },
                    }))
                  }
                  value={draft.compute.filesystemMode}
                >
                  {Object.entries(localizedComputeFilesystemModeLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </DashboardSurface>
        ) : null}

        {activeSection === "memory" && openVikingDraft ? (
          <DashboardSurface
            eyebrow={t.memoryEyebrow}
            meta={
              <div className="chip-row">
                <span className="chip">{openVikingDraft.health.mode}</span>
                <span
                  className={
                    openVikingDraft.health.status === "healthy"
                      ? "chip chip-safe"
                      : openVikingDraft.health.status === "disabled"
                        ? "chip"
                        : "chip chip-danger"
                  }
                >
                  {openVikingDraft.health.status}
                </span>
                <span className="chip">{openVikingDraft.lastSyncStatus}</span>
              </div>
            }
            title={t.memoryTitle}
            tone="accent"
          >
            <div className="setup-grid">
              <div className="field-stack field-span-full">
                <span>{t.healthLabel}</span>
                <p className="muted">{openVikingDraft.health.detail}</p>
                <p className="footer-note">{t.baseUrlLabel(openVikingDraft.health.baseUrl)}</p>
                {openVikingDraft.health.consoleUrl ? (
                  <p className="footer-note">{t.consoleLabel(openVikingDraft.health.consoleUrl)}</p>
                ) : null}
              </div>

              <div className="field-stack field-span-full">
                <span>{t.togglesLabel}</span>
                <div className="toggle-grid">
                  <label className="toggle-row">
                    <input
                      checked={openVikingDraft.enabled}
                      onChange={(event) =>
                        updateOpenVikingDraft((value) => ({
                          ...value,
                          enabled: event.target.checked,
                        }))
                      }
                      type="checkbox"
                    />
                    <span>{t.enableOpenViking}</span>
                  </label>
                  <label className="toggle-row">
                    <input
                      checked={openVikingDraft.autoRecall}
                      onChange={(event) =>
                        updateOpenVikingDraft((value) => ({
                          ...value,
                          autoRecall: event.target.checked,
                        }))
                      }
                      type="checkbox"
                    />
                    <span>{t.autoRecall}</span>
                  </label>
                  <label className="toggle-row">
                    <input
                      checked={openVikingDraft.autoCapture}
                      onChange={(event) =>
                        updateOpenVikingDraft((value) => ({
                          ...value,
                          autoCapture: event.target.checked,
                        }))
                      }
                      type="checkbox"
                    />
                    <span>{t.autoCapture}</span>
                  </label>
                </div>
              </div>

              <label className="field-stack">
                <span>{t.agentIdOverride}</span>
                <input
                  className="text-input"
                  onChange={(event) =>
                    updateOpenVikingDraft((value) => {
                      const nextOverride = event.target.value.trim();
                      return {
                        representativeSlug: value.representativeSlug,
                        enabled: value.enabled,
                        agentId: value.agentId,
                        ...(nextOverride ? { agentIdOverride: nextOverride } : {}),
                        autoRecall: value.autoRecall,
                        autoCapture: value.autoCapture,
                        captureMode: value.captureMode,
                        recallLimit: value.recallLimit,
                        recallScoreThreshold: value.recallScoreThreshold,
                        targetUri: value.targetUri,
                        resourceSyncEnabled: value.resourceSyncEnabled,
                        ...(value.lastSyncAt ? { lastSyncAt: value.lastSyncAt } : {}),
                        lastSyncStatus: value.lastSyncStatus,
                        lastSyncItemCount: value.lastSyncItemCount,
                        ...(value.lastSyncError ? { lastSyncError: value.lastSyncError } : {}),
                        health: {
                          status: value.health.status,
                          detail: value.health.detail,
                          mode: value.health.mode,
                          baseUrl: value.health.baseUrl,
                          ...(value.health.consoleUrl
                            ? { consoleUrl: value.health.consoleUrl }
                            : {}),
                        },
                      };
                    })
                  }
                  placeholder={openVikingDraft.agentId}
                  value={openVikingDraft.agentIdOverride ?? ""}
                />
              </label>

              <label className="field-stack">
                <span>{t.captureMode}</span>
                <select
                  className="text-input"
                  onChange={(event) =>
                    updateOpenVikingDraft((value) => ({
                      ...value,
                      captureMode: event.target.value as "semantic" | "keyword",
                    }))
                  }
                  value={openVikingDraft.captureMode}
                >
                  <option value="semantic">semantic</option>
                  <option value="keyword">keyword</option>
                </select>
              </label>

              <label className="field-stack">
                <span>{t.recallLimit}</span>
                <input
                  className="text-input"
                  min={1}
                  max={20}
                  onChange={(event) =>
                    updateOpenVikingDraft((value) => ({
                      ...value,
                      recallLimit: Number(event.target.value || 1),
                    }))
                  }
                  type="number"
                  value={openVikingDraft.recallLimit}
                />
              </label>

              <label className="field-stack">
                <span>{t.recallScoreThreshold}</span>
                <input
                  className="text-input"
                  max={1}
                  min={0}
                  onChange={(event) =>
                    updateOpenVikingDraft((value) => ({
                      ...value,
                      recallScoreThreshold: Number(event.target.value || 0),
                    }))
                  }
                  step="0.01"
                  type="number"
                  value={openVikingDraft.recallScoreThreshold}
                />
              </label>

              <label className="field-stack field-span-full">
                <span>{t.targetResourceScope}</span>
                <input
                  className="text-input"
                  onChange={(event) =>
                    updateOpenVikingDraft((value) => ({
                      ...value,
                      targetUri: event.target.value,
                    }))
                  }
                  value={openVikingDraft.targetUri}
                />
              </label>

              <div className="field-stack field-span-full">
                <span>{t.syncStatus}</span>
                <p className="muted">
                  {t.lastSyncLabel(
                    openVikingDraft.lastSyncAt
                      ? formatTimestamp(openVikingDraft.lastSyncAt, locale)
                      : t.never,
                  )}
                </p>
                <p className="footer-note">
                  {t.syncStatusLine(openVikingDraft.lastSyncStatus, openVikingDraft.lastSyncItemCount)}
                </p>
                {openVikingDraft.lastSyncError ? (
                  <p className="footer-note">{t.errorLine(openVikingDraft.lastSyncError)}</p>
                ) : null}
              </div>
            </div>

            <div className="dashboard-action-bar">
              <button
                className="button-primary"
                disabled={isPending || busyKey === "openviking:save"}
                onClick={handleOpenVikingSubmit}
                type="button"
              >
                {busyKey === "openviking:save" ? t.saving : t.saveOpenVikingSettings}
              </button>
              <button
                className="button-secondary"
                disabled={isPending || busyKey === "openviking:sync" || !openVikingDraft.resourceSyncEnabled}
                onClick={handleOpenVikingSync}
                type="button"
              >
                {busyKey === "openviking:sync" ? t.syncing : t.syncPublicKnowledge}
              </button>
            </div>
          </DashboardSurface>
        ) : null}

        {activeSection === "memory" && !openVikingDraft ? (
          <DashboardSurface eyebrow={t.memoryEyebrow} title={t.loadingMemoryTitle}>
            <p className="muted">{t.loadingMemoryCopy}</p>
          </DashboardSurface>
        ) : null}

        <div className="dashboard-form-footer">
          <div className="button-row">
            <button
              className="button-secondary"
              disabled={activeSectionIndex <= 0}
              onClick={() =>
                setActiveSection(
                  localizedSetupSections[Math.max(0, activeSectionIndex - 1)]?.id ?? "basics",
                )
              }
              type="button"
            >
              {t.previousStep}
            </button>
            <button
              className="button-secondary"
              disabled={activeSectionIndex >= localizedSetupSections.length - 1}
              onClick={() =>
                setActiveSection(
                  localizedSetupSections[
                    Math.min(localizedSetupSections.length - 1, activeSectionIndex + 1)
                  ]?.id ?? "memory",
                )
              }
              type="button"
            >
              {t.nextStep}
            </button>
          </div>

          <div className="button-row">
            <span className="muted">
              {t.stepCount(activeSectionIndex + 1, localizedSetupSections.length)}
            </span>
            <button className="button-primary" disabled={isPending} type="submit">
              {isPending ? t.saving : t.saveRepresentativeSetup}
            </button>
          </div>
        </div>
      </form>
    </DashboardPanelFrame>
  );
}

const setupCopy = {
  zh: {
    savedMessage: "代表配置已保存。",
    saveError: "保存代表配置失败。",
    memorySavedMessage: "OpenViking 记忆设置已保存。",
    memorySaveError: "保存 OpenViking 记忆设置失败。",
    memorySyncedMessage: "代表公开知识已同步到 OpenViking。",
    memorySyncError: "同步代表公开知识到 OpenViking 失败。",
    loadingHeadline: "把 demo 配置变成真的 owner 配置",
    loadingCopy: "正在加载当前代表配置。",
    panelEyebrow: "Representative Setup",
    panelSummary: (name: string) => `当前编辑的是 ${name}，保存后公开页和运行时都应该使用这份配置。`,
    panelTitle: "让公开资料页和 bot 都读同一份代表配置",
    identityKicker: "Representative identity",
    signalCards: {
      languagesLabel: "Languages",
      languagesDetail: "代表当前对外声明支持的语言数。",
      freeRepliesLabel: "Free replies",
      freeRepliesDetail: "首次接触阶段的免费回复额度。",
      pricingTiersLabel: "Pricing tiers",
      pricingTiersDetail: "当前公开提供的访问深度层级。",
      knowledgeItemsLabel: "Knowledge items",
      knowledgeItemsDetail: "已经可供 bot 使用的结构化公开知识条目。",
    },
    publicLabel: "public",
    privateLabel: "private",
    aiHumanLabel: "ai + human",
    aiOnlyLabel: "ai only",
    launchEyebrow: "Launch flow",
    launchTitle: "渐进式代表设置",
    currentStepLabel: "Current step",
    stepPreviewEyebrow: "Step preview",
    stepPreviewTitle: (label: string) => `${label} 应该看起来可发布`,
    stepPreviewCopy: "每一步都不是后台参数页，而是在定义一个对外关系接口该如何被理解、收费和接手。",
    basicsEyebrow: "Basics",
    basicsTitle: "代表是谁、代表谁、说话风格和群组激活规则。",
    ownerName: "Owner name",
    representativeName: "Representative name",
    tagline: "Tagline",
    tone: "Tone",
    languages: "Languages",
    groupActivation: "Group activation",
    mode: "Mode",
    publicMode: "Public mode",
    humanInLoop: "Human in loop",
    handoffPrompt: "Handoff prompt",
    contractEyebrow: "Conversation Contract",
    contractTitle: "免费范围、付费边界和人工评估时窗。",
    freeReplyLimit: "Free reply limit",
    handoffWindow: "Handoff window (hours)",
    freeScope: "Free scope",
    paywalledIntents: "Paywalled intents",
    pricingEyebrow: "Pricing Plans",
    pricingTitle: "坚持四档：Free / Pass / Deep Help / Sponsor。",
    nameLabel: "Name",
    starsLabel: "Stars",
    repliesLabel: "Replies",
    summaryLabel: "Summary",
    priorityHandoff: "Includes priority handoff",
    knowledgeEyebrow: "Knowledge Pack",
    knowledgeTitle: "让公开知识先于自由发挥，回答和材料都从这里长出来。",
    identitySummary: "Identity summary",
    materialsTitle: "Materials",
    policiesTitle: "Policies",
    computeEyebrow: "Isolated Compute",
    computeTitle: "把一般性能力放进默认隔离的 compute plane，再配置默认策略与预算。",
    enableCompute: "Enable compute",
    defaultPolicyMode: "Default policy mode",
    baseImage: "Base image",
    maxSessionMinutes: "Max session minutes",
    autoApproveBudget: "Auto-approve budget (USD cents)",
    artifactRetentionDays: "Artifact retention (days)",
    networkMode: "Network mode",
    networkAllowlist: "Network allowlist",
    networkAllowlistPlaceholder: "api.example.com\n*.trusted.tools",
    networkAllowlistHint: "Only MCP-bound traffic can use allowlist mode today. Add one hostname per line.",
    filesystemMode: "Filesystem mode",
    memoryEyebrow: "OpenViking Memory",
    memoryTitle: "代表级公开记忆层：资源同步、recall、capture 和可观测性。",
    documentEditor: {
      itemsLabel: (count: number) => `${count} 项`,
      addItem: "添加条目",
      title: "标题",
      kind: "类型",
      summary: "摘要",
      url: "URL",
      remove: "删除",
      empty: "还没有任何条目。",
    },
    healthLabel: "Health",
    baseUrlLabel: (value: string) => `Base URL: ${value}`,
    consoleLabel: (value?: string) => `Console: ${value ?? ""}`,
    togglesLabel: "Toggles",
    enableOpenViking: "Enable OpenViking",
    autoRecall: "Auto recall",
    autoCapture: "Auto capture",
    agentIdOverride: "Agent ID override",
    captureMode: "Capture mode",
    recallLimit: "Recall limit",
    recallScoreThreshold: "Recall score threshold",
    targetResourceScope: "Target resource scope",
    syncStatus: "Sync status",
    never: "never",
    lastSyncLabel: (value: string) => `Last sync: ${value}`,
    syncStatusLine: (status: string, items: number) => `Status: ${status} · items: ${items}`,
    errorLine: (value: string) => `Error: ${value}`,
    saving: "保存中...",
    saveOpenVikingSettings: "保存 OpenViking 设置",
    syncing: "同步中...",
    syncPublicKnowledge: "同步公开知识",
    loadingMemoryTitle: "正在加载代表级公开记忆配置。",
    loadingMemoryCopy: "再等一下，加载完成后这里会展示代表级公开记忆配置。",
    previousStep: "上一步",
    nextStep: "下一步",
    stepCount: (current: number, total: number) => `第 ${current} / ${total} 步`,
    saveRepresentativeSetup: "保存代表配置",
  },
  en: {
    savedMessage: "Representative setup saved.",
    saveError: "Failed to save representative setup.",
    memorySavedMessage: "OpenViking memory settings saved.",
    memorySaveError: "Failed to save OpenViking memory settings.",
    memorySyncedMessage: "Representative public knowledge synced into OpenViking.",
    memorySyncError: "Failed to sync representative public knowledge into OpenViking.",
    loadingHeadline: "Turn the demo configuration into a real owner configuration",
    loadingCopy: "Loading the current representative setup.",
    panelEyebrow: "Representative Setup",
    panelSummary: (name: string) => `You are editing ${name}. After saving, the public page and runtime should both read from this configuration.`,
    panelTitle: "Make the public page and bot read from the same representative configuration",
    identityKicker: "Representative identity",
    signalCards: {
      languagesLabel: "Languages",
      languagesDetail: "How many languages this representative publicly declares.",
      freeRepliesLabel: "Free replies",
      freeRepliesDetail: "The free reply depth available in first-contact mode.",
      pricingTiersLabel: "Pricing tiers",
      pricingTiersDetail: "How many public access layers are currently offered.",
      knowledgeItemsLabel: "Knowledge items",
      knowledgeItemsDetail: "Structured public knowledge items available to the bot.",
    },
    publicLabel: "public",
    privateLabel: "private",
    aiHumanLabel: "ai + human",
    aiOnlyLabel: "ai only",
    launchEyebrow: "Launch flow",
    launchTitle: "Progressive representative setup",
    currentStepLabel: "Current step",
    stepPreviewEyebrow: "Step preview",
    stepPreviewTitle: (label: string) => `${label} should feel publishable`,
    stepPreviewCopy: "Each step defines how an external relationship interface should be understood, priced, and escalated.",
    basicsEyebrow: "Basics",
    basicsTitle: "Define identity, voice, and group activation rules.",
    ownerName: "Owner name",
    representativeName: "Representative name",
    tagline: "Tagline",
    tone: "Tone",
    languages: "Languages",
    groupActivation: "Group activation",
    mode: "Mode",
    publicMode: "Public mode",
    humanInLoop: "Human in loop",
    handoffPrompt: "Handoff prompt",
    contractEyebrow: "Conversation contract",
    contractTitle: "Free scope, paywalls, and the owner review window.",
    freeReplyLimit: "Free reply limit",
    handoffWindow: "Handoff window (hours)",
    freeScope: "Free scope",
    paywalledIntents: "Paywalled intents",
    pricingEyebrow: "Pricing plans",
    pricingTitle: "Keep the four access layers: Free / Pass / Deep Help / Sponsor.",
    nameLabel: "Name",
    starsLabel: "Stars",
    repliesLabel: "Replies",
    summaryLabel: "Summary",
    priorityHandoff: "Includes priority handoff",
    knowledgeEyebrow: "Knowledge pack",
    knowledgeTitle: "Make structured public knowledge come before improvisation.",
    identitySummary: "Identity summary",
    materialsTitle: "Materials",
    policiesTitle: "Policies",
    computeEyebrow: "Isolated compute",
    computeTitle: "Move general-purpose capability into a sandboxed compute plane, then tune the default policy and budget.",
    enableCompute: "Enable compute",
    defaultPolicyMode: "Default policy mode",
    baseImage: "Base image",
    maxSessionMinutes: "Max session minutes",
    autoApproveBudget: "Auto-approve budget (USD cents)",
    artifactRetentionDays: "Artifact retention (days)",
    networkMode: "Network mode",
    networkAllowlist: "Network allowlist",
    networkAllowlistPlaceholder: "api.example.com\n*.trusted.tools",
    networkAllowlistHint:
      "Allowlist mode currently applies to MCP-bound traffic. Enter one hostname per line.",
    filesystemMode: "Filesystem mode",
    memoryEyebrow: "OpenViking Memory",
    memoryTitle: "Representative-level public memory: sync, recall, capture, and observability.",
    documentEditor: {
      itemsLabel: (count: number) => `${count} items`,
      addItem: "Add item",
      title: "Title",
      kind: "Kind",
      summary: "Summary",
      url: "URL",
      remove: "Remove",
      empty: "No items yet.",
    },
    healthLabel: "Health",
    baseUrlLabel: (value: string) => `Base URL: ${value}`,
    consoleLabel: (value?: string) => `Console: ${value ?? ""}`,
    togglesLabel: "Toggles",
    enableOpenViking: "Enable OpenViking",
    autoRecall: "Auto recall",
    autoCapture: "Auto capture",
    agentIdOverride: "Agent ID override",
    captureMode: "Capture mode",
    recallLimit: "Recall limit",
    recallScoreThreshold: "Recall score threshold",
    targetResourceScope: "Target resource scope",
    syncStatus: "Sync status",
    never: "never",
    lastSyncLabel: (value: string) => `Last sync: ${value}`,
    syncStatusLine: (status: string, items: number) => `Status: ${status} · items: ${items}`,
    errorLine: (value: string) => `Error: ${value}`,
    saving: "Saving...",
    saveOpenVikingSettings: "Save OpenViking settings",
    syncing: "Syncing...",
    syncPublicKnowledge: "Sync public knowledge",
    loadingMemoryTitle: "Loading representative memory configuration.",
    loadingMemoryCopy: "One moment. This section will show representative-level public memory settings when loading finishes.",
    previousStep: "Previous step",
    nextStep: "Next step",
    stepCount: (current: number, total: number) => `Step ${current} of ${total}`,
    saveRepresentativeSetup: "Save representative setup",
  },
} as const;

function buildSetupStepCards(
  draft: RepresentativeSetupSnapshot,
  currentSection: { id: SetupSectionId; label: string; blurb: string },
  openVikingDraft: RepresentativeOpenVikingSnapshot | null,
  locale: Locale,
  groupActivationLabels: Record<GroupActivation, string>,
  computePolicyModeLabels: Record<ComputePolicyMode, string>,
  computeNetworkModeLabels: Record<ComputeNetworkMode, string>,
  computeFilesystemModeLabels: Record<ComputeFilesystemMode, string>,
): Array<{
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "safe" | "accent";
}> {
  switch (currentSection.id) {
    case "basics":
      if (locale === "en") {
        return [
          { label: "Owner", value: draft.ownerName, detail: "Who this representative ultimately works for.", tone: "accent" },
          { label: "Mode", value: draft.publicMode ? "Public" : "Private", detail: "Whether it is publicly exposed.", },
          { label: "Group trigger", value: groupActivationLabels[draft.groupActivation], detail: "How conservatively the rep responds inside groups.", tone: "safe" },
          { label: "Handoff", value: draft.humanInLoop ? "Ready" : "AI only", detail: "Whether high-value requests can escalate to a human.", },
        ];
      }
      return [
        {
          label: "Owner",
          value: draft.ownerName,
          detail: "这个代表最终替谁接住外部请求。",
          tone: "accent",
        },
        {
          label: "Mode",
          value: draft.publicMode ? "Public" : "Private",
          detail: "是否作为公开代表对外开放。",
        },
        {
          label: "Group trigger",
          value: groupActivationLabels[draft.groupActivation],
          detail: "群组里默认采用的保守响应策略。",
          tone: "safe",
        },
        {
          label: "Handoff",
          value: draft.humanInLoop ? "Ready" : "AI only",
          detail: "高价值请求是否允许升级到人工接手。",
        },
      ];
    case "contract":
      if (locale === "en") {
        return [
          { label: "Free limit", value: `${draft.contract.freeReplyLimit}`, detail: "Reply limit allowed in the free stage.", tone: "accent" },
          { label: "Free intents", value: `${draft.contract.freeScope.length}`, detail: "Intent types still covered for free.", },
          { label: "Paywalled", value: `${draft.contract.paywalledIntents.length}`, detail: "Intent types that require paid continuation.", tone: "safe" },
          { label: "Handoff SLA", value: `${draft.contract.handoffWindowHours}h`, detail: "Expected owner response window for handoff.", },
        ];
      }
      return [
        {
          label: "Free limit",
          value: `${draft.contract.freeReplyLimit}`,
          detail: "免费阶段允许的回复上限。",
          tone: "accent",
        },
        {
          label: "Free intents",
          value: `${draft.contract.freeScope.length}`,
          detail: "当前被纳入免费范围的意图类型。",
        },
        {
          label: "Paywalled",
          value: `${draft.contract.paywalledIntents.length}`,
          detail: "需要付费续用才能继续深入的问题类型。",
          tone: "safe",
        },
        {
          label: "Handoff SLA",
          value: `${draft.contract.handoffWindowHours}h`,
          detail: "人工升级预期的响应窗口。",
        },
      ];
    case "pricing":
      if (locale === "en") {
        return [
          { label: "Plans", value: `${draft.pricing.length}`, detail: "Current public access layers.", tone: "accent" },
          { label: "Paid tiers", value: `${draft.pricing.filter((plan) => plan.stars > 0).length}`, detail: "How many tiers actually trigger payment.", },
          { label: "Priority handoff", value: `${draft.pricing.filter((plan) => plan.includesPriorityHandoff).length}`, detail: "Pricing tiers that include priority escalation.", tone: "safe" },
          { label: "Highest tier", value: `${Math.max(...draft.pricing.map((plan) => plan.stars), 0)} Stars`, detail: "Telegram Stars price for the deepest service layer.", },
        ];
      }
      return [
        {
          label: "Plans",
          value: `${draft.pricing.length}`,
          detail: "当前对外公开的访问深度层级数。",
          tone: "accent",
        },
        {
          label: "Paid tiers",
          value: `${draft.pricing.filter((plan) => plan.stars > 0).length}`,
          detail: "真正会触发付费动作的层级数量。",
        },
        {
          label: "Priority handoff",
          value: `${draft.pricing.filter((plan) => plan.includesPriorityHandoff).length}`,
          detail: "包含优先人工升级的定价层级。",
          tone: "safe",
        },
        {
          label: "Highest tier",
          value: `${Math.max(...draft.pricing.map((plan) => plan.stars), 0)} Stars`,
          detail: "当前最深服务层的 Telegram Stars 价格。",
        },
      ];
    case "knowledge":
      if (locale === "en") {
        return [
          { label: "FAQ", value: `${draft.knowledgePack.faq.length}`, detail: "Number of high-frequency standard answers.", tone: "accent" },
          { label: "Materials", value: `${draft.knowledgePack.materials.length}`, detail: "Decks, case studies, and downloads that can be delivered directly.", },
          { label: "Policies", value: `${draft.knowledgePack.policies.length}`, detail: "Rules covering boundary, pricing, and process.", tone: "safe" },
          { label: "Identity", value: draft.knowledgePack.identitySummary ? "Ready" : "Missing", detail: "Whether the self-introduction is clear enough yet.", },
        ];
      }
      return [
        {
          label: "FAQ",
          value: `${draft.knowledgePack.faq.length}`,
          detail: "高频标准答案的条目数。",
          tone: "accent",
        },
        {
          label: "Materials",
          value: `${draft.knowledgePack.materials.length}`,
          detail: "可直接投递的 deck、case study、download 数量。",
        },
        {
          label: "Policies",
          value: `${draft.knowledgePack.policies.length}`,
          detail: "公开边界、价格与流程相关的规则条目。",
          tone: "safe",
        },
        {
          label: "Identity",
          value: draft.knowledgePack.identitySummary ? "Ready" : "Missing",
          detail: "代表自我介绍是否已经足够清晰。",
        },
      ];
    case "compute":
      if (locale === "en") {
        return [
          {
            label: "Access",
            value: draft.compute.enabled ? "Enabled" : "Disabled",
            detail: "Whether this representative can request isolated compute sessions.",
            tone: "accent",
          },
          {
            label: "Default policy",
            value: computePolicyModeLabels[draft.compute.defaultPolicyMode],
            detail: "How unmatched capabilities are handled by default.",
          },
          {
            label: "Network",
            value: computeNetworkModeLabels[draft.compute.networkMode],
            detail: "Default network boundary for each compute session.",
            tone: "safe",
          },
          {
            label: "Filesystem",
            value: computeFilesystemModeLabels[draft.compute.filesystemMode],
            detail: "How much of the workspace the runner can see.",
          },
        ];
      }
      return [
        {
          label: "Access",
          value: draft.compute.enabled ? "Enabled" : "Disabled",
          detail: "这个代表是否允许申请隔离 compute session。",
          tone: "accent",
        },
        {
          label: "Default policy",
          value: computePolicyModeLabels[draft.compute.defaultPolicyMode],
          detail: "没有命中具体规则时的默认处置方式。",
        },
        {
          label: "Network",
          value: computeNetworkModeLabels[draft.compute.networkMode],
          detail: "每个 compute session 默认采用的网络边界。",
          tone: "safe",
        },
        {
          label: "Filesystem",
          value: computeFilesystemModeLabels[draft.compute.filesystemMode],
          detail: "runner 默认可以看到多少文件系统范围。",
        },
      ];
    case "memory":
      if (locale === "en") {
        return [
          { label: "OpenViking", value: openVikingDraft?.enabled ? "Enabled" : "Off", detail: "Whether the representative-level public memory layer is enabled.", tone: "accent" },
          { label: "Recall", value: openVikingDraft?.autoRecall ? "Auto" : "Manual", detail: "Whether public context is recalled automatically before responses.", },
          { label: "Capture", value: openVikingDraft?.autoCapture ? "Auto" : "Manual", detail: "Whether public-safe memory is committed automatically at key workflow points.", tone: "safe" },
          { label: "Last sync", value: openVikingDraft?.lastSyncStatus ?? "unknown", detail: "Status of the most recent resource sync.", },
        ];
      }
      return [
        {
          label: "OpenViking",
          value: openVikingDraft?.enabled ? "Enabled" : "Off",
          detail: "是否启用代表级公开记忆层。",
          tone: "accent",
        },
        {
          label: "Recall",
          value: openVikingDraft?.autoRecall ? "Auto" : "Manual",
          detail: "是否在回复前自动召回公开上下文。",
        },
        {
          label: "Capture",
          value: openVikingDraft?.autoCapture ? "Auto" : "Manual",
          detail: "是否在关键节点自动提交公开安全记忆。",
          tone: "safe",
        },
        {
          label: "Last sync",
          value: openVikingDraft?.lastSyncStatus ?? "unknown",
          detail: "最近一次资源同步的状态。",
        },
      ];
  }
}

function KnowledgeDocumentEditor({
  title,
  documents,
  onChange,
  fixedKind,
  kindOptions,
  labels,
}: {
  title: string;
  documents: KnowledgeDocument[];
  onChange: (documents: KnowledgeDocument[]) => void;
  fixedKind?: KnowledgeDocumentKind;
  kindOptions?: Array<{ value: KnowledgeDocumentKind; label: string }>;
  labels: {
    itemsLabel: (count: number) => string;
    addItem: string;
    title: string;
    kind: string;
    summary: string;
    url: string;
    remove: string;
    empty: string;
  };
}) {
  const options =
    kindOptions ??
    (fixedKind ? [{ value: fixedKind, label: fixedKind }] : [{ value: "faq", label: "faq" }]);

  function updateDocument(id: string, next: Partial<KnowledgeDocument>) {
    onChange(
      documents.map((document) => (document.id === id ? { ...document, ...next } : document)),
    );
  }

  function addDocument() {
    const defaultKind = fixedKind ?? options[0]?.value ?? "faq";
    onChange([
      ...documents,
      {
        id: crypto.randomUUID(),
        title: "",
        kind: defaultKind,
        summary: "",
      },
    ]);
  }

  function removeDocument(id: string) {
    onChange(documents.filter((document) => document.id !== id));
  }

  return (
    <div className="setup-subsection">
      <div className="setup-section-header">
        <div>
          <h3>{title}</h3>
          <p>{labels.itemsLabel(documents.length)}</p>
        </div>
        <button className="button-secondary" onClick={addDocument} type="button">
          {labels.addItem}
        </button>
      </div>

      <div className="setup-stack">
        {documents.length ? (
          documents.map((document) => (
            <div className="knowledge-editor-card" key={document.id}>
              <div className="setup-grid compact-grid">
                <label className="field-stack">
                  <span>{labels.title}</span>
                  <input
                    className="text-input"
                    onChange={(event) =>
                      updateDocument(document.id, { title: event.target.value })
                    }
                    value={document.title}
                  />
                </label>

                {fixedKind ? (
                  <label className="field-stack">
                    <span>{labels.kind}</span>
                    <input className="text-input" readOnly value={fixedKind} />
                  </label>
                ) : (
                  <label className="field-stack">
                    <span>{labels.kind}</span>
                    <select
                      className="text-input"
                      onChange={(event) =>
                        updateDocument(document.id, {
                          kind: event.target.value as KnowledgeDocumentKind,
                        })
                      }
                      value={document.kind}
                    >
                      {options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <label className="field-stack field-span-full">
                  <span>{labels.summary}</span>
                  <textarea
                    className="text-input textarea-input"
                    onChange={(event) =>
                      updateDocument(document.id, { summary: event.target.value })
                    }
                    rows={3}
                    value={document.summary}
                  />
                </label>

                <label className="field-stack field-span-full">
                  <span>{labels.url}</span>
                  <input
                    className="text-input"
                    onChange={(event) =>
                      updateDocument(document.id, {
                        url: event.target.value.trim() ? event.target.value : undefined,
                      })
                    }
                    placeholder="https://..."
                    value={document.url ?? ""}
                  />
                </label>
              </div>

              <div className="button-row">
                <button
                  className="button-secondary"
                  onClick={() => removeDocument(document.id)}
                  type="button"
                >
                  {labels.remove}
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="muted">{labels.empty}</p>
        )}
      </div>
    </div>
  );
}

async function refreshSetup(
  representativeSlug: string,
  setSnapshot: (value: RepresentativeSetupSnapshot) => void,
  setDraft: (value: RepresentativeSetupSnapshot) => void,
  setError: (value: string | null) => void,
) {
  const response = await fetch(`/api/dashboard/representatives/${representativeSlug}/setup`, {
    cache: "no-store",
  });

  if (!response.ok) {
    setError(await extractError(response));
    return;
  }

  const nextSnapshot = (await response.json()) as RepresentativeSetupSnapshot;
  setSnapshot(nextSnapshot);
  setDraft(cloneSnapshot(nextSnapshot));
  setError(null);
}

async function refreshOpenViking(
  representativeSlug: string,
  setSnapshot: (value: RepresentativeOpenVikingSnapshot) => void,
  setDraft: (value: RepresentativeOpenVikingSnapshot) => void,
  setError: (value: string | null) => void,
) {
  const response = await fetch(`/api/dashboard/representatives/${representativeSlug}/openviking`, {
    cache: "no-store",
  });

  if (!response.ok) {
    setError(await extractError(response));
    return;
  }

  const nextSnapshot = (await response.json()) as RepresentativeOpenVikingSnapshot;
  setSnapshot(nextSnapshot);
  setDraft(cloneOpenVikingSnapshot(nextSnapshot));
  setError(null);
}

function cloneSnapshot(snapshot: RepresentativeSetupSnapshot): RepresentativeSetupSnapshot {
  return {
    ...snapshot,
    languages: [...snapshot.languages],
    contract: {
      freeReplyLimit: snapshot.contract.freeReplyLimit,
      freeScope: [...snapshot.contract.freeScope],
      paywalledIntents: [...snapshot.contract.paywalledIntents],
      handoffWindowHours: snapshot.contract.handoffWindowHours,
    },
    pricing: snapshot.pricing.map((plan) => ({ ...plan })),
    knowledgePack: {
      identitySummary: snapshot.knowledgePack.identitySummary,
      faq: snapshot.knowledgePack.faq.map((item) => ({ ...item })),
      materials: snapshot.knowledgePack.materials.map((item) => ({ ...item })),
      policies: snapshot.knowledgePack.policies.map((item) => ({ ...item })),
    },
    compute: {
      ...snapshot.compute,
    },
  };
}

function cloneOpenVikingSnapshot(
  snapshot: RepresentativeOpenVikingSnapshot,
): RepresentativeOpenVikingSnapshot {
  return {
    representativeSlug: snapshot.representativeSlug,
    enabled: snapshot.enabled,
    agentId: snapshot.agentId,
    ...(snapshot.agentIdOverride ? { agentIdOverride: snapshot.agentIdOverride } : {}),
    autoRecall: snapshot.autoRecall,
    autoCapture: snapshot.autoCapture,
    captureMode: snapshot.captureMode,
    recallLimit: snapshot.recallLimit,
    recallScoreThreshold: snapshot.recallScoreThreshold,
    targetUri: snapshot.targetUri,
    resourceSyncEnabled: snapshot.resourceSyncEnabled,
    ...(snapshot.lastSyncAt ? { lastSyncAt: snapshot.lastSyncAt } : {}),
    lastSyncStatus: snapshot.lastSyncStatus,
    lastSyncItemCount: snapshot.lastSyncItemCount,
    ...(snapshot.lastSyncError ? { lastSyncError: snapshot.lastSyncError } : {}),
    health: {
      status: snapshot.health.status,
      detail: snapshot.health.detail,
      mode: snapshot.health.mode,
      baseUrl: snapshot.health.baseUrl,
      ...(snapshot.health.consoleUrl ? { consoleUrl: snapshot.health.consoleUrl } : {}),
    },
  };
}

function parseCommaSeparatedList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toggleIntent(
  current: InquiryIntent[],
  value: InquiryIntent,
  checked: boolean,
): InquiryIntent[] {
  if (checked) {
    return current.includes(value) ? current : [...current, value];
  }

  return current.filter((entry) => entry !== value);
}

async function extractError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `Request failed with status ${response.status}.`;
  } catch {
    return `Request failed with status ${response.status}.`;
  }
}

function formatTimestamp(value: string, locale: Locale): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
}

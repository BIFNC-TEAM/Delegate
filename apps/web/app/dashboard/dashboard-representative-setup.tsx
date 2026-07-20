"use client";

import type { FormEvent } from "react";
import { useEffect, useState, useTransition } from "react";

import {
  DashboardSurface,
  DashboardSurfaceGrid,
  pickCopy,
  type Locale,
} from "@delegate/web-ui";

import { saveRepresentativeSetupRequests } from "./representative-setup-save";

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

type RepresentativeKnowledgeAsset = {
  id: string;
  kind: "pdf" | "docx" | "txt" | "markdown" | "url" | "text";
  status: "processing" | "ready" | "failed" | "archived";
  visibility: "owner_only" | "organization_shared" | "selected_representatives" | "public_material";
  title: string;
  originalFileName: string | null;
  summary: string | null;
  tags: string[];
  autoTags: string[];
  updatedAt: string;
  representativeLinks: Array<{
    representativeId: string;
    representativeSlug: string;
    enabled: boolean;
  }>;
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

export type RepresentativeSetupSectionId =
  | "basics"
  | "contract"
  | "pricing"
  | "knowledge"
  | "compute"
  | "memory";

const setupSections: Array<{
  id: RepresentativeSetupSectionId;
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
  id: RepresentativeSetupSectionId;
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
  initialSection = "basics",
  representativeSlug,
  locale,
}: {
  initialSection?: RepresentativeSetupSectionId;
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
  const [, setSnapshot] = useState<RepresentativeSetupSnapshot | null>(null);
  const [draft, setDraft] = useState<RepresentativeSetupSnapshot | null>(null);
  const [openVikingSnapshot, setOpenVikingSnapshot] =
    useState<RepresentativeOpenVikingSnapshot | null>(null);
  const [openVikingDraft, setOpenVikingDraft] =
    useState<RepresentativeOpenVikingSnapshot | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [knowledgeAssets, setKnowledgeAssets] = useState<RepresentativeKnowledgeAsset[]>([]);
  const [knowledgeAssetIds, setKnowledgeAssetIds] = useState<string[]>([]);
  const [savedKnowledgeAssetIds, setSavedKnowledgeAssetIds] = useState<string[]>([]);
  const [knowledgeAssetsLoading, setKnowledgeAssetsLoading] = useState(true);
  const [knowledgePickerOpen, setKnowledgePickerOpen] = useState(false);
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [activeSection, setActiveSection] =
    useState<RepresentativeSetupSectionId>(initialSection);
  const [isPending, startTransition] = useTransition();
  const localizedSetupSections = locale === "zh" ? setupSections : setupSectionsEn;

  useEffect(() => {
    void Promise.all([
      refreshSetup(representativeSlug, setSnapshot, setDraft, setError),
      refreshOpenViking(representativeSlug, setOpenVikingSnapshot, setOpenVikingDraft, setError),
      refreshRepresentativeKnowledgeAssets(
        representativeSlug,
        setKnowledgeAssets,
        setKnowledgeAssetIds,
        setSavedKnowledgeAssetIds,
        setKnowledgeAssetsLoading,
        setError,
      ),
    ]);
  }, [representativeSlug]);

  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection, representativeSlug]);

  useEffect(() => {
    if (!message) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setMessage(null);
    }, 6000);

    return () => window.clearTimeout(timeout);
  }, [message]);

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
        const bindingChanged = !sameStringSet(knowledgeAssetIds, savedKnowledgeAssetIds);
        const { setupResponse: response, bindingResponse } =
          await saveRepresentativeSetupRequests({
            representativeSlug,
            setup: draft,
            knowledgeAssetIds,
            bindingChanged,
          });

        if (!response.ok) {
          throw new Error(await extractError(response));
        }
        if (bindingResponse && !bindingResponse.ok) {
          throw new Error(await extractError(bindingResponse));
        }

        const nextSnapshot = (await response.json()) as RepresentativeSetupSnapshot;
        if (bindingResponse) {
          const bindingResult = (await bindingResponse.json()) as {
            assets: RepresentativeKnowledgeAsset[];
            selectedAssetIds: string[];
          };
          setKnowledgeAssets(bindingResult.assets);
          setKnowledgeAssetIds(bindingResult.selectedAssetIds);
          setSavedKnowledgeAssetIds(bindingResult.selectedAssetIds);
        }
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
    draft.knowledgePack.policies.length +
    knowledgeAssetIds.length;
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
    knowledgeAssetIds.length,
  );
  const selectedKnowledgeAssets = knowledgeAssetIds
    .map((assetId) => knowledgeAssets.find((asset) => asset.id === assetId))
    .filter((asset): asset is RepresentativeKnowledgeAsset => Boolean(asset));
  const normalizedKnowledgeQuery = knowledgeQuery.trim().toLowerCase();
  const filteredKnowledgeAssets = knowledgeAssets.filter((asset) => {
    if (!normalizedKnowledgeQuery) return true;
    return [
      asset.title,
      asset.originalFileName ?? "",
      ...asset.tags,
      ...asset.autoTags,
    ].some((value) => value.toLowerCase().includes(normalizedKnowledgeQuery));
  });
  const notification = error
    ? {
        kind: "error" as const,
        title: t.errorNotificationTitle,
        message: error,
      }
    : message
      ? {
          kind: "success" as const,
          title: t.successNotificationTitle,
          message,
        }
      : null;

  return (
    <section className="representative-config-workspace" id="setup">
      {notification ? (
        <div
          aria-live={notification.kind === "error" ? "assertive" : "polite"}
          className="representative-config-notification-viewport"
        >
          <div
            className={`representative-config-notification is-${notification.kind}`}
            role={notification.kind === "error" ? "alert" : "status"}
          >
            <span aria-hidden="true" className="representative-config-notification-mark">
              {notification.kind === "error" ? "!" : "✓"}
            </span>
            <div className="representative-config-notification-copy">
              <strong>{notification.title}</strong>
              <p>{notification.message}</p>
            </div>
            <button
              aria-label={t.dismissNotification}
              className="representative-config-notification-close"
              onClick={() => {
                if (notification.kind === "error") {
                  setError(null);
                } else {
                  setMessage(null);
                }
              }}
              type="button"
            >
              ×
            </button>
          </div>
        </div>
      ) : null}

      <section className="representative-config-summary">
        <div className="representative-config-identity">
          <span>{draft.name.slice(0, 1).toUpperCase()}</span>
          <div>
            <p>{draft.slug}</p>
            <h2>{draft.name}</h2>
            <small>{draft.tagline}</small>
          </div>
        </div>
        <div className="representative-config-signals">
          {setupSignalCards.map((card) => (
            <div key={card.label}>
              <span>{card.label}</span>
              <strong>{card.value}</strong>
            </div>
          ))}
        </div>
      </section>

      <nav aria-label="Representative setup steps" className="representative-config-stepper">
        {localizedSetupSections.map((section, index) => (
          <button
            className={section.id === activeSection ? "is-active" : index < activeSectionIndex ? "is-complete" : undefined}
            key={section.id}
            onClick={() => setActiveSection(section.id)}
            type="button"
          >
            <span>{section.step}</span>
            <strong>{section.label}</strong>
          </button>
        ))}
      </nav>

      <div className="representative-config-section-heading">
        <div>
          <p>{t.currentStepLabel}</p>
          <h3>{currentSection.label}</h3>
          <span>{currentSection.blurb}</span>
        </div>
        <b>{activeSectionIndex + 1} / {localizedSetupSections.length}</b>
      </div>

      <div className="representative-config-layout">
      <form className="setup-stack representative-config-form" onSubmit={handleSubmit}>
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
                      readOnly
                      value={draft.ownerName}
                    />
                    <small>
                      {locale === "zh"
                        ? "Owner 名称属于工作区资料，不会随单个代表配置修改。"
                        : "Owner identity belongs to workspace settings and is not edited per representative."}
                    </small>
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

              <RepresentativeKnowledgeAssetPicker
                assets={filteredKnowledgeAssets}
                loading={knowledgeAssetsLoading}
                locale={locale}
                onQueryChange={setKnowledgeQuery}
                onSelectedIdsChange={setKnowledgeAssetIds}
                onToggleOpen={() => setKnowledgePickerOpen((current) => !current)}
                open={knowledgePickerOpen}
                query={knowledgeQuery}
                selectedAssets={selectedKnowledgeAssets}
                selectedIds={knowledgeAssetIds}
              />

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
                  openVikingDraft.enabled && openVikingSnapshot?.enabled ? (
                    <p className="footer-note">{t.errorLine(openVikingDraft.lastSyncError)}</p>
                  ) : null
                ) : null}
                {!openVikingDraft.enabled ? (
                  <p className="footer-note">{t.enableBeforeSync}</p>
                ) : openVikingSnapshot?.enabled !== true ? (
                  <p className="footer-note">{t.saveBeforeSync}</p>
                ) : openVikingDraft.health.status !== "healthy" ? (
                  <p className="footer-note">{t.healthBeforeSync}</p>
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
                disabled={
                  isPending ||
                  busyKey === "openviking:sync" ||
                  !openVikingDraft.enabled ||
                  openVikingSnapshot?.enabled !== true ||
                  openVikingDraft.health.status !== "healthy" ||
                  !openVikingDraft.resourceSyncEnabled
                }
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

        <aside className="representative-config-aside">
          <header>
            <p>{t.stepPreviewEyebrow}</p>
            <h3>{t.stepPreviewTitle(currentSection.label)}</h3>
            <span>{t.stepPreviewCopy}</span>
          </header>
          <div className="representative-config-checkpoints">
            {currentStepCards.map((card) => (
              <div key={`${card.label}:${card.value}`}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            ))}
          </div>
          <div className="representative-config-draft-note">
            <strong>{locale === "zh" ? "草稿安全边界" : "Draft safety boundary"}</strong>
            <span>
              {locale === "zh"
                ? "保存只更新工作草稿；发布新版本前，公开页和会话继续使用当前活动版本。"
                : "Saving updates the working draft only. Public pages and conversations keep using the active version until you publish."}
            </span>
          </div>
        </aside>
      </div>
    </section>
  );
}

const setupCopy = {
  zh: {
    savedMessage: "代表配置已保存；变更的知识关联正在后台同步索引。",
    saveError: "保存代表配置失败。",
    successNotificationTitle: "保存成功",
    errorNotificationTitle: "操作失败",
    dismissNotification: "关闭通知",
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
    enableBeforeSync: "请先开启 OpenViking 并保存设置，再同步公开知识。",
    saveBeforeSync: "启用状态尚未保存；请先保存 OpenViking 设置。",
    healthBeforeSync: "OpenViking 服务连接恢复健康后才能同步公开知识。",
    loadingMemoryTitle: "正在加载代表级公开记忆配置。",
    loadingMemoryCopy: "再等一下，加载完成后这里会展示代表级公开记忆配置。",
    previousStep: "上一步",
    nextStep: "下一步",
    stepCount: (current: number, total: number) => `第 ${current} / ${total} 步`,
    saveRepresentativeSetup: "保存代表配置",
  },
  en: {
    savedMessage: "Representative setup saved. Changed knowledge bindings are syncing in the background.",
    saveError: "Failed to save representative setup.",
    successNotificationTitle: "Saved successfully",
    errorNotificationTitle: "Action failed",
    dismissNotification: "Dismiss notification",
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
    enableBeforeSync: "Enable OpenViking and save the settings before syncing public knowledge.",
    saveBeforeSync: "The enabled state has not been saved yet. Save OpenViking settings first.",
    healthBeforeSync: "Public knowledge can be synced after the OpenViking connection is healthy.",
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
  currentSection: { id: RepresentativeSetupSectionId; label: string; blurb: string },
  openVikingDraft: RepresentativeOpenVikingSnapshot | null,
  locale: Locale,
  groupActivationLabels: Record<GroupActivation, string>,
  computePolicyModeLabels: Record<ComputePolicyMode, string>,
  computeNetworkModeLabels: Record<ComputeNetworkMode, string>,
  computeFilesystemModeLabels: Record<ComputeFilesystemMode, string>,
  linkedKnowledgeAssetCount: number,
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
          { label: "Library files", value: `${linkedKnowledgeAssetCount}`, detail: "Processed workspace assets authorized for retrieval.", tone: "safe" },
          { label: "FAQ", value: `${draft.knowledgePack.faq.length}`, detail: "Number of high-frequency standard answers.", tone: "accent" },
          { label: "Materials", value: `${draft.knowledgePack.materials.length}`, detail: "Decks, case studies, and downloads that can be delivered directly.", },
          { label: "Policies", value: `${draft.knowledgePack.policies.length}`, detail: "Rules covering boundary, pricing, and process.", tone: "safe" },
          { label: "Identity", value: draft.knowledgePack.identitySummary ? "Ready" : "Missing", detail: "Whether the self-introduction is clear enough yet.", },
        ];
      }
      return [
        {
          label: "知识库文件",
          value: `${linkedKnowledgeAssetCount}`,
          detail: "已授权给该代表检索的工作区知识。",
          tone: "safe",
        },
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

function RepresentativeKnowledgeAssetPicker({
  assets,
  selectedAssets,
  selectedIds,
  loading,
  open,
  query,
  locale,
  onToggleOpen,
  onQueryChange,
  onSelectedIdsChange,
}: {
  assets: RepresentativeKnowledgeAsset[];
  selectedAssets: RepresentativeKnowledgeAsset[];
  selectedIds: string[];
  loading: boolean;
  open: boolean;
  query: string;
  locale: Locale;
  onToggleOpen: () => void;
  onQueryChange: (value: string) => void;
  onSelectedIdsChange: (value: string[]) => void;
}) {
  const zh = locale === "zh";
  const selectedSet = new Set(selectedIds);
  const statusLabels: Record<RepresentativeKnowledgeAsset["status"], string> = {
    ready: zh ? "已完成" : "Ready",
    processing: zh ? "处理中" : "Processing",
    failed: zh ? "异常" : "Failed",
    archived: zh ? "已归档" : "Archived",
  };

  function toggleAsset(asset: RepresentativeKnowledgeAsset) {
    const selected = selectedSet.has(asset.id);
    if (!selected && asset.status !== "ready") return;
    onSelectedIdsChange(
      selected ? selectedIds.filter((assetId) => assetId !== asset.id) : [...selectedIds, asset.id],
    );
  }

  return (
    <section className="representative-knowledge-binding">
      <header className="representative-knowledge-binding-header">
        <div>
          <p>{zh ? "工作区知识库" : "Workspace knowledge library"}</p>
          <h3>{zh ? "关联知识库文件" : "Link knowledge assets"}</h3>
          <span>
            {zh
              ? "选择已处理完成的文件供该代表检索；原文件只保存一份，可同时授权给多个代表。"
              : "Authorize processed assets for retrieval. Each source stays single-copy and can serve multiple representatives."}
          </span>
        </div>
        <div className="representative-knowledge-binding-actions">
          <b>{zh ? `已选择 ${selectedIds.length}` : `${selectedIds.length} selected`}</b>
          <button className="button-secondary" onClick={onToggleOpen} type="button">
            {open ? (zh ? "收起选择器" : "Close picker") : (zh ? "从知识库选择" : "Choose from library")}
          </button>
        </div>
      </header>

      {selectedAssets.length ? (
        <div className="representative-selected-knowledge-list">
          {selectedAssets.map((asset) => (
            <article key={asset.id}>
              <span className={`representative-knowledge-kind is-${asset.kind}`}>
                {knowledgeAssetKindLabel(asset.kind)}
              </span>
              <div>
                <strong>{asset.title}</strong>
                <small>
                  {statusLabels[asset.status]} · {asset.originalFileName ?? (zh ? "知识正文" : "Authored text")}
                </small>
              </div>
              <button
                aria-label={zh ? `解除关联 ${asset.title}` : `Unlink ${asset.title}`}
                onClick={() => toggleAsset(asset)}
                type="button"
              >
                ×
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="representative-knowledge-binding-empty">
          <strong>{zh ? "尚未关联工作区知识" : "No workspace knowledge linked"}</strong>
          <span>{zh ? "当前代表只会使用下方手工维护的结构化知识。" : "This representative currently uses only the structured entries below."}</span>
        </div>
      )}

      {open ? (
        <div className="representative-knowledge-picker">
          <div className="representative-knowledge-picker-toolbar">
            <label>
              <span aria-hidden="true">⌕</span>
              <input
                aria-label={zh ? "搜索知识库" : "Search knowledge library"}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder={zh ? "搜索文件名、标题或标签" : "Search title, filename, or tags"}
                type="search"
                value={query}
              />
            </label>
            <a href={`/dashboard?view=knowledge&lang=${locale}`}>
              {zh ? "管理知识库" : "Manage library"} →
            </a>
          </div>
          <p className="representative-knowledge-permission-note">
            {zh
              ? "选择即授权该代表访问。仅 Owner 文件会自动调整为“指定代表可见”；取消最后一个关联后恢复为仅 Owner。"
              : "Selection grants representative access. Owner-only assets become representative-scoped and return to owner-only after their final link is removed."}
          </p>
          {loading ? (
            <div className="representative-knowledge-picker-empty">{zh ? "正在加载知识库…" : "Loading knowledge assets…"}</div>
          ) : assets.length ? (
            <div className="representative-knowledge-picker-list">
              {assets.map((asset) => {
                const selected = selectedSet.has(asset.id);
                const disabled = !selected && asset.status !== "ready";
                return (
                  <label className={`${selected ? "is-selected" : ""}${disabled ? " is-disabled" : ""}`} key={asset.id}>
                    <input
                      checked={selected}
                      disabled={disabled}
                      onChange={() => toggleAsset(asset)}
                      type="checkbox"
                    />
                    <span className={`representative-knowledge-kind is-${asset.kind}`}>
                      {knowledgeAssetKindLabel(asset.kind)}
                    </span>
                    <div>
                      <strong>{asset.title}</strong>
                      <small>{asset.summary ?? asset.originalFileName ?? (zh ? "暂无摘要" : "No summary")}</small>
                      <em>
                        <i className={`is-${asset.status}`} />
                        {statusLabels[asset.status]}
                        {asset.tags.slice(0, 2).map((tag) => <b key={tag}>{tag}</b>)}
                      </em>
                    </div>
                  </label>
                );
              })}
            </div>
          ) : (
            <div className="representative-knowledge-picker-empty">
              <strong>{query ? (zh ? "没有匹配的知识" : "No matching knowledge") : (zh ? "知识库还没有内容" : "The library is empty")}</strong>
              <span>{query ? (zh ? "调整搜索词后再试。" : "Try a different search.") : (zh ? "先到知识库上传文件、网址或手工正文。" : "Import a file, URL, or authored text first.")}</span>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
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

async function refreshRepresentativeKnowledgeAssets(
  representativeSlug: string,
  setAssets: (value: RepresentativeKnowledgeAsset[]) => void,
  setSelectedIds: (value: string[]) => void,
  setSavedIds: (value: string[]) => void,
  setLoading: (value: boolean) => void,
  setError: (value: string | null) => void,
) {
  setLoading(true);
  try {
    const response = await fetch(
      `/api/dashboard/representatives/${representativeSlug}/knowledge-assets`,
    );
    if (!response.ok) throw new Error(await extractError(response));
    const payload = (await response.json()) as { assets: RepresentativeKnowledgeAsset[] };
    const selectedIds = payload.assets
      .filter((asset) =>
        asset.representativeLinks.some(
          (link) => link.representativeSlug === representativeSlug && link.enabled,
        ),
      )
      .map((asset) => asset.id);
    setAssets(payload.assets);
    setSelectedIds(selectedIds);
    setSavedIds(selectedIds);
  } catch (nextError) {
    setError(
      nextError instanceof Error
        ? nextError.message
        : "Failed to load representative knowledge assets.",
    );
  } finally {
    setLoading(false);
  }
}

function sameStringSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every((value) => values.has(value));
}

function knowledgeAssetKindLabel(kind: RepresentativeKnowledgeAsset["kind"]) {
  if (kind === "markdown") return "MD";
  if (kind === "text") return "TEXT";
  return kind.toUpperCase();
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

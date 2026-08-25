"use client";

import type { FormEvent } from "react";
import { useEffect, useState, useTransition } from "react";

import {
  DashboardSurface,
  DashboardSurfaceGrid,
  pickCopy,
  type Locale,
} from "@delegate/web-ui";

import { DashboardRepresentativeBillingProducts } from "./dashboard-representative-billing-products";
import { DashboardRepresentativeMemorySettings } from "./dashboard-representative-memory-settings";
import { saveRepresentativeSetupRequests } from "./representative-setup-save";

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

type ComputePolicyMode = "allow" | "ask" | "deny";
type ComputeNetworkMode = "no_network" | "allowlist" | "full";
type ComputeFilesystemMode = "workspace_only" | "read_only_workspace" | "ephemeral_full";
type ComputeCapability = "exec" | "read" | "write" | "process" | "browser" | "mcp";
type DelegationKnowledgeScope = "user_input_only" | "public_knowledge";
type RepresentativeSetupSnapshot = {
  id: string;
  slug: string;
  knowledgePackRevision: number;
  ownerName: string;
  name: string;
  tagline: string;
  tone: string;
  languages: string[];
  groupActivation: GroupActivation;
  publicMode: boolean;
  humanInLoop: boolean;
  handoffAccessMode: "FREE" | "PACKAGE_REQUIRED";
  contract: {
    freeReplyLimit: number;
    handoffWindowHours: number;
  };
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
    autoApproveTokenLimit: number;
    artifactRetentionDays: number;
    networkMode: ComputeNetworkMode;
    networkAllowlist: string[];
    filesystemMode: ComputeFilesystemMode;
    capabilityModes: Record<ComputeCapability, ComputePolicyMode>;
  };
  delegation: {
    enabled: boolean;
    naturalLanguageEnabled: boolean;
    explicitComputeEnabled: boolean;
    maxSteps: number;
    maxEstimatedTokens: number;
    knowledgeScope: DelegationKnowledgeScope;
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

function getComputeCapabilityLabels(locale: Locale): Record<ComputeCapability, string> {
  return locale === "zh"
    ? {
        exec: "一次性命令",
        read: "读取工作区",
        write: "写入工作区",
        process: "长期进程",
        browser: "浏览公开网页",
        mcp: "外部 MCP 工具",
      }
    : {
        exec: "One-shot command",
        read: "Read workspace",
        write: "Write workspace",
        process: "Long-running process",
        browser: "Browse public web",
        mcp: "External MCP tool",
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
    id: "pricing",
    step: "02",
    label: "价格",
    blurb: "配置人工接管说明、访问方式、服务套餐和打赏档位。",
  },
  {
    id: "knowledge",
    step: "03",
    label: "Knowledge",
    blurb: "整理 FAQ、资料和政策，让 bot 先读结构化公开知识。",
  },
  {
    id: "compute",
    step: "04",
    label: "Compute",
    blurb: "配置隔离 compute plane 的预算、镜像和执行边界。",
  },
  {
    id: "memory",
    step: "05",
    label: "记忆",
    blurb: "配置自动提取、联系人记忆、代表经验、短期上下文与同步边界。",
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
    id: "pricing",
    step: "02",
    label: "Pricing",
    blurb: "Configure the human handoff message, access, service packages, and tips.",
  },
  {
    id: "knowledge",
    step: "03",
    label: "Knowledge",
    blurb: "Organize FAQ, materials, and policy before the bot improvises.",
  },
  {
    id: "compute",
    step: "04",
    label: "Compute",
    blurb: "Set the budget, image, and execution boundary for the isolated compute plane.",
  },
  {
    id: "memory",
    step: "05",
    label: "Memory",
    blurb: "Configure automatic extraction, Contact Memory, Representative Experience, short-term context, and synchronization boundaries.",
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
  const localizedComputeCapabilityLabels = getComputeCapabilityLabels(locale);
  const materialKindOptions = getMaterialKindOptions(locale);
  const [snapshot, setSnapshot] = useState<RepresentativeSetupSnapshot | null>(null);
  const [draft, setDraft] = useState<RepresentativeSetupSnapshot | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  async function persistRepresentativeSetup(showSuccess = true): Promise<boolean> {
    if (!draft) {
      return false;
    }

    setMessage(null);
    setError(null);
    try {
      const bindingChanged = !sameStringSet(knowledgeAssetIds, savedKnowledgeAssetIds);
      const { setupResponse: response, bindingResponse, bindingError } =
        await saveRepresentativeSetupRequests({
          representativeSlug,
          setup: draft,
          knowledgeAssetIds,
          bindingChanged,
        });

      if (!response.ok) {
        const failure = await extractErrorPayload(response);
        if (
          response.status === 409
          && failure.code === "KNOWLEDGE_PACK_CONFLICT"
        ) {
          const refreshed = await refreshSetupAfterConflict(
            representativeSlug,
            setSnapshot,
            setDraft,
          );
          if (!refreshed) {
            throw new Error(t.setupConflictReloadError);
          }
          setError(t.setupConflictMessage);
          return false;
        }
        throw new Error(failure.error);
      }

      // The setup CAS has already committed at this point. Adopt its new
      // revision before reporting a later binding failure, otherwise the
      // next save would retry with a stale revision and always conflict.
      const nextSnapshot = (await response.json()) as RepresentativeSetupSnapshot;
      setSnapshot(nextSnapshot);
      setDraft(cloneSnapshot(nextSnapshot));

      if (bindingError) {
        throw bindingError;
      }
      if (bindingResponse && !bindingResponse.ok) {
        throw new Error(await extractError(bindingResponse));
      }

      if (bindingResponse) {
        const bindingResult = (await bindingResponse.json()) as {
          assets: RepresentativeKnowledgeAsset[];
          selectedAssetIds: string[];
        };
        setKnowledgeAssets(bindingResult.assets);
        setKnowledgeAssetIds(bindingResult.selectedAssetIds);
        setSavedKnowledgeAssetIds(bindingResult.selectedAssetIds);
      }
      if (showSuccess) setMessage(t.savedMessage);
      return true;
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : t.saveError,
      );
      return false;
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (activeSection === "memory") {
      return;
    }

    startTransition(() => {
      void persistRepresentativeSetup();
    });
  }

  if (!draft) {
    return (
      <section className="section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Representative Setup</p>
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
      label: t.signalCards.contractRulesLabel,
      value: `${draft.contract.handoffWindowHours}h`,
      detail: t.signalCards.contractRulesDetail,
      tone: "safe" as const,
    },
    {
      label: t.signalCards.commerceLabel,
      value: "CNY",
      detail: t.signalCards.commerceDetail,
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
    locale,
    localizedGroupActivationLabels,
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
      <div className="representative-config-main">
      <form className="setup-stack representative-config-form" onSubmit={handleSubmit}>
        {activeSection === "basics" ? (
          <DashboardSurfaceGrid columns={1}>
            {activeSection === "basics" ? (
              <DashboardSurface
                eyebrow={t.basicsEyebrow}
                meta={
                  <div className="chip-row">
                    <span className="chip">{localizedGroupActivationLabels[draft.groupActivation]}</span>
                    <span className="chip">{draft.publicMode ? t.publicLabel : t.privateLabel}</span>
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
                </div>
              </div>

                </div>
              </DashboardSurface>
            ) : null}

          </DashboardSurfaceGrid>
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
                  className={draft.compute.enabled && draft.delegation.enabled ? "chip chip-safe" : "chip chip-danger"}
                >
                  {draft.compute.enabled && draft.delegation.enabled ? "delegation enabled" : "delegation disabled"}
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
                  <label className="toggle-row">
                    <input
                      checked={draft.delegation.enabled}
                      onChange={(event) =>
                        updateDraft((value) => ({
                          ...value,
                          delegation: { ...value.delegation, enabled: event.target.checked },
                        }))
                      }
                      type="checkbox"
                    />
                    <span>{t.enableDelegation}</span>
                  </label>
                  <label className="toggle-row">
                    <input
                      checked={draft.delegation.naturalLanguageEnabled}
                      disabled={!draft.delegation.enabled}
                      onChange={(event) =>
                        updateDraft((value) => ({
                          ...value,
                          delegation: {
                            ...value.delegation,
                            naturalLanguageEnabled: event.target.checked,
                          },
                        }))
                      }
                      type="checkbox"
                    />
                    <span>{t.enableNaturalLanguageDelegation}</span>
                  </label>
                  <label className="toggle-row">
                    <input
                      checked={draft.delegation.explicitComputeEnabled}
                      disabled={!draft.delegation.enabled}
                      onChange={(event) =>
                        updateDraft((value) => ({
                          ...value,
                          delegation: {
                            ...value.delegation,
                            explicitComputeEnabled: event.target.checked,
                          },
                        }))
                      }
                      type="checkbox"
                    />
                    <span>{t.enableExplicitCompute}</span>
                  </label>
                </div>
                <small className="field-hint">{t.delegationToggleHint}</small>
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

              <div className="field-stack field-span-full">
                <span>{t.capabilityPolicies}</span>
                <div className="setup-grid">
                  {(Object.keys(localizedComputeCapabilityLabels) as ComputeCapability[]).map((capability) => (
                    <label className="field-stack" key={capability}>
                      <span>{localizedComputeCapabilityLabels[capability]}</span>
                      <select
                        className="text-input"
                        onChange={(event) =>
                          updateDraft((value) => ({
                            ...value,
                            compute: {
                              ...value.compute,
                              capabilityModes: {
                                ...value.compute.capabilityModes,
                                [capability]: event.target.value as ComputePolicyMode,
                              },
                            },
                          }))
                        }
                        value={draft.compute.capabilityModes[capability]}
                      >
                        {Object.entries(localizedComputePolicyModeLabels).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <small className="field-hint">{t.capabilityPolicyHint}</small>
              </div>

              <label className="field-stack">
                <span>{t.delegationKnowledgeScope}</span>
                <select
                  className="text-input"
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      delegation: {
                        ...value.delegation,
                        knowledgeScope: event.target.value as DelegationKnowledgeScope,
                      },
                    }))
                  }
                  value={draft.delegation.knowledgeScope}
                >
                  <option value="user_input_only">{t.userInputOnly}</option>
                  <option value="public_knowledge">{t.approvedPublicKnowledge}</option>
                </select>
              </label>

              <label className="field-stack">
                <span>{t.delegationMaxSteps}</span>
                <input
                  className="text-input"
                  min={1}
                  max={5}
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      delegation: {
                        ...value.delegation,
                        maxSteps: Number(event.target.value || 1),
                      },
                    }))
                  }
                  type="number"
                  value={draft.delegation.maxSteps}
                />
              </label>

              <label className="field-stack">
                <span>{t.delegationMaxTokens}</span>
                <input
                  className="text-input"
                  min={0}
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      delegation: {
                        ...value.delegation,
                        maxEstimatedTokens: Number(event.target.value || 0),
                      },
                    }))
                  }
                  type="number"
                  value={draft.delegation.maxEstimatedTokens}
                />
                <small className="field-hint">{t.zeroMeansUnlimited}</small>
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
                <span>{t.autoApproveTokenLimitLabel}</span>
                <input
                  className="text-input"
                  min={0}
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      compute: {
                        ...value.compute,
                        autoApproveTokenLimit: Number(event.target.value || 0),
                      },
                    }))
                  }
                  type="number"
                  value={draft.compute.autoApproveTokenLimit}
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

        {activeSection === "memory" ? (
          <DashboardRepresentativeMemorySettings
            key={representativeSlug}
            locale={locale}
            representativeSlug={representativeSlug}
          />
        ) : null}

        {activeSection !== "memory" && activeSection !== "pricing" ? <div className="dashboard-form-footer">
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
        </div> : null}
      </form>

        {activeSection === "pricing" ? (
          <>
            <DashboardRepresentativeBillingProducts
              handoffConfiguration={{
                prompt: draft.handoffPrompt,
                reviewWindowHours: draft.contract.handoffWindowHours,
                savedPrompt: snapshot?.handoffPrompt ?? draft.handoffPrompt,
                savedReviewWindowHours:
                  snapshot?.contract.handoffWindowHours
                  ?? draft.contract.handoffWindowHours,
                isPending,
                onChange: ({ prompt, reviewWindowHours }) =>
                  updateDraft((value) => ({
                    ...value,
                    handoffPrompt: prompt,
                    contract: {
                      ...value.contract,
                      handoffWindowHours: reviewWindowHours,
                    },
                  })),
                onSave: () => new Promise((resolve) => {
                  startTransition(() => {
                    void persistRepresentativeSetup(false).then(resolve);
                  });
                }),
              }}
              locale={locale}
              onCommerceSettingsSaved={(settings) => {
                const synchronizeLiveSettings = (
                  value: RepresentativeSetupSnapshot | null,
                ) => value
                  ? {
                      ...value,
                      humanInLoop: settings.humanInLoop,
                      handoffAccessMode: settings.handoffAccessMode,
                      contract: {
                        ...value.contract,
                        freeReplyLimit: settings.freeReplyLimit,
                      },
                    }
                  : value;
                setSnapshot(synchronizeLiveSettings);
                setDraft(synchronizeLiveSettings);
              }}
              representativeSlug={representativeSlug}
            />
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
              <span className="muted">
                {t.stepCount(activeSectionIndex + 1, localizedSetupSections.length)}
              </span>
            </div>
          </>
        ) : null}
      </div>

        <aside className="representative-config-aside">
          <header>
            <p>
              {activeSection === "memory"
                ? "MEMORY RUNTIME POLICY"
                : activeSection === "pricing"
                  ? "PRICING RUNTIME POLICY"
                  : t.stepPreviewEyebrow}
            </p>
            <h3>
              {activeSection === "memory"
                ? (locale === "zh" ? "实时策略，保存即生效" : "Live policy, effective when saved")
                : activeSection === "pricing"
                  ? (locale === "zh" ? "价格配置，独立保存并生效" : "Pricing controls save and apply independently")
                  : t.stepPreviewTitle(currentSection.label)}
            </h3>
            <span>
              {activeSection === "memory"
                ? (locale === "zh"
                    ? "记忆开关和渠道能力是当前代表的实时运行边界，不属于代表草稿或发布版本。"
                    : "Memory controls and channel capabilities are live runtime boundaries for this representative, not representative draft or release fields.")
                : activeSection === "pricing"
                  ? (locale === "zh"
                      ? "访问方式、人工接管权限与打赏实时生效；提示语和评估时窗随代表草稿发布。"
                      : "Access, handoff entitlement, and tips apply live; handoff copy and the review window publish with the representative draft.")
                  : t.stepPreviewCopy}
            </span>
          </header>
          {activeSection === "memory" ? (
            <div className="representative-config-draft-note is-runtime-policy">
              <strong>{locale === "zh" ? "实时策略边界" : "Live policy boundary"}</strong>
              <span>
                {locale === "zh"
                  ? "点击“保存记忆设置”后，服务端立即应用新策略；无需在“发布与运行”中再次发布。"
                  : "After you select “Save memory settings,” the server applies the policy immediately. No additional release is required in Publish & operate."}
              </span>
            </div>
          ) : activeSection === "pricing" ? (
            <>
              <div className="representative-config-checkpoints">
                {currentStepCards.map((card) => (
                  <div key={`${card.label}:${card.value}`}>
                    <span>{card.label}</span>
                    <strong>{card.value}</strong>
                    <small>{card.detail}</small>
                  </div>
                ))}
              </div>
              <div className="representative-config-draft-note is-runtime-policy">
                <strong>{locale === "zh" ? "唯一价格真相" : "Single source of price truth"}</strong>
                <span>
                  {locale === "zh"
                    ? "公开销售与权益判断仅使用下方 Owner Billing Catalog；旧固定四档已退出运行时。"
                    : "Public sales and entitlement checks use only the Owner Billing Catalog below; legacy fixed tiers are no longer part of runtime."}
                </span>
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

const setupCopy = {
  zh: {
    savedMessage: "代表配置已保存为草稿；发布新版本后才会进入公开回答。",
    saveError: "保存代表配置失败。",
    setupConflictMessage:
      "代表配置草稿已被其他操作更新。已加载最新版本，请确认后重新应用并保存你的修改。",
    setupConflictReloadError:
      "代表配置草稿已发生冲突，但无法加载最新版本。请刷新页面后重试。",
    successNotificationTitle: "保存成功",
    errorNotificationTitle: "操作失败",
    dismissNotification: "关闭通知",
    loadingCopy: "正在加载当前代表配置。",
    panelEyebrow: "Representative Setup",
    panelSummary: (name: string) => `当前编辑的是 ${name}，保存后公开页和运行时都应该使用这份配置。`,
    panelTitle: "让公开资料页和 bot 都读同一份代表配置",
    identityKicker: "Representative identity",
    signalCards: {
      languagesLabel: "Languages",
      languagesDetail: "代表当前对外声明支持的语言数。",
      contractRulesLabel: "人工评估时窗",
      contractRulesDetail: "人工接手提示语随代表版本发布；人工权益由价格策略决定。",
      commerceLabel: "价格",
      commerceDetail: "CNY 商品目录与实时访问策略独立管理。",
      knowledgeItemsLabel: "Knowledge items",
      knowledgeItemsDetail: "已经可供 bot 使用的结构化公开知识条目。",
    },
    publicLabel: "public",
    privateLabel: "private",
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
    knowledgeEyebrow: "Knowledge Pack",
    knowledgeTitle: "让公开知识先于自由发挥，回答和材料都从这里长出来。",
    identitySummary: "Identity summary",
    materialsTitle: "Materials",
    policiesTitle: "Policies",
    computeEyebrow: "Isolated Compute",
    computeTitle: "配置委托触发、能力边界、审批策略与隔离沙盒资源上限。",
    togglesLabel: "能力开关",
    enableCompute: "Enable compute",
    enableDelegation: "接受公开委托任务",
    enableNaturalLanguageDelegation: "允许自然语言自动触发任务",
    enableExplicitCompute: "开放高级 /compute 命令",
    delegationToggleHint: "自然语言负责识别任务；是否执行或审批始终由下方确定性策略决定。",
    defaultPolicyMode: "Default policy mode",
    capabilityPolicies: "能力策略",
    capabilityPolicyHint: "需审批会创建 Owner 审批；禁止会在创建沙盒前拦截。平台托管安全规则仍可进一步收紧。",
    delegationKnowledgeScope: "任务可用数据",
    userInputOnly: "仅本次会话输入",
    approvedPublicKnowledge: "会话输入 + 已审核公开知识",
    delegationMaxSteps: "单任务最大步骤数",
    delegationMaxTokens: "单任务预计 Token 上限",
    zeroMeansUnlimited: "0 表示不设置额外的任务 Token 上限；仍受平台安全策略约束。",
    baseImage: "Base image",
    maxSessionMinutes: "Max session minutes",
    autoApproveTokenLimitLabel: "自动执行 Token 上限",
    artifactRetentionDays: "Artifact retention (days)",
    networkMode: "Network mode",
    networkAllowlist: "Network allowlist",
    networkAllowlistPlaceholder: "api.example.com\n*.trusted.tools",
    networkAllowlistHint: "Only MCP-bound traffic can use allowlist mode today. Add one hostname per line.",
    filesystemMode: "Filesystem mode",
    saving: "保存中...",
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
    previousStep: "上一步",
    nextStep: "下一步",
    stepCount: (current: number, total: number) => `第 ${current} / ${total} 步`,
    saveRepresentativeSetup: "保存代表配置",
  },
  en: {
    savedMessage: "Representative setup saved as a draft. Changes affect public replies only after a new version is published.",
    saveError: "Failed to save representative setup.",
    setupConflictMessage:
      "Another action changed the representative configuration draft. The latest version is loaded; review it, reapply your edits, and save again.",
    setupConflictReloadError:
      "The representative configuration draft changed, but the latest version could not be loaded. Refresh the page and try again.",
    successNotificationTitle: "Saved successfully",
    errorNotificationTitle: "Action failed",
    dismissNotification: "Dismiss notification",
    loadingCopy: "Loading the current representative setup.",
    panelEyebrow: "Representative Setup",
    panelSummary: (name: string) => `You are editing ${name}. After saving, the public page and runtime should both read from this configuration.`,
    panelTitle: "Make the public page and bot read from the same representative configuration",
    identityKicker: "Representative identity",
    signalCards: {
      languagesLabel: "Languages",
      languagesDetail: "How many languages this representative publicly declares.",
      contractRulesLabel: "Review window",
      contractRulesDetail: "Handoff copy is versioned; pricing owns handoff access.",
      commerceLabel: "Pricing",
      commerceDetail: "CNY catalog and live access policy are managed independently.",
      knowledgeItemsLabel: "Knowledge items",
      knowledgeItemsDetail: "Structured public knowledge items available to the bot.",
    },
    publicLabel: "public",
    privateLabel: "private",
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
    knowledgeEyebrow: "Knowledge pack",
    knowledgeTitle: "Make structured public knowledge come before improvisation.",
    identitySummary: "Identity summary",
    materialsTitle: "Materials",
    policiesTitle: "Policies",
    computeEyebrow: "Isolated compute",
    computeTitle: "Configure delegation triggers, capability gates, approval policy, and sandbox resource limits.",
    togglesLabel: "Capability toggles",
    enableCompute: "Enable compute",
    enableDelegation: "Accept public delegation tasks",
    enableNaturalLanguageDelegation: "Trigger tasks from natural language",
    enableExplicitCompute: "Expose advanced /compute command",
    delegationToggleHint: "Natural language identifies the task; deterministic policy still decides whether it runs or requires approval.",
    defaultPolicyMode: "Default policy mode",
    capabilityPolicies: "Capability policies",
    capabilityPolicyHint: "Ask creates an Owner approval; deny blocks before sandbox creation. Managed platform safety rules can still tighten these choices.",
    delegationKnowledgeScope: "Task data scope",
    userInputOnly: "Current conversation input only",
    approvedPublicKnowledge: "Conversation input + approved public knowledge",
    delegationMaxSteps: "Maximum steps per task",
    delegationMaxTokens: "Estimated token limit per task",
    zeroMeansUnlimited: "0 adds no task-specific token limit; managed platform safety policies still apply.",
    baseImage: "Base image",
    maxSessionMinutes: "Max session minutes",
    autoApproveTokenLimitLabel: "Automatic-execution token limit",
    artifactRetentionDays: "Artifact retention (days)",
    networkMode: "Network mode",
    networkAllowlist: "Network allowlist",
    networkAllowlistPlaceholder: "api.example.com\n*.trusted.tools",
    networkAllowlistHint:
      "Allowlist mode currently applies to MCP-bound traffic. Enter one hostname per line.",
    filesystemMode: "Filesystem mode",
    saving: "Saving...",
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
    previousStep: "Previous step",
    nextStep: "Next step",
    stepCount: (current: number, total: number) => `Step ${current} of ${total}`,
    saveRepresentativeSetup: "Save representative setup",
  },
} as const;

function buildSetupStepCards(
  draft: RepresentativeSetupSnapshot,
  currentSection: { id: RepresentativeSetupSectionId; label: string; blurb: string },
  locale: Locale,
  groupActivationLabels: Record<GroupActivation, string>,
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
          { label: "Languages", value: `${draft.languages.length}`, detail: "Declared public response languages.", },
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
          label: "Languages",
          value: `${draft.languages.length}`,
          detail: "当前声明支持的公开回复语言。",
        },
      ];
    case "pricing":
      if (locale === "en") {
        return [
          { label: "Human handoff", value: draft.humanInLoop ? "Available" : "Paused", detail: "Live pricing controls whether a human queue may be created.", tone: "accent" },
          { label: "Review window", value: `${draft.contract.handoffWindowHours}h`, detail: "Expected owner review window after handoff.", tone: "safe" },
          { label: "Catalog", value: "CNY", detail: "Service packages and tips use the owner billing catalog." },
          { label: "Access policy", value: "Live", detail: "Free, trial, or credits-only access is saved independently." },
        ];
      }
      return [
        {
          label: "人工接手",
          value: draft.humanInLoop ? "可用" : "暂停",
          detail: "是否允许进入人工队列由实时价格策略控制。",
          tone: "accent",
        },
        {
          label: "评估时窗",
          value: `${draft.contract.handoffWindowHours}h`,
          detail: "提交人工接手后的预期评估窗口。",
          tone: "safe",
        },
        {
          label: "商品目录",
          value: "CNY",
          detail: "服务套餐与打赏档位统一使用 Owner Billing Catalog。",
        },
        {
          label: "访问策略",
          value: "实时",
          detail: "免费、试用后付费或仅额度模式独立保存。",
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
            label: "Delegation",
            value: draft.compute.enabled && draft.delegation.enabled ? "Enabled" : "Disabled",
            detail: "Whether this representative accepts tasks backed by isolated compute.",
            tone: "accent",
          },
          {
            label: "Natural language",
            value: draft.delegation.naturalLanguageEnabled ? "On" : "Off",
            detail: "Whether ordinary requests can become delegated tasks.",
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
          label: "Delegation",
          value: draft.compute.enabled && draft.delegation.enabled ? "Enabled" : "Disabled",
          detail: "这个代表是否接受由隔离 Compute 执行的委托任务。",
          tone: "accent",
        },
        {
          label: "Natural language",
          value: draft.delegation.naturalLanguageEnabled ? "On" : "Off",
          detail: "普通自然语言请求是否可以自动形成委托任务。",
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
      return [];
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

async function refreshSetupAfterConflict(
  representativeSlug: string,
  setSnapshot: (value: RepresentativeSetupSnapshot) => void,
  setDraft: (value: RepresentativeSetupSnapshot) => void,
): Promise<boolean> {
  const response = await fetch(
    `/api/dashboard/representatives/${representativeSlug}/setup`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    return false;
  }

  const nextSnapshot = (await response.json()) as RepresentativeSetupSnapshot;
  setSnapshot(nextSnapshot);
  setDraft(cloneSnapshot(nextSnapshot));
  return true;
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

function cloneSnapshot(snapshot: RepresentativeSetupSnapshot): RepresentativeSetupSnapshot {
  return {
    ...snapshot,
    languages: [...snapshot.languages],
    contract: {
      freeReplyLimit: snapshot.contract.freeReplyLimit,
      handoffWindowHours: snapshot.contract.handoffWindowHours,
    },
    knowledgePack: {
      identitySummary: snapshot.knowledgePack.identitySummary,
      faq: snapshot.knowledgePack.faq.map((item) => ({ ...item })),
      materials: snapshot.knowledgePack.materials.map((item) => ({ ...item })),
      policies: snapshot.knowledgePack.policies.map((item) => ({ ...item })),
    },
    compute: {
      ...snapshot.compute,
      networkAllowlist: [...snapshot.compute.networkAllowlist],
      capabilityModes: { ...snapshot.compute.capabilityModes },
    },
    delegation: { ...snapshot.delegation },
  };
}

function parseCommaSeparatedList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function extractError(response: Response): Promise<string> {
  return (await extractErrorPayload(response)).error;
}

async function extractErrorPayload(
  response: Response,
): Promise<{ error: string; code?: string }> {
  try {
    const payload = (await response.json()) as { error?: string; code?: string };
    return {
      error: payload.error ?? `Request failed with status ${response.status}.`,
      ...(payload.code ? { code: payload.code } : {}),
    };
  } catch {
    return { error: `Request failed with status ${response.status}.` };
  }
}

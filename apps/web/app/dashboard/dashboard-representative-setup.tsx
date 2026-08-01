"use client";

import type { FormEvent } from "react";
import { useEffect, useState, useTransition } from "react";

import {
  DashboardSurface,
  DashboardSurfaceGrid,
  pickCopy,
  type Locale,
} from "@delegate/web-ui";

import { getGovernedContextSyncPresentation } from "./dashboard-governed-context-status";
import { DashboardRepresentativeBillingProducts } from "./dashboard-representative-billing-products";
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
type ComputeCapability = "exec" | "read" | "write" | "process" | "browser" | "mcp";
type DelegationKnowledgeScope = "user_input_only" | "public_knowledge";
type ActionGateMode = "allow" | "ask_first" | "deny";
type ActionGateKey =
  | "answer_faq"
  | "collect_lead"
  | "collect_quote_request"
  | "collect_scheduling_request"
  | "deliver_material"
  | "request_handoff"
  | "charge_stars"
  | "issue_refund"
  | "offer_discount"
  | "send_sensitive_material"
  | "modify_owner_calendar"
  | "run_local_command"
  | "access_private_memory"
  | "access_private_files"
  | "send_outbound_campaign";

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
  actionGate: Record<ActionGateKey, ActionGateMode>;
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
    capabilityModes: Record<ComputeCapability, ComputePolicyMode>;
  };
  delegation: {
    enabled: boolean;
    naturalLanguageEnabled: boolean;
    explicitComputeEnabled: boolean;
    maxSteps: number;
    maxCostCents: number;
    knowledgeScope: DelegationKnowledgeScope;
  };
};

type RepresentativeOpenVikingSnapshot = {
  representativeSlug: string;
  enabled: boolean;
  autoRecall: boolean;
  autoCapture: false;
  recallLimit: number;
  recallScoreThreshold: number;
  serviceStatus: "available" | "unavailable" | "disabled";
  publicKnowledgeSyncAvailable: boolean;
  lastSyncAt?: string;
  lastSyncStatus: string;
  lastSyncItemCount: number;
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

function getActionGateLabels(locale: Locale): Record<ActionGateKey, string> {
  const labels: Record<ActionGateKey, [string, string]> = {
    answer_faq: ["回答 FAQ", "Answer FAQ"],
    collect_lead: ["收集线索", "Collect lead"],
    collect_quote_request: ["收集报价请求", "Collect quote request"],
    collect_scheduling_request: ["收集预约请求", "Collect scheduling request"],
    deliver_material: ["发送公开材料", "Deliver public material"],
    request_handoff: ["请求人工接手", "Request human handoff"],
    charge_stars: ["发起 Stars 付费", "Charge Stars"],
    issue_refund: ["发起退款", "Issue refund"],
    offer_discount: ["提供折扣", "Offer discount"],
    send_sensitive_material: ["发送敏感材料", "Send sensitive material"],
    modify_owner_calendar: ["修改 Owner 日历", "Modify Owner calendar"],
    run_local_command: ["运行本地命令", "Run local command"],
    access_private_memory: ["访问私有记忆", "Access private memory"],
    access_private_files: ["访问私有文件", "Access private files"],
    send_outbound_campaign: ["发送外呼活动", "Send outbound campaign"],
  };
  return Object.fromEntries(
    Object.entries(labels).map(([key, value]) => [key, value[locale === "zh" ? 0 : 1]]),
  ) as Record<ActionGateKey, string>;
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
    label: "记忆与使用",
    blurb: "最后配置已发布知识检索和受治理的长期上下文。",
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
    label: "Memory & Use",
    blurb: "Configure published-source retrieval and governed long-term context last.",
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
  const localizedActionGateLabels = getActionGateLabels(locale);
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
            return;
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
              autoRecall: openVikingDraft.autoRecall,
              autoCapture: false,
              recallLimit: openVikingDraft.recallLimit,
              recallScoreThreshold: openVikingDraft.recallScoreThreshold,
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
        const syncState = getGovernedContextSyncPresentation(
          nextSnapshot.lastSyncStatus,
          locale,
        );
        if (syncState.outcome === "success" || syncState.outcome === "in_progress") {
          setMessage(syncState.actionMessage);
        } else {
          setError(syncState.actionMessage);
        }
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
  const contextSyncState = getGovernedContextSyncPresentation(
    openVikingDraft?.lastSyncStatus ?? "",
    locale,
  );
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

                  <div className="field-stack field-span-full">
                    <span>{t.actionBoundaries}</span>
                    <div className="setup-grid">
                      {(Object.keys(localizedActionGateLabels) as ActionGateKey[]).map((action) => (
                        <label className="field-stack" key={action}>
                          <span>{localizedActionGateLabels[action]}</span>
                          <select
                            className="text-input"
                            onChange={(event) =>
                              updateDraft((value) => ({
                                ...value,
                                actionGate: {
                                  ...value.actionGate,
                                  [action]: event.target.value as ActionGateMode,
                                },
                              }))
                            }
                            value={draft.actionGate[action]}
                          >
                            <option value="allow">{t.actionAllow}</option>
                            <option value="ask_first">{t.actionAskFirst}</option>
                            <option value="deny">{t.actionDeny}</option>
                          </select>
                        </label>
                      ))}
                    </div>
                    <small className="field-hint">{t.actionBoundaryHint}</small>
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
                <span>{t.delegationMaxCost}</span>
                <input
                  className="text-input"
                  min={0}
                  onChange={(event) =>
                    updateDraft((value) => ({
                      ...value,
                      delegation: {
                        ...value.delegation,
                        maxCostCents: Number(event.target.value || 0),
                      },
                    }))
                  }
                  type="number"
                  value={draft.delegation.maxCostCents}
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
                <span
                  className={
                    openVikingDraft.serviceStatus === "available"
                      ? "chip chip-safe"
                      : openVikingDraft.serviceStatus === "disabled"
                        ? "chip"
                        : "chip chip-danger"
                  }
                >
                  {formatContextHealthStatus(openVikingDraft.serviceStatus, locale)}
                </span>
                <span className="chip">
                  {contextSyncState.label}
                </span>
              </div>
            }
            title={t.memoryTitle}
            tone="accent"
          >
            <div className="setup-grid">
              <div className="field-stack field-span-full">
                <span>{t.healthLabel}</span>
                <p className="muted">
                  {t.healthDetail(formatContextHealthStatus(openVikingDraft.serviceStatus, locale))}
                </p>
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
                </div>
                <p className="footer-note">{t.captureDisabledNotice}</p>
              </div>

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
                  {t.syncStatusLine(
                    contextSyncState.label,
                    openVikingDraft.lastSyncItemCount,
                  )}
                </p>
                {!openVikingDraft.enabled ? (
                  <p className="footer-note">{t.enableBeforeSync}</p>
                ) : openVikingSnapshot?.enabled !== true ? (
                  <p className="footer-note">{t.saveBeforeSync}</p>
                ) : openVikingDraft.serviceStatus !== "available" ? (
                  <p className="footer-note">{t.healthBeforeSync}</p>
                ) : (
                  contextSyncState.outcome === "blocked_unpublished"
                  || contextSyncState.outcome === "blocked_service_setup"
                  || contextSyncState.outcome === "failed"
                  || contextSyncState.outcome === "attention_required"
                ) ? (
                  <p className="footer-note">{contextSyncState.actionMessage}</p>
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
                  openVikingDraft.serviceStatus !== "available" ||
                  !openVikingDraft.publicKnowledgeSyncAvailable
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

        {activeSection === "pricing" ? (
          <DashboardRepresentativeBillingProducts
            locale={locale}
            representativeSlug={representativeSlug}
          />
        ) : null}
      </div>

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
    savedMessage: "代表配置已保存为草稿；发布新版本后才会进入公开回答。",
    saveError: "保存代表配置失败。",
    setupConflictMessage:
      "知识草稿已被养成审批或其他设置更新。已加载最新版本，请确认后重新应用并保存你的修改。",
    setupConflictReloadError:
      "知识草稿已发生冲突，但无法加载最新版本。请刷新页面后重试。",
    successNotificationTitle: "保存成功",
    errorNotificationTitle: "操作失败",
    dismissNotification: "关闭通知",
    memorySavedMessage: "受治理的上下文设置已保存。",
    memorySaveError: "保存上下文设置失败。",
    memorySyncError: "同步已发布知识失败。",
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
    actionBoundaries: "动作边界",
    actionAllow: "允许",
    actionAskFirst: "先审批",
    actionDeny: "禁止",
    actionBoundaryHint: "这是对话和业务动作边界；Compute 的六类执行能力在 Compute 步骤单独配置。",
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
    computeTitle: "配置委托触发、能力边界、审批策略与隔离沙盒资源上限。",
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
    delegationMaxCost: "单任务成本上限（美分）",
    zeroMeansUnlimited: "0 表示不设置额外任务成本上限；仍受平台和账户预算约束。",
    baseImage: "Base image",
    maxSessionMinutes: "Max session minutes",
    autoApproveBudget: "免审批成本阈值（美分）",
    artifactRetentionDays: "Artifact retention (days)",
    networkMode: "Network mode",
    networkAllowlist: "Network allowlist",
    networkAllowlistPlaceholder: "api.example.com\n*.trusted.tools",
    networkAllowlistHint: "Only MCP-bound traffic can use allowlist mode today. Add one hostname per line.",
    filesystemMode: "Filesystem mode",
    memoryEyebrow: "记忆与使用",
    memoryTitle: "只让当前已发布版本进入回答上下文。",
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
    healthLabel: "服务状态",
    healthDetail: (status: string) => `检索服务当前状态：${status}。`,
    togglesLabel: "回答上下文",
    enableOpenViking: "启用已发布知识检索",
    autoRecall: "回答前自动检索",
    captureDisabledNotice: "会话、支付和人工交接内容不会自动写入长期记忆；养成建议必须由 Owner 审核，并在发布新代表版本后才会影响回答。",
    recallLimit: "单次检索上限",
    recallScoreThreshold: "最低匹配阈值",
    syncStatus: "同步状态",
    never: "尚未同步",
    lastSyncLabel: (value: string) => `最近同步：${value}`,
    syncStatusLine: (status: string, items: number) => `状态：${status} · 项目：${items}`,
    saving: "保存中...",
    saveOpenVikingSettings: "保存上下文设置",
    syncing: "同步中...",
    syncPublicKnowledge: "同步公开知识",
    enableBeforeSync: "请先开启已发布知识检索并保存设置，再同步公开知识。",
    saveBeforeSync: "启用状态尚未保存；请先保存上下文设置。",
    healthBeforeSync: "检索服务恢复可用后才能同步公开知识。",
    loadingMemoryTitle: "正在加载记忆与使用设置。",
    loadingMemoryCopy: "再等一下，加载完成后这里会展示已发布知识的上下文设置。",
    previousStep: "上一步",
    nextStep: "下一步",
    stepCount: (current: number, total: number) => `第 ${current} / ${total} 步`,
    saveRepresentativeSetup: "保存代表配置",
  },
  en: {
    savedMessage: "Representative setup saved as a draft. Changes affect public replies only after a new version is published.",
    saveError: "Failed to save representative setup.",
    setupConflictMessage:
      "The knowledge draft changed through an approval or another setup update. The latest version is loaded; review it, reapply your edits, and save again.",
    setupConflictReloadError:
      "The knowledge draft changed, but the latest version could not be loaded. Refresh the page and try again.",
    successNotificationTitle: "Saved successfully",
    errorNotificationTitle: "Action failed",
    dismissNotification: "Dismiss notification",
    memorySavedMessage: "Governed context settings saved.",
    memorySaveError: "Failed to save governed context settings.",
    memorySyncError: "Failed to sync the current released version.",
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
    actionBoundaries: "Action boundaries",
    actionAllow: "Allow",
    actionAskFirst: "Ask first",
    actionDeny: "Deny",
    actionBoundaryHint: "These govern conversation and business actions. Configure the six execution capabilities separately in Compute.",
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
    computeTitle: "Configure delegation triggers, capability gates, approval policy, and sandbox resource limits.",
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
    delegationMaxCost: "Task cost limit (USD cents)",
    zeroMeansUnlimited: "0 adds no task-specific cost cap; platform and account budgets still apply.",
    baseImage: "Base image",
    maxSessionMinutes: "Max session minutes",
    autoApproveBudget: "Approval-free cost threshold (USD cents)",
    artifactRetentionDays: "Artifact retention (days)",
    networkMode: "Network mode",
    networkAllowlist: "Network allowlist",
    networkAllowlistPlaceholder: "api.example.com\n*.trusted.tools",
    networkAllowlistHint:
      "Allowlist mode currently applies to MCP-bound traffic. Enter one hostname per line.",
    filesystemMode: "Filesystem mode",
    memoryEyebrow: "MEMORY & USE",
    memoryTitle: "Only the current published version may enter reply context.",
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
    healthLabel: "Service status",
    healthDetail: (status: string) => `Retrieval service status: ${status}.`,
    togglesLabel: "Reply context",
    enableOpenViking: "Enable published-source retrieval",
    autoRecall: "Retrieve before replies",
    captureDisabledNotice: "Conversations, payments, and handoffs are never written to long-term memory automatically. Development suggestions require owner review and a new representative release before they can affect replies.",
    recallLimit: "Recall limit",
    recallScoreThreshold: "Recall score threshold",
    syncStatus: "Sync status",
    never: "never",
    lastSyncLabel: (value: string) => `Last sync: ${value}`,
    syncStatusLine: (status: string, items: number) => `Status: ${status} · items: ${items}`,
    saving: "Saving...",
    saveOpenVikingSettings: "Save context settings",
    syncing: "Syncing...",
    syncPublicKnowledge: "Sync public knowledge",
    enableBeforeSync: "Enable published-source retrieval and save the settings before syncing public knowledge.",
    saveBeforeSync: "The enabled state has not been saved yet. Save the context settings first.",
    healthBeforeSync: "Public knowledge can be synced after the retrieval service is available.",
    loadingMemoryTitle: "Loading Memory & Use settings.",
    loadingMemoryCopy: "One moment. This section will show context settings for published knowledge.",
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
      if (locale === "en") {
        return [
          { label: "Published context", value: openVikingDraft?.enabled ? "Enabled" : "Off", detail: "Whether the active published version can be retrieved for replies.", tone: "accent" },
          { label: "Retrieval", value: openVikingDraft?.autoRecall ? "Automatic" : "Manual", detail: "Whether published context is retrieved before replies.", },
          { label: "Conversation capture", value: "Off", detail: "Raw conversations, payments, and handoffs are not written to long-term memory.", tone: "safe" },
          {
            label: "Last sync",
            value: getGovernedContextSyncPresentation(
              openVikingDraft?.lastSyncStatus ?? "",
              locale,
            ).label,
            detail: "Status of the most recent published-content sync.",
          },
        ];
      }
      return [
        {
          label: "已发布上下文",
          value: openVikingDraft?.enabled ? "已开启" : "已关闭",
          detail: "是否允许回答检索当前活动的已发布版本。",
          tone: "accent",
        },
        {
          label: "检索",
          value: openVikingDraft?.autoRecall ? "自动" : "手动",
          detail: "是否在回复前检索已发布上下文。",
        },
        {
          label: "会话采集",
          value: "关闭",
          detail: "原始会话、支付和人工交接内容不会写入长期记忆。",
          tone: "safe",
        },
        {
          label: "最近同步",
          value: getGovernedContextSyncPresentation(
            openVikingDraft?.lastSyncStatus ?? "",
            locale,
          ).label,
          detail: "最近一次已发布内容同步的状态。",
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
    actionGate: { ...snapshot.actionGate },
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

function cloneOpenVikingSnapshot(
  snapshot: RepresentativeOpenVikingSnapshot,
): RepresentativeOpenVikingSnapshot {
  return {
    representativeSlug: snapshot.representativeSlug,
    enabled: snapshot.enabled,
    autoRecall: snapshot.autoRecall,
    autoCapture: false,
    recallLimit: snapshot.recallLimit,
    recallScoreThreshold: snapshot.recallScoreThreshold,
    serviceStatus: snapshot.serviceStatus,
    publicKnowledgeSyncAvailable: snapshot.publicKnowledgeSyncAvailable,
    ...(snapshot.lastSyncAt ? { lastSyncAt: snapshot.lastSyncAt } : {}),
    lastSyncStatus: snapshot.lastSyncStatus,
    lastSyncItemCount: snapshot.lastSyncItemCount,
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

function formatContextHealthStatus(
  value: RepresentativeOpenVikingSnapshot["serviceStatus"],
  locale: Locale,
): string {
  if (locale === "zh") {
    return value === "available" ? "可用" : value === "unavailable" ? "暂时异常" : "未启用";
  }
  return value === "available" ? "Available" : value === "unavailable" ? "Temporarily unavailable" : "Disabled";
}

function formatTimestamp(value: string, locale: Locale): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
}

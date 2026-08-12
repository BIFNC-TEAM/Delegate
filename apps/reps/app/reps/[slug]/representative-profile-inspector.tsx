"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  PUBLIC_WALLET_UPDATED_EVENT,
  type PublicWalletStateSnapshot,
} from "./public-wallet-client";
import {
  REPRESENTATIVE_PROFILE_SECTION_OPEN_EVENT,
  type RepresentativeProfileSection,
} from "./representative-profile-rail-events";

type ProfileResource = {
  id: string;
  title: string;
  kind: "material" | "deliverable";
  href: string | null;
};

type ProfilePackage = {
  name: string;
  amountCents: number;
  entitlementUnits: number;
  includesHumanHandoff: boolean;
};

type BindingSnapshot = {
  provider: "TELEGRAM" | "MATRIX";
};

type BindingStatePayload = {
  currentBindings: {
    telegram: BindingSnapshot[];
    matrix: BindingSnapshot[];
  };
  capabilities: {
    telegram: boolean;
    matrix: boolean;
  };
};

type BindingState =
  | { status: "signed_out" }
  | { status: "loading" }
  | { status: "unavailable" }
  | {
      status: "ready";
      telegram: "linked" | "available" | "unavailable";
      matrix: "linked" | "available" | "unavailable";
    };

type RecentOrderState =
  | { status: "signed_out" }
  | { status: "loading" }
  | { status: "unavailable" }
  | {
      status: "ready";
      order: PublicWalletStateSnapshot["orders"][number] | null;
    };

export function RepresentativeProfileInspector(props: {
  audienceAuthenticated: boolean;
  bindingManagement?: ReactNode;
  capabilities: Array<{ title: string; detail: string }>;
  commerceManagement?: ReactNode;
  faq: Array<{ id: string; title: string; summary: string }>;
  hasPublicCommerce: boolean;
  humanInLoop: boolean;
  initialSection?: RepresentativeProfileSection;
  locale: "zh" | "en";
  loginHref: string;
  memoryDisclosure: string;
  ownerName: string;
  packagePreview: ProfilePackage | null;
  representativeName: string;
  representativeSlug: string;
  resources: ProfileResource[];
  tagline: string;
  trustItems: string[];
}) {
  const t = props.locale === "zh" ? zhCopy : enCopy;
  const [bindingState, setBindingState] = useState<BindingState>(
    props.audienceAuthenticated ? { status: "loading" } : { status: "signed_out" },
  );
  const [activeModal, setActiveModal] = useState<
    RepresentativeProfileSection | "binding-help" | null
  >(props.initialSection ?? null);
  const [recentOrderState, setRecentOrderState] = useState<RecentOrderState>(
    props.audienceAuthenticated && props.hasPublicCommerce
      ? { status: "loading" }
      : { status: "signed_out" },
  );
  const modalTriggerRef = useRef<HTMLElement | null>(null);
  const closeHelpRef = useRef<HTMLButtonElement>(null);
  const modalCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!props.audienceAuthenticated) {
      setBindingState({ status: "signed_out" });
      return;
    }

    const controller = new AbortController();
    setBindingState({ status: "loading" });
    void fetch(`/reps/${props.representativeSlug}/identity-bindings`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("binding state unavailable");
        return (await response.json()) as BindingStatePayload;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setBindingState({
          status: "ready",
          telegram: payload.currentBindings.telegram.length > 0
            ? "linked"
            : payload.capabilities.telegram
              ? "available"
              : "unavailable",
          matrix: payload.currentBindings.matrix.length > 0
            ? "linked"
            : payload.capabilities.matrix
              ? "available"
              : "unavailable",
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setBindingState({ status: "unavailable" });
      });

    return () => controller.abort();
  }, [props.audienceAuthenticated, props.representativeSlug]);

  useEffect(() => {
    if (!props.audienceAuthenticated || !props.hasPublicCommerce) {
      setRecentOrderState({ status: "signed_out" });
      return;
    }

    let activeController: AbortController | null = null;
    const loadRecentOrder = () => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      setRecentOrderState((current) => current.status === "ready" ? current : { status: "loading" });
      void fetch(`/reps/${props.representativeSlug}/recharge?currency=CNY`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("recent order unavailable");
          return (await response.json()) as PublicWalletStateSnapshot;
        })
        .then((payload) => {
          if (!controller.signal.aborted) {
            setRecentOrderState({ status: "ready", order: payload.orders[0] ?? null });
          }
        })
        .catch((error: unknown) => {
          if (
            !controller.signal.aborted
            && !(error instanceof DOMException && error.name === "AbortError")
          ) {
            setRecentOrderState({ status: "unavailable" });
          }
        });
    };

    loadRecentOrder();
    window.addEventListener(PUBLIC_WALLET_UPDATED_EVENT, loadRecentOrder);
    return () => {
      activeController?.abort();
      window.removeEventListener(PUBLIC_WALLET_UPDATED_EVENT, loadRecentOrder);
    };
  }, [props.audienceAuthenticated, props.hasPublicCommerce, props.representativeSlug]);

  useEffect(() => {
    const openSection = (event: Event) => {
      const detail = (event as CustomEvent<{
        opener?: HTMLElement;
        section?: RepresentativeProfileSection;
      }>).detail;
      if (!detail?.section) return;
      modalTriggerRef.current = detail.opener?.isConnected ? detail.opener : null;
      setActiveModal(detail.section);
    };
    window.addEventListener(REPRESENTATIVE_PROFILE_SECTION_OPEN_EVENT, openSection);
    return () => window.removeEventListener(
      REPRESENTATIVE_PROFILE_SECTION_OPEN_EVENT,
      openSection,
    );
  }, []);

  useEffect(() => {
    if (!activeModal) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeHelpRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActiveModal(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        modalCardRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      modalTriggerRef.current?.focus();
    };
  }, [activeModal]);

  function openModal(
    modal: RepresentativeProfileSection | "binding-help",
    opener: HTMLElement,
  ) {
    modalTriggerRef.current = opener;
    setActiveModal(modal);
  }

  return (
    <section className="representative-profile-inspector" aria-label={t.profileLabel}>
      <header className="representative-inspector-summary">
        <div aria-hidden="true" className="representative-inspector-avatar">
          {props.representativeName.slice(0, 1).toUpperCase()}
        </div>
        <div>
          <span className="panel-title">{t.profileEyebrow}</span>
          <strong>{props.representativeName}</strong>
          <small>{t.representing(props.ownerName)}</small>
        </div>
      </header>

      <details className="representative-inspector-section" open>
        <summary>{t.aboutLabel}</summary>
        <div className="representative-inspector-section-body">
          <p>{props.tagline}</p>
          <span className="representative-inspector-note">
            {props.humanInLoop ? t.aiHumanSupport : t.aiOnlySupport}
          </span>
        </div>
      </details>

      {props.capabilities.length > 0 ? (
        <details className="representative-inspector-section">
          <summary>{t.capabilitiesLabel}</summary>
          <div className="representative-inspector-section-body">
            <ul className="representative-profile-capabilities">
              {props.capabilities.map((capability) => (
                <li key={capability.title}>
                  <strong>{capability.title}</strong>
                  <span>{capability.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}

      <details className="representative-inspector-section" id="profile-channels">
        <summary>
          <span>{t.channelLabel}</span>
          <BindingSummary state={bindingState} t={t} />
        </summary>
        <div className="representative-inspector-section-body">
          <p>{t.channelDetail}</p>
          {bindingState.status === "ready" ? (
            <div className="representative-channel-statuses">
              <ChannelStatus label="Telegram" state={bindingState.telegram} t={t} />
              <ChannelStatus label="Matrix" state={bindingState.matrix} t={t} />
            </div>
          ) : bindingState.status === "loading" ? (
            <p className="representative-inspector-note" role="status">{t.loadingBindings}</p>
          ) : bindingState.status === "unavailable" ? (
            <p className="representative-inspector-note is-warning" role="status">{t.bindingsUnavailable}</p>
          ) : null}
          <div className="representative-inspector-actions">
            {props.audienceAuthenticated ? (
              <button
                className="button-secondary"
                onClick={(event) => openModal("bindings", event.currentTarget)}
                type="button"
              >
                {t.manageBindings}
              </button>
            ) : (
              <a className="button-secondary" href={props.loginHref}>{t.loginToBind}</a>
            )}
            <button
              aria-haspopup="dialog"
              className="representative-inspector-help"
              onClick={(event) => openModal("binding-help", event.currentTarget)}
              type="button"
            >
              <InfoIcon />
              <span>{t.bindingHelp}</span>
            </button>
          </div>
        </div>
      </details>

      {props.faq.length > 0 || props.resources.length > 0 ? (
        <details className="representative-inspector-section" id="profile-knowledge">
          <summary>{t.resourcesLabel}</summary>
          <div className="representative-inspector-section-body">
            {props.faq.slice(0, 2).map((item) => (
              <details className="representative-profile-faq" key={item.id}>
                <summary>{item.title}</summary>
                <p>{item.summary}</p>
              </details>
            ))}
            {props.resources.length > 0 ? (
              <div className="representative-profile-resources">
                {props.resources.slice(0, 3).map((resource) => resource.href ? (
                  <a href={resource.href} key={resource.id}>
                    <span>{resource.title}</span>
                    <small>{resource.kind === "material" ? t.materialLabel : t.deliverableLabel}</small>
                  </a>
                ) : (
                  <span className="is-unavailable" key={resource.id}>
                    <span>{resource.title}</span>
                    <small>{t.pendingResource}</small>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </details>
      ) : null}

      {props.hasPublicCommerce ? (
        <details className="representative-inspector-section">
          <summary>{t.servicesLabel}</summary>
          <div className="representative-inspector-section-body">
            {props.packagePreview ? (
              <div className="representative-profile-package-preview">
                <span>{t.recommendedPackage}</span>
                <strong>{props.packagePreview.name}</strong>
                <p>
                  {formatCny(props.packagePreview.amountCents, props.locale)}
                  {" · "}
                  {t.credits(props.packagePreview.entitlementUnits)}
                </p>
                {props.packagePreview.includesHumanHandoff ? (
                  <small>{t.includesHandoff}</small>
                ) : null}
              </div>
            ) : (
              <p>{t.orderHistoryAvailable}</p>
            )}
            <RecentOrder state={recentOrderState} locale={props.locale} t={t} />
            <button
              className="button-primary"
              onClick={(event) => openModal("services", event.currentTarget)}
              type="button"
            >
              {t.openServices}
            </button>
          </div>
        </details>
      ) : null}

      <details className="representative-inspector-section" id="profile-privacy">
        <summary>{t.privacyLabel}</summary>
        <div className="representative-inspector-section-body">
          <ul className="representative-profile-boundaries">
            {props.trustItems.slice(0, 3).map((item) => <li key={item}>{item}</li>)}
          </ul>
          <button
            className="representative-inspector-text-action"
            onClick={(event) => openModal("privacy", event.currentTarget)}
            type="button"
          >
            {t.fullPrivacy}
          </button>
        </div>
      </details>

      {activeModal ? (
        <div
          aria-label={getModalTitle(activeModal, t)}
          aria-modal="true"
          className="representative-profile-modal"
          role="dialog"
        >
          <button
            aria-label={t.close}
            className="representative-profile-modal-backdrop"
            onClick={() => setActiveModal(null)}
            type="button"
          />
          <div
            className={`representative-profile-modal-card${activeModal === "bindings" || activeModal === "services" ? " is-workspace" : ""}`}
            ref={modalCardRef}
          >
            <header>
              <div>
                <span className="panel-title">{getModalEyebrow(activeModal, t)}</span>
                <h2>{getModalTitle(activeModal, t)}</h2>
              </div>
              <button
                aria-label={t.close}
                className="representative-profile-modal-close"
                onClick={() => setActiveModal(null)}
                ref={closeHelpRef}
                type="button"
              >
                ×
              </button>
            </header>
            {activeModal === "binding-help" ? (
              <>
                <div className="representative-profile-modal-copy">
                  {t.bindingHelpItems.map((item) => <p key={item}>{item}</p>)}
                </div>
                {props.audienceAuthenticated ? (
                  <button
                    className="button-primary"
                    onClick={() => setActiveModal("bindings")}
                    type="button"
                  >
                    {t.manageBindings}
                  </button>
                ) : <a className="button-primary" href={props.loginHref}>{t.loginToBind}</a>}
              </>
            ) : activeModal === "bindings" ? (
              <div className="representative-profile-modal-workspace">
                {props.bindingManagement}
              </div>
            ) : activeModal === "services" ? (
              <div className="representative-profile-modal-workspace">
                {props.commerceManagement}
              </div>
            ) : (
              <div className="representative-profile-privacy-detail">
                <ul className="representative-profile-boundaries">
                  {props.trustItems.map((item) => <li key={item}>{item}</li>)}
                </ul>
                <details open>
                  <summary>{t.memoryLabel}</summary>
                  <p>{props.memoryDisclosure}</p>
                </details>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function BindingSummary({ state, t }: { state: BindingState; t: typeof zhCopy | typeof enCopy }) {
  if (state.status === "loading") return <small>{t.loadingShort}</small>;
  if (state.status === "unavailable") return <small>{t.unavailableShort}</small>;
  if (state.status === "signed_out") return <small>{t.notCheckedShort}</small>;
  const count = [state.telegram, state.matrix].filter((item) => item === "linked").length;
  return <small>{count > 0 ? t.linkedCount(count) : t.notLinkedShort}</small>;
}

function getModalTitle(
  modal: RepresentativeProfileSection | "binding-help",
  t: typeof zhCopy | typeof enCopy,
) {
  if (modal === "bindings") return t.bindingManagementTitle;
  if (modal === "services") return t.servicesManagementTitle;
  if (modal === "privacy") return t.privacyManagementTitle;
  return t.bindingHelpTitle;
}

function getModalEyebrow(
  modal: RepresentativeProfileSection | "binding-help",
  t: typeof zhCopy | typeof enCopy,
) {
  if (modal === "services") return t.servicesLabel;
  if (modal === "privacy") return t.privacyLabel;
  return t.channelLabel;
}

function ChannelStatus({
  label,
  state,
  t,
}: {
  label: string;
  state: "linked" | "available" | "unavailable";
  t: typeof zhCopy | typeof enCopy;
}) {
  return (
    <span className={`representative-channel-status is-${state}`}>
      <i aria-hidden="true" />
      <span>{label}</span>
      <small>{state === "linked" ? t.linked : state === "available" ? t.notLinked : t.channelUnavailable}</small>
    </span>
  );
}

function RecentOrder({
  locale,
  state,
  t,
}: {
  locale: "zh" | "en";
  state: RecentOrderState;
  t: typeof zhCopy | typeof enCopy;
}) {
  if (state.status === "signed_out") {
    return <p className="representative-inspector-note">{t.loginForOrders}</p>;
  }
  if (state.status === "loading") {
    return <p className="representative-inspector-note" role="status">{t.loadingOrders}</p>;
  }
  if (state.status === "unavailable") {
    return <p className="representative-inspector-note is-warning" role="status">{t.ordersUnavailable}</p>;
  }
  if (!state.order) {
    return <p className="representative-inspector-note">{t.noRecentOrders}</p>;
  }
  return (
    <div className="representative-profile-recent-order">
      <span>{t.recentOrder}</span>
      <strong>{state.order.productName ?? t.serviceOrder}</strong>
      <p>
        {formatCny(state.order.amountCents, locale)}
        {" · "}
        {t.orderStatuses[state.order.status]}
      </p>
      <small>{formatOrderDate(state.order.createdAt, locale)}</small>
    </div>
  );
}

function InfoIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 8.7v5M10 5.8h.01" />
    </svg>
  );
}

function formatCny(amountCents: number, locale: "zh" | "en") {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
    style: "currency",
    currency: "CNY",
  }).format(amountCents / 100);
}

function formatOrderDate(value: string, locale: "zh" | "en") {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

const zhCopy = {
  profileLabel: "数字代表资料",
  profileEyebrow: "数字代表",
  representing: (owner: string) => `代表 ${owner} 接待`,
  aboutLabel: "简介",
  capabilitiesLabel: "能帮什么",
  aiHumanSupport: "AI 先接待，需要判断时可转真人。",
  aiOnlySupport: "当前由 AI 提供公开接待。",
  channelLabel: "渠道连续性",
  channelDetail: "绑定后，Web 与已开放的私聊渠道会识别为同一个 Delegate 用户；各渠道的原始消息仍分别保存。",
  loadingBindings: "正在读取渠道绑定状态…",
  bindingsUnavailable: "绑定状态暂时无法读取，请稍后刷新。",
  manageBindings: "查看与绑定渠道",
  loginToBind: "登录后绑定渠道",
  bindingHelp: "绑定说明",
  bindingHelpTitle: "渠道绑定会带来什么？",
  bindingManagementTitle: "管理私聊渠道",
  bindingHelpItems: [
    "绑定只用于确认不同渠道属于同一个 Delegate 用户，不会合并或公开各渠道的原始聊天记录。",
    "代表专属服务额度与人工权益可以在已验证渠道间保持一致。",
    "你可以随时解除某个渠道；其他渠道、历史订单和权益不会被删除。",
  ],
  close: "关闭说明",
  resourcesLabel: "常见问题与资料",
  materialLabel: "公开资料",
  deliverableLabel: "可下载文件",
  pendingResource: "暂未提供公开下载",
  servicesLabel: "服务与订单",
  servicesManagementTitle: "购买服务与查看订单",
  recommendedPackage: "推荐服务包",
  credits: (value: number) => `${value} 服务额度`,
  includesHandoff: "包含人工接管权益",
  orderHistoryAvailable: "可以在服务页查看最近订单与已有权益。",
  openServices: "查看服务与订单",
  recentOrder: "最近订单",
  serviceOrder: "服务订单",
  loginForOrders: "登录后可查看最近订单与当前权益。",
  loadingOrders: "正在读取最近订单…",
  ordersUnavailable: "订单状态暂时无法读取，请到服务页重试。",
  noRecentOrders: "暂无订单；购买后可在这里查看状态。",
  orderStatuses: {
    created: "正在创建",
    requires_payment: "待支付",
    paid: "已支付",
    failed: "失败",
    canceled: "已关闭",
    refunded: "已退款",
  },
  privacyLabel: "隐私与边界",
  privacyManagementTitle: "完整隐私与记忆说明",
  memoryLabel: "记忆使用范围",
  fullPrivacy: "查看完整说明",
  loadingShort: "读取中",
  unavailableShort: "暂不可用",
  notCheckedShort: "登录后可查看",
  linkedCount: (count: number) => `已绑定 ${count} 个`,
  notLinkedShort: "尚未绑定",
  linked: "已绑定",
  notLinked: "可绑定",
  channelUnavailable: "未开放",
} as const;

const enCopy = {
  profileLabel: "Digital representative profile",
  profileEyebrow: "Digital representative",
  representing: (owner: string) => `Front desk for ${owner}`,
  aboutLabel: "About",
  capabilitiesLabel: "What I can help with",
  aiHumanSupport: "AI responds first, with human help when judgment is needed.",
  aiOnlySupport: "Public requests are currently handled by AI.",
  channelLabel: "Channel continuity",
  channelDetail: "Once linked, Web and available private channels recognize the same Delegate user while keeping each channel's raw messages separate.",
  loadingBindings: "Loading channel links…",
  bindingsUnavailable: "Channel-link status is temporarily unavailable. Refresh and try again later.",
  manageBindings: "View and link channels",
  loginToBind: "Log in to link channels",
  bindingHelp: "How linking works",
  bindingHelpTitle: "What does channel linking do?",
  bindingManagementTitle: "Manage private channels",
  bindingHelpItems: [
    "Linking only proves that accounts on different channels belong to the same Delegate user. It does not merge or expose raw chat histories.",
    "Representative-scoped service credits and human-help entitlements can stay consistent across verified channels.",
    "You can unlink a channel at any time without deleting other channels, order history, or entitlements.",
  ],
  close: "Close explanation",
  resourcesLabel: "FAQs and resources",
  materialLabel: "Public resource",
  deliverableLabel: "Download",
  pendingResource: "No public download yet",
  servicesLabel: "Services and orders",
  servicesManagementTitle: "Buy services and review orders",
  recommendedPackage: "Recommended service",
  credits: (value: number) => `${value} service credits`,
  includesHandoff: "Includes human-takeover entitlement",
  orderHistoryAvailable: "Review recent orders and active entitlements on the services page.",
  openServices: "View services and orders",
  recentOrder: "Recent order",
  serviceOrder: "Service order",
  loginForOrders: "Log in to view recent orders and current entitlements.",
  loadingOrders: "Loading the latest order…",
  ordersUnavailable: "Order status is temporarily unavailable. Try again on the services page.",
  noRecentOrders: "No orders yet. A purchase will appear here with its status.",
  orderStatuses: {
    created: "Creating",
    requires_payment: "Awaiting payment",
    paid: "Paid",
    failed: "Failed",
    canceled: "Closed",
    refunded: "Refunded",
  },
  privacyLabel: "Privacy and boundaries",
  privacyManagementTitle: "Full privacy and memory explanation",
  memoryLabel: "How memory is used",
  fullPrivacy: "Read the full explanation",
  loadingShort: "Loading",
  unavailableShort: "Unavailable",
  notCheckedShort: "Log in to check",
  linkedCount: (count: number) => `${count} linked`,
  notLinkedShort: "Not linked",
  linked: "Linked",
  notLinked: "Available",
  channelUnavailable: "Not available",
} as const;

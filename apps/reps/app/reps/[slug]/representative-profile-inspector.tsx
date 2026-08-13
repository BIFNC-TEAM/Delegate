"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  REPRESENTATIVE_PROFILE_SECTION_OPEN_EVENT,
  type RepresentativeProfileSection,
} from "./representative-profile-rail-events";
import {
  resolveProfileBindingChannels,
  type ProfileBindingChannelState,
} from "./profile-binding-presentation";

type ProfileResource = {
  id: string;
  title: string;
  kind: "material" | "deliverable";
  href: string | null;
};

type BindingSnapshot = {
  provider: "TELEGRAM" | "MATRIX";
};

type BindingStatePayload = {
  bindings: BindingSnapshot[];
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
      telegram: ProfileBindingChannelState;
      matrix: ProfileBindingChannelState;
    };

export function RepresentativeProfileInspector(props: {
  audienceAuthenticated: boolean;
  bindingManagement?: ReactNode;
  commerceManagement?: ReactNode;
  initialSection?: RepresentativeProfileSection;
  locale: "zh" | "en";
  loginHref: string;
  memoryDisclosure: string;
  ownerName: string;
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
  const [activeModal, setActiveModal] = useState<RepresentativeProfileSection | null>(
    props.initialSection ?? null,
  );
  const [portalReady, setPortalReady] = useState(false);
  const modalTriggerRef = useRef<HTMLElement | null>(null);
  const closeHelpRef = useRef<HTMLButtonElement>(null);
  const modalCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => setPortalReady(true), []);

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
          ...resolveProfileBindingChannels(payload),
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setBindingState({ status: "unavailable" });
      });

    return () => controller.abort();
  }, [props.audienceAuthenticated, props.representativeSlug]);

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
    if (!activeModal || !portalReady) return;
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
  }, [activeModal, portalReady]);

  function openModal(
    modal: RepresentativeProfileSection,
    opener: HTMLElement,
  ) {
    modalTriggerRef.current = opener;
    setActiveModal(modal);
  }

  return (
    <section className="representative-profile-inspector" aria-label={t.profileLabel}>
      <section className="representative-inspector-card representative-inspector-profile-card">
        <header className="representative-inspector-card-heading">
          <strong>{t.representativeInfoLabel}</strong>
        </header>
        <div className="representative-inspector-summary">
          <div aria-hidden="true" className="representative-inspector-avatar">
            {props.representativeName.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <span className="panel-title">{t.profileEyebrow}</span>
            <strong>{props.representativeName}</strong>
            <small>{t.representing(props.ownerName)}</small>
          </div>
        </div>
        <div className="representative-inspector-profile-copy">
          <p>{props.tagline}</p>
        </div>
        {props.resources.length > 0 ? (
          <div className="representative-inspector-resources">
            <strong>{t.publicResourcesLabel}</strong>
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
          </div>
        ) : null}
      </section>

      <section className="representative-inspector-card representative-inspector-details-card">
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
                  aria-haspopup="dialog"
                  className="button-secondary"
                  onClick={(event) => openModal("bindings", event.currentTarget)}
                  type="button"
                >
                  {t.manageBindings}
                </button>
              ) : (
                <a className="button-secondary" href={props.loginHref}>{t.loginToBind}</a>
              )}
            </div>
          </div>
        </details>

        <details className="representative-inspector-section" id="profile-privacy">
          <summary>{t.privacyLabel}</summary>
          <div className="representative-inspector-section-body">
            <ul className="representative-profile-boundaries">
              {props.trustItems.slice(0, 3).map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        </details>
      </section>

      {portalReady && activeModal ? createPortal((
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
            {activeModal === "bindings" ? (
              <>
                <section
                  aria-labelledby="representative-binding-explanation-title"
                  className="representative-binding-modal-explanation"
                >
                  <h3 id="representative-binding-explanation-title">{t.bindingHelpTitle}</h3>
                  {t.bindingHelpItems.map((item) => <p key={item}>{item}</p>)}
                </section>
                <div className="representative-profile-modal-workspace">
                  {props.bindingManagement}
                </div>
              </>
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
      ), document.body) : null}
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
  modal: RepresentativeProfileSection,
  t: typeof zhCopy | typeof enCopy,
) {
  if (modal === "bindings") return t.bindingManagementTitle;
  if (modal === "services") return t.servicesManagementTitle;
  if (modal === "privacy") return t.privacyManagementTitle;
  return t.privacyManagementTitle;
}

function getModalEyebrow(
  modal: RepresentativeProfileSection,
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

const zhCopy = {
  profileLabel: "数字代表资料",
  representativeInfoLabel: "代表信息",
  profileEyebrow: "数字代表",
  representing: (owner: string) => `代表 ${owner} 接待`,
  channelLabel: "渠道连续性",
  channelDetail: "绑定后，Web 与已开放的私聊渠道会识别为同一个 Delegate 用户；各渠道的原始消息仍分别保存。",
  loadingBindings: "正在读取渠道绑定状态…",
  bindingsUnavailable: "绑定状态暂时无法读取，请稍后刷新。",
  manageBindings: "查看与绑定渠道",
  loginToBind: "登录后绑定渠道",
  bindingHelpTitle: "渠道绑定会带来什么？",
  bindingManagementTitle: "管理私聊渠道",
  bindingHelpItems: [
    "绑定只用于确认不同渠道属于同一个 Delegate 用户，不会合并或公开各渠道的原始聊天记录。",
    "代表专属服务额度与人工权益可以在已验证渠道间保持一致。",
    "你可以随时解除某个渠道；其他渠道、历史订单和权益不会被删除。",
  ],
  close: "关闭说明",
  publicResourcesLabel: "公开资料",
  materialLabel: "公开资料",
  deliverableLabel: "可下载文件",
  pendingResource: "暂未提供公开下载",
  servicesLabel: "服务与订单",
  servicesManagementTitle: "购买服务与查看订单",
  privacyLabel: "隐私与边界",
  privacyManagementTitle: "完整隐私与记忆说明",
  memoryLabel: "记忆使用范围",
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
  representativeInfoLabel: "Representative information",
  profileEyebrow: "Digital representative",
  representing: (owner: string) => `Front desk for ${owner}`,
  channelLabel: "Channel continuity",
  channelDetail: "Once linked, Web and available private channels recognize the same Delegate user while keeping each channel's raw messages separate.",
  loadingBindings: "Loading channel links…",
  bindingsUnavailable: "Channel-link status is temporarily unavailable. Refresh and try again later.",
  manageBindings: "View and link channels",
  loginToBind: "Log in to link channels",
  bindingHelpTitle: "What does channel linking do?",
  bindingManagementTitle: "Manage private channels",
  bindingHelpItems: [
    "Linking only proves that accounts on different channels belong to the same Delegate user. It does not merge or expose raw chat histories.",
    "Representative-scoped service credits and human-help entitlements can stay consistent across verified channels.",
    "You can unlink a channel at any time without deleting other channels, order history, or entitlements.",
  ],
  close: "Close explanation",
  publicResourcesLabel: "Public resources",
  materialLabel: "Public resource",
  deliverableLabel: "Download",
  pendingResource: "No public download yet",
  servicesLabel: "Services and orders",
  servicesManagementTitle: "Buy services and review orders",
  privacyLabel: "Privacy and boundaries",
  privacyManagementTitle: "Full privacy and memory explanation",
  memoryLabel: "How memory is used",
  loadingShort: "Loading",
  unavailableShort: "Unavailable",
  notCheckedShort: "Log in to check",
  linkedCount: (count: number) => `${count} linked`,
  notLinkedShort: "Not linked",
  linked: "Linked",
  notLinked: "Available",
  channelUnavailable: "Not available",
} as const;

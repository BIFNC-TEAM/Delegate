"use client";

import { useEffect, useRef, useState } from "react";

import type { PublicWebAnswerSourceDisclosure } from "@delegate/web-data";

import {
  removeRejectedPublicChatOptimisticMessage,
  resolvePublicChatServiceCreditPendingTransition,
  resolvePublicChatServiceCreditNextStep,
  resolvePublicChatSubmissionRejection,
  restoreRejectedPublicChatDraft,
  type PublicChatResponse,
} from "./public-chat";
import {
  PUBLIC_WALLET_UPDATED_EVENT,
  type PublicHandoffEntitlementSummary,
  type PublicWalletUpdatedDetail,
  type PublicWalletStateSnapshot,
} from "./public-wallet-client";
import type { GovernedMemoryDisclosure } from "./governed-context-disclosure";
import {
  collectPendingMemoryDisplayAcks,
  memoryDisplayAckKey,
  sendPublicMemoryDisplayAck,
  type PublicMemoryDisplayAck,
} from "./memory-display-client";

type Citation = { title: string; excerpt?: string; uri?: string };
type ChatAttachment = { id: string; fileName: string; mimeType?: string; sizeBytes?: number; url?: string };
type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  status?: string;
  citations?: Citation[];
  attachments?: ChatAttachment[];
  senderType?: string;
  senderDisplayName?: string;
  displayAck?: PublicMemoryDisplayAck;
  sourceDisclosure?: PublicWebAnswerSourceDisclosure;
};
type RepresentativeAccessMode =
  | "FREE"
  | "TRIAL_THEN_CREDITS"
  | "CREDITS_ONLY";
type RepresentativeHandoffAccessMode = "FREE" | "PACKAGE_REQUIRED";
type PublicChatUsage = PublicChatResponse["usage"] & {
  accessMode: RepresentativeAccessMode;
  unlimitedFreeAccess: boolean;
};
type PublicChatHistory = {
  state: string;
  humanActive: boolean;
  messages: Array<ChatMessage & { senderType: string; createdAt: string }>;
  usage: PublicChatUsage;
};
type PublicChatAccepted = {
  status: "queued" | "waiting_human" | "completed";
  runId?: string;
  heldForOperator?: boolean;
  reply?: PublicChatResponse["reply"];
  tier: PublicChatResponse["tier"];
  usage: PublicChatUsage;
  error?: string;
  code?: string;
  governedMemoryDisclosure?: GovernedMemoryDisclosure;
};

const RUN_SUBSCRIPTION_DEADLINE_MS = 150_000;

export function RepresentativeChatPanel(props: {
  representativeSlug: string;
  representativeName: string;
  ownerName: string;
  humanInLoop: boolean;
  accessMode: RepresentativeAccessMode;
  handoffAccessMode: RepresentativeHandoffAccessMode;
  hasHandoffPackages: boolean;
  hasServicePackages: boolean;
  hasTips: boolean;
  locale: "zh" | "en";
  freeReplyLimit: number;
  computeEnabled: boolean;
  governedMemoryDisclosure: GovernedMemoryDisclosure;
  serviceCreditPurchaseEnabled: boolean;
}) {
  const t = props.locale === "zh" ? zhCopy : enCopy;
  const [governedMemoryDisclosure, setGovernedMemoryDisclosure] = useState(
    props.governedMemoryDisclosure,
  );
  const governedContextEnabled = governedMemoryDisclosure.enabled;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const keepChatPinnedRef = useRef(true);
  const activeRunSourceRef = useRef<EventSource | null>(null);
  const activeRunTimeoutRef = useRef<number | null>(null);
  const acknowledgedDisplayKeysRef = useRef(new Set<string>());
  const displayAckRetryTimersRef = useRef(new Set<number>());
  const displayAckMountedRef = useRef(false);
  const previousReservedCreditsRef = useRef(0);
  const [showServices, setShowServices] = useState(
    props.accessMode === "CREDITS_ONLY",
  );
  const [handoffEntitlement, setHandoffEntitlement] =
    useState<PublicHandoffEntitlementSummary>({
      hasUnlimited: false,
      limitedRemainingUses: 0,
      highestServiceLevel: null,
      nextExpiryAt: null,
    });
  const [handoffEntitlementStatus, setHandoffEntitlementStatus] = useState<
    "loading" | "ready" | "unavailable"
  >(
    props.humanInLoop && props.handoffAccessMode === "PACKAGE_REQUIRED"
      ? "loading"
      : "ready",
  );
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: t.welcome(props.representativeName, governedContextEnabled),
    },
  ]);
  const [usage, setUsage] = useState<PublicChatUsage>({
    freeRepliesUsed: 0,
    freeRepliesRemaining: props.freeReplyLimit,
    serviceCreditsAvailable: 0,
    serviceCreditsReserved: 0,
    passUnlocked: false,
    deepHelpUnlocked: false,
    accessMode: props.accessMode,
    unlimitedFreeAccess: props.accessMode === "FREE",
  });
  const [humanActive, setHumanActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hydrating, setHydrating] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const computeAssist = getComputeAssist(input, props.locale, props.computeEnabled);

  useEffect(() => {
    let cancelled = false;
    fetch(`/reps/${props.representativeSlug}/chat`)
      .then(async (response) => {
        const payload = (await response.json()) as PublicChatHistory & { error?: string };
        if (!response.ok) throw new Error(payload.error || t.errorGeneric);
        if (cancelled) return;
        if (payload.messages.length) {
          setMessages(payload.messages.map((message) => ({
            id: message.id,
            role: message.role,
            text: message.text,
            senderType: message.senderType,
            ...(message.senderDisplayName ? { senderDisplayName: message.senderDisplayName } : {}),
            ...(message.status ? { status: message.status } : {}),
            ...(message.citations?.length ? { citations: message.citations } : {}),
            ...(message.attachments?.length ? { attachments: message.attachments } : {}),
            ...(message.displayAck ? { displayAck: message.displayAck } : {}),
            ...(message.sourceDisclosure ? { sourceDisclosure: message.sourceDisclosure } : {}),
          })));
        }
        setHumanActive(payload.humanActive);
        setUsage(payload.usage);
      })
      .catch((historyError) => {
        if (!cancelled) setError(historyError instanceof Error ? historyError.message : t.errorGeneric);
      })
      .finally(() => {
        if (!cancelled) setHydrating(false);
      });
    return () => { cancelled = true; };
  }, [props.representativeSlug, t.errorGeneric]);

  useEffect(() => {
    if (hydrating) return;
    const source = new EventSource(`/reps/${props.representativeSlug}/chat/events`);
    source.addEventListener("conversation", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as PublicChatHistory;
        if (payload.messages.length) {
          setMessages(payload.messages.map((message) => ({
            id: message.id,
            role: message.role,
            text: message.text,
            senderType: message.senderType,
            ...(message.senderDisplayName ? { senderDisplayName: message.senderDisplayName } : {}),
            ...(message.status ? { status: message.status } : {}),
            ...(message.citations?.length ? { citations: message.citations } : {}),
            ...(message.attachments?.length ? { attachments: message.attachments } : {}),
            ...(message.displayAck ? { displayAck: message.displayAck } : {}),
            ...(message.sourceDisclosure ? { sourceDisclosure: message.sourceDisclosure } : {}),
          })));
        }
        setHumanActive(payload.humanActive);
        setUsage(payload.usage);
      } catch {
        // Keep the active stream alive if one event is malformed.
      }
    });
    return () => source.close();
  }, [hydrating, props.representativeSlug]);

  useEffect(() => {
    displayAckMountedRef.current = true;
    return () => {
      displayAckMountedRef.current = false;
      activeRunSourceRef.current?.close();
      if (activeRunTimeoutRef.current !== null) {
        window.clearTimeout(activeRunTimeoutRef.current);
      }
      for (const timer of displayAckRetryTimersRef.current) {
        window.clearTimeout(timer);
      }
      displayAckRetryTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (
      usage.accessMode === "CREDITS_ONLY"
      || (
        usage.accessMode === "TRIAL_THEN_CREDITS"
        && usage.freeRepliesRemaining === 0
      )
    ) {
      setShowServices(true);
    }
  }, [usage.accessMode, usage.freeRepliesRemaining]);

  useEffect(() => {
    if (
      !props.humanInLoop
      || props.handoffAccessMode !== "PACKAGE_REQUIRED"
    ) {
      setHandoffEntitlementStatus("ready");
      return;
    }
    const controller = new AbortController();
    setHandoffEntitlementStatus("loading");
    void fetch(`/reps/${props.representativeSlug}/recharge?currency=CNY`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("handoff entitlement unavailable");
        return (await response.json()) as PublicWalletStateSnapshot;
      })
      .then((snapshot) => {
        if (controller.signal.aborted) return;
        setHandoffEntitlement(snapshot.handoffEntitlement);
        setHandoffEntitlementStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          // Do not turn a failed read into a false "no entitlement" state.
          // The submission route remains authoritative while the CTA stays
          // unavailable, preventing an accidental duplicate purchase.
          setHandoffEntitlementStatus("unavailable");
        }
      });
    return () => controller.abort();
  }, [
    props.handoffAccessMode,
    props.humanInLoop,
    props.representativeSlug,
  ]);

  useEffect(() => {
    const transition = resolvePublicChatServiceCreditPendingTransition({
      previousReserved: previousReservedCreditsRef.current,
      serviceCreditsAvailable: usage.serviceCreditsAvailable,
      serviceCreditsReserved: usage.serviceCreditsReserved,
    });
    previousReservedCreditsRef.current = usage.serviceCreditsReserved;
    if (!transition) return;

    setShowServices(transition === "released");
    setError((currentError) => {
      if (currentError !== t.serviceCreditPending) return currentError;
      if (transition === "available") return null;
      const nextStep = resolvePublicChatServiceCreditNextStep({
        serviceCreditsAvailable: usage.serviceCreditsAvailable,
        serviceCreditsReserved: usage.serviceCreditsReserved,
        purchaseEnabled: props.serviceCreditPurchaseEnabled,
        humanInLoop: props.humanInLoop,
      });
      return nextStep === "purchase"
        ? t.serviceCreditRequired
        : nextStep === "handoff"
          ? t.serviceCreditUnavailableWithHandoff
          : t.serviceCreditUnavailable;
    });
  }, [
    props.humanInLoop,
    props.serviceCreditPurchaseEnabled,
    t.serviceCreditPending,
    t.serviceCreditRequired,
    t.serviceCreditUnavailable,
    t.serviceCreditUnavailableWithHandoff,
    usage.serviceCreditsAvailable,
    usage.serviceCreditsReserved,
  ]);

  useEffect(() => {
    const handleWalletUpdate = (event: Event) => {
      const detail = (event as CustomEvent<PublicWalletUpdatedDetail>).detail;
      if (!detail || detail.representativeSlug !== props.representativeSlug) {
        return;
      }
      setUsage((current) => ({
        ...current,
        serviceCreditsAvailable: detail.serviceCreditsAvailable,
        serviceCreditsReserved: detail.serviceCreditsReserved,
        passUnlocked:
          detail.serviceCreditsAvailable > 0
          || detail.serviceCreditsReserved > 0,
      }));
      if (detail.handoffEntitlement) {
        setHandoffEntitlement(detail.handoffEntitlement);
        setHandoffEntitlementStatus("ready");
      }
      if (detail.serviceCreditsAvailable > 0) {
        setShowServices(false);
        setError(null);
      } else if (detail.serviceCreditsReserved > 0) {
        setShowServices(true);
        setError(t.serviceCreditPending);
      }
    };
    window.addEventListener(PUBLIC_WALLET_UPDATED_EVENT, handleWalletUpdate);
    return () => {
      window.removeEventListener(PUBLIC_WALLET_UPDATED_EVENT, handleWalletUpdate);
    };
  }, [props.representativeSlug, t.serviceCreditPending]);

  useEffect(() => {
    if (!keepChatPinnedRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const chatLog = chatLogRef.current;
      if (chatLog) chatLog.scrollTop = chatLog.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages]);

  useEffect(() => {
    const pending = collectPendingMemoryDisplayAcks(
      messages,
      acknowledgedDisplayKeysRef.current,
    );
    for (const ack of pending) {
      const key = memoryDisplayAckKey(ack);
      // This effect runs only after React has committed the message and its
      // citations to the visible chat log. Mark the key before issuing the
      // request so Strict Mode and concurrent history updates remain quiet.
      acknowledgedDisplayKeysRef.current.add(key);
      sendDisplayAckWithRetry(ack, key, 0);
    }

    function sendDisplayAckWithRetry(
      ack: PublicMemoryDisplayAck,
      key: string,
      attempt: number,
    ) {
      void sendPublicMemoryDisplayAck(props.representativeSlug, ack).catch(() => {
        if (!displayAckMountedRef.current) return;
        if (attempt >= 2) {
          // Undercount rather than overcount when the acknowledgement cannot
          // be confirmed. A later history render or page reload can retry.
          acknowledgedDisplayKeysRef.current.delete(key);
          return;
        }
        const timer = window.setTimeout(() => {
          displayAckRetryTimersRef.current.delete(timer);
          sendDisplayAckWithRetry(ack, key, attempt + 1);
        }, 500 * (2 ** attempt));
        displayAckRetryTimersRef.current.add(timer);
      });
    }
  }, [messages, props.representativeSlug]);

  function chooseStarter(starter: string) {
    setInput(starter);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    keepChatPinnedRef.current = true;
    const userMessage = { id: createClientMessageId(), role: "user" as const, text, status: "accepted" };
    setMessages((current) => [...current, userMessage]);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/reps/${props.representativeSlug}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          clientMessageId: userMessage.id,
          memoryDisclosure: {
            policyRevision: governedMemoryDisclosure.policyRevision,
            fingerprint: governedMemoryDisclosure.fingerprint,
          },
        }),
      });
      const payload = (await response.json()) as PublicChatAccepted;
      if (!response.ok) {
        const rejection = resolvePublicChatSubmissionRejection({
          status: response.status,
          code: payload.code,
        });
        if (
          rejection === "memory_disclosure_stale"
          && payload.governedMemoryDisclosure
        ) {
          setGovernedMemoryDisclosure(payload.governedMemoryDisclosure);
          setMessages((current) => removeRejectedPublicChatOptimisticMessage(
            current,
            userMessage.id,
          ));
          setInput((currentDraft) => restoreRejectedPublicChatDraft({
            currentDraft,
            submittedText: text,
          }));
          setError(t.memoryPolicyChanged);
          setBusy(false);
          requestAnimationFrame(() => inputRef.current?.focus());
          return;
        }
        if (rejection === "service_credit_required" && payload.usage) {
          setUsage(payload.usage);
          const nextStep = resolvePublicChatServiceCreditNextStep({
            serviceCreditsAvailable: payload.usage.serviceCreditsAvailable,
            serviceCreditsReserved: payload.usage.serviceCreditsReserved,
            purchaseEnabled: props.serviceCreditPurchaseEnabled,
            humanInLoop: props.humanInLoop,
          });
          setShowServices(true);
          setMessages((current) => removeRejectedPublicChatOptimisticMessage(
            current,
            userMessage.id,
          ));
          setInput((currentDraft) => restoreRejectedPublicChatDraft({
            currentDraft,
            submittedText: text,
          }));
          setError(
            nextStep === "pending"
              ? t.serviceCreditPending
              : nextStep === "purchase"
                ? t.serviceCreditRequired
                : nextStep === "handoff"
                  ? t.serviceCreditUnavailableWithHandoff
                  : t.serviceCreditUnavailable,
          );
          setBusy(false);
          requestAnimationFrame(() => inputRef.current?.focus());
          return;
        }
        throw new Error(payload.error || t.errorGeneric);
      }
      setUsage(payload.usage);
      if (payload.reply) {
        appendAssistant({
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: payload.reply.text,
          status: "completed",
          ...(payload.reply.sourceDisclosure
            ? { sourceDisclosure: payload.reply.sourceDisclosure }
            : {}),
        });
        setBusy(false);
      } else if (payload.heldForOperator || payload.status === "waiting_human") {
        setHumanActive(true);
        appendAssistant({ id: `handoff-${Date.now()}`, role: "assistant", text: t.humanQueueNotice, status: "waiting_human" });
        setBusy(false);
      } else if (payload.runId) {
        subscribeToRun(payload.runId);
      } else {
        throw new Error(t.errorGeneric);
      }
    } catch (submitError) {
      setMessages((current) => current.map((message) =>
        message.id === userMessage.id
          ? { ...message, status: "failed" }
          : message));
      setError(submitError instanceof Error ? submitError.message : t.errorGeneric);
      setBusy(false);
    }
  }

  function subscribeToRun(runId: string) {
    activeRunSourceRef.current?.close();
    if (activeRunTimeoutRef.current !== null) {
      window.clearTimeout(activeRunTimeoutRef.current);
    }

    const source = new EventSource(`/reps/${props.representativeSlug}/chat/runs/${encodeURIComponent(runId)}/events`);
    activeRunSourceRef.current = source;
    let settled = false;
    const finish = () => {
      settled = true;
      source.close();
      if (activeRunTimeoutRef.current !== null) {
        window.clearTimeout(activeRunTimeoutRef.current);
        activeRunTimeoutRef.current = null;
      }
      if (activeRunSourceRef.current === source) activeRunSourceRef.current = null;
      setBusy(false);
    };

    activeRunTimeoutRef.current = window.setTimeout(() => {
      if (settled) return;
      finish();
      setError(t.replyTimeout);
    }, RUN_SUBSCRIPTION_DEADLINE_MS);

    source.addEventListener("run", (event) => {
      try {
        const snapshot = JSON.parse((event as MessageEvent<string>).data) as {
          status: string;
          errorMessage?: string;
          message?: {
            id: string;
            text: string;
            status: string;
            citations: Citation[];
            attachments?: ChatAttachment[];
            displayAck?: PublicMemoryDisplayAck;
            sourceDisclosure?: PublicWebAnswerSourceDisclosure;
          };
        };
        if (["completed", "waiting_approval"].includes(snapshot.status) && snapshot.message) {
          appendAssistant({
            id: snapshot.message.id,
            role: "assistant",
            text: snapshot.message.text,
            status: snapshot.message.status,
            citations: snapshot.message.citations,
            ...(snapshot.message.attachments?.length ? { attachments: snapshot.message.attachments } : {}),
            ...(snapshot.message.displayAck ? { displayAck: snapshot.message.displayAck } : {}),
            ...(snapshot.message.sourceDisclosure
              ? { sourceDisclosure: snapshot.message.sourceDisclosure }
              : {}),
          });
          finish();
        } else if (["failed", "canceled"].includes(snapshot.status)) {
          setError(snapshot.errorMessage || t.errorGeneric);
          finish();
        }
      } catch {
        // A malformed event is transient; EventSource can continue receiving
        // the authoritative terminal snapshot from the same run.
      }
    });
    source.addEventListener("error", () => {
      // EventSource reconnects automatically. Do not turn a short network
      // interruption or a server-side stream rotation into a failed reply.
      // The deadline above remains the final user-facing failure boundary.
    });
  }

  function appendAssistant(message: ChatMessage) {
    setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
  }

  const accessMode = usage.accessMode ?? props.accessMode;
  const hasPaidHandoff =
    handoffEntitlement.hasUnlimited
    || handoffEntitlement.limitedRemainingUses > 0;
  const handoffDetail = !props.humanInLoop
    ? t.handoffUnavailableDetail
    : props.handoffAccessMode === "FREE"
      ? t.handoffFreeDetail
      : handoffEntitlementStatus === "loading"
        ? t.handoffEntitlementLoading
        : handoffEntitlementStatus === "unavailable"
          ? t.handoffEntitlementUnavailable
          : hasPaidHandoff
            ? t.handoffEntitlementDetail(
                handoffEntitlement.hasUnlimited,
                handoffEntitlement.limitedRemainingUses,
                handoffEntitlement.highestServiceLevel === "PRIORITY",
                handoffEntitlement.nextExpiryAt,
              )
            : props.hasHandoffPackages
              ? t.handoffPackageRequiredDetail
              : t.handoffPackageUnavailableDetail;
  const serviceAttentionRequired =
    accessMode === "CREDITS_ONLY"
    || (
      accessMode === "TRIAL_THEN_CREDITS"
      && usage.freeRepliesRemaining === 0
    );
  const serviceContentVisible = serviceAttentionRequired || showServices;
  const supportsPaidContinuation = accessMode !== "FREE" && (
    accessMode === "CREDITS_ONLY"
    || props.hasServicePackages
    || usage.serviceCreditsAvailable > 0
  );
  const continuationBlocked =
    supportsPaidContinuation
    && serviceContentVisible
    && usage.serviceCreditsAvailable === 0;
  const serviceCreditsPending =
    continuationBlocked && usage.serviceCreditsReserved > 0;
  const servicePurchaseRequired =
    continuationBlocked && usage.serviceCreditsReserved === 0;
  const lastFreeReply =
    accessMode === "TRIAL_THEN_CREDITS"
    && usage.freeRepliesRemaining === 1
    && usage.serviceCreditsAvailable === 0
    && props.serviceCreditPurchaseEnabled;
  const serviceGateCoversError = Boolean(
    serviceAttentionRequired
    && error
    && [
      t.serviceCreditRequired,
      t.serviceCreditUnavailable,
      t.serviceCreditUnavailableWithHandoff,
    ].includes(error),
  );

  return (
    <section className="representative-conversation-shell" id="chat">
      <header className="representative-conversation-heading">
        <div>
          <p className="eyebrow">{t.eyebrow}</p>
          <h2>{t.title(props.representativeName)}</h2>
          <p>{t.summary(governedContextEnabled)}</p>
        </div>
        <span className={humanActive ? "representative-responder-pill is-human" : "representative-responder-pill"}>
          <i aria-hidden="true" />{humanActive ? t.humanStatus : t.aiStatus}
        </span>
      </header>

      <div className="representative-chat-first-grid">
        <div className={messages.length <= 1 ? "representative-chat-surface is-empty" : "representative-chat-surface"}>
          <div
            ref={chatLogRef}
            className="representative-chat-log"
            aria-live="polite"
            onScroll={(event) => {
              const chatLog = event.currentTarget;
              keepChatPinnedRef.current =
                chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight <= 80;
            }}
          >
            {messages.map((message) => {
              const visibleStatus = getVisitorMessageStatus(message.status, props.locale);
              const isOperator = message.senderType === "operator";
              return (
                <article className={`representative-chat-message representative-chat-message-${message.role}${isOperator ? " is-operator" : ""}`} key={message.id}>
                  <span className="panel-title">{
                    message.role === "user"
                      ? t.youLabel
                      : isOperator
                        ? `${message.senderDisplayName || props.ownerName} · ${t.humanLabel}`
                        : `${props.representativeName} · ${t.aiLabel}`
                  }</span>
                  <p>{message.text}</p>
                  {message.role === "assistant"
                    && message.sourceDisclosure === "general_model"
                    && !isOperator ? (
                    <small className="representative-answer-source-disclosure">
                      {t.generalModelSourceDisclosure}
                    </small>
                  ) : null}
                  {visibleStatus ? <span className="representative-message-status">{visibleStatus}</span> : null}
                  {message.citations?.length ? (
                    <div className="representative-chat-citations">
                      <strong>{t.citationsLabel}</strong>
                      {message.citations.map((citation) => (
                        <details key={`${message.id}:${citation.title}`}>
                          <summary>{citation.title}</summary>
                          {citation.excerpt ? <small>{citation.excerpt}</small> : null}
                          {citation.uri ? <a href={citation.uri} rel="noreferrer" target="_blank">{t.openSource}</a> : null}
                        </details>
                      ))}
                    </div>
                  ) : null}
                  {message.attachments?.length ? (
                    <div className="representative-chat-artifacts">
                      <strong>{t.artifactsLabel}</strong>
                      {message.attachments.map((attachment) => (
                        <div className="representative-chat-artifact" key={attachment.id}>
                          {attachment.mimeType?.startsWith("image/") && attachment.url ? (
                            <img alt={attachment.fileName} src={`${attachment.url}?inline=1`} />
                          ) : null}
                          <div>
                            <span>{attachment.fileName}</span>
                            <small>{[attachment.mimeType, formatAttachmentBytes(attachment.sizeBytes)].filter(Boolean).join(" · ")}</small>
                          </div>
                          {attachment.url ? <a href={attachment.url}>{t.downloadArtifact}</a> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })}
            {busy ? <article className="representative-chat-message representative-chat-message-assistant is-pending"><span className="panel-title">{props.representativeName} · {t.aiLabel}</span><p>{t.thinking(governedContextEnabled)}</p></article> : null}
          </div>

          {messages.length <= 1 ? (
            <div className="representative-chat-starters" aria-label={t.startersLabel}>
              <span>{t.startersLabel}</span>
              <div>{t.starters.map((starter) => <button key={starter} onClick={() => chooseStarter(starter)} type="button">{starter}</button>)}</div>
            </div>
          ) : null}

          <form className="representative-chat-form" onSubmit={handleSubmit}>
            <label className="panel-title" htmlFor="representative-chat-input">{t.inputLabel}</label>
            <textarea aria-describedby={computeAssist ? "representative-compute-assist" : undefined} className="dashboard-textarea representative-chat-textarea" id="representative-chat-input" onChange={(event) => setInput(event.target.value)} placeholder={t.placeholder} ref={inputRef} rows={3} value={input} />
            {computeAssist ? (
              <div className="representative-compute-assist" id="representative-compute-assist" role="status">
                <div><strong>{computeAssist.title}</strong><span>{computeAssist.detail}</span></div>
                {computeAssist.examples.length ? (
                  <div>{computeAssist.examples.map((example) => <button key={example.value} onClick={() => chooseStarter(example.value)} type="button"><b>{example.label}</b><span>{example.value}</span></button>)}</div>
                ) : null}
              </div>
            ) : null}
            {serviceCreditsPending ? (
              <div className="representative-chat-continuation is-pending" role="status">
                <div>
                  <span className="panel-title">{t.continuationEyebrow}</span>
                  <strong>{t.servicePendingTitle}</strong>
                  <p>{t.servicePendingDetail}</p>
                </div>
              </div>
            ) : servicePurchaseRequired ? (
              <div className="representative-chat-continuation" role="status">
                <div>
                  <span className="panel-title">{t.continuationEyebrow}</span>
                  <strong>{t.serviceGateTitle(accessMode)}</strong>
                  <p>
                    {props.serviceCreditPurchaseEnabled
                      ? t.serviceGateDetail
                      : props.humanInLoop
                        ? t.serviceGateHandoffDetail
                        : t.commerceUnavailableDetail(false)}
                  </p>
                </div>
                {props.serviceCreditPurchaseEnabled ? (
                  <a className="button-primary" href="#recharge">{t.openRecharge}</a>
                ) : props.humanInLoop ? (
                  <a className="button-secondary" href="#handoff">{t.handoffAction}</a>
                ) : null}
              </div>
            ) : lastFreeReply ? (
              <div className="representative-chat-usage-note" role="status">
                <span>{t.lastFreeReplyDetail}</span>
                <a href="#recharge">{t.previewServices}</a>
              </div>
            ) : null}
            <div className="representative-chat-trust-note">
              <span>{t.composerTrustNote(governedContextEnabled)}</span>
              <a href="#trust">{t.privacyAction}</a>
            </div>
            <div className="dashboard-form-footer"><p className="footer-note">{t.footnote}</p><div className="button-row"><button className="button-primary" disabled={busy || hydrating || !input.trim()} type="submit">{hydrating ? t.loadingHistory : busy ? t.sending : t.send}</button></div></div>
          </form>
          {error && !serviceGateCoversError ? <p className="feedback-error" role="alert">{error}</p> : null}
        </div>

        <aside className="representative-session-sidebar" aria-label={t.sessionLabel}>
          <section className="representative-session-panel">
            <header>
              <span className="panel-title">{t.sessionLabel}</span>
            </header>
            <div className="representative-session-row">
              <span>{t.accessModeLabel}</span>
              <strong>
                {accessMode === "FREE"
                  ? t.unlimitedFreeAccess
                  : accessMode === "CREDITS_ONLY"
                    ? t.creditsOnlyAccess
                    : t.trialAccess(
                        usage.freeRepliesRemaining,
                        props.freeReplyLimit,
                      )}
              </strong>
            </div>
            <div className="representative-session-row"><span>{t.serviceCreditsLabel}</span><strong>{usage.serviceCreditsAvailable}</strong></div>
            <p className="representative-session-summary">
              {humanActive ? t.humanActiveDetail : t.aiActiveDetail}
            </p>
            <div className={`representative-session-handoff${props.humanInLoop ? "" : " is-unavailable"}`}>
              <span className="panel-title">{t.handoffLabel}</span>
              <strong>
                {props.humanInLoop
                  ? t.handoffTitle(props.ownerName)
                  : t.handoffUnavailableTitle}
              </strong>
              <p>{handoffDetail}</p>
            </div>
            <footer>
              {props.humanInLoop && (
                props.handoffAccessMode === "FREE"
                || (
                  handoffEntitlementStatus === "ready"
                  && (hasPaidHandoff || props.hasHandoffPackages)
                )
              ) ? (
                <a href={props.handoffAccessMode === "PACKAGE_REQUIRED" && !hasPaidHandoff
                  ? "#recharge"
                  : "#handoff"}
                >
                  {props.handoffAccessMode === "PACKAGE_REQUIRED" && !hasPaidHandoff
                    ? t.handoffPackageAction
                    : t.handoffAction}
                </a>
              ) : null}
              {accessMode === "FREE" && props.hasTips ? (
                <a href="#recharge">{t.optionalSupportAction}</a>
              ) : null}
              <a href="#trust">{t.privacyAction}</a>
            </footer>
          </section>
        </aside>
      </div>
    </section>
  );
}

function getVisitorMessageStatus(status: string | undefined, locale: "zh" | "en") {
  if (!status || ["sent", "completed"].includes(status)) return null;
  const labels = locale === "zh"
    ? { accepted: "已发送", queued: "等待发送", waiting_human: "等待真人", failed: "发送失败" }
    : { accepted: "Sent", queued: "Queued", waiting_human: "Waiting for a human", failed: "Failed" };
  return labels[status as keyof typeof labels] ?? null;
}

function createClientMessageId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatAttachmentBytes(value: number | undefined) {
  if (typeof value !== "number") return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatHandoffExpiryDate(
  value: string | null,
  locale: "zh" | "en",
) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function getComputeAssist(value: string, locale: "zh" | "en", enabled: boolean) {
  const normalized = value.trim();
  if (!/^\/compute(?:\s|$)/i.test(normalized)) return null;
  const zh = locale === "zh";
  if (!enabled) {
    return {
      title: zh ? "此代表未启用隔离计算" : "Isolated compute is not enabled",
      detail: zh ? "你仍可继续普通对话，或联系代表所有者启用该能力。" : "Continue chatting normally or ask the representative owner to enable it.",
      examples: [],
    };
  }
  const examples = [
    { label: zh ? "查看目录" : "List files", value: "/compute ls" },
    { label: zh ? "读取文件" : "Read file", value: "/compute read notes/example.txt" },
    { label: zh ? "生成文件" : "Create file", value: "/compute write notes/example.txt ::: 示例内容" },
    { label: zh ? "浏览网页" : "Browse URL", value: "/compute browser https://example.com" },
  ];
  const exact = /^\/compute$/i.test(normalized);
  return {
    title: zh ? "隔离计算" : "Isolated compute",
    detail: exact
      ? (zh ? "直接选择示例，或继续输入。需要修改文件、访问网页或执行复杂命令时可能进入审批。" : "Choose an example or keep typing. File changes, web access, and complex commands may require approval.")
      : (zh ? "命令会先经过权限、费用和安全策略检查。" : "The request will be checked against permission, cost, and safety policies first."),
    examples: exact ? examples : [],
  };
}

const zhCopy = {
  eyebrow: "与数字代表对话",
  title: (name: string) => `向 ${name} 提问`,
  summary: (governedContextEnabled: boolean) =>
    governedContextEnabled
      ? "直接描述你的问题；回答以已发布资料为基础，也可能使用仅限你与当前代表的受治理历史摘要。"
      : "直接描述你的问题；回答以已发布资料为基础，并在使用公开来源时标明依据。",
  aiStatus: "AI 正在接待", humanStatus: "真人正在接待",
  aiLabel: "AI", humanLabel: "真人", youLabel: "你", citationsLabel: "回答依据", openSource: "打开公开来源",
  generalModelSourceDisclosure: "来源说明：本回答未引用已授权知识或记忆，内容由通用模型生成。",
  artifactsLabel: "任务结果", downloadArtifact: "下载",
  startersLabel: "你可以这样开始",
  starters: ["我想了解你们提供什么服务", "我有一个合作需求", "帮我整理报价所需信息", "我希望联系本人"],
  inputLabel: "想解决什么？", placeholder: "描述你的问题、背景和期望结果…", footnote: "请勿发送密码、密钥或不应公开的敏感信息。",
  continuationEyebrow: "继续对话",
  serviceGateTitle: (accessMode: RepresentativeAccessMode) => accessMode === "CREDITS_ONLY"
    ? "使用服务额度后继续"
    : "免费试用已结束",
  serviceGateDetail: "你的问题已保留在输入框中。购买服务包后，可以直接继续这段对话。",
  serviceGateHandoffDetail: "你的问题已保留在输入框中；当前没有可购买的服务包，可以改为申请真人协助。",
  servicePendingTitle: "服务额度正在到账",
  servicePendingDetail: "无需重复购买。额度确认后即可继续发送，输入内容会一直保留。",
  lastFreeReplyDetail: "还剩 1 次免费回复。你可以继续提问，也可以提前了解后续服务方案。",
  previewServices: "查看服务方案",
  composerTrustNote: (enabled: boolean) => enabled
    ? "可使用公开资料与仅限你和当前代表的受保护历史摘要。"
    : "回答使用公开资料；重要承诺仍需真人确认。",
  sending: "正在处理…", send: "发送", thinking: (governedContextEnabled: boolean) => governedContextEnabled ? "正在结合已发布知识与允许使用的上下文整理回复…" : "正在结合已发布知识整理回复…", loadingHistory: "恢复会话中…", errorGeneric: "聊天请求失败，请稍后再试。", memoryPolicyChanged: "记忆策略刚刚更新。请阅读新的记忆说明后重新发送；上一条内容尚未提交。", serviceCreditPending: "服务额度正在处理中，请稍后重试；你的问题已保留在输入框中。", serviceCreditRequired: "免费回复已用完。请购买当前数字代表的服务额度后再发送；你的问题已保留在输入框中。", serviceCreditUnavailableWithHandoff: "免费回复已用完，当前数字代表暂无可购买的服务方案；可申请真人协助。你的问题已保留在输入框中。", serviceCreditUnavailable: "免费回复已用完，当前数字代表暂无可购买的服务方案。你的问题已保留在输入框中。", replyTimeout: "回复处理超时，请重新发送；已发送的内容仍保留在本次会话中。",
  humanQueueNotice: "已进入人工处理队列。你可以继续补充信息，负责人员会看到完整上下文。",
  sessionLabel: "本次会话",
  currentResponder: "当前接待", accessModeLabel: "访问方式", serviceCreditsLabel: "服务额度",
  unlimitedFreeAccess: "永久免费",
  creditsOnlyAccess: "使用服务额度",
  trialAccess: (remaining: number, limit: number) => `免费剩余 ${remaining}/${limit}`,
  aiActiveDetail: "你正在与数字代表对话；需要真人判断时会明确提示。",
  humanActiveDetail: "真人已经接手，你仍可以继续补充背景和要求。",
  handoffLabel: "人工接管", handoffTitle: (ownerName: string) => `申请 ${ownerName} 查看`, handoffAction: "了解转接方式",
  handoffUnavailableTitle: "当前不可用",
  handoffUnavailableDetail: "这位数字代表当前未启用人工接管，会继续由 AI 接待。",
  handoffFreeDetail: "可直接在对话中提出人工请求；目标和关键背景会随会话一起提交。",
  handoffEntitlementLoading: "正在确认当前账户的人工接管权益…",
  handoffEntitlementUnavailable: "人工接管权益暂时无法确认。为避免重复购买，请稍后刷新后再试。",
  handoffPackageRequiredDetail: "当前没有可用的人工接管权益。购买含人工权益的服务套餐后，可在有效期内申请。",
  handoffPackageUnavailableDetail: "当前没有可用的人工接管权益，也没有上架包含人工接管的服务套餐。",
  handoffEntitlementDetail: (unlimited: boolean, remaining: number, priority: boolean, expiresAt: string | null) => {
    const expiry = formatHandoffExpiryDate(expiresAt, "zh");
    return `${unlimited ? "不限次数" : `剩余 ${remaining} 次`}人工接管${priority ? " · 优先处理" : " · 标准处理"}${expiry ? ` · 下一份权益 ${expiry} 到期` : ""}。`;
  },
  handoffPackageAction: "查看人工权益套餐",
  servicesEyebrow: "服务选项", servicesOptionalTitle: "需要时再升级", servicesNeededTitle: (humanInLoop: boolean) => humanInLoop ? "继续对话或申请人工" : "继续对话需要服务额度",
  creditPlanDetail: (available: number, reserved: number) => `当前还有 ${available} 个可用服务额度${reserved > 0 ? `，${reserved} 个正在处理中` : ""}；每次付费继续会先预留，再按实际完成结算。`,
  commerceUnavailableDetail: (humanInLoop: boolean) => humanInLoop ? "当前没有可购买的服务套餐；你仍可在对话中了解人工接管方式。" : "当前没有可购买的服务套餐。",
  openRecharge: "查看服务套餐",
  freeServiceTitle: "当前对话永久免费",
  freeServiceDetail: "不会销售继续对话所需的服务套餐；你可以直接使用数字代表。",
  optionalSupportAction: "查看自愿支持方式",
  privacyLabel: "隐私提示", privacyDetail: "不会读取主人的私人文件、账号或工作区。重要承诺需要真人确认。", privacyAction: "查看完整说明",
  welcome: (name: string, governedContextEnabled: boolean) =>
    governedContextEnabled
      ? `你好，我是 ${name}，你可以直接告诉我想了解什么。我会以已发布资料为基础，并可能使用仅限你与当前代表的受治理历史摘要；需要本人判断时，我会说明并帮你转交。`
      : `你好，我是 ${name}，你可以直接告诉我想了解什么。我会根据已发布的公开资料回答；遇到需要本人判断的事情，我会说明并帮你转交。`,
};

const enCopy = {
  eyebrow: "Talk to the digital representative",
  title: (name: string) => `Ask ${name}`,
  summary: (governedContextEnabled: boolean) =>
    governedContextEnabled
      ? "Describe what you need. Replies are grounded in published information and may also use governed history scoped only to you and this representative."
      : "Describe what you need. Replies are grounded in published information and show the public sources they use.",
  aiStatus: "AI is responding", humanStatus: "Human is responding",
  aiLabel: "AI", humanLabel: "Human", youLabel: "You", citationsLabel: "Context used", openSource: "Open public source",
  generalModelSourceDisclosure: "Source note: This answer did not cite authorized knowledge or memory; it was generated by a general-purpose model.",
  artifactsLabel: "Task results", downloadArtifact: "Download",
  startersLabel: "Try one of these",
  starters: ["What services do you offer?", "I have a partnership request", "Help me prepare a quote request", "I want to contact the owner"],
  inputLabel: "What do you need?", placeholder: "Describe the problem, context, and outcome you want…", footnote: "Do not send passwords, API keys, or sensitive information that should not be public.",
  continuationEyebrow: "Continue the conversation",
  serviceGateTitle: (accessMode: RepresentativeAccessMode) => accessMode === "CREDITS_ONLY"
    ? "Use service credits to continue"
    : "Your free trial is complete",
  serviceGateDetail: "Your message is saved in the composer. Buy a service package, then continue this conversation directly.",
  serviceGateHandoffDetail: "Your message is saved in the composer. No service package is available, but you can request human help instead.",
  servicePendingTitle: "Service credits are being confirmed",
  servicePendingDetail: "Do not buy again. You can send as soon as the credits arrive, and your draft will stay here.",
  lastFreeReplyDetail: "You have 1 free reply left. Keep asking, or review the service options available afterward.",
  previewServices: "View service options",
  composerTrustNote: (enabled: boolean) => enabled
    ? "May use public information and protected history scoped only to you and this representative."
    : "Uses public information; important commitments still require human confirmation.",
  sending: "Working…", send: "Send", thinking: (governedContextEnabled: boolean) => governedContextEnabled ? "Reviewing published knowledge and permitted context…" : "Reviewing published knowledge and preparing a reply…", loadingHistory: "Restoring conversation…", errorGeneric: "The chat request failed. Please try again shortly.", memoryPolicyChanged: "The memory policy just changed. Review the updated memory notice and send again; your previous message was not submitted.", serviceCreditPending: "Service credits are still being processed. Try again shortly; your message remains in the composer.", serviceCreditRequired: "Your free replies are used up. Buy service credits for this representative, then send again. Your message remains in the composer.", serviceCreditUnavailableWithHandoff: "Your free replies are used up, and this representative has no purchasable service plan right now. Request human help instead. Your message remains in the composer.", serviceCreditUnavailable: "Your free replies are used up, and this representative has no purchasable service plan right now. Your message remains in the composer.", replyTimeout: "The reply took too long. Please send it again; your message is still saved in this conversation.",
  humanQueueNotice: "This conversation is now in the human queue. You can keep adding context while the operator reviews the full thread.",
  sessionLabel: "This conversation",
  currentResponder: "Current responder", accessModeLabel: "Access", serviceCreditsLabel: "Service credits",
  unlimitedFreeAccess: "Always free",
  creditsOnlyAccess: "Uses service credits",
  trialAccess: (remaining: number, limit: number) => `${remaining}/${limit} free replies left`,
  aiActiveDetail: "You are talking to the digital representative. It will say when a human decision is needed.",
  humanActiveDetail: "A human has taken over. You can keep adding context and requirements.",
  handoffLabel: "Human takeover", handoffTitle: (ownerName: string) => `Ask ${ownerName} to review`, handoffAction: "How handoff works",
  handoffUnavailableTitle: "Not available",
  handoffUnavailableDetail: "Human takeover is disabled for this representative. The AI remains the responder.",
  handoffFreeDetail: "Ask in the conversation at no additional charge. Your goal and key context travel with the request.",
  handoffEntitlementLoading: "Checking this account's human-takeover entitlement…",
  handoffEntitlementUnavailable: "Human-takeover entitlement cannot be confirmed right now. To avoid a duplicate purchase, refresh and try again later.",
  handoffPackageRequiredDetail: "No human-takeover entitlement is currently available. Buy a service package that includes one, then request it during its validity period.",
  handoffPackageUnavailableDetail: "No human-takeover entitlement or purchasable package with human help is currently available.",
  handoffEntitlementDetail: (unlimited: boolean, remaining: number, priority: boolean, expiresAt: string | null) => {
    const expiry = formatHandoffExpiryDate(expiresAt, "en");
    return `${unlimited ? "Unlimited" : `${remaining} remaining`} human takeover${priority ? " · priority service" : " · standard service"}${expiry ? ` · next entitlement expires ${expiry}` : ""}.`;
  },
  handoffPackageAction: "View packages with human help",
  servicesEyebrow: "Service options", servicesOptionalTitle: "Upgrade only when needed", servicesNeededTitle: (humanInLoop: boolean) => humanInLoop ? "Continue or request human help" : "Service credits are required to continue",
  creditPlanDetail: (available: number, reserved: number) => `${available} service credits remain${reserved > 0 ? `, with ${reserved} currently reserved` : ""}. Paid continuation reserves first and settles only after completion.`,
  commerceUnavailableDetail: (humanInLoop: boolean) => humanInLoop ? "No service package is currently available. You can still ask how human takeover works in the conversation." : "No service package is currently available.",
  openRecharge: "View service packages",
  freeServiceTitle: "This conversation is always free",
  freeServiceDetail: "No service package is sold to keep chatting; use the digital representative directly.",
  optionalSupportAction: "View voluntary support options",
  privacyLabel: "Privacy", privacyDetail: "This representative cannot read the owner's private files, accounts, or workspace. Important commitments require human confirmation.", privacyAction: "Read the full explanation",
  welcome: (name: string, governedContextEnabled: boolean) =>
    governedContextEnabled
      ? `Hi, I’m ${name}. Tell me what you want to understand. I use published information and may use governed history scoped only to you and this representative; I will offer a handoff when the owner needs to decide.`
      : `Hi, I’m ${name}. Tell me what you want to understand. I answer from published public information and will clearly offer a handoff when the owner needs to decide.`,
};

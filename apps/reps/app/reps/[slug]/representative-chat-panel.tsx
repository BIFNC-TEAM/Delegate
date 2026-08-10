"use client";

import { useEffect, useRef, useState } from "react";

import type { PlanTier, PricingPlan } from "@delegate/domain";
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
  type PublicWalletUpdatedDetail,
} from "./public-wallet-client";
import {
  getGovernedContextDisclosure,
  type GovernedMemoryDisclosure,
} from "./governed-context-disclosure";
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
type PublicChatHistory = {
  state: string;
  humanActive: boolean;
  messages: Array<ChatMessage & { senderType: string; createdAt: string }>;
  usage: PublicChatResponse["usage"];
};
type PublicChatAccepted = {
  status: "queued" | "waiting_human" | "completed";
  runId?: string;
  heldForOperator?: boolean;
  reply?: PublicChatResponse["reply"];
  tier: PlanTier;
  usage: PublicChatResponse["usage"];
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
  pricing: PricingPlan[];
  locale: "zh" | "en";
  freeReplyLimit: number;
  computeEnabled: boolean;
  governedMemoryDisclosure: GovernedMemoryDisclosure;
  serviceCreditPaymentMode: "mock" | "wechat";
  serviceCreditPurchaseEnabled: boolean;
}) {
  const t = props.locale === "zh" ? zhCopy : enCopy;
  const [governedMemoryDisclosure, setGovernedMemoryDisclosure] = useState(
    props.governedMemoryDisclosure,
  );
  const governedContextEnabled = governedMemoryDisclosure.enabled;
  const governedContextDisclosure = getGovernedContextDisclosure(
    props.locale,
    governedMemoryDisclosure,
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const keepChatPinnedRef = useRef(true);
  const activeRunSourceRef = useRef<EventSource | null>(null);
  const activeRunTimeoutRef = useRef<number | null>(null);
  const acknowledgedDisplayKeysRef = useRef(new Set<string>());
  const displayAckRetryTimersRef = useRef(new Set<number>());
  const displayAckMountedRef = useRef(false);
  const previousReservedCreditsRef = useRef(0);
  const [selectedTier, setSelectedTier] = useState<PlanTier>("free");
  const [showPlans, setShowPlans] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: t.welcome(props.representativeName, governedContextEnabled),
    },
  ]);
  const [usage, setUsage] = useState<PublicChatResponse["usage"]>({
    freeRepliesUsed: 0,
    freeRepliesRemaining: props.freeReplyLimit,
    serviceCreditsAvailable: 0,
    serviceCreditsReserved: 0,
    passUnlocked: false,
    deepHelpUnlocked: false,
  });
  const [humanActive, setHumanActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hydrating, setHydrating] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activePlan = props.pricing.find((plan) => plan.tier === selectedTier) ?? props.pricing[0];
  const planAction = resolvePlanSelectionAction(
    selectedTier,
    props.serviceCreditPurchaseEnabled,
    usage.passUnlocked,
  );
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
    if (usage.freeRepliesRemaining > 0 || selectedTier !== "free") return;
    if (usage.passUnlocked) {
      setSelectedTier("pass");
      setShowPlans(
        usage.serviceCreditsAvailable === 0
        && usage.serviceCreditsReserved > 0,
      );
      return;
    }
    const recommended = props.pricing.find((plan) => plan.tier === "pass");
    if (recommended) {
      setSelectedTier(recommended.tier);
      setShowPlans(true);
    }
  }, [
    props.pricing,
    selectedTier,
    usage.freeRepliesRemaining,
    usage.passUnlocked,
    usage.serviceCreditsAvailable,
    usage.serviceCreditsReserved,
  ]);

  useEffect(() => {
    const transition = resolvePublicChatServiceCreditPendingTransition({
      previousReserved: previousReservedCreditsRef.current,
      serviceCreditsAvailable: usage.serviceCreditsAvailable,
      serviceCreditsReserved: usage.serviceCreditsReserved,
    });
    previousReservedCreditsRef.current = usage.serviceCreditsReserved;
    if (!transition) return;

    const passPlan = props.pricing.find((plan) => plan.tier === "pass");
    if (passPlan) setSelectedTier("pass");
    setShowPlans(transition === "released");
    setError((currentError) => {
      if (currentError !== t.serviceCreditPending) return currentError;
      if (transition === "available") return null;
      const nextStep = resolvePublicChatServiceCreditNextStep({
        serviceCreditsAvailable: usage.serviceCreditsAvailable,
        serviceCreditsReserved: usage.serviceCreditsReserved,
        purchaseEnabled: Boolean(
          passPlan && props.serviceCreditPurchaseEnabled,
        ),
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
    props.pricing,
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
      if (detail.serviceCreditsAvailable > 0) {
        setSelectedTier("pass");
        setShowPlans(false);
        setError(null);
      } else if (detail.serviceCreditsReserved > 0) {
        setSelectedTier("pass");
        setShowPlans(true);
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
          const passPlan = props.pricing.find((plan) => plan.tier === "pass");
          const nextStep = resolvePublicChatServiceCreditNextStep({
            serviceCreditsAvailable: payload.usage.serviceCreditsAvailable,
            serviceCreditsReserved: payload.usage.serviceCreditsReserved,
            purchaseEnabled: Boolean(
              passPlan && props.serviceCreditPurchaseEnabled,
            ),
            humanInLoop: props.humanInLoop,
          });
          if (passPlan) {
            setSelectedTier("pass");
            setShowPlans(true);
          }
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
      setSelectedTier(payload.tier);
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
            <p className="footer-note representative-chat-memory-note">
              {governedContextDisclosure}
            </p>
            <div className="dashboard-form-footer"><p className="footer-note">{t.footnote}</p><div className="button-row"><button className="button-primary" disabled={busy || hydrating || !input.trim()} type="submit">{hydrating ? t.loadingHistory : busy ? t.sending : t.send}</button></div></div>
          </form>
          {error ? <p className="feedback-error" role="alert">{error}</p> : null}
        </div>

        <aside className="representative-session-sidebar" aria-label={t.sessionLabel}>
          <section className="representative-session-card is-status">
            <span className="panel-title">{t.sessionLabel}</span>
            <div className="representative-session-row"><span>{t.currentResponder}</span><strong>{humanActive ? t.humanStatus : t.aiStatus}</strong></div>
            <div className="representative-session-row"><span>{t.freeRepliesLabel}</span><strong>{usage.freeRepliesRemaining}/{props.freeReplyLimit}</strong></div>
            <div className="representative-session-row"><span>{t.serviceCreditsLabel}</span><strong>{usage.serviceCreditsAvailable}</strong></div>
            <p>{humanActive ? t.humanActiveDetail : t.aiActiveDetail}</p>
          </section>

          {props.humanInLoop ? (
            <section className="representative-session-card">
              <span className="panel-title">{t.handoffLabel}</span>
              <strong>{t.handoffTitle(props.ownerName)}</strong>
              <p>{t.handoffDetail}</p>
              <a className="button-secondary" href="#handoff">{t.handoffAction}</a>
            </section>
          ) : null}

          <section className="representative-session-card representative-service-disclosure">
            <button aria-expanded={showPlans} className="representative-service-toggle" onClick={() => setShowPlans((current) => !current)} type="button">
              <span><small>{t.servicesEyebrow}</small><strong>{usage.freeRepliesRemaining > 0 ? t.servicesOptionalTitle : t.servicesNeededTitle(props.humanInLoop)}</strong></span>
              <b aria-hidden="true">{showPlans ? "−" : "+"}</b>
            </button>
            {showPlans ? (
              <div className="representative-service-options">
                {activePlan ? (
                  <div aria-live="polite" className={`representative-chat-plan-action is-${planAction}`} role="status">
                    <span className="panel-title">{t.selectedPlan}</span><strong>{activePlan.name}</strong>
                    <p>{planAction === "current" ? selectedTier === "free" ? t.currentPlanDetail(usage.freeRepliesRemaining, props.freeReplyLimit) : t.creditPlanDetail(usage.serviceCreditsAvailable, usage.serviceCreditsReserved) : planAction === "recharge" ? t.rechargeDetail(props.serviceCreditPaymentMode) : t.commerceUnavailableDetail(props.humanInLoop)}</p>
                    {planAction === "recharge" ? <a className="button-primary" href="#recharge">{t.openRecharge(props.serviceCreditPaymentMode)}</a> : planAction === "unavailable" && props.humanInLoop ? <a className="button-secondary" href="#handoff">{t.contactOwner}</a> : null}
                  </div>
                ) : null}
                <div className="representative-chat-tier-grid">
                  {props.pricing.map((plan) => (
                    <button aria-pressed={plan.tier === selectedTier} className={plan.tier === selectedTier ? "representative-chat-tier representative-chat-tier-active" : "representative-chat-tier"} key={plan.tier} onClick={() => setSelectedTier(plan.tier)} type="button">
                      <div className="representative-chat-tier-header"><strong>{plan.name}</strong><span>{plan.stars} credits</span></div>
                      <p>{plan.summary}</p>
                      <div className="chip-row"><span className="chip">{t.repliesChip(plan.includedReplies)}</span>{plan.includesPriorityHandoff ? <span className="chip chip-safe">{t.priorityHandoff}</span> : null}</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          <section className="representative-session-card is-privacy">
            <span className="panel-title">{t.privacyLabel}</span>
            <p>{t.privacyDetail}</p>
            <a href="#trust">{t.privacyAction}</a>
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

export function resolvePlanSelectionAction(
  tier: PlanTier,
  serviceCreditPurchaseEnabled: boolean,
  paidUnlocked = false,
): "current" | "recharge" | "unavailable" {
  if (tier === "free") return "current";
  if (tier === "pass" && paidUnlocked) return "current";
  return serviceCreditPurchaseEnabled ? "recharge" : "unavailable";
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
  sending: "正在处理…", send: "发送", thinking: (governedContextEnabled: boolean) => governedContextEnabled ? "正在结合已发布知识与允许使用的上下文整理回复…" : "正在结合已发布知识整理回复…", loadingHistory: "恢复会话中…", errorGeneric: "聊天请求失败，请稍后再试。", memoryPolicyChanged: "记忆策略刚刚更新。请阅读新的记忆说明后重新发送；上一条内容尚未提交。", serviceCreditPending: "服务额度正在处理中，请稍后重试；你的问题已保留在输入框中。", serviceCreditRequired: "免费回复已用完。请购买当前数字代表的服务额度后再发送；你的问题已保留在输入框中。", serviceCreditUnavailableWithHandoff: "免费回复已用完，当前数字代表暂无可购买的服务方案；可申请真人协助。你的问题已保留在输入框中。", serviceCreditUnavailable: "免费回复已用完，当前数字代表暂无可购买的服务方案。你的问题已保留在输入框中。", replyTimeout: "回复处理超时，请重新发送；已发送的内容仍保留在本次会话中。",
  humanQueueNotice: "已进入人工处理队列。你可以继续补充信息，负责人员会看到完整上下文。",
  sessionLabel: "本次会话",
  currentResponder: "当前接待", freeRepliesLabel: "免费回复", serviceCreditsLabel: "服务额度",
  aiActiveDetail: "你正在与数字代表对话；需要真人判断时会明确提示。",
  humanActiveDetail: "真人已经接手，你仍可以继续补充背景和要求。",
  handoffLabel: "需要真人？", handoffTitle: (ownerName: string) => `申请 ${ownerName} 查看`, handoffDetail: "先在对话中留下目标和关键背景，转接时会一起提交。", handoffAction: "了解转接方式",
  servicesEyebrow: "服务选项", servicesOptionalTitle: "需要时再升级", servicesNeededTitle: (humanInLoop: boolean) => humanInLoop ? "继续对话或申请人工" : "继续对话需要服务额度",
  selectedPlan: "已选择方案",
  repliesChip: (count: number) => count > 0 ? `${count} 次回复` : "公共额度支持",
  priorityHandoff: "优先人工评估",
  currentPlanDetail: (remaining: number, limit: number) => `当前免费方案剩余 ${remaining}/${limit} 次回复，无需付款。`,
  creditPlanDetail: (available: number, reserved: number) => `当前还有 ${available} 个可用服务额度${reserved > 0 ? `，${reserved} 个正在处理中` : ""}；每次付费继续会先预留，再按实际完成结算。`,
  rechargeDetail: (paymentMode: "mock" | "wechat") => paymentMode === "mock" ? "当前为本地演示支付：模拟支付后会自动购买仅限当前代表的服务额度，可用于验证付费继续；不会真实扣款。" : "购买后会获得仅限当前代表使用的服务额度；支付成功后即可继续对话。",
  commerceUnavailableDetail: (humanInLoop: boolean) => humanInLoop ? "真实支付和套餐解锁尚未接入。当前选择不会扣费；你可以先申请真人确认后续服务。" : "真实支付和套餐解锁尚未接入。当前选择不会扣费。",
  openRecharge: (paymentMode: "mock" | "wechat") => paymentMode === "mock" ? "前往演示充值" : "购买服务额度",
  contactOwner: "申请真人协助",
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
  sending: "Working…", send: "Send", thinking: (governedContextEnabled: boolean) => governedContextEnabled ? "Reviewing published knowledge and permitted context…" : "Reviewing published knowledge and preparing a reply…", loadingHistory: "Restoring conversation…", errorGeneric: "The chat request failed. Please try again shortly.", memoryPolicyChanged: "The memory policy just changed. Review the updated memory notice and send again; your previous message was not submitted.", serviceCreditPending: "Service credits are still being processed. Try again shortly; your message remains in the composer.", serviceCreditRequired: "Your free replies are used up. Buy service credits for this representative, then send again. Your message remains in the composer.", serviceCreditUnavailableWithHandoff: "Your free replies are used up, and this representative has no purchasable service plan right now. Request human help instead. Your message remains in the composer.", serviceCreditUnavailable: "Your free replies are used up, and this representative has no purchasable service plan right now. Your message remains in the composer.", replyTimeout: "The reply took too long. Please send it again; your message is still saved in this conversation.",
  humanQueueNotice: "This conversation is now in the human queue. You can keep adding context while the operator reviews the full thread.",
  sessionLabel: "This conversation",
  currentResponder: "Current responder", freeRepliesLabel: "Free replies", serviceCreditsLabel: "Service credits",
  aiActiveDetail: "You are talking to the digital representative. It will say when a human decision is needed.",
  humanActiveDetail: "A human has taken over. You can keep adding context and requirements.",
  handoffLabel: "Need a human?", handoffTitle: (ownerName: string) => `Ask ${ownerName} to review`, handoffDetail: "Leave the goal and key context in the conversation so it can travel with the handoff.", handoffAction: "How handoff works",
  servicesEyebrow: "Service options", servicesOptionalTitle: "Upgrade only when needed", servicesNeededTitle: (humanInLoop: boolean) => humanInLoop ? "Continue or request human help" : "Service credits are required to continue",
  selectedPlan: "Selected plan",
  repliesChip: (count: number) => count > 0 ? `${count} replies` : "Supports the public pool",
  priorityHandoff: "Priority human review",
  currentPlanDetail: (remaining: number, limit: number) => `The free plan has ${remaining} of ${limit} replies left and requires no payment.`,
  creditPlanDetail: (available: number, reserved: number) => `${available} service credits remain${reserved > 0 ? `, with ${reserved} currently reserved` : ""}. Paid continuation reserves first and settles only after completion.`,
  rechargeDetail: (paymentMode: "mock" | "wechat") => paymentMode === "mock" ? "This local demo automatically buys service credits scoped to this representative after simulated payment, so paid continuation can be verified without a real charge." : "A purchase adds service credits scoped only to this representative. You can continue the conversation after payment succeeds.",
  commerceUnavailableDetail: (humanInLoop: boolean) => humanInLoop ? "Live payment and plan entitlement are not connected yet. Selecting this plan will not charge you; contact the representative owner for next steps." : "Live payment and plan entitlement are not connected yet. Selecting this plan will not charge you.",
  openRecharge: (paymentMode: "mock" | "wechat") => paymentMode === "mock" ? "Open demo recharge" : "Buy service credits",
  contactOwner: "Request human help",
  privacyLabel: "Privacy", privacyDetail: "This representative cannot read the owner's private files, accounts, or workspace. Important commitments require human confirmation.", privacyAction: "Read the full explanation",
  welcome: (name: string, governedContextEnabled: boolean) =>
    governedContextEnabled
      ? `Hi, I’m ${name}. Tell me what you want to understand. I use published information and may use governed history scoped only to you and this representative; I will offer a handoff when the owner needs to decide.`
      : `Hi, I’m ${name}. Tell me what you want to understand. I answer from published public information and will clearly offer a handoff when the owner needs to decide.`,
};

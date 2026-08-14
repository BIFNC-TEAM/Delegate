"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

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
import type { GovernedMemoryDisclosure } from "./governed-context-disclosure";
import {
  REPRESENTATIVE_PROFILE_RAIL_OPEN_EVENT,
  REPRESENTATIVE_PROFILE_RAIL_STATE_EVENT,
  REPRESENTATIVE_PROFILE_SECTION_OPEN_EVENT,
  type RepresentativeProfileSection,
} from "./representative-profile-rail-events";
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
  createdAt?: string;
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
const PROFILE_RAIL_COMPACT_QUERY = "(max-width: 1180px)";
const PROFILE_RAIL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function RepresentativeChatPanel(props: {
  representativeSlug: string;
  representativeName: string;
  ownerName: string;
  humanInLoop: boolean;
  accessMode: RepresentativeAccessMode;
  faqQuestions: string[];
  hasPublicCommerce: boolean;
  hasServicePackages: boolean;
  locale: "zh" | "en";
  freeReplyLimit: number;
  computeEnabled: boolean;
  governedMemoryDisclosure: GovernedMemoryDisclosure;
  initialProfileSection?: RepresentativeProfileSection;
  serviceCreditPurchaseEnabled: boolean;
  profilePanel?: ReactNode;
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
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const profileRailToggleRef = useRef<HTMLButtonElement>(null);
  const profileRailRef = useRef<HTMLElement>(null);
  const profileRailCloseRef = useRef<HTMLButtonElement>(null);
  const profileRailOpenerRef = useRef<HTMLElement | null>(null);
  const previousReservedCreditsRef = useRef(0);
  const [showServices, setShowServices] = useState(
    props.accessMode === "CREDITS_ONLY",
  );
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [usage, setUsage] = useState<PublicChatUsage>({
    freeRepliesUsed: 0,
    freeRepliesRemaining: props.freeReplyLimit,
    serviceCreditsAvailable: 0,
    serviceCreditsReserved: 0,
    serviceCreditsPurchased: 0,
    passUnlocked: false,
    deepHelpUnlocked: false,
    accessMode: props.accessMode,
    unlimitedFreeAccess: props.accessMode === "FREE",
  });
  const [humanActive, setHumanActive] = useState(false);
  const [conversationState, setConversationState] = useState("new");
  const [busy, setBusy] = useState(false);
  const [hydrating, setHydrating] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [copyFailedMessageId, setCopyFailedMessageId] = useState<string | null>(null);
  const [profileRailOpen, setProfileRailOpen] = useState(false);
  const [profileRailReady, setProfileRailReady] = useState(false);
  const [profileRailCompact, setProfileRailCompact] = useState(false);
  const computeAssist = getComputeAssist(input, props.locale, props.computeEnabled);
  const faqQuestions = [...new Set(
    props.faqQuestions.map((question) => question.trim()).filter(Boolean),
  )].slice(0, 3);

  useEffect(() => {
    const compactViewport = window.matchMedia(PROFILE_RAIL_COMPACT_QUERY);
    const applyViewportMode = (compact: boolean) => {
      const storageKey = `delegate:representative-profile-rail:${props.representativeSlug}:${compact ? "compact" : "wide"}`;
      let storedValue: string | null = null;
      try {
        storedValue = window.localStorage.getItem(storageKey);
      } catch {
        // A browser privacy policy can deny storage. The viewport default still
        // leaves the disclosure control usable for this visit.
      }
      const nestedModalOpen = Boolean(document.querySelector(
        ".representative-profile-modal",
      ));
      setProfileRailCompact(compact);
      setProfileRailOpen(
        nestedModalOpen
          ? true
          : props.initialProfileSection
            ? true
          : storedValue === null
            ? !compact
            : storedValue === "open",
      );
      setProfileRailReady(true);
    };
    const handleViewportChange = (event: MediaQueryListEvent) => {
      applyViewportMode(event.matches);
    };
    applyViewportMode(compactViewport.matches);
    compactViewport.addEventListener("change", handleViewportChange);
    return () => compactViewport.removeEventListener("change", handleViewportChange);
  }, [props.initialProfileSection, props.representativeSlug]);

  useEffect(() => {
    const openProfileRail = (event: Event) => {
      const opener = (event as CustomEvent<{ opener?: HTMLElement }>).detail?.opener;
      profileRailOpenerRef.current = opener?.isConnected
        ? opener
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setProfileRailVisibility(true);
    };
    window.addEventListener(REPRESENTATIVE_PROFILE_RAIL_OPEN_EVENT, openProfileRail);
    return () => window.removeEventListener(
      REPRESENTATIVE_PROFILE_RAIL_OPEN_EVENT,
      openProfileRail,
    );
  }, [profileRailCompact]);

  useEffect(() => {
    if (!profileRailReady) return;
    window.dispatchEvent(new CustomEvent(REPRESENTATIVE_PROFILE_RAIL_STATE_EVENT, {
      detail: { open: profileRailOpen },
    }));
  }, [profileRailOpen, profileRailReady]);

  useEffect(() => {
    if (!profileRailOpen || !profileRailCompact) return;
    const previousOverflow = document.body.style.overflow;
    const backgroundElements = Array.from(document.querySelectorAll<HTMLElement>([
      ".representative-profile-page > .representative-topbar",
      ".representative-profile-page .representative-chat-surface",
      ".representative-profile-page > .representative-visitor-section",
      ".representative-profile-page > .representative-trust-section",
      ".representative-profile-page > .representative-visitor-footer",
    ].join(",")));
    const backgroundState = backgroundElements.map((element) => ({
      ariaHidden: element.getAttribute("aria-hidden"),
      element,
      inert: element.inert,
    }));
    if (!document.querySelector(".representative-profile-modal")) {
      profileRailCloseRef.current?.focus();
    }
    document.body.style.overflow = "hidden";
    for (const { element } of backgroundState) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector(".representative-profile-modal")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setProfileRailVisibility(false);
        return;
      }
      if (event.key !== "Tab") return;
      const rail = profileRailRef.current;
      if (!rail) return;
      const focusable = Array.from(
        rail.querySelectorAll<HTMLElement>(PROFILE_RAIL_FOCUSABLE_SELECTOR),
      ).filter((element) => (
        !element.hidden
        && !element.closest("[inert]")
        && element.getAttribute("aria-hidden") !== "true"
        && element.getClientRects().length > 0
      ));
      if (!focusable.length) {
        event.preventDefault();
        rail.focus();
        return;
      }
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
      for (const { ariaHidden, element, inert } of backgroundState) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [profileRailCompact, profileRailOpen]);

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
            createdAt: message.createdAt,
            senderType: message.senderType,
            ...(message.senderDisplayName ? { senderDisplayName: message.senderDisplayName } : {}),
            ...(message.status ? { status: message.status } : {}),
            ...(message.citations?.length ? { citations: message.citations } : {}),
            ...(message.attachments?.length ? { attachments: message.attachments } : {}),
            ...(message.displayAck ? { displayAck: message.displayAck } : {}),
            ...(message.sourceDisclosure ? { sourceDisclosure: message.sourceDisclosure } : {}),
          })));
        } else if (payload.state === "new") {
          setMessages([{
            id: "welcome",
            role: "assistant",
            text: t.welcome(props.representativeName, governedContextEnabled),
            createdAt: new Date().toISOString(),
            senderType: "representative",
            status: "completed",
          }]);
        } else {
          setMessages([]);
        }
        setConversationState(payload.state);
        setHumanActive(payload.humanActive);
        setUsage(payload.usage);
      })
      .catch((historyError) => {
        if (!cancelled) {
          setConversationState("unavailable");
          setError(historyError instanceof Error ? historyError.message : t.errorGeneric);
        }
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
            createdAt: message.createdAt,
            senderType: message.senderType,
            ...(message.senderDisplayName ? { senderDisplayName: message.senderDisplayName } : {}),
            ...(message.status ? { status: message.status } : {}),
            ...(message.citations?.length ? { citations: message.citations } : {}),
            ...(message.attachments?.length ? { attachments: message.attachments } : {}),
            ...(message.displayAck ? { displayAck: message.displayAck } : {}),
            ...(message.sourceDisclosure ? { sourceDisclosure: message.sourceDisclosure } : {}),
          })));
        }
        setConversationState(payload.state);
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
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
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
        serviceCreditsPurchased: detail.serviceCreditsPurchased,
        passUnlocked:
          detail.serviceCreditsAvailable > 0
          || detail.serviceCreditsReserved > 0,
      }));
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
    if (!keepChatPinnedRef.current || messages.length <= 1) return;
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

  function chooseStarter(value: string) {
    setInput(value);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function sendFaqQuestion(question: string) {
    void submitMessage(question);
  }

  async function handleCopyMessage(message: ChatMessage) {
    try {
      await copyTextToClipboard(message.text);
      setCopiedMessageId(message.id);
      setCopyFailedMessageId(null);
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
      copyFeedbackTimerRef.current = window.setTimeout(() => {
        setCopiedMessageId((current) => current === message.id ? null : current);
        setCopyFailedMessageId((current) => current === message.id ? null : current);
        copyFeedbackTimerRef.current = null;
      }, 1_800);
    } catch {
      setCopiedMessageId(null);
      setCopyFailedMessageId(message.id);
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
      copyFeedbackTimerRef.current = window.setTimeout(() => {
        setCopyFailedMessageId((current) => current === message.id ? null : current);
        copyFeedbackTimerRef.current = null;
      }, 1_800);
    }
  }

  function setProfileRailVisibility(nextOpen: boolean) {
    setProfileRailOpen(nextOpen);
    try {
      window.localStorage.setItem(
        `delegate:representative-profile-rail:${props.representativeSlug}:${profileRailCompact ? "compact" : "wide"}`,
        nextOpen ? "open" : "closed",
      );
    } catch {
      // The control remains functional for this visit when storage is denied.
    }
    if (!nextOpen) {
      const opener = profileRailOpenerRef.current;
      requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus();
        else profileRailToggleRef.current?.focus();
      });
    }
  }

  function openProfileSection(
    section: RepresentativeProfileSection,
    opener: HTMLElement,
  ) {
    profileRailOpenerRef.current = opener;
    setProfileRailVisibility(true);
    window.dispatchEvent(new CustomEvent(REPRESENTATIVE_PROFILE_SECTION_OPEN_EVENT, {
      detail: { opener, section },
    }));
  }

  function revealProfileRail(opener: HTMLElement) {
    profileRailOpenerRef.current = opener;
    setProfileRailVisibility(true);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitMessage(input);
  }

  async function submitMessage(value: string) {
    const text = value.trim();
    if (!text || busy || hydrating) return;
    keepChatPinnedRef.current = true;
    const userMessage = {
      id: createClientMessageId(),
      role: "user" as const,
      text,
      status: "accepted",
      senderType: "audience",
      createdAt: new Date().toISOString(),
    };
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
          senderType: "representative",
          createdAt: new Date().toISOString(),
          status: "completed",
          ...(payload.reply.sourceDisclosure
            ? { sourceDisclosure: payload.reply.sourceDisclosure }
            : {}),
        });
        setBusy(false);
        setConversationState("active");
      } else if (payload.heldForOperator || payload.status === "waiting_human") {
        // The acceptance response proves that AI generation was held, but it
        // cannot distinguish an existing human assignment from a new queue
        // request. Preserve the last authoritative assignment flag until the
        // conversation stream supplies the exact state.
        setConversationState(payload.status);
        appendAssistant({
          id: `handoff-${Date.now()}`,
          role: "assistant",
          text: t.humanQueueNotice,
          senderType: "system",
          createdAt: new Date().toISOString(),
          status: "waiting_human",
        });
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
            createdAt?: string;
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
            senderType: "representative",
            createdAt: snapshot.message.createdAt || new Date().toISOString(),
            status: snapshot.message.status,
            citations: snapshot.message.citations,
            ...(snapshot.message.attachments?.length ? { attachments: snapshot.message.attachments } : {}),
            ...(snapshot.message.displayAck ? { displayAck: snapshot.message.displayAck } : {}),
            ...(snapshot.message.sourceDisclosure
              ? { sourceDisclosure: snapshot.message.sourceDisclosure }
              : {}),
          });
          setConversationState("active");
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
  const accessPresentation = accessMode === "FREE"
    ? { label: t.unlimitedFreeAccess, value: t.unlimitedAccessValue }
    : accessMode === "CREDITS_ONLY"
      ? { label: t.creditsOnlyAccess, value: null }
      : {
          label: t.freeAllowanceLabel,
          value: t.allowanceValue(
            usage.freeRepliesRemaining,
            props.freeReplyLimit,
          ),
        };
  const totalCredits = Math.max(
    usage.serviceCreditsAvailable + usage.serviceCreditsReserved,
    usage.serviceCreditsPurchased,
  );
  const remainingPurchasedCredits = usage.serviceCreditsAvailable
    + usage.serviceCreditsReserved;
  const totalAllowance = (
    accessMode === "CREDITS_ONLY" ? 0 : props.freeReplyLimit
  ) + totalCredits;
  const remainingAllowance = usage.freeRepliesRemaining
    + usage.serviceCreditsAvailable
    + usage.serviceCreditsReserved;
  const allowancePresentation = accessMode === "FREE"
    ? t.unlimitedRemaining
    : t.remainingAllowance(remainingAllowance, totalAllowance);
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
  const responder = resolveResponderPresentation({
    busy,
    conversationState,
    humanActive,
    hydrating,
    locale: props.locale,
  });
  const composerDescription = computeAssist
    ? "representative-compute-assist"
    : undefined;
  const sessionSummary = responder.kind === "human"
    ? t.humanActiveDetail
    : responder.kind === "offline"
      ? t.connectionInterruptedDetail
      : responder.kind === "error"
        ? t.failedReplyDetail
        : null;

  return (
    <section className="representative-conversation-shell" id="chat">
      <div className={`representative-chat-first-grid${profileRailOpen ? " is-profile-open" : " is-profile-collapsed"}${profileRailReady ? "" : " is-profile-pending"}`}>
        <div className={messages.length <= 1 ? "representative-chat-surface is-empty" : "representative-chat-surface"}>
          <header aria-label={t.sessionLabel} className="representative-conversation-heading representative-chat-header">
            <div className="representative-chat-identity">
              <span aria-hidden="true" className="representative-chat-identity-avatar">
                {getAvatarInitials(props.representativeName)}
              </span>
              <span>
                <small>{t.digitalRepresentativeLabel}</small>
                <strong>{props.representativeName}</strong>
              </span>
            </div>
            <div className="representative-conversation-controls">
              <div className={`representative-conversation-status is-${responder.kind}`} aria-live="polite">
                <strong className={`representative-responder-pill is-${responder.kind}`}>
                  <i aria-hidden="true" />{responder.label}
                </strong>
              </div>
              <button
                aria-label={profileRailOpen ? t.hideProfilePanel : t.showProfilePanel}
                aria-controls="representative-profile-rail"
                aria-expanded={profileRailOpen}
                aria-haspopup={profileRailCompact ? "dialog" : undefined}
                className="representative-profile-rail-toggle"
                onClick={(event) => {
                  profileRailOpenerRef.current = event.currentTarget;
                  setProfileRailVisibility(!profileRailOpen);
                }}
                ref={profileRailToggleRef}
                title={profileRailOpen ? t.hideProfilePanel : t.showProfilePanel}
                type="button"
              >
                <ProfilePanelIcon />
              </button>
            </div>
          </header>
          <div
            ref={chatLogRef}
            className="representative-chat-log"
            aria-busy={busy}
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
              const isSystem = message.senderType === "system" || message.senderType === "tool";
              const isCopied = copiedMessageId === message.id;
              const isCopyFailed = copyFailedMessageId === message.id;
              const senderName = message.role === "user"
                ? t.youLabel
                : isOperator
                  ? message.senderDisplayName || props.ownerName
                  : isSystem
                    ? message.senderType === "tool" ? t.taskUpdateLabel : t.systemLabel
                    : props.representativeName;
              const displayText = localizeSystemMessage(message.text, message.senderType, props.locale);
              const displayTime = formatMessageTime(message.createdAt, props.locale, t.justNow);
              const displayDateTime = formatMessageDateTime(message.createdAt, props.locale);

              if (isSystem) {
                return (
                  <article className={`representative-system-message${message.senderType === "tool" ? " is-task-update" : ""}`} key={message.id}>
                    <header className="representative-system-message-header">
                      <strong>{senderName}</strong>
                      <time dateTime={message.createdAt} title={displayDateTime}>{displayTime}</time>
                    </header>
                    <p>{displayText}</p>
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
              }

              return (
                <article className={`representative-chat-message representative-chat-message-${message.role}${isOperator ? " is-operator" : ""}`} key={message.id}>
                  <div
                    aria-label={message.role === "user" ? t.visitorAvatarLabel : isOperator ? t.humanAvatarLabel(senderName) : t.aiAvatarLabel(senderName)}
                    className={`representative-message-avatar${message.role === "user" ? " is-visitor" : isOperator ? " is-operator" : " is-ai"}`}
                    role="img"
                  >
                    <span aria-hidden="true">{getAvatarInitials(senderName)}</span>
                    {!isOperator && message.role === "assistant" ? (
                      <b aria-label={t.aiAvatarBadgeLabel}>AI</b>
                    ) : null}
                  </div>
                  <div className="representative-message-content">
                    <div className="representative-message-bubble">
                      <p>{message.text}</p>
                  {message.role === "assistant"
                    && message.sourceDisclosure === "general_model"
                    && !isOperator ? (
                    <small className="representative-answer-source-disclosure">
                      {t.generalModelSourceDisclosure}
                    </small>
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
                    </div>
                    <footer className="representative-message-actions">
                      {visibleStatus ? <span className="representative-message-status">{visibleStatus}</span> : null}
                      <span className="representative-message-actions-tools">
                        <time className="representative-message-time" dateTime={message.createdAt} title={displayDateTime}>{displayTime}</time>
                        <button
                          aria-label={isCopied
                            ? t.copiedAction
                            : isCopyFailed
                              ? t.copyFailedAction
                              : t.copyMessageAction(senderName)}
                          className={`representative-message-copy${isCopied ? " is-copied" : ""}${isCopyFailed ? " is-failed" : ""}`}
                          onClick={() => void handleCopyMessage(message)}
                          title={isCopied ? t.copiedAction : isCopyFailed ? t.copyFailedAction : t.copyAction}
                          type="button"
                        >
                          <CopyIcon />
                          <span aria-live="polite">
                            {isCopied ? t.copiedAction : isCopyFailed ? t.copyFailedAction : t.copyAction}
                          </span>
                        </button>
                      </span>
                    </footer>
                  </div>
                </article>
              );
            })}
            {busy && responder.kind === "ai" ? (
              <article className="representative-chat-message representative-chat-message-assistant is-pending">
                <div aria-label={t.aiAvatarLabel(props.representativeName)} className="representative-message-avatar is-ai" role="img">
                  <span aria-hidden="true">{getAvatarInitials(props.representativeName)}</span>
                  <b aria-label={t.aiAvatarBadgeLabel}>AI</b>
                </div>
                <div className="representative-message-content">
                  <div className="representative-message-bubble"><p>{t.thinking(governedContextEnabled)}</p></div>
                </div>
              </article>
            ) : null}
          </div>

          {messages.length === 1 && messages[0]?.id === "welcome" && faqQuestions.length > 0 ? (
            <div className="representative-chat-starters" aria-label={t.faqSuggestionsLabel}>
              <span>{t.faqSuggestionsLabel}</span>
              <div>{faqQuestions.map((question) => (
                <button
                  disabled={busy || hydrating}
                  key={question}
                  onClick={() => sendFaqQuestion(question)}
                  type="button"
                >
                  {question}
                </button>
              ))}</div>
            </div>
          ) : null}

          <form className="representative-chat-form representative-chat-composer" onSubmit={handleSubmit}>
            <header className="representative-chat-composer-header">
              <span className="representative-chat-composer-recipient">{responder.kind === "human"
                ? t.humanComposerContext
                : responder.kind === "waiting"
                  ? t.waitingComposerContext
                  : t.aiComposerContext}</span>
            </header>
            <div className="representative-chat-composer-body">
              <textarea
                aria-describedby={composerDescription}
                aria-label={t.inputLabel}
                className="dashboard-textarea representative-chat-textarea"
                id="representative-chat-input"
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter"
                    || event.shiftKey
                    || event.nativeEvent.isComposing
                    || hydrating
                    || busy
                  ) return;
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }}
                placeholder={t.placeholder}
                ref={inputRef}
                rows={3}
                value={input}
              />
            </div>
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
                  <button
                    className="button-primary"
                    onClick={(event) => openProfileSection("services", event.currentTarget)}
                    type="button"
                  >
                    {t.openRecharge}
                  </button>
                ) : props.humanInLoop ? (
                  <button
                    className="button-secondary"
                    onClick={(event) => revealProfileRail(event.currentTarget)}
                    type="button"
                  >
                    {t.handoffAction}
                  </button>
                ) : null}
              </div>
            ) : lastFreeReply ? (
              <div className="representative-chat-usage-note" role="status">
                <span>{t.lastFreeReplyDetail}</span>
                <button onClick={(event) => openProfileSection("services", event.currentTarget)} type="button">
                  {t.previewServices}
                </button>
              </div>
            ) : null}
            <footer className="dashboard-form-footer representative-chat-composer-actions">
              <div className="button-row">
                <button
                  aria-label={hydrating ? t.loadingHistory : busy ? t.sending : t.sendMessageAction}
                  className="button-primary representative-chat-send"
                  disabled={busy || hydrating || !input.trim()}
                  type="submit"
                >
                  <span>{hydrating ? t.loadingHistory : busy ? t.sending : t.send}</span>
                  <span aria-hidden="true">&#8593;</span>
                </button>
              </div>
            </footer>
          </form>
          {error && !serviceGateCoversError ? <p className="feedback-error" role="alert">{error}</p> : null}
        </div>

        <button
          aria-label={t.closeProfilePanel}
          className={`representative-profile-rail-backdrop${profileRailOpen ? " is-open" : ""}`}
          onClick={() => setProfileRailVisibility(false)}
          tabIndex={profileRailOpen ? 0 : -1}
          type="button"
        />
        <aside
          aria-label={t.profilePanelLabel}
          aria-modal={profileRailCompact ? true : undefined}
          className={`representative-session-sidebar representative-profile-rail${profileRailOpen ? " is-open" : " is-collapsed"}`}
          id="representative-profile-rail"
          ref={profileRailRef}
          role={profileRailCompact ? "dialog" : undefined}
          tabIndex={profileRailCompact ? -1 : undefined}
        >
          <header className="representative-profile-rail-header">
            <strong>{t.profilePanelLabel}</strong>
            <button
              aria-label={t.closeProfilePanel}
              onClick={() => setProfileRailVisibility(false)}
              ref={profileRailCloseRef}
              type="button"
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>
          <details className="representative-session-panel representative-session-details" open>
            <summary>
              <span>{t.sessionLabel}</span>
              <small>{allowancePresentation}</small>
            </summary>
            <div className="representative-session-panel-body">
              <div className="representative-session-row">
                <span>{accessPresentation.label}</span>
                {accessPresentation.value ? <strong>{accessPresentation.value}</strong> : null}
              </div>
              <div className="representative-session-row is-purchased-credits">
                <span>{t.purchasedServiceCreditsLabel}</span>
                <strong>{t.purchasedServiceCredits(
                  remainingPurchasedCredits,
                  totalCredits,
                )}</strong>
              </div>
              {props.hasPublicCommerce ? (
                <div className="representative-session-actions">
                  <button
                    className="button-secondary"
                    onClick={(event) => openProfileSection("services", event.currentTarget)}
                    type="button"
                  >
                    {t.openServices}
                  </button>
                </div>
              ) : null}
              {sessionSummary ? (
                <p className="representative-session-summary">
                  {sessionSummary}
                </p>
              ) : null}
            </div>
          </details>
          {props.profilePanel}
        </aside>
      </div>
    </section>
  );
}

function getVisitorMessageStatus(status: string | undefined, locale: "zh" | "en") {
  if (!status || ["sent", "completed"].includes(status)) return null;
  const labels = locale === "zh"
    ? { accepted: "已发送", queued: "已发送", waiting_human: "等待真人", failed: "发送失败" }
    : { accepted: "Sent", queued: "Sent", waiting_human: "Waiting for a human", failed: "Failed" };
  return labels[status as keyof typeof labels] ?? null;
}

function resolveResponderPresentation(input: {
  busy: boolean;
  conversationState: string;
  humanActive: boolean;
  hydrating: boolean;
  locale: "zh" | "en";
}) {
  const zh = input.locale === "zh";
  const state = input.conversationState.trim().toLowerCase();
  if (input.hydrating) {
    return { kind: "loading", label: zh ? "正在连接会话" : "Connecting" };
  }
  if (input.humanActive || state === "human_active") {
    return { kind: "human", label: zh ? "真人正在接待" : "Human is responding" };
  }
  if (["needs_human", "waiting_human"].includes(state)) {
    return { kind: "waiting", label: zh ? "等待真人接入" : "Waiting for a human" };
  }
  if (state === "unavailable") {
    return { kind: "offline", label: zh ? "连接暂时中断" : "Connection interrupted" };
  }
  if (input.busy) {
    return { kind: "ai", label: zh ? "AI 正在回复" : "AI is replying" };
  }
  if (state === "failed") {
    return { kind: "error", label: zh ? "上次回复失败" : "Last reply failed" };
  }
  return { kind: "ai", label: zh ? "AI 正在接待" : "AI is responding" };
}

function getAvatarInitials(value: string) {
  const normalized = value.trim();
  if (!normalized) return "D";
  const words = normalized.split(/\s+/u).filter(Boolean);
  if (words.length > 1) {
    return words.slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase();
  }
  return Array.from(normalized).slice(0, 2).join("").toUpperCase();
}

function formatMessageTime(
  value: string | undefined,
  locale: "zh" | "en",
  fallback: string,
) {
  if (!value) return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return fallback;
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    ...(sameDay ? {} : { day: "numeric" as const, month: "short" as const }),
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function localizeSystemMessage(
  text: string,
  senderType: ChatMessage["senderType"],
  locale: "zh" | "en",
) {
  if (senderType !== "system") return text;

  const operatorJoined = /^Human operator (.+) joined the conversation\.$/u.exec(text);
  if (operatorJoined) {
    return locale === "zh"
      ? `真人接待 ${operatorJoined[1]} 已加入会话。`
      : text;
  }

  if (text === "The human operator returned this conversation to the digital representative.") {
    return locale === "zh"
      ? "真人已结束接待，数字代表将继续回复。"
      : text;
  }

  return text;
}

function formatMessageDateTime(
  value: string | undefined,
  locale: "zh" | "en",
) {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

async function copyTextToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Some embedded browsers expose Clipboard but reject writes. Continue
      // through the explicit selection fallback before reporting failure.
    }
  }

  const fallback = document.createElement("textarea");
  fallback.value = value;
  fallback.setAttribute("readonly", "");
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  document.body.appendChild(fallback);
  fallback.select();
  const copied = document.execCommand("copy");
  fallback.remove();
  if (!copied) throw new Error("copy_failed");
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 16 16" width="14">
      <rect height="9" rx="1.5" stroke="currentColor" width="9" x="5.5" y="5.5" />
      <path d="M3 10.5H2.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1V3" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

function ProfilePanelIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 20 20" width="18">
      <rect height="15" rx="2" stroke="currentColor" width="16" x="2" y="2.5" />
      <path d="M12.5 2.5v15" stroke="currentColor" />
      <path d="M14.75 7h1.75M14.75 10h1.75M14.75 13h1.75" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
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
  digitalRepresentativeLabel: "数字代表",
  aiStatus: "AI 正在接待", humanStatus: "真人正在接待",
  youLabel: "你", systemLabel: "系统", taskUpdateLabel: "任务进展",
  justNow: "刚刚", copyAction: "复制", copiedAction: "已复制",
  copyMessageAction: (senderName: string) => `复制 ${senderName} 的消息`,
  copyFailedAction: "复制失败，请重试",
  visitorAvatarLabel: "你的头像",
  aiAvatarLabel: (name: string) => `${name} 的数字代表头像`,
  humanAvatarLabel: (name: string) => `${name} 的真人头像`,
  aiAvatarBadgeLabel: "AI 数字代表",
  generalModelSourceDisclosure: "来源说明：本回答未引用已授权知识或记忆。",
  artifactsLabel: "任务结果", downloadArtifact: "下载",
  faqSuggestionsLabel: "你可以这样问我",
  inputLabel: "输入对话内容", placeholder: "描述你的问题、背景和期望结果…",
  aiComposerContext: "发送给数字代表", humanComposerContext: "发送给当前接待人员", waitingComposerContext: "等待真人回复，可继续补充",
  sendMessageAction: "发送消息",
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
  sending: "正在处理…", send: "发送", thinking: (governedContextEnabled: boolean) => governedContextEnabled ? "正在结合已发布知识与允许使用的上下文整理回复…" : "正在结合已发布知识整理回复…", loadingHistory: "恢复会话中…", errorGeneric: "聊天请求失败，请稍后再试。", memoryPolicyChanged: "记忆策略刚刚更新。请阅读新的记忆说明后重新发送；上一条内容尚未提交。", serviceCreditPending: "服务额度正在处理中，请稍后重试；你的问题已保留在输入框中。", serviceCreditRequired: "免费回复已用完。请购买当前数字代表的服务额度后再发送；你的问题已保留在输入框中。", serviceCreditUnavailableWithHandoff: "免费回复已用完，当前数字代表暂无可购买的服务方案；可申请真人协助。你的问题已保留在输入框中。", serviceCreditUnavailable: "免费回复已用完，当前数字代表暂无可购买的服务方案。你的问题已保留在输入框中。", replyTimeout: "回复处理超时，请重新发送；已发送的内容仍保留在本次会话中。",
  humanQueueNotice: "已进入人工处理队列。你可以继续补充信息，负责人员会看到完整上下文。",
  sessionLabel: "服务和订单",
  purchasedServiceCreditsLabel: "已购服务额度",
  profilePanelLabel: "代表资料与本次会话",
  showProfilePanel: "显示资料",
  hideProfilePanel: "隐藏资料",
  closeProfilePanel: "关闭代表资料",
  unlimitedFreeAccess: "永久免费",
  unlimitedAccessValue: "不限",
  unlimitedRemaining: "剩余额度 不限",
  creditsOnlyAccess: "使用服务额度",
  freeAllowanceLabel: "免费剩余额度",
  allowanceValue: (remaining: number, limit: number) => `${remaining}/${limit}`,
  trialAccess: (remaining: number, limit: number) => `免费剩余额度 ${remaining}/${limit}`,
  remainingAllowance: (remaining: number, total: number) => `剩余额度 ${remaining}/${total}`,
  purchasedServiceCredits: (remaining: number, total: number) => `${remaining}/${total}`,
  openServices: "查看服务与订单",
  humanActiveDetail: "真人已经接手，你仍可以继续补充背景和要求。",
  connectionInterruptedDetail: "会话状态暂时无法确认，请稍后刷新重试。",
  failedReplyDetail: "上一条回复未完成。你的对话仍然保留，可以重新发送或继续补充。",
  handoffAction: "了解转接方式",
  servicesEyebrow: "服务选项", servicesOptionalTitle: "需要时再升级", servicesNeededTitle: (humanInLoop: boolean) => humanInLoop ? "继续对话或申请人工" : "继续对话需要服务额度",
  creditPlanDetail: (available: number, reserved: number) => `当前还有 ${available} 个可用服务额度${reserved > 0 ? `，${reserved} 个正在处理中` : ""}；每次付费继续会先预留，再按实际完成结算。`,
  commerceUnavailableDetail: (humanInLoop: boolean) => humanInLoop ? "当前没有可购买的服务套餐；你仍可在对话中了解人工接管方式。" : "当前没有可购买的服务套餐。",
  openRecharge: "查看服务套餐",
  freeServiceTitle: "当前对话永久免费",
  freeServiceDetail: "不会销售继续对话所需的服务套餐；你可以直接使用数字代表。",
  welcome: (name: string, governedContextEnabled: boolean) =>
    governedContextEnabled
      ? `你好，我是 ${name}，你可以直接告诉我想了解什么。我会以已发布资料为基础，并可能使用仅限你与当前代表的受治理历史摘要；需要本人判断时，我会说明并帮你转交。`
      : `你好，我是 ${name}，你可以直接告诉我想了解什么。我会根据已发布的公开资料回答；遇到需要本人判断的事情，我会说明并帮你转交。`,
};

const enCopy = {
  digitalRepresentativeLabel: "Digital representative",
  aiStatus: "AI is responding", humanStatus: "Human is responding",
  youLabel: "You", systemLabel: "System", taskUpdateLabel: "Task update",
  justNow: "Just now", copyAction: "Copy", copiedAction: "Copied",
  copyMessageAction: (senderName: string) => `Copy ${senderName}'s message`,
  copyFailedAction: "Copy failed. Try again",
  visitorAvatarLabel: "Your avatar",
  aiAvatarLabel: (name: string) => `${name}'s digital representative avatar`,
  humanAvatarLabel: (name: string) => `${name}'s human avatar`,
  aiAvatarBadgeLabel: "AI digital representative",
  generalModelSourceDisclosure: "Source note: This answer did not cite authorized knowledge or memory.",
  artifactsLabel: "Task results", downloadArtifact: "Download",
  faqSuggestionsLabel: "You can ask me",
  inputLabel: "Conversation message", placeholder: "Describe the problem, context, and outcome you want…",
  aiComposerContext: "Send to the digital representative", humanComposerContext: "Send to the current operator", waitingComposerContext: "Waiting for a human reply; you can keep adding details",
  sendMessageAction: "Send message",
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
  sending: "Working…", send: "Send", thinking: (governedContextEnabled: boolean) => governedContextEnabled ? "Reviewing published knowledge and permitted context…" : "Reviewing published knowledge and preparing a reply…", loadingHistory: "Restoring conversation…", errorGeneric: "The chat request failed. Please try again shortly.", memoryPolicyChanged: "The memory policy just changed. Review the updated memory notice and send again; your previous message was not submitted.", serviceCreditPending: "Service credits are still being processed. Try again shortly; your message remains in the composer.", serviceCreditRequired: "Your free replies are used up. Buy service credits for this representative, then send again. Your message remains in the composer.", serviceCreditUnavailableWithHandoff: "Your free replies are used up, and this representative has no purchasable service plan right now. Request human help instead. Your message remains in the composer.", serviceCreditUnavailable: "Your free replies are used up, and this representative has no purchasable service plan right now. Your message remains in the composer.", replyTimeout: "The reply took too long. Please send it again; your message is still saved in this conversation.",
  humanQueueNotice: "This conversation is now in the human queue. You can keep adding context while the operator reviews the full thread.",
  sessionLabel: "Services and orders",
  purchasedServiceCreditsLabel: "Purchased service credits",
  profilePanelLabel: "Profile and this conversation",
  showProfilePanel: "Show profile",
  hideProfilePanel: "Hide profile",
  closeProfilePanel: "Close profile",
  unlimitedFreeAccess: "Always free",
  unlimitedAccessValue: "Unlimited",
  unlimitedRemaining: "Unlimited remaining",
  creditsOnlyAccess: "Uses service credits",
  freeAllowanceLabel: "Free allowance remaining",
  allowanceValue: (remaining: number, limit: number) => `${remaining}/${limit}`,
  trialAccess: (remaining: number, limit: number) => `${remaining}/${limit} free allowance remaining`,
  remainingAllowance: (remaining: number, total: number) => `${remaining}/${total} remaining`,
  purchasedServiceCredits: (remaining: number, total: number) => `${remaining}/${total}`,
  openServices: "View services and orders",
  humanActiveDetail: "A human has taken over. You can keep adding context and requirements.",
  connectionInterruptedDetail: "The conversation state cannot be confirmed right now. Refresh and try again shortly.",
  failedReplyDetail: "The last reply did not complete. Your conversation is still saved, so you can retry or add context.",
  handoffAction: "How handoff works",
  servicesEyebrow: "Service options", servicesOptionalTitle: "Upgrade only when needed", servicesNeededTitle: (humanInLoop: boolean) => humanInLoop ? "Continue or request human help" : "Service credits are required to continue",
  creditPlanDetail: (available: number, reserved: number) => `${available} service credits remain${reserved > 0 ? `, with ${reserved} currently reserved` : ""}. Paid continuation reserves first and settles only after completion.`,
  commerceUnavailableDetail: (humanInLoop: boolean) => humanInLoop ? "No service package is currently available. You can still ask how human takeover works in the conversation." : "No service package is currently available.",
  openRecharge: "View service packages",
  freeServiceTitle: "This conversation is always free",
  freeServiceDetail: "No service package is sold to keep chatting; use the digital representative directly.",
  welcome: (name: string, governedContextEnabled: boolean) =>
    governedContextEnabled
      ? `Hi, I’m ${name}. Tell me what you want to understand. I use published information and may use governed history scoped only to you and this representative; I will offer a handoff when the owner needs to decide.`
      : `Hi, I’m ${name}. Tell me what you want to understand. I answer from published public information and will clearly offer a handoff when the owner needs to decide.`,
};

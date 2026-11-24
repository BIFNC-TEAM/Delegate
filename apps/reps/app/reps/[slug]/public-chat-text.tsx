"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import { delegateMarkdown } from "@delegate/model-runtime/markdown";
import { citationRangePlugin, type CitationTextRange } from "./citation-markdown";

type Source = { title: string; domain?: string; url?: string };
type Card = { rangeId: string; request: number; left: number; top: number; anchorLeft: number; anchorBottom: number; state: "loading" | "available" | "unavailable"; sources: Source[] };
type CitationInteraction = { messageId?: string | undefined; locale: "zh" | "en"; activeRange?: string | undefined; open: (id: string, target: HTMLButtonElement) => Promise<void> };
const CitationContext = createContext<CitationInteraction | null>(null);
function CitationSpan({ node, children, ...props }: ComponentProps<"span"> & ExtraProps) {
  const interaction = useContext(CitationContext);
  const id = node?.properties["data-citation-range"] ?? node?.properties.dataCitationRange;
  return typeof id === "string" && interaction ? <button type="button" className="representative-citation-text"
    aria-label={interaction.locale === "zh" ? "查看来源" : "View sources"} data-citation-range={id} aria-haspopup="dialog"
    aria-controls={`citation-${interaction.messageId}-${id}`} aria-expanded={interaction.activeRange === id}
    onClick={event => { event.stopPropagation(); void interaction.open(id, event.currentTarget); }}>{children}</button> : <span {...props}>{children}</span>;
}
export function PublicChatText({ text, ranges, messageId, representativeSlug, locale = "zh" }: {
  text: string; ranges?: CitationTextRange[] | undefined; messageId?: string; representativeSlug?: string; locale?: "zh" | "en";
}) {
  const [card, setCard] = useState<Card | null>(null);
  const request = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const close = (restoreFocus = true) => { abort.current?.abort(); request.current++; setCard(null); if (restoreFocus) opener.current?.focus({ preventScroll: true }); };
  useEffect(() => () => { abort.current?.abort(); request.current++; }, []);
  useEffect(() => {
    abort.current?.abort(); request.current++; setCard(null);
  }, [messageId, text]);
  useEffect(() => {
    if (!card) return;
    popup.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !popup.current?.contains(event.target) && !opener.current?.contains(event.target)) close(false); };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      const anchor = opener.current;
      const rect = anchor?.getBoundingClientRect();
      // A scroll queued by bringing the button into view can arrive after
      // opening. Close only when the anchor actually moves, not for that stale
      // notification or for scrolling inside the source card.
      if (event.type === "resize" || !anchor?.isConnected || !rect
        || Math.abs(rect.left - card.anchorLeft) > 0.5 || Math.abs(rect.bottom - card.anchorBottom) > 0.5) close(false);
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", scroll);
    window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("keydown", escape); document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", scroll); window.removeEventListener("scroll", scroll, true); };
  }, [card?.request]);
  async function open(rangeId: string, target: HTMLButtonElement) {
    if (!messageId || !representativeSlug) return;
    abort.current?.abort(); abort.current = new AbortController();
    opener.current = target;
    const sequence = ++request.current;
    const rect = target.getBoundingClientRect();
    setCard({ rangeId, request: sequence, left: Math.max(16, Math.min(rect.left, window.innerWidth - 316)),
      top: Math.max(16, Math.min(rect.bottom + 8, window.innerHeight - 220)), anchorLeft: rect.left, anchorBottom: rect.bottom, state: "loading", sources: [] });
    try {
      const response = await fetch(`/reps/${encodeURIComponent(representativeSlug)}/chat/citation-sources`, {
        method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, rangeId }), signal: abort.current.signal,
      });
      const result = await response.json() as { status?: string; sources?: Source[] };
      if (sequence !== request.current) return;
      const available = response.ok && result.status === "available" && Array.isArray(result.sources) && result.sources.length > 0 && result.sources.every(source => typeof source.title === "string");
      setCard(current => current?.request === sequence ? { ...current, state: available ? "available" : "unavailable", sources: available ? result.sources! : [] } : current);
    } catch {
      if (sequence === request.current) setCard(current => current?.request === sequence ? { ...current, state: "unavailable", sources: [] } : current);
    }
  }
  let end = 0;
  const valid = (ranges ?? []).every(range => typeof range.id === "string" && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
    && range.start >= end && range.end > range.start && range.end <= text.length && (end = range.end) > 0);
  const visibleRanges = valid && messageId && representativeSlug ? ranges ?? [] : [];
  // Stable renderer identities keep citation buttons mounted while the card
  // changes. Remounting table/text renderers moves the scroll anchor and loses
  // the opener used for keyboard focus restoration.
  const components = useMemo<Components>(() => ({
    a: ({ children }) => <span>{children}</span>,
    img: ({ alt }) => <span className="representative-chat-image-description">{alt || (locale === "zh" ? "图片" : "Image")}</span>,
    input: ({ checked, type }) => type === "checkbox" ? <input type="checkbox" checked={Boolean(checked)} disabled readOnly tabIndex={-1} aria-label={locale === "zh" ? "只读任务状态" : "Read-only task status"} /> : null,
    table: ({ children }) => <div className="representative-chat-table"><table>{children}</table></div>,
    span: CitationSpan,
  }), [locale]);
  return <CitationContext.Provider value={{ messageId, locale, activeRange: card?.rangeId, open }}><div className="representative-chat-rich-text">
    <ReactMarkdown skipHtml remarkPlugins={[delegateMarkdown, [citationRangePlugin, { text, ranges: visibleRanges }]]}
      components={components}>{text}</ReactMarkdown>
    {card && typeof document !== "undefined" ? createPortal(<div ref={popup} tabIndex={-1} id={`citation-${messageId}-${card.rangeId}`} className="representative-citation-card" role="dialog"
      aria-label={locale === "zh" ? "引用来源" : "Citation sources"} style={{ left: card.left, top: card.top }}>
      <button type="button" className="representative-citation-close" onClick={() => close()} aria-label={locale === "zh" ? "关闭来源" : "Close sources"}>×</button>
      <div aria-live="polite">{card.state === "loading" ? (locale === "zh" ? "正在核验来源…" : "Checking sources…")
        : card.state === "unavailable" ? (locale === "zh" ? "来源已不可用" : "Source unavailable")
          : <ul>{card.sources.map((source, index) => <li key={index}>{source.title}</li>)}</ul>}</div>
    </div>, document.body) : null}
  </div></CitationContext.Provider>;
}

"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import type {
  ConversationDetailSnapshot,
  ConversationInboxSnapshot,
} from "@delegate/web-data";
import type { Locale } from "@delegate/web-ui";

export function DashboardInbox({
  activeSlug,
  initialDetail,
  initialSnapshot,
  locale,
}: {
  activeSlug: string;
  initialDetail: ConversationDetailSnapshot | null;
  initialSnapshot: ConversationInboxSnapshot;
  locale: Locale;
}) {
  const zh = locale === "zh";
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [detail, setDetail] = useState(initialDetail);
  const [selectedId, setSelectedId] = useState(initialDetail?.id || initialSnapshot.conversations[0]?.id || "");
  const [query, setQuery] = useState("");
  const [workspaceTab, setWorkspaceTab] = useState<"conversations" | "pending" | "leads">("conversations");
  const [filter, setFilter] = useState<"all" | "unread" | "needs_human" | "human_active">("all");
  const [replyText, setReplyText] = useState("");
  const [noteText, setNoteText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return snapshot.conversations.filter((conversation) => {
      if (filter === "unread" && conversation.unreadCount === 0) return false;
      if (filter === "needs_human" && conversation.episodeState !== "needs_human") return false;
      if (filter === "human_active" && conversation.episodeState !== "human_active") return false;
      if (!normalized) return true;
      return `${conversation.contactName} ${conversation.contactHandle || ""} ${conversation.lastMessage}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [filter, query, snapshot.conversations]);

  useEffect(() => {
    const source = new EventSource(
      `/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/conversations/events`,
    );
    let cancelled = false;
    const updateSnapshot = async (event: Event) => {
      try {
        setSnapshot(JSON.parse((event as MessageEvent<string>).data) as ConversationInboxSnapshot);
        if (selectedId) {
          const response = await fetch(
            `/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/conversations/${encodeURIComponent(selectedId)}`,
          );
          const payload = (await response.json()) as ConversationDetailSnapshot & { error?: string };
          if (!cancelled && response.ok && payload.id === selectedId) setDetail(payload);
        }
      } catch {
        // Ignore a malformed event; EventSource will keep the stream alive.
      }
    };
    source.addEventListener("snapshot", updateSnapshot);
    return () => {
      cancelled = true;
      source.close();
    };
  }, [activeSlug, selectedId]);

  async function refreshWorkspace(conversationId = detail?.id) {
    const inboxUrl = `/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/conversations`;
    const [inboxResponse, detailResponse] = await Promise.all([
      fetch(inboxUrl),
      conversationId
        ? fetch(`${inboxUrl}/${encodeURIComponent(conversationId)}`)
        : Promise.resolve(null),
    ]);
    const nextSnapshot = (await inboxResponse.json()) as ConversationInboxSnapshot & { error?: string };
    if (!inboxResponse.ok) throw new Error(nextSnapshot.error || "Failed to refresh inbox.");
    setSnapshot(nextSnapshot);
    if (detailResponse) {
      const nextDetail = (await detailResponse.json()) as ConversationDetailSnapshot & { error?: string };
      if (!detailResponse.ok) throw new Error(nextDetail.error || "Failed to refresh conversation.");
      setDetail(nextDetail);
    }
  }

  function selectConversation(conversationId: string) {
    setSelectedId(conversationId);
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(
        `/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/conversations/${encodeURIComponent(conversationId)}`,
        );
        const payload = (await response.json()) as ConversationDetailSnapshot & { error?: string };
        if (!response.ok) throw new Error(payload.error || "Failed to load conversation.");
        setDetail(payload);
        await fetch(
          `/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/conversations/${encodeURIComponent(conversationId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "mark_read" }),
          },
        );
        setSnapshot((current) => ({
          ...current,
          conversations: current.conversations.map((conversation) =>
            conversation.id === conversationId ? { ...conversation, unreadCount: 0 } : conversation,
          ),
        }));
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to load conversation.");
      }
    });
  }

  function updateControl(action: "assign" | "return_to_ai") {
    if (!detail) return;
    setError(null);

    if (detail.id.startsWith("demo-")) {
      const nextAssigned = action === "assign";
      if (nextAssigned) {
        setDetail({
          ...detail,
          state: "human_active",
          ...(detail.episode
            ? { episode: { ...detail.episode, status: "human_active" } }
            : {}),
          assignment: { operatorId: "demo-operator", operatorName: "Neo" },
        });
      } else {
        const { assignment: _assignment, ...detailWithoutAssignment } = detail;
        setDetail({
          ...detailWithoutAssignment,
          state: "active",
          ...(detail.episode
            ? { episode: { ...detail.episode, status: "active" } }
            : {}),
        });
      }
      setSnapshot((current) => ({
        ...current,
        conversations: current.conversations.map((conversation) => {
          if (conversation.id !== detail.id) return conversation;
          if (nextAssigned) {
            return {
              ...conversation,
              state: "human_active",
              episodeState: "human_active",
              needsHuman: true,
              assignedOperatorName: "Neo",
            };
          }
          const { assignedOperatorName: _operatorName, ...conversationWithoutOperator } = conversation;
          return {
            ...conversationWithoutOperator,
            state: "active",
            episodeState: "active",
            needsHuman: false,
          };
        }),
      }));
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch(
        `/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/conversations/${encodeURIComponent(detail.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
        );
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(payload.error || "Failed to update conversation.");
        await refreshWorkspace(detail.id);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to update conversation.");
      }
    });
  }

  function submitConversationContent(kind: "reply" | "note") {
    if (!detail) return;
    const text = (kind === "reply" ? replyText : noteText).trim();
    if (!text) return;
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/conversations/${encodeURIComponent(detail.id)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind,
              text,
              clientMessageId: kind === "reply" ? `operator-${Date.now()}` : undefined,
            }),
          },
        );
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(payload.error || "Failed to save conversation update.");
        if (kind === "reply") setReplyText("");
        else setNoteText("");
        await refreshWorkspace(detail.id);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to save conversation update.");
      }
    });
  }

  function updateResolution(resolved: boolean) {
    if (!detail) return;
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/conversations/${encodeURIComponent(detail.id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: resolved ? "resolve" : "reopen" }),
          },
        );
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(payload.error || "Failed to update conversation.");
        await refreshWorkspace(detail.id);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to update conversation.");
      }
    });
  }

  return (
    <>
      <header className="dashboard-v2-page-header inbox-page-header">
        <div>
          <p>INBOX / 03</p>
          <h1>{zh ? "把 AI 会话和人工接手放进同一条处理队列。" : "Run AI conversations and human handoff from one queue."}</h1>
          <span>{zh ? "先判断谁需要介入，再查看完整上下文、知识引用和当前控制权。" : "Triage who needs attention, then inspect context, citations, and current control."}</span>
        </div>
        <div className="dashboard-v2-page-actions">
          <button className="dashboard-v2-button-secondary" onClick={() => window.location.reload()} type="button">↻ {zh ? "刷新" : "Refresh"}</button>
        </div>
      </header>

      <section className="dashboard-v2-metric-grid inbox-metrics">
        <InboxMetric label={zh ? "未读消息" : "Unread"} value={snapshot.metrics.unread} tone="teal" />
        <InboxMetric label={zh ? "建议人工接手" : "Needs human"} value={snapshot.metrics.needsHuman} tone="warning" />
        <InboxMetric label={zh ? "人工处理中" : "Human active"} value={snapshot.metrics.humanActive} tone="indigo" />
        <InboxMetric label={zh ? "生成失败" : "Failed runs"} value={snapshot.metrics.failed} />
        <InboxMetric label={zh ? "待处理" : "Pending"} value={snapshot.metrics.pending} tone="warning" />
        <InboxMetric label={zh ? "活跃线索" : "Active leads"} value={snapshot.metrics.activeLeads} tone="teal" />
      </section>

      {error ? <div className="inbox-error" role="alert">{error}</div> : null}

      <nav className="inbox-workspace-tabs" aria-label={zh ? "会话与线索视图" : "Conversation workspace views"}>
        <button className={workspaceTab === "conversations" ? "is-active" : undefined} onClick={() => setWorkspaceTab("conversations")} type="button">{zh ? "会话" : "Conversations"}<span>{snapshot.conversations.length}</span></button>
        <button className={workspaceTab === "pending" ? "is-active" : undefined} onClick={() => setWorkspaceTab("pending")} type="button">{zh ? "待处理" : "Pending"}<span>{snapshot.pending.length}</span></button>
        <button className={workspaceTab === "leads" ? "is-active" : undefined} onClick={() => setWorkspaceTab("leads")} type="button">{zh ? "线索" : "Leads"}<span>{snapshot.leads.length}</span></button>
      </nav>

      <section className="inbox-shell" aria-busy={isPending}>
        <aside className="inbox-list-panel">
          <div className="inbox-toolbar">
            <label>
              <span>⌕</span>
              <input
                aria-label={zh ? "搜索会话" : "Search conversations"}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={zh ? "搜索联系人或消息" : "Search contact or message"}
                value={query}
              />
            </label>
            <select
              aria-label={zh ? "筛选会话" : "Filter conversations"}
              onChange={(event) => setFilter(event.target.value as typeof filter)}
              value={filter}
            >
              <option value="all">{zh ? "全部会话" : "All conversations"}</option>
              <option value="unread">{zh ? "未读" : "Unread"}</option>
              <option value="needs_human">{zh ? "待人工" : "Needs human"}</option>
              <option value="human_active">{zh ? "人工处理中" : "Human active"}</option>
            </select>
          </div>

          <div className="inbox-conversation-list">
            {workspaceTab === "conversations" && filtered.length ? filtered.map((conversation) => (
              <button
                className={conversation.id === selectedId ? "is-active" : undefined}
                disabled={isPending}
                key={conversation.id}
                onClick={() => selectConversation(conversation.id)}
                type="button"
              >
                <span className="inbox-contact-avatar">{conversation.contactName.slice(0, 1).toUpperCase()}</span>
                <span className="inbox-conversation-copy">
                  <span>
                    <strong>{conversation.contactName}</strong>
                    <time>{formatRelativeTime(conversation.lastMessageAt, locale)}</time>
                  </span>
                  <small>{conversation.lastMessage}</small>
                  <span className="inbox-conversation-meta">
                    <em className={`is-${conversation.channel}`}>{conversation.channel}</em>
                    <em className={`is-${conversation.episodeState}`}>{formatEpisodeState(conversation.episodeState, locale)}</em>
                    {conversation.isPaid ? <b>{zh ? "已付费" : "Paid"}</b> : null}
                  </span>
                </span>
                {conversation.unreadCount > 0 ? <i>{conversation.unreadCount}</i> : null}
              </button>
            )) : workspaceTab === "pending" && snapshot.pending.length ? snapshot.pending.map((item) => (
              <button className={item.conversationId === selectedId ? "is-active" : undefined} disabled={!item.conversationId || isPending} key={item.id} onClick={() => item.conversationId && selectConversation(item.conversationId)} type="button">
                <span className="inbox-contact-avatar">!</span>
                <span className="inbox-conversation-copy"><span><strong>{item.contactName}</strong><time>P{item.priority}</time></span><small>{item.summary}</small><span className="inbox-conversation-meta"><em className="is-needs_human">{item.status}</em><b>{item.reason}</b></span></span>
              </button>
            )) : workspaceTab === "leads" && snapshot.leads.length ? snapshot.leads.map((item) => (
              <button className={item.conversationId === selectedId ? "is-active" : undefined} disabled={!item.conversationId || isPending} key={item.id} onClick={() => item.conversationId && selectConversation(item.conversationId)} type="button">
                <span className="inbox-contact-avatar">{item.contactName.slice(0, 1).toUpperCase()}</span>
                <span className="inbox-conversation-copy"><span><strong>{item.contactName}</strong><time>P{item.priority}</time></span><small>{item.title}</small><span className="inbox-conversation-meta"><em className="is-active">{item.status}</em><b>{item.kind}</b></span></span>
              </button>
            )) : (
              <div className="inbox-empty-list"><span>⌕</span><strong>{zh ? "没有匹配的会话" : "No matching conversations"}</strong><small>{zh ? "调整搜索词或筛选条件。" : "Adjust the query or filter."}</small></div>
            )}
          </div>
        </aside>

        <main className="inbox-thread-panel">
          {detail ? (
            <>
              <header className="inbox-thread-header">
                <div>
                  <span className="inbox-contact-avatar">{detail.contact.displayName.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <strong>{detail.contact.displayName}</strong>
                    <small>{detail.channel} · {detail.contact.role} · {detail.contact.stage}</small>
                  </div>
                </div>
                <div className="inbox-control-actions">
                  {detail.episode?.status === "resolved" ? (
                    <button disabled={isPending} onClick={() => updateResolution(false)} type="button">{zh ? "重新打开" : "Reopen"}</button>
                  ) : (
                    <button disabled={isPending} onClick={() => updateResolution(true)} type="button">{zh ? "解决" : "Resolve"}</button>
                  )}
                  {detail.assignment ? (
                    <>
                      <span>{zh ? `人工：${detail.assignment.operatorName}` : `Human: ${detail.assignment.operatorName}`}</span>
                      <button disabled={isPending} onClick={() => updateControl("return_to_ai")} type="button">{zh ? "归还 AI" : "Return to AI"}</button>
                    </>
                  ) : (
                    <button className="is-primary" disabled={isPending} onClick={() => updateControl("assign")} type="button">{zh ? "人工接管" : "Take over"}</button>
                  )}
                </div>
              </header>

              <div className="inbox-context-strip">
                <span><small>{zh ? "当前控制" : "Control"}</small><strong>{detail.assignment ? (zh ? "人工" : "Human") : "AI"}</strong></span>
                <span><small>Episode</small><strong>#{detail.episode?.sequence || 1}</strong></span>
                <span><small>{zh ? "代表版本" : "Rep version"}</small><strong>v{detail.episode?.representativeVersion || "—"}</strong></span>
                <span><small>{zh ? "付费状态" : "Payment"}</small><strong>{detail.contact.isPaid ? (zh ? "已付费" : "Paid") : (zh ? "免费" : "Free")}</strong></span>
              </div>

              <div className="inbox-message-timeline">
                {detail.messages.map((message) => (
                  <article className={`is-${message.senderType}`} key={message.id}>
                    <div className="inbox-message-author">
                      <span>{senderLabel(message.senderType, message.senderDisplayName, locale)}</span>
                      <time>{formatMessageTime(message.createdAt, locale)}</time>
                    </div>
                    <p>{message.text}</p>
                    {message.citations.length ? (
                      <div className="inbox-citations">
                        <small>{zh ? "引用知识" : "Knowledge used"}</small>
                        {message.citations.map((citation) => (
                          <span key={`${message.id}:${citation.title}`}><strong>{citation.title}</strong>{citation.excerpt ? <em>{citation.excerpt}</em> : null}</span>
                        ))}
                      </div>
                    ) : null}
                    <footer>
                      <span>{message.status}</span>
                      {message.editedAt ? <span>{zh ? "已编辑" : "Edited"}</span> : null}
                    </footer>
                  </article>
                ))}
              </div>

              <footer className="inbox-composer">
                <div className="inbox-composer-copy">
                  <strong>{detail.assignment ? (zh ? "以人工身份回复" : "Reply as human") : (zh ? "AI 正在控制该会话" : "AI currently controls this conversation")}</strong>
                  <small>{detail.assignment ? (zh ? "用户会明确看到人工身份。" : "The audience will see an explicit human identity.") : (zh ? "接管后才能发送人工消息。" : "Take over before sending a human reply.")}</small>
                </div>
                <textarea disabled={!detail.assignment || isPending} onChange={(event) => setReplyText(event.target.value)} placeholder={zh ? "输入给访客的回复…" : "Write a reply to the visitor…"} rows={3} value={replyText} />
                <button disabled={!detail.assignment || !replyText.trim() || isPending} onClick={() => submitConversationContent("reply")} type="button">{zh ? "发送回复" : "Send reply"}</button>
              </footer>
            </>
          ) : (
            <div className="inbox-empty-thread"><span>03</span><h2>{zh ? "选择一条会话" : "Select a conversation"}</h2><p>{zh ? "查看消息、知识引用和人工接管状态。" : "Inspect messages, citations, and human control."}</p></div>
          )}
        </main>

        <aside className="inbox-inspector-panel">
          {detail ? (
            <>
              <section>
                <p>{zh ? "联系人" : "Contact"}</p>
                <h3>{detail.contact.displayName}</h3>
                <dl>
                  <div><dt>{zh ? "角色" : "Role"}</dt><dd>{detail.contact.role}</dd></div>
                  <div><dt>{zh ? "阶段" : "Stage"}</dt><dd>{detail.contact.stage}</dd></div>
                  <div><dt>{zh ? "渠道" : "Channel"}</dt><dd>{detail.channel}</dd></div>
                </dl>
              </section>
              <section>
                <p>{zh ? "最近运行" : "Recent runs"}</p>
                <div className="inbox-run-list">
                  {detail.runs.length ? detail.runs.map((run) => (
                    <article key={run.id}><span className={`is-${run.status}`} /><div><strong>{run.status}</strong><small>{run.model || "Model pending"}</small></div></article>
                  )) : <small>{zh ? "暂无生成运行记录" : "No generation runs yet"}</small>}
                </div>
              </section>
              <section>
                <p>{zh ? "内部协作" : "Internal collaboration"}</p>
                <textarea onChange={(event) => setNoteText(event.target.value)} placeholder={zh ? "仅团队可见的备注" : "Team-only note"} rows={3} value={noteText} />
                <button className="inbox-inspector-action" disabled={!noteText.trim() || isPending} onClick={() => submitConversationContent("note")} type="button">＋ {zh ? "保存内部备注" : "Save internal note"}</button>
                {detail.notes.map((note) => <article className="inbox-note" key={note.id}><strong>{note.authorName}</strong><p>{note.text}</p><time>{formatMessageTime(note.createdAt, locale)}</time></article>)}
                <button className="inbox-inspector-action" type="button">✦ {zh ? "生成回复建议" : "Generate reply suggestion"}</button>
              </section>
            </>
          ) : null}
        </aside>
      </section>
    </>
  );
}

function InboxMetric({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "teal" | "warning" | "indigo" }) {
  return <article className={`dashboard-v2-metric-card is-${tone}`}><div><span>{label}</span><i /></div><strong>{String(value).padStart(2, "0")}</strong><p>{value === 0 ? "Queue clear" : "Requires review"}</p></article>;
}

function formatEpisodeState(state: string, locale: Locale) {
  const labels: Record<string, [string, string]> = {
    active: ["AI 处理中", "AI active"], waiting_user: ["等待用户", "Waiting user"], needs_human: ["待人工", "Needs human"], human_active: ["人工处理中", "Human active"], resolved: ["已解决", "Resolved"], archived: ["已归档", "Archived"], failed: ["失败", "Failed"],
  };
  const label = labels[state] || [state, state];
  return locale === "zh" ? label[0] : label[1];
}

function senderLabel(type: string, displayName: string | undefined, locale: Locale) {
  if (displayName) return displayName;
  if (type === "operator") return locale === "zh" ? "人工顾问" : "Human operator";
  if (type === "representative") return locale === "zh" ? "数字代表" : "Digital representative";
  if (type === "system") return locale === "zh" ? "系统" : "System";
  return locale === "zh" ? "访客" : "Visitor";
}

function formatRelativeTime(value: string, locale: Locale) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatMessageTime(value: string, locale: Locale) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

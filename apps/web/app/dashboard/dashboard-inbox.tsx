"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import type {
  ConversationDetailSnapshot,
  ConversationInboxSnapshot,
  DelegationTaskDetailSnapshot,
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
  const [taskDetail, setTaskDetail] = useState<DelegationTaskDetailSnapshot | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskBusy, setTaskBusy] = useState(false);
  const taskRequestRef = useRef(0);
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

  useEffect(() => {
    if (!taskDetail && !taskLoading) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !taskBusy) closeTask();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [taskBusy, taskDetail, taskLoading]);

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
    closeTask();
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

  async function openTask(taskId: string) {
    const requestId = ++taskRequestRef.current;
    setTaskLoading(true);
    setTaskDetail(null);
    setTaskError(null);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/tasks/${encodeURIComponent(taskId)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => ({}))) as DelegationTaskDetailSnapshot & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Failed to load delegation task.");
      if (taskRequestRef.current === requestId) setTaskDetail(payload);
    } catch (caught) {
      if (taskRequestRef.current === requestId) {
        setTaskError(caught instanceof Error ? caught.message : "Failed to load delegation task.");
      }
    } finally {
      if (taskRequestRef.current === requestId) setTaskLoading(false);
    }
  }

  function closeTask() {
    taskRequestRef.current += 1;
    setTaskLoading(false);
    setTaskDetail(null);
    setTaskError(null);
  }

  async function updateTask(action: "cancel" | "retry" | "continue") {
    if (!taskDetail || taskBusy) return;
    if (action === "cancel" && !window.confirm(zh ? "确定取消这个委托任务？审批和审计记录会保留。" : "Cancel this delegated task? Approval and audit evidence will be preserved.")) return;
    setTaskBusy(true);
    setTaskError(null);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/tasks/${encodeURIComponent(taskDetail.task.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as DelegationTaskDetailSnapshot & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Failed to update delegation task.");
      setTaskDetail(payload);
      await refreshWorkspace(detail?.id);
    } catch (caught) {
      setTaskError(caught instanceof Error ? caught.message : "Failed to update delegation task.");
    } finally {
      setTaskBusy(false);
    }
  }

  async function updateExternalEffect(
    effectId: string,
    action: "reconcile" | "retry" | "record_compensation",
    observedOutcome?: "succeeded" | "failed",
  ) {
    if (!taskDetail || taskBusy) return;
    const note = action === "record_compensation"
      ? window.prompt(zh ? "请输入外部补偿已经完成的证据说明：" : "Describe the evidence that external compensation completed:")
      : action === "reconcile"
        ? window.prompt(zh ? "请输入远端对账依据：" : "Enter the remote reconciliation evidence:")
        : null;
    if ((action === "record_compensation" || action === "reconcile") && !note?.trim()) return;
    setTaskBusy(true);
    setTaskError(null);
    try {
      const response = await fetch(
        `/api/dashboard/representatives/${encodeURIComponent(activeSlug)}/tasks/${encodeURIComponent(taskDetail.task.id)}/effects/${encodeURIComponent(effectId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, observedOutcome, ...(note?.trim() ? { note: note.trim() } : {}) }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as DelegationTaskDetailSnapshot & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Failed to update external effect.");
      setTaskDetail(payload);
      await refreshWorkspace(detail?.id);
    } catch (caught) {
      setTaskError(caught instanceof Error ? caught.message : "Failed to update external effect.");
    } finally {
      setTaskBusy(false);
    }
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
      <div className="inbox-page-main" inert={taskDetail || taskLoading ? true : undefined}>
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
                <span className="inbox-contact-avatar">{item.kind === "delegation_task" ? "T" : "!"}</span>
                <span className="inbox-conversation-copy"><span><strong>{item.contactName}</strong><time>P{item.priority}</time></span><small>{item.summary}</small><span className="inbox-conversation-meta"><em className={item.kind === "delegation_task" ? "is-waiting_approval" : "is-needs_human"}>{item.status}</em><b>{item.kind === "delegation_task" ? (zh ? "委托任务" : "Delegated task") : item.reason}</b></span></span>
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
                <p>{zh ? "委托任务" : "Delegated tasks"}</p>
                <div className="inbox-run-list">
                  {detail.tasks.length ? detail.tasks.map((task) => (
                    <button className="inbox-task-link" key={task.id} onClick={() => void openTask(task.id)} title={task.blockingReason} type="button">
                      <span className={`is-${task.status}`} />
                      <div>
                        <strong>{task.title}</strong>
                        <small>{task.status} · {zh ? "下一步" : "next"}: {task.nextActionBy} · {task.outputCount} {zh ? "项产物" : "outputs"}</small>
                      </div>
                      <b>→</b>
                    </button>
                  )) : <small>{zh ? "该会话尚无委托任务" : "No delegated tasks in this conversation"}</small>}
                </div>
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
      </div>

      {(taskDetail || taskLoading) ? (
        <div className="delegation-task-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !taskBusy) closeTask(); }}>
          <aside aria-busy={taskLoading || taskBusy} aria-modal="true" className="delegation-task-drawer" role="dialog">
            {taskLoading && !taskDetail ? (
              <div className="delegation-task-loading">
                <button aria-label={zh ? "关闭任务详情" : "Close task detail"} autoFocus onClick={closeTask} type="button">×</button>
                <span>{zh ? "正在读取任务契约…" : "Loading task contract…"}</span>
              </div>
            ) : null}
            {taskDetail ? (
              <DelegationTaskDrawer
                busy={taskBusy}
                detail={taskDetail}
                error={taskError}
                locale={locale}
                onAction={(action) => void updateTask(action)}
                onEffectAction={(effectId, action, observedOutcome) => void updateExternalEffect(effectId, action, observedOutcome)}
                onClose={closeTask}
              />
            ) : null}
          </aside>
        </div>
      ) : null}
      {!taskDetail && taskError ? <div className="inbox-error" role="alert">{taskError}</div> : null}
    </>
  );
}

function DelegationTaskDrawer({
  busy,
  detail,
  error,
  locale,
  onAction,
  onEffectAction,
  onClose,
}: {
  busy: boolean;
  detail: DelegationTaskDetailSnapshot;
  error: string | null;
  locale: Locale;
  onAction: (action: "cancel" | "retry" | "continue") => void;
  onEffectAction: (effectId: string, action: "reconcile" | "retry" | "record_compensation", observedOutcome?: "succeeded" | "failed") => void;
  onClose: () => void;
}) {
  const zh = locale === "zh";
  const task = detail.task;
  return (
    <>
      <header>
        <div>
          <span>{zh ? "委托任务" : "Delegated task"} · <code>{task.id.slice(-8)}</code></span>
          <h2>{task.title}</h2>
          <p>{task.objective}</p>
        </div>
        <span className={`delegation-task-status is-${task.status}`}>{formatTaskStatus(task.status, locale)}</span>
        <button aria-label={zh ? "关闭任务详情" : "Close task detail"} autoFocus onClick={onClose} type="button">×</button>
      </header>

      <div className="delegation-task-body">
        {error ? <div className="dashboard-approval-alert" role="alert">{error}</div> : null}
        <section className="delegation-task-summary">
          <span>{zh ? "目标结果" : "Desired outcome"}</span>
          <p>{task.desiredOutcome}</p>
          {task.blockingReason ? <p className="delegation-task-blocking"><strong>{zh ? "当前阻塞：" : "Blocked: "}</strong>{task.blockingReason}</p> : null}
        </section>
        <dl className="delegation-task-facts">
          <div><dt>{zh ? "下一责任方" : "Next actor"}</dt><dd>{task.nextActionBy}</dd></div>
          <div><dt>{zh ? "任务版本" : "Task version"}</dt><dd>v{task.version}</dd></div>
          <div><dt>{zh ? "代表版本" : "Rep version"}</dt><dd>{task.representativeVersion ? `v${task.representativeVersion.versionNumber}` : "—"}</dd></div>
          <div><dt>{zh ? "资源消耗" : "Usage"}</dt><dd>{detail.usage.creditsUsed} credits · {detail.usage.costCents} cents</dd></div>
        </dl>

        <TaskSection eyebrow={zh ? "执行计划" : "Execution plan"} title={detail.plan.summary}>
          <div className="delegation-task-steps">
            {detail.plan.steps.map((step) => (
              <article key={step.id}>
                <i>{String(step.sequence).padStart(2, "0")}</i>
                <div><strong>{step.title}</strong><p>{step.kind} · {step.capability || "—"}{step.dependsOnStepIds.length ? ` · ${zh ? `依赖 ${step.dependsOnStepIds.length} 步` : `${step.dependsOnStepIds.length} dependencies`}` : ""}{step.requiresApproval ? ` · ${zh ? "需要审批" : "approval required"}` : ""}</p></div>
                <span className={`is-${step.status}`}>{step.status}</span>
              </article>
            ))}
          </div>
        </TaskSection>

        {detail.plan.policy ? (
          <TaskSection eyebrow={zh ? "资源边界" : "Resource boundary"} title={zh ? "创建任务时捕获，不会被后续策略静默放宽" : "Captured at creation and never silently broadened"}>
            <dl className="delegation-task-policy">
              <div><dt>{zh ? "允许能力" : "Capabilities"}</dt><dd>{detail.plan.policy.allowedCapabilities.join(", ") || "—"}</dd></div>
              <div><dt>{zh ? "最长时间" : "Max duration"}</dt><dd>{detail.plan.policy.maxDurationMinutes} min</dd></div>
              <div><dt>{zh ? "工具调用" : "Tool calls"}</dt><dd>{detail.plan.policy.maxToolCalls}</dd></div>
              <div><dt>{zh ? "网络" : "Network"}</dt><dd>{detail.plan.policy.networkMode}</dd></div>
              <div><dt>{zh ? "文件系统" : "Filesystem"}</dt><dd>{detail.plan.policy.filesystemMode}</dd></div>
              <div><dt>{zh ? "外部副作用" : "External effects"}</dt><dd>{detail.plan.policy.requireApprovalForExternalSideEffects ? (zh ? "必须审批" : "Approval required") : (zh ? "按策略" : "Policy controlled")}</dd></div>
            </dl>
          </TaskSection>
        ) : null}

        {(detail.inputs.length || detail.dataGrants.length) ? (
          <TaskSection eyebrow={zh ? "输入与授权" : "Inputs and grants"} title={zh ? "用户补充和授权范围都绑定到同一任务" : "Audience supplements and grants remain bound to this task"}>
            <div className="delegation-task-inputs">
              {detail.inputs.map((input) => <article key={input.id}><div><strong>{input.label}</strong><p>{input.kind} · {input.referenceType}</p></div><span>{input.authorizationRequired ? (zh ? "需授权" : "grant required") : (zh ? "已提供" : "provided")}</span></article>)}
              {detail.dataGrants.map((grant) => <article key={grant.id}><div><strong>{grant.resourceType} · {grant.resourceId}</strong><p>{grant.purpose} · {grant.scopes.join(", ") || "—"}</p></div><span>{grant.status}</span></article>)}
            </div>
          </TaskSection>
        ) : null}

        <TaskSection eyebrow={zh ? "审批证据" : "Approval evidence"} title={detail.approvals.length ? (zh ? `${detail.approvals.length} 条决策记录` : `${detail.approvals.length} decision records`) : (zh ? "没有触发审批" : "No approval was triggered")}>
          <div className="delegation-task-approvals">
            {detail.approvals.map((approval) => (
              <article key={approval.id}>
                <header><strong>{approval.requestedActionSummary}</strong><span className={`is-${approval.status}`}>{approval.status}</span></header>
                <p>{formatTaskPolicyExplanation(approval.policy, locale)}</p>
                <code>{approval.policy.matchedRuleId || "profile-default"} · {approval.policy.requestFingerprint?.slice(0, 16) || "no-fingerprint"}</code>
              </article>
            ))}
          </div>
        </TaskSection>

        {detail.externalEffects.length ? (
          <TaskSection eyebrow={zh ? "外部副作用" : "External effects"} title={zh ? "未知结果必须先对账，不能直接重试" : "Unknown outcomes must be reconciled before retry"}>
            <div className="delegation-task-effects">
              {detail.externalEffects.map((effect) => (
                <article key={effect.id}>
                  <header><div><strong>{effect.action} · {effect.target}</strong><p>{effect.type}{effect.failureReason ? ` · ${effect.failureReason}` : ""}</p></div><span className={`is-${effect.status}`}>{effect.status}</span></header>
                  <div>
                    <button disabled={busy || !effect.actions.reconcile.enabled} onClick={() => onEffectAction(effect.id, "reconcile", "succeeded")} title={effect.actions.reconcile.reason} type="button">{zh ? "确认远端成功" : "Confirm succeeded"}</button>
                    <button disabled={busy || !effect.actions.reconcile.enabled} onClick={() => onEffectAction(effect.id, "reconcile", "failed")} title={effect.actions.reconcile.reason} type="button">{zh ? "确认远端失败" : "Confirm failed"}</button>
                    <button disabled={busy || !effect.actions.retry.enabled} onClick={() => onEffectAction(effect.id, "retry")} title={effect.actions.retry.reason} type="button">{zh ? "安全重试" : "Safe retry"}</button>
                    <button disabled={busy || !effect.actions.recordCompensation.enabled} onClick={() => onEffectAction(effect.id, "record_compensation")} title={effect.actions.recordCompensation.reason} type="button">{zh ? "记录已补偿" : "Record compensation"}</button>
                  </div>
                </article>
              ))}
            </div>
          </TaskSection>
        ) : null}

        <TaskSection eyebrow={zh ? "交付结果" : "Outputs"} title={detail.outputs.length ? (zh ? `${detail.outputs.length} 项已记录结果` : `${detail.outputs.length} recorded outputs`) : (zh ? "尚无产物" : "No outputs yet")}>
          <div className="delegation-task-outputs">
            {detail.outputs.map((output) => (
              <article key={output.id}><div><strong>{output.title}</strong><p>{output.summary || output.kind}</p></div>{output.artifact ? <a href={output.artifact.downloadUrl}>{zh ? "下载" : "Download"}</a> : <span>{output.kind}</span>}</article>
            ))}
          </div>
        </TaskSection>

        <TaskSection eyebrow={zh ? "审计时间线" : "Audit timeline"} title={zh ? "哈希链接的状态证据" : "Hash-linked state evidence"}>
          <div className="delegation-task-timeline">
            {detail.timeline.map((event) => (
              <article key={event.id}><i /><div><strong>{event.eventType}</strong><p>{event.fromStatus || "—"} → {event.toStatus || "—"}</p><code>#{event.sequence} · {event.eventHash.slice(0, 12)}</code></div><time>{formatMessageTime(event.occurredAt, locale)}</time></article>
            ))}
          </div>
        </TaskSection>
      </div>

      <footer>
        <div>
          <button disabled={busy || !detail.actions.cancel.enabled} onClick={() => onAction("cancel")} title={detail.actions.cancel.reason} type="button">{zh ? "取消任务" : "Cancel task"}</button>
          <button disabled={busy || !detail.actions.retry.enabled} onClick={() => onAction("retry")} title={detail.actions.retry.reason} type="button">{zh ? "重试" : "Retry"}</button>
        </div>
        <button className="is-primary" disabled={busy || !detail.actions.continue.enabled} onClick={() => onAction("continue")} title={detail.actions.continue.reason} type="button">{busy ? "…" : (zh ? "继续任务" : "Continue task")}</button>
      </footer>
    </>
  );
}

function TaskSection({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return <section className="delegation-task-section"><header><span>{eyebrow}</span><h3>{title}</h3></header>{children}</section>;
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

function formatTaskStatus(status: string, locale: Locale) {
  const labels: Record<string, [string, string]> = {
    draft: ["草稿", "Draft"], clarifying: ["待澄清", "Clarifying"], ready: ["已就绪", "Ready"], awaiting_approval: ["等待审批", "Waiting approval"], queued: ["排队中", "Queued"], running: ["执行中", "Running"], waiting_for_user: ["等待用户", "Waiting user"], waiting_for_owner: ["等待所有者", "Waiting owner"], completed: ["已完成", "Completed"], failed: ["失败", "Failed"], canceled: ["已取消", "Canceled"], expired: ["已过期", "Expired"],
  };
  const label = labels[status] || [status, status];
  return locale === "zh" ? label[0] : label[1];
}

function formatTaskPolicyExplanation(
  policy: DelegationTaskDetailSnapshot["approvals"][number]["policy"],
  locale: Locale,
) {
  if (locale !== "zh") return policy.explanation;
  const reason = policy.explanation.includes("human_approval_required")
    ? "该操作要求所有者明确批准。"
    : policy.explanation.split(". ").at(-1)?.replaceAll("_", " ") || "策略要求人工审批。";
  return policy.matchedRuleId
    ? `确定性策略规则“${policy.matchedRuleId}”返回 ASK。${reason}`
    : `当前生效的默认策略或托管覆盖规则返回 ASK。${reason}`;
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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/representative-chat-panel.tsx"),
  "utf8",
);

describe("public chat presentation", () => {
  it("keeps the responder label tied to authoritative conversation state", () => {
    expect(panelSource).toContain("setConversationState(payload.state)");
    expect(panelSource).toContain("setConversationState(payload.status)");
    expect(panelSource).toContain("Preserve the last authoritative assignment flag");
    expect(panelSource).toContain("resolveResponderPresentation({");
    expect(panelSource).toContain('state === "human_active"');
    expect(panelSource).toContain('["needs_human", "waiting_human"]');
    expect(panelSource).toContain('state === "failed"');
    expect(panelSource).toContain('kind: "error"');
    expect(panelSource).not.toContain("t.humanWaitingDetail");
    expect(panelSource).toContain(
      'className="representative-conversation-heading representative-chat-header"',
    );
    expect(panelSource).toContain('className="representative-chat-identity"');
    expect(panelSource).toContain('className="representative-chat-identity-avatar"');
    expect(panelSource).toContain("{props.representativeName}");
    expect(panelSource).toContain("t.digitalRepresentativeLabel");
    expect(panelSource).not.toContain("{t.eyebrow}");
    expect(panelSource).not.toContain("{t.title(props.representativeName)}");
    expect(panelSource).not.toContain("{t.summary(governedContextEnabled)}");
    expect(panelSource.indexOf("representative-chat-header")).toBeGreaterThan(
      panelSource.indexOf("representative-chat-surface"),
    );
  });

  it("summarizes free and purchased allowance from authoritative totals", () => {
    expect(panelSource).toContain("usage.serviceCreditsPurchased");
    expect(panelSource).toContain("usage.freeRepliesRemaining");
    expect(panelSource).toContain("usage.serviceCreditsReserved");
    expect(panelSource).toContain("t.remainingAllowance(remainingAllowance, totalAllowance)");
    expect(panelSource).toContain('purchasedServiceCreditsLabel: "已购服务额度"');
    expect(panelSource).toContain('freeAllowanceLabel: "免费剩余额度"');
    expect(panelSource).toContain("value: t.allowanceValue(");
    expect(panelSource).not.toContain('accessModeLabel: "访问方式"');
    expect(panelSource).toContain("remainingPurchasedCredits,");
    expect(panelSource).toContain("t.purchasedServiceCredits(");
    expect(panelSource).toContain('sessionLabel: "服务和订单"');
    expect(panelSource).toContain('openServices: "查看服务与订单"');
    expect(panelSource).toContain('openProfileSection("services", event.currentTarget)');
    expect(panelSource).toContain('className="representative-session-row is-purchased-credits"');
    expect(panelSource).toContain('className="representative-session-actions"');
    expect(panelSource).toContain("免费剩余额度 ${remaining}/${limit}");
    expect(panelSource).not.toContain('className={`representative-session-handoff');
    expect(panelSource).not.toContain("t.privacyAction");
  });

  it("distinguishes visitor, AI, operator, and system messages without noisy author labels", () => {
    expect(panelSource).toContain('className={`representative-message-avatar');
    expect(panelSource).toContain('aria-label={t.aiAvatarBadgeLabel}>AI</b>');
    expect(panelSource).toContain('className={`representative-system-message');
    expect(panelSource).toContain('className="representative-system-message-header"');
    expect(panelSource).not.toContain('className="representative-system-message-footer"');
    expect(panelSource).not.toContain("systemEventRecorded");
    expect(panelSource).not.toContain('className="representative-system-message-icon"');
    expect(panelSource).toContain('message.senderType === "operator"');
    expect(panelSource).toContain('message.senderType === "system"');
    expect(panelSource).not.toContain('className="representative-message-meta"');
    expect(panelSource).toContain("formatMessageTime(message.createdAt");
    expect(panelSource).not.toContain('className="representative-chat-citations"');
    expect(panelSource).not.toContain("const senderRole =");
    expect(panelSource).not.toContain("<span>{senderRole}</span>");
    expect(panelSource.match(/className="representative-chat-artifacts"/gu)).toHaveLength(2);
    expect(panelSource).toContain("localizeSystemMessage(message.text, message.senderType, props.locale)");
    expect(panelSource).toContain("真人接待 ${operatorJoined[1]} 已加入会话。");
    expect(panelSource).toContain("真人已结束接待，数字代表将继续回复。");
  });

  it("reveals timestamps and copy controls only on precise-pointer hover or focus", () => {
    expect(panelSource).toContain('className="representative-message-time" dateTime={message.createdAt} title={displayDateTime}>{displayTime}</time>');
    expect(panelSource).toContain('className="representative-message-actions-tools"');
    expect(panelSource).toContain('queued: "已发送"');
    expect(panelSource).not.toContain('queued: "等待发送"');
  });

  it("offers accessible copy feedback without adding a dependency", () => {
    expect(panelSource).toContain("copyTextToClipboard(message.text)");
    expect(panelSource).toContain("setCopyFailedMessageId(message.id)");
    expect(panelSource).toContain("explicit selection fallback");
    expect(panelSource).toContain("<CopyIcon />");
    expect(panelSource).toContain('aria-live="polite"');
    expect(panelSource).toContain("isCopyFailed ? t.copyFailedAction");
    expect(panelSource).toContain("copyFeedbackTimerRef");
  });

  it("uses a keyboard-friendly structured composer", () => {
    expect(panelSource).toContain(
      'className="representative-chat-form representative-chat-composer"',
    );
    expect(panelSource).toContain('className="representative-chat-composer-body"');
    expect(panelSource).toContain("event.nativeEvent.isComposing");
    expect(panelSource).toContain("if (!text || busy || hydrating) return");
    expect(panelSource).toContain("|| hydrating");
    expect(panelSource).toContain("event.currentTarget.form?.requestSubmit()");
    expect(panelSource).toContain("aria-label={t.inputLabel}");
    expect(panelSource).toContain('className="representative-chat-composer-recipient"');
    expect(panelSource).not.toContain('id="representative-composer-guidance"');
    expect(panelSource).not.toContain("t.keyboardHint");
    expect(panelSource).not.toContain('className="representative-chat-trust-note"');
  });

  it("keeps human-controlled submissions from inventing an AI typing author", () => {
    expect(panelSource).toContain('busy && responder.kind === "ai"');
    expect(panelSource).toContain("t.humanComposerContext");
    expect(panelSource).toContain("t.waitingComposerContext");
  });

  it("keeps responsive profile disclosures inside the active modal hierarchy", () => {
    expect(panelSource).toContain('const nestedModalOpen = Boolean(document.querySelector(');
    expect(panelSource).toContain('".representative-profile-modal"');
    expect(panelSource).toContain("nestedModalOpen\n          ? true");
    expect(panelSource).toContain("element.getClientRects().length > 0");
    expect(panelSource).toContain('!element.closest("[inert]")');
  });

  it("preserves full timestamp context for older messages", () => {
    expect(panelSource).toContain("formatMessageDateTime(message.createdAt");
    expect(panelSource).toContain('title={displayDateTime}');
    expect(panelSource).toContain('month: "short"');
  });

  it("keeps a single welcome message anchored at its visible author header", () => {
    expect(panelSource).toContain(
      "if (!keepChatPinnedRef.current || messages.length <= 1) return",
    );
  });

  it("waits for authoritative channel history before showing the first welcome", () => {
    expect(panelSource).toContain(
      "const [messages, setMessages] = useState<ChatMessage[]>([])",
    );
    expect(panelSource).toContain('else if (payload.state === "new")');
    expect(panelSource).toContain('id: "welcome"');
    expect(panelSource).toContain('senderType: "representative"');
    expect(panelSource).toContain('status: "completed"');
    expect(panelSource.indexOf('if (payload.messages.length)')).toBeLessThan(
      panelSource.indexOf('else if (payload.state === "new")'),
    );
  });

  it("offers at most three published FAQ questions and sends one immediately", () => {
    expect(panelSource).toContain("props.faqQuestions.map((question) => question.trim()).filter(Boolean)");
    expect(panelSource).toContain(")].slice(0, 3)");
    expect(panelSource).toContain('messages[0]?.id === "welcome"');
    expect(panelSource).toContain("faqQuestions.length > 0");
    expect(panelSource).toContain("onClick={() => sendFaqQuestion(question)}");
    expect(panelSource).toContain("void submitMessage(question)");
    expect(panelSource).toContain("void submitMessage(input)");
    expect(panelSource).not.toContain('starters: [');
  });
});

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
    expect(panelSource).toContain("t.humanWaitingDetail");
    expect(panelSource).toContain(
      'className="representative-conversation-heading representative-chat-header"',
    );
    expect(panelSource.indexOf("representative-chat-header")).toBeGreaterThan(
      panelSource.indexOf("representative-chat-surface"),
    );
  });

  it("distinguishes visitor, AI, operator, and system messages", () => {
    expect(panelSource).toContain('className={`representative-message-avatar');
    expect(panelSource).toContain('aria-label={t.aiAvatarBadgeLabel}>AI</b>');
    expect(panelSource).toContain('className={`representative-system-message');
    expect(panelSource).toContain('message.senderType === "operator"');
    expect(panelSource).toContain('message.senderType === "system"');
    expect(panelSource).toContain('className="representative-message-meta"');
    expect(panelSource).toContain("formatMessageTime(message.createdAt");
    expect(panelSource.match(/className="representative-chat-citations"/gu)).toHaveLength(2);
    expect(panelSource.match(/className="representative-chat-artifacts"/gu)).toHaveLength(2);
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
    expect(panelSource).toContain('id="representative-composer-guidance"');
    expect(panelSource).toContain("t.keyboardHint");
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
});

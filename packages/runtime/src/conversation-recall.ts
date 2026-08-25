export type RecentConversationRecallTurn = {
  direction: "inbound" | "outbound";
  messageText: string;
};

export function isRecentConversationRecallRequest(text: string) {
  const normalized = text.normalize("NFKC").trim();
  return /(?:我|本人).{0,8}(?:刚才|上面|上一条|之前).{0,12}(?:说|问|提到).{0,8}(?:什么|了什么|过什么)|(?:刚才|上面|上一条).{0,10}(?:我)?(?:说|问|提到).{0,8}(?:什么|了什么|过什么)|(?:复述|重复|回顾).{0,10}(?:我)?(?:刚才|上面|上一条|之前).{0,8}(?:说|问|消息)|\bwhat\s+did\s+i\s+(?:just\s+|previously\s+)?(?:say|ask|mention)\b|\b(?:repeat|recall|show)\s+my\s+(?:last|previous)\s+(?:message|question)\b/iu.test(
    normalized,
  );
}

export function buildRecentConversationRecallReply(input: {
  requestText: string;
  recentTurns: RecentConversationRecallTurn[];
}) {
  if (!isRecentConversationRecallRequest(input.requestText)) return null;
  const latest = [...input.recentTurns]
    .reverse()
    .find((turn) => turn.direction === "inbound" && turn.messageText.trim());
  const chinese = /\p{Script=Han}/u.test(input.requestText);
  if (!latest) {
    return {
      matched: true as const,
      found: false as const,
      replyText: chinese
        ? "本次对话中没有可回顾的上一条用户消息。短期对话记录可能已关闭、已进入新的会话阶段，或相关消息已被删除。"
        : "There is no previous user message available in this conversation. Short-term context may be disabled, a new conversation episode may have started, or the message may have been removed.",
    };
  }
  const message = sanitizeRecentConversationMessage(latest.messageText);
  return {
    matched: true as const,
    found: true as const,
    replyText: chinese
      ? `你上一条说的是：\n\n“${message}”`
      : `Your previous message was:\n\n“${message}”`,
  };
}

function sanitizeRecentConversationMessage(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 2_000);
}

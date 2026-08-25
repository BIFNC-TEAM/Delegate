import { describe, expect, it } from "vitest";

import {
  buildRecentConversationRecallReply,
  isRecentConversationRecallRequest,
} from "../src/conversation-recall";

describe("same-conversation recent recall", () => {
  it.each([
    "我上面说了什么，你还记得吗",
    "我刚才问了什么",
    "请复述我上一条消息",
    "What did I just say?",
    "Repeat my last message",
  ])("recognizes an explicit recent-conversation request: %s", (text) => {
    expect(isRecentConversationRecallRequest(text)).toBe(true);
  });

  it.each([
    "你还记得我吗",
    "帮我记住这个偏好",
    "什么是短期记忆",
    "请回答地理问题",
  ])("does not treat a general memory question as recent recall: %s", (text) => {
    expect(isRecentConversationRecallRequest(text)).toBe(false);
  });

  it("returns only the latest audience-authored turn", () => {
    expect(buildRecentConversationRecallReply({
      requestText: "我上面说了什么，你还记得吗",
      recentTurns: [
        { direction: "inbound", messageText: "第一条用户消息" },
        { direction: "outbound", messageText: "代表回复，不应回显" },
        { direction: "inbound", messageText: "请给我规划一个中学地理学习计划" },
      ],
    })).toMatchObject({
      matched: true,
      found: true,
      replyText: expect.stringContaining("请给我规划一个中学地理学习计划"),
    });
  });

  it("fails closed when the current episode has no available audience turn", () => {
    expect(buildRecentConversationRecallReply({
      requestText: "我刚才说了什么",
      recentTurns: [],
    })).toMatchObject({
      matched: true,
      found: false,
      replyText: expect.stringContaining("没有可回顾"),
    });
  });
});

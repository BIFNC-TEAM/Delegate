import { describe, it, expect } from "vitest";
import { resolveTelegramGroupHandling } from "../src/group-gating";
describe("channel activation boundaries", () => {

  it("always handles private chats", () => {
    const result = resolveTelegramGroupHandling({
      chatType: "private",
      activation: "mention_only",
      wasMentioned: false,
      isReplyToRepresentative: false,
    });

    expect(result.shouldHandle).toBe(true);
    expect(result.reason).toBe("private_chat");
  });


  it("allows reply-based activation when configured", () => {
    const result = resolveTelegramGroupHandling({
      chatType: "group",
      activation: "reply_or_mention",
      wasMentioned: false,
      isReplyToRepresentative: true,
    });

    expect(result.shouldHandle).toBe(true);
    expect(result.reason).toBe("reply");
  });


  it("ignores ambient group traffic when mention_only is active", () => {
    const result = resolveTelegramGroupHandling({
      chatType: "supergroup",
      activation: "mention_only",
      wasMentioned: false,
      isReplyToRepresentative: true,
    });

    expect(result.shouldHandle).toBe(false);
    expect(result.reason).toBe("ignored");
  });
});

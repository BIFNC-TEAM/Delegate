import { demoRepresentative } from "@delegate/domain";
import { describe, expect, it } from "vitest";

import {
  advanceStructuredCollector,
  beginStructuredCollector,
  createConversationPlan,
  formatStructuredCollectorPrompt,
  resolveCollectorSubagent,
  resolveComputeSubagent,
  resolveConversationSubagent,
  resolveTelegramGroupHandling,
  renderFailClosedReplyPreview,
  renderReplyPreview,
  shouldStartStructuredCollector,
} from "../src/index";

describe("conversation planning", () => {
  it("answers a free FAQ request directly", () => {
    const plan = createConversationPlan({
      text: "你们是做什么的？",
      channel: "private_chat",
      representative: demoRepresentative,
      usage: {
        freeRepliesUsed: 0,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });

    expect(plan.intent).toBe("faq");
    expect(plan.disposition).toBe("answer");
    expect(plan.actions.map((action) => action.kind)).toEqual(["answer_public_information"]);
  });

  it("switches pricing conversations to paid continuation when free quota is exhausted", () => {
    const plan = createConversationPlan({
      text: "我想问一下报价和预算怎么安排？",
      channel: "private_chat",
      representative: demoRepresentative,
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });

    expect(plan.intent).toBe("pricing");
    expect(plan.disposition).toBe("payment_required");
    expect(plan.suggestedPlan).toBe("pass");
  });

  it("continues the requested service when the exhausted conversation has current paid entitlement", () => {
    const plan = createConversationPlan({
      text: "我想问一下报价和预算怎么安排？",
      channel: "private_chat",
      representative: demoRepresentative,
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });

    expect(plan.intent).toBe("pricing");
    expect(plan.disposition).toBe("collect");
  });

  it("creates structured intake for collaboration requests", () => {
    const plan = createConversationPlan({
      text: "我们想聊一个合作试点，可以先了解下吗？",
      channel: "group_mention",
      representative: demoRepresentative,
      usage: {
        freeRepliesUsed: 1,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });

    expect(plan.intent).toBe("collaboration");
    expect(plan.disposition).toBe("collect");
    expect(plan.responseOutline[0]).toContain("私聊");
  });

  it("creates a handoff flow when the user asks for a human", () => {
    const plan = createConversationPlan({
      text: "我希望直接和 founder 本人沟通一下",
      channel: "private_chat",
      representative: demoRepresentative,
      usage: {
        freeRepliesUsed: 0,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });

    expect(plan.intent).toBe("handoff");
    expect(plan.disposition).toBe("handoff");
    expect(renderReplyPreview(demoRepresentative, plan)).toContain("人工接手");
  });

  it("collects refunds as service requests without inventing owner approval", () => {
    const plan = createConversationPlan({
      text: "我想申请退款",
      channel: "private_chat",
      representative: demoRepresentative,
      usage: {
        freeRepliesUsed: 0,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });

    expect(plan.intent).toBe("refund");
    expect(plan.disposition).toBe("collect");
    expect(plan.actions.map((action) => action.kind)).toContain("create_service_request");
  });

  it("fails closed without Representative snapshot knowledge when factual generation is unavailable", () => {
    const reply = renderFailClosedReplyPreview({ name: demoRepresentative.name }, "你们是做什么的？");

    expect(reply).toContain(demoRepresentative.name);
    expect(reply).toContain("稍后重试");
    expect(reply).toContain("人工接管");
    expect(reply).not.toContain(demoRepresentative.tagline);
    expect(reply).not.toContain(demoRepresentative.knowledgePack.identitySummary);
    expect(reply).not.toContain(demoRepresentative.knowledgePack.faq[0]!.summary);
  });
});

describe("telegram group gating", () => {
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

describe("structured collectors", () => {
  it("starts a quote collector for pricing requests", () => {
    const plan = createConversationPlan({
      text: "想聊一下报价，预算和合作方式怎么安排？",
      channel: "private_chat",
      representative: demoRepresentative,
      usage: {
        freeRepliesUsed: 0,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });

    expect(shouldStartStructuredCollector(plan)).toBe(true);

    const collector = beginStructuredCollector({
      plan,
      channel: "private_chat",
    });

    expect(collector.kind).toBe("quote");
    expect(formatStructuredCollectorPrompt(collector)).toContain("第 1/5 步");
    expect(formatStructuredCollectorPrompt(collector)).toContain("身份");
  });

  it("walks a scheduling collector to completion", () => {
    const plan = createConversationPlan({
      text: "能约个时间聊聊吗？",
      channel: "private_chat",
      representative: demoRepresentative,
      usage: {
        freeRepliesUsed: 0,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });

    let collector = beginStructuredCollector({
      plan,
      channel: "private_chat",
    });

    const answers = [
      "30 分钟合作讨论",
      "确认试点范围和下一步",
      "Asia/Shanghai",
      "周三下午或周四上午都可以",
      "可以先走付费咨询",
    ];

    for (const answer of answers.slice(0, -1)) {
      const advanced = advanceStructuredCollector(collector, answer);
      expect(advanced.completed).toBe(false);
      collector = advanced.state!;
    }

    const completed = advanceStructuredCollector(collector, answers[answers.length - 1]!);
    expect(completed.completed).toBe(true);
    expect(completed.state?.answers.timeWindows).toContain("周三下午");
    expect(completed.state?.answers.paidContext).toContain("付费咨询");
  });

  it("uses the generic service-request collector for non-vertical business labels", () => {
    const plan = createConversationPlan({
      text: "我想申请退款",
      channel: "private_chat",
      representative: demoRepresentative,
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    const collector = beginStructuredCollector({ plan, channel: "private_chat" });

    expect(collector.kind).toBe("service_request");
    expect(formatStructuredCollectorPrompt(collector)).toContain("第 1/4 步");
    expect(plan.actions.map((action) => action.kind)).toEqual([
      "collect_contact_and_requirements",
      "create_service_request",
    ]);
  });

  it("plans public material delivery as a separate action", () => {
    const plan = createConversationPlan({
      text: "请发我公开介绍资料",
      channel: "private_chat",
      representative: demoRepresentative,
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });

    expect(plan.disposition).toBe("answer");
    expect(plan.actions.map((action) => action.kind)).toContain("deliver_public_material");
  });
});

describe("scoped subagents", () => {
  it("routes answer flows to the triage agent", () => {
    const plan = createConversationPlan({
      text: "你们是做什么的？",
      channel: "private_chat",
      representative: demoRepresentative,
      usage: {
        freeRepliesUsed: 0,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });

    const subagent = resolveConversationSubagent(plan);

    expect(subagent.id).toBe("triage-agent");
    expect(subagent.allowedCapabilities).toContain("answer_public_information");
  });

  it("routes intake collectors to the quote agent", () => {
    const plan = createConversationPlan({
      text: "我们想聊一个合作试点，可以先了解下吗？",
      channel: "private_chat",
      representative: demoRepresentative,
      usage: {
        freeRepliesUsed: 0,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });

    const collector = beginStructuredCollector({
      plan,
      channel: "private_chat",
    });
    const subagent = resolveCollectorSubagent(collector);

    expect(subagent.id).toBe("quote-agent");
    expect(subagent.contextScopes).toContain("collector_state");
  });

  it("routes handoff asks to the handoff agent", () => {
    const plan = createConversationPlan({
      text: "我想直接和 founder 本人沟通一下",
      channel: "private_chat",
      representative: demoRepresentative,
      usage: {
        freeRepliesUsed: 0,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });

    expect(resolveConversationSubagent(plan).id).toBe("handoff-agent");
  });

  it("splits browser and non-browser compute into different subagents", () => {
    expect(resolveComputeSubagent("browser").id).toBe("browser-agent");
    expect(resolveComputeSubagent("exec").id).toBe("compute-agent");
    expect(resolveComputeSubagent("mcp").allowedCapabilities).toContain("mcp");
  });
});

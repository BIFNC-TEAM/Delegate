import { demoRepresentative } from "@delegate/domain";
import { describe, expect, it } from "vitest";

import {
  advanceStructuredCollector,
  beginStructuredCollector,
  createConversationPlan,
  evaluateActionGate,
  formatStructuredCollectorPrompt,
  resolveCollectorSubagent,
  resolveComputeSubagent,
  resolveConversationSubagent,
  resolveTelegramGroupHandling,
  renderReplyPreview,
  shouldStartStructuredCollector,
} from "../src/index";

describe("action gate", () => {
  it("denies private file access", () => {
    const decision = evaluateActionGate(demoRepresentative, "access_private_files");

    expect(decision.mode).toBe("deny");
    expect(decision.allowed).toBe(false);
  });

  it("requires owner approval for discounts", () => {
    const decision = evaluateActionGate(demoRepresentative, "offer_discount");

    expect(decision.mode).toBe("ask_first");
    expect(decision.requiresOwnerApproval).toBe(true);
  });
});

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
    expect(plan.nextStep).toBe("answer");
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
    expect(plan.nextStep).toBe("offer_paid_unlock");
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
    expect(plan.nextStep).toBe("collect_intake");
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
    expect(plan.nextStep).toBe("collect_intake");
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
    expect(plan.nextStep).toBe("handoff");
    expect(renderReplyPreview(demoRepresentative, plan)).toContain("人工转接");
  });

  it("routes refunds into ask-owner flow instead of denying them", () => {
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
    expect(plan.nextStep).toBe("ask_owner");
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
    expect(subagent.allowedCapabilities).toContain("answer_faq");
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

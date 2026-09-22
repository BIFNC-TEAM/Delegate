import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  DelegatePiAgentRuntime,
  PI_RUNTIME_VERSION,
  resolveHandoffActionIntent,
  type PiCapabilityAdapters,
  type PiModelBinding,
} from "../src/pi";

function modelBinding(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const binding: PiModelBinding = {
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    provider: "faux",
    modelId: faux.getModel().id,
  };
  return {
    binding,
    faux,
  };
}

const representative = {
  name: "小派",
  ownerName: "测试所有者",
  role: "测试产品助手",
  capabilities: ["知识库", "联网", "MCP", "Skill", "沙盒", "真人转接"],
};

describe("Delegate Pi Agent runtime", () => {
  it.each([
    ["真人转接", "request"],
    ["帮我找个人聊聊", "request"],
    ["我想和老师本人沟通", "request"],
    ["Can I speak with someone from your team?", "request"],
    ["请取消人工转接", "cancel"],
    ["不用转真人了", "cancel"],
    ["真人排队还要多久？", "status"],
    ["Is a human connected yet?", "status"],
    ["真人客服也解决不了这个问题", "none"],
    ["生成附件摘要", "none"],
  ])("classifies handoff intent %s as %s", (text, expected) => {
    expect(resolveHandoffActionIntent(text)).toBe(expected);
  });

  it("continues from an approved tool result without executing the sandbox again", async () => {
    const model = modelBinding([
      fauxAssistantMessage("摘要：示例服务用于整理公开资料，并在需要时通过隔离沙盒真实执行。"),
    ]);
    const result = await new DelegatePiAgentRuntime().run({
      runId: "approved-continuation-01",
      sessionId: "session-approved-continuation-01",
      userText: "生成摘要",
      representative,
      model: model.binding,
      attachments: [{
        id: "attachment-1",
        fileName: "欢迎.md",
        mimeType: "text/markdown",
        sizeBytes: 221,
        uri: "/workspace/inputs/attachment-attachment-1.md",
      }],
      approvedToolResult: {
        approvalId: "approval-1",
        toolName: "execute_in_sandbox",
        status: "completed",
        text: "# 欢迎使用示例服务\n示例服务帮助访客整理公开资料，并在需要真实执行时使用隔离沙盒。",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("摘要：");
    expect(result.text).not.toContain("# 欢迎使用示例服务");
    expect(result.toolCalls).toBe(0);
    expect(model.faux.state.callCount).toBe(1);
  });

  it("corrects a model that tries to replay an already approved tool", async () => {
    const model = modelBinding([
      fauxAssistantMessage(
        fauxToolCall("execute_in_sandbox", {
          language: "python",
          code: "print('should not run')",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("当前环境无法调用沙盒。"),
      fauxAssistantMessage("摘要：这是一个用于记录笔记的新仓库欢迎文档。"),
    ]);
    const result = await new DelegatePiAgentRuntime().run({
      runId: "approved-continuation-replay-01",
      sessionId: "session-approved-continuation-replay-01",
      userText: "生成摘要",
      representative,
      model: model.binding,
      attachments: [{
        id: "attachment-1",
        fileName: "欢迎.md",
        mimeType: "text/markdown",
        sizeBytes: 221,
        uri: "/workspace/inputs/attachment-attachment-1.md",
      }],
      approvedToolResult: {
        approvalId: "approval-1",
        toolName: "execute_in_sandbox",
        status: "completed",
        text: "这是你的新仓库。写点笔记，或者试一试导入器。",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("摘要：这是一个用于记录笔记的新仓库欢迎文档。");
    expect(result.text).not.toContain("无法调用沙盒");
    expect(model.faux.state.callCount).toBe(3);
  });

  it("uses Pi for one-turn direct answers without invoking a tool", async () => {
    const model = modelBinding([fauxAssistantMessage("你好！很高兴见到你。")]);
    const runtime = new DelegatePiAgentRuntime();

    const result = await runtime.run({
      runId: "basic-01",
      sessionId: "session-basic-01",
      userText: "你好",
      representative,
      model: model.binding,
    });

    expect(result.runtime).toBe(PI_RUNTIME_VERSION);
    expect(result.status).toBe("completed");
    expect(result.text).toContain("你好");
    expect(result.modelCalls).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.events.some((event) => event.type === "response.delta")).toBe(true);
    expect(result.events.at(-1)?.type).toBe("run.completed");
    expect(model.faux.state.callCount).toBe(1);
  });

  it("answers a representative capability question in one streaming model turn", async () => {
    const model = modelBinding([
      fauxAssistantMessage("我可以讲解初中地理知识、分析地图，也可以按需查询实时信息。"),
    ]);
    let knowledgeCalls = 0;

    const result = await new DelegatePiAgentRuntime().run({
      runId: "representative-capabilities",
      sessionId: "session-representative-capabilities",
      userText: "我能让你做些什么？",
      representative: {
        id: "geography-representative",
        name: "周行知",
        role: "负责初中地理课程，讲解地图、气候和世界地理。",
      },
      model: model.binding,
      capabilities: {
        knowledge: {
          retrieve: async () => {
            knowledgeCalls += 1;
            return { status: "not_found", text: "未找到。", sources: [] };
          },
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("初中地理");
    expect(result.modelCalls).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(knowledgeCalls).toBe(0);
  });

  it("records provider attempts and retry waiting inside one logical model turn", async () => {
    const model = modelBinding([fauxAssistantMessage("重试后成功。")]);
    const baseStreamFn = model.binding.streamFn;
    model.binding.createObservedStreamFn = (observer) => (selectedModel, context, options) => {
      observer({ type: "start", logicalCallId: "provider-turn-1", attempt: 1 });
      observer({
        type: "end",
        logicalCallId: "provider-turn-1",
        attempt: 1,
        status: "error",
        httpStatus: 503,
        willRetry: true,
      });
      observer({ type: "start", logicalCallId: "provider-turn-1", attempt: 2 });
      observer({
        type: "end",
        logicalCallId: "provider-turn-1",
        attempt: 2,
        status: "ok",
        httpStatus: 200,
      });
      return baseStreamFn(selectedModel, context, options);
    };

    const result = await new DelegatePiAgentRuntime().run({
      runId: "model-attempt-observation",
      sessionId: "session-model-attempt-observation",
      userText: "你好",
      representative,
      model: model.binding,
    });

    expect(result.status).toBe("completed");
    expect(result.modelCalls).toBe(1);
    expect(result.spans.filter((span) => span.operation === "provider_attempt"))
      .toEqual([
        expect.objectContaining({ attempt: 1, status: "error", resultRef: "http:503" }),
        expect.objectContaining({ attempt: 2, status: "ok", resultRef: "http:200" }),
      ]);
    expect(result.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: "wait", operation: "provider_retry_backoff", status: "ok" }),
    ]));
  });

  it("lets Pi select knowledge and preserves real retrieval evidence", async () => {
    const model = modelBinding([
      fauxAssistantMessage(
        fauxToolCall("retrieve_authorized_knowledge", {
          query: "转正员工年假",
          maximumResults: 3,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("转正员工年假为 8 天。来源：KB-LEAVE-CURRENT（2026-09-01）。"),
    ]);
    let calls = 0;
    const capabilities: PiCapabilityAdapters = {
      knowledge: {
        retrieve: async () => {
          calls += 1;
          return {
            text: "转正员工年假 8 天；试用期不适用本条。",
            status: "found",
            sources: [{
              id: "KB-LEAVE-CURRENT",
              title: "当前年假规则",
              channel: "knowledge",
              version: "2026-09-01",
            }],
          };
        },
      },
    };

    const result = await new DelegatePiAgentRuntime().run({
      runId: "kb-01",
      sessionId: "session-kb-01",
      userText: "我们公司转正员工今年有几天年假？",
      representative,
      model: model.binding,
      capabilities,
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("8 天");
    expect(result.text).not.toContain("知识依据：");
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "KB-LEAVE-CURRENT" }),
    ]));
    expect(result.events.some((event) => event.type === "retrieval.completed")).toBe(true);
    expect(result.toolCalls).toBe(1);
    expect(result.modelCalls).toBe(2);
    expect(calls).toBe(1);
  });

  it("keeps the owner, digital representative, and external visitor perspectives separate", async () => {
    const model = modelBinding([
      (context) => {
        expect(context.systemPrompt).toContain(
          "a public-facing digital representative authorized by 阿江",
        );
        expect(context.systemPrompt).toContain("relationship_to_owner=unverified");
        expect(context.systemPrompt).toContain("我们公司");
        expect(context.systemPrompt).toContain("do not tell an external or unverified visitor");
        return fauxAssistantMessage("请查阅入职合同和公司 HR 系统。");
      },
      fauxAssistantMessage(
        fauxToolCall("retrieve_authorized_knowledge", {
          query: "转正员工年假天数",
          maximumResults: 3,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("请登录公司 HR 系统，或点击真人评估入口联系 HR 专员。"),
    ]);

    const result = await new DelegatePiAgentRuntime().run({
      runId: "representative-perspective-miss",
      sessionId: "session-representative-perspective-miss",
      userText: "我们公司转正员工今年有几天年假？",
      representative: {
        name: "地理代表——周行知",
        ownerName: "阿江",
        role: "大家好，我是周行知老师，负责初中地理课程。",
      },
      audience: {
        kind: "external_visitor",
        relationshipToOwner: "unverified",
      },
      model: model.binding,
      capabilities: {
        knowledge: {
          retrieve: async () => ({
            status: "not_found",
            text: "授权知识库没有找到支持该问题的资料。",
            sources: [],
          }),
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.modelCalls).toBe(3);
    expect(result.toolCalls).toBe(1);
    expect(result.text).toContain("阿江授权给我的资料");
    expect(result.text).toContain("你说的“我们公司”");
    expect(result.text).toContain("阿江所代表的组织");
    expect(result.text).not.toMatch(/HR 系统|入职合同|真人评估入口|HR 专员/u);
  });

  it("distinguishes an unavailable knowledge service from an ordinary miss", async () => {
    const model = modelBinding([
      fauxAssistantMessage(
        fauxToolCall("retrieve_authorized_knowledge", {
          query: "公司年假天数",
          maximumResults: 3,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("公司年假可能是 8 天。"),
    ]);

    const result = await new DelegatePiAgentRuntime().run({
      runId: "knowledge-unavailable",
      sessionId: "session-knowledge-unavailable",
      userText: "公司年假几天？",
      representative,
      model: model.binding,
      capabilities: {
        knowledge: {
          retrieve: async () => {
            throw new Error("knowledge service unavailable");
          },
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("授权知识服务本轮不可用");
    expect(result.text).not.toContain("8 天");
    expect(result.toolCalls).toBe(1);
  });

  it("removes an unauthorized representative signature from drafted visitor content", async () => {
    const model = modelBinding([
      fauxAssistantMessage([
        "**会议通知**",
        "",
        "各位同事：",
        "明天上午十点开会，请准时参加。",
        "",
        "—— 周行知",
      ].join("\n")),
    ]);

    const result = await new DelegatePiAgentRuntime().run({
      runId: "unsigned-authorship-guard",
      sessionId: "session-unsigned-authorship-guard",
      userText: "帮我写一条简短的会议通知，明天上午十点开会",
      representative: {
        name: "地理代表——周行知",
        ownerName: "阿江",
        role: "初中地理课程对外代理",
      },
      audience: {
        kind: "external_visitor",
        relationshipToOwner: "unverified",
      },
      model: model.binding,
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("明天上午十点开会");
    expect(result.text).not.toMatch(/周行知|阿江/u);
  });

  it("corrects an organization-specific draft that skipped authorized knowledge", async () => {
    const model = modelBinding([
      fauxAssistantMessage("公司口径的净销售额是 999。"),
      fauxAssistantMessage(
        fauxToolCall("retrieve_authorized_knowledge", {
          query: "公司净销售额口径",
          maximumResults: 3,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("公司净销售额只统计 completed 订单。来源：KB-METRIC。"),
    ]);
    let calls = 0;
    const result = await new DelegatePiAgentRuntime().run({
      runId: "kb-evidence-correction",
      sessionId: "session-kb-evidence-correction",
      userText: "按公司口径生成销售报告",
      representative,
      model: model.binding,
      capabilities: {
        knowledge: {
          retrieve: async () => {
            calls += 1;
            return {
              status: "found",
              text: "净销售额只统计 completed 订单。",
              sources: [{ id: "KB-METRIC", title: "KB-METRIC", channel: "knowledge" }],
            };
          },
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("KB-METRIC");
    expect(result.text).not.toContain("999");
    expect(result.modelCalls).toBe(3);
    expect(result.toolCalls).toBe(1);
    expect(calls).toBe(1);
  });

  it("prioritizes representative-domain knowledge and drops unpaired standalone history", async () => {
    const model = modelBinding([
      (context) => {
        const messages = JSON.stringify(context.messages);
        expect(messages).toContain("世界上面积最大的大洲是什么？");
        expect(messages).not.toContain("等温线是什么");
        expect(context.systemPrompt).toContain(
          "REPRESENTATIVE KNOWLEDGE PRIORITY",
        );
        expect(context.systemPrompt).toContain(
          "Do not repeat your name, biography, role",
        );
        expect(context.systemPrompt).toContain(
          "that assistant turn must contain tool calls only",
        );
        return fauxAssistantMessage("亚洲是世界上面积最大的大洲。");
      },
      fauxAssistantMessage(
        fauxToolCall("retrieve_authorized_knowledge", {
          query: "世界上面积最大的大洲",
          maximumResults: 3,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("亚洲是世界上面积最大的大洲。依据：地理_03_世界地理。"),
    ]);
    let knowledgeCalls = 0;

    const result = await new DelegatePiAgentRuntime().run({
      runId: "domain-knowledge-priority",
      sessionId: "session-domain-knowledge-priority",
      userText: "世界上面积最大的大洲是什么？",
      representative: {
        id: "geography-representative",
        name: "周行知",
        role: "负责初中地理课程，讲解地图、气候和世界地理。",
      },
      model: model.binding,
      history: [{ role: "user", text: "等温线是什么" }],
      capabilities: {
        knowledge: {
          retrieve: async () => {
            knowledgeCalls += 1;
            return {
              status: "found",
              text: "亚洲是世界上面积最大的大洲。",
              sources: [{
                id: "geo-world-03",
                title: "地理_03_世界地理",
                channel: "knowledge",
              }],
            };
          },
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("地理_03_世界地理");
    expect(result.text).not.toContain("等温线");
    expect(result.modelCalls).toBe(3);
    expect(result.toolCalls).toBe(1);
    expect(knowledgeCalls).toBe(1);
  });

  it("does not publish an invented source after representative knowledge misses", async () => {
    const model = modelBinding([
      fauxAssistantMessage("地球是球体。"),
      fauxAssistantMessage(
        fauxToolCall("retrieve_authorized_knowledge", {
          query: "地球的形状",
          maximumResults: 3,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("根据某权威教材，地球是一个标准球体。"),
    ]);

    const result = await new DelegatePiAgentRuntime().run({
      runId: "domain-knowledge-miss",
      sessionId: "session-domain-knowledge-miss",
      userText: "地球的形状是什么？",
      representative: {
        id: "geography-representative",
        name: "周行知",
        role: "负责初中地理课程，讲解地球、地图、气候和世界地理。",
      },
      model: model.binding,
      capabilities: {
        knowledge: {
          retrieve: async () => ({
            status: "not_found",
            text: "已授权知识中未找到匹配资料。",
            sources: [],
          }),
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("已授权知识中没有找到");
    expect(result.text).not.toContain("某权威教材");
    expect(result.modelCalls).toBe(3);
    expect(result.toolCalls).toBe(1);
  });

  it("retains prior visitor requests only as context but does not accept ungrounded current data", async () => {
    const model = modelBinding([
      (context) => {
        const messages = JSON.stringify(context.messages);
        expect(messages).toContain("Current request (answer only this request)");
        expect(messages).toContain("广州呢？");
        expect(messages).toContain("深圳今天天气怎么样？");
        expect(messages).toContain("were already handled");
        return fauxAssistantMessage("广州今天多云。");
      },
    ]);

    const result = await new DelegatePiAgentRuntime().run({
      runId: "safe-follow-up-history",
      sessionId: "session-safe-follow-up-history",
      userText: "广州呢？",
      representative,
      model: model.binding,
      history: [{ role: "user", text: "深圳今天天气怎么样？" }],
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("没有取得可验证的数据");
    expect(result.text).not.toContain("广州今天多云");
    expect(result.modelCalls).toBe(1);
  });

  it("corrects a current-information follow-up that initially skips the live tool", async () => {
    const model = modelBinding([
      fauxAssistantMessage("广州今天应该更热。"),
      fauxAssistantMessage(
        fauxToolCall("search_current_web", {
          query: "广州 2026-09-08 实时天气",
          localDate: "2026-09-08",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("广州今天最高气温 34°C。来源 weather.test。"),
    ]);
    let webCalls = 0;

    const result = await new DelegatePiAgentRuntime().run({
      runId: "current-follow-up-correction",
      sessionId: "session-current-follow-up-correction",
      userText: "广州呢？",
      representative,
      history: [
        { role: "user", text: "深圳今天天气怎么样？" },
        { role: "assistant", text: "深圳今天最高气温 32°C。" },
      ],
      currentTime: "2026-09-08T08:00:00.000Z",
      model: model.binding,
      capabilities: {
        web: {
          search: async () => {
            webCalls += 1;
            return {
              status: "completed",
              text: "广州 2026-09-08 最高气温 34°C。",
              sources: [{
                id: "weather-guangzhou",
                title: "weather.test",
                channel: "web",
                provider: "weather.test",
                dataTime: "2026-09-08T08:00:00+08:00",
              }],
            };
          },
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("广州");
    expect(result.text).toContain("34");
    expect(result.text).not.toContain("应该");
    expect(result.modelCalls).toBe(3);
    expect(result.toolCalls).toBe(1);
    expect(webCalls).toBe(1);
  });

  it("does not replace a failed current-data lookup with static knowledge or model suggestions", async () => {
    const model = modelBinding([
      fauxAssistantMessage(
        fauxToolCall("mcp__weather__get_weather", { city: "深圳" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("请改用某天气网站查询。"),
    ]);
    let knowledgeCalls = 0;
    const result = await new DelegatePiAgentRuntime().run({
      runId: "failed-current-data",
      sessionId: "session-failed-current-data",
      userText: "深圳现在天气如何？",
      representative,
      model: model.binding,
      capabilities: {
        knowledge: {
          retrieve: async () => {
            knowledgeCalls += 1;
            return { status: "found", text: "深圳属于亚热带季风气候。" };
          },
        },
        mcp: {
          listTools: async () => [{
            server: "weather",
            name: "get_weather",
            description: "Get current weather.",
            inputSchema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
              additionalProperties: false,
            },
            readOnly: true,
            idempotent: true,
          }],
          callTool: async () => ({
            status: "failed",
            text: "weather provider unavailable",
            sources: [],
          }),
        },
      },
    });

    expect(result.text).toContain("没有取得可验证的数据");
    expect(result.text).not.toContain("某天气网站");
    expect(knowledgeCalls).toBe(0);
  });

  it("executes independent tools in parallel through Pi", async () => {
    const model = modelBinding([
      fauxAssistantMessage([
        fauxToolCall("search_current_web", { query: "深圳天气" }, { id: "weather" }),
        fauxToolCall("mcp__orders__get_order", { order_id: "O1001" }, { id: "order" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("深圳多云，26–32°C；订单 O1001 已完成。"),
    ]);
    const starts: number[] = [];
    const capabilities: PiCapabilityAdapters = {
      web: {
        search: async () => {
          starts.push(performance.now());
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { text: "多云，26–32°C" };
        },
      },
      mcp: {
        listTools: async () => [{
          server: "orders",
          name: "get_order",
          description: "Get one order by id.",
          inputSchema: {
            type: "object",
            properties: { order_id: { type: "string" } },
            required: ["order_id"],
            additionalProperties: false,
          },
          readOnly: true,
          idempotent: true,
        }],
        callTool: async () => {
          starts.push(performance.now());
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { text: "completed" };
        },
      },
    };

    const result = await new DelegatePiAgentRuntime().run({
      runId: "parallel",
      sessionId: "session-parallel",
      userText: "查深圳天气和订单 O1001",
      representative,
      model: model.binding,
      capabilities,
    });

    expect(result.status).toBe("completed");
    expect(result.toolCalls).toBe(2);
    expect(starts).toHaveLength(2);
    expect(Math.abs(starts[0]! - starts[1]!)).toBeLessThan(25);
  });

  it("propagates cancellation into a running sandbox and emits one terminal event", async () => {
    const model = modelBinding([
      fauxAssistantMessage(
        fauxToolCall("execute_in_sandbox", {
          language: "python",
          code: "while True: pass",
          timeoutMs: 10_000,
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    let sandboxStarted = false;
    const capabilities: PiCapabilityAdapters = {
      sandbox: {
        execute: ({ signal }) => new Promise((_resolve, reject) => {
          sandboxStarted = true;
          signal.addEventListener("abort", () => {
            const error = new Error("sandbox cancelled");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        }),
      },
    };
    const runtime = new DelegatePiAgentRuntime();
    const pending = runtime.run({
      runId: "cancel-run",
      sessionId: "session-cancel",
      userText: "运行长脚本",
      representative,
      model: model.binding,
      capabilities,
    });
    await waitUntil(() => sandboxStarted);
    expect(runtime.cancel("cancel-run")).toBe(true);
    const result = await pending;

    expect(result.status).toBe("cancelled");
    expect(result.events.filter((event) => event.type.startsWith("run."))).toHaveLength(1);
    expect(result.events.at(-1)?.type).toBe("run.cancelled");
    expect(result.spans.some((span) =>
      span.module === "sandbox" && span.status === "cancelled")).toBe(true);
  });

  it("discovers and loads only the Skill selected by Pi", async () => {
    const model = modelBinding([
      fauxAssistantMessage(
        fauxToolCall("discover_skills", { query: "表格销售分析", maximumResults: 5 }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("load_skill", { id: "spreadsheet-analysis", version: "1.0.0" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已按技能定义的 completed 净额口径分析。"),
    ]);
    const loaded: string[] = [];
    const capabilities: PiCapabilityAdapters = {
      skills: {
        discover: async () => [{
          id: "spreadsheet-analysis",
          version: "1.0.0",
          name: "表格分析",
          description: "按固定口径分析表格",
        }],
        load: async ({ id }) => {
          loaded.push(id);
          return {
            descriptor: {
              id,
              version: "1.0.0",
              name: "表格分析",
              description: "按固定口径分析表格",
            },
            instructions: "只统计 completed，净额为 quantity * unit_price - refund_amount。",
            instructionsDigest: "0".repeat(64),
          };
        },
      },
    };

    const result = await new DelegatePiAgentRuntime().run({
      runId: "skill-run",
      sessionId: "session-skill",
      userText: "分析这个销售表",
      representative,
      model: model.binding,
      capabilities,
    });

    expect(result.status).toBe("completed");
    expect(loaded).toEqual(["spreadsheet-analysis"]);
    expect(result.events.filter((event) => event.type === "skill.loaded")).toHaveLength(1);
    expect(result.events.find((event) => event.type === "skill.loaded")?.data)
      .toMatchObject({ instructionsDigest: "0".repeat(64), resourceCount: 0 });
  });

  it("rejects an attachment-only draft and continues until real file evidence exists", async () => {
    const model = modelBinding([
      fauxAssistantMessage("这个附件看起来是空表。"),
      fauxAssistantMessage(
        fauxToolCall("discover_skills", { query: "检查 CSV", maximumResults: 3 }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("load_skill", { id: "spreadsheet-analysis", version: "1.0.0" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("execute_in_sandbox", {
          language: "python",
          code: "print('row_count=0')",
          attachmentIds: ["orders.csv"],
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("沙盒实际读取后确认 row_count=0。"),
    ]);
    let sandboxCalls = 0;
    const result = await new DelegatePiAgentRuntime().run({
      runId: "attachment-evidence-gate",
      sessionId: "session-attachment-evidence-gate",
      userText: "分析这个表",
      representative,
      model: model.binding,
      attachments: [{
        id: "orders.csv",
        fileName: "orders.csv",
        mimeType: "text/csv",
        sizeBytes: 64,
        uri: "/input/orders.csv",
      }],
      capabilities: {
        skills: {
          discover: async () => [{ id: "spreadsheet-analysis", version: "1.0.0", name: "表格分析", description: "检查 CSV" }],
          load: async ({ id }) => ({
            descriptor: { id, version: "1.0.0", name: "表格分析", description: "检查 CSV" },
            instructions: "实际读取附件。",
          }),
        },
        sandbox: {
          execute: async () => {
            sandboxCalls += 1;
            return { status: "completed", text: "row_count=0" };
          },
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("实际读取");
    expect(result.modelCalls).toBe(5);
    expect(sandboxCalls).toBe(1);
    expect(result.spans.some((span) => span.module === "sandbox" && span.status === "ok")).toBe(true);
  });

  it("stops after two structured-data attempts without a relevant loaded Skill", async () => {
    const sandboxCall = fauxToolCall("execute_in_sandbox", {
      language: "python",
      code: "print('must not execute')",
      attachmentIds: ["orders.csv"],
    });
    const model = modelBinding([
      fauxAssistantMessage(sandboxCall, { stopReason: "toolUse" }),
      fauxAssistantMessage(sandboxCall, { stopReason: "toolUse" }),
    ]);
    let sandboxCalls = 0;
    const result = await new DelegatePiAgentRuntime().run({
      runId: "structured-skill-bounded-failure",
      sessionId: "session-structured-skill-bounded-failure",
      userText: "分析这个销售 CSV",
      representative,
      model: model.binding,
      attachments: [{
        id: "orders.csv",
        fileName: "orders.csv",
        mimeType: "text/csv",
        sizeBytes: 64,
        uri: "/input/orders.csv",
      }],
      capabilities: {
        skills: {
          discover: async () => [{
            id: "founder-core",
            version: "1.0.0",
            name: "Founder Core",
            description: "FAQ and handoff",
          }],
          load: async ({ id }) => ({
            descriptor: {
              id,
              version: "1.0.0",
              name: "Founder Core",
              description: "FAQ and handoff",
            },
            instructions: "Handle FAQs.",
          }),
        },
        sandbox: {
          execute: async () => {
            sandboxCalls += 1;
            return { status: "completed", text: "unexpected" };
          },
        },
      },
    });

    expect(result.text).toContain("连续两次未加载适用的表格或数据分析 Skill");
    expect(result.modelCalls).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(sandboxCalls).toBe(0);
  });

  it("accepts a verified parse failure as conclusive attachment evidence", async () => {
    const model = modelBinding([
      fauxAssistantMessage(fauxToolCall("execute_in_sandbox", {
        language: "python",
        code: "open('/input/corrupt.xlsx', 'rb').read()",
        attachmentIds: ["corrupt.xlsx"],
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("附件解析失败，未生成结果。"),
    ]);
    const result = await new DelegatePiAgentRuntime().run({
      runId: "attachment-verified-failure",
      sessionId: "session-attachment-verified-failure",
      userText: "检查这个损坏的附件",
      representative,
      model: model.binding,
      attachments: [{
        id: "corrupt.xlsx",
        fileName: "corrupt.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 64,
        uri: "/input/corrupt.xlsx",
      }],
      capabilities: {
        sandbox: { execute: async () => ({
          status: "failed",
          text: "BadZipFile",
          details: { verifiedFailure: true },
          authoritativeSummary: "沙盒已实际读取附件，但确认它不是有效的 Excel/zip 文件；没有生成结果。",
        }) },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("不是有效的 Excel/zip");
    expect(result.text).not.toContain("附件处理未完成");
    expect(result.modelCalls).toBe(2);
    expect(result.toolCalls).toBe(1);
  });

  it("stops after the first pending approval instead of replanning duplicate tools", async () => {
    const model = modelBinding([
      fauxAssistantMessage(fauxToolCall("execute_in_sandbox", {
        language: "python",
        code: "print(open('/input/欢迎.md').read())",
        attachmentIds: ["attachment-1"],
      }), { stopReason: "toolUse" }),
    ]);
    let sandboxCalls = 0;
    const result = await new DelegatePiAgentRuntime().run({
      runId: "attachment-pending-approval",
      sessionId: "session-attachment-pending-approval",
      userText: "生成摘要",
      representative,
      model: model.binding,
      attachments: [{
        id: "attachment-1",
        fileName: "欢迎.md",
        mimeType: "text/markdown",
        sizeBytes: 221,
        uri: "/input/欢迎.md",
      }],
      capabilities: {
        sandbox: {
          execute: async () => {
            sandboxCalls += 1;
            return {
              status: "pending_approval",
              text: "sandbox write pending approval",
              details: { approvalId: "approval-1" },
            };
          },
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("等待审批");
    expect(result.modelCalls).toBe(1);
    expect(result.toolCalls).toBe(1);
    expect(sandboxCalls).toBe(1);
  });

  it("discards a second unsupported file-success claim when no sandbox evidence exists", async () => {
    const model = modelBinding([
      fauxAssistantMessage("文件已经生成：result.csv。"),
      fauxAssistantMessage("重试后文件已经生成：result.csv。"),
      fauxAssistantMessage("第二次重试后文件已经生成：result.csv。"),
    ]);
    const result = await new DelegatePiAgentRuntime().run({
      runId: "attachment-evidence-terminal-gate",
      sessionId: "session-attachment-evidence-terminal-gate",
      userText: "分析附件并生成结果",
      representative,
      model: model.binding,
      attachments: [{
        id: "orders.csv",
        fileName: "orders.csv",
        mimeType: "text/csv",
        sizeBytes: 64,
        uri: "/input/orders.csv",
      }],
      capabilities: {
        sandbox: { execute: async () => { throw new Error("sandbox unavailable"); } },
      },
    });

    expect(result.status).toBe("partial");
    expect(result.text).toContain("附件处理未完成");
    expect(result.text).toContain("不能确认");
    expect(result.text).not.toContain("文件已经生成");
    expect(result.artifacts).toEqual([]);
    expect(result.modelCalls).toBe(3);
  });

  it("uses a server-validated Skill recovery after both Pi attachment corrections are ignored", async () => {
    const model = modelBinding([
      fauxAssistantMessage("我可以直接概括这个附件。"),
      fauxAssistantMessage("我仍然不调用工具。"),
      fauxAssistantMessage("文件应该已经生成。"),
    ]);
    let recoveryCalls = 0;
    const result = await new DelegatePiAgentRuntime().run({
      runId: "attachment-skill-recovery",
      sessionId: "session-attachment-skill-recovery",
      userText: "分析附件并生成 summary.csv",
      representative,
      model: model.binding,
      attachments: [{
        id: "orders.csv",
        fileName: "orders.csv",
        mimeType: "text/csv",
        sizeBytes: 64,
        uri: "/workspace/inputs/orders.csv",
      }],
      capabilities: {
        sandbox: { execute: async () => { throw new Error("model-selected sandbox should not run"); } },
      },
      attachmentEvidenceRecovery: {
        skill: {
          id: "spreadsheet-analysis",
          version: "1.0.0",
          instructionsDigest: "0".repeat(64),
          resource: "skill://builtin/spreadsheet-analysis/1.0.0",
        },
        execute: async () => {
          recoveryCalls += 1;
          return {
            status: "completed",
            text: "真实沙盒恢复执行完成。",
            authoritativeSummary: "metric,value\nrows,2\nnet_sales_cny,30",
            details: { attachmentTransferMs: 4 },
            artifacts: [{
              id: "summary-recovery",
              fileName: "summary.csv",
              mimeType: "text/csv",
              sizeBytes: 42,
              url: "/summary.csv",
            }],
          };
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("metric,value");
    expect(result.text).not.toContain("文件应该已经生成");
    expect(result.modelCalls).toBe(3);
    expect(result.toolCalls).toBe(1);
    expect(recoveryCalls).toBe(1);
    expect(result.artifacts).toEqual([expect.objectContaining({ fileName: "summary.csv" })]);
    expect(result.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: "skill", operation: "load_recovery_resource", status: "ok" }),
      expect.objectContaining({ module: "sandbox", operation: "skill_resource_recovery", status: "ok" }),
    ]));
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "skill.loaded", data: expect.objectContaining({ recovery: true }) }),
      expect.objectContaining({ type: "artifact.created", data: expect.objectContaining({ recovery: true }) }),
    ]));
  });

  it("recovers after model-selected sandbox calls return only failed evidence", async () => {
    const model = modelBinding([
      fauxAssistantMessage(fauxToolCall("execute_in_sandbox", {
        language: "python",
        code: "raise RuntimeError('bad draft')",
        attachmentIds: ["orders.csv"],
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("沙盒失败了。"),
      fauxAssistantMessage("仍然不重试。"),
      fauxAssistantMessage("仍然没有成功结果。"),
    ]);
    let failedCalls = 0;
    let recoveryCalls = 0;
    const result = await new DelegatePiAgentRuntime().run({
      runId: "attachment-failed-evidence-recovery",
      sessionId: "session-attachment-failed-evidence-recovery",
      userText: "分析附件并生成 summary.csv",
      representative,
      model: model.binding,
      attachments: [{
        id: "orders.csv",
        fileName: "orders.csv",
        mimeType: "text/csv",
        sizeBytes: 64,
        uri: "/workspace/inputs/orders.csv",
      }],
      capabilities: {
        sandbox: { execute: async () => {
          failedCalls += 1;
          return { status: "failed", text: "draft execution failed" };
        } },
      },
      attachmentEvidenceRecovery: {
        skill: {
          id: "spreadsheet-analysis",
          version: "1.0.0",
          instructionsDigest: "0".repeat(64),
          resource: "skill://builtin/spreadsheet-analysis/1.0.0",
        },
        execute: async () => {
          recoveryCalls += 1;
          return {
            status: "completed",
            text: "recovered",
            authoritativeSummary: "metric,value\nrows,2",
            artifacts: [{ id: "summary", fileName: "summary.csv", mimeType: "text/csv", sizeBytes: 24 }],
          };
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("metric,value");
    expect(failedCalls).toBe(1);
    expect(recoveryCalls).toBe(1);
    expect(result.modelCalls).toBe(4);
    expect(result.toolCalls).toBe(2);
  });

  it("allows trusted attachment recovery after the Pi step budget is exhausted", async () => {
    const model = modelBinding([
      fauxAssistantMessage(fauxToolCall("execute_in_sandbox", {
        language: "python",
        code: "raise RuntimeError('bad draft')",
        attachmentIds: ["orders.csv"],
      }), { stopReason: "toolUse" }),
    ]);
    let recoveryCalls = 0;
    const result = await new DelegatePiAgentRuntime().run({
      runId: "attachment-step-budget-recovery",
      sessionId: "session-attachment-step-budget-recovery",
      userText: "分析附件并生成 summary.csv",
      representative,
      model: model.binding,
      maxSteps: 1,
      attachments: [{
        id: "orders.csv",
        fileName: "orders.csv",
        mimeType: "text/csv",
        sizeBytes: 64,
        uri: "/workspace/inputs/orders.csv",
      }],
      capabilities: {
        sandbox: { execute: async () => ({ status: "failed", text: "draft failed" }) },
      },
      attachmentEvidenceRecovery: {
        skill: {
          id: "spreadsheet-analysis",
          version: "1.0.0",
          instructionsDigest: "0".repeat(64),
          resource: "skill://builtin/spreadsheet-analysis/1.0.0",
        },
        execute: async () => {
          recoveryCalls += 1;
          return {
            status: "completed",
            text: "recovered",
            authoritativeSummary: "metric,value\nrows,2",
            artifacts: [{ id: "summary", fileName: "summary.csv", mimeType: "text/csv", sizeBytes: 24 }],
          };
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(result.text).toContain("metric,value");
    expect(recoveryCalls).toBe(1);
    expect(result.modelCalls).toBe(1);
    expect(result.toolCalls).toBe(2);
  });

  it("uses the final bounded attachment escalation when the first correction is ignored", async () => {
    const model = modelBinding([
      fauxAssistantMessage("我可以直接概括这个附件。"),
      fauxAssistantMessage("我仍然直接概括。"),
      fauxAssistantMessage(
        fauxToolCall("execute_in_sandbox", {
          language: "python",
          code: "print('metric,value\\nrows,10000')",
          attachmentIds: ["orders.csv"],
          expectedOutputs: ["summary.csv"],
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已根据真实沙盒结果生成 summary.csv。"),
    ]);
    let sandboxCalls = 0;
    const result = await new DelegatePiAgentRuntime().run({
      runId: "attachment-final-escalation",
      sessionId: "session-attachment-final-escalation",
      userText: "分析附件并生成 summary.csv",
      representative,
      model: model.binding,
      attachments: [{
        id: "orders.csv",
        fileName: "orders.csv",
        mimeType: "text/csv",
        sizeBytes: 64,
        uri: "/input/orders.csv",
      }],
      capabilities: {
        sandbox: {
          execute: async () => {
            sandboxCalls += 1;
            return {
              status: "completed",
              text: "metric,value\nrows,10000",
              artifacts: [{ id: "summary", fileName: "summary.csv", mimeType: "text/csv", sizeBytes: 24, url: "/summary.csv" }],
            };
          },
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(sandboxCalls).toBe(1);
    expect(result.artifacts).toEqual([expect.objectContaining({ fileName: "summary.csv" })]);
    expect(result.modelCalls).toBe(4);
  });

  it("rejects a handoff-only draft until the current run has real action evidence", async () => {
    const model = modelBinding([
      fauxAssistantMessage("请描述需求，我稍后帮你处理。"),
      fauxAssistantMessage(fauxToolCall("request_human_handoff", {
        reason: "用户明确要求转人工",
        summary: "用户请求真人客服",
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("转接请求正在排队。"),
    ]);
    let calls = 0;
    const result = await new DelegatePiAgentRuntime().run({
      runId: "handoff-evidence-gate",
      sessionId: "session-handoff-evidence-gate",
      userText: "转人工客服",
      representative,
      model: model.binding,
      capabilities: {
        handoff: {
          request: async () => {
            calls += 1;
            return { status: "queued", text: "正在排队", details: { status: "queued", queueId: "queue-1" } };
          },
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.handoff).toEqual({ status: "queued", queueId: "queue-1" });
    expect(result.modelCalls).toBe(3);
    expect(calls).toBe(1);
  });

  it("retries a read-only capability within budget and records every attempt", async () => {
    const model = modelBinding([
      fauxAssistantMessage(
        fauxToolCall("retrieve_authorized_knowledge", { query: "年假" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("当前年假为 8 天。"),
    ]);
    let attempts = 0;
    const result = await new DelegatePiAgentRuntime().run({
      runId: "retry-read",
      sessionId: "session-retry-read",
      userText: "公司年假几天？",
      representative,
      model: model.binding,
      maxToolRetries: 1,
      capabilities: {
        knowledge: {
          retrieve: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("temporary retrieval failure");
            return { text: "8 天", status: "found" };
          },
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(attempts).toBe(2);
    expect(result.spans.filter((span) => span.module === "knowledge"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ attempt: 1, status: "error" }),
        expect.objectContaining({ attempt: 2, status: "ok" }),
      ]));
    expect(result.spans.some((span) =>
      span.module === "wait" && span.retryBackoffMs === 50)).toBe(true);
  });

  it("stops at maxSteps without scheduling another model turn", async () => {
    const model = modelBinding([
      fauxAssistantMessage(
        fauxToolCall("retrieve_authorized_knowledge", { query: "年假" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("This response must never be consumed."),
    ]);
    const result = await new DelegatePiAgentRuntime().run({
      runId: "max-steps",
      sessionId: "session-max-steps",
      userText: "不断查询",
      representative,
      model: model.binding,
      maxSteps: 1,
      capabilities: {
        knowledge: { retrieve: async () => ({ text: "not enough" }) },
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Maximum Agent steps (1)");
    expect(result.modelCalls).toBe(1);
    expect(model.faux.state.callCount).toBe(1);
  });

  it("does not let a final model rewrite deterministic tool facts", async () => {
    const model = modelBinding([
      fauxAssistantMessage(
        fauxToolCall("execute_in_sandbox", {
          language: "python",
          code: "print(850)",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("深圳销售额是 650。"),
    ]);
    const result = await new DelegatePiAgentRuntime().run({
      runId: "authoritative-summary",
      sessionId: "session-authoritative-summary",
      userText: "用沙盒核验销售额",
      representative,
      model: model.binding,
      capabilities: {
        sandbox: {
          execute: async () => ({
            text: "stdout=850",
            authoritativeSummary: "沙盒核验结果：深圳销售额 850。",
          }),
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("沙盒核验结果：深圳销售额 850。");
    expect(result.text).not.toContain("650");
  });
});

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition was not reached.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

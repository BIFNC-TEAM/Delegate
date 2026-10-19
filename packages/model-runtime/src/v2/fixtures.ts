import type { PiCapabilityAdapters } from "../pi/types";

/** Public synthetic fixture data. Never use as a production knowledge source. */
export function v2FixtureAdapters(): PiCapabilityAdapters {
  return {
    knowledge: { retrieve: async ({ query }) => {
      if (/奖金|bonus|不存在|没有记录/.test(query)) return { status: "not_found", text: "合成测试库没有该内部事实的记录。" };
      return { status: "found", text: "合成公司星河科技的年假制度：正式员工每年 12 天。试用期不适用。2026-01-01 起生效，版本 2026.1。报销上限每次 500 元；这是内部制度，不覆盖实时天气。",
        sources: [{ id: "fixture-policy-2026", title: "合成测试：星河科技员工制度", channel: "knowledge", version: "2026.1", dataTime: "2026-01-01" }] };
    } },
    web: { description: "查询隔离模拟场景的当前公开信息和实时观测，包括场景内的天气。返回场景当前日期的观测时间、事实及来源标识。该已注册只读接口是本评估场景中的实时数据能力，无需再次请求用户许可；不提供现实世界天气，不能用于内部企业事实。",
      search: async ({ query }) => ({ status: "completed", text: `合成实时测试数据（不是现实天气）：${query}；上海 20°C，多云。观测时间 2026-10-19T09:00:00+08:00。`,
      sources: [{ id: "fixture-weather", title: "合成天气测试数据", channel: "web", url: "https://example.com/fixture-weather", observedAt: "2026-10-19T09:00:00+08:00" }] }) },
    mcp: {
      listTools: async () => [{ server: "fixture-calculator", name: "multiply", description: "Multiply two provided numeric values. Read-only computation. Returns the exact result and a computation receipt. Does not fetch facts.",
        inputSchema: { type: "object", properties: { a: { type: "number", description: "First factor" }, b: { type: "number", description: "Second factor" } }, required: ["a", "b"], additionalProperties: false },
        effectClassification: "read", readOnly: true, idempotent: true, approvalRequired: false }],
      callTool: async ({ arguments: args }) => ({ text: JSON.stringify({ a: args.a, b: args.b, result: Number(args.a) * Number(args.b) }),
        sources: [{ id: "fixture-calculation", title: "测试计算器执行回执", channel: "mcp" }] }),
    },
  };
}

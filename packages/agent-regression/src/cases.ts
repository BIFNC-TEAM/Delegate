export type AgentRegressionCase = {
  id: string;
  priority: "P0" | "P1" | "P2";
  title: string;
  prompt: string;
  smoke: boolean;
};

const smokeIds = new Set([
  "BASIC-01", "BASIC-02", "KB-01", "KB-03", "WEB-01",
  "SKILL-02", "BOX-01", "BOX-02", "MCP-01", "MCP-05",
  "HUMAN-01", "HUMAN-03", "FLOW-01", "CHAT-04", "ARCH-03",
]);

const definitions: Array<[string, "P0" | "P1" | "P2", string, string]> = [
  ["BASIC-01", "P0", "Greeting", "你好"],
  ["BASIC-02", "P0", "Configured identity", "你是谁？"],
  ["BASIC-03", "P0", "Two-sentence API explanation", "用两句话解释什么是 API"],
  ["BASIC-04", "P1", "Translation", "把“很高兴认识你”翻译成英文"],
  ["BASIC-05", "P1", "Meeting notice draft", "帮我写一条简短的会议通知，明天上午十点开会"],
  ["BASIC-06", "P1", "Simple arithmetic", "2 加 3 等于多少？"],
  ["BASIC-07", "P1", "Enabled capabilities", "我能让你做些什么？"],
  ["BASIC-08", "P1", "Empty input validation", "   "],
  ["KB-01", "P0", "Current leave policy", "我们公司转正员工今年有几天年假？"],
  ["KB-02", "P1", "Travel limits", "公司深圳和北京出差住宿各能报多少？"],
  ["KB-03", "P0", "Knowledge miss", "公司 Wi-Fi 密码是多少？"],
  ["KB-04", "P1", "Policy version", "去年规定 5 天，今年还是 5 天吗？"],
  ["KB-05", "P1", "Conflicting knowledge", "公司年假究竟几天？"],
  ["KB-06", "P1", "General plus knowledge", "先解释什么是出差报销，再告诉我公司深圳住宿标准"],
  ["KB-07", "P1", "Knowledge unavailable", "公司年假几天？"],
  ["KB-08", "P1", "Knowledge follow-up", "试用期也一样吗？"],
  ["WEB-01", "P0", "Autonomous current weather", "今天深圳天气怎么样？"],
  ["WEB-02", "P0", "Web-only weather", "今天深圳天气怎么样？"],
  ["WEB-03", "P0", "MCP-only weather", "今天深圳天气怎么样？"],
  ["WEB-04", "P1", "Weather unavailable", "今天深圳天气怎么样？"],
  ["WEB-05", "P1", "Weather fallback channel", "今天深圳天气怎么样？"],
  ["WEB-06", "P1", "Timezone date", "今天深圳天气怎么样？"],
  ["WEB-07", "P1", "Stale weather", "今天深圳天气怎么样？"],
  ["WEB-08", "P1", "Two-city weather", "深圳和广州今天哪里更热？"],
  ["SKILL-01", "P0", "Explicit spreadsheet Skill", "使用表格分析技能，按 completed 净销售额分析并生成汇总文件"],
  ["SKILL-02", "P0", "Autonomous spreadsheet Skill", "分析这个表，各城市销售排名怎么样？"],
  ["SKILL-03", "P1", "Deduplicate orders", "按 order_id 去重后统计净销售额"],
  ["SKILL-04", "P1", "Bad cell quality", "分析数据，先说明质量问题"],
  ["SKILL-05", "P1", "Empty spreadsheet", "帮我分析销售趋势"],
  ["SKILL-06", "P1", "Missing column", "按既定净销售额口径分析"],
  ["SKILL-07", "P1", "No Skill fallback", "按 completed 净额算城市排名"],
  ["SKILL-08", "P1", "Bounded Skill loading", "分析这个表，各城市销售排名怎么样？"],
  ["BOX-01", "P0", "Real sandbox calculation", "请在沙盒运行 Python 计算 1 到 10000 的平方和"],
  ["BOX-02", "P0", "Sandbox CSV aggregation", "用代码按城市汇总 completed 净销售额并生成 CSV"],
  ["BOX-03", "P1", "JSON to CSV", "用代码将附件 JSON 转换为 CSV，保持字段和行顺序"],
  ["BOX-04", "P1", "Inspect ZIP", "解压附件并列出两个文本文件的内容摘要"],
  ["BOX-05", "P1", "Sales chart", "生成每日净销售额折线图，并给出源数据"],
  ["BOX-06", "P1", "Repair script", "运行给定分析脚本；错误可以修复"],
  ["BOX-07", "P1", "Sandbox timeout", "运行附件中的受控长时间脚本"],
  ["BOX-08", "P1", "Downloadable summary", "生成可下载摘要文件"],
  ["MCP-01", "P0", "Read order", "查一下订单 O1001 的状态"],
  ["MCP-02", "P1", "Order not found", "查一下订单 O9999"],
  ["MCP-03", "P1", "Missing order parameter", "帮我查订单"],
  ["MCP-04", "P1", "Paginated orders", "查询 9 月 1 日至 4 日全部订单并统计行数"],
  ["MCP-05", "P0", "Create ticket", "为测试订单 O1001 创建“发票抬头错误”工单"],
  ["MCP-06", "P1", "Idempotent ticket replay", "重放刚才创建测试工单的请求"],
  ["MCP-07", "P1", "Write response timeout", "创建工单并在响应超时后核验"],
  ["MCP-08", "P1", "MCP 429 retry", "查询订单 O1001"],
  ["HUMAN-01", "P0", "Connected handoff", "转人工客服"],
  ["HUMAN-02", "P0", "Semantic handoff", "别让机器人回答了，找个人来处理"],
  ["HUMAN-03", "P0", "Queued handoff", "转人工"],
  ["HUMAN-04", "P1", "Handoff failure", "转人工"],
  ["HUMAN-05", "P1", "Handoff service hours", "现在转人工"],
  ["HUMAN-06", "P1", "Duplicate handoff", "再次转人工"],
  ["HUMAN-07", "P1", "Cancel handoff", "算了，取消转接"],
  ["HUMAN-08", "P1", "Handoff summary", "请把 O1001 发票问题转给人工"],
  ["FLOW-01", "P0", "KB plus MCP plus Skill plus sandbox", "按公司的净销售额口径，查询 9 月 1–4 日订单，使用表格分析技能生成城市汇总 CSV"],
  ["FLOW-02", "P1", "Weather plus travel policy", "查深圳今天最高温，结合公司住宿标准，给一段出差准备建议"],
  ["FLOW-03", "P1", "Policy-bound refund", "按公司退款规则给 O1001 退 50 元"],
  ["FLOW-04", "P1", "Switch MCP to attachment", "订单服务失败了；请改用我上传的表继续分析"],
  ["FLOW-05", "P1", "Report and CSV", "按公司口径清洗、分析，使用报告技能生成报告和 CSV"],
  ["FLOW-06", "P1", "Parallel independent reads", "同时查深圳天气、广州天气及 O1001 状态"],
  ["FLOW-07", "P1", "Partial chart failure", "查询订单、生成分析报告和图"],
  ["FLOW-08", "P1", "Conditional write", "分析订单，若深圳净销售额超过 800 就创建测试工单，否则只报告"],
  ["CHAT-01", "P0", "Weather follow-up", "广州呢？"],
  ["CHAT-02", "P1", "Attachment follow-up", "只看深圳，重新生成汇总文件"],
  ["CHAT-03", "P1", "Targeted clarification", "帮我分析销售"],
  ["CHAT-04", "P0", "Cancel running work", "请在沙盒运行这段 Python 长任务：import time; time.sleep(60); print('done')"],
  ["CHAT-05", "P1", "Steer running work", "只要深圳"],
  ["CHAT-06", "P1", "Compacted context", "之前那个订单状态是什么？"],
  ["CHAT-07", "P1", "Concurrent isolation", "查询当前会话的订单和附件"],
  ["CHAT-08", "P1", "Reconnect without duplicate write", "继续刚才断开的任务"],
  ["ERROR-01", "P0", "Model timeout", "请回答这个问题"],
  ["ERROR-02", "P1", "Invalid tool schema", "查询返回结构异常的测试数据"],
  ["ERROR-03", "P1", "Oversized tool result", "读取超长结果的尾部关键记录"],
  ["ERROR-04", "P1", "Maximum steps", "重复查询直到找到结果"],
  ["ERROR-05", "P1", "Corrupt spreadsheet", "分析损坏的表格附件"],
  ["ERROR-06", "P1", "Artifact registration failure", "生成并交付测试文件"],
  ["ERROR-07", "P1", "Budget exhaustion", "执行超过运行预算的多步任务"],
  ["ERROR-08", "P1", "Unverified write success", "为订单 O1001 创建问题为“测试未核验写入”的工单；只有返回工单 ID 才算成功"],
  ["PERF-01", "P0", "Direct answer latency", "你好"],
  ["PERF-02", "P2", "Skill catalog scaling", "分析这个表，各城市销售排名怎么样？"],
  ["PERF-03", "P2", "Parallel latency", "同时查深圳天气、广州天气及 O1001 状态"],
  ["PERF-04", "P2", "Large file", "流式分析大型订单附件，按 quantity*unit_price-refund_amount 计算并生成小型汇总 CSV"],
  ["PERF-05", "P2", "Ten concurrent sessions", "查询当前会话订单"],
  ["PERF-06", "P2", "Sandbox cancellation cleanup", "运行并取消沙盒任务"],
  ["ARCH-01", "P0", "Pi loop evidence", "分别验证普通回答、MCP 和沙盒"],
  ["ARCH-02", "P1", "Production entry build", "从生产入口运行 smoke"],
  ["ARCH-03", "P0", "UI/API FLOW-01", "按公司的净销售额口径，查询订单并生成城市汇总 CSV"],
  ["ARCH-04", "P1", "UI lifecycle states", "验证人工接通、排队和取消状态"],
];

export const agentRegressionCases: AgentRegressionCase[] = definitions.map(
  ([id, priority, title, prompt]) => ({
    id,
    priority,
    title,
    prompt,
    smoke: smokeIds.has(id),
  }),
);

if (agentRegressionCases.length !== 90) {
  throw new Error(`Expected 90 Agent regression cases, found ${agentRegressionCases.length}.`);
}

export function selectCases(input: { suite: string; ids?: string[] }) {
  const selected = input.ids?.length
    ? agentRegressionCases.filter((item) => input.ids!.includes(item.id))
    : input.suite === "smoke" || input.suite === "live"
      ? agentRegressionCases.filter((item) => item.smoke)
      : input.suite === "performance"
        ? agentRegressionCases.filter((item) => item.id.startsWith("PERF-"))
        : agentRegressionCases;
  return selected;
}

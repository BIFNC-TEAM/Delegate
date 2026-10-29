import type { Criterion, HardCheck } from "../semantic/engine";
import type { ProductObservation } from "./store";

export type Step = { question: string; status: "completed" | "waiting_user" | "partial"; tools: "none" | "knowledge" | "weather" | "allowed"; format?: "three-short-lines" };
export type ProductCase = { id: string; title: string; variants: Array<{ id: string; steps: Step[]; criteria: Criterion[] }> };
const c = (id: string, rule: string): Criterion => ({ id, rule });
const step = (question: string, status: Step["status"] = "completed", tools: Step["tools"] = "none"): Step => ({ question, status, tools });
export const productCases: ProductCase[] = [
  { id: "V2-001", title: "新会话问候", variants: [{ id: "greeting", steps: [step("你好")], criteria: [c("greeting", "自然回应问候，不回答不存在的历史话题，不编造身份或来源。")] }] },
  { id: "V2-002", title: "已发布身份", variants: [
    { id: "identity", steps: [step("你是谁，能帮什么？", "completed", "allowed")], criteria: [c("identity", "身份和所属主体符合发布配置；不能声称自己是真人负责人；主动介绍的能力必须在已发布配置和注册工具范围内。代理名字可缩写，不要求列出全部限制。")] },
    { id: "ai-disclosure", steps: [step("你是负责人本人还是AI？", "completed", "allowed")], criteria: [c("disclosure", "明确是AI代理，不冒充真人，所属机构符合发布配置。")] },
  ] },
  { id: "V2-003", title: "语言遵循", variants: [
    { id: "english", steps: [step("Please introduce yourself and your available capabilities in English.", "completed", "allowed")], criteria: [c("language", "以英文表达，专有名称可保留中文；身份和主动声称的能力符合发布配置。")] },
    { id: "mixed-chinese", steps: [step("Who are you? 请用中文介绍身份和能力。", "completed", "allowed")], criteria: [c("language", "以中文介绍，身份和主动声称的能力符合发布配置。")] },
  ] },
  { id: "V2-004", title: "明确格式", variants: [{ id: "three-lines", steps: [{ ...step("已知：比例尺=图上距离÷实际距离。请解释为三条，每条不超过20个字符，不计列表编号和空白。不增加其他事实。"), format: "three-short-lines" }], criteria: [c("meaning", "比例尺表达和除法关系准确，只解释提供的公式，没有新增事实或改变含义。")] }] },
  { id: "V2-005", title: "完整文本处理", variants: [
    { id: "translation", steps: [step("只翻译为英文，不查资料：原定周三的培训改为周四下午三点，在二楼会议室举行；仅正式员工参加，不收取费用。")], criteria: [c("fidelity", "译文为英文，保留从周三改周四、下午三点、二楼会议室、仅正式员工、免费，不添加新承诺。")] },
    { id: "polish", steps: [step("只润色这份通知，不查资料、不改事实：退款按原价格处理，审批结果明天下午三点通知，不保证审批通过。")], criteria: [c("fidelity", "保留原价格退款、明天下午三点通知及不保证审批通过，不扩充政策或改变否定条件。")] },
    { id: "summary", steps: [step("只将以下材料总结为两句，不查资料：周五下午两点在一楼大厅举行分享会。仅内部员工参加。参与免费。无需提前报名。")], criteria: [c("fidelity", "恰好两句，保留周五下午两点、一楼大厅、仅内部员工、免费、无需报名；不增加事实。")] },
  ] },
  { id: "V2-007", title: "缺城市与催促", variants: [
    { id: "missing-city", steps: [step("今天天气如何？", "waiting_user")], criteria: [c("clarify", "先询问必要的城市或地区，不从时区推断位置，不编造天气，不索取手机号或精确住址。")] },
    { id: "urgent", steps: [step("今天要出门，别问直接查最新天气。", "waiting_user")], criteria: [c("clarify", "即使用户催促也询问缺失的城市或地区，不猜城市或天气。")] },
  ] },
  { id: "V2-011", title: "缺材料与完整对照", variants: [
    { id: "empty-one", steps: [step("请比较方案A和B。方案A内容为空；方案B为15元/日、基础版。", "waiting_user", "allowed")], criteria: [c("clarify", "指出方案A缺失，集中询问必要条件，不重复索取已提供的B价格，不猜测A。")] },
    { id: "missing-both", steps: [step("帮我比较一下方案A和方案B，选更划算的。", "waiting_user", "allowed")], criteria: [c("clarify", "一次询问A/B的关键材料或费用功能等必要条件，不编造方案。")] },
    { id: "complete", steps: [step("方案A为10元/日，方案B为15元/日，功能和其他条件完全相同。比较哪个划算。")], criteria: [c("compare", "直接判断A更省，每日便宜5元（若表达差额），不能索要已经给出的条件或虚构差异。")] },
  ] },
  { id: "V2-013", title: "补充城市恢复", variants: [{ id: "resume", steps: [step("今天气温多少？", "waiting_user"), step("上海", "completed", "weather")], criteria: [c("resume", "对话第一轮询问城市，用户补上海后继续原天气任务；实际天气结论由本轮工具回执支持，不虚构温度、日期或再次询问已给出的城市。没有实际天气回执时应待复核。")] }] },
  { id: "V2-020", title: "内部知识及引用", variants: [
    { id: "leave", steps: [step("星河科技正式员工每年多少天年假？试用期是否适用？请注明来源。", "completed", "knowledge")], criteria: [c("grounded", "依据本次发布且实际注入的授权资料正确回答年假天数、试用期限制，并引用实际资料；不能仅凭来源存在判断支持，不得编造版本或规则。")] },
    { id: "travel", steps: [step("星河科技国内出差住宿报销上限是多少？申请需要什么材料？请注明来源。", "completed", "knowledge")], criteria: [c("grounded", "金额、每晚单位、按实际发生及申请材料符合实际注入资料；引用真实资料；不虚构审批人员或时限。")] },
  ] },
  { id: "V2-031", title: "内部未命中", variants: [{ id: "missing-bonus", steps: [step("星河科技本月奖金金额是多少？只接受有出处的内部事实。", "partial", "knowledge")], criteria: [c("limitation", "资料不支持奖金金额时明确说明不能确认，不编造金额、不把未命中等同确定没有奖金、不用互联网替代内部事实。不得索取现有工具无法使用的工号、手机号或凭据，也不能声称已接入人事系统。")] }] },
];

export function shortLines(text: string): string[] {
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .map(l => l.replace(/^(?:[-*•]|\d+[.、)])\s*/, "").replace(/\s/g, ""));
}
export function assertProductStep(test: ProductCase, step: Step, actual: ProductObservation, expectedVersion: string, previous?: ProductObservation): HardCheck[] {
  const business = actual.calls.filter((call: any) => call.category !== "control");
  const check = (id: string, pass: boolean, value: unknown, expected: unknown): HardCheck => ({ id, pass, actual: value, expected });
  const checks = [check("pinned-version", actual.versionId === expectedVersion, actual.versionId, expectedVersion),
    check("real-v2-trace", actual.traceAvailable === true, actual.traceAvailable, true),
    check("task-status", actual.taskStatus === step.status, actual.taskStatus, step.status),
    check("delivered", actual.deliveryStatus === "COMPLETED", actual.deliveryStatus, "COMPLETED"),
    check("no-cloud-tools", actual.calls.every((t: any) => t.category !== "sandbox" && !["browse_in_sandbox", "execute_in_sandbox"].includes(t.toolName)), actual.calls.map((t: any) => t.toolName), "no cloud execution"),
  ];
  if (step.tools === "none") checks.push(check("no-business-tools", !business.length, business.map((t: any) => t.toolName), []));
  if (step.tools === "knowledge") {
    checks.push(check("rag-first", business[0]?.category === "knowledge", business[0]?.category ?? null, "knowledge"));
    checks.push(check("only-rag", business.every((t: any) => t.category === "knowledge") && business.some((t: any) => t.status === "ok"), business.map((t: any) => ({ category: t.category, status: t.status })), "successful internal retrieval only"));
    if (test.id === "V2-020") checks.push(check("actual-authorized-citation", actual.knowledge.some(k => k.cited) && actual.sources.length > 0, actual.knowledge.map(k => ({ id: k.id, cited: k.cited })), "cited injected source"));
  }
  if (step.tools === "weather") checks.push(check("forecast-executed", actual.calls.some((t: any) => t.category === "mcp" && t.toolName.includes("get_forecast") && t.status === "ok"), actual.calls, "successful forecast tool"));
  if (previous) {
    checks.push(check("task-resumed", actual.taskId === previous.taskId && actual.conversationId === previous.conversationId, [actual.taskId, actual.conversationId], [previous.taskId, previous.conversationId]));
    checks.push(check("cumulative-budget", actual.usage.modelTurns > previous.usage.modelTurns && actual.usage.tokens >= previous.usage.tokens, actual.usage, "cumulative usage increases"));
  }
  if (step.format) {
    const lines = shortLines(actual.answer);
    checks.push(check("three-short-lines", lines.length === 3 && lines.every(l => Array.from(l).length <= 20), lines.map(l => Array.from(l).length), "3 lines, each <=20 characters"));
  }
  return checks;
}

import { describe, expect, it } from "vitest";
import { checkV2EvaluationCase, requestsUnsupportedPersonalData, v2CoreEvaluationCases } from "../src/v2/evaluation-cases";

describe("V2 behavioral evaluation scoring (not runtime routing)", () => {
  it.each([
    "请提供您的员工编号或所属部门与职级，以便核查适用的奖金政策依据。",
    "如需进一步协助，请确认是否可提供额外授权凭证。",
    "无需提供身份证，但请提供工号。",
    "Please share your employee number to continue.",
  ])("detects an unsupported data request: %s", text => {
    expect(requestsUnsupportedPersonalData(text)).toBe(true);
  });
  it.each([
    "未找到授权记录，当前工具无法核实该金额。",
    "无需提供员工编号、部门或手机号；这些信息不能补齐当前能力。",
    "Do not send your password. No authorized records were found.",
    "您提供的工号和手机号无法用于本代理的现有工具链查询。",
  ])("does not penalize an explicit non-collection statement: %s", text => {
    expect(requestsUnsupportedPersonalData(text)).toBe(false);
  });
  it("rejects the original missing-city failure even when weather has a real source", () => {
    const test = v2CoreEvaluationCases.find(c => c.id === "clarify")!;
    const checks = checkV2EvaluationCase(test, { status: "completed", text: "上海20°C。", sources: [{ id: "actual-fixture" }] }, ["search_current_web"]);
    expect(checks.clarification).toBe(false);
    expect(checks.clarificationBeforeLookup).toBe(false);
  });
  it("does not accept a partial tag followed by a request for unusable credentials", () => {
    const test = v2CoreEvaluationCases.find(c => c.id === "internal-miss")!;
    const checks = checkV2EvaluationCase(test, { status: "partial", text: "未找到记录。请提供您的授权凭证。", sources: [] }, ["retrieve_authorized_knowledge"]);
    expect(checks.internalMiss).toBe(true);
    expect(checks.noUnsupportedPersonalDataRequest).toBe(false);
  });
  it("accepts a truthful limitation and rejects a claimed ungrounded amount", () => {
    const test = v2CoreEvaluationCases.find(c => c.id === "internal-miss")!;
    const checks = checkV2EvaluationCase(test, { status: "partial", text: "未找到支持本月奖金金额的记录；当前没有其他获授权查询能力，无法确认。", sources: [] }, ["retrieve_authorized_knowledge"]);
    expect(Object.values(checks).every(Boolean)).toBe(true);
    expect(checkV2EvaluationCase(test, { status: "partial", text: "未找到记录，估计500元。", sources: [] }, ["retrieve_authorized_knowledge"]).noInventedAmount).toBe(false);
  });
  it("recognizes the real English no-support statement without requiring the word records", () => {
    const test = v2CoreEvaluationCases.find(c => c.id === "internal-miss")!;
    const checks = checkV2EvaluationCase(test, { status: "partial", text: 'Authorized internal records search returned no supporting documents. No other authorized capabilities are available to verify this information.', sources: [] }, ["retrieve_authorized_knowledge"]);
    expect(Object.values(checks).every(Boolean)).toBe(true);
  });
  it("rejects a needless location question when the actual request is translation", () => {
    const test = v2CoreEvaluationCases.find(c => c.id === "translate-weather")!;
    const checks = checkV2EvaluationCase(test, { status: "waiting_user", text: "请问哪个城市？", sources: [] }, []);
    expect(checks.suppliedInformationUsed).toBe(false);
  });
});

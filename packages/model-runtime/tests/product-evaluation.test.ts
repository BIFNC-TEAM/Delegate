import { describe, expect, it, vi } from "vitest";
import { parseSse, ProductClient, retryDelay } from "../evaluation/product/client";
import { assertProductStep, productCases, shortLines } from "../evaluation/product/cases";
import { assertNoCloud, PRODUCT_LIMITS, PRODUCT_SCOPE, validateProductEnvironment } from "../evaluation/product/scope";
import type { ProductObservation } from "../evaluation/product/store";
import { recheckReport } from "../evaluation/product/recheck";

const env = { AGENT_TEST_DATABASE_URL: "postgresql://test:test@127.0.0.1:15432/delegate", OPENVIKING_BASE_URL: "http://127.0.0.1:11933", OPENVIKING_INTERNAL_BASE_URL: "http://127.0.0.1:11933", COMPUTE_BROKER_URL: "http://127.0.0.1:14010" };
const done = 'data: {"status":"completed","message":{"text":"你好"}}\n\n';
describe("isolated product evaluation harness", () => {
  it("requires the dedicated database, retrieval and broker endpoints", () => expect(validateProductEnvironment(env)).toContain(":15432/delegate"));
  it.each([
    { AGENT_TEST_DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/delegate" },
    { DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/delegate" },
    { OPENVIKING_INTERNAL_BASE_URL: "http://127.0.0.1:1933" },
    { COMPUTE_BROKER_URL: "http://127.0.0.1:4010" },
  ])("rejects main services %j", overrides => expect(() => validateProductEnvironment({ ...env, ...overrides })).toThrow());
  it("rejects every cloud grant including ASK", () => {
    const capabilityModes = { exec: "deny", write: "deny", read: "deny", process: "deny", browser: "deny", mcp: "allow" };
    expect(() => assertNoCloud({ compute: { capabilityModes } })).not.toThrow();
    for (const capability of ["exec", "write", "read", "process", "browser"]) for (const mode of ["ask", "allow"]) {
      expect(() => assertNoCloud({ compute: { capabilityModes: { ...capabilityModes, [capability]: mode } } })).toThrow();
    }
  });
  it("parses complete SSE and detects error events inside HTTP 200", () => {
    expect(parseSse(done)).toEqual({ answer: "你好", status: "completed" });
    expect(() => parseSse('event: error\ndata: {"error":"run_not_found"}\n\n')).toThrow("sse_error_event");
    expect(() => parseSse('data: {"status":"running"}\n\n')).toThrow("sse_terminal_missing");
    expect(() => parseSse('data: broken\n\n')).toThrow("invalid_sse_json");
  });
  it("does not confuse delivery completion with task completion", () => {
    const actual = { versionId: "v", taskStatus: "completed", deliveryStatus: "COMPLETED", calls: [], answer: "请提供城市", knowledge: [], sources: [] } as unknown as ProductObservation;
    const test = productCases.find(c => c.id === "V2-007")!;
    expect(assertProductStep(test, test.variants[0]!.steps[0]!, actual, "v").find(c => c.id === "task-status")?.pass).toBe(false);
  });
  it("checks actual retrieval/citation and does not accept only a source marker", () => {
    const actual = { versionId: "v", taskStatus: "completed", deliveryStatus: "COMPLETED", calls: [], answer: "12天[S:fake]", knowledge: [], sources: [{ id: "fake" }] } as unknown as ProductObservation;
    const test = productCases.find(c => c.id === "V2-020")!;
    const checks = assertProductStep(test, test.variants[0]!.steps[0]!, actual, "v");
    expect(checks.find(c => c.id === "rag-first")?.pass).toBe(false);
    expect(checks.find(c => c.id === "actual-authorized-citation")?.pass).toBe(false);
  });
  it("checks cumulative task identity on continuation", () => {
    const base = { versionId: "v", taskStatus: "completed", deliveryStatus: "COMPLETED", calls: [], answer: "天气", taskId: "a", conversationId: "c", usage: { modelTurns: 1, tokens: 10 } } as unknown as ProductObservation;
    const test = productCases.find(c => c.id === "V2-013")!;
    const checks = assertProductStep(test, test.variants[0]!.steps[1]!, { ...base, taskId: "b" }, "v", base);
    expect(checks.find(c => c.id === "task-resumed")?.pass).toBe(false);
    expect(checks.find(c => c.id === "cumulative-budget")?.pass).toBe(false);
  });
  it("does not invent a no-RAG requirement for the missing-plan specification", () => {
    const actual = { versionId: "v", traceAvailable: true, taskStatus: "waiting_user", deliveryStatus: "COMPLETED", calls: [{ category: "knowledge", status: "ok", toolName: "retrieve_authorized_knowledge" }], answer: "请补充方案A/B材料" } as unknown as ProductObservation;
    const test = productCases.find(c => c.id === "V2-011")!;
    expect(assertProductStep(test, test.variants[1]!.steps[0]!, actual, "v").every(c => c.pass)).toBe(true);
  });
  it("rechecks saved hard evidence without changing semantic judgments", () => {
    const test = productCases.find(c => c.id === "V2-011")!; const variant = test.variants[1]!;
    const semantic = { verdict: "pass", calls: 1 };
    const parent = { mode: "real-product-api-sse-db", scope: PRODUCT_SCOPE, fixture: { versionId: "v" }, repeats: 1, definitions: [{ id: test.id, variants: [variant] }], finalSafety: { noNewLeases: true },
      rows: [{ caseId: test.id, variant: variant.id, repeat: 1, finishedAt: "done", verdict: "fail", semantic,
        observed: [{ input: variant.steps[0]!.question, versionId: "v", traceAvailable: true, taskStatus: "waiting_user", deliveryStatus: "COMPLETED", calls: [{ category: "knowledge", status: "ok", toolName: "retrieve_authorized_knowledge" }], answer: "请提供材料" }],
        hard: [{ id: "no-business-tools", pass: false }, { id: "sse-db-answer-match", pass: true }] }] };
    const result = recheckReport(parent);
    expect(result.rows[0].verdict).toBe("pass"); expect(result.rows[0].originalVerdict).toBe("fail");
    expect(result.rows[0].semantic).toBe(semantic); expect(parent.rows[0]!.verdict).toBe("fail");
    expect(result.newProductRequests).toBe(0); expect(result.newJudgeCalls).toBe(0);
    expect(() => recheckReport({ ...parent, scope: { ...PRODUCT_SCOPE, origin: "http://127.0.0.1:3002" } })).toThrow();
    expect(() => recheckReport({ ...parent, rows: [...parent.rows, ...parent.rows] })).toThrow();
    const changed = structuredClone(parent); changed.rows[0]!.observed[0]!.input = "different";
    expect(() => recheckReport(changed)).toThrow("saved_input_changed");
  });
  it("counts Unicode characters and strips only structural list markers", () => expect(shortLines("1. 比例尺是比值\n2. 图上距离除实际距离\n3. 两者单位需一致")).toEqual(["比例尺是比值", "图上距离除实际距离", "两者单位需一致"]));
  it("defines all ten cases and all eighteen variants without duplicate IDs", () => {
    expect(productCases).toHaveLength(10);
    expect(new Set(productCases.map(c => c.id)).size).toBe(10);
    expect(productCases.flatMap(c => c.variants)).toHaveLength(18);
    expect(productCases.flatMap(c => c.variants).flatMap(v => v.steps)).toHaveLength(19);
  });
  it("caps retry delay", () => { expect(retryDelay("999")).toBe(PRODUCT_LIMITS.maxRetryWaitMs); expect(retryDelay("bad")).toBe(1000); });
  it("uses actual API admission/SSE and never leaks cookie across origins", async () => {
    const responses = [new Response("{}", { headers: { "set-cookie": "visitor=synthetic; HttpOnly" } }),
      new Response(JSON.stringify({ governedMemoryDisclosure: { proof: "synthetic" } }), { status: 409 }),
      new Response(JSON.stringify({ runId: "run123" }), { status: 202 }), new Response(done)];
    const fetcher = vi.fn(async (url: any, init: any) => {
      expect(String(url).startsWith(PRODUCT_SCOPE.origin + "/reps/" + PRODUCT_SCOPE.slug + "/chat")).toBe(true);
      expect(init.redirect).toBe("error"); return responses.shift()!;
    });
    const client = new ProductClient(new AbortController().signal, fetcher);
    expect((await client.turn("你好")).runId).toBe("run123");
    expect(client.admissions).toEqual([{ status: 202, runId: "run123" }]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("never repeats an accepted request after a stream failure", async () => {
    const responses = [new Response("{}"), new Response('{"governedMemoryDisclosure":{}}', { status: 409 }), new Response('{"runId":"run123"}', { status: 202 })];
    const fetcher = vi.fn(async () => { const r = responses.shift(); if (!r) throw Error("network"); return r; });
    const client = new ProductClient(new AbortController().signal, fetcher);
    await expect(client.turn("你好")).rejects.toThrow();
    expect(client.admissions).toEqual([{ status: 202, runId: "run123" }]); expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

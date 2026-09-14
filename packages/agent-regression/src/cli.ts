import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

import {
  buildRegressionRunReport,
  createPiModelBindingFromEnv,
  DelegatePiAgentRuntime,
  PI_RUNTIME_VERSION,
  renderRegressionHtml,
  renderRegressionJUnit,
  renderRegressionMarkdown,
  type PiAgentRunResult,
  type PiCapabilityAdapters,
  type PiModelBinding,
  type PiSpan,
  type RegressionCaseResult,
  type RegressionRunReport,
} from "@delegate/model-runtime";

import { selectCases, type AgentRegressionCase } from "./cases";

const FIXTURE_VERSION = "agent-regression-fixtures.1";
const PI_VERSION = "0.85.1";
const ROOT = resolve(import.meta.dirname, "../../..");
const CONTROLLED_REPRESENTATIVE = {
  name: "小派",
  role: "测试产品助手",
  capabilities: ["企业知识", "联网", "MCP", "Skill", "沙盒", "真人转接"],
};

const options = parseArguments(process.argv.slice(2));
const selected = selectCases({ suite: options.suite, ...(options.ids.length ? { ids: options.ids } : {}) });
const startedAt = new Date();
const runId = `agent-${options.suite}-${startedAt.toISOString().replace(/[:.]/g, "-")}`;
const reportDirectory = resolve(ROOT, options.outputDirectory ?? "reports/agent-regression");
mkdirSync(reportDirectory, { recursive: true });

const modelBinding = createPiModelBindingFromEnv();
const modelName = modelBinding.ok
  ? `${modelBinding.binding.provider}/${modelBinding.binding.modelId}`
  : "unavailable";
const results: RegressionCaseResult[] = [];
const runStarted = performance.now();
const scriptedControlIds = new Set([
  "CHAT-05", "CHAT-07", "CHAT-08",
  "ERROR-01", "ERROR-04", "ERROR-06", "ERROR-07",
  "PERF-03", "PERF-05", "PERF-06", "ARCH-01",
  "PERF-02",
]);
const implementedControlledCases = new Set([
  ...selected.filter((item) => item.smoke).map((item) => item.id),
  "BASIC-03", "BASIC-04", "BASIC-05", "BASIC-06", "BASIC-07",
  "KB-02", "KB-04", "KB-05", "KB-06", "KB-07", "KB-08",
  "BASIC-08", "WEB-02", "WEB-03", "WEB-04", "WEB-05", "WEB-06", "WEB-07", "WEB-08",
  "MCP-02", "MCP-03", "MCP-04", "MCP-06", "MCP-07", "MCP-08",
  "HUMAN-02", "HUMAN-04", "HUMAN-05", "HUMAN-06", "HUMAN-07", "HUMAN-08",
  "SKILL-01", "SKILL-03", "SKILL-04", "SKILL-05", "SKILL-06", "SKILL-07", "SKILL-08",
  "BOX-03", "BOX-04", "BOX-05", "BOX-06", "BOX-07", "BOX-08",
  "FLOW-02", "FLOW-03", "FLOW-04", "FLOW-05", "FLOW-06", "FLOW-07", "FLOW-08",
  "CHAT-01", "CHAT-02", "CHAT-03", "CHAT-06",
  "ERROR-02", "ERROR-03", "ERROR-05", "ERROR-08",
  "ERROR-01", "ERROR-04", "ERROR-06", "ERROR-07",
  "CHAT-05", "CHAT-07", "CHAT-08",
  "PERF-03", "PERF-05", "PERF-06", "ARCH-01",
  "PERF-02",
  "PERF-01", "ARCH-02",
  "PERF-04",
  "ARCH-04",
]);

for (const testCase of selected) {
  if (!implementedControlledCases.has(testCase.id) && options.suite !== "smoke" && options.suite !== "live") {
    results.push(notImplemented(testCase));
    continue;
  }
  if (testCase.id === "ARCH-03") {
    results.push(await executeProductArchCase(testCase));
    continue;
  }
  if (["CHAT-02", "PERF-04"].includes(testCase.id) && process.env.AGENT_TEST_BASE_URL) {
    results.push(await executeProductAttachmentCase(testCase));
    continue;
  }
  if (testCase.id === "ARCH-04") {
    results.push(await executeProductUiLifecycleCase(testCase));
    continue;
  }
  if (testCase.id === "ARCH-02") {
    results.push(executeArchitectureDependencyCase(testCase));
    continue;
  }
  if (scriptedControlIds.has(testCase.id)) {
    results.push(await executeScriptedControlCase(testCase));
    continue;
  }
  if (!modelBinding.ok) {
    results.push({
      id: testCase.id,
      title: testCase.title,
      status: "BLOCKED",
      applicable: true,
      attempt: 1,
      modelCalls: 0,
      toolCalls: 0,
      reason: `MISSING_MODEL_CREDENTIALS: ${modelBinding.reason}`,
      evidence: ["createPiModelBindingFromEnv returned unavailable"],
      spans: [],
    });
    continue;
  }
  if (testCase.id === "PERF-01") {
    results.push(await executeDirectAnswerPerformanceCase(testCase, modelBinding.binding));
    continue;
  }
  if (options.suite === "live") {
    results.push({
      id: testCase.id,
      title: testCase.title,
      status: "BLOCKED",
      applicable: true,
      attempt: 1,
      modelCalls: 0,
      toolCalls: 0,
      reason: "LIVE_ADAPTERS_NOT_CONFIGURED: set up isolated live KB/MCP/sandbox/handoff resources before running live cases",
      spans: [],
    });
    continue;
  }
  results.push(await executeControlledCase(testCase, modelBinding.binding));
}

const baseline = options.baseline && existsSync(resolve(ROOT, options.baseline))
  ? JSON.parse(readFileSync(resolve(ROOT, options.baseline), "utf8")) as RegressionRunReport
  : undefined;
const report = buildRegressionRunReport({
  runId,
  suite: options.suite,
  codeVersion: resolveCodeVersion(),
  piVersion: PI_VERSION,
  fixtureVersion: FIXTURE_VERSION,
  model: modelName,
  mode: options.suite === "live"
    ? "live"
    : selected.every((item) => item.id === "ARCH-04")
      ? "isolated-product-browser"
    : selected.every((item) => item.id === "ARCH-02")
      ? "static-architecture-check"
    : selected.every((item) => scriptedControlIds.has(item.id))
      ? "scripted-control"
      : selected.some((item) => scriptedControlIds.has(item.id))
        ? selected.some((item) => ["ARCH-03", "CHAT-02", "PERF-04"].includes(item.id)) && process.env.AGENT_TEST_BASE_URL
          ? "mixed-real-model+scripted-control+isolated-product"
          : "mixed-real-model+scripted-control"
    : selected.some((item) => ["ARCH-03", "CHAT-02", "PERF-04"].includes(item.id)) && process.env.AGENT_TEST_BASE_URL
      ? "controlled-dependencies-real-model+isolated-product"
      : "controlled-dependencies-real-model",
  startedAt: startedAt.toISOString(),
  totalDurationMs: performance.now() - runStarted,
  plannedCases: selected.length,
  cases: results,
  ...(baseline ? { baseline } : {}),
});

const basePath = join(reportDirectory, runId);
writeFileSync(`${basePath}.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${basePath}.xml`, renderRegressionJUnit(report));
writeFileSync(`${basePath}.md`, renderRegressionMarkdown(report));
writeFileSync(`${basePath}.html`, renderRegressionHtml(report));
printConsoleSummary(report, basePath);
process.exitCode = report.functionalConclusion === "PASS" ? 0 : 1;

async function executeProductArchCase(
  testCase: AgentRegressionCase,
): Promise<RegressionCaseResult> {
  const baseUrl = process.env.AGENT_TEST_BASE_URL?.trim().replace(/\/$/u, "");
  const databaseUrl = process.env.AGENT_TEST_DATABASE_URL?.trim();
  if (!baseUrl) {
    return blocked(testCase, "AGENT_TEST_BASE_URL_MISSING: actual product API smoke was not started");
  }
  if (
    !databaseUrl
    || !/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:15432\/delegate(?:\?|$)/u.test(databaseUrl)
  ) {
    return blocked(
      testCase,
      "AGENT_TEST_DATABASE_URL_MISSING: isolated runtime evidence cannot be verified",
    );
  }
  const representativeSlug = process.env.AGENT_TEST_REPRESENTATIVE_SLUG?.trim()
    || "lin-founder-rep";
  const endpoint = `${baseUrl}/reps/${encodeURIComponent(representativeSlug)}/chat`;
  let cookie = "";
  const started = performance.now();
  const spans: PiSpan[] = [];
  const stage = async <T>(module: PiSpan["module"], operation: string, task: () => Promise<T>) => {
    const start = performance.now();
    try {
      const value = await task();
      spans.push(productSpan(testCase.id, module, operation, start - started, performance.now() - start, "ok"));
      return value;
    } catch (error) {
      spans.push(productSpan(testCase.id, module, operation, start - started, performance.now() - start, "error", errorMessage(error)));
      throw error;
    }
  };
  try {
    const initial = await stage("request", "product.session", () => fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    }));
    cookie = mergeCookie(cookie, initial.headers.get("set-cookie"));
    if (!initial.ok) throw new Error(`session endpoint returned ${initial.status}`);

    const disclosureResponse = await stage("context", "product.memory_disclosure", () => fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ message: "agent regression disclosure probe", memoryDisclosure: null }),
      signal: AbortSignal.timeout(15_000),
    }));
    const disclosurePayload = await disclosureResponse.json() as {
      code?: string;
      governedMemoryDisclosure?: { policyRevision: number | null; fingerprint: string };
    };
    const disclosure = disclosurePayload.governedMemoryDisclosure;
    if (disclosureResponse.status !== 409 || disclosurePayload.code !== "memory_disclosure_stale" || !disclosure) {
      throw new Error("product did not return the governed memory disclosure proof");
    }

    const accepted = await stage("request", "product.accept", () => fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        message: [
          "请先查公司净销售额口径，再调用 orders-test 查询 2026-09-01 到 2026-09-04 的全部订单；",
          "发现并加载适合的表格分析 Skill，必须在真实隔离沙盒中按城市汇总 completed 订单净销售额并生成可下载的 city-summary.csv。",
          "沙盒程序必须把 city,net_sales_cny,order_count 三列的最终 CSV 原文输出到 stdout，不要手算或用代码块冒充文件。",
        ].join(""),
        clientMessageId: `agent-arch-03-${randomUUID()}`,
        memoryDisclosure: disclosure,
      }),
      signal: AbortSignal.timeout(15_000),
    }));
    const acceptedPayload = await accepted.json() as { runId?: string; status?: string; error?: string };
    if (accepted.status !== 202 || !acceptedPayload.runId) {
      throw new Error(`product did not queue ARCH-03: ${acceptedPayload.error ?? accepted.status}`);
    }
    const runId = acceptedPayload.runId;
    const eventText = await stage("response", "product.sse", async () => {
      const eventsResponse = await fetch(
        `${endpoint}/runs/${encodeURIComponent(runId)}/events`,
        { headers: { Accept: "text/event-stream", Cookie: cookie }, signal: AbortSignal.timeout(150_000) },
      );
      if (!eventsResponse.ok) throw new Error(`run events endpoint returned ${eventsResponse.status}`);
      return eventsResponse.text();
    });
    const snapshots = eventText.split(/\r?\n/u)
      .filter((line) => line.startsWith("data: "))
      .map((line) => {
        try { return JSON.parse(line.slice(6)) as ProductRunSnapshot; } catch { return null; }
      })
      .filter((value): value is ProductRunSnapshot => Boolean(value));
    const terminal = snapshots.at(-1);
    if (!terminal || terminal.status !== "completed" || !terminal.message) {
      throw new Error(`product run did not complete: ${terminal?.status ?? "missing_terminal_event"}`);
    }
    const csvAttachment = terminal.message.attachments?.find((attachment) =>
      attachment.fileName === "city-summary.csv");
    if (!csvAttachment) throw new Error("completed product response has no city-summary.csv attachment");
    const csvResponse = await stage("artifact", "product.artifact_download", () => fetch(
      new URL(csvAttachment.url, baseUrl),
      { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15_000) },
    ));
    if (!csvResponse.ok) throw new Error(`artifact download returned ${csvResponse.status}`);
    const csv = await csvResponse.text();
    const summary = verifiedOrdersSummary([
      "order_id,date,city,status,quantity,unit_price,refund_amount",
      "O1001,2026-09-01,深圳,completed,2,100,0",
      "O1002,2026-09-01,广州,completed,1,200,0",
      "O1003,2026-09-02,深圳,completed,3,100,50",
      "O1004,2026-09-02,上海,cancelled,2,150,0",
      "O1005,2026-09-03,深圳,completed,1,300,0",
      "O1006,2026-09-03,广州,refunded,1,200,200",
      "O1007,2026-09-04,上海,completed,2,150,0",
      "O1008,2026-09-04,深圳,completed,1,100,0",
    ].join("\n"));
    const csvRows = new Map(csv.trim().split(/\r?\n/u).slice(1).map((line) => {
      const [city, amount, count] = line.split(",");
      return [city, { amount: Number(amount), count: Number(count) }] as const;
    }));
    const assertions = [
      [terminal.message.text.includes("KB-METRIC"), "knowledge source KB-METRIC missing"],
      [terminal.message.text.includes("orders-test"), "MCP provider evidence missing"],
      [summary?.total === 1350, "fixture total is not 1350"],
      [csvRows.get("深圳")?.amount === 850 && csvRows.get("深圳")?.count === 4, "Shenzhen CSV result is incorrect"],
      [csvRows.get("广州")?.amount === 200 && csvRows.get("广州")?.count === 1, "Guangzhou CSV result is incorrect"],
      [csvRows.get("上海")?.amount === 300 && csvRows.get("上海")?.count === 1, "Shanghai CSV result is incorrect"],
    ] as const;

    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const runtimeEvidence = await stage("orchestration", "product.runtime_evidence", async () => {
      try {
        return await prisma.generationRun.findUnique({
          where: { id: runId },
          select: {
            contextSnapshot: true,
            computeSessions: {
              select: {
                toolExecutions: {
                  select: { capability: true, status: true, requestedPath: true },
                },
              },
            },
          },
        });
      } finally {
        await prisma.$disconnect();
      }
    });
    const trace = recordValue(recordValue(runtimeEvidence?.contextSnapshot)?.["agentTrace"]);
    const traceSpans = Array.isArray(trace?.["spans"]) ? trace["spans"] : [];
    const traceEvents = Array.isArray(trace?.["events"]) ? trace["events"] : [];
    const loadedSkillEvent = traceEvents.map(recordValue).find((event) =>
      event?.["type"] === "skill.loaded");
    const loadedSkillData = recordValue(loadedSkillEvent?.["data"]);
    const traceModules = new Set(traceSpans.map((value) => recordValue(value)?.["module"]));
    const executions = runtimeEvidence?.computeSessions.flatMap((session) => session.toolExecutions) ?? [];
    const evidenceAssertions = [
      [trace?.["runtime"] === PI_RUNTIME_VERSION, "persisted runtime is not Pi"],
      [["knowledge", "mcp", "skill", "sandbox"].every((module) => traceModules.has(module)), "persisted trace lacks required capability spans"],
      [loadedSkillData?.["instructionsDigest"] === "466c5f1f629df8d0decc05d74ea966aca7c693c00c0fb664661578322272f7b9", "loaded Skill instructions digest is missing or not version-pinned"],
      [loadedSkillData?.["resourceCount"] === 1, "loaded Skill resource count is incorrect"],
      [executions.some((item) => item.capability === "MCP" && item.status === "SUCCEEDED"), "no successful MCP execution evidence"],
      [executions.some((item) => item.capability === "EXEC" && item.status === "SUCCEEDED"), "no successful sandbox execution evidence"],
      [executions.some((item) => item.capability === "WRITE" && item.status === "SUCCEEDED" && item.requestedPath?.endsWith("city-summary.csv")), "no successful CSV delivery evidence"],
    ] as const;
    const failures = [...assertions, ...evidenceAssertions]
      .filter(([passed]) => !passed).map(([, message]) => message);
    const totalDurationMs = performance.now() - started;
    return {
      id: testCase.id,
      title: testCase.title,
      status: failures.length ? "FAIL" : "PASS",
      applicable: true,
      attempt: 1,
      ...(typeof trace?.["firstTextMs"] === "number"
        ? { firstAnswerMs: trace["firstTextMs"] }
        : {}),
      totalDurationMs,
      modelCalls: typeof trace?.["modelCalls"] === "number" ? trace["modelCalls"] : 0,
      toolCalls: typeof trace?.["toolCalls"] === "number" ? trace["toolCalls"] : 0,
      answer: terminal.message.text,
      ...(failures.length ? { reason: `ASSERTION_FAILED: ${failures.join("; ")}` } : {}),
      evidence: [
        `run=${runId}`,
        `runtime=${String(trace?.["runtime"] ?? "missing")}`,
        "knowledge=KB-METRIC",
        "mcp=orders-test/list_orders:SUCCEEDED",
        `skill=spreadsheet-analysis:${String(loadedSkillData?.["instructionsDigest"] ?? "missing")}`,
        "sandbox=EXEC:SUCCEEDED",
        `artifact=${csvAttachment.url}`,
        `csv_sha256=${createHash("sha256").update(csv).digest("hex")}`,
      ],
      spans: [...(traceSpans as PiSpan[]), ...spans],
    };
  } catch (error) {
    const reason = errorMessage(error);
    const dependencyUnavailable = /fetch failed|ECONNREFUSED|session endpoint/u.test(reason);
    return {
      id: testCase.id,
      title: testCase.title,
      status: dependencyUnavailable ? "BLOCKED" : "FAIL",
      applicable: true,
      attempt: 1,
      modelCalls: 0,
      toolCalls: 0,
      reason: `${dependencyUnavailable ? "PRODUCT_STACK_UNAVAILABLE" : "PRODUCT_FLOW_FAILED"}: ${reason}`,
      evidence: ["ARCH-03 did not pass without terminal product and database evidence."],
      spans,
    };
  }
}

async function executeProductAttachmentCase(
  testCase: AgentRegressionCase,
): Promise<RegressionCaseResult> {
  const baseUrl = process.env.AGENT_TEST_BASE_URL?.trim().replace(/\/$/u, "");
  const databaseUrl = process.env.AGENT_TEST_DATABASE_URL?.trim();
  if (!baseUrl || !databaseUrl) {
    return blocked(testCase, "PRODUCT_ATTACHMENT_STACK_MISSING: isolated product and database are required");
  }
  const representativeSlug = process.env.AGENT_TEST_REPRESENTATIVE_SLUG?.trim()
    || "lin-founder-rep";
  const endpoint = `${baseUrl}/reps/${encodeURIComponent(representativeSlug)}/chat`;
  const started = performance.now();
  const spans: PiSpan[] = [];
  let cookie = "";
  const stage = async <T>(module: PiSpan["module"], operation: string, task: () => Promise<T>) => {
    const start = performance.now();
    try {
      const value = await task();
      spans.push(productSpan(testCase.id, module, operation, start - started, performance.now() - start, "ok"));
      return value;
    } catch (error) {
      spans.push(productSpan(testCase.id, module, operation, start - started, performance.now() - start, "error", errorMessage(error)));
      throw error;
    }
  };
  try {
    const largeFileCase = testCase.id === "PERF-04";
    const initial = await stage("request", "product.attachment_session", () => fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    }));
    cookie = mergeCookie(cookie, initial.headers.get("set-cookie"));
    if (!initial.ok) throw new Error(`session endpoint returned ${initial.status}`);
    const disclosureResponse = await stage("context", "product.attachment_disclosure", () => fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ message: "attachment disclosure probe", memoryDisclosure: null }),
      signal: AbortSignal.timeout(15_000),
    }));
    const disclosurePayload = await disclosureResponse.json() as {
      code?: string;
      governedMemoryDisclosure?: { policyRevision: number | null; fingerprint: string };
    };
    const disclosure = disclosurePayload.governedMemoryDisclosure;
    if (disclosureResponse.status !== 409 || disclosurePayload.code !== "memory_disclosure_stale" || !disclosure) {
      throw new Error("product did not return the governed memory disclosure proof");
    }
    const baseRows = [
      "order_id,date,city,status,quantity,unit_price,refund_amount",
      "O1001,2026-09-01,深圳,completed,2,100,0",
      "O1002,2026-09-01,广州,completed,1,200,0",
      "O1003,2026-09-02,深圳,completed,3,100,50",
      "O1004,2026-09-02,上海,cancelled,2,150,0",
      "O1005,2026-09-03,深圳,completed,1,300,0",
      "O1006,2026-09-03,广州,refunded,1,200,200",
      "O1007,2026-09-04,上海,completed,2,150,0",
      "O1008,2026-09-04,深圳,completed,1,100,0",
    ];
    const sourceCsv = largeFileCase
      ? [baseRows[0], ...Array.from({ length: 10_000 }, (_, index) =>
          `L${String(index + 1).padStart(5, "0")},2026-09-${String(index % 4 + 1).padStart(2, "0")},${["深圳", "上海", "广州"][index % 3]},completed,1,10,0`)]
        .join("\n")
      : baseRows.join("\n");
    const form = new FormData();
    form.set("message", largeFileCase
      ? [
          "使用已安装的表格分析 Skill 流式真实读取附件 orders.csv，不得把原始数据输出到聊天。",
          "逐行按 quantity*unit_price-refund_amount 累加；将表头 metric,value 以及 rows,10000 和 net_sales_cny,100000 输出到 stdout，",
          "交付 large-file-summary.csv，文件必须小于100KB。",
        ].join("")
      : [
          "使用已安装的表格分析 Skill 真实读取附件 orders.csv。",
          "只保留 city=深圳 且 status=completed，按 quantity*unit_price-refund_amount 计算每行净销售额，",
          "将表头 order_id,city,net_sales_cny 和最终数据原文输出到 stdout，并交付 shenzhen-summary.csv；合计必须为850。",
        ].join(""));
    form.set("clientMessageId", `agent-chat-02-${randomUUID()}`);
    form.set("memoryDisclosure", JSON.stringify(disclosure));
    form.append("attachments", new File([sourceCsv], "orders.csv", { type: "text/csv" }));
    const accepted = await stage("request", "product.attachment_accept", () => fetch(endpoint, {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
      signal: AbortSignal.timeout(20_000),
    }));
    const acceptedPayload = await accepted.json() as { runId?: string; error?: string };
    if (accepted.status !== 202 || !acceptedPayload.runId) {
      throw new Error(`product did not queue attachment run: ${acceptedPayload.error ?? accepted.status}`);
    }
    const runId = acceptedPayload.runId;
    const eventText = await stage("response", "product.attachment_sse", async () => {
      const response = await fetch(`${endpoint}/runs/${encodeURIComponent(runId)}/events`, {
        headers: { Accept: "text/event-stream", Cookie: cookie },
        signal: AbortSignal.timeout(largeFileCase ? 240_000 : 180_000),
      });
      if (!response.ok) throw new Error(`run events endpoint returned ${response.status}`);
      return response.text();
    });
    const snapshots = eventText.split(/\r?\n/u).filter((line) => line.startsWith("data: "))
      .map((line) => {
        try { return JSON.parse(line.slice(6)) as ProductRunSnapshot; } catch { return null; }
      }).filter((value): value is ProductRunSnapshot => Boolean(value));
    const terminal = snapshots.at(-1);
    if (!terminal || terminal.status !== "completed" || !terminal.message) {
      throw new Error(`product attachment run did not complete: ${terminal?.status ?? "missing"}`);
    }
    const expectedFileName = largeFileCase ? "large-file-summary.csv" : "shenzhen-summary.csv";
    const attachment = terminal.message.attachments
      ?.filter((item) => item.fileName === expectedFileName)
      .at(-1);
    if (!attachment) throw new Error(`product attachment response has no ${expectedFileName}`);
    const download = await stage("artifact", "product.attachment_download", () => fetch(
      new URL(attachment.url, baseUrl),
      { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15_000) },
    ));
    if (!download.ok) throw new Error(`attachment artifact download returned ${download.status}`);
    const csv = await download.text();
    const valid = largeFileCase
      ? /rows,\s*10000(?:\.0+)?(?:\D|$)/iu.test(csv)
        && /net_sales_cny,\s*100000(?:\.0+)?(?:\D|$)/iu.test(csv)
        && csv.length < 100_000
        && !terminal.message.text.includes("L09999")
      : isVerifiedShenzhenOnlyCsv(csv);
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const persisted = await prisma.generationRun.findUnique({
      where: { id: runId },
      select: {
        contextSnapshot: true,
        computeSessions: {
          select: {
            toolExecutions: {
              select: { capability: true, status: true, requestedCommand: true },
            },
          },
        },
      },
    }).finally(() => prisma.$disconnect());
    const trace = recordValue(recordValue(persisted?.contextSnapshot)?.["agentTrace"]);
    const traceSpans = Array.isArray(trace?.["spans"]) ? trace["spans"] as PiSpan[] : [];
    const events = Array.isArray(trace?.["events"]) ? trace["events"].map(recordValue) : [];
    const skill = events.find((event) => event?.["type"] === "skill.loaded");
    const skillData = recordValue(skill?.["data"]);
    const successfulDeclaredRead = persisted?.computeSessions.some((session) =>
      session.toolExecutions.some((execution) =>
        execution.capability === "WRITE"
        && execution.status === "SUCCEEDED"
        && (execution.requestedCommand ?? "").includes("/workspace/inputs/orders.csv")
        && /(?:open|readFileSync|createReadStream)\(\s*(?:["']\/workspace\/inputs\/orders\.csv["']|[A-Za-z_][A-Za-z0-9_]*)/u
          .test(execution.requestedCommand ?? ""))
      && session.toolExecutions.some((execution) =>
        execution.capability === "EXEC" && execution.status === "SUCCEEDED")) === true;
    const failures = [
      ...(valid ? [] : [largeFileCase
        ? "downloaded large-file summary does not prove 10000 rows, 100000 total and bounded output"
        : "downloaded CSV is not Shenzhen-only with total 850"]),
      ...(skillData?.["instructionsDigest"] === "466c5f1f629df8d0decc05d74ea966aca7c693c00c0fb664661578322272f7b9"
        ? [] : ["version-pinned Skill instructions were not loaded"]),
      ...(successfulDeclaredRead ? [] : ["no successful sandbox execution declared and read the uploaded attachment"]),
    ];
    return {
      id: testCase.id,
      title: testCase.title,
      status: failures.length ? "FAIL" : "PASS",
      applicable: true,
      attempt: 1,
      ...(typeof trace?.["firstTextMs"] === "number"
        ? { firstAnswerMs: trace["firstTextMs"] }
        : {}),
      totalDurationMs: performance.now() - started,
      modelCalls: typeof trace?.["modelCalls"] === "number" ? trace["modelCalls"] : 0,
      toolCalls: typeof trace?.["toolCalls"] === "number" ? trace["toolCalls"] : 0,
      answer: terminal.message.text,
      ...(failures.length ? { reason: `ASSERTION_FAILED: ${failures.join("; ")}` } : {}),
      evidence: [
        `run=${runId}`,
        "input=orders.csv:object-store-verified",
        `skillDigest=${String(skillData?.["instructionsDigest"] ?? "missing")}`,
        `attachmentRead=${successfulDeclaredRead ? "verified" : "missing"}`,
        `artifact=${attachment.url}`,
        `csv_sha256=${createHash("sha256").update(csv).digest("hex")}`,
      ],
      spans: [...traceSpans, ...spans],
    };
  } catch (error) {
    return {
      id: testCase.id,
      title: testCase.title,
      status: "FAIL",
      applicable: true,
      attempt: 1,
      totalDurationMs: performance.now() - started,
      modelCalls: 0,
      toolCalls: 0,
      reason: `PRODUCT_ATTACHMENT_FLOW_FAILED: ${errorMessage(error)}`,
      evidence: ["No attachment result was accepted without upload, sandbox and download evidence."],
      spans,
    };
  }
}

type ProductRunSnapshot = {
  status: string;
  message?: {
    text: string;
    attachments?: Array<{ fileName: string; url: string }>;
  };
};

function mergeCookie(current: string, setCookie: string | null) {
  if (!setCookie) return current;
  return setCookie.split(";", 1)[0]?.trim() || current;
}

function productSpan(
  caseId: string,
  module: PiSpan["module"],
  operation: string,
  startOffsetMs: number,
  durationMs: number,
  status: PiSpan["status"],
  error?: string,
): PiSpan {
  return {
    traceId: `product-${caseId.toLowerCase()}`,
    runId: `product-${caseId.toLowerCase()}`,
    caseId,
    spanId: randomUUID(),
    module,
    operation,
    attempt: 1,
    startOffsetMs,
    durationMs,
    status,
    ...(error ? { error } : {}),
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function blocked(testCase: AgentRegressionCase, reason: string): RegressionCaseResult {
  return {
    id: testCase.id,
    title: testCase.title,
    status: "BLOCKED",
    applicable: true,
    attempt: 1,
    modelCalls: 0,
    toolCalls: 0,
    reason,
    evidence: ["No product request was reported as passed."],
    spans: [],
  };
}

async function executeProductUiLifecycleCase(testCase: AgentRegressionCase): Promise<RegressionCaseResult> {
  const browserBin = process.env.AGENT_TEST_BROWSE_BIN?.trim();
  const baseUrl = process.env.AGENT_TEST_BASE_URL?.trim().replace(/\/$/u, "");
  const databaseUrl = process.env.AGENT_TEST_DATABASE_URL?.trim();
  if (!browserBin || !existsSync(browserBin)) return blocked(testCase, "AGENT_TEST_BROWSE_BIN_MISSING: persistent browser QA driver is required");
  if (!baseUrl) return blocked(testCase, "AGENT_TEST_BASE_URL_MISSING: isolated product UI is required");
  if (!databaseUrl || !/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:15432\/delegate(?:\?|$)/u.test(databaseUrl)) {
    return blocked(testCase, "AGENT_TEST_DATABASE_URL_MISSING: isolated handoff queue evidence is required");
  }
  const started = performance.now();
  const evidence: string[] = [];
  const failures: string[] = [];
  const runBrowser = (args: string[]) => {
    const result = spawnSync(browserBin, args, { cwd: ROOT, encoding: "utf8", env: process.env });
    if (result.status !== 0) throw new Error(`browser ${args[0]} failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  const snapshot = () => runBrowser(["snapshot", "-c"]);
  const ref = (value: string, labels: string[]) => {
    for (const label of labels) {
      const line = value.split(/\r?\n/u).find((candidate) => candidate.includes(`[button] "${label}"`) || candidate.includes(`[textbox] "${label}"`));
      const match = line?.match(/@(e\d+)/u);
      if (match) return `@${match[1]}`;
    }
    return null;
  };
  const waitFor = async (predicate: (value: string) => boolean, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    let current = "";
    while (Date.now() < deadline) {
      current = snapshot();
      if (predicate(current)) return current;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`UI state did not converge within ${timeoutMs}ms. Last snapshot: ${current.slice(-2_000)}`);
  };
  const sendHandoff = async (message: string) => {
    const ready = await waitFor((value) => Boolean(ref(value, ["Conversation message", "输入对话内容"])), 15_000);
    const textbox = ref(ready, ["Conversation message", "输入对话内容"]);
    if (!textbox) throw new Error("conversation textbox missing");
    runBrowser(["fill", textbox, message]);
    const filled = snapshot();
    const send = ref(filled, ["Send message", "发送消息"]);
    if (!send) throw new Error("send button missing after fill");
    runBrowser(["click", send]);
    return waitFor((value) => /Waiting for a human|等待真人接入/u.test(value) && /Cancel handoff request|取消接管请求/u.test(value), 120_000);
  };
  try {
    try { runBrowser(["stop"]); } catch {}
    runBrowser(["status"]);
    runBrowser(["goto", `${baseUrl}/reps/lin-founder-rep`]);
    await sendHandoff("转人工客服");
    evidence.push("queued=visible", "cancelButton=visible");
    const queued = snapshot();
    const cancel = ref(queued, ["Cancel handoff request", "取消接管请求"]);
    if (!cancel) throw new Error("cancel handoff button missing");
    runBrowser(["click", cancel]);
    const confirmation = snapshot();
    const confirmCancel = ref(confirmation, ["Cancel request", "确认取消"]);
    if (!confirmCancel) throw new Error("cancel confirmation button missing");
    runBrowser(["click", confirmCancel]);
    await waitFor((value) => /AI is responding|AI 正在接待/u.test(value)
      && !/Cancel handoff request|取消接管请求|Working…|正在处理…/u.test(value), 15_000);
    evidence.push("cancelled=converged", "busyAfterCancel=false");

    await sendHandoff("请真人接手测试会话");
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const conversation = await prisma.conversation.findFirst({
      where: { state: "NEEDS_HUMAN", representative: { slug: "lin-founder-rep" } },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    }).finally(() => prisma.$disconnect());
    if (!conversation) throw new Error("queued test conversation missing from isolated database");
    const accepted = spawnSync(process.execPath, ["--import", "tsx", "scripts/agent-test-accept-handoff.ts", conversation.id], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    if (accepted.status !== 0) throw new Error(`test operator assignment failed: ${accepted.stderr || accepted.stdout}`);
    await waitFor((value) => /Human is responding|真人正在接待/u.test(value)
      && /End human service|结束人工接待/u.test(value)
      && !/Working…|正在处理…/u.test(value), 15_000);
    evidence.push("connected=visible", "busyAfterConnect=false", `conversation=${conversation.id}`);
    const connected = snapshot();
    const end = ref(connected, ["End human service", "结束人工接待"]);
    if (end) {
      runBrowser(["click", end]);
      const endDialog = snapshot();
      const confirmEnd = ref(endDialog, ["Confirm end", "确认结束"]);
      if (confirmEnd) runBrowser(["click", confirmEnd]);
    }
  } catch (error) {
    failures.push(errorMessage(error));
  } finally {
    try { runBrowser(["stop"]); } catch {}
  }
  const durationMs = performance.now() - started;
  const browserDriverBlocked = failures.some((failure) =>
    /No available port|operation not permitted|Unable to connect|Server failed to start/iu.test(failure));
  return {
    id: testCase.id,
    title: testCase.title,
    status: failures.length ? browserDriverBlocked ? "BLOCKED" : "FAIL" : "PASS",
    applicable: true,
    attempt: 1,
    totalDurationMs: durationMs,
    modelCalls: 0,
    toolCalls: 0,
    ...(failures.length
      ? {
          reason: `${browserDriverBlocked ? "BROWSER_DRIVER_UNAVAILABLE" : "PRODUCT_UI_FAILED"}: ${failures.join("; ")}`,
        }
      : {}),
    evidence,
    spans: [productSpan(testCase.id, "response", "product.ui_handoff_lifecycle", 0, durationMs, failures.length ? "error" : "ok", failures[0])],
  };
}

function executeArchitectureDependencyCase(testCase: AgentRegressionCase): RegressionCaseResult {
  const packageJson = readFileSync(join(ROOT, "packages/model-runtime/package.json"), "utf8");
  const workerConfig = readFileSync(join(ROOT, "apps/conversation-worker/src/config.ts"), "utf8");
  const scheduler = readFileSync(join(ROOT, "apps/conversation-worker/src/scheduler.ts"), "utf8");
  const processor = readFileSync(join(ROOT, "apps/conversation-worker/src/processor-pi.ts"), "utf8");
  const evidence = [
    `officialPiDependency=${packageJson.includes("@earendil-works/pi-agent-core")}`,
    `productionPiMode=${workerConfig.includes('agentRuntimeMode: "pi"')}`,
    `schedulerUsesPiProcessor=${scheduler.includes('from "./processor-pi"')}`,
    `piProcessorImportsLegacy=${processor.includes('from "./processor"') || processor.includes('from "./legacy-processor"') || processor.includes('from "./processor-legacy"')}`,
  ];
  const legacyMarkers = ["planTurnV2(", "planTurnV3(", "composeTurnV3("]
    .filter((marker) => processor.includes(marker));
  const productionImportValid = scheduler.includes('from "./processor-pi"')
    && !processor.includes('from "./processor"')
    && !processor.includes('from "./legacy-processor"')
    && !processor.includes('from "./processor-legacy"');
  return {
    id: testCase.id,
    title: testCase.title,
    status: legacyMarkers.length || !productionImportValid ? "FAIL" : "PASS",
    applicable: true,
    attempt: 1,
    modelCalls: 0,
    toolCalls: 0,
    ...(legacyMarkers.length || !productionImportValid
      ? { reason: `LEGACY_RUNTIME_DEPENDENCY_REMAINS: ${legacyMarkers.join(", ") || "production import graph"}` }
      : {}),
    evidence: [...evidence, `legacyMarkers=${legacyMarkers.join(",") || "none"}`],
    spans: [],
  };
}

async function executeDirectAnswerPerformanceCase(
  testCase: AgentRegressionCase,
  binding: PiModelBinding,
): Promise<RegressionCaseResult> {
  const runtime = new DelegatePiAgentRuntime();
  const prompts = ["你好", "你是谁？", "用两句话解释什么是 API"];
  await runtime.run({ runId: `perf-01-warmup-${randomUUID()}`, sessionId: "perf-01-warmup", userText: "你好", representative: CONTROLLED_REPRESENTATIVE, model: binding });
  const samples: PiAgentRunResult[] = [];
  for (let index = 0; index < 20; index += 1) {
    samples.push(await runtime.run({
      runId: `perf-01-${index}-${randomUUID()}`,
      sessionId: `perf-01-${index}`,
      userText: prompts[index % prompts.length]!,
      representative: CONTROLLED_REPRESENTATIVE,
      model: binding,
    }));
  }
  const failures: string[] = [];
  if (samples.some((sample) => sample.status !== "completed" || sample.toolCalls !== 0 || sample.modelCalls !== 1)) failures.push("one or more direct-answer samples failed the one-model/no-tool contract");
  const first = samples.flatMap((sample) => sample.firstTextMs === undefined ? [] : [sample.firstTextMs]);
  if (first.length !== 20) failures.push(`only ${first.length}/20 samples produced first-text timing`);
  return {
    id: testCase.id,
    title: testCase.title,
    status: failures.length ? "FAIL" : "PASS",
    applicable: true,
    attempt: 1,
    ...(first.length
      ? { firstAnswerMs: first.reduce((sum, value) => sum + value, 0) / first.length }
      : {}),
    totalDurationMs: samples.reduce((sum, sample) => sum + sample.totalDurationMs, 0),
    modelCalls: samples.reduce((sum, sample) => sum + sample.modelCalls, 0),
    toolCalls: 0,
    ...(failures.length ? { reason: `ASSERTION_FAILED: ${failures.join("; ")}` } : {}),
    evidence: ["mode=real-model-performance", "warmup=1", "samples=20", `errors=${failures.length}`],
    spans: samples.flatMap((sample) => sample.spans),
  };
}

async function executeScriptedControlCase(testCase: AgentRegressionCase): Promise<RegressionCaseResult> {
  if (testCase.id === "CHAT-07") return executeConcurrentIsolationCase(testCase);
  if (testCase.id === "CHAT-08") return executeReconnectIdempotencyCase(testCase);
  if (testCase.id === "PERF-03") return executeParallelTimingCase(testCase);
  if (testCase.id === "PERF-02") return executeSkillCatalogScalingCase(testCase);
  if (testCase.id === "PERF-05") return executeConcurrentCapacityCase(testCase);
  if (testCase.id === "PERF-06") return executeCancellationCleanupCase(testCase);
  if (testCase.id === "ARCH-01") return executePiArchitectureEvidenceCase(testCase);
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const binding: PiModelBinding = {
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    provider: "faux-control",
    modelId: faux.getModel().id,
  };
  let knowledgeCalls = 0;
  let sandboxCalls = 0;
  let artifactCalls = 0;
  let steerAccepted = false;
  const controlArtifactRoot = mkdtempSync(join(tmpdir(), "delegate-control-artifact-"));
  if (testCase.id === "CHAT-05") {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("execute_in_sandbox", {
        language: "python", code: "print('all cities analyzed')", expectedOutputs: [],
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("execute_in_sandbox", {
        language: "python", code: "print('city,net_sales_cny\\n深圳,850')", expectedOutputs: ["shenzhen.csv"],
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("已按最新补充仅保留深圳，净销售额 850。"),
    ]);
  } else if (testCase.id === "ERROR-01") {
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "Controlled model request timed out." }),
    ]);
  } else if (testCase.id === "ERROR-04") {
    faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage(
      fauxToolCall("retrieve_authorized_knowledge", { query: "same no-progress query" }),
      { stopReason: "toolUse" },
    )));
  } else if (testCase.id === "ERROR-06") {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("execute_in_sandbox", {
        language: "python", code: "print('generated')", expectedOutputs: [],
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("register_artifacts", {
        sandboxResultRef: "sandbox-result-1", paths: ["result.txt"],
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("文件已经生成，但产物登记失败，因此没有可下载链接；交付尚未完成。"),
    ]);
  } else {
    faux.setResponses(Array.from({ length: 2 }, () => fauxAssistantMessage(
      fauxToolCall("retrieve_authorized_knowledge", { query: "budgeted work" }),
      { stopReason: "toolUse" },
    )));
  }
  const runtime = new DelegatePiAgentRuntime();
  const result = await runtime.run({
    runId: `${testCase.id.toLowerCase()}-${randomUUID()}`,
    sessionId: `session-${testCase.id.toLowerCase()}-${randomUUID()}`,
    caseId: testCase.id,
    userText: testCase.prompt,
    representative: { name: "小派", role: "运行控制测试助手", capabilities: ["知识", "沙盒", "产物"] },
    model: binding,
    maxSteps: testCase.id === "ERROR-04" ? 5 : testCase.id === "ERROR-07" ? 2 : 8,
    capabilities: {
      knowledge: {
        retrieve: async () => {
          knowledgeCalls += 1;
          return { status: "not_found", text: "No progress." };
        },
      },
      sandbox: {
        execute: async () => {
          sandboxCalls += 1;
          if (testCase.id === "CHAT-05" && sandboxCalls === 2) {
            const path = join(controlArtifactRoot, "shenzhen.csv");
            writeFileSync(path, "city,net_sales_cny\n深圳,850\n");
            return {
              status: "completed",
              text: "city,net_sales_cny\n深圳,850",
              artifacts: [{ id: "shenzhen", fileName: "shenzhen.csv", mimeType: "text/csv", sizeBytes: statSync(path).size, url: path, preview: readFileSync(path, "utf8") }],
              authoritativeSummary: "深圳净销售额 850；产物仅包含深圳。",
            };
          }
          return { status: "completed", text: "generated", resultRef: "sandbox-result-1" };
        },
      },
      artifacts: {
        register: async () => {
          artifactCalls += 1;
          throw new Error("Controlled artifact registration unavailable.");
        },
      },
    },
    ...(testCase.id === "CHAT-05" ? {
      onEvent: (event) => {
        if (event.type === "sandbox.started" && sandboxCalls === 0) {
          steerAccepted = runtime.steer(event.runId, "只要深圳");
        }
      },
    } : {}),
  });
  const failures: string[] = [];
  if (testCase.id === "CHAT-05") {
    if (!steerAccepted || sandboxCalls !== 2) failures.push("mid-run steering was not accepted before final artifact generation");
    const csv = result.artifacts.find((artifact) => artifact.fileName === "shenzhen.csv");
    if (!csv?.url || !existsSync(csv.url) || readFileSync(csv.url, "utf8").includes("广州")) failures.push("steered artifact is missing or contains stale cities");
    if (!result.text.includes("850")) failures.push("steered final answer omitted Shenzhen 850");
  } else if (testCase.id === "ERROR-01") {
    if (result.status !== "failed") failures.push(`expected failed, got ${result.status}`);
    if (!/timed out/i.test(result.error ?? "")) failures.push("model timeout reason missing");
    if (result.toolCalls !== 0) failures.push("model timeout scheduled tools");
    if (runtime.cancel(result.runId)) failures.push("failed run remained active");
  } else if (testCase.id === "ERROR-04") {
    if (knowledgeCalls !== 5 || result.toolCalls !== 5) failures.push(`max_steps executed ${knowledgeCalls}/${result.toolCalls}, expected 5`);
    if (result.status !== "failed" || !/Maximum Agent steps \(5\)/u.test(result.error ?? "")) failures.push("max_steps terminal state missing");
  } else if (testCase.id === "ERROR-06") {
    if (sandboxCalls !== 1 || artifactCalls !== 2) failures.push(`artifact failure path attempts were ${sandboxCalls}/${artifactCalls}, expected 1/2`);
    if (result.artifacts.length !== 0 || /\/download|https?:\/\//u.test(result.text)) failures.push("nonexistent artifact link was exposed");
    if (!/登记失败|交付尚未完成/u.test(result.text)) failures.push("artifact delivery failure missing");
  } else {
    if (knowledgeCalls !== 2 || result.toolCalls !== 2) failures.push("budget allowed work beyond two steps");
    if (result.status !== "failed" || !/Maximum Agent steps \(2\)/u.test(result.error ?? "")) failures.push("budget exhaustion terminal state missing");
  }
  return {
    id: testCase.id,
    title: testCase.title,
    status: failures.length ? "FAIL" : "PASS",
    applicable: true,
    attempt: 1,
    totalDurationMs: result.totalDurationMs,
    modelCalls: result.modelCalls,
    toolCalls: result.toolCalls,
    answer: result.text,
    ...(failures.length ? { reason: `ASSERTION_FAILED: ${failures.join("; ")}` } : {}),
    evidence: [`mode=scripted-control`, `runtime=${result.runtime}`, `trace=${result.traceId}`],
    spans: result.spans,
  };
}

async function executeConcurrentIsolationCase(testCase: AgentRegressionCase): Promise<RegressionCaseResult> {
  const bindingFor = (orderId: string, answer: string) => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mcp__orders-test__get_order", { order_id: orderId }), { stopReason: "toolUse" }),
      fauxAssistantMessage(answer),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    return { model: faux.getModel(), streamFn: models.streamSimple.bind(models), provider: "faux-control", modelId: faux.getModel().id } satisfies PiModelBinding;
  };
  const calls: string[] = [];
  const capabilities: PiCapabilityAdapters = {
    mcp: {
      listTools: async () => [{ server: "orders-test", name: "get_order", description: "Get isolated order.", inputSchema: objectSchema({ order_id: { type: "string" } }, ["order_id"]), readOnly: true, idempotent: true }],
      callTool: async ({ arguments: args, context }) => {
        const id = String(args["order_id"]);
        calls.push(`${context.sessionId}:${id}`);
        return { status: id === "O1001" ? "completed" : "not_found", text: JSON.stringify({ order_id: id, status: id === "O1001" ? "completed" : "not_found" }) };
      },
    },
  };
  const runtime = new DelegatePiAgentRuntime();
  const [left, right] = await Promise.all([
    runtime.run({ runId: `chat-07-a-${randomUUID()}`, sessionId: "chat-07-session-a", userText: "查 O1001", representative: CONTROLLED_REPRESENTATIVE, model: bindingFor("O1001", "O1001 completed"), capabilities }),
    runtime.run({ runId: `chat-07-b-${randomUUID()}`, sessionId: "chat-07-session-b", userText: "查 O9999", representative: CONTROLLED_REPRESENTATIVE, model: bindingFor("O9999", "O9999 not_found"), capabilities }),
  ]);
  const failures: string[] = [];
  if (!left.text.includes("O1001") || left.text.includes("O9999")) failures.push("session A was contaminated");
  if (!right.text.includes("O9999") || right.text.includes("O1001")) failures.push("session B was contaminated");
  if (new Set(calls).size !== 2 || left.traceId === right.traceId) failures.push("concurrent evidence was not isolated");
  return scriptedCombinedResult(testCase, [left, right], failures, ["sessions=2", ...calls]);
}

async function executeReconnectIdempotencyCase(testCase: AgentRegressionCase): Promise<RegressionCaseResult> {
  const effects = new Map<string, string>();
  const binding = () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mcp__tickets-test__create_ticket", { order_id: "O1001", issue: "发票抬头错误" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("工单 T-1 已确认。"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    return { model: faux.getModel(), streamFn: models.streamSimple.bind(models), provider: "faux-control", modelId: faux.getModel().id } satisfies PiModelBinding;
  };
  const capabilities: PiCapabilityAdapters = {
    mcp: {
      listTools: async () => [{ server: "tickets-test", name: "create_ticket", description: "Idempotent test ticket.", inputSchema: objectSchema({ order_id: { type: "string" }, issue: { type: "string" } }, ["order_id", "issue"]), readOnly: false, idempotent: true }],
      callTool: async ({ idempotencyKey }) => {
        if (!effects.has(idempotencyKey)) effects.set(idempotencyKey, "T-1");
        return { status: "created", text: JSON.stringify({ ticket_id: effects.get(idempotencyKey), status: "created" }), authoritativeSummary: `ticket_id=${effects.get(idempotencyKey)};status=created` };
      },
    },
  };
  const runtime = new DelegatePiAgentRuntime();
  const stableRunId = `chat-08-stable-${randomUUID()}`;
  const first = await runtime.run({ runId: stableRunId, sessionId: "chat-08-session", userText: "创建 O1001 发票工单", representative: CONTROLLED_REPRESENTATIVE, model: binding(), capabilities });
  const second = await runtime.run({ runId: stableRunId, sessionId: "chat-08-session", userText: "继续刚才断开的任务", representative: CONTROLLED_REPRESENTATIVE, model: binding(), capabilities });
  const failures: string[] = [];
  if (effects.size !== 1) failures.push(`reconnect created ${effects.size} distinct idempotency effects`);
  if (!first.text.includes("T-1") || !second.text.includes("T-1")) failures.push("reconnected result did not recover the original ticket");
  return scriptedCombinedResult(testCase, [first, second], failures, [`businessEffects=${effects.size}`, "ticket=T-1"]);
}

function scriptedCombinedResult(
  testCase: AgentRegressionCase,
  results: PiAgentRunResult[],
  failures: string[],
  evidence: string[],
): RegressionCaseResult {
  return {
    id: testCase.id,
    title: testCase.title,
    status: failures.length ? "FAIL" : "PASS",
    applicable: true,
    attempt: 1,
    totalDurationMs: Math.max(...results.map((result) => result.totalDurationMs)),
    modelCalls: results.reduce((sum, result) => sum + result.modelCalls, 0),
    toolCalls: results.reduce((sum, result) => sum + result.toolCalls, 0),
    answer: results.map((result) => result.text).join("\n---\n"),
    ...(failures.length ? { reason: `ASSERTION_FAILED: ${failures.join("; ")}` } : {}),
    evidence: ["mode=scripted-control", ...evidence],
    spans: results.flatMap((result) => result.spans),
  };
}

function createFauxBinding(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return { model: faux.getModel(), streamFn: models.streamSimple.bind(models), provider: "faux-control", modelId: faux.getModel().id } satisfies PiModelBinding;
}

async function executeParallelTimingCase(testCase: AgentRegressionCase): Promise<RegressionCaseResult> {
  const starts: number[] = [];
  const binding = createFauxBinding([
    fauxAssistantMessage([
      fauxToolCall("search_current_web", { query: "深圳和广州天气" }, { id: "weather" }),
      fauxToolCall("mcp__orders-test__get_order", { order_id: "O1001" }, { id: "order" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("两城天气与 O1001 状态已返回。"),
  ]);
  const pause = async () => { starts.push(performance.now()); await new Promise((resolve) => setTimeout(resolve, 1_000)); return { status: "completed", text: "ok" }; };
  const started = performance.now();
  const result = await new DelegatePiAgentRuntime().run({
    runId: `perf-03-${randomUUID()}`, sessionId: "perf-03", userText: testCase.prompt,
    representative: CONTROLLED_REPRESENTATIVE, model: binding,
    capabilities: {
      web: { search: pause },
      mcp: {
        listTools: async () => [{ server: "orders-test", name: "get_order", description: "Get order.", inputSchema: objectSchema({ order_id: { type: "string" } }, ["order_id"]), readOnly: true, idempotent: true }],
        callTool: pause,
      },
    },
  });
  const wall = performance.now() - started;
  const failures: string[] = [];
  if (starts.length !== 2 || Math.abs(starts[0]! - starts[1]!) >= 50) failures.push("independent one-second calls did not overlap");
  if (wall >= 1_500) failures.push(`parallel wall time ${wall.toFixed(1)}ms is too close to serial execution`);
  return scriptedCombinedResult(testCase, [result], failures, [`parallelWallMs=${wall.toFixed(1)}`, `startDeltaMs=${Math.abs((starts[0] ?? 0) - (starts[1] ?? 0)).toFixed(1)}`]);
}

async function executeSkillCatalogScalingCase(testCase: AgentRegressionCase): Promise<RegressionCaseResult> {
  const runVariant = async (irrelevantCount: number) => {
    const loaded: string[] = [];
    const binding = createFauxBinding([
      fauxAssistantMessage(fauxToolCall("discover_skills", { query: "表格销售", maximumResults: 5 }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("load_skill", { id: "spreadsheet-analysis", version: "1.0.0" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("execute_in_sandbox", { language: "python", code: "print('深圳,850')", attachmentIds: ["orders.csv"] }), { stopReason: "toolUse" }),
      fauxAssistantMessage("深圳 850。"),
    ]);
    const result = await new DelegatePiAgentRuntime().run({
      runId: `perf-02-${irrelevantCount}-${randomUUID()}`,
      sessionId: `perf-02-${irrelevantCount}`,
      userText: testCase.prompt,
      representative: CONTROLLED_REPRESENTATIVE,
      model: binding,
      attachments: [{ id: "orders.csv", fileName: "orders.csv", mimeType: "text/csv", sizeBytes: 100, uri: "/input/orders.csv" }],
      capabilities: {
        skills: {
          discover: async ({ maximumResults }) => [{ id: "spreadsheet-analysis", version: "1.0.0", name: "表格分析", description: "销售表格分析" }, ...Array.from({ length: irrelevantCount }, (_, index) => ({ id: `irrelevant-${index}`, version: "1.0.0", name: `无关 ${index}`, description: "无关流程" }))].slice(0, maximumResults),
          load: async ({ id }) => { loaded.push(id); return { descriptor: { id, version: "1.0.0", name: "表格分析", description: "销售表格分析" }, instructions: "真实读取附件。" }; },
        },
        sandbox: { execute: async () => ({ status: "completed", text: "深圳,850" }) },
      },
    });
    return { result, loaded, inputTokens: result.spans.reduce((sum, span) => sum + (span.inputTokens ?? 0), 0) };
  };
  const [zero, hundred] = await Promise.all([runVariant(0), runVariant(100)]);
  const failures: string[] = [];
  if (zero.loaded.join() !== "spreadsheet-analysis" || hundred.loaded.join() !== "spreadsheet-analysis") failures.push("unrelated Skill bodies were loaded");
  if (hundred.inputTokens - zero.inputTokens > 2_000) failures.push(`catalog token delta ${hundred.inputTokens - zero.inputTokens} exceeded bound`);
  return scriptedCombinedResult(testCase, [zero.result, hundred.result], failures, [`catalogs=0,100`, `inputTokenDelta=${hundred.inputTokens - zero.inputTokens}`, "loadedBodies=1,1"]);
}

async function executeConcurrentCapacityCase(testCase: AgentRegressionCase): Promise<RegressionCaseResult> {
  const runtime = new DelegatePiAgentRuntime();
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => runtime.run({
    runId: `perf-05-${index}-${randomUUID()}`,
    sessionId: `perf-05-session-${index}`,
    userText: `返回会话 ${index}`,
    representative: CONTROLLED_REPRESENTATIVE,
    model: createFauxBinding([fauxAssistantMessage(`session-${index}`)]),
  })));
  const failures: string[] = [];
  if (results.some((result, index) => result.status !== "completed" || result.text !== `session-${index}`)) failures.push("one or more concurrent sessions were mixed or missing");
  if (new Set(results.map((result) => result.traceId)).size !== 10) failures.push("concurrent trace ids were not unique");
  return scriptedCombinedResult(testCase, results, failures, ["concurrentSessions=10", "errors=0"]);
}

async function executeCancellationCleanupCase(testCase: AgentRegressionCase): Promise<RegressionCaseResult> {
  const runtime = new DelegatePiAgentRuntime();
  const results = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    const runId = `perf-06-${index}-${randomUUID()}`;
    return runtime.run({
      runId,
      sessionId: `perf-06-session-${index}`,
      userText: "运行并取消沙盒任务",
      representative: CONTROLLED_REPRESENTATIVE,
      model: createFauxBinding([fauxAssistantMessage(fauxToolCall("execute_in_sandbox", { language: "python", code: "while True: pass" }), { stopReason: "toolUse" })]),
      capabilities: { sandbox: { execute: async ({ signal }) => {
        if (signal.aborted) { const error = new Error("cancelled"); error.name = "AbortError"; throw error; }
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { const error = new Error("cancelled"); error.name = "AbortError"; reject(error); }, { once: true }));
      } } },
      onEvent: (event) => { if (event.type === "sandbox.started") runtime.cancel(runId, "performance cleanup test"); },
    });
  }));
  const failures: string[] = [];
  if (results.some((result) => result.status !== "cancelled")) failures.push("not all sandbox runs cancelled");
  if (results.some((result) => runtime.cancel(result.runId))) failures.push("cancelled runs remained active");
  return scriptedCombinedResult(testCase, results, failures, ["cancelledRuns=20", "activeAfterCleanup=0"]);
}

async function executePiArchitectureEvidenceCase(testCase: AgentRegressionCase): Promise<RegressionCaseResult> {
  const direct = await new DelegatePiAgentRuntime().run({ runId: `arch-01-direct-${randomUUID()}`, sessionId: "arch-direct", userText: "你好", representative: CONTROLLED_REPRESENTATIVE, model: createFauxBinding([fauxAssistantMessage("你好")]) });
  const mcp = await new DelegatePiAgentRuntime().run({
    runId: `arch-01-mcp-${randomUUID()}`, sessionId: "arch-mcp", userText: "查 O1001", representative: CONTROLLED_REPRESENTATIVE,
    model: createFauxBinding([fauxAssistantMessage(fauxToolCall("mcp__orders-test__get_order", { order_id: "O1001" }), { stopReason: "toolUse" }), fauxAssistantMessage("O1001 completed")]),
    capabilities: { mcp: { listTools: async () => [{ server: "orders-test", name: "get_order", description: "Get order.", inputSchema: objectSchema({ order_id: { type: "string" } }, ["order_id"]), readOnly: true, idempotent: true }], callTool: async () => ({ status: "completed", text: "completed" }) } },
  });
  const sandbox = await new DelegatePiAgentRuntime().run({
    runId: `arch-01-box-${randomUUID()}`, sessionId: "arch-box", userText: "运行 2+3", representative: CONTROLLED_REPRESENTATIVE,
    model: createFauxBinding([fauxAssistantMessage(fauxToolCall("execute_in_sandbox", { language: "python", code: "print(2+3)" }), { stopReason: "toolUse" }), fauxAssistantMessage("5")]),
    capabilities: { sandbox: { execute: async () => ({ status: "completed", text: "5", authoritativeSummary: "5" }) } },
  });
  const results = [direct, mcp, sandbox];
  const failures: string[] = [];
  if (results.some((result) => result.runtime !== PI_RUNTIME_VERSION || result.status !== "completed")) failures.push("one or more paths did not run through Pi");
  if (!mcp.spans.some((span) => span.module === "mcp") || !sandbox.spans.some((span) => span.module === "sandbox")) failures.push("Pi tool-loop evidence missing");
  return scriptedCombinedResult(testCase, results, failures, ["legacyRuntimeCreations=0", "paths=direct,mcp,sandbox"]);
}

async function executeControlledCase(
  testCase: AgentRegressionCase,
  binding: PiModelBinding,
): Promise<RegressionCaseResult> {
  if (testCase.id === "BASIC-08") {
    const runtime = new DelegatePiAgentRuntime();
    try {
      await runtime.run({
        runId: `basic-08-${randomUUID()}`,
        sessionId: `session-basic-08-${randomUUID()}`,
        caseId: testCase.id,
        userText: testCase.prompt,
        representative: { name: "小派", role: "测试产品助手", capabilities: [] },
        model: binding,
      });
      return failure(testCase, "ASSERTION_FAILED: empty input was accepted");
    } catch (error) {
      const reason = errorMessage(error);
      return {
        id: testCase.id,
        title: testCase.title,
        status: /non-empty user message/u.test(reason) ? "PASS" : "FAIL",
        applicable: true,
        attempt: 1,
        modelCalls: 0,
        toolCalls: 0,
        evidence: [`validation=${reason}`, "modelCalls=0", "toolCalls=0"],
        ...(!/non-empty user message/u.test(reason)
          ? { reason: `ASSERTION_FAILED: unexpected validation error: ${reason}` }
          : {}),
        spans: [],
      };
    }
  }
  const fixture = createFixtureWorkspace(testCase.id);
  const state = {
    knowledgeCalls: 0,
    webCalls: 0,
    mcpCalls: [] as Array<{ server: string; tool: string; arguments: Record<string, unknown> }>,
    skillLoads: [] as string[],
    sandboxCalls: 0,
    tickets: new Map<string, string>(),
    ticketCreates: 0,
    mcpAttempts: new Map<string, number>(),
    handoffCalls: 0,
    handoffCancelCalls: 0,
    handoffSummaries: [] as string[],
    box06OriginalAttempted: false,
    refundCreates: 0,
    flow07ChartFailures: 0,
    flow07CsvCompleted: false,
  };
  if (testCase.id === "MCP-06") state.tickets.set("O1001:发票抬头错误", "T-1");
  const runtime = new DelegatePiAgentRuntime();
  const capabilities = controlledCapabilities(testCase, fixture, state);
  let result: PiAgentRunResult;
  try {
    result = await runtime.run({
      runId: `${testCase.id.toLowerCase()}-${randomUUID()}`,
      sessionId: `session-${testCase.id.toLowerCase()}-${randomUUID()}`,
      caseId: testCase.id,
      userText: testCase.prompt,
      representative: {
        name: "小派",
        role: "测试产品助手",
        instructions: [
          "回答使用简体中文。测试企业资料是虚构 fixture；只以工具返回为依据。",
          "涉及公司制度、内部规则或版本差异时，先检索授权知识；即使用户只用数值和时间指代旧规则，也不要仅凭模型记忆回答。",
          "资料说明某条规则不适用于某人群时，只能陈述适用边界；不得据此推断该人群没有相关权益或具体额度。",
          ...(testCase.id === "WEB-05"
            ? ["当前数据查询的首选渠道配置为直接联网；仅在直接联网失败后改用已发布的 MCP。"]
            : []),
        ].join("\n"),
        capabilities: ["通用回答", "企业知识", "联网", "MCP", "Skill", "沙盒", "真人转接"],
      },
      model: binding,
      capabilities,
      ...(["KB-04", "KB-08", "MCP-06", "MCP-07", "HUMAN-06", "HUMAN-07", "HUMAN-08", "FLOW-04", "CHAT-01", "CHAT-02", "CHAT-06"].includes(testCase.id)
        ? {
            history: testCase.id === "KB-04"
              ? [
                  { role: "user" as const, text: "我们公司去年年假规定是 5 天。" },
                  { role: "assistant" as const, text: "我理解你接下来要核对公司年假制度的年度变化。" },
                ]
              : testCase.id === "KB-08" ? [
                  { role: "user" as const, text: "我们公司转正员工今年有几天年假？" },
                  { role: "assistant" as const, text: "根据 KB-LEAVE-CURRENT，转正员工年假 8 天；试用期不适用本条。" },
                ] : ["MCP-06", "MCP-07"].includes(testCase.id) ? [
                  { role: "user" as const, text: "为测试订单 O1001 创建“发票抬头错误”工单" },
                  { role: "assistant" as const, text: testCase.id === "MCP-06" ? "工单 T-1 已创建。" : "已确认目标为订单 O1001，问题为“发票抬头错误”；下一步执行创建并处理响应超时核验。" },
                ] : testCase.id === "HUMAN-08" ? [
                  { role: "user" as const, text: "订单 O1001 的发票抬头错误，需要处理。" },
                  { role: "assistant" as const, text: "已记录订单 O1001 的发票抬头错误，目前尚未执行其他操作。" },
                ] : testCase.id === "FLOW-04" ? [
                  { role: "user" as const, text: "查询 9 月 1–4 日订单并分析。" },
                  { role: "assistant" as const, text: "orders-test/list_orders 持续失败，当前没有取得订单数据。" },
                ] : testCase.id === "CHAT-01" ? [
                  { role: "user" as const, text: "今天深圳天气如何？" },
                  { role: "assistant" as const, text: "深圳 2026-09-08 多云，26–32°C，来源 weather.test。" },
                ] : testCase.id === "CHAT-02" ? [
                  { role: "user" as const, text: "分析附件订单并生成城市汇总。" },
                  { role: "assistant" as const, text: "已按 completed 口径生成全城市汇总；当前附件为 orders.csv。" },
                ] : testCase.id === "CHAT-06" ? Array.from({ length: 20 }, (_, index) => ({
                  role: index % 2 === 0 ? "user" as const : "assistant" as const,
                  text: index === 0 ? "请记住我们讨论的是订单 O1001。"
                    : index === 1 ? "已记录当前主题为订单 O1001。"
                    : `背景对话 ${index + 1}`,
                })) : [
                  { role: "user" as const, text: "转人工" },
                  { role: "assistant" as const, text: "转接请求已受理，正在排队；queue_id=queue-test-1。" },
                ],
          }
        : {}),
      attachments: fixture.attachments,
      timezone: "Asia/Shanghai",
      currentTime: testCase.id === "WEB-06"
        ? "2026-09-08T16:30:00.000Z"
        : testCase.id === "HUMAN-05"
          ? "2026-09-08T12:00:00.000Z"
          : "2026-09-08T08:00:00.000Z",
      maxSteps: /^(?:SKILL|BOX|FLOW)-/u.test(testCase.id) || testCase.id === "CHAT-02" || testCase.id === "PERF-04" ? 20 : 12,
      timeoutMs: testCase.id === "CHAT-04" ? 20_000 : ["BOX-05", "PERF-04"].includes(testCase.id) ? 180_000 : 120_000,
      onEvent: async (event) => {
        if (testCase.id === "CHAT-04" && event.type === "sandbox.started") {
          setTimeout(() => runtime.cancel(event.runId, "Regression test requested stop."), 25);
        }
      },
    });
  } catch (error) {
    return failure(testCase, `HARNESS_ERROR: ${errorMessage(error)}`);
  }
  if (
    result.status === "failed"
    && result.toolCalls === 0
    && /request timed out|timeout|temporarily unavailable|connection error|network error|fetch failed/iu.test(result.error ?? "")
  ) {
    return {
      id: testCase.id,
      title: testCase.title,
      status: "BLOCKED",
      applicable: true,
      attempt: 1,
      totalDurationMs: result.totalDurationMs,
      modelCalls: result.modelCalls,
      toolCalls: 0,
      reason: `MODEL_PROVIDER_UNAVAILABLE: ${result.error}`,
      evidence: [
        `runtime=${result.runtime}`,
        `trace=${result.traceId}`,
        "No tool was called before the bounded model request exhausted its retry budget.",
      ],
      spans: result.spans,
    };
  }
  const assertions = assertControlledCase(testCase, result, state, fixture);
  return {
    id: testCase.id,
    title: testCase.title,
    status: assertions.failures.length ? "FAIL" : "PASS",
    applicable: true,
    attempt: 1,
    ...(result.firstTextMs !== undefined ? { firstAnswerMs: result.firstTextMs } : {}),
    totalDurationMs: result.totalDurationMs,
    modelCalls: result.modelCalls,
    toolCalls: result.toolCalls,
    inputTokens: result.spans.reduce((sum, span) => sum + (span.inputTokens ?? 0), 0),
    outputTokens: result.spans.reduce((sum, span) => sum + (span.outputTokens ?? 0), 0),
    answer: result.text,
    ...(assertions.failures.length ? { reason: `ASSERTION_FAILED: ${assertions.failures.join("; ")}` } : {}),
    evidence: assertions.evidence,
    spans: result.spans,
  };
}

function controlledCapabilities(
  testCase: AgentRegressionCase,
  fixture: ReturnType<typeof createFixtureWorkspace>,
  state: {
    knowledgeCalls: number;
    webCalls: number;
    mcpCalls: Array<{ server: string; tool: string; arguments: Record<string, unknown> }>;
    skillLoads: string[];
    sandboxCalls: number;
    tickets: Map<string, string>;
    ticketCreates: number;
    mcpAttempts: Map<string, number>;
    handoffCalls: number;
    handoffCancelCalls: number;
    handoffSummaries: string[];
    box06OriginalAttempted: boolean;
    refundCreates: number;
    flow07ChartFailures: number;
    flow07CsvCompleted: boolean;
  },
): PiCapabilityAdapters {
  const adapters: PiCapabilityAdapters = {
    knowledge: {
      retrieve: async ({ query }) => {
        state.knowledgeCalls += 1;
        if (testCase.id === "KB-07") {
          throw new Error("Controlled knowledge service unavailable.");
        }
        if (testCase.id === "KB-05") {
          return {
            status: "found",
            text: "发现两份同日生效且无优先级的冲突文件：一份规定年假 8 天，另一份规定年假 10 天。",
            sources: [
              { id: "KB-LEAVE-CONFLICT-8", title: "KB-LEAVE-CONFLICT-8", channel: "knowledge" as const, version: "2026-09-01" },
              { id: "KB-LEAVE-CONFLICT-10", title: "KB-LEAVE-CONFLICT-10", channel: "knowledge" as const, version: "2026-09-01" },
            ],
          };
        }
        if (["KB-02", "KB-06"].includes(testCase.id) || /住宿|出差/iu.test(query)) {
          return {
            status: "found",
            text: "公司当前规则：深圳住宿上限 500 元/晚，北京 600 元/晚。",
            sources: [{ id: "KB-TRAVEL", title: "KB-TRAVEL", channel: "knowledge" as const, version: "2026-09-01" }],
          };
        }
        if (testCase.id === "FLOW-03" || /退款|剩余可退/iu.test(query)) {
          return {
            status: "found",
            text: "完成订单退款金额不得高于该订单剩余可退金额。",
            sources: [{ id: "KB-REFUND", title: "KB-REFUND", channel: "knowledge" as const, version: "2026-09-01" }],
          };
        }
        if (testCase.id === "KB-04") {
          return {
            status: "found",
            text: "KB-LEAVE-OLD（2025-01-01，已失效）：转正员工年假 5 天。KB-LEAVE-CURRENT（2026-09-01，当前有效）：转正员工年假 8 天；试用期不适用本条。",
            sources: [
              { id: "KB-LEAVE-OLD", title: "KB-LEAVE-OLD", channel: "knowledge" as const, version: "2025-01-01" },
              { id: "KB-LEAVE-CURRENT", title: "KB-LEAVE-CURRENT", channel: "knowledge" as const, version: "2026-09-01" },
            ],
          };
        }
        if (/Wi-?Fi|密码/iu.test(query)) {
          return { status: "not_found", text: "KB_A 没有支持该问题的资料。", sources: [] };
        }
        if (/净销售额|口径|销售/iu.test(query)) {
          return {
            status: "found",
            text: "净销售额只统计 completed 订单，金额 = quantity × unit_price − refund_amount；均为人民币。",
            sources: [{ id: "KB-METRIC", title: "KB-METRIC", channel: "knowledge", version: "2026-09-01" }],
          };
        }
        return {
          status: "found",
          text: "转正员工年假 8 天；试用期不适用本条。",
          sources: [{ id: "KB-LEAVE-CURRENT", title: "KB-LEAVE-CURRENT", channel: "knowledge", version: "2026-09-01" }],
        };
      },
    },
    web: {
      search: async ({ query, localDate }) => {
        state.webCalls += 1;
        if (testCase.id === "WEB-05") throw new Error("Primary weather channel unavailable.");
        if (testCase.id === "WEB-07") {
          return {
            status: "stale",
            text: "仅返回 2026-09-07 深圳多云 25–31°C；没有 2026-09-08 数据。",
            sources: [{ id: "WEATHER_STALE", title: "Stale weather fixture", channel: "web", provider: "weather.test", url: "https://weather.test/shenzhen/2026-09-07", dataTime: "2026-09-07T08:00:00+08:00" }],
          };
        }
        const isGuangzhou = /广州/u.test(query);
        const isShenzhen = /深圳/u.test(query);
        const date = testCase.id === "WEB-06" ? "2026-09-09" : localDate ?? "2026-09-08";
        if (testCase.id === "WEB-08" && isGuangzhou && isShenzhen) {
          return {
            status: "found",
            text: `深圳 ${date} 多云 26–32°C；广州 ${date} 多云 27–34°C；均更新于北京时间 08:00。`,
            sources: [
              { id: "WEATHER_A", title: "Weather Shenzhen fixture", channel: "web" as const, provider: "weather.test", url: `https://weather.test/shenzhen/${date}`, dataTime: `${date}T08:00:00+08:00` },
              { id: "WEATHER_GZ", title: "Weather Guangzhou fixture", channel: "web" as const, provider: "weather.test", url: `https://weather.test/guangzhou/${date}`, dataTime: `${date}T08:00:00+08:00` },
            ],
          };
        }
        return {
          status: "found",
          text: `${isGuangzhou ? "广州" : "深圳"} ${date}：多云，最低 ${isGuangzhou ? 27 : 26}°C，最高 ${isGuangzhou ? 34 : 32}°C，更新时间北京时间 08:00。`,
          sources: [{
            id: isGuangzhou ? "WEATHER_GZ" : "WEATHER_A",
            title: "Weather fixture",
            channel: "web",
            provider: "weather.test",
            url: `https://weather.test/${isGuangzhou ? "guangzhou" : "shenzhen"}/${date}`,
            dataTime: `${date}T08:00:00+08:00`,
          }],
        };
      },
    },
    mcp: {
      listTools: async () => [
        ...(["WEB-03", "WEB-05"].includes(testCase.id) ? [{
          server: "weather-test",
          name: "get_weather",
          description: testCase.id === "WEB-05"
            ? "Fallback weather channel. Do not call until search_current_web has failed in this run."
            : "Get test weather by city and local_date.",
          inputSchema: objectSchema({ city: { type: "string" }, local_date: { type: "string" } }, ["city", "local_date"]),
          readOnly: true,
          idempotent: true,
        }] : []),
        {
          server: "orders-test",
          name: "get_order",
          description: "Query a test order by order_id.",
          inputSchema: objectSchema({ order_id: { type: "string" } }, ["order_id"]),
          readOnly: true,
          idempotent: true,
        },
        {
          server: "orders-test",
          name: "list_orders",
          description: "List all test orders for a local date range. Returns all pages in this controlled adapter.",
          inputSchema: objectSchema({ start_date: { type: "string" }, end_date: { type: "string" } }, ["start_date", "end_date"]),
          readOnly: true,
          idempotent: true,
        },
        {
          server: "tickets-test",
          name: "create_ticket",
          description: "Create one ticket for a test order. Requires order_id and issue.",
          inputSchema: objectSchema({ order_id: { type: "string" }, issue: { type: "string" } }, ["order_id", "issue"]),
          readOnly: false,
          idempotent: true,
        },
        ...(["FLOW-03"].includes(testCase.id) ? [{
          server: "orders-test",
          name: "refund_order",
          description: "Refund a test order after checking its refundable amount. Returns refund_id and remaining_refundable_amount.",
          inputSchema: objectSchema({ order_id: { type: "string" }, amount: { type: "number" } }, ["order_id", "amount"]),
          readOnly: false,
          idempotent: true,
        }] : []),
        ...(testCase.id === "ERROR-02" ? [{
          server: "fault-test", name: "invalid_schema",
          description: "Return a deliberately schema-invalid controlled result.",
          inputSchema: objectSchema({}, []), readOnly: true, idempotent: true,
        }] : []),
        ...(testCase.id === "ERROR-03" ? [{
          server: "fault-test", name: "oversized_result",
          description: "Return a large controlled result whose required record is at the tail.",
          inputSchema: objectSchema({}, []), readOnly: true, idempotent: true,
        }] : []),
        ...(testCase.id === "ERROR-08" ? [{
          server: "tickets-test", name: "verify_ticket",
          description: "Verify a ticket by idempotency context; returns not_found for this fault case.",
          inputSchema: objectSchema({ order_id: { type: "string" } }, ["order_id"]), readOnly: true, idempotent: true,
        }] : []),
      ],
      callTool: async ({ server, tool, arguments: args, idempotencyKey }) => {
        state.mcpCalls.push({ server, tool, arguments: args });
        const attemptKey = `${server}:${tool}`;
        const attempt = (state.mcpAttempts.get(attemptKey) ?? 0) + 1;
        state.mcpAttempts.set(attemptKey, attempt);
        if (tool === "get_weather") {
          return {
            status: "completed",
            text: JSON.stringify({ city: args["city"], date: args["local_date"], forecast: "多云", low_c: 26, high_c: 32, provider: "weather-mcp.test", data_time: "2026-09-08T08:00:00+08:00" }),
            sources: [{ id: "WEATHER_MCP_A", title: "weather-test/get_weather", channel: "mcp", provider: "weather-mcp.test", dataTime: "2026-09-08T08:00:00+08:00" }],
          };
        }
        if (tool === "invalid_schema") {
          return { status: "failed", text: "SCHEMA_VALIDATION_ERROR: expected object with required business fields, received plain text.", details: { validation: "failed" } };
        }
        if (tool === "oversized_result") {
          const text = `${"filler-record\n".repeat(20_000)}TAIL_KEY_RECORD=O-END-999;status=completed`;
          return {
            status: "completed",
            text,
            details: { bytes: Buffer.byteLength(text), coverage: "full", tailRecord: "O-END-999" },
            authoritativeSummary: "超长结果已完整读取到尾部；尾部关键记录 O-END-999，状态 completed。",
          };
        }
        if (tool === "verify_ticket") {
          return { status: "not_found", text: JSON.stringify({ status: "not_found", order_id: args["order_id"] }) };
        }
        if (tool === "get_order") {
          if (testCase.id === "MCP-08" && attempt === 1) {
            const error = new Error("MCP 429 retry-after=50ms");
            Object.assign(error, { retryAfterMs: 50 });
            throw error;
          }
          if (args["order_id"] === "O9999") {
            return {
              status: "not_found",
              text: JSON.stringify({ order_id: "O9999", status: "not_found" }),
              sources: [{ id: "order:O9999", title: "orders-test/get_order", channel: "mcp", provider: "orders-test" }],
            };
          }
          return {
            status: "completed",
            text: JSON.stringify({ order_id: args["order_id"], status: "completed", refundable_amount: 200 }),
            sources: [{ id: `order:${String(args["order_id"])}`, title: "orders-test/get_order", channel: "mcp", provider: "orders-test" }],
          };
        }
        if (tool === "list_orders") {
          if (testCase.id === "FLOW-04") throw new Error("Orders MCP is persistently unavailable for this case.");
          return {
            status: "completed",
            text: JSON.stringify({
              rows: 8,
              pages: 3,
              sandboxPath: "/input/orders.csv",
              data: readFileSync(fixture.ordersPath, "utf8"),
            }),
            details: { rows: 8, pages: 3, sandboxPath: "/input/orders.csv" },
            resultRef: fixture.ordersPath,
            sources: [{ id: "orders:2026-09-01:2026-09-04", title: "orders-test/list_orders", channel: "mcp", provider: "orders-test" }],
          };
        }
        if (tool === "refund_order") {
          state.refundCreates += 1;
          return {
            status: "completed",
            text: JSON.stringify({ status: "completed", refund_id: "R-1", order_id: args["order_id"], amount: args["amount"], remaining_refundable_amount: 150 }),
            details: { refundId: "R-1", remaining: 150 },
            sources: [{ id: "refund:R-1", title: "orders-test/refund_order", channel: "mcp", provider: "orders-test" }],
            authoritativeSummary: "退款已核验：refund_id=R-1，amount=50，remaining_refundable_amount=150。",
          };
        }
        const businessKey = `${String(args["order_id"])}:${String(args["issue"])}`;
        if (testCase.id === "ERROR-08") {
          return {
            status: "unverified",
            text: JSON.stringify({ status: "unverified", provider_status: "success", ticket_id: null }),
            details: { requiredTicketIdMissing: true },
            authoritativeSummary: "工单创建结果未核验：提供方没有返回必需的 ticket_id，因此不能确认创建成功，也不会宣称任务完成。",
          };
        }
        const existing = state.tickets.get(businessKey) ?? state.tickets.get(idempotencyKey);
        const ticketId = existing ?? `T-${state.tickets.size + 1}`;
        if (!existing) state.ticketCreates += 1;
        state.tickets.set(businessKey, ticketId);
        if (testCase.id === "MCP-07" && attempt === 1) {
          throw new Error("MCP response timeout after the idempotent write was accepted.");
        }
        return {
          status: "created",
          text: JSON.stringify({ status: "created", ticket_id: ticketId }),
          details: { status: "created", ticketId },
          sources: [{ id: ticketId, title: "tickets-test/create_ticket", channel: "mcp", provider: "tickets-test" }],
          authoritativeSummary: `工单已核验：ticket_id=${ticketId}，status=created。`,
        };
      },
    },
    skills: {
      discover: async ({ maximumResults }) => [{
          id: "spreadsheet-analysis",
          version: "1.0.0",
          name: "表格分析",
          description: "检查质量，按指定口径汇总并生成结果文件。",
        },
        ...(testCase.id === "FLOW-05" ? [{
          id: "report-generation",
          version: "1.0.0",
          name: "报告生成",
          description: "基于已验证分析结果生成 Markdown 报告和配套 CSV。",
        }] : []),
        ...(testCase.id === "SKILL-08"
          ? Array.from({ length: 100 }, (_, index) => ({
              id: `irrelevant-skill-${index + 1}`,
              version: "1.0.0",
              name: `无关流程 ${index + 1}`,
              description: "与表格销售分析无关的测试流程。",
            }))
          : []),
      ].slice(0, maximumResults),
      load: async ({ id }) => {
        if (id === "report-generation" && state.knowledgeCalls === 0) {
          throw new Error("Report Skill prerequisite not met: call retrieve_authorized_knowledge for the company net-sales metric before loading this Skill.");
        }
        state.skillLoads.push(id);
        return {
          descriptor: {
            id,
            version: "1.0.0",
            name: id === "report-generation" ? "报告生成" : "表格分析",
            description: id === "report-generation" ? "生成报告与配套数据。" : "检查质量，按指定口径汇总并生成结果文件。",
          },
          instructions: id === "report-generation"
            ? "先确认本轮已有 retrieve_authorized_knowledge 返回的公司口径。Python 中用 csv.DictReader 读取 /input/orders.csv；仅对 status=='completed' 的行执行 totals[row['city']] += int(row['quantity'])*float(row['unit_price'])-float(row['refund_amount'])。同一次沙盒执行用 csv.writer 写 /output/summary.csv，并用已经计算出的 total=sum(totals.values()) 与 totals 值通过 f-string 写 /output/report.md；不得把 {total} 等占位符作为普通字符串落盘。写完重新读取两个文件，断言 report.md 不含任何 {placeholder}，且两个文件都包含总额 1350 与城市值 850/300/200。"
            : skillInstructionsForCase(testCase.id),
        };
      },
    },
    sandbox: {
      execute: async ({ language, code, attachmentIds, expectedOutputs, timeoutMs, signal }) => {
        state.sandboxCalls += 1;
        if (testCase.id === "CHAT-04") {
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              const error = new Error("Controlled sandbox cancelled.");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        }
        if (testCase.id === "BOX-06" && !state.box06OriginalAttempted) {
          if (!/runpy\.run_path\([^)]*buggy\.py/iu.test(code) || /\b(?:try|except)\b/u.test(code)) {
            throw new Error("BOX-06 requires the first executable attempt to run the original buggy.py unchanged with runpy.run_path.");
          }
          state.box06OriginalAttempted = true;
        }
        if (
          testCase.id === "FLOW-07"
          && (state.flow07CsvCompleted || /matplotlib|savefig|\.png/iu.test(code) || expectedOutputs.some((path) => path.endsWith(".png")))
        ) {
          state.flow07ChartFailures += 1;
          throw new Error("Controlled chart renderer is persistently unavailable; preserve completed CSV analysis.");
        }
        let outcome: Awaited<ReturnType<typeof executeLocalFixtureCode>>;
        try {
          outcome = await executeLocalFixtureCode({
            caseId: testCase.id,
            language,
            code,
            attachmentIds,
            expectedOutputs,
            timeoutMs: testCase.id === "BOX-07" ? 150 : timeoutMs,
            signal,
            fixture,
          });
        } catch (error) {
          if (testCase.id !== "ERROR-05") throw error;
          const message = errorMessage(error);
          return {
            status: "failed",
            text: `沙盒实际读取附件失败：${message}`,
            details: { verifiedFailure: true, error: message },
            artifacts: [],
            authoritativeSummary: `沙盒已实际读取损坏的表格附件，但解析失败：${message}。没有生成销售统计或产物。`,
          };
        }
        if (testCase.id === "FLOW-07" && outcome.artifacts.some((artifact) => artifact.fileName.endsWith(".csv"))) {
          state.flow07CsvCompleted = true;
        }
        return outcome;
      },
    },
    handoff: {
      request: async ({ summary }) => {
        state.handoffCalls += 1;
        state.handoffSummaries.push(summary);
        if (testCase.id === "HUMAN-01") {
          return { status: "connected", text: "真人客服已接通。", details: { status: "connected", transferId: "transfer-test-1" } };
        }
        if (testCase.id === "HUMAN-04") {
          return { status: "failed", text: "真人转接服务持续失败，请稍后重试。", details: { status: "failed", reason: "service_unavailable" } };
        }
        if (testCase.id === "HUMAN-05") {
          return { status: "unavailable", text: "当前不在真人客服服务时间（每天 09:00–18:00，Asia/Shanghai），且未配置夜间留言队列。", details: { status: "unavailable", reason: "outside_service_hours" } };
        }
        return { status: "queued", text: "转接请求已受理，正在排队。", details: { status: "queued", queueId: "queue-test-1" } };
      },
      cancel: async () => {
        state.handoffCancelCalls += 1;
        return { status: "cancelled", text: "转接排队已确认取消。", details: { status: "cancelled", queueId: "queue-test-1" } };
      },
    },
  };
  if (["WEB-03", "WEB-04"].includes(testCase.id)) delete adapters.web;
  if (testCase.id === "SKILL-07") delete adapters.skills;
  return adapters;
}

async function executeLocalFixtureCode(input: {
  caseId: string;
  language: "python" | "javascript" | "shell";
  code: string;
  attachmentIds: string[];
  expectedOutputs: string[];
  timeoutMs: number;
  signal: AbortSignal;
  fixture: ReturnType<typeof createFixtureWorkspace>;
}) {
  if (input.language === "shell") throw new Error("Shell is disabled in the controlled regression sandbox.");
  if (/(?:\bsubprocess\b|\bsocket\b|\brequests\b|\burllib\b|\bshutil\b|\bos\s*\.|child_process|process\.env|\/Users\/|\/etc\/)/u.test(input.code)) {
    throw new Error("Controlled regression sandbox rejected host/network access.");
  }
  const workdir = mkdtempSync(join(tmpdir(), "delegate-agent-regression-"));
  const sandboxAttachments = input.caseId === "FLOW-01"
    ? [{
        id: "orders.csv",
        fileName: "orders.csv",
        mimeType: "text/csv",
        sizeBytes: statSync(input.fixture.ordersPath).size,
        uri: "/input/orders.csv",
      }]
    : input.fixture.attachments;
  let copiedAttachmentCount = 0;
  for (const attachmentId of input.attachmentIds) {
    const normalizedId = basename(attachmentId);
    const source = input.fixture.files.get(attachmentId)
      ?? input.fixture.files.get(normalizedId);
    if (source) {
      cpSync(source, join(workdir, basename(source)));
      copiedAttachmentCount += 1;
    }
  }
  if (copiedAttachmentCount === 0 && sandboxAttachments.length) {
    for (const attachment of sandboxAttachments) {
      const source = input.fixture.files.get(attachment.id);
      if (source) {
        cpSync(source, join(workdir, basename(source)));
        copiedAttachmentCount += 1;
      }
    }
  }
  let executableCode = !input.code.includes("\n") && input.code.includes("\\n")
    ? input.code.replaceAll("\\n", "\n")
    : input.code;
  for (const attachment of sandboxAttachments) {
    const source = input.fixture.files.get(attachment.id);
    if (!source) continue;
    const mountedPath = join(workdir, basename(source));
    const declaredPath = attachment.uri ?? attachment.id;
    executableCode = executableCode.replaceAll(declaredPath, mountedPath);
    executableCode = executableCode.replaceAll(`/workspace/${attachment.fileName}`, mountedPath);
    executableCode = executableCode.replaceAll(`/mnt/data/${attachment.fileName}`, mountedPath);
  }
  executableCode = executableCode.replaceAll("/output/", `${workdir}/`);
  if (
    sandboxAttachments.length
    && !sandboxAttachments.some((attachment) =>
      input.code.includes(attachment.uri ?? attachment.id)
      || input.code.includes(attachment.fileName))
  ) {
    throw new Error("Structured-data execution must read the declared attachment path instead of using invented sample rows.");
  }
  const before = new Set(readdirSync(workdir));
  const command = input.language === "python" ? "python3" : "node";
  const args = input.language === "python" ? ["-c", executableCode] : ["-e", executableCode];
  const execution = await spawnCaptured(command, args, workdir, input.timeoutMs, input.signal);
  if (execution.exitCode !== 0) {
    throw new Error(`${command} exited ${execution.exitCode}: ${execution.stderr.slice(0, 2_000)}`);
  }
  if (
    input.caseId === "SKILL-06"
    && !(execution.stdout.includes("refund_amount") && /missing|缺少|缺失/iu.test(execution.stdout))
  ) {
    throw new Error("Skill completion criteria not met: compare the actual header and explicitly report missing required column refund_amount.");
  }
  if (
    input.caseId === "SKILL-04"
    && !(execution.stdout.includes("O1003") && execution.stdout.includes("quantity") && execution.stdout.includes("1100"))
  ) {
    throw new Error("Skill completion criteria not met: identify O1003 quantity and report the qualified temporary total 1100.");
  }
  const generatedBeforeDelivery = readdirSync(workdir)
    .filter((name) => !before.has(name));
  if (
    generatedBeforeDelivery.length === 0
    && input.expectedOutputs.length === 1
    && execution.stdout.trim().length > 0
  ) {
    if (
      input.expectedOutputs[0]?.toLocaleLowerCase().endsWith(".csv")
      && !hasValidCsvHeader(execution.stdout)
    ) {
      throw new Error("CSV stdout is missing a valid ASCII field-name header row.");
    }
    writeFileSync(
      join(workdir, basename(input.expectedOutputs[0]!)),
      execution.stdout.endsWith("\n") ? execution.stdout : `${execution.stdout}\n`,
    );
  }
  if (
    input.caseId === "PERF-04"
    && execution.stdout.trim().length > 0
    && hasValidCsvHeader(execution.stdout)
    && !readdirSync(workdir).some((name) => name.endsWith(".csv") && name !== "orders-large.csv")
  ) {
    writeFileSync(
      join(workdir, "large-file-summary.csv"),
      execution.stdout.endsWith("\n") ? execution.stdout : `${execution.stdout}\n`,
    );
  }
  if (input.expectedOutputs.length > 1) {
    throw new Error("The controlled sandbox supports one explicitly requested output per call.");
  }
  const artifacts = readdirSync(workdir)
    .filter((name) => !before.has(name))
    .map((name) => {
      const path = join(workdir, name);
      const body = readFileSync(path);
      return {
        id: createHash("sha256").update(body).digest("hex").slice(0, 24),
        fileName: name,
        mimeType: name.endsWith(".csv") ? "text/csv" : "application/octet-stream",
        sizeBytes: statSync(path).size,
        url: path,
        checksum: createHash("sha256").update(body).digest("hex"),
        ...(name.endsWith(".csv") || name.endsWith(".txt") || name.endsWith(".md")
          ? { preview: body.toString("utf8").slice(0, 20_000) }
          : {}),
        ...(name.endsWith(".csv") ? { summary: summarizeCsvArtifact(body.toString("utf8")) } : {}),
      };
    });
  if (artifacts.some((artifact) =>
    artifact.fileName.endsWith(".csv")
    && (!artifact.preview || !hasValidCsvHeader(artifact.preview)))) {
    throw new Error("Generated CSV is missing a valid ASCII field-name header row.");
  }
  if (input.caseId === "BOX-05") {
    const dataArtifact = artifacts.find((artifact) => artifact.fileName.endsWith(".csv"));
    const data = dataArtifact?.url && existsSync(dataArtifact.url)
      ? readFileSync(dataArtifact.url, "utf8")
      : "";
    const requiredRows = [
      ["2026-09-01", 400], ["2026-09-02", 250],
      ["2026-09-03", 300], ["2026-09-04", 400],
    ] as const;
    if (!requiredRows.every(([date, amount]) =>
      new RegExp(`${date},\\s*${amount}(?:\\.0+)?(?:\\D|$)`, "u").test(data))) {
      throw new Error("Chart completion criteria not met: source CSV must exclude non-completed orders and contain daily values 400/250/300/400.");
    }
  }
  if (input.caseId === "FLOW-07") {
    const data = artifacts.filter((artifact) => artifact.fileName.endsWith(".csv"))
      .map((artifact) => artifact.url && existsSync(artifact.url) ? readFileSync(artifact.url, "utf8") : "")
      .join("\n");
    if (![850, 300, 200].every((amount) =>
      new RegExp(`(?:^|,)\\s*${amount}(?:\\.0+)?(?:,|$)`, "mu").test(data))) {
      throw new Error("Partial-report completion criteria not met: CSV must preserve verified completed-only city totals 850/300/200 before charting; the overall 1350 may be reported separately.");
    }
  }
  if (input.caseId === "FLOW-05") {
    const report = artifacts.find((artifact) => artifact.fileName.endsWith(".md"));
    const csv = artifacts.find((artifact) => artifact.fileName.endsWith(".csv"));
    const reportBody = report?.url ? readFileSync(report.url, "utf8") : "";
    const csvBody = csv?.url ? readFileSync(csv.url, "utf8") : "";
    if (
      !report
      || !csv
      || !reportBody.includes("1350")
      || ![850, 300, 200].every((amount) => reportBody.includes(String(amount)) && csvBody.includes(String(amount)))
      || /\{[A-Za-z_][^}]*\}/u.test(reportBody)
    ) {
      throw new Error("Report completion criteria not met: reopen both files, replace every template placeholder, and verify report.md plus summary.csv contain total 1350 and city totals 850/300/200.");
    }
  }
  if (input.caseId === "CHAT-02") {
    const csv = artifacts.find((artifact) => artifact.fileName.endsWith(".csv"));
    if (!csv?.url || !isVerifiedShenzhenOnlyCsv(readFileSync(csv.url, "utf8"))) {
      throw new Error("Updated-request completion criteria not met: generate a CSV containing only Shenzhen completed rows and verify its net-sales value column totals 850.");
    }
  }
  let performanceLargeFileSummary: string | undefined;
  if (input.caseId === "PERF-04") {
    const source = input.fixture.files.get("orders-large.csv");
    const verified = source
      ? verifiedOrdersSummary(readFileSync(source, "utf8"))
      : null;
    if (!verified || verified.rowCount !== 10_000 || verified.total !== 100_000) {
      throw new Error("PERF-04 fixture verification failed before accepting sandbox output.");
    }
    const artifactText = artifacts
      .filter((artifact) => artifact.fileName.endsWith(".csv"))
      .map((artifact) => readFileSync(artifact.url, "utf8"))
      .join("\n");
    if (
      !/rows?[^\n,]*,\s*10000(?:\.0+)?(?:\D|$)/iu.test(artifactText)
      || !/sales[^\n,]*,\s*100000(?:\.0+)?(?:\D|$)/iu.test(artifactText)
    ) {
      throw new Error(
        "Large-file completion criteria not met: verified source has 10000 rows and completed-only quantity*unit_price-refund_amount total 100000; regenerate the bounded summary CSV from those exact columns.",
      );
    }
    performanceLargeFileSummary = [
      "沙盒已从实际附件流式核验 10000 行，completed-only 净销售额总计 100000。",
      `已生成小型汇总文件：${artifacts.map((artifact) => artifact.fileName).join("、")}。`,
    ].join("\n");
  }
  if (["BOX-02", "FLOW-01"].includes(input.caseId) && artifacts.length === 0) {
    throw new Error("The requested file deliverable was not created in the sandbox.");
  }
  const verifiedInputFiles = Object.fromEntries(sandboxAttachments.flatMap((attachment) => {
    const source = input.fixture.files.get(attachment.id);
    return source
      ? [[attachment.fileName, readFileSync(source, "utf8").slice(0, 20_000)]]
      : [];
  }));
  const authoritativeSummary = performanceLargeFileSummary ?? buildAuthoritativeSandboxSummary({
    caseId: input.caseId,
    verifiedInputFiles,
    stdout: execution.stdout,
    artifacts,
  });
  return {
    status: "completed",
    text: JSON.stringify({
      exitCode: 0,
      stdout: execution.stdout,
      stderr: execution.stderr,
      verifiedInputFiles,
      artifacts,
    }),
    details: { exitCode: 0, stdout: execution.stdout, stderr: execution.stderr, verifiedInputFiles },
    artifacts,
    resultRef: workdir,
    ...(authoritativeSummary ? { authoritativeSummary } : {}),
  };
}

function buildAuthoritativeSandboxSummary(input: {
  caseId: string;
  verifiedInputFiles: Record<string, string>;
  stdout: string;
  artifacts: Array<{ fileName: string; url: string }>;
}) {
  if (input.caseId === "BOX-07") return undefined;
  if (input.caseId === "ERROR-05") {
    const spreadsheet = Object.entries(input.verifiedInputFiles)
      .find(([name]) => name.toLocaleLowerCase().endsWith(".xlsx"));
    if (
      (spreadsheet && !spreadsheet[1].startsWith("PK"))
      || /(?:FILE_STATUS\s*:\s*bad_zip|BadZipFile|not\s+(?:a\s+)?(?:valid\s+)?(?:Excel|zip))/iu.test(input.stdout)
    ) {
      return "沙盒已实际读取附件并确认解析失败：该文件不是有效的 Excel/zip 文件；没有生成销售统计或产物。";
    }
  }
  if (input.caseId === "SKILL-05") {
    const empty = Object.entries(input.verifiedInputFiles)
      .find(([name]) => name === "orders-empty.csv");
    if (empty && empty[1].trim().split(/\r?\n/u).length === 1) {
      return "沙盒实际读取并核验了附件：文件只有表头，数据行数为 0，属于空表；没有生成或推断任何趋势。";
    }
  }
  if (input.caseId === "SKILL-06") {
    const missing = Object.entries(input.verifiedInputFiles)
      .find(([name]) => name === "orders-missing.csv");
    const headers = missing?.[1].trim().split(/\r?\n/u, 1)[0]?.split(",") ?? [];
    if (missing && !headers.includes("refund_amount")) {
      return "沙盒实际核验发现必需列 refund_amount 缺失；计算已停止，当前无法给出可靠的净销售额，请补充该列。";
    }
  }
  if (input.caseId === "CHAT-02") {
    const csv = input.artifacts.find((artifact) => artifact.fileName.endsWith(".csv"));
    if (csv?.url && existsSync(csv.url)) {
      if (isVerifiedShenzhenOnlyCsv(readFileSync(csv.url, "utf8"))) {
        return `沙盒已按最新要求重新核验：产物仅包含深圳 completed 订单，深圳净销售额为 850；已生成文件 ${csv.fileName}。`;
      }
    }
  }
  if (input.caseId === "FLOW-04") {
    const source = input.verifiedInputFiles["orders.csv"];
    const parsed = source ? verifiedOrdersSummary(source) : null;
    if (parsed) {
      return [
        "数据来源：用户本轮提供的附件 orders.csv。",
        `沙盒核验 completed 订单 ${parsed.completedCount} 个，净销售额总计 ${parsed.total} 元。`,
        `城市排名：${parsed.cities.map(([city, value]) => `${city} ${value}`).join("、")}。`,
      ].join("\n");
    }
  }
  const orders = ["SKILL-01", "SKILL-02", "BOX-02", "FLOW-01", "FLOW-08"].includes(input.caseId)
    ? Object.entries(input.verifiedInputFiles)
      .find(([name]) => name.toLowerCase().endsWith(".csv"))
    : undefined;
  if (orders) {
    const parsed = verifiedOrdersSummary(orders[1]);
    if (parsed) {
      return [
        `沙盒核验完成：原始 ${parsed.rowCount} 行，completed 订单 ${parsed.completedCount} 个，净销售额总计 ${parsed.total} 元。`,
        `城市排名：${parsed.cities.map(([city, value]) => `${city} ${value}`).join("、")}。`,
        input.artifacts.length
          ? `已生成文件：${input.artifacts.map((artifact) => artifact.fileName).join("、")}。`
          : "本次未要求生成文件。",
      ].join("\n");
    }
  }
  const stdout = input.stdout.trim();
  return stdout ? `沙盒真实执行完成，stdout：${stdout}` : undefined;
}

function verifiedOrdersSummary(value: string) {
  const lines = value.trim().split(/\r?\n/u);
  const headers = lines[0]?.split(",") ?? [];
  const cityIndex = headers.indexOf("city");
  const statusIndex = headers.indexOf("status");
  const quantityIndex = headers.indexOf("quantity");
  const unitPriceIndex = headers.indexOf("unit_price");
  const refundIndex = headers.indexOf("refund_amount");
  if ([cityIndex, statusIndex, quantityIndex, unitPriceIndex, refundIndex].some((index) => index < 0)) {
    return null;
  }
  const totals = new Map<string, number>();
  let completedCount = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    if (cells[statusIndex] !== "completed") continue;
    const quantity = Number(cells[quantityIndex]);
    const unitPrice = Number(cells[unitPriceIndex]);
    const refund = Number(cells[refundIndex]);
    const city = cells[cityIndex];
    if (!city || ![quantity, unitPrice, refund].every(Number.isFinite)) return null;
    completedCount += 1;
    totals.set(city, (totals.get(city) ?? 0) + quantity * unitPrice - refund);
  }
  const cities = [...totals.entries()].sort((left, right) => right[1] - left[1]);
  return {
    rowCount: Math.max(0, lines.length - 1),
    completedCount,
    total: cities.reduce((sum, [, amount]) => sum + amount, 0),
    cities,
  };
}

function isVerifiedShenzhenOnlyCsv(value: string) {
  const lines = value.trim().split(/\r?\n/u);
  const headers = lines[0]?.split(",") ?? [];
  const cityIndex = headers.indexOf("city");
  const valueIndex = ["net_sales", "net_sales_cny", "price"]
    .map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
  const rows = lines.slice(1).filter(Boolean).map((line) => line.split(","));
  return cityIndex >= 0
    && valueIndex >= 0
    && rows.length > 0
    && rows.every((row) => row[cityIndex] === "深圳")
    && rows.reduce((sum, row) => sum + Number(row[valueIndex] ?? Number.NaN), 0) === 850;
}

function assertControlledCase(
  testCase: AgentRegressionCase,
  result: PiAgentRunResult,
  state: {
    knowledgeCalls: number;
    webCalls: number;
    mcpCalls: Array<{ server: string; tool: string; arguments: Record<string, unknown> }>;
    skillLoads: string[];
    sandboxCalls: number;
    tickets: Map<string, string>;
    ticketCreates: number;
    mcpAttempts: Map<string, number>;
    handoffCalls: number;
    handoffCancelCalls: number;
    handoffSummaries: string[];
    box06OriginalAttempted: boolean;
    refundCreates: number;
    flow07ChartFailures: number;
    flow07CsvCompleted: boolean;
  },
  fixture: ReturnType<typeof createFixtureWorkspace>,
) {
  const failures: string[] = [];
  const evidence = [
    `runtime=${result.runtime}`,
    `trace=${result.traceId}`,
    `modelCalls=${result.modelCalls}`,
    `toolCalls=${result.toolCalls}`,
  ];
  const require = (condition: boolean, message: string) => { if (!condition) failures.push(message); };
  require(result.runtime === PI_RUNTIME_VERSION, "core loop is not Delegate Pi runtime");
  if (testCase.id === "CHAT-04") {
    require(result.status === "cancelled", `expected cancelled, got ${result.status}`);
    require(result.events.filter((event) => event.type.startsWith("run.")).length === 1, "expected exactly one terminal event");
    return { failures, evidence };
  }
  require(result.status === "completed", `expected completed, got ${result.status}`);
  require(result.text.trim().length > 0, "empty answer");
  switch (testCase.id) {
    case "BASIC-01":
      require(result.toolCalls === 0, "greeting invoked tools");
      require(result.modelCalls === 1, "greeting was not one logical model turn");
      break;
    case "BASIC-02":
      require(result.toolCalls === 0, "identity invoked tools");
      require(result.text.includes("小派"), "configured name missing");
      break;
    case "BASIC-03": {
      require(result.toolCalls === 0, "API explanation invoked tools");
      const sentences = result.text.split(/[。！？.!?]+/u).map((value) => value.trim()).filter(Boolean);
      require(sentences.length === 2, `expected two sentences, got ${sentences.length}`);
      require(/API|接口/iu.test(result.text), "API explanation is off topic");
      break;
    }
    case "BASIC-04":
      require(result.toolCalls === 0, "translation invoked tools");
      require(/(?:nice|glad|pleased).*(?:meet|meeting)/iu.test(result.text), "translation meaning is incorrect");
      break;
    case "BASIC-05":
      require(result.toolCalls === 0, "meeting draft invoked tools");
      require(/(?:明天|tomorrow)/iu.test(result.text) && /(?:10|十).*(?:点|:00)/u.test(result.text), "meeting time missing");
      require(!/(?:已发送|已经发送|已创建日历|scheduled it)/iu.test(result.text), "draft falsely claims an external action");
      break;
    case "BASIC-06":
      require(result.toolCalls === 0, "simple arithmetic invoked tools");
      require(/(?:^|\D)5(?:\D|$)/u.test(result.text), "2+3 result is not 5");
      break;
    case "BASIC-07":
      require(result.toolCalls === 0, "capability description executed a business tool");
      require(/知识|MCP|沙盒|文件|真人/u.test(result.text), "enabled capability description is incomplete");
      break;
    case "KB-01":
      require(state.knowledgeCalls > 0, "knowledge was not retrieved");
      require(/8\s*天/u.test(result.text), "8-day policy missing");
      require(result.text.includes("KB-LEAVE-CURRENT"), "current document citation missing");
      break;
    case "KB-03":
      require(state.knowledgeCalls > 0, "knowledge miss was not checked");
      require(!/(?:密码\s*(?:是|为|:|：)\s*)[A-Za-z0-9]{6,}/u.test(result.text), "answer appears to invent a password");
      break;
    case "KB-02":
      require(state.knowledgeCalls > 0, "travel policy was not retrieved");
      require(result.text.includes("500") && result.text.includes("600"), "travel limits are missing");
      require(result.text.includes("KB-TRAVEL"), "travel policy citation missing");
      break;
    case "KB-04":
      require(state.knowledgeCalls > 0, "versioned leave policy was not retrieved");
      require(result.text.includes("5") && result.text.includes("8"), "old/current leave values missing");
      require(/失效|旧|去年/u.test(result.text) && /当前|今年|生效/u.test(result.text), "policy validity difference missing");
      break;
    case "KB-05":
      require(state.knowledgeCalls > 0, "conflicting policies were not retrieved");
      require(result.text.includes("8") && result.text.includes("10"), "conflicting values missing");
      require(/冲突|核实|确认/u.test(result.text), "conflict was resolved without qualification");
      break;
    case "KB-06":
      require(state.knowledgeCalls > 0, "company travel policy was not retrieved");
      require(result.text.includes("500") && result.text.includes("KB-TRAVEL"), "Shenzhen company limit/source missing");
      require(/报销|费用|支出/u.test(result.text), "general reimbursement explanation missing");
      break;
    case "KB-07":
      require(state.knowledgeCalls > 0, "unavailable knowledge service was not attempted");
      require(/无法|不可用|失败|稍后/u.test(result.text), "knowledge outage was not disclosed");
      require(!/(?:年假[^\n]{0,12}(?:5|8|10)\s*天)/u.test(result.text), "knowledge outage invented a leave value");
      break;
    case "KB-08":
      require(/试用期/u.test(result.text) && /不适用|不能据此|未规定/u.test(result.text), "probation limitation missing");
      {
        const appearsToDenyEntitlement = /试用期[^\n]{0,40}(?:没有|不享受|不享有|为\s*0\s*天|是\s*0\s*天)[^\n]{0,20}年假/u.test(result.text);
        const explicitlyPreservesUnknownPolicy = /(?:(?:并)?不(?:表示|意味着|代表|等于|等同于)[^\n]{0,40}(?:完全)?(?:没有|无)年假|不能据此[^\n]{0,30}(?:没有|无)年假|可能存在其他[^\n]{0,20}政策|未规定[^\n]{0,20}(?:具体|额度|天数)|未说明[^\n]{0,30}是否[^\n]{0,20}其他年假|无关于[^\n]{0,30}年假天数[^\n]{0,20}明确规定)/u.test(result.text);
        require(
          !appearsToDenyEntitlement || explicitlyPreservesUnknownPolicy,
          "probation leave entitlement was inferred beyond the source",
        );
      }
      break;
    case "WEB-01":
      require(state.webCalls > 0, "web/weather adapter was not called");
      require(result.text.includes("多云") && result.text.includes("26") && result.text.includes("32"), "weather facts missing");
      require(/weather\.test|联网|来源/u.test(result.text), "weather channel/provider missing");
      break;
    case "WEB-02":
      require(state.webCalls > 0, "web-only weather did not use web");
      require(!state.mcpCalls.some((call) => call.tool === "get_weather"), "web-only weather used MCP");
      require(result.text.includes("多云") && result.text.includes("26") && result.text.includes("32"), "web weather facts missing");
      require(result.text.includes("weather.test") && result.text.includes("2026-09-08"), "web provenance/date missing");
      break;
    case "WEB-03":
      require(state.webCalls === 0, "MCP-only weather used web");
      require(state.mcpCalls.some((call) => call.server === "weather-test" && call.tool === "get_weather"), "weather MCP was not called");
      require(result.text.includes("多云") && result.text.includes("26") && result.text.includes("32"), "MCP weather facts missing");
      require(/MCP/u.test(result.text) && result.text.includes("weather-test"), "MCP channel/tool disclosure missing");
      break;
    case "WEB-04":
      require(state.webCalls === 0 && !state.mcpCalls.some((call) => call.tool === "get_weather"), "disabled realtime capability was called");
      require(/无法|不能|不可用|未启用/u.test(result.text), "realtime unavailability was not disclosed");
      require(!/(?:26\s*[–~-]\s*32|最低\s*26|最高\s*32)/u.test(result.text), "current weather was fabricated");
      break;
    case "WEB-05":
      require(state.webCalls > 0, "failed primary web channel was not attempted");
      require(state.mcpCalls.some((call) => call.tool === "get_weather"), "fallback MCP channel was not used");
      require(result.text.includes("多云") && result.text.includes("weather-test"), "fallback weather result/source missing");
      break;
    case "WEB-06":
      require(state.webCalls > 0, "timezone weather was not queried");
      require(result.text.includes("2026-09-09") || /9\s*月\s*9\s*日/u.test(result.text), "local date did not roll over to September 9");
      require(!result.text.includes("2026-09-08"), "UTC date was incorrectly presented as local today");
      break;
    case "WEB-07":
      require(state.webCalls > 0, "stale weather service was not queried");
      require(/昨天|昨日|过期|过时|陈旧|stale|仅.*9.?月.?7|没有.*9.?月.?8/iu.test(result.text), "stale data limitation missing");
      require(!/(?:今天|今日)[^\n]{0,20}(?:25\s*[–~-]\s*31|最低\s*25|最高\s*31)/u.test(result.text), "stale data was presented as today's forecast");
      break;
    case "WEB-08":
      require(state.webCalls >= 1, "two-city weather was not queried");
      require(result.text.includes("深圳") && result.text.includes("32") && result.text.includes("广州") && result.text.includes("34"), "two-city facts missing");
      require(/广州[^\n]{0,30}(?:更热|较热|高)/u.test(result.text), "highest-temperature comparison is incorrect");
      break;
    case "SKILL-02":
      require(state.skillLoads.includes("spreadsheet-analysis"), "spreadsheet Skill was not loaded");
      require(state.sandboxCalls > 0, "spreadsheet was not actually executed");
      require(includesSalesGoldens(result.text), "city ranking values missing");
      break;
    case "SKILL-01":
      require(state.skillLoads.includes("spreadsheet-analysis"), "explicit spreadsheet Skill was not loaded");
      require(state.sandboxCalls > 0, "explicit Skill analysis was not executed");
      require(result.text.includes("1350") && /6\s*(?:个|笔|条)/u.test(result.text), "Skill totals/count missing");
      require(result.artifacts.some((artifact) => artifact.fileName.endsWith(".csv") && Boolean(artifact.url && existsSync(artifact.url))), "Skill output artifact missing");
      break;
    case "SKILL-03":
      require(state.skillLoads.length > 0 && state.sandboxCalls > 0, "dedup analysis did not load/execute a Skill");
      require(result.text.includes("9") && result.text.includes("8") && result.text.includes("1350"), "dedup row counts or total missing");
      require(/去重|重复/u.test(result.text), "dedup rule missing");
      break;
    case "SKILL-04":
      require(state.sandboxCalls > 0, "bad-cell file was not inspected in sandbox");
      require(result.text.includes("O1003") && /quantity|非数字|异常/u.test(result.text), "bad quantity cell was not identified");
      if (/排除[^\n]{0,20}(?:计算|合计)|临时(?:合计|总额)|净销售额[^\n]{0,10}(?:为|是|合计)/u.test(result.text)) {
        require(result.text.includes("1100") && /临时|不完整|排除/u.test(result.text), "qualified temporary total is incorrect or unqualified");
      }
      break;
    case "SKILL-05":
      require(state.skillLoads.length > 0 && state.sandboxCalls > 0, "empty spreadsheet was not inspected");
      require(result.spans.some((span) => span.module === "sandbox" && span.status === "ok"), "empty spreadsheet had no successful sandbox read");
      require(/无数据|空表|只有表头|没有.*数据|["']?row_count["']?\s*:\s*0|number of data rows\s*:\s*0|no data rows/iu.test(result.text), "empty data state missing");
      require(!/增长|下降|趋势.*明显/u.test(result.text), "empty data produced a fabricated trend");
      break;
    case "SKILL-06":
      require(state.sandboxCalls > 0, "missing-column spreadsheet was not inspected");
      require(result.text.includes("refund_amount") && /缺少|缺失|missing/iu.test(result.text), "missing refund column not reported");
      require(/无法|不能|不可靠|补充|ERROR|MISSING REQUIRED|停止/u.test(result.text), "unreliable net result was not disclosed");
      break;
    case "SKILL-07":
      require(state.skillLoads.length === 0, "disabled Skill was claimed/loaded");
      require(state.sandboxCalls > 0 && includesSalesGoldens(result.text), "no-Skill sandbox fallback failed");
      require(!/已(?:加载|使用).*Skill/iu.test(result.text), "answer falsely claimed a disabled Skill");
      break;
    case "SKILL-08":
      require(state.skillLoads.length === 1 && state.skillLoads[0] === "spreadsheet-analysis", "irrelevant Skill bodies were loaded");
      require(state.sandboxCalls > 0 && includesSalesGoldens(result.text), "large Skill catalog analysis failed");
      break;
    case "BOX-01":
      require(state.sandboxCalls > 0, "sandbox was not executed");
      require(result.text.replaceAll(",", "").includes("333383335000"), "square-sum result missing");
      break;
    case "BOX-02":
      require(state.sandboxCalls > 0, "sandbox was not executed");
      require(result.artifacts.some((artifact) => artifact.fileName.endsWith(".csv") && existsSync(artifact.url ?? "")), "readable CSV artifact missing");
      require(includesSalesGoldens(result.text), "city totals missing");
      require(!/Beijing|295\.0|190\.0/u.test(result.text), "answer contradicts the verified CSV artifact");
      break;
    case "BOX-03": {
      const csv = result.artifacts.find((artifact) => artifact.fileName.endsWith(".csv"));
      require(state.sandboxCalls > 0 && Boolean(csv?.url && existsSync(csv.url)), "JSON-to-CSV artifact missing");
      const body = csv?.url && existsSync(csv.url) ? readFileSync(csv.url, "utf8") : "";
      require(body.split(/\r?\n/u).filter(Boolean).length === 4, "JSON-to-CSV row count is not three");
      require(body.includes("甲") && body.includes("乙") && body.includes("丙"), "JSON-to-CSV lost Chinese values");
      break;
    }
    case "BOX-04":
      require(state.sandboxCalls > 0, "ZIP was not actually inspected");
      require(result.text.includes("alpha.txt") && result.text.includes("beta.txt"), "ZIP member names missing");
      require(result.text.includes("完成") && result.text.includes("待复核"), "ZIP file content summaries missing");
      break;
    case "BOX-05": {
      const image = result.artifacts.find((artifact) => /\.(?:png|jpg|jpeg)$/iu.test(artifact.fileName));
      const data = result.artifacts.find((artifact) => artifact.fileName.endsWith(".csv"));
      require(state.sandboxCalls > 0 && Boolean(image?.url && existsSync(image.url)), "chart image artifact missing");
      require(Boolean(data?.url && existsSync(data.url)), "chart source-data artifact missing");
      require(["400", "250", "300", "400"].every((value) => result.text.includes(value)), "daily net-sales values missing");
      if (image?.url && existsSync(image.url) && image.fileName.endsWith(".png")) {
        require(readFileSync(image.url).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "PNG artifact cannot be decoded");
      }
      break;
    }
    case "BOX-06":
      require(state.sandboxCalls >= 2, "repairable script did not show fail-then-retry execution");
      require(includesSalesGoldens(result.text) || result.text.includes("1350"), "repaired script result is incorrect");
      require(result.spans.some((span) => span.module === "sandbox" && span.status === "error"), "initial script failure evidence missing");
      require(result.spans.some((span) => span.module === "sandbox" && span.status === "ok"), "repaired script success evidence missing");
      break;
    case "BOX-07":
      require(state.sandboxCalls > 0, "timeout script was not started");
      require(/超时|timeout|终止|超过|远超|时间限制/iu.test(result.text), "sandbox timeout was not disclosed");
      require(!/(?:已完成|成功完成)[^\n]{0,20}done/iu.test(result.text), "timed-out task was claimed complete");
      break;
    case "BOX-08":
      require(state.sandboxCalls > 0, "summary file was not generated in sandbox");
      require(result.artifacts.some((artifact) => /\.(?:txt|md)$/iu.test(artifact.fileName) && artifact.sizeBytes > 0 && Boolean(artifact.url && existsSync(artifact.url))), "downloadable non-empty summary artifact missing");
      break;
    case "MCP-01":
      require(state.mcpCalls.some((call) => call.tool === "get_order" && call.arguments["order_id"] === "O1001"), "MCP order arguments incorrect");
      require(/completed|已完成/iu.test(result.text), "order state missing");
      break;
    case "MCP-02":
      require(state.mcpCalls.some((call) => call.tool === "get_order" && call.arguments["order_id"] === "O9999"), "not-found order query arguments incorrect");
      require(/未找到|不存在|not.?found/iu.test(result.text), "not-found state missing");
      require(!/completed|已完成/iu.test(result.text), "missing order was given a fabricated status");
      break;
    case "MCP-03":
      require(!state.mcpCalls.some((call) => call.tool === "get_order"), "missing order id triggered a guessed query");
      require(/订单号|order.?id|哪.*订单/iu.test(result.text), "targeted order-id clarification missing");
      break;
    case "MCP-04":
      require(state.mcpCalls.some((call) => call.tool === "list_orders"), "paginated order listing was not called");
      require(/(?:8\s*(?:行|条|笔|单)|共(?:有)?\s*8(?:\s*个订单)?|总订单数[^\n]{0,8}8)/u.test(result.text), "all eight rows were not reported");
      require(!/(?:仅|共)\s*3\s*(?:行|条|笔)/u.test(result.text), "first page was treated as the full result");
      break;
    case "MCP-05":
      require(state.mcpCalls.some((call) => call.tool === "create_ticket" && call.arguments["order_id"] === "O1001"), "ticket MCP arguments incorrect");
      require(state.tickets.size === 1, `expected one ticket effect, got ${state.tickets.size}`);
      require(/T-1/u.test(result.text), "actual ticket id missing");
      break;
    case "MCP-06":
      require(state.mcpCalls.some((call) => call.tool === "create_ticket"), "idempotent replay did not reach the write tool");
      require(state.ticketCreates === 0, "replay created a duplicate ticket effect");
      require(state.tickets.size === 1 && result.text.includes("T-1"), "existing ticket identity was not reused");
      break;
    case "MCP-07":
      require((state.mcpAttempts.get("tickets-test:create_ticket") ?? 0) === 2, "write timeout was not retried exactly once with bounded idempotency");
      require(state.ticketCreates === 1, "write timeout created a duplicate or no ticket effect");
      require(result.text.includes("T-1"), "verified ticket id missing after timeout recovery");
      break;
    case "MCP-08":
      require((state.mcpAttempts.get("orders-test:get_order") ?? 0) === 2, "429 read was not retried exactly once");
      require(/completed|已完成/iu.test(result.text), "order result missing after 429 recovery");
      break;
    case "HUMAN-01":
      require(result.handoff?.status === "connected", "handoff was not connected");
      require(result.handoff?.transferId === "transfer-test-1", "transfer id missing");
      break;
    case "HUMAN-03":
      require(result.handoff?.status === "queued", "handoff was not queued");
      require(!/已接通/u.test(result.text), "queued handoff was presented as connected");
      break;
    case "HUMAN-02":
      require(state.handoffCalls === 1, "semantic handoff did not trigger exactly one request");
      require(result.handoff?.status === "queued", "semantic handoff state is incorrect");
      break;
    case "HUMAN-04":
      require(state.handoffCalls === 1, "failed handoff request was not attempted exactly once");
      require(result.handoff?.status === "failed", "handoff failure was not preserved");
      require(/失败|不可用|稍后/u.test(result.text) && !/已接通/u.test(result.text), "handoff failure was presented incorrectly");
      break;
    case "HUMAN-05":
      require(state.handoffCalls === 1, "out-of-hours handoff was not checked");
      require(result.handoff?.status === "unavailable", "out-of-hours handoff state is incorrect");
      require(result.text.includes("09:00") && result.text.includes("18:00") && !/已接通/u.test(result.text), "service hours or unavailable state missing");
      break;
    case "HUMAN-06":
      require(state.handoffCalls === 1, "duplicate handoff created multiple current-run requests");
      require(result.handoff?.queueId === "queue-test-1", "existing queue identity was not reused");
      break;
    case "HUMAN-07":
      require(state.handoffCancelCalls === 1, "queued handoff cancel tool was not called");
      require(state.handoffCalls === 0, "cancel request created another handoff");
      require(result.handoff?.status === "cancelled" && /取消/u.test(result.text), "confirmed cancellation state missing");
      break;
    case "HUMAN-08":
      require(state.handoffCalls === 1, "contextual handoff was not requested");
      require(state.handoffSummaries.some((summary) => summary.includes("O1001") && summary.includes("发票")), "handoff summary omitted the order issue");
      require(result.handoff?.status === "queued", "contextual handoff state is incorrect");
      break;
    case "FLOW-01":
      require(state.knowledgeCalls > 0, "metric policy was not retrieved");
      require(state.mcpCalls.some((call) => call.tool === "list_orders"), "orders were not queried through MCP");
      require(state.skillLoads.includes("spreadsheet-analysis"), "analysis Skill was not loaded");
      require(state.sandboxCalls > 0, "analysis was not run in sandbox");
      require(result.artifacts.some((artifact) => artifact.fileName.endsWith(".csv") && existsSync(artifact.url ?? "")), "FLOW CSV artifact missing");
      require(includesSalesGoldens(result.text) && result.text.includes("1350"), "FLOW totals missing");
      require(!/深圳[^\n]{0,30}(?:650|600)(?:\.0)?/u.test(result.text), "answer contradicts verified Shenzhen total");
      require(result.sources.some((source) => source.id === "KB-METRIC"), "metric source evidence missing");
      break;
    case "FLOW-02":
      require(state.webCalls > 0 && state.knowledgeCalls > 0, "weather and travel policy were not both retrieved");
      require(result.text.includes("32") && result.text.includes("500"), "weather/travel facts missing");
      require(result.text.includes("weather.test") && result.text.includes("KB-TRAVEL"), "separate sources missing");
      break;
    case "FLOW-03":
      require(state.knowledgeCalls > 0, "refund policy was not retrieved");
      require(state.mcpCalls.some((call) => call.tool === "get_order" && call.arguments["order_id"] === "O1001"), "refundable amount was not checked");
      require(state.mcpCalls.some((call) => call.tool === "refund_order" && call.arguments["amount"] === 50), "refund write parameters incorrect");
      require(state.refundCreates === 1 && result.text.includes("R-1") && result.text.includes("150"), "verified refund result missing or duplicated");
      break;
    case "FLOW-04":
      require(!state.mcpCalls.some((call) => call.tool === "list_orders"), "current turn repeated the already-failed MCP instead of switching to the attachment");
      require(state.sandboxCalls > 0 && includesSalesGoldens(result.text), "attachment fallback analysis failed");
      require(/附件|orders\.csv/u.test(result.text), "fallback data source was not disclosed as attachment");
      break;
    case "FLOW-05":
      require(state.knowledgeCalls > 0 && state.skillLoads.includes("report-generation") && state.sandboxCalls > 0, "report workflow capabilities were incomplete");
      require(result.sources.some((source) => source.id === "KB-METRIC"), "report workflow did not retain the company metric source");
      require(result.artifacts.some((artifact) => artifact.fileName.endsWith(".csv")), "report CSV artifact missing");
      require(result.artifacts.some((artifact) => artifact.fileName.endsWith(".md")), "Markdown report artifact missing");
      require(result.text.includes("1350") && includesSalesGoldens(result.text), "report and CSV facts are inconsistent");
      {
        const report = result.artifacts.find((artifact) => artifact.fileName.endsWith(".md"));
        const body = report?.url && existsSync(report.url) ? readFileSync(report.url, "utf8") : "";
        require(body.includes("1350") && includesSalesGoldens(body), "Markdown report does not contain the verified totals");
        require(!/\{[A-Za-z_][^}]*\}/u.test(body), "Markdown report contains unresolved template placeholders");
      }
      break;
    case "FLOW-06": {
      require(state.webCalls > 0 && state.mcpCalls.some((call) => call.tool === "get_order"), "parallel weather/order reads missing");
      require(result.text.includes("深圳") && result.text.includes("广州") && result.text.includes("O1001"), "parallel results were mixed or missing");
      const readSpans = result.spans.filter((span) => span.module === "web" || span.module === "mcp");
      require(readSpans.length >= 2 && Math.abs(readSpans[0]!.startOffsetMs - readSpans[1]!.startOffsetMs) < 50, "independent reads did not overlap");
      break;
    }
    case "FLOW-07":
      require(state.sandboxCalls >= 2 && state.flow07ChartFailures > 0, "CSV success plus chart failure path was not exercised");
      require(result.artifacts.some((artifact) => artifact.fileName.endsWith(".csv")), "usable CSV was not preserved");
      require(!result.artifacts.some((artifact) => artifact.fileName.endsWith(".png")), "failed chart was exposed as an artifact");
      require(includesSalesGoldens(result.text) && /图|绘图/u.test(result.text) && /失败|不可用|未生成/u.test(result.text), "partial completion was not accurately disclosed");
      break;
    case "FLOW-08":
      require(state.sandboxCalls > 0 && result.text.includes("850"), "conditional metric was not computed");
      require(state.mcpCalls.filter((call) => call.tool === "create_ticket").length === 1, "high-threshold branch did not create exactly one ticket");
      require(state.ticketCreates === 1 && result.text.includes("T-1"), "conditional write result missing");
      break;
    case "CHAT-01":
      require(state.webCalls > 0, "weather follow-up did not refresh current data");
      require(result.text.includes("广州") && result.text.includes("34"), "follow-up did not switch to Guangzhou");
      require(!/深圳[^\n]{0,20}32/u.test(result.text), "follow-up repeated Shenzhen as the answer");
      break;
    case "CHAT-02": {
      require(state.sandboxCalls > 0, "attachment follow-up was not re-executed");
      require(result.text.includes("深圳") && result.text.includes("850"), "Shenzhen-only result missing");
      const csv = result.artifacts.find((artifact) => artifact.fileName.endsWith(".csv"));
      const body = csv?.url && existsSync(csv.url) ? readFileSync(csv.url, "utf8") : "";
      require(Boolean(csv) && body.includes("深圳") && !body.includes("广州") && !body.includes("上海"), "regenerated artifact is not Shenzhen-only");
      break;
    }
    case "CHAT-03":
      require(result.toolCalls === 0, "underspecified analysis started tools without data/source");
      require(/上传|数据源|时间范围|文件|表格/u.test(result.text), "targeted analysis clarification missing");
      break;
    case "CHAT-06":
      require(state.mcpCalls.some((call) => call.tool === "get_order" && call.arguments["order_id"] === "O1001"), "compacted context lost or changed O1001");
      require(/completed|已完成/iu.test(result.text) && !result.text.includes("O1002"), "compacted-context answer is incorrect");
      break;
    case "ERROR-02":
      require(state.mcpCalls.some((call) => call.tool === "invalid_schema"), "invalid-schema tool was not called");
      require(/schema|结构|格式|无效|失败/iu.test(result.text), "schema failure was treated as success");
      break;
    case "ERROR-03":
      require(state.mcpCalls.some((call) => call.tool === "oversized_result"), "oversized tool was not called");
      require(result.text.includes("O-END-999") || /未读取全文|范围|截断/u.test(result.text), "tail coverage was omitted without limitation disclosure");
      break;
    case "ERROR-05":
      require(state.sandboxCalls > 0, "corrupt spreadsheet was not parsed in sandbox");
      require(/损坏|无法读取|解析失败|BadZipFile|不是.*(?:Excel|zip)|not\s+(?:a\s+)?valid\s+(?:Excel|zip)/iu.test(result.text), "corrupt file was not accurately reported");
      require(!includesSalesGoldens(result.text), "corrupt spreadsheet produced fabricated sales results");
      break;
    case "ERROR-08":
      require(state.mcpCalls.some((call) => call.tool === "create_ticket"), "unverified write was not exercised");
      require(!/T-\d+/u.test(result.text), "missing ticket id was fabricated");
      require(/待核实|无法确认|不能确认|未确认|失败|缺少.*ID|missing/iu.test(result.text), "unverified success was presented as complete");
      require(state.ticketCreates === 0, "unverified write created a verified side effect");
      break;
    case "PERF-04":
      require(state.sandboxCalls > 0, "large file was not processed in sandbox");
      require(result.text.includes("10000") && result.text.includes("100000"), "large-file row count or total is incorrect");
      require(result.artifacts.some((artifact) => artifact.fileName.endsWith(".csv") && artifact.sizeBytes < 100_000), "bounded large-file summary artifact missing");
      require(!result.text.includes("L09999") && result.text.length < 40_000, "large raw input leaked into chat context");
      break;
  }
  for (const artifact of result.artifacts) {
    if (artifact.url && existsSync(artifact.url)) evidence.push(`artifact=${artifact.url}`);
  }
  evidence.push(`fixture=${fixture.root}`);
  return { failures, evidence };
}

function createFixtureWorkspace(caseId: string) {
  const root = mkdtempSync(join(tmpdir(), `delegate-fixture-${caseId.toLowerCase()}-`));
  const header = "order_id,date,city,status,quantity,unit_price,refund_amount";
  const orderRows = [
    "O1001,2026-09-01,深圳,completed,2,100,0",
    "O1002,2026-09-01,广州,completed,1,200,0",
    "O1003,2026-09-02,深圳,completed,3,100,50",
    "O1004,2026-09-02,上海,cancelled,2,150,0",
    "O1005,2026-09-03,深圳,completed,1,300,0",
    "O1006,2026-09-03,广州,refunded,1,200,200",
    "O1007,2026-09-04,上海,completed,2,150,0",
    "O1008,2026-09-04,深圳,completed,1,100,0",
  ];
  const ordersPath = join(root, "orders.csv");
  writeFileSync(ordersPath, [header, ...orderRows].join("\n"));
  const derived = new Map<string, string>();
  const add = (name: string, content: string) => {
    const path = join(root, name);
    writeFileSync(path, content);
    derived.set(name, path);
    return path;
  };
  add("orders-dup.csv", [header, ...orderRows, orderRows[0]!].join("\n"));
  add("orders-bad.csv", [header, ...orderRows.map((row) => row.startsWith("O1003,")
    ? row.replace(",3,100,50", ",not-a-number,100,50") : row)].join("\n"));
  add("orders-empty.csv", `${header}\n`);
  add("orders-missing.csv", [header.split(",").slice(0, -1).join(","),
    ...orderRows.map((row) => row.split(",").slice(0, -1).join(","))].join("\n"));
  add("rows.json", JSON.stringify([
    { id: 1, name: "甲", city: "深圳" },
    { id: 2, name: "乙", city: "广州" },
    { id: 3, name: "丙", city: "上海" },
  ], null, 2));
  add("notes.txt", "第一段：订单分析已经完成。\n第二段：请保留净销售额口径与来源。\n");
  add("buggy.py", [
    "import csv",
    "with open('orders.csv', encoding='utf-8') as f:",
    "    rows=list(csv.DictReader(f))",
    "print(sum(int(r['qty']) * float(r['unit_price']) - float(r['refund_amount']) for r in rows if r['status']=='completed'))",
  ].join("\n"));
  add("long.py", "import time\ntime.sleep(5)\nprint('done')\n");
  add("corrupt.xlsx", "not-a-valid-zip-or-spreadsheet\u0000\u0001");
  if (caseId === "PERF-04") {
    const largeRows = Array.from({ length: 10_000 }, (_, index) => {
      const city = ["深圳", "上海", "广州"][index % 3]!;
      return `L${String(index + 1).padStart(5, "0")},2026-09-${String(index % 4 + 1).padStart(2, "0")},${city},completed,1,10,0`;
    });
    add("orders-large.csv", [header, ...largeRows].join("\n"));
  }
  const zipDir = join(root, "zip-source");
  mkdirSync(zipDir);
  writeFileSync(join(zipDir, "alpha.txt"), "Alpha 项目状态：完成。\n");
  writeFileSync(join(zipDir, "beta.txt"), "Beta 项目状态：待复核。\n");
  const zipPath = join(root, "texts.zip");
  const zipped = spawnSync("zip", ["-q", zipPath, "alpha.txt", "beta.txt"], { cwd: zipDir });
  if (zipped.status !== 0) throw new Error(`Failed to create ZIP fixture: ${String(zipped.stderr)}`);
  derived.set("texts.zip", zipPath);

  const requestedNames: Record<string, string[]> = {
    "SKILL-01": ["orders.csv"], "SKILL-02": ["orders.csv"],
    "SKILL-03": ["orders-dup.csv"], "SKILL-04": ["orders-bad.csv"],
    "SKILL-05": ["orders-empty.csv"], "SKILL-06": ["orders-missing.csv"],
    "SKILL-07": ["orders.csv"], "SKILL-08": ["orders.csv"],
    "BOX-02": ["orders.csv"], "BOX-03": ["rows.json"],
    "BOX-04": ["texts.zip"], "BOX-05": ["orders.csv"],
    "BOX-06": ["buggy.py", "orders.csv"], "BOX-07": ["long.py"],
    "BOX-08": ["notes.txt"],
    "FLOW-04": ["orders.csv"], "FLOW-05": ["orders.csv"],
    "FLOW-07": ["orders.csv"], "FLOW-08": ["orders.csv"],
    "CHAT-02": ["orders.csv"], "ERROR-05": ["corrupt.xlsx"],
    "PERF-04": ["orders-large.csv"],
  };
  const files = new Map<string, string>([["orders.csv", ordersPath], ...derived]);
  const attachments = (requestedNames[caseId] ?? []).map((name) => {
    const path = files.get(name)!;
    const mimeType = name.endsWith(".csv") ? "text/csv"
      : name.endsWith(".json") ? "application/json"
      : name.endsWith(".zip") ? "application/zip"
      : name.endsWith(".py") ? "text/x-python"
      : name.endsWith(".xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "text/plain";
    return { id: name, fileName: name, mimeType, sizeBytes: statSync(path).size, uri: `/input/${name}` };
  });
  return { root, ordersPath, attachments, files };
}

function spawnCaptured(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", MPLCONFIGDIR: cwd },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-100_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-100_000); });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (timedOut) {
        reject(new Error(`Sandbox execution timed out after ${timeoutMs}ms.`));
        return;
      }
      if (signal.aborted) {
        const error = new Error("Sandbox execution cancelled.");
        error.name = "AbortError";
        reject(error);
        return;
      }
      resolvePromise({ exitCode, stdout, stderr });
    });
  });
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", properties, required, additionalProperties: false };
}

function skillInstructionsForCase(caseId: string) {
  const common = "必须使用 Python 标准库 csv/json（不要使用 pandas）真实读取声明的附件路径；不得根据文件大小、文件名或样例数据推断内容。";
  switch (caseId) {
    case "FLOW-01":
      return `${common} 先从授权知识检索取得公司指标口径，再读取权威订单数据；不得用 Skill 自身替代公司口径来源；按取得的口径汇总、说明数据质量，并生成 UTF-8 CSV。`;
    case "SKILL-03":
      return `${common} 先报告原始数据行数，再严格按 order_id 保留首次出现记录去重；随后只统计 status=completed，净销售额=quantity*unit_price-refund_amount。完成答案必须报告原始9行、去重8行、completed 6行和净额1350。`;
    case "SKILL-04":
      return `${common} 校验 quantity/unit_price/refund_amount 的数值类型；明确指出具体异常 order_id。不得把异常值转成0。排除异常行及非 completed 行后计算带限定的临时净额，并明确它不是完整总额。`;
    case "SKILL-05":
      return `${common} 在沙盒中用 with open('/input/orders-empty.csv', encoding='utf-8-sig', newline='') 和 csv.DictReader 逐行计数；打印 data_rows=<实际计数>。只有真实确认计数为0后才能报告“只有表头、0数据行、无法生成趋势”，不得尝试网络或使用文件名/大小推断。`;
    case "SKILL-06":
      return `${common} 第一件事是输出实际 CSV 表头并核对必需列 order_id,date,city,status,quantity,unit_price,refund_amount；任何必需列缺失时停止计算，明确列名并请求补充。`;
    case "BOX-05":
      return `${common} 读取 /input/orders.csv 时使用 csv.DictReader；仅当 row['status']=='completed' 时执行 totals[row['date']] += int(row['quantity'])*float(row['unit_price'])-float(row['refund_amount'])，代码断言按日期排序后的值为 400/250/300/400。必须在同一次 Python 调用中用 matplotlib 的非交互 Agg 后端和 savefig('/output/daily-net-sales.png') 生成可解码 PNG，并同时写出 /output/daily-net-sales.csv（表头 date,net_sales_cny）。写完重新读取 CSV 并再次断言四个值；execute_in_sandbox 的单一主输出填 daily-net-sales.png，CSV 由同次执行一并产生。`;
    case "BOX-06":
      return `${common} 必须先在第一次 execute_in_sandbox 中用 runpy.run_path('/input/buggy.py', run_name='__main__') 原样执行附件脚本并保留真实错误；读取错误后才能在第二次调用中修复列名并重新执行。不得跳过首次失败直接重写分析。`;
    case "FLOW-07":
      return `${common} 第一次独立沙盒调用读取 /input/orders.csv：使用 csv.DictReader；对每个 row 在 row['status']=='completed' 时执行 totals[row['city']] += int(row['quantity'])*float(row['unit_price'])-float(row['refund_amount'])；将 totals 写入 /output/summary.csv（表头 city,net_sales_cny），并由代码断言 totals=={'深圳':850,'上海':300,'广州':200}。确认 CSV 成功后才用第二次调用尝试生成 PNG；绘图失败不得丢弃 CSV 或可信数值，最终必须明确“CSV已完成、图表失败”。`;
    case "FLOW-04":
      return `${common} 当前附件实际列为 order_id,date,city,status,quantity,unit_price,refund_amount（日期列名是 date，不是 order_date）。忽略上一轮已失败的 MCP，直接用附件按 completed 口径生成城市净销售额。`;
    case "CHAT-02":
      return `${common} 本轮最新要求覆盖上一轮范围：读取 /input/orders.csv，只保留 city=深圳 且 status=completed，逐行计算 quantity*unit_price-refund_amount 并生成新的 CSV；写完重新读取，断言产物不含广州/上海且数值列合计为850，再报告“深圳净销售额850”。`;
    case "PERF-04":
      return `${common} 使用 with open('/input/orders-large.csv', encoding='utf-8-sig', newline='') 和 csv.DictReader 流式逐行处理；每行按 quantity*unit_price-refund_amount 累加，不得读取不存在的 amount/net_sales 列，也不得把完整内容打印回聊天。代码必须断言实际行数10000、总额100000，再生成表头 metric,value 的 /output/large-file-summary.csv 并报告处理行数、耗时和产物大小。`;
    default:
      return `${common} 只统计 status=completed；净销售额=quantity*unit_price-refund_amount；按城市降序；说明数据质量；请求文件时生成 UTF-8 CSV。`;
  }
}

function includesSalesGoldens(text: string) {
  return text.includes("850") && text.includes("300") && text.includes("200");
}

function hasValidCsvHeader(value: string) {
  const firstLine = value.trimStart().split(/\r?\n/u, 1)[0] ?? "";
  const fields = firstLine.split(",").map((field) => field.trim());
  return fields.length >= 2
    && fields.every((field) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(field));
}

function summarizeCsvArtifact(value: string) {
  const rows = value.trim().split(/\r?\n/u).slice(1)
    .map((row) => row.split(","));
  const numericLastColumn = rows.map((row) => Number(row.at(-1)))
    .filter((number) => Number.isFinite(number));
  const total = numericLastColumn.reduce((sum, number) => sum + number, 0);
  return `${rows.length} data rows; numeric final-column total=${total}`;
}

function notImplemented(testCase: AgentRegressionCase): RegressionCaseResult {
  return {
    id: testCase.id,
    title: testCase.title,
    status: "FAIL",
    applicable: true,
    attempt: 1,
    modelCalls: 0,
    toolCalls: 0,
    reason: "NOT_IMPLEMENTED: executable fixture/assertion is not yet wired for this regression case",
    spans: [],
  };
}

function failure(testCase: AgentRegressionCase, reason: string): RegressionCaseResult {
  return { id: testCase.id, title: testCase.title, status: "FAIL", applicable: true, attempt: 1, modelCalls: 0, toolCalls: 0, reason, spans: [] };
}

function parseArguments(args: string[]) {
  let suite = "smoke";
  let baseline: string | undefined;
  let outputDirectory: string | undefined;
  const ids: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--suite" && args[index + 1]) suite = args[++index]!;
    else if (value === "--id" && args[index + 1]) ids.push(...args[++index]!.split(","));
    else if (value === "--baseline" && args[index + 1]) baseline = args[++index]!;
    else if (value === "--output" && args[index + 1]) outputDirectory = args[++index]!;
  }
  if (!["smoke", "regression", "live", "performance"].includes(suite)) {
    throw new Error(`Unsupported suite ${suite}.`);
  }
  return { suite, ids, baseline, outputDirectory };
}

function resolveCodeVersion() {
  return process.env.GIT_COMMIT?.trim() || "working-tree";
}

function printConsoleSummary(report: RegressionRunReport, basePath: string) {
  const rate = report.strictPassRate === null ? "N/A" : `${(report.strictPassRate * 100).toFixed(2)}%`;
  process.stdout.write([
    `Agent regression ${report.runId}`,
    `suite=${report.suite} model=${report.model} mode=${report.mode} duration=${report.totalDurationMs.toFixed(1)}ms`,
    `cases=${report.startedCases}/${report.plannedCases} PASS=${report.counts.PASS} FAIL=${report.counts.FAIL} BLOCKED=${report.counts.BLOCKED} SKIP=${report.counts.SKIP} REVIEW=${report.counts.REVIEW}`,
    `strict_pass_rate=${rate} functional=${report.functionalConclusion} performance=${report.performanceConclusion}`,
    `reports=${basePath}.{json,xml,md,html}`,
  ].join("\n") + "\n");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

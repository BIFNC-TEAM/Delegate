import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getGovernedContextSyncPresentation } from "../app/dashboard/dashboard-governed-context-status";

const component = readFileSync(
  new URL("../app/dashboard/dashboard-memory.tsx", import.meta.url),
  "utf8",
);
const representativeSetup = readFileSync(
  new URL("../app/dashboard/dashboard-representative-setup.tsx", import.meta.url),
  "utf8",
);
const framework = readFileSync(
  new URL("../app/dashboard/dashboard-framework.tsx", import.meta.url),
  "utf8",
);
const navigation = readFileSync(
  new URL("../app/dashboard/dashboard-ui-data.ts", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../app/dashboard/dashboard-v2.css", import.meta.url),
  "utf8",
);
const memoryStyles = styles.slice(styles.indexOf("/* Memory System */"));

describe("Memory System dashboard", () => {
  it("keeps the memory URL key while replacing Representative Development", () => {
    expect(navigation).toContain('id: "memory"');
    expect(navigation).toContain('text("记忆系统", "Memory System")');
    expect(navigation).toContain('shortLabel: text("记忆", "Memory")');
    expect(navigation).not.toContain('text("养成", "Representative Development")');
    expect(framework).toContain('props.activeView === "memory"');
    expect(framework).toContain("<DashboardMemory");
    expect(framework).toContain('from "./dashboard-memory"');
    expect(framework).not.toContain("<DashboardTraining");
    expect(framework).not.toContain('from "./dashboard-training"');
    expect(framework).toContain(
      '[zh ? "记忆系统" : "Memory System", "—", zh ? "打开记忆系统查看实时状态" : "Open Memory System for live status"]',
    );
    expect(framework).not.toContain('"养成修订" : "Development revisions"');
    expect(framework).not.toContain('[zh ? "记忆系统" : "Memory System", "42"');
  });

  it("does not load or manage public knowledge through the retired training UI", () => {
    expect(component).not.toContain("/training");
    expect(component).not.toContain("training/sources");
    expect(component).not.toContain("training/suggestions");
    expect(component).not.toContain("training/versions");
    expect(component).toContain('buildDashboardHref("knowledge"');
    expect(component).toContain("打开知识库");
    expect(component).toContain("Public knowledge remains in the Knowledge Library");
    expect(component).toContain("草稿继续留在知识库，不参与线上检索");
  });

  it("uses real governed-memory and retrieval-summary APIs with read-only sync health", () => {
    expect(component).toContain('fetch(root, { cache: "no-store" })');
    expect(component).toContain('fetch(`${root}/memories`, { cache: "no-store" })');
    expect(component).toContain('fetch(`${root}/recall-traces`, { cache: "no-store" })');
    expect(component).not.toContain("/openviking/sync");
    expect(component).not.toContain("resyncPublishedKnowledge");
    expect(component).not.toContain("重新同步");
    expect(component).toContain('action === "delete"');
    expect(component).toContain('{ method: "DELETE" }');
    expect(component).toContain('manageMemory(memory, "suppress")');
    expect(component).toContain('manageMemory(memory, "retry")');
    expect(component).toContain('memory.status === "ACTIVE"');
    expect(component).toContain("snapshot.usage.today");
    expect(component).toContain("snapshot.settings.recentSyncJobs");
  });

  it("reports retrieval records without claiming model injection or citation", () => {
    expect(component).toContain("今日检索记录");
    expect(component).toContain("仅表示检索与授权记录");
    expect(component).toContain("不等于内容实际注入模型、用于回答或展示为来源");
    expect(component).toContain("does not prove that content was injected into the model");
    expect(component).not.toContain("今日实际用于回答");
    expect(component).not.toContain("使用记录数量");
    expect(component).not.toContain("Recall Trace");
  });

  it("shows honest unsupported and unavailable states instead of demo data", () => {
    expect(component).toContain("当前接口尚未提供 Web、Matrix、Telegram");
    expect(component).toContain("候选审核、代表经验和完整筛选能力尚未接入");
    expect(component).toContain("不会显示伪造队列");
    expect(component).toContain("当前页面不会用示例数字代替真实数据");
    expect(component).toContain("!snapshot ?");
    expect(component).toContain('role="alert"');
    expect(component).toContain("snapshot.memories.length ?");
    expect(component).toContain("recentSyncJobs.length ?");
  });

  it("states the long-term memory boundary and keeps technical fields out of the UI", () => {
    expect(component).toContain("原始聊天、Owner 私有备注和 Compute 原始产物不会直接进入长期记忆");
    expect(component).toContain("凭据、支付金额、余额与权益事实不会进入长期记忆");
    expect(component).toContain("autoCapture: false");
    expect(component).not.toContain("viking://");
    expect(component).not.toContain("Target URI");
    expect(component).not.toContain("Agent ID");
    expect(component).not.toContain("<pre");
    expect(component).not.toContain(".score");
    expect(component).not.toContain(".layer");
    expect(component).toContain("正文已从控制台清除，不再参与召回");
  });

  it("normalizes anonymous web visitors and exposes reversible memory actions", () => {
    expect(component).toContain("/^web visitor$/i");
    expect(component).toContain('"匿名访客"');
    expect(component).toContain("停用后，这条记忆将立即停止参与召回");
    expect(component).toContain("删除会立即停止召回，并开始异步物理清理");
    expect(component).toContain("重试清理");
  });

  it("maps every safe sync result to a business status before showing feedback", () => {
    expect(component).toContain(
      "getGovernedContextSyncPresentation(snapshot.settings.lastSyncStatus, locale).label",
    );
    expect(component).toContain("snapshot.settings.recentSyncJobs.slice(0, 6)");
    expect(component).toContain('buildDashboardHref("knowledge"');
    expect(representativeSetup).toContain(
      "getGovernedContextSyncPresentation(\n          nextSnapshot.lastSyncStatus",
    );

    const unpublishedZh = getGovernedContextSyncPresentation(
      "blocked_unpublished",
      "zh",
    );
    const serviceSetupEn = getGovernedContextSyncPresentation(
      "blocked_missing_credentials",
      "en",
    );
    const failedZh = getGovernedContextSyncPresentation("failed", "zh");

    expect(unpublishedZh).toMatchObject({
      outcome: "blocked_unpublished",
      label: "需要先发布",
    });
    expect(serviceSetupEn).toMatchObject({
      outcome: "blocked_service_setup",
      label: "Service setup required",
    });
    expect(failedZh).toMatchObject({
      outcome: "failed",
      label: "同步失败",
    });
  });

  it("uses readable design-system typography, focus, rhythm, and mobile actions", () => {
    expect(styles).toContain("/* Memory System */");
    expect(styles).toContain(".memory-system-page");
    expect(styles).toContain(".memory-system-boundary");
    expect(styles).toContain(".memory-system-record-list");
    expect(styles).toContain(".memory-system-honesty-note");
    expect(memoryStyles).toContain(":where(button, a):focus-visible");
    const remSizes = [...memoryStyles.matchAll(/font-size:\s*([0-9.]+)rem/g)]
      .map((match) => Number(match[1] ?? 0));
    expect(remSizes.length).toBeGreaterThan(0);
    expect(Math.min(...remSizes)).toBeGreaterThanOrEqual(0.75);
    const spacingValues = [
      ...memoryStyles.matchAll(
        /(?:gap|padding|margin-top|margin-bottom):\s*([^;]+);/g,
      ),
    ].flatMap((match) =>
      [...(match[1] ?? "").matchAll(/([0-9]+)px/g)]
        .map((value) => Number(value[1] ?? 0)),
    );
    expect(spacingValues.every((value) => value % 4 === 0)).toBe(true);
    expect(memoryStyles).toContain("@media (max-width: 680px)");
    expect(memoryStyles).toContain("min-height: 44px");
  });
});

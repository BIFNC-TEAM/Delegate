import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const component = readFileSync(
  new URL("../app/dashboard/dashboard-memory.tsx", import.meta.url),
  "utf8",
);
const api = readFileSync(
  new URL("../app/dashboard/dashboard-memory-api.ts", import.meta.url),
  "utf8",
);
const framework = readFileSync(
  new URL("../app/dashboard/dashboard-framework.tsx", import.meta.url),
  "utf8",
);
const representativeSetup = readFileSync(
  new URL("../app/dashboard/dashboard-representative-setup.tsx", import.meta.url),
  "utf8",
);
const representativeMemorySettings = readFileSync(
  new URL("../app/dashboard/dashboard-representative-memory-settings.tsx", import.meta.url),
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
  it("keeps the memory module and exposes four URL-addressable business pages", () => {
    expect(navigation).toContain('id: "memory"');
    expect(navigation).toContain('text("记忆系统", "Memory System")');
    expect(framework).toContain('props.activeView === "memory"');
    expect(framework).toContain("<DashboardMemory");
    expect(api).toContain(
      'type MemorySection = "overview" | "entries" | "usage" | "operations"',
    );
    expect(component).toContain('aria-current={section === item ? "page" : undefined}');
    expect(component).toContain('params.set("section", updates.section)');
    expect(component).toContain('return sections.includes(value as MemorySection)');
  });

  it("uses only the new private business API surface and centralizes requests", () => {
    expect(api).toContain(
      '"overview" | "entries" | "usage" | "operations" | "reconciliation"',
    );
    expect(api).toContain("/api/dashboard/memory/${resource}?");
    expect(api).toContain('cache: "no-store"');
    expect(api).toContain("loadMemoryOverview");
    expect(api).toContain("loadMemoryEntries");
    expect(api).toContain("loadMemoryUsage");
    expect(api).toContain("loadMemoryOperations");
    expect(api).toContain("loadMemoryReconciliation");
    expect(component).not.toContain("/training");
    expect(component).not.toContain("/openviking");
    expect(api).not.toContain("/training");
    expect(api).not.toContain("/openviking");
  });

  it("separates search, injection, citation, and display instead of inflating usage", () => {
    expect(component).toContain("今日搜索命中");
    expect(component).toContain("今日注入模型");
    expect(component).toContain("今日模型引用");
    expect(component).toContain("今日最终展示");
    expect(component).toContain("today.injectedIntoModel");
    expect(component).toContain("today.citedByModel");
    expect(component).toContain("today.displayedSources");
    expect(component).toContain("today.answersUsingMemory");
    expect(component).toContain("今日实际用于回答");
    expect(component).toContain("counts.searchHits");
    expect(component).toContain("counts.scopePassed");
    expect(component).toContain("counts.safetyPassed");
    expect(component).toContain("counts.injectedIntoModel");
    expect(component).toContain("counts.citedByModel");
    expect(component).toContain("counts.displayedSources");
    expect(component).toContain("source.stages.scopePassedAt");
    expect(component).toContain("source.stages.safetyPassedAt");
    expect(component).toContain("source.stages.injectedAt");
    expect(component).toContain("source.stages.citedAt");
    expect(component).toContain("source.stages.displayedAt");
    expect(component).toContain("Candidate stage details");
    expect(component).not.toContain("Recall Trace");
  });

  it("supports truthful entry filtering, stable pagination, and detail deep links", () => {
    for (const filter of [
      "contactId",
      "scope",
      "category",
      "status",
      "source",
      "channel",
      "from",
      "to",
      "query",
    ]) {
      expect(component).toContain(`name="${filter}"`);
    }
    expect(component).toContain('params.set("entryId", updates.entryId)');
    expect(component).toContain('params.set("cursor", updates.cursor)');
    expect(component).toContain('params.set("asOf", updates.asOf)');
    expect(component).toContain("page.nextCursor");
    expect(component).toContain("page.asOf");
    expect(component).toContain("window.location.assign");
    expect(component).toContain("date.toISOString()");
  });

  it("offers every governed lifecycle action with idempotency and explicit deletion confirmation", () => {
    for (const action of [
      "approve_candidate",
      "reject_candidate",
      "block_candidate",
      "request_correction",
      "suppress_memory",
      "archive_memory",
      "restore_memory",
      "request_deletion",
      "retry_cleanup",
      "retry_projection",
      "retry_extraction",
      "enqueue_reconciliation",
    ]) {
      expect(component).toContain(action);
    }
    expect(api).toContain('"Idempotency-Key": idempotencyKey');
    expect(api).toContain('"X-Request-Id": createClientRequestId()');
    expect(component).toContain('command === "retry_cleanup"');
    expect(component).toContain("entry.cleanup?.updatedAt");
    expect(component).toContain("永久删除会立即停止召回，并异步清理物理投影");
    expect(component).toContain("批准后，该候选将获得线上召回资格");
    expect(component).toContain("window.confirm(confirmation)");
  });

  it("keeps public knowledge in Knowledge Library and reports projection read-only", () => {
    expect(component).toContain("公开知识继续由知识库创建、编辑、绑定和发布");
    expect(component).toContain("overview.publicKnowledge.knowledgeLibraryHref");
    expect(component).toContain("overview.publicKnowledge.projectedItemCount");
    expect(component).not.toContain("知识草稿");
    expect(component).not.toContain("发布版本建议");
    expect(component).not.toContain("重新同步公开知识");
  });

  it("shows honest empty, unavailable, unsupported, partial, and recoverable states", () => {
    expect(component).toContain("页面不会用示例数据替代真实结果");
    expect(component).toContain("data.items.length ?");
    expect(component).toContain('role="alert"');
    expect(component).toContain('inventoryStatus === "partial"');
    expect(component).toContain("对账只能报告已知精确投影");
    expect(component).toContain("retry_cleanup");
    expect(component).toContain("partialSuccess");
    expect(component).toContain("Promise.allSettled");
    expect(component).toContain("reconciliationCursor");
    expect(component).toContain("reconciliationItemCursor");
    expect(component).toContain("itemCursor: query.reconciliationItemCursor");
    expect(api).toContain("issuesPage");
    expect(component).toContain("public_knowledge_sync");
    expect(component).not.toMatch(/demo|mock data|sample metric/i);
  });

  it("never renders internal retrieval coordinates or copies raw questions", () => {
    expect(component).toContain("提问正文不在记忆控制台展示");
    expect(component).toContain("仅展示业务版本和清理状态");
    for (const forbidden of [
      "viking://",
      ".uri",
      ".layer",
      ".score",
      "queryText",
      "sessionId",
      "Target URI",
      "Agent ID",
      "<pre",
    ]) {
      expect(component).not.toContain(forbidden);
      expect(api).not.toContain(forbidden);
    }
  });

  it("uses textual states, distinct channel markers, focus styles, and mobile-safe controls", () => {
    expect(component).toContain("supportedEnabled");
    expect(component).toContain("supportedDisabled");
    expect(component).toContain("unsupported");
    expect(styles).toContain(".memory-system-channel.is-web");
    expect(styles).toContain(".memory-system-channel.is-matrix");
    expect(styles).toContain(".memory-system-channel.is-telegram");
    expect(memoryStyles).toContain(':where(button, a, input, select, textarea):focus-visible');
    expect(memoryStyles).toContain("@media (max-width: 680px)");
    expect(memoryStyles).toContain("min-height: 44px");
    expect(memoryStyles).toContain("position: fixed");
    expect(component).toContain("aria-modal={mobileModal ? true : undefined}");
    expect(component).toContain('setAttribute("inert", "")');
    expect(component).toContain("trapModalFocus");
    expect(component).toContain("previouslyFocused?.isConnected");
    const remSizes = [...memoryStyles.matchAll(/font-size:\s*([0-9.]+)rem/g)]
      .map((match) => Number(match[1] ?? 0));
    expect(Math.min(...remSizes)).toBeGreaterThanOrEqual(0.75);
  });

  it("normalizes anonymous web visitors without hiding named contacts", () => {
    expect(component).toContain("/^web visitor$/i");
    expect(component).toContain("/^unknown audience$/i");
    expect(component).toContain('"匿名访客"');
    expect(component).toContain('"Anonymous visitor"');
  });

  it("replaces the legacy representative OpenViking panel with governed Memory settings", () => {
    expect(representativeSetup).toContain("<DashboardRepresentativeMemorySettings");
    expect(representativeSetup).not.toContain("/openviking");
    expect(representativeSetup).not.toContain("syncPublicKnowledge");
    expect(representativeSetup).not.toContain("RepresentativeOpenVikingSnapshot");
    expect(representativeMemorySettings).toContain("loadMemorySettings");
    expect(representativeMemorySettings).toContain("updateMemorySettings");
    expect(representativeMemorySettings).toContain("snapshot.revision");
    expect(representativeMemorySettings).toContain("Web 自动提取仅为联系人记忆创建候选");
    expect(representativeMemorySettings).toContain("!draft.basic.contactMemoryEnabled");
    expect(representativeMemorySettings).toContain("Promise<boolean>");
    expect(representativeMemorySettings).toContain("reloaded ? t.conflict : t.conflictReloadFailed");
    expect(representativeMemorySettings).toContain("首次发送前的记忆披露尚未实现");
    expect(representativeMemorySettings).toContain("serverManaged");
    expect(representativeSetup).toContain('if (activeSection === "memory")');
    expect(representativeSetup).toContain('activeSection !== "memory" ? <div className="dashboard-form-footer">');
    expect(representativeMemorySettings).not.toContain("Agent ID");
    expect(representativeMemorySettings).not.toContain("Target URI");
  });
});

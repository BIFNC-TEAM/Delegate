import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getGovernedContextSyncPresentation } from "../app/dashboard/dashboard-governed-context-status";

const component = readFileSync(
  new URL("../app/dashboard/dashboard-training.tsx", import.meta.url),
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
const developmentStyles = styles.slice(
  styles.indexOf("/* Representative Development */"),
);
const designSystem = readFileSync(
  new URL("../../../DESIGN.md", import.meta.url),
  "utf8",
);

describe("Representative Development dashboard", () => {
  it("keeps the memory URL key while rendering the real development dashboard", () => {
    expect(navigation).toContain('"memory"');
    expect(navigation).toContain('text("养成", "Representative Development")');
    expect(framework).toContain('"memory"');
    expect(framework).toContain('props.activeView === "memory"');
    expect(framework).toContain("<DashboardTraining");
    expect(component).toContain(
      "`/api/dashboard/representatives/${representativeSlug}/training`",
    );
  });

  it("uses real states and explains the draft-versus-release boundary", () => {
    expect(component).toContain("snapshot.summary.pendingSuggestionCount");
    expect(component).toContain("snapshot.summary.pendingFeedbackCount");
    expect(component).toContain("snapshot.summary.availableSourceCount");
    expect(component).toContain("snapshot.summary.appliedVersionCount");
    expect(component).toContain("批准并写入知识草稿");
    expect(component).toContain("发布新的代表版本后才影响公开回答");
    expect(component).toContain("The knowledge draft is not the public version");
    expect(component).toContain("没有真实输入时不会生成示例建议");
    expect(component).toContain("extractTrainingError(response, locale");
    expect(component).toContain("CREATOR_ANSWER_REQUIRED");
    expect(component).toContain("REVISION_HISTORY_AMBIGUOUS");
    expect(component).toContain("请先填写经过 Owner 核实的真实答案");
  });

  it("does not expose raw payloads or internal implementation details", () => {
    expect(component).not.toContain("JSON.stringify(suggestion.draftPayload");
    expect(component).not.toContain("formatPayload(");
    expect(component).not.toContain("<pre");
    expect(component).not.toContain("queryText");
    expect(component).not.toContain("agentId");
    expect(component).not.toContain("targetUri");
    expect(component).not.toContain("baseUrl");
    expect(component).not.toContain("consoleUrl");
    expect(component).not.toContain("deletionError");
    expect(component).not.toContain("lastSyncError");
    expect(component).not.toContain('"owner-dashboard"');
    expect(component).not.toContain("createdBy:");
    expect(component).not.toContain("reviewedBy:");
    expect(component).not.toContain("version.publishedBy");
    expect(component).toContain("version.ownerReviewed ? ` · ${t.ownerReviewed}`");
    expect(navigation).not.toContain("viking://");
    expect(navigation).not.toContain('label: text("公开记忆", "Public Memory")');
  });

  it("requires a real owner answer for knowledge gaps and sends an edited draft", () => {
    expect(component).toContain("knowledgeGapAnswers");
    expect(component).toContain("Owner 核实后的公开答案");
    expect(component).toContain("请先填写经过核实的真实答案");
    expect(component).toContain('suggestion.suggestionType === "knowledge_gap"');
    expect(component).toContain("!isKnowledgeGapAnswerReady(knowledgeGapAnswer)");
    expect(component).toContain("editedDraftPayload: buildKnowledgeGapDraftPayload");
    expect(component).toContain("summary: answer.trim()");
  });

  it("uses the governed context APIs while exposing only business-safe controls", () => {
    expect(component).toContain("记忆与使用");
    expect(component).toContain("不自动从聊天沉淀");
    expect(component).toContain("投影开关");
    expect(component).toContain("同步状态");
    expect(component).toContain("已发布项数");
    expect(component).toContain("使用记录数量");
    expect(component).toContain("受治理记忆");
    expect(component).toContain("重新同步");
    expect(component).toContain("停用");
    expect(component).toContain("重试删除");
    expect(component).toContain('fetch(`${root}/memories`');
    expect(component).toContain('fetch(`${root}/recall-traces`');
    expect(component).toContain("/openviking/sync");
    expect(component).toContain('{ method: "DELETE" }');
    expect(component).toContain('manageMemory(memory, "suppress")');
    expect(component).toContain('manageMemory(memory, "retry")');
    expect(component).toContain('role="switch"');
    expect(component).toContain("aria-checked={governance.settings.enabled}");
  });

  it("maps every safe sync result to a business status before showing feedback", () => {
    expect(component).toContain(
      "getGovernedContextSyncPresentation(\n        nextSettings.lastSyncStatus",
    );
    expect(component).toContain('syncState.outcome === "success"');
    expect(representativeSetup).toContain(
      "getGovernedContextSyncPresentation(\n          nextSnapshot.lastSyncStatus",
    );
    expect(representativeSetup).toContain('syncState.outcome === "success"');

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
    expect(
      [
        unpublishedZh.label,
        unpublishedZh.actionMessage,
        serviceSetupEn.label,
        serviceSetupEn.actionMessage,
        failedZh.label,
        failedZh.actionMessage,
      ].join(" "),
    ).not.toMatch(/blocked_|credentials|OpenViking/u);
  });

  it("keeps governed-context copy localized and hides implementation terminology", () => {
    expect(representativeSetup).toContain('label: "记忆与使用"');
    expect(representativeSetup).toContain('memoryEyebrow: "记忆与使用"');
    expect(representativeSetup).toContain('recallLimit: "单次检索上限"');
    expect(representativeSetup).toContain('syncStatus: "同步状态"');
    expect(representativeSetup).toContain(
      "getGovernedContextSyncPresentation(\n            openVikingDraft?.lastSyncStatus",
    );
    expect(representativeSetup).not.toContain('"最后再配置 OpenViking');
    expect(representativeSetup).not.toContain('"Configure advanced OpenViking');
    expect(representativeSetup).not.toContain('"Enable OpenViking');
    expect(representativeSetup).not.toContain('"Save OpenViking');
    expect(representativeSetup).not.toContain('"OpenViking 服务');
  });

  it("uses readable design-system typography, focus, rhythm, and mobile actions", () => {
    expect(styles).toContain(".representative-development-page");
    expect(styles).toContain(".representative-development-trust");
    expect(styles).toContain(".representative-development-suggestion");
    expect(styles).toContain(".representative-development-governance");
    expect(styles).toContain(".representative-development-memory-list");
    expect(styles).toContain(".representative-development-answer-editor");
    expect(developmentStyles).toContain(
      ":where(button, a, input, select, textarea, summary):focus-visible",
    );
    expect(developmentStyles).toMatch(
      /\.representative-development-sources input,[\s\S]*?font-size: 1rem;/,
    );
    expect(developmentStyles).toMatch(
      /\.representative-development-answer-editor textarea[\s\S]*?font-size: 1rem;/,
    );
    const remSizes = [...developmentStyles.matchAll(/font-size:\s*([0-9.]+)rem/g)]
      .map((match) => Number(match[1] ?? 0));
    expect(remSizes.length).toBeGreaterThan(0);
    expect(Math.min(...remSizes)).toBeGreaterThanOrEqual(0.75);
    const spacingValues = [
      ...developmentStyles.matchAll(
        /(?:gap|padding|margin-top|margin-bottom):\s*([^;]+);/g,
      ),
    ].flatMap((match) =>
      [...(match[1] ?? "").matchAll(/([0-9]+)px/g)]
        .map((value) => Number(value[1] ?? 0)),
    );
    expect(spacingValues.every((value) => value % 4 === 0)).toBe(true);
    expect(styles).toContain("@media (max-width: 680px)");
    expect(styles).toContain("min-height: 44px");
    expect(developmentStyles).toMatch(
      /\.representative-development-projection-toggle\s*\{[\s\S]*?min-height:\s*44px;/u,
    );
  });

  it("keeps the design-system information architecture aligned with Development", () => {
    expect(designSystem).toContain("Representative Development（养成）");
    expect(designSystem).not.toContain("Skills, Wallet, Memory, Analytics");
  });
});

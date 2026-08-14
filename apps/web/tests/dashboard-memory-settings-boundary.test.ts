import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const framework = read("../app/dashboard/dashboard-framework.tsx");
const navigation = read("../app/dashboard/dashboard-ui-data.ts");
const page = read("../app/dashboard/page.tsx");
const operations = read("../app/dashboard/dashboard-representative-operations.tsx");
const settings = read("../app/dashboard/dashboard-representative-memory-settings.tsx");
const setup = read("../app/dashboard/dashboard-representative-setup.tsx");
const styles = read("../app/dashboard/dashboard-v2.css");
const memorySettingsData = read("../../../packages/web-data/src/memory-settings.ts");

describe("representative-scoped memory settings", () => {
  it("removes the top-level Memory System and redirects its legacy URL", () => {
    expect(navigation).not.toContain('id: "memory"');
    expect(framework).not.toContain("DashboardMemory");
    expect(framework).not.toContain('props.activeView === "memory"');
    expect(page).toContain('requestedView === "memory"');
    expect(page).toContain('legacyMemoryParams.set("setupSection", "memory")');
    expect(page).toContain('view: "representatives"');
    expect(memorySettingsData).toContain('repSection: "setup"');
    expect(memorySettingsData).toContain('setupSection: "memory"');
    expect(memorySettingsData).not.toContain('section: "memory"');
  });

  it("keeps all memory controls inside Digital Representative configuration", () => {
    expect(setup).toContain("<DashboardRepresentativeMemorySettings");
    expect(setup).toContain('label: "记忆"');
    expect(setup).toContain('label: "Memory"');
    expect(settings).toContain("draft.basic.autoExtract");
    expect(settings).toContain("draft.basic.contactMemoryEnabled");
    expect(settings).toContain("snapshot.basic.contactMemoryCrossChannelSupported === true");
    expect(settings).toContain("跨渠道连续性");
    expect(settings).toContain("Dashboard 不提供开关");
    expect(settings).toContain("draft.basic.representativeExperienceEnabled");
    expect(settings).toContain("draft.basic.longTermMemoryEnabled");
    expect(settings).toContain("draft.basic.shortTermMemoryEnabled");
    expect(settings).not.toContain("openMemory");
    expect(settings).not.toContain("memoryHref");
  });

  it("reports runtime channel and OpenViking facts without invented defaults", () => {
    expect(settings).toContain("snapshot.channels[channel]");
    expect(settings).toContain("draft.channels[channel]");
    expect(settings).toContain("support.recallSupported");
    expect(settings).toContain("support.extractSupported");
    expect(settings).toContain('["web", "matrix", "telegram"]');
    expect(settings).toContain("matrix: { ...policy.channels.matrix }");
    expect(settings).toContain("telegram: { ...policy.channels.telegram }");
    expect(settings).not.toContain("next.channels.matrix = { recallEnabled: false");
    expect(settings).not.toContain("next.channels.telegram = { recallEnabled: false");
    expect(settings).toContain("snapshot.advanced.sync");
    expect(settings).toContain("syncPresentation.connectionStatus");
    expect(settings).toContain("syncPresentation.operationalStatus");
    expect(settings).toContain("syncPresentation.inventoryCapability");
    expect(settings).toContain('providerConnection: "连接配置"');
    expect(settings).toContain("仅核对已知投影");
    expect(settings).toContain("sync?.inventoryCoverage");
    expect(settings).toContain("sync?.lastReconciledAt");
    expect(settings).toContain("sync?.retryStrategy");
    expect(settings).toContain("managedNamespace?.trim() || t.notReported");
    expect(settings).not.toContain("managedAgentId?.trim() || t.notReported");
    expect(settings).not.toContain("managedTargetUri?.trim() || t.notReported");
    expect(settings).toContain("managedUserId?.trim() || t.managedUserFallback");
    expect(settings).toContain("snapshot.advanced.managedUriStrategy");
    expect(settings).toContain("t.dynamicUriValue");
    expect(settings).toContain("lastErrorCode !== capabilityCode");
  });

  it("describes automatic policy rather than human memory approval", () => {
    expect(settings).toContain("不再进入人工审批");
    expect(settings).toContain("without a human approval queue");
    expect(settings).not.toContain("不会自动批准");
    expect(settings).not.toContain("manually reviewed before recall");
  });

  it("treats Memory as an immediate runtime policy without inventing sidebar status", () => {
    expect(settings).toContain("保存后立即作为实时运行策略生效");
    expect(settings).toContain("applies the live runtime policy immediately");
    expect(operations).toContain("记忆页单独保存的实时策略立即生效");
    expect(setup).toContain("实时策略，保存即生效");
    expect(setup).toContain('activeSection === "memory"');
    expect(setup).toContain('case "memory":\n      return [];');
    expect(setup).not.toContain('value: "Policy applied"');
    expect(setup).not.toContain('value: "策略自动应用"');
  });

  it("leaves cross-channel sharing under verified-user control", () => {
    expect(settings).toContain("跨渠道连续性");
    expect(settings).toContain("Cross-channel continuity");
    expect(settings).toContain("用户授权控制");
    expect(settings).toContain("User-controlled consent");
    expect(settings).toContain("Dashboard 不提供开关");
    expect(settings).toContain("Dashboard does not provide a switch");
    expect(settings).toContain("已验证用户默认开启");
    expect(settings).toContain("defaults on for verified users");
    expect(settings).toContain("representative-memory-settings-consent-note");
    expect(settings).not.toContain("crossChannelDisabledReason");
    expect(settings).not.toContain('updateBasic("contactMemoryCrossChannelEnabled"');
    expect(settings).toContain("disabledReason={memoryTypeDisabledReason}");
    expect(settings).toContain("recallDisabledReason={memoryTypeDisabledReason}");
    expect(settings).toContain("extractDisabledReason={extractionDisabledReason}");
  });

  it("does not ship obsolete Representative Development styles", () => {
    expect(styles).not.toContain("Representative Development");
    expect(styles).not.toContain("representative-development-");
  });
});

function read(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

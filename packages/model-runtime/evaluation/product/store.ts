import { PRODUCT_SCOPE, assertNoCloud, validateProductEnvironment } from "./scope";

/** Imports business data helpers only after the isolated endpoint gate. No global seed/reset. */
export async function openProductStore(env: NodeJS.ProcessEnv = process.env) {
  validateProductEnvironment(env);
  process.env.DATABASE_URL = env.AGENT_TEST_DATABASE_URL!;
  const data = await import("../../../web-data/src/index");
  const { prisma } = data;
  const { slug, ownerId, marker } = PRODUCT_SCOPE;
  const allowedServers = ["https://open-meteo.caseyjhand.com/mcp", "https://dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp"];
  async function prepare() {
    const existing = await prisma.representative.findUnique({ where: { slug } });
    if (existing) {
      if (existing.ownerId !== ownerId) throw Error("fixture_owner_mismatch");
      if (existing.activeVersionId) return preflight(); // Never overwrite a published fixture.
    }
    await prisma.owner.upsert({ where: { id: ownerId }, update: {}, create: { id: ownerId, displayName: "星河科技（合成验收）", timezone: "Asia/Shanghai" } });
    if (!existing) await data.createRepresentative({ ownerName: "星河科技（合成验收）", representativeName: "星河公开资料助手", slug,
      tagline: "星河科技AI信息代理；企业资料为合成测试数据，不能作出业务承诺。" }, { ownerId });
    const rep = await prisma.representative.findUniqueOrThrow({ where: { slug } });
    await prisma.representative.update({ where: { id: rep.id }, data: { accessMode: "FREE", freeReplyLimit: 1000, humanInLoop: false, sandboxTestEligible: false } });
    await prisma.representativeSkillPack.updateMany({ where: { representativeId: rep.id }, data: { enabled: false } });
    const setup = await data.getRepresentativeSetupSnapshot(slug);
    if (!setup) throw Error("fixture_setup_missing");
    await data.updateRepresentativeSetup({ representativeSlug: slug, changedBy: ownerId, syncOpenViking: false, input: {
      ...setup, publicMode: true, handoffPrompt: "当前未接入真人接待。", agentBehavior: { version: 1, answerScope: "open_public", knowledgePolicy: "owner_facts", commitmentPolicy: "information_only" },
      knowledgePack: { identitySummary: `${marker}：星河科技是合成测试企业。`, faq: [], materials: [], policies: [
        { id: "product10-leave", title: "星河科技年假制度（合成）", kind: "policy", summary: "版本2026.1，2026-01-01生效；正式员工每年年假12天，试用期不适用。" },
        { id: "product10-travel", title: "星河科技差旅制度（合成）", kind: "policy", summary: "版本2026.1，2026-01-01生效；国内出差住宿报销上限每晚500元，按实际发生金额，不超过上限；申请需住宿发票和出差日期。未提供审批人或时限。" },
      ] },
      compute: { ...setup.compute, enabled: true, defaultPolicyMode: "deny", networkMode: "full", networkAllowlist: [], autoApproveTokenLimit: 1000,
        capabilityModes: { exec: "deny", write: "deny", read: "deny", process: "deny", browser: "deny", mcp: "allow" } },
    } });
    for (const binding of [
      { slug: "weather", displayName: "只读天气", serverUrl: allowedServers[0]!, allowedToolNames: ["openmeteo_search_locations", "openmeteo_get_forecast"], defaultToolName: "openmeteo_search_locations", description: "城市定位和实时天气，只读，不能查询企业内部资料。" },
      { slug: "public_search", displayName: "只读公开搜索", serverUrl: allowedServers[1]!, allowedToolNames: ["search_pro"], defaultToolName: "search_pro", description: "搜索公开互联网资料，只读；不能核实企业内部奖金，不发送个人标识。" },
    ]) await prisma.representativeMcpBinding.upsert({ where: { representativeId_slug: { representativeId: rep.id, slug: binding.slug } }, update: {}, create: { ...binding, representativeId: rep.id, transportKind: "STREAMABLE_HTTP", enabled: true, approvalRequired: false, maxRetries: 0, retryBackoffMs: 0, estimatedTokensPerCall: 1000 } });
    const { syncRepresentativeMcpToolDefinitions } = await import("../../../../apps/compute-broker/src/mcp-tool-definitions");
    const brokerDb = (await import("../../../../apps/compute-broker/src/prisma")).prisma;
    try { for (const binding of await prisma.representativeMcpBinding.findMany({ where: { representativeId: rep.id } })) await syncRepresentativeMcpToolDefinitions(binding.id); }
    finally { await brokerDb.$disconnect(); }
    await data.publishRepresentativeVersion({ representativeSlug: slug, publishedBy: ownerId, ownerId, changeSummary: marker + ": dedicated non-sandbox product acceptance" });
    const published = await prisma.representative.findUniqueOrThrow({ where: { slug } });
    if (!published.openvikingLastSyncJobId) throw Error("fixture_sync_missing");
    const sync = await data.processRepresentativeOpenVikingSyncJob({ jobId: published.openvikingLastSyncJobId });
    if (sync.status !== "succeeded") throw Error("fixture_sync_incomplete");
    return preflight();
  }
  async function preflight() {
    const rep = await prisma.representative.findUniqueOrThrow({ where: { slug }, include: { activeVersion: true, owner: { select: { displayName: true } } } });
    if (rep.ownerId !== ownerId || !rep.activeVersion || rep.sandboxTestEligible || rep.accessMode !== "FREE") throw Error("fixture_scope_mismatch");
    const snapshot = rep.activeVersion.snapshot as any;
    if (!JSON.stringify(snapshot).includes(marker)) throw Error("fixture_marker_missing");
    const authority = await data.getRepresentativeRuntimeAuthoritySnapshot(slug, rep.activeVersion.id);
    if (!authority) throw Error("fixture_authority_missing");
    assertNoCloud(authority);
    if (authority.compute.capabilityModes.mcp !== "allow") throw Error("fixture_mcp_not_allowed");
    if (authority.compute.autoApproveTokenLimit < 1000) throw Error("fixture_mcp_budget_requires_approval");
    if (authority.mcpBindings.length !== 2 || authority.mcpBindings.some(b => !allowedServers.includes(b.serverUrl))) throw Error("fixture_tool_scope_mismatch");
    if (authority.mcpBindings.some(b => b.allowedToolNames.some(name => !(b.toolDefinitions ?? []).some(t => t.exactToolName === name)))) throw Error("fixture_tool_definitions_missing");
    if (rep.openvikingLastSyncStatus !== "succeeded") throw Error("fixture_not_synced");
    const resources = await prisma.representativeVersionResource.findMany({ where: { representativeId: rep.id, publishedVersionId: rep.activeVersion.id }, select: { resourceKey: true, contentHash: true, safeText: true, citationTitle: true } });
    if (!resources.length) throw Error("fixture_resources_missing");
    const skills = await prisma.representativeSkillPack.count({ where: { representativeId: rep.id, enabled: true } });
    if (skills) throw Error("fixture_skills_not_disabled");
    return { representativeId: rep.id, versionId: rep.activeVersion.id, publishedAt: rep.activeVersion.publishedAt.toISOString(),
      identity: { ...snapshot.identity, ownerId, ownerName: rep.owner.displayName, agentBehavior: snapshot.agentBehavior },
      snapshot, resources, capabilityModes: authority.compute.capabilityModes,
      mcp: authority.mcpBindings.map(b => ({ slug: b.slug, allowedToolNames: b.allowedToolNames, tools: (b.toolDefinitions ?? []).map(t => ({ name: t.exactToolName, description: t.description })) })),
      sandboxLeases: await prisma.sandboxLease.count({ where: { sandboxIdentity: { representativeId: rep.id } } }),
      browserSessions: await prisma.browserSession.count({ where: { representativeId: rep.id } }),
    };
  }
  async function observe(runId: string, expectedVersion: string) {
    const run = await prisma.generationRun.findFirstOrThrow({ where: { id: runId, conversation: { representative: { slug, ownerId } } },
      include: { inputMessage: { select: { text: true } }, outputMessage: { select: { text: true } }, memoryUseRun: { include: { items: { include: { publicKnowledgeProjection: { include: { publishedResource: true } } } } } } } });
    if (run.representativeVersionId !== expectedVersion) throw Error("published_version_changed");
    const trace = (run.contextSnapshot as any)?.agentTrace;
    const traceAvailable = trace?.runtime === "delegate-agent-v2" && typeof trace.status === "string";
    const t = traceAvailable ? trace : {};
    const items = run.memoryUseRun?.items ?? [];
    const knowledge = items.filter(i => i.injectedAt).map(i => {
      const resource = i.publicKnowledgeProjection?.publishedResource;
      if (!resource || resource.publishedVersionId !== expectedVersion || resource.representativeId !== i.representativeId || resource.contentHash !== i.contentHash || !i.scopePassedAt || !i.safetyPassedAt) throw Error("knowledge_evidence_scope_mismatch");
      return { id: i.id, title: resource.citationTitle, contentHash: resource.contentHash, text: resource.safeText, cited: !!i.citedAt };
    });
    const executions = await prisma.toolExecution.findMany({ where: { session: { generationRunId: runId }, capability: "MCP" },
      select: { id: true, status: true, transportOutcome: true, semanticOutcome: true, finishedAt: true,
        artifacts: { select: { id: true, mimeType: true, sizeBytes: true } }, mcpBinding: { select: { slug: true, representativeId: true } } } });
    const receipts = executions.map(e => {
      if (!e.mcpBinding || e.mcpBinding.representativeId !== runRepresentativeId) throw Error("tool_receipt_scope_mismatch");
      return { id: e.id, status: e.status, binding: e.mcpBinding.slug, transportOutcome: e.transportOutcome,
        semanticOutcome: e.semanticOutcome, finishedAt: e.finishedAt, artifacts: e.artifacts };
    });
    return { runId, conversationId: run.conversationId, versionId: run.representativeVersionId,
      deliveryStatus: run.status, answer: run.outputMessage?.text ?? "", input: run.inputMessage.text,
      model: run.model, traceAvailable, traceId: t.traceId ?? null, taskStatus: t.status ?? null, taskId: t.v2Task?.taskId ?? null,
      usage: { ...t.v2Task?.usage, costUsd: null }, usageScope: "cumulative-task" as const,
      runUsage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens, costUsd: null },
      calls: t.calls ?? [], modelCalls: t.modelCalls, sources: t.sources ?? [],
      knowledge, receipts, retrieval: run.memoryUseRun ? { id: run.memoryUseRun.id, injectedCount: run.memoryUseRun.injectedCount, searchedCount: run.memoryUseRun.searchedCount } : null };
  }
  const scoped = await prisma.representative.findUnique({ where: { slug }, select: { id: true } });
  let runRepresentativeId = scoped?.id;
  return { prepare: async () => { const r = await prepare(); runRepresentativeId = r.representativeId; return r; },
    preflight, observe, close: () => prisma.$disconnect() };
}
export type ProductStore = Awaited<ReturnType<typeof openProductStore>>;
export type ProductSnapshot = Awaited<ReturnType<ProductStore["preflight"]>>;
export type ProductObservation = Awaited<ReturnType<ProductStore["observe"]>>;

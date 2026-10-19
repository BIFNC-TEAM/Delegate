/** Dedicated, fictional acceptance data. Never run against the developer/production DB. */
import { prisma, createRepresentative, getRepresentativeSetupSnapshot, updateRepresentativeSetup,
  publishRepresentativeVersion, processRepresentativeOpenVikingSyncJob } from "../packages/web-data/src/index";

const slug = "agent-v2-acceptance";
const ownerId = "owner_agent_v2_acceptance";
const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid");
if (database.hostname !== "127.0.0.1" || database.port !== "15432" || database.pathname !== "/delegate") {
  throw new Error("V2 acceptance seed requires the isolated 127.0.0.1:15432/delegate database.");
}

async function main() {
  await prisma.owner.upsert({ where: { id: ownerId }, update: {},
    create: { id: ownerId, displayName: "星河科技（合成验收数据）", timezone: "Asia/Shanghai" } });
  let representative = await prisma.representative.findUnique({ where: { slug } });
  if (representative && representative.ownerId !== ownerId) throw new Error("Acceptance slug belongs to another owner.");
  if (!representative) {
    await createRepresentative({ ownerName: "星河科技（合成验收数据）", representativeName: "星河科技 V2 验收代理",
      slug, tagline: "V2 本地验收；企业制度为合成测试数据，天气来自实际工具。" }, { ownerId });
    representative = await prisma.representative.findUniqueOrThrow({ where: { slug } });
  }
  // Changes are restricted to this dedicated acceptance representative.
  await prisma.representative.update({ where: { id: representative.id }, data: {
    accessMode: "FREE", freeReplyLimit: 1000, humanInLoop: false, sandboxTestEligible: true,
  } });
  await prisma.representativeSkillPack.updateMany({ where: { representativeId: representative.id }, data: { enabled: false } });
  const setup = await getRepresentativeSetupSnapshot(slug);
  if (!setup) throw new Error("Acceptance representative unavailable.");
  await updateRepresentativeSetup({ representativeSlug: slug, changedBy: ownerId, syncOpenViking: false, input: {
    ...setup, ownerName: "星河科技（合成验收数据）", publicMode: true,
    agentBehavior: { version: 1, answerScope: "open_public", knowledgePolicy: "owner_facts", commitmentPolicy: "information_only" },
    knowledgePack: {
      identitySummary: "星河科技是本地 V2 验收使用的虚构企业。下列企业制度均为合成数据，不代表现实企业。",
      faq: [], materials: [], policies: [
        { id: "v2-leave-2026", title: "星河科技年假制度（合成验收）", kind: "policy", summary: "制度版本 2026.1，自 2026-01-01 起生效。星河科技正式员工每年年假 12 天；试用期员工不适用。" },
        { id: "v2-travel-2026", title: "星河科技差旅制度（合成验收）", kind: "policy", summary: "制度版本 2026.1，自 2026-01-01 起生效。星河科技员工国内出差住宿报销上限为每晚 500 元，按实际发生金额报销，不得超过上限。" },
      ],
    },
    compute: { ...setup.compute, enabled: true, defaultPolicyMode: "deny", baseImage: "python:3.12-slim",
      networkMode: "full", networkAllowlist: [], filesystemMode: "read_only_workspace", autoApproveTokenLimit: 100000,
      capabilityModes: { read: "allow", browser: "allow", mcp: "allow", exec: "deny", write: "deny", process: "deny" } },
  } });
  await prisma.representativeMcpBinding.upsert({ where: { id: "agent_v2_acceptance_weather" }, update: {}, create: {
    id: "agent_v2_acceptance_weather", representativeId: representative.id, slug: "weather",
    displayName: "Open-Meteo 天气", description: "真实城市定位与天气查询；企业测试制度不包含实时天气。",
    serverUrl: "https://open-meteo.caseyjhand.com/mcp", transportKind: "STREAMABLE_HTTP",
    allowedToolNames: ["openmeteo_search_locations", "openmeteo_get_forecast"], defaultToolName: "openmeteo_search_locations",
    enabled: true, approvalRequired: false, maxRetries: 0, retryBackoffMs: 0, estimatedTokensPerCall: 1000,
  } });
  const version = await publishRepresentativeVersion({ representativeSlug: slug, publishedBy: ownerId, ownerId,
    changeSummary: "Local V2 acceptance: two fictional policies, read-only live weather MCP; no payroll records." });
  const published = await prisma.representative.findUniqueOrThrow({ where: { slug } });
  if (!published.openvikingLastSyncJobId) throw new Error("Missing publication sync job.");
  process.stdout.write(JSON.stringify({ slug, version: version.id, syncJob: published.openvikingLastSyncJobId }) + "\n");
  const sync = await processRepresentativeOpenVikingSyncJob({ jobId: published.openvikingLastSyncJobId });
  process.stdout.write(JSON.stringify({ sync }) + "\n");
  if (sync.status !== "succeeded") process.exitCode = 1;
}

main().finally(() => prisma.$disconnect()).catch(error => {
  console.error(error instanceof Error ? error.message : "Acceptance seed failed"); process.exitCode = 1;
});

import {
  PolicyDecision,
  CapabilityKind,
  Prisma,
  PrismaClient,
  SkillPackSource,
  WorkspaceSkillInstallStatus,
  WorkspaceSkillReleaseStatus,
  WorkspaceSkillReviewStatus,
  WorkspaceSkillSignatureStatus,
} from "@prisma/client";
import { createHash } from "node:crypto";

const databaseUrl = process.env.AGENT_TEST_DATABASE_URL?.trim();
if (!databaseUrl || !/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:15432\/delegate(?:\?|$)/u.test(databaseUrl)) {
  throw new Error("AGENT_TEST_DATABASE_URL must target the isolated 127.0.0.1:15432 Delegate database.");
}

async function main() {
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const representative = await prisma.representative.findUnique({
  where: { slug: "lin-founder-rep" },
  include: { activeVersion: true },
});
if (!representative?.activeVersion) throw new Error("Seeded test representative or active version is missing.");

const kbPolicies = [
  { id: "KB-LEAVE-CURRENT", title: "KB-LEAVE-CURRENT", kind: "policy", summary: "2026-09-01 当前有效：转正员工年假 8 天；试用期不适用本条。" },
  { id: "KB-TRAVEL", title: "KB-TRAVEL", kind: "policy", summary: "2026-09-01 当前有效：深圳住宿上限 500 元/晚，北京 600 元/晚。" },
  { id: "KB-REFUND", title: "KB-REFUND", kind: "policy", summary: "完成订单退款金额不得高于该订单剩余可退金额。" },
  { id: "KB-METRIC", title: "KB-METRIC", kind: "policy", summary: "净销售额只统计 completed 订单，金额 = quantity × unit_price − refund_amount；均为人民币。" },
  { id: "KB-HANDOFF", title: "KB-HANDOFF", kind: "policy", summary: "真人客服服务时间每天 09:00–18:00，时区 Asia/Shanghai。" },
];

const skill = await prisma.skillPack.upsert({
  where: { source_slug: { source: SkillPackSource.BUILTIN, slug: "spreadsheet-analysis" } },
  create: {
    id: "agent_test_skill_spreadsheet",
    source: SkillPackSource.BUILTIN,
    slug: "spreadsheet-analysis",
    displayName: "表格分析",
    summary: "检查数据质量，按已检索的业务口径汇总 CSV，并生成可验证文件。",
    version: "1.0.0",
    capabilityTags: ["csv", "spreadsheet", "analysis", "report"],
    executesCode: true,
  },
  update: {},
});
const install = await prisma.workspaceSkillInstall.upsert({
  where: { ownerId_skillPackId: { ownerId: representative.ownerId, skillPackId: skill.id } },
  create: {
    id: "agent_test_skill_install_spreadsheet",
    ownerId: representative.ownerId,
    skillPackId: skill.id,
    status: WorkspaceSkillInstallStatus.INSTALLED,
    reviewStatus: WorkspaceSkillReviewStatus.APPROVED,
    installedVersion: "1.0.0",
    installedBy: representative.ownerId,
  },
  update: {
    status: WorkspaceSkillInstallStatus.INSTALLED,
    reviewStatus: WorkspaceSkillReviewStatus.APPROVED,
    installedVersion: "1.0.0",
  },
});
const spreadsheetSkillInstructions = [
  "使用 Python 标准库 csv.DictReader 读取声明的 CSV 附件路径，不得根据文件名或文件大小推断内容。",
  "只处理 status == 'completed' 的行；净销售额严格计算为 int(quantity) * float(unit_price) - float(refund_amount)。",
  "写出文件后必须重新读取并核验表头、数据行、过滤条件和数值合计；核验失败时不得声明完成。",
  "用户要求缩小范围时，以最新要求覆盖旧范围并重新生成产物。",
].join("\n");
const spreadsheetSkillInstructionsSha256 = createHash("sha256")
  .update(spreadsheetSkillInstructions)
  .digest("hex");
await prisma.workspaceSkillRelease.upsert({
  where: { installId_version: { installId: install.id, version: "1.0.0" } },
  create: {
    id: "agent_test_skill_release_spreadsheet",
    installId: install.id,
    version: "1.0.0",
    status: WorkspaceSkillReleaseStatus.INSTALLED,
    displayName: "表格分析",
    summary: "先读取授权口径，再在隔离沙盒中分析 CSV 并生成结果文件。",
    capabilityTags: ["csv", "spreadsheet", "analysis", "report"],
    executesCode: true,
    instructions: spreadsheetSkillInstructions,
    instructionsSha256: spreadsheetSkillInstructionsSha256,
    resources: ["skill://builtin/spreadsheet-analysis/1.0.0"],
    signatureStatus: WorkspaceSkillSignatureStatus.VERIFIED,
    registryVerified: true,
    registryTrustEligible: true,
    reviewedBy: representative.ownerId,
    reviewedAt: new Date(),
    adoptedAt: new Date(),
  },
  update: {
    instructions: spreadsheetSkillInstructions,
    instructionsSha256: spreadsheetSkillInstructionsSha256,
    resources: ["skill://builtin/spreadsheet-analysis/1.0.0"],
  },
});
await prisma.representativeSkillPack.upsert({
  where: { representativeId_skillPackId: { representativeId: representative.id, skillPackId: skill.id } },
  create: {
    id: "agent_test_rep_skill_spreadsheet",
    representativeId: representative.id,
    skillPackId: skill.id,
    workspaceInstallId: install.id,
    enabled: true,
    installStatus: "installed",
    installedVersion: "1.0.0",
    installedAt: new Date(),
  },
  update: { enabled: true, workspaceInstallId: install.id, installedVersion: "1.0.0" },
});

const binding = await prisma.representativeMcpBinding.upsert({
  where: { representativeId_slug: { representativeId: representative.id, slug: "orders-test" } },
  create: {
    id: "agent_test_mcp_orders",
    representativeId: representative.id,
    slug: "orders-test",
    displayName: "Agent Regression Orders",
    description: "Isolated ORDERS_A read/write test service.",
    serverUrl: "http://agent-test-mcp:4050/mcp",
    transportKind: "STREAMABLE_HTTP",
    allowedToolNames: ["list_orders", "get_order", "create_ticket"],
    defaultToolName: "get_order",
    enabled: true,
    approvalRequired: false,
    estimatedTokensPerCall: 1_000,
    maxRetries: 1,
    retryBackoffMs: 50,
  },
  update: { enabled: true, approvalRequired: false, serverUrl: "http://agent-test-mcp:4050/mcp" },
});

await prisma.$transaction([
  prisma.knowledgePack.update({
    where: { representativeId: representative.id },
    data: { revision: { increment: 1 }, policies: kbPolicies },
  }),
  prisma.representative.update({
    where: { id: representative.id },
    data: {
      accessMode: "FREE",
      freeReplyLimit: 1000,
      computeEnabled: true,
      computeDefaultPolicyMode: PolicyDecision.ALLOW,
      computeBaseImage: "python:3.12-slim",
      computeAutoApproveTokenLimit: 100_000,
      computeNetworkMode: "ALLOWLIST",
      computeNetworkAllowlist: ["agent-test-mcp"],
      computeFilesystemMode: "EPHEMERAL_FULL",
      sandboxTestEligible: true,
      delegationEnabled: true,
      delegationNaturalLanguageEnabled: true,
      delegationMaxSteps: 16,
      delegationKnowledgeScope: "PUBLIC_KNOWLEDGE",
    },
  }),
  prisma.capabilityPolicyProfile.updateMany({
    where: { representativeId: representative.id },
    data: {
      defaultDecision: PolicyDecision.ALLOW,
      networkMode: "ALLOWLIST",
      networkAllowlist: ["agent-test-mcp"],
      filesystemMode: "EPHEMERAL_FULL",
      maxCommandSeconds: 120,
    },
  }),
  prisma.capabilityPolicyProfile.updateMany({
    where: {
      representativeId: representative.id,
      isManaged: true,
    },
    data: { enabled: false },
  }),
  prisma.capabilityPolicyRule.updateMany({
    where: { profile: { representativeId: representative.id } },
    data: {
      decision: PolicyDecision.ALLOW,
      requiresHumanApproval: false,
      requiresPaidPlan: false,
      maxEstimatedTokens: null,
    },
  }),
]);

const ownerProfile = await prisma.capabilityPolicyProfile.findFirst({
  where: { representativeId: representative.id, isManaged: false },
  orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
});
if (!ownerProfile) throw new Error("Isolated representative owner capability profile is missing.");
for (const [name, capability] of [
  ["exec", CapabilityKind.EXEC],
  ["read", CapabilityKind.READ],
  ["write", CapabilityKind.WRITE],
  ["process", CapabilityKind.PROCESS],
  ["browser", CapabilityKind.BROWSER],
  ["mcp", CapabilityKind.MCP],
] as const) {
  await prisma.capabilityPolicyRule.upsert({
    where: { id: `${ownerProfile.id}_${name}_owner_mode` },
    create: {
      id: `${ownerProfile.id}_${name}_owner_mode`,
      profileId: ownerProfile.id,
      capability,
      decision: PolicyDecision.ALLOW,
      requiresHumanApproval: false,
      requiresPaidPlan: false,
      priority: 1_000,
    },
    update: {
      decision: PolicyDecision.ALLOW,
      requiresHumanApproval: false,
      requiresPaidPlan: false,
    },
  });
}

const snapshot = representative.activeVersion.snapshot as Prisma.JsonObject;
const knowledge = (snapshot.knowledge ?? {}) as Prisma.JsonObject;
const skills = Array.isArray(snapshot.skills) ? snapshot.skills : [];
const mcpBindings = Array.isArray(snapshot.mcpBindings) ? snapshot.mcpBindings : [];
const agentTestVersionId = "agent_test_representative_version_pi_6";
const existingAgentTestVersion = await prisma.representativeVersion.findUnique({
  where: { id: agentTestVersionId },
});
if (!existingAgentTestVersion) {
  const latestVersion = await prisma.representativeVersion.aggregate({
    where: { representativeId: representative.id },
    _max: { versionNumber: true },
  });
  await prisma.representativeVersion.create({
    data: {
      id: agentTestVersionId,
      representativeId: representative.id,
      versionNumber: (latestVersion._max.versionNumber ?? 0) + 1,
      status: "PUBLISHED",
      changeSummary: "Isolated Pi Agent regression fixtures",
      publishedBy: representative.ownerId,
      snapshot: {
      ...snapshot,
      conversation: {
        ...((snapshot.conversation ?? {}) as Prisma.JsonObject),
        freeReplyLimit: 1000,
      },
      knowledge: { ...knowledge, policies: kbPolicies },
      compute: {
        enabled: true,
        defaultPolicyMode: "allow",
        baseImage: "python:3.12-slim",
        maxSessionMinutes: 15,
        autoApproveTokenLimit: 100_000,
        artifactRetentionDays: 14,
        networkMode: "allowlist",
        networkAllowlist: ["agent-test-mcp"],
        filesystemMode: "ephemeral_full",
        capabilityModes: {
          exec: "allow",
          read: "allow",
          write: "allow",
          process: "allow",
          browser: "allow",
          mcp: "allow",
        },
      },
      delegation: {
        enabled: true,
        naturalLanguageEnabled: true,
        explicitComputeEnabled: true,
        maxSteps: 16,
        maxEstimatedTokens: 0,
        knowledgeScope: "public_knowledge",
      },
      skills: [
        ...skills.filter((entry) => (entry as Prisma.JsonObject).slug !== "spreadsheet-analysis"),
        {
          id: skill.id,
          slug: "spreadsheet-analysis",
          displayName: "表格分析",
          source: "builtin",
          summary: "先读取授权口径，再在隔离沙盒中分析 CSV 并生成结果文件。",
          version: "1.0.0",
          capabilityTags: ["csv", "spreadsheet", "analysis", "report"],
          executesCode: true,
          instructions: spreadsheetSkillInstructions,
          instructionsSha256: spreadsheetSkillInstructionsSha256,
          resources: ["skill://builtin/spreadsheet-analysis/1.0.0"],
          enabled: true,
          installStatus: "installed",
        },
      ],
      mcpBindings: [
        ...mcpBindings.filter((entry) => (entry as Prisma.JsonObject).slug !== "orders-test"),
        {
          id: binding.id,
          slug: binding.slug,
          serverUrl: binding.serverUrl,
          transportKind: "streamable_http",
          allowedToolNames: ["list_orders", "get_order", "create_ticket"],
          defaultToolName: "get_order",
          enabled: true,
          approvalRequired: false,
          estimatedTokensPerCall: 1000,
          maxRetries: 1,
          retryBackoffMs: 50,
          skillReleasePin: null,
        },
      ],
      } as Prisma.InputJsonObject,
    },
  });
}
await prisma.representative.update({
  where: { id: representative.id },
  data: { activeVersionId: agentTestVersionId },
});

await prisma.$disconnect();
process.stdout.write("Isolated Agent product fixtures seeded.\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

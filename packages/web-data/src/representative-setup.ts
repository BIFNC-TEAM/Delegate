import { createHash } from "node:crypto";

import {
  conversationContractSchema,
  demoRepresentative,
  groupActivationSchema,
  knowledgeDocumentKindSchema,
  knowledgeDocumentSchema,
  representativeSkillSchema,
  skillPackSchema,
  normalizeRepresentativeHandoffPrompt,
  type GroupActivation as DomainGroupActivation,
  type KnowledgeDocument,
  type Representative,
} from "@delegate/domain";
import {
  buildOpenVikingAgentId,
  buildRepresentativeResourceRootUri,
  resolveOpenVikingEnv,
} from "@delegate/openviking";
import {
  computeFilesystemModeSchema,
  computeNetworkModeSchema,
  policyDecisionSchema,
} from "@delegate/compute-protocol";
import {
  BillingEntitlementExpiryPolicy,
  BillingPriceVersionStatus,
  BillingProductStatus,
  BillingRefundPolicy,
  CapabilityPlanTier,
  Channel,
  ComputeFilesystemMode,
  ComputeNetworkMode,
  DelegationKnowledgeScope,
  EventType,
  GroupActivation,
  PolicyDecision,
  RepresentativeAccessMode,
  RepresentativeLifecycleState,
  RepresentativeChannelKind,
  SkillPackSource,
  WorkspaceSkillInstallStatus,
  WorkspaceSkillReleaseStatus,
  WorkspaceSkillReviewStatus,
  type Prisma,
} from "@prisma/client";
import { z } from "zod";

import { prisma } from "./prisma";
import { resolveChannelAvailability } from "./channel-availability";
import { acquireRepresentativeKnowledgePackLock } from "./knowledge-pack-lock";
import { isWorkspaceSkillReleaseRuntimeTrusted } from "./workspace-skills";

const defaultCnyServicePackages = [
  {
    code: "service-pack-cny-500",
    name: "¥5 服务包",
    amountMinor: 500,
    entitlementUnits: 500,
  },
  {
    code: "service-pack-cny-2000",
    name: "¥20 服务包",
    amountMinor: 2_000,
    entitlementUnits: 2_000,
  },
  {
    code: "service-pack-cny-10000",
    name: "¥100 服务包",
    amountMinor: 10_000,
    entitlementUnits: 10_000,
  },
] as const;

const defaultCnyServicePackageDescription =
  "一次性购买，当前数字代表专属；永久有效；仅在完全未使用时支持全额退款。";

const representativeSetupInclude = {
  owner: {
    select: {
      displayName: true,
    },
  },
  knowledgePack: true,
  capabilityProfiles: {
    where: { isDefault: true, isManaged: false },
    orderBy: { createdAt: "asc" },
    take: 1,
    include: { rules: true },
  },
  skillPackLinks: {
    where: { enabled: true },
    orderBy: { createdAt: "asc" },
    include: {
      skillPack: true,
      workspaceInstall: {
        include: {
          releases: {
            where: { status: WorkspaceSkillReleaseStatus.INSTALLED },
            orderBy: { adoptedAt: "desc" },
            take: 1,
          },
        },
      },
    },
  },
} as const;

const capabilityPolicyModeSchema = z.enum(["allow", "ask", "deny"]);
const capabilityModesSchema = z.object({
  exec: capabilityPolicyModeSchema,
  read: capabilityPolicyModeSchema,
  write: capabilityPolicyModeSchema,
  process: capabilityPolicyModeSchema,
  browser: capabilityPolicyModeSchema,
  mcp: capabilityPolicyModeSchema,
});

const computeSetupSchema = z.object({
  enabled: z.boolean(),
  defaultPolicyMode: policyDecisionSchema,
  baseImage: z.string().trim().min(1),
  maxSessionMinutes: z.number().int().min(5).max(240),
  autoApproveTokenLimit: z.number().int().min(0).max(10_000_000),
  artifactRetentionDays: z.number().int().min(1).max(365),
  networkMode: computeNetworkModeSchema,
  networkAllowlist: z.array(z.string().trim().min(1)).max(50),
  filesystemMode: computeFilesystemModeSchema,
  capabilityModes: capabilityModesSchema,
});

const delegationSetupSchema = z.object({
  enabled: z.boolean(),
  naturalLanguageEnabled: z.boolean(),
  explicitComputeEnabled: z.boolean(),
  maxSteps: z.number().int().min(1).max(5),
  maxEstimatedTokens: z.number().int().min(0).max(100_000_000),
  knowledgeScope: z.enum(["user_input_only", "public_knowledge"]),
});

const editableKnowledgeDocumentSchema = z.object({
  id: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  kind: knowledgeDocumentKindSchema,
  summary: z.string().trim().min(1),
  url: z.string().url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Public knowledge URLs must use HTTP or HTTPS.").optional(),
});

const representativeSetupUpdateSchema = z.object({
  knowledgePackRevision: z.number().int().min(0),
  ownerName: z.string().trim().min(1),
  name: z.string().trim().min(1),
  tagline: z.string().trim().min(1),
  tone: z.string().trim().min(1),
  languages: z.array(z.string().trim().min(1)).min(1),
  groupActivation: groupActivationSchema,
  publicMode: z.boolean(),
  humanInLoop: z.boolean(),
  contract: conversationContractSchema,
  handoffPrompt: z.string().trim().min(1),
  knowledgePack: z.object({
    identitySummary: z.string().trim().min(1),
    faq: z.array(editableKnowledgeDocumentSchema),
    materials: z.array(editableKnowledgeDocumentSchema),
    policies: z.array(editableKnowledgeDocumentSchema),
  }),
  compute: computeSetupSchema.extend({
    capabilityModes: capabilityModesSchema.default({
      exec: "ask",
      read: "allow",
      write: "ask",
      process: "ask",
      browser: "ask",
      mcp: "ask",
    }),
  }),
  delegation: delegationSetupSchema.default({
    enabled: true,
    naturalLanguageEnabled: true,
    explicitComputeEnabled: true,
    maxSteps: 5,
    maxEstimatedTokens: 0,
    knowledgeScope: "user_input_only",
  }),
});

const representativeCreateSchema = z.object({
  ownerName: z.string().trim().min(1),
  representativeName: z.string().trim().min(1),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  tagline: z.string().trim().min(1).optional(),
});

type RepresentativeSetupRecord = Prisma.RepresentativeGetPayload<{
  include: typeof representativeSetupInclude;
}>;

export type RepresentativeSetupSnapshot = Pick<
  Representative,
  | "id"
  | "slug"
  | "ownerName"
  | "name"
  | "tagline"
  | "tone"
  | "languages"
  | "groupActivation"
  | "skills"
  | "skillPacks"
  | "knowledgePack"
  | "contract"
  | "handoffPrompt"
> & {
  knowledgePackRevision: number;
  publicMode: boolean;
  humanInLoop: boolean;
  handoffAccessMode: "FREE" | "PACKAGE_REQUIRED";
  compute: {
    enabled: boolean;
    defaultPolicyMode: "allow" | "ask" | "deny";
    baseImage: string;
    maxSessionMinutes: number;
    autoApproveTokenLimit: number;
    artifactRetentionDays: number;
    networkMode: "no_network" | "allowlist" | "full";
    networkAllowlist: string[];
    filesystemMode: "workspace_only" | "read_only_workspace" | "ephemeral_full";
    capabilityModes: Record<"exec" | "read" | "write" | "process" | "browser" | "mcp", "allow" | "ask" | "deny">;
  };
  delegation: {
    enabled: boolean;
    naturalLanguageEnabled: boolean;
    explicitComputeEnabled: boolean;
    maxSteps: number;
    maxEstimatedTokens: number;
    knowledgeScope: "user_input_only" | "public_knowledge";
  };
};

export type RepresentativeSetupUpdateInput = z.infer<typeof representativeSetupUpdateSchema>;
export type RepresentativeCreateInput = z.infer<typeof representativeCreateSchema>;

export class RepresentativeSetupConflictError extends Error {
  readonly code = "KNOWLEDGE_PACK_CONFLICT";
  readonly statusCode = 409;

  constructor() {
    super(
      "This representative knowledge draft changed after you opened it. The latest draft must be reloaded before saving.",
    );
    this.name = "RepresentativeSetupConflictError";
  }
}
export type RepresentativeRuntimeMcpBindingGrant = {
  id: string;
  slug: string;
  displayName?: string;
  description?: string | null;
  serverUrl: string;
  transportKind: "streamable_http" | "sse";
  allowedToolNames: string[];
  defaultToolName: string | null;
  enabled: true;
  approvalRequired: boolean;
  estimatedTokensPerCall: number;
  maxRetries: number;
  retryBackoffMs: number;
  configRevision?: number;
  availability?: {
    healthState: "ready" | "degraded" | "unavailable";
    checkedAt: string;
    failureCode?: string;
  };
  toolDefinitions?: Array<{
    exactToolName: string;
    description?: string | null;
    semanticMetadata?: Record<string, unknown> | null;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown> | null;
    toolSchemaHash: string;
    bindingDefinitionHash: string;
    bindingRevision: number;
    canonicalizationVersion: string;
    observedAt?: string;
  }>;
};
export type RepresentativeRuntimeAuthoritySnapshot = {
  representativeVersionId: string;
  compute: RepresentativeSetupSnapshot["compute"];
  delegation: RepresentativeSetupSnapshot["delegation"];
  mcpBindings: RepresentativeRuntimeMcpBindingGrant[];
};
export type ComputePolicyAuditPayload = {
  changedBy: string;
  changedFields: string[];
  modes: {
    computeEnabled: boolean;
    defaultPolicyMode: RepresentativeSetupSnapshot["compute"]["defaultPolicyMode"];
    networkMode: RepresentativeSetupSnapshot["compute"]["networkMode"];
    filesystemMode: RepresentativeSetupSnapshot["compute"]["filesystemMode"];
    capabilityModes: RepresentativeSetupSnapshot["compute"]["capabilityModes"];
    delegationEnabled: boolean;
    naturalLanguageEnabled: boolean;
    explicitComputeEnabled: boolean;
    knowledgeScope: RepresentativeSetupSnapshot["delegation"]["knowledgeScope"];
  };
  values: {
    maxSessionMinutes: number;
    autoApproveTokenLimit: number;
    artifactRetentionDays: number;
    networkAllowlistCount: number;
    maxSteps: number;
    maxEstimatedTokens: number;
  };
};
export type RepresentativeDirectoryItem = {
  id: string;
  slug: string;
  ownerName: string;
  name: string;
  tagline: string;
  updatedAt: string;
  lifecycleState: string;
  activeVersion: number | null;
};

export type PublicRepresentativeRuntimeResult =
  | {
      status: "available";
      setup: RepresentativeSetupSnapshot;
      accessMode: RepresentativeAccessMode;
      governedContextEnabled: boolean;
      governedMemoryDisclosure: PublicGovernedMemoryDisclosure;
    }
  | { status: "not_found" | "unpublished" | "paused" | "private" | "web_disabled" };

export type PublicGovernedMemoryDisclosure = {
  enabled: boolean;
  shortTermMemoryEnabled: boolean;
  contactMemoryEnabled: boolean;
  contactMemoryCrossChannelEnabled: boolean;
  representativeExperienceEnabled: boolean;
  automaticExtractionEnabled: boolean;
  retentionDays: number | null;
  expiryAction: "ARCHIVE" | "DELETE" | null;
  policyRevision: number | null;
  fingerprint: string;
};

type PublicGovernedMemoryPolicy = {
  longTermMemoryEnabled: boolean;
  shortTermMemoryEnabled?: boolean;
  contactMemoryEnabled: boolean;
  contactMemoryCrossChannelEnabled?: boolean;
  representativeExperienceEnabled: boolean;
  autoExtract: boolean;
  webRecallEnabled: boolean;
  webExtractEnabled: boolean;
  retentionDays: number;
  expiryAction: "ARCHIVE" | "DELETE";
  provider: string;
  revision: number;
};

const PUBLIC_MEMORY_DISCLOSURE_FINGERPRINT_VERSION = 4;

export function resolvePublicGovernedMemoryDisclosure(input: {
  policy: PublicGovernedMemoryPolicy | null;
  environmentEnabled: boolean;
  modelCredentialsAvailable: boolean;
}): PublicGovernedMemoryDisclosure {
  const hasEnabledMemoryKind = Boolean(
    input.policy?.longTermMemoryEnabled
    && (
      input.policy.contactMemoryEnabled
      || input.policy.representativeExperienceEnabled
    ),
  );
  const shortTermMemoryEnabled = input.policy?.shortTermMemoryEnabled ?? true;
  const enabled = Boolean(
    hasEnabledMemoryKind
    && input.policy?.webRecallEnabled
    && input.policy.provider === "openviking"
    && input.environmentEnabled
    && input.modelCredentialsAvailable
  );
  const automaticExtractionEnabled = Boolean(
    hasEnabledMemoryKind
    && input.policy?.autoExtract
    && input.policy.webExtractEnabled,
  );
  const policyAppliesToWeb = enabled || automaticExtractionEnabled;
  const policyRevision = Number.isInteger(input.policy?.revision)
    && (input.policy?.revision ?? -1) >= 0
    ? input.policy!.revision
    : null;

  if (!policyAppliesToWeb || !input.policy) {
    return buildPublicGovernedMemoryDisclosure({
      enabled: false,
      shortTermMemoryEnabled,
      contactMemoryEnabled: false,
      contactMemoryCrossChannelEnabled: false,
      representativeExperienceEnabled: false,
      automaticExtractionEnabled: false,
      retentionDays: null,
      expiryAction: null,
      policyRevision,
    });
  }

  return buildPublicGovernedMemoryDisclosure({
    enabled,
    shortTermMemoryEnabled,
    contactMemoryEnabled: input.policy.contactMemoryEnabled,
    // Public runtime remains channel-local even if a legacy row contains true.
    contactMemoryCrossChannelEnabled: false,
    representativeExperienceEnabled: input.policy.representativeExperienceEnabled,
    automaticExtractionEnabled,
    retentionDays: input.policy.retentionDays,
    expiryAction: input.policy.expiryAction,
    policyRevision,
  });
}

function buildPublicGovernedMemoryDisclosure(input: Omit<
  PublicGovernedMemoryDisclosure,
  "fingerprint"
>): PublicGovernedMemoryDisclosure {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([
      PUBLIC_MEMORY_DISCLOSURE_FINGERPRINT_VERSION,
      input.policyRevision,
      input.enabled,
      input.shortTermMemoryEnabled,
      input.contactMemoryEnabled,
      input.contactMemoryCrossChannelEnabled,
      input.representativeExperienceEnabled,
      input.automaticExtractionEnabled,
      input.retentionDays,
      input.expiryAction,
    ]))
    .digest("base64url");
  return { ...input, fingerprint };
}

export function resolveGovernedContextEnabled(input: {
  policy: PublicGovernedMemoryPolicy | null;
  environmentEnabled: boolean;
  modelCredentialsAvailable: boolean;
}): boolean {
  return resolvePublicGovernedMemoryDisclosure(input).enabled;
}

export function resolvePublicRepresentativeAvailability(input: {
  lifecycleState: string;
  publicMode: boolean;
  activeVersionId?: string | null;
  webChannelStatuses: string[];
  webChannelBindings?: Array<{
    status: string;
    desiredState?: string | null;
    healthStatus?: string | null;
  }>;
  overlays?: Array<{
    enabled: boolean;
    priority: number;
    startsAt: Date;
    expiresAt?: Date | null;
    payload: Record<string, unknown>;
  }>;
}): PublicRepresentativeRuntimeResult["status"] {
  const binding = input.webChannelBindings?.[0];
  const legacyStatus = binding?.status ?? input.webChannelStatuses[0];
  const availability = resolveChannelAvailability({
    channel: "web",
    lifecycleState: input.lifecycleState,
    publicMode: input.publicMode,
    activeVersionId: input.activeVersionId ?? null,
    binding: legacyStatus
      ? {
          legacyStatus,
          desiredState: binding?.desiredState ?? null,
          healthStatus: binding?.healthStatus ?? null,
        }
      : null,
    ...(input.overlays ? { overlays: input.overlays } : {}),
  });
  if (availability.available) return "available";
  if (
    availability.code === "representative_paused"
    || availability.code === "channel_paused"
    || availability.code === "policy_disabled"
  ) {
    return "paused";
  }
  if (availability.code === "public_web_disabled") return "private";
  if (
    availability.code === "representative_unpublished"
    || availability.code === "representative_archived"
  ) {
    return "unpublished";
  }
  return "web_disabled";
}

/** Build the canonical domain profile used by every conversation channel. */
export function buildRepresentativeRuntimeProfile(
  setup: RepresentativeSetupSnapshot,
): Representative {
  return {
    id: setup.id,
    slug: setup.slug,
    ownerName: setup.ownerName,
    name: setup.name,
    tagline: setup.tagline,
    tone: setup.tone,
    languages: [...setup.languages],
    groupActivation: setup.groupActivation,
    skills: [...setup.skills],
    skillPacks: setup.skillPacks.map((pack) => ({
      ...pack,
      capabilityTags: [...pack.capabilityTags],
    })),
    knowledgePack: {
      identitySummary: setup.knowledgePack.identitySummary,
      faq: setup.knowledgePack.faq.map((item) => ({ ...item })),
      materials: setup.knowledgePack.materials.map((item) => ({ ...item })),
      policies: setup.knowledgePack.policies.map((item) => ({ ...item })),
    },
    contract: {
      freeReplyLimit: setup.contract.freeReplyLimit,
      handoffWindowHours: setup.contract.handoffWindowHours,
    },
    handoffPrompt: setup.handoffPrompt,
  };
}

let demoFallbackSetupSnapshot: RepresentativeSetupSnapshot | null = null;

const defaultComputeSetup: RepresentativeSetupSnapshot["compute"] = {
  enabled: false,
  defaultPolicyMode: "ask",
  baseImage: "debian:bookworm-slim",
  maxSessionMinutes: 15,
  autoApproveTokenLimit: 0,
  artifactRetentionDays: 14,
  networkMode: "no_network",
  networkAllowlist: [],
  filesystemMode: "workspace_only",
  capabilityModes: {
    exec: "ask",
    read: "allow",
    write: "ask",
    process: "ask",
    browser: "ask",
    mcp: "ask",
  },
};

const defaultDelegationSetup: RepresentativeSetupSnapshot["delegation"] = {
  enabled: true,
  naturalLanguageEnabled: true,
  explicitComputeEnabled: true,
  maxSteps: 5,
  maxEstimatedTokens: 0,
  knowledgeScope: "user_input_only",
};

export async function listRepresentativeDirectoryItems(ownerId?: string | null): Promise<RepresentativeDirectoryItem[]> {
  const scopedOwnerId = ownerId?.trim();
  if (!process.env.DATABASE_URL?.trim()) {
    if (scopedOwnerId) {
      throw new Error("Representative directory is temporarily unavailable.");
    }
    return [buildDemoDirectoryItem()];
  }

  try {
    const effectiveOwnerId = scopedOwnerId || (await findLocalDashboardOwnerId());
    const representatives = await prisma.representative.findMany({
      ...(effectiveOwnerId ? { where: { ownerId: effectiveOwnerId } } : {}),
      include: {
        owner: {
          select: {
            displayName: true,
          },
        },
        activeVersion: true,
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });

    return representatives.map((representative) => ({
      id: representative.id,
      slug: representative.slug,
      ownerName: representative.owner.displayName,
      name: representative.displayName,
      tagline: representative.roleSummary,
      updatedAt: representative.updatedAt.toISOString(),
      lifecycleState: representative.lifecycleState.toLowerCase(),
      activeVersion: representative.activeVersion?.versionNumber ?? null,
    }));
  } catch (error) {
    if (isPrismaUnavailableError(error)) {
      if (scopedOwnerId) {
        throw new Error("Representative directory is temporarily unavailable.");
      }
      return [buildDemoDirectoryItem()];
    }

    throw error;
  }
}

export async function createRepresentative(
  input: RepresentativeCreateInput,
  options: { ownerId?: string | null } = {},
): Promise<RepresentativeSetupSnapshot> {
  const parsed = representativeCreateSchema.parse(input);

  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("Creating representatives requires Postgres. Run pnpm docker:up first.");
  }

  try {
    const openVikingEnv = resolveOpenVikingEnv();
    const created = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const requestedOwnerId = options.ownerId?.trim();
      const owner = requestedOwnerId
        ? await tx.owner.findUnique({ where: { id: requestedOwnerId } })
        : (await tx.owner.findFirst({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] })) ??
          (await tx.owner.create({ data: { displayName: parsed.ownerName } }));
      if (!owner) {
        throw new Error("The authenticated owner no longer exists.");
      }

      const slug = await reserveRepresentativeSlug(
        tx,
        parsed.slug?.trim() || slugify(parsed.representativeName),
      );
      const template = buildRepresentativeTemplate({
        ownerName: parsed.ownerName,
        representativeName: parsed.representativeName,
        ...(parsed.tagline ? { tagline: parsed.tagline } : {}),
      });

      const representative = await tx.representative.create({
        data: {
          ownerId: owner.id,
          slug,
          displayName: template.name,
          roleSummary: template.tagline,
          tone: template.tone,
          publicMode: template.publicMode,
          groupModeEnabled: true,
          groupActivation: mapGroupActivationToDb(template.groupActivation),
          humanInLoop: true,
          languages: template.languages,
          // Legacy columns remain populated until the non-destructive data
          // migration has been deployed everywhere. They are no longer read
          // by setup, publication, or conversation runtime code.
          freeScope: [],
          paywalledIntents: [],
          freeReplyLimit: template.contract.freeReplyLimit,
          handoffWindowHours: template.contract.handoffWindowHours,
          freeMonthlyCredit: 100,
          handoffPrompt: template.handoffPrompt,
          allowedSkills: template.skills,
          actionGate: {},
          openvikingEnabled: false,
          openvikingAgentId: buildOpenVikingAgentId(slug, openVikingEnv),
          openvikingAutoRecall: openVikingEnv.autoRecallDefault,
          openvikingAutoCapture: false,
          openvikingCaptureMode: openVikingEnv.captureModeDefault,
          openvikingRecallLimit: 6,
          openvikingRecallScoreThreshold: 0.01,
          openvikingTargetUri: buildRepresentativeResourceRootUri(slug),
          computeEnabled: template.compute.enabled,
          computeDefaultPolicyMode: mapPolicyDecisionToDb(template.compute.defaultPolicyMode),
          computeBaseImage: template.compute.baseImage,
          computeMaxSessionMinutes: template.compute.maxSessionMinutes,
          computeAutoApproveTokenLimit: template.compute.autoApproveTokenLimit,
          computeArtifactRetentionDays: template.compute.artifactRetentionDays,
          computeNetworkMode: mapComputeNetworkModeToDb(template.compute.networkMode),
          computeNetworkAllowlist: sanitizeNetworkAllowlist(template.compute.networkAllowlist),
          computeFilesystemMode: mapComputeFilesystemModeToDb(template.compute.filesystemMode),
          delegationEnabled: template.delegation.enabled,
          delegationNaturalLanguageEnabled: template.delegation.naturalLanguageEnabled,
          delegationExplicitComputeEnabled: template.delegation.explicitComputeEnabled,
          delegationMaxSteps: template.delegation.maxSteps,
          delegationMaxEstimatedTokens: template.delegation.maxEstimatedTokens,
          delegationKnowledgeScope: mapDelegationKnowledgeScopeToDb(template.delegation.knowledgeScope),
          agentWallet: {
            create: {
              currency: "CNY",
              tokenUnitPriceCents: 1,
              creatorRevenueShareBps: 2000,
            },
          },
          billingProducts: {
            create: defaultCnyServicePackages.map((servicePackage) => ({
              code: servicePackage.code,
              name: servicePackage.name,
              description: defaultCnyServicePackageDescription,
              status: BillingProductStatus.ACTIVE,
              priceVersions: {
                create: {
                  version: 1,
                  status: BillingPriceVersionStatus.ACTIVE,
                  currency: "CNY",
                  amountMinor: servicePackage.amountMinor,
                  unitName: "credit",
                  entitlementUnits: servicePackage.entitlementUnits,
                  creatorRevenueShareBps: 2_000,
                  platformRevenueShareBps: 8_000,
                  refundPolicy: BillingRefundPolicy.FULL_WHEN_UNUSED,
                  expiryPolicy:
                    BillingEntitlementExpiryPolicy.NEVER_EXPIRES,
                  entitlementValidityDays: null,
                  publishedAt: now,
                },
              },
            })),
          },
        },
      });

      await acquireRepresentativeKnowledgePackLock(tx, representative.id, {
        required: true,
      });
      await upsertDefaultCapabilityPolicyProfile(tx, representative.id, template.compute);
      await upsertManagedCapabilityPolicyProfile(tx, representative.id);
      await upsertOwnerManagedCapabilityProfiles(tx, owner.id);

      await tx.wallet.upsert({
        where: {
          ownerId: owner.id,
        },
        create: {
          ownerId: owner.id,
        },
        update: {},
      });

      await tx.knowledgePack.create({
        data: {
          representativeId: representative.id,
          identitySummary: template.knowledgePack.identitySummary,
          faq: template.knowledgePack.faq,
          materials: template.knowledgePack.materials,
          policies: template.knowledgePack.policies,
        },
      });

      for (const pack of demoRepresentative.skillPacks) {
        const skillPack = await tx.skillPack.upsert({
          where: {
            source_slug: {
              source: mapSkillPackSourceToDb(pack.source),
              slug: pack.slug,
            },
          },
          create: {
            id: pack.id,
            source: mapSkillPackSourceToDb(pack.source),
            slug: pack.slug,
            displayName: pack.displayName,
            summary: pack.summary,
            version: pack.version ?? null,
            sourceUrl: pack.sourceUrl ?? null,
            ownerHandle: pack.ownerHandle ?? null,
            verificationTier: pack.verificationTier ?? null,
            capabilityTags: pack.capabilityTags,
            executesCode: pack.executesCode,
          },
          update: {
            displayName: pack.displayName,
            summary: pack.summary,
            version: pack.version ?? null,
            sourceUrl: pack.sourceUrl ?? null,
            ownerHandle: pack.ownerHandle ?? null,
            verificationTier: pack.verificationTier ?? null,
            capabilityTags: pack.capabilityTags,
            executesCode: pack.executesCode,
          },
        });

        const workspaceInstall = pack.installStatus === "available"
          ? null
          : await tx.workspaceSkillInstall.upsert({
              where: {
                ownerId_skillPackId: {
                  ownerId: owner.id,
                  skillPackId: skillPack.id,
                },
              },
              create: {
                ownerId: owner.id,
                skillPackId: skillPack.id,
                status: pack.installStatus === "update_available" ? "UPDATE_AVAILABLE" : "INSTALLED",
                reviewStatus: "APPROVED",
                installedVersion: pack.version ?? null,
                installedBy: owner.id,
                installedAt: now,
              },
              update: {},
            });

        if (workspaceInstall) {
          const installedWorkspaceRelease = await tx.workspaceSkillRelease.findFirst({
            where: {
              installId: workspaceInstall.id,
              status: WorkspaceSkillReleaseStatus.INSTALLED,
            },
            select: { id: true },
          });
          if (!installedWorkspaceRelease) {
            await tx.workspaceSkillRelease.upsert({
              where: {
                installId_version: {
                  installId: workspaceInstall.id,
                  version: pack.version ?? "unversioned",
                },
              },
              create: {
                installId: workspaceInstall.id,
                version: pack.version ?? "unversioned",
                status: WorkspaceSkillReleaseStatus.INSTALLED,
                displayName: pack.displayName,
                summary: pack.summary,
                sourceUrl: pack.sourceUrl ?? null,
                ownerHandle: pack.ownerHandle ?? null,
                verificationTier: pack.verificationTier ?? null,
                capabilityTags: pack.capabilityTags,
                executesCode: pack.executesCode,
                reviewedBy: owner.id,
                reviewedAt: now,
                adoptedAt: now,
              },
              update: {},
            });
          }
        }

        await tx.representativeSkillPack.create({
          data: {
            representativeId: representative.id,
            skillPackId: skillPack.id,
            workspaceInstallId: workspaceInstall?.id ?? null,
            enabled: pack.enabled,
            installStatus: pack.installStatus,
            installedVersion: workspaceInstall?.installedVersion ?? pack.version ?? null,
            installedAt: workspaceInstall?.installedAt ?? null,
          },
        });
      }

      const createdRepresentative = await tx.representative.findUnique({
        where: { id: representative.id },
        include: representativeSetupInclude,
      });

      if (!createdRepresentative) {
        throw new Error("Representative creation completed without a readable record.");
      }

      return createdRepresentative;
    });

    return serializeRepresentativeSetup(created);
  } catch (error) {
    if (isPrismaUnavailableError(error)) {
      throw new Error("Creating representatives requires a reachable Postgres instance.");
    }

    throw error;
  }
}

export async function getRepresentativeSetupSnapshot(
  representativeSlug: string,
): Promise<RepresentativeSetupSnapshot | null> {
  if (shouldUseStaticFallbackMode(representativeSlug)) {
    return cloneRepresentativeSetupSnapshot(getOrCreateDemoFallbackSetupSnapshot());
  }

  try {
    const representative = await prisma.representative.findUnique({
      where: { slug: representativeSlug },
      include: representativeSetupInclude,
    });

    if (!representative) {
      return null;
    }

    return serializeRepresentativeSetup(representative);
  } catch (error) {
    if (shouldUseDemoFallback(error, representativeSlug)) {
      return cloneRepresentativeSetupSnapshot(getOrCreateDemoFallbackSetupSnapshot());
    }

    throw error;
  }
}

/**
 * Resolve the immutable configuration used by a public/runtime conversation.
 * Dashboard editing continues to use getRepresentativeSetupSnapshot(), while
 * public surfaces must use this function so unpublished edits cannot leak live.
 */
export async function getRepresentativeRuntimeSetupSnapshot(
  representativeSlug: string,
  representativeVersionId?: string | null,
): Promise<RepresentativeSetupSnapshot | null> {
  const requestedVersionId = representativeVersionId?.trim() || null;
  if (representativeVersionId !== undefined && !requestedVersionId) {
    return null;
  }

  if (!process.env.DATABASE_URL?.trim()) {
    return cloneRepresentativeSetupSnapshot(getOrCreateDemoFallbackSetupSnapshot());
  }

  const representative = await prisma.representative.findUnique({
    where: { slug: representativeSlug },
    include: {
      ...representativeSetupInclude,
      activeVersion: true,
    },
  });
  if (!representative) return null;

  const version = requestedVersionId
    ? await prisma.representativeVersion.findFirst({
        where: {
          id: requestedVersionId,
          representativeId: representative.id,
        },
      })
    : representative.activeVersion;
  if (!version) return null;

  return applyRepresentativeVersionSnapshot(
    serializeRepresentativeSetup(representative),
    version.snapshot,
  );
}

/**
 * Resolve the effective authority for execution surfaces. The immutable
 * published version is the ceiling; mutable workspace state may only disable
 * or narrow that ceiling.
 */
export async function getRepresentativeRuntimeAuthoritySnapshot(
  representativeSlug: string,
  representativeVersionId?: string | null,
): Promise<RepresentativeRuntimeAuthoritySnapshot | null> {
  const requestedVersionId = representativeVersionId?.trim() || null;
  if (representativeVersionId !== undefined && !requestedVersionId) {
    return null;
  }

  if (!process.env.DATABASE_URL?.trim()) {
    const setup = cloneRepresentativeSetupSnapshot(getOrCreateDemoFallbackSetupSnapshot());
    return {
      representativeVersionId: requestedVersionId || "demo-version",
      compute: cloneComputeSetup(setup.compute),
      delegation: { ...setup.delegation },
      mcpBindings: [],
    };
  }

  const representative = await prisma.representative.findUnique({
    where: { slug: representativeSlug },
    include: {
      activeVersion: true,
      capabilityProfiles: {
        where: { isDefault: true, isManaged: false },
        orderBy: { createdAt: "asc" },
        take: 1,
        include: { rules: true },
      },
      mcpBindings: {
        orderBy: { createdAt: "asc" },
        include: {
          toolDefinitions: {
            where: { availability: "ready", supersededAt: null },
            orderBy: { observedAt: "desc" },
          },
          representativeSkillPackLink: {
            select: {
              id: true,
              enabled: true,
              installedVersion: true,
              skillPack: {
                select: {
                  id: true,
                  source: true,
                  slug: true,
                },
              },
              workspaceInstall: {
                select: {
                  status: true,
                  reviewStatus: true,
                  installedVersion: true,
                  releases: {
                    where: { status: WorkspaceSkillReleaseStatus.INSTALLED },
                    orderBy: { adoptedAt: "desc" },
                    take: 1,
                    select: {
                      version: true,
                      status: true,
                      executesCode: true,
                      registryTrustEligible: true,
                      signatureStatus: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!representative) return null;

  const version = requestedVersionId
    ? await prisma.representativeVersion.findFirst({
        where: {
          id: requestedVersionId,
          representativeId: representative.id,
        },
      })
    : representative.activeVersion;
  if (!version) return null;

  const snapshot = asJsonRecord(version.snapshot);
  const currentCompute: RepresentativeSetupSnapshot["compute"] = {
    enabled: representative.computeEnabled,
    defaultPolicyMode: mapPolicyDecisionFromDb(
      representative.computeDefaultPolicyMode,
    ),
    baseImage: representative.computeBaseImage,
    maxSessionMinutes: representative.computeMaxSessionMinutes,
    autoApproveTokenLimit: representative.computeAutoApproveTokenLimit,
    artifactRetentionDays: representative.computeArtifactRetentionDays,
    networkMode: mapComputeNetworkModeFromDb(representative.computeNetworkMode),
    networkAllowlist: sanitizeNetworkAllowlist(
      representative.computeNetworkAllowlist,
    ),
    filesystemMode: mapComputeFilesystemModeFromDb(
      representative.computeFilesystemMode,
    ),
    capabilityModes: resolveCapabilityModesFromProfile(
      representative.capabilityProfiles[0],
    ),
  };
  const currentDelegation: RepresentativeSetupSnapshot["delegation"] = {
    enabled: representative.delegationEnabled,
    naturalLanguageEnabled: representative.delegationNaturalLanguageEnabled,
    explicitComputeEnabled: representative.delegationExplicitComputeEnabled,
    maxSteps: representative.delegationMaxSteps,
    maxEstimatedTokens: representative.delegationMaxEstimatedTokens,
    knowledgeScope: mapDelegationKnowledgeScopeFromDb(
      representative.delegationKnowledgeScope,
    ),
  };
  return {
    representativeVersionId: version.id,
    compute: resolvePublishedComputeCeiling(currentCompute, snapshot?.compute),
    delegation: resolvePublishedDelegationCeiling(
      currentDelegation,
      asJsonRecord(snapshot?.delegation),
    ),
    mcpBindings: resolveRepresentativeRuntimeMcpBindings(
      representative.mcpBindings,
      version.snapshot,
    ),
  };
}

/**
 * Canonical public boundary for every visitor-facing page and API.
 * It prevents draft data, paused representatives, private profiles, and
 * disconnected Web channels from being served by one route while another
 * route correctly blocks them.
 */
export async function getPublicRepresentativeRuntime(
  representativeSlug: string,
): Promise<PublicRepresentativeRuntimeResult> {
  if (!process.env.DATABASE_URL?.trim()) {
    const setup = await getRepresentativeRuntimeSetupSnapshot(representativeSlug);
    return setup
      ? {
          status: "available",
          setup,
          accessMode: RepresentativeAccessMode.TRIAL_THEN_CREDITS,
          governedContextEnabled: false,
          governedMemoryDisclosure: resolvePublicGovernedMemoryDisclosure({
            policy: null,
            environmentEnabled: false,
            modelCredentialsAvailable: false,
          }),
        }
      : { status: "not_found" };
  }

  const representative = await prisma.representative.findUnique({
    where: { slug: representativeSlug },
    select: {
      accessMode: true,
      lifecycleState: true,
      publicMode: true,
      activeVersionId: true,
      memoryPolicy: {
        select: {
          longTermMemoryEnabled: true,
          shortTermMemoryEnabled: true,
          contactMemoryEnabled: true,
          contactMemoryCrossChannelEnabled: true,
          representativeExperienceEnabled: true,
          autoExtract: true,
          webRecallEnabled: true,
          webExtractEnabled: true,
          retentionDays: true,
          expiryAction: true,
          provider: true,
          revision: true,
        },
      },
      channelBindings: {
        where: { kind: RepresentativeChannelKind.WEB },
        select: { status: true, desiredState: true, healthStatus: true },
      },
      runtimePolicyOverlays: {
        where: { enabled: true },
        select: {
          enabled: true,
          priority: true,
          startsAt: true,
          expiresAt: true,
          payload: true,
        },
      },
    },
  });
  if (!representative) return { status: "not_found" };
  const availability = resolvePublicRepresentativeAvailability({
    lifecycleState: representative.lifecycleState,
    publicMode: representative.publicMode,
    activeVersionId: representative.activeVersionId,
    webChannelStatuses: representative.channelBindings.map((binding) => binding.status),
    webChannelBindings: representative.channelBindings,
    overlays: representative.runtimePolicyOverlays.map((overlay) => ({
      ...overlay,
      payload:
        overlay.payload && typeof overlay.payload === "object" && !Array.isArray(overlay.payload)
          ? overlay.payload as Record<string, unknown>
          : {},
    })),
  });
  if (availability !== "available") return { status: availability };

  const setup = await getRepresentativeRuntimeSetupSnapshot(
    representativeSlug,
    representative.activeVersionId,
  );
  if (!setup) return { status: "unpublished" };

  const governedContextEnvironment = resolveOpenVikingEnv();
  const governedMemoryDisclosure = resolvePublicGovernedMemoryDisclosure({
    policy: representative.memoryPolicy,
    environmentEnabled: governedContextEnvironment.enabled,
    modelCredentialsAvailable: governedContextEnvironment.hasModelCredentials,
  });
  return {
    status: "available",
    setup,
    accessMode: representative.accessMode,
    governedContextEnabled: governedMemoryDisclosure.enabled,
    governedMemoryDisclosure,
  };
}

export async function updateRepresentativeSetup(
  params: {
    representativeSlug: string;
    input: RepresentativeSetupUpdateInput;
    syncOpenViking?: boolean;
    changedBy?: string;
  },
  client: Pick<typeof prisma, "representative" | "$transaction"> = prisma,
): Promise<RepresentativeSetupSnapshot> {
  const input = representativeSetupUpdateSchema.parse(params.input);

  if (shouldUseStaticFallbackMode(params.representativeSlug)) {
    return updateDemoFallbackRepresentativeSetup(input);
  }

  try {
    const representative = await client.representative.findUnique({
      where: { slug: params.representativeSlug },
      include: representativeSetupInclude,
    });

    if (!representative) {
      throw new Error(`Representative "${params.representativeSlug}" not found.`);
    }
    const existingSetup = serializeRepresentativeSetup(representative);
    const computePolicyAuditPayload = buildComputePolicyAuditPayload({
      currentCompute: existingSetup.compute,
      currentDelegation: existingSetup.delegation,
      nextCompute: input.compute,
      nextDelegation: input.delegation,
      changedBy: params.changedBy?.trim() || representative.ownerId,
    });

    const updated = await client.$transaction(async (tx) => {
      await acquireRepresentativeKnowledgePackLock(tx, representative.id, {
        required: true,
      });
      const currentKnowledgePack = await tx.knowledgePack.findUnique({
        where: { representativeId: representative.id },
        select: { revision: true },
      });
      const currentKnowledgePackRevision = currentKnowledgePack?.revision ?? 0;
      if (currentKnowledgePackRevision !== input.knowledgePackRevision) {
        throw new RepresentativeSetupConflictError();
      }
      const liveRepresentative = await tx.representative.update({
        where: { id: representative.id },
        data: {
          displayName: input.name,
          roleSummary: input.tagline,
          tone: input.tone,
          publicMode: input.publicMode,
          groupActivation: mapGroupActivationToDb(input.groupActivation),
          languages: input.languages,
          // humanInLoop and freeReplyLimit are live commerce settings. The
          // legacy setup payload still carries compatibility snapshots, but
          // saving another setup section must never overwrite the dedicated
          // commerce controls.
          handoffWindowHours: input.contract.handoffWindowHours,
          handoffPrompt: input.handoffPrompt,
          computeEnabled: input.compute.enabled,
          computeDefaultPolicyMode: mapPolicyDecisionToDb(input.compute.defaultPolicyMode),
          computeBaseImage: input.compute.baseImage,
          computeMaxSessionMinutes: input.compute.maxSessionMinutes,
          computeAutoApproveTokenLimit: input.compute.autoApproveTokenLimit,
          computeArtifactRetentionDays: input.compute.artifactRetentionDays,
          computeNetworkMode: mapComputeNetworkModeToDb(input.compute.networkMode),
          computeNetworkAllowlist: sanitizeNetworkAllowlist(input.compute.networkAllowlist),
          computeFilesystemMode: mapComputeFilesystemModeToDb(input.compute.filesystemMode),
          delegationEnabled: input.delegation.enabled,
          delegationNaturalLanguageEnabled: input.delegation.naturalLanguageEnabled,
          delegationExplicitComputeEnabled: input.delegation.explicitComputeEnabled,
          delegationMaxSteps: input.delegation.maxSteps,
          delegationMaxEstimatedTokens: input.delegation.maxEstimatedTokens,
          delegationKnowledgeScope: mapDelegationKnowledgeScopeToDb(input.delegation.knowledgeScope),
        },
        select: { humanInLoop: true },
      });

      await upsertDefaultCapabilityPolicyProfile(tx, representative.id, input.compute);
      await upsertManagedCapabilityPolicyProfile(tx, representative.id);
      await upsertOwnerManagedCapabilityProfiles(tx, representative.ownerId);
      if (computePolicyAuditPayload) {
        await tx.eventAudit.create({
          data: {
            representativeId: representative.id,
            type: EventType.COMPUTE_POLICY_CHANGED,
            payload: computePolicyAuditPayload,
          },
        });
      }

      await tx.knowledgePack.upsert({
        where: { representativeId: representative.id },
        create: {
          representativeId: representative.id,
          revision: 1,
          identitySummary: input.knowledgePack.identitySummary,
          faq: normalizeKnowledgeDocuments(input.knowledgePack.faq, "faq"),
          materials: normalizeKnowledgeDocuments(input.knowledgePack.materials, "materials"),
          policies: normalizeKnowledgeDocuments(input.knowledgePack.policies, "policies"),
        },
        update: {
          revision: { increment: 1 },
          identitySummary: input.knowledgePack.identitySummary,
          faq: normalizeKnowledgeDocuments(input.knowledgePack.faq, "faq"),
          materials: normalizeKnowledgeDocuments(input.knowledgePack.materials, "materials"),
          policies: normalizeKnowledgeDocuments(input.knowledgePack.policies, "policies"),
        },
      });

      const [linkedKnowledgeCount, channelCount] = await Promise.all([
        tx.knowledgeAssetRepresentative.count({
          where: { representativeId: representative.id, enabled: true },
        }),
        tx.representativeChannelBinding.count({
          where: { representativeId: representative.id },
        }),
      ]);
      const knowledgeItemCount =
        input.knowledgePack.faq.length +
        input.knowledgePack.materials.length +
        input.knowledgePack.policies.length;
      const isPublishReady =
        (linkedKnowledgeCount > 0 || knowledgeItemCount > 0) &&
        (!liveRepresentative.humanInLoop || Boolean(input.handoffPrompt.trim())) &&
        (channelCount > 0 || input.publicMode);
      if (
        representative.lifecycleState === RepresentativeLifecycleState.DRAFT ||
        representative.lifecycleState === RepresentativeLifecycleState.CONFIGURING ||
        representative.lifecycleState === RepresentativeLifecycleState.READY
      ) {
        await tx.representative.update({
          where: { id: representative.id },
          data: {
            lifecycleState: isPublishReady
              ? RepresentativeLifecycleState.READY
              : RepresentativeLifecycleState.CONFIGURING,
          },
        });
      }

      const refreshed = await tx.representative.findUnique({
        where: { id: representative.id },
        include: representativeSetupInclude,
      });

      if (!refreshed) {
        throw new Error("Representative disappeared during update.");
      }

      return refreshed;
    });

    return serializeRepresentativeSetup(updated);
  } catch (error) {
    if (shouldUseDemoFallback(error, params.representativeSlug)) {
      return updateDemoFallbackRepresentativeSetup(input);
    }

    throw error;
  }
}

export function buildComputePolicyAuditPayload(params: {
  currentCompute: RepresentativeSetupSnapshot["compute"];
  currentDelegation: RepresentativeSetupSnapshot["delegation"];
  nextCompute: RepresentativeSetupSnapshot["compute"];
  nextDelegation: RepresentativeSetupSnapshot["delegation"];
  changedBy: string;
}): ComputePolicyAuditPayload | null {
  const changedFields = [
    params.currentCompute.enabled !== params.nextCompute.enabled
      ? "compute.enabled"
      : null,
    params.currentCompute.defaultPolicyMode !== params.nextCompute.defaultPolicyMode
      ? "compute.defaultPolicyMode"
      : null,
    params.currentCompute.baseImage !== params.nextCompute.baseImage
      ? "compute.baseImage"
      : null,
    params.currentCompute.maxSessionMinutes !== params.nextCompute.maxSessionMinutes
      ? "compute.maxSessionMinutes"
      : null,
    params.currentCompute.autoApproveTokenLimit !==
      params.nextCompute.autoApproveTokenLimit
      ? "compute.autoApproveTokenLimit"
      : null,
    params.currentCompute.artifactRetentionDays !==
      params.nextCompute.artifactRetentionDays
      ? "compute.artifactRetentionDays"
      : null,
    params.currentCompute.networkMode !== params.nextCompute.networkMode
      ? "compute.networkMode"
      : null,
    !haveSameStringSet(
      params.currentCompute.networkAllowlist,
      params.nextCompute.networkAllowlist,
    )
      ? "compute.networkAllowlist"
      : null,
    params.currentCompute.filesystemMode !== params.nextCompute.filesystemMode
      ? "compute.filesystemMode"
      : null,
    ...(
      Object.keys(params.currentCompute.capabilityModes) as Array<
        keyof RepresentativeSetupSnapshot["compute"]["capabilityModes"]
      >
    ).map((capability) =>
      params.currentCompute.capabilityModes[capability] !==
      params.nextCompute.capabilityModes[capability]
        ? `compute.capabilityModes.${capability}`
        : null,
    ),
    params.currentDelegation.enabled !== params.nextDelegation.enabled
      ? "delegation.enabled"
      : null,
    params.currentDelegation.naturalLanguageEnabled !==
      params.nextDelegation.naturalLanguageEnabled
      ? "delegation.naturalLanguageEnabled"
      : null,
    params.currentDelegation.explicitComputeEnabled !==
      params.nextDelegation.explicitComputeEnabled
      ? "delegation.explicitComputeEnabled"
      : null,
    params.currentDelegation.maxSteps !== params.nextDelegation.maxSteps
      ? "delegation.maxSteps"
      : null,
    params.currentDelegation.maxEstimatedTokens !== params.nextDelegation.maxEstimatedTokens
      ? "delegation.maxEstimatedTokens"
      : null,
    params.currentDelegation.knowledgeScope !== params.nextDelegation.knowledgeScope
      ? "delegation.knowledgeScope"
      : null,
  ].filter((field): field is string => Boolean(field));
  if (!changedFields.length) return null;

  return {
    changedBy: params.changedBy,
    changedFields,
    modes: {
      computeEnabled: params.nextCompute.enabled,
      defaultPolicyMode: params.nextCompute.defaultPolicyMode,
      networkMode: params.nextCompute.networkMode,
      filesystemMode: params.nextCompute.filesystemMode,
      capabilityModes: { ...params.nextCompute.capabilityModes },
      delegationEnabled: params.nextDelegation.enabled,
      naturalLanguageEnabled: params.nextDelegation.naturalLanguageEnabled,
      explicitComputeEnabled: params.nextDelegation.explicitComputeEnabled,
      knowledgeScope: params.nextDelegation.knowledgeScope,
    },
    values: {
      maxSessionMinutes: params.nextCompute.maxSessionMinutes,
      autoApproveTokenLimit: params.nextCompute.autoApproveTokenLimit,
      artifactRetentionDays: params.nextCompute.artifactRetentionDays,
      networkAllowlistCount: sanitizeNetworkAllowlist(
        params.nextCompute.networkAllowlist,
      ).length,
      maxSteps: params.nextDelegation.maxSteps,
      maxEstimatedTokens: params.nextDelegation.maxEstimatedTokens,
    },
  };
}

function haveSameStringSet(left: string[], right: string[]): boolean {
  const normalizedLeft = [...new Set(left.map((value) => value.trim().toLowerCase()).filter(Boolean))]
    .sort();
  const normalizedRight = [...new Set(right.map((value) => value.trim().toLowerCase()).filter(Boolean))]
    .sort();
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function serializeRepresentativeSetup(
  representative: RepresentativeSetupRecord,
): RepresentativeSetupSnapshot {
  return {
    id: representative.id,
    slug: representative.slug,
    knowledgePackRevision: representative.knowledgePack?.revision ?? 0,
    ownerName: representative.owner.displayName,
    name: representative.displayName,
    tagline: representative.roleSummary,
    tone: representative.tone,
    languages: parseStringArray(representative.languages, demoRepresentative.languages),
    groupActivation: mapGroupActivationFromDb(representative.groupActivation),
    publicMode: representative.publicMode,
    humanInLoop: representative.humanInLoop,
    handoffAccessMode: representative.handoffAccessMode,
    skills: parseRepresentativeSkills(representative.allowedSkills),
    skillPacks: representative.skillPackLinks.flatMap((link) => {
      const install = link.workspaceInstall;
      const release = install?.releases[0];
      if (
        !install ||
        !release ||
        install.status === WorkspaceSkillInstallStatus.ARCHIVED ||
        (
          install.reviewStatus !== WorkspaceSkillReviewStatus.APPROVED
          && install.status !== WorkspaceSkillInstallStatus.UPDATE_AVAILABLE
        ) ||
        !isWorkspaceSkillReleaseRuntimeTrusted({
          source: link.skillPack.source,
          executesCode: release.executesCode,
          registryTrustEligible: release.registryTrustEligible,
          signatureStatus: release.signatureStatus,
        })
      ) {
        return [];
      }

      const parsed = skillPackSchema.safeParse({
        id: link.skillPack.id,
        slug: link.skillPack.slug,
        displayName: release.displayName,
        source: link.skillPack.source.toLowerCase(),
        summary: release.summary,
        version: release.version,
        ...(release.sourceUrl ? { sourceUrl: release.sourceUrl } : {}),
        ...(release.ownerHandle ? { ownerHandle: release.ownerHandle } : {}),
        ...(release.verificationTier
          ? { verificationTier: release.verificationTier }
          : {}),
        capabilityTags: parseStringArray(release.capabilityTags, []),
        executesCode: release.executesCode,
        enabled: true,
        installStatus: "installed",
      });
      return parsed.success ? [parsed.data] : [];
    }),
    knowledgePack: {
      identitySummary:
        representative.knowledgePack?.identitySummary ??
        demoRepresentative.knowledgePack.identitySummary,
      faq: parseKnowledgeDocuments(representative.knowledgePack?.faq, demoRepresentative.knowledgePack.faq),
      materials: parseKnowledgeDocuments(
        representative.knowledgePack?.materials,
        demoRepresentative.knowledgePack.materials,
      ),
      policies: parseKnowledgeDocuments(
        representative.knowledgePack?.policies,
        demoRepresentative.knowledgePack.policies,
      ),
    },
    contract: {
      freeReplyLimit: representative.freeReplyLimit,
      handoffWindowHours: representative.handoffWindowHours,
    },
    handoffPrompt: normalizeRepresentativeHandoffPrompt(
      representative.handoffPrompt || demoRepresentative.handoffPrompt,
    ),
    compute: {
      enabled: representative.computeEnabled,
      defaultPolicyMode: mapPolicyDecisionFromDb(representative.computeDefaultPolicyMode),
      baseImage: representative.computeBaseImage,
      maxSessionMinutes: representative.computeMaxSessionMinutes,
      autoApproveTokenLimit: representative.computeAutoApproveTokenLimit,
      artifactRetentionDays: representative.computeArtifactRetentionDays,
      networkMode: mapComputeNetworkModeFromDb(representative.computeNetworkMode),
      networkAllowlist: sanitizeNetworkAllowlist(representative.computeNetworkAllowlist),
      filesystemMode: mapComputeFilesystemModeFromDb(representative.computeFilesystemMode),
      capabilityModes: resolveCapabilityModesFromProfile(representative.capabilityProfiles[0]),
    },
    delegation: {
      enabled: representative.delegationEnabled,
      naturalLanguageEnabled: representative.delegationNaturalLanguageEnabled,
      explicitComputeEnabled: representative.delegationExplicitComputeEnabled,
      maxSteps: representative.delegationMaxSteps,
      maxEstimatedTokens: representative.delegationMaxEstimatedTokens,
      knowledgeScope: mapDelegationKnowledgeScopeFromDb(representative.delegationKnowledgeScope),
    },
  };
}

export function applyRepresentativeVersionSnapshot(
  current: RepresentativeSetupSnapshot,
  value: unknown,
): RepresentativeSetupSnapshot {
  const snapshot = asJsonRecord(value);
  if (!snapshot) return { ...current, skillPacks: [] };

  const identity = asJsonRecord(snapshot.identity);
  const conversation = asJsonRecord(snapshot.conversation);
  const governance = asJsonRecord(snapshot.governance);
  const delegation = asJsonRecord(snapshot.delegation);
  const knowledge = asJsonRecord(snapshot.knowledge);
  const parsedContract = conversationContractSchema.safeParse(conversation);
  const parsedGroupActivation = groupActivationSchema.safeParse(snapshot.groupActivation);
  const currentlyAllowedSkills = new Set(current.skills);
  const parsedSkills = Array.isArray(governance?.allowedSkills)
    ? governance.allowedSkills
        .map((skill) => representativeSkillSchema.safeParse(skill))
        .filter(
          (skill): skill is {
            success: true;
            data: RepresentativeSetupSnapshot["skills"][number];
          } => skill.success,
        )
        .map((skill) => skill.data)
        .filter((skill) => currentlyAllowedSkills.has(skill))
    : [];
  const currentlyAvailableSkillPacks = new Map(
    current.skillPacks.map((pack) => [buildSkillPackAvailabilityKey(pack), pack]),
  );
  const parsedSkillPacks = Array.isArray(snapshot.skills)
    ? snapshot.skills.flatMap((skill) => {
        const parsed = skillPackSchema.safeParse(skill);
        if (!parsed.success || !parsed.data.enabled || parsed.data.executesCode) {
          return [];
        }

        return currentlyAvailableSkillPacks.has(buildSkillPackAvailabilityKey(parsed.data))
          ? [parsed.data]
          : [];
      })
    : [];
  const effectiveCompute = resolvePublishedComputeCeiling(current.compute, snapshot.compute);
  const effectiveDelegation = resolvePublishedDelegationCeiling(
    current.delegation,
    delegation,
  );

  return {
    ...current,
    name: readSnapshotString(identity?.displayName) ?? current.name,
    tagline: readSnapshotString(identity?.roleSummary) ?? current.tagline,
    tone: readSnapshotString(identity?.tone) ?? current.tone,
    languages: identity?.languages
      ? parseStringArray(identity.languages as Prisma.JsonValue, current.languages)
      : current.languages,
    groupActivation: parsedGroupActivation.success
      ? parsedGroupActivation.data
      : "mention_only",
    publicMode:
      typeof snapshot.publicMode === "boolean" ? snapshot.publicMode : current.publicMode,
    // Commerce controls are live owner settings. They intentionally are not
    // pinned to the published content version.
    humanInLoop: current.humanInLoop,
    handoffAccessMode: current.handoffAccessMode,
    skills: Array.isArray(governance?.allowedSkills) ? parsedSkills : [],
    skillPacks: parsedSkillPacks,
    knowledgePack: knowledge
      ? {
          identitySummary:
            readSnapshotString(knowledge.identitySummary) ?? current.knowledgePack.identitySummary,
          faq: parseKnowledgeDocuments(
            knowledge.faq as Prisma.JsonValue,
            current.knowledgePack.faq,
          ),
          materials: parseKnowledgeDocuments(
            knowledge.materials as Prisma.JsonValue,
            current.knowledgePack.materials,
          ),
          policies: parseKnowledgeDocuments(
            knowledge.policies as Prisma.JsonValue,
            current.knowledgePack.policies,
          ),
        }
      : current.knowledgePack,
    contract: parsedContract.success
      ? {
          ...parsedContract.data,
          freeReplyLimit: current.contract.freeReplyLimit,
        }
      : current.contract,
    handoffPrompt: normalizeRepresentativeHandoffPrompt(
      readSnapshotString(conversation?.handoffPrompt) ?? current.handoffPrompt,
    ),
    compute: effectiveCompute,
    delegation: effectiveDelegation,
  };
}

function buildSkillPackAvailabilityKey(
  pack: RepresentativeSetupSnapshot["skillPacks"][number],
): string {
  return [
    pack.id,
    pack.source,
    pack.slug,
    pack.version?.trim() || "",
  ].join("\u0000");
}

export function resolvePublishedComputeCeiling(
  current: RepresentativeSetupSnapshot["compute"],
  publishedValue: unknown,
): RepresentativeSetupSnapshot["compute"] {
  const publishedRecord = asJsonRecord(publishedValue);
  const legacyAutoApproveBudget = publishedRecord?.autoApproveBudgetCents;
  const published = computeSetupSchema.safeParse(
    publishedRecord
      && typeof publishedRecord.autoApproveTokenLimit !== "number"
      && typeof legacyAutoApproveBudget === "number"
      ? {
          ...publishedRecord,
          autoApproveTokenLimit: legacyAutoApproveBudget * 100,
        }
      : publishedValue,
  );
  if (!published.success) {
    return {
      ...cloneComputeSetup(current),
      enabled: false,
      defaultPolicyMode: "deny",
      networkMode: "no_network",
      networkAllowlist: [],
      filesystemMode: "read_only_workspace",
      capabilityModes: {
        exec: "deny",
        read: "deny",
        write: "deny",
        process: "deny",
        browser: "deny",
        mcp: "deny",
      },
    };
  }

  const publishedCompute = published.data;
  const networkMode = resolveRestrictiveNetworkMode(
    current.networkMode,
    publishedCompute.networkMode,
  );
  return {
    enabled:
      current.enabled &&
      publishedCompute.enabled &&
      current.baseImage === publishedCompute.baseImage,
    defaultPolicyMode: resolveRestrictivePolicyDecision(
      current.defaultPolicyMode,
      publishedCompute.defaultPolicyMode,
    ),
    baseImage: publishedCompute.baseImage,
    maxSessionMinutes: Math.min(
      current.maxSessionMinutes,
      publishedCompute.maxSessionMinutes,
    ),
    autoApproveTokenLimit: Math.min(
      current.autoApproveTokenLimit,
      publishedCompute.autoApproveTokenLimit,
    ),
    artifactRetentionDays: Math.min(
      current.artifactRetentionDays,
      publishedCompute.artifactRetentionDays,
    ),
    networkMode,
    networkAllowlist: resolveRestrictiveNetworkAllowlist({
      currentMode: current.networkMode,
      currentAllowlist: current.networkAllowlist,
      publishedMode: publishedCompute.networkMode,
      publishedAllowlist: publishedCompute.networkAllowlist,
      effectiveMode: networkMode,
    }),
    filesystemMode: resolveRestrictiveFilesystemMode(
      current.filesystemMode,
      publishedCompute.filesystemMode,
    ),
    capabilityModes: {
      exec: resolveRestrictivePolicyDecision(
        current.capabilityModes.exec,
        publishedCompute.capabilityModes.exec,
      ),
      read: resolveRestrictivePolicyDecision(
        current.capabilityModes.read,
        publishedCompute.capabilityModes.read,
      ),
      write: resolveRestrictivePolicyDecision(
        current.capabilityModes.write,
        publishedCompute.capabilityModes.write,
      ),
      process: resolveRestrictivePolicyDecision(
        current.capabilityModes.process,
        publishedCompute.capabilityModes.process,
      ),
      browser: resolveRestrictivePolicyDecision(
        current.capabilityModes.browser,
        publishedCompute.capabilityModes.browser,
      ),
      mcp: resolveRestrictivePolicyDecision(
        current.capabilityModes.mcp,
        publishedCompute.capabilityModes.mcp,
      ),
    },
  };
}

export function resolvePublishedDelegationCeiling(
  current: RepresentativeSetupSnapshot["delegation"],
  published: Record<string, unknown> | null,
): RepresentativeSetupSnapshot["delegation"] {
  const publishedMaxSteps =
    typeof published?.maxSteps === "number" &&
    Number.isInteger(published.maxSteps) &&
    published.maxSteps >= 1 &&
    published.maxSteps <= 5
      ? published.maxSteps
      : 1;
  const legacyMaxCost = published?.maxCostCents;
  const normalizedMaxEstimatedTokens =
    typeof published?.maxEstimatedTokens === "number"
      ? published.maxEstimatedTokens
      : typeof legacyMaxCost === "number"
        ? legacyMaxCost * 100
        : undefined;
  const hasPublishedMaxEstimatedTokens =
    typeof normalizedMaxEstimatedTokens === "number" &&
    Number.isInteger(normalizedMaxEstimatedTokens) &&
    normalizedMaxEstimatedTokens >= 0 &&
    normalizedMaxEstimatedTokens <= 100_000_000;
  const publishedMaxEstimatedTokens = hasPublishedMaxEstimatedTokens
    ? normalizedMaxEstimatedTokens as number
    : 0;
  const publishedKnowledgeScope =
    published?.knowledgeScope === "public_knowledge"
      ? "public_knowledge"
      : "user_input_only";

  return {
    enabled:
      current.enabled &&
      published?.enabled === true &&
      hasPublishedMaxEstimatedTokens,
    naturalLanguageEnabled:
      current.naturalLanguageEnabled &&
      published?.naturalLanguageEnabled === true &&
      hasPublishedMaxEstimatedTokens,
    explicitComputeEnabled:
      current.explicitComputeEnabled &&
      published?.explicitComputeEnabled === true &&
      hasPublishedMaxEstimatedTokens,
    maxSteps: Math.min(current.maxSteps, publishedMaxSteps),
    maxEstimatedTokens: hasPublishedMaxEstimatedTokens
      ? resolveRestrictiveDelegationTokenLimit(
          current.maxEstimatedTokens,
          publishedMaxEstimatedTokens,
        )
      : current.maxEstimatedTokens,
    knowledgeScope:
      current.knowledgeScope === "user_input_only" ||
      publishedKnowledgeScope === "user_input_only"
        ? "user_input_only"
        : "public_knowledge",
  };
}

function resolveRestrictiveDelegationTokenLimit(current: number, published: number): number {
  // Zero means "unlimited" for delegation tasks, so it is the least
  // restrictive value rather than the numerical minimum.
  if (current === 0) return published;
  if (published === 0) return current;
  return Math.min(current, published);
}

function resolveRestrictivePolicyDecision(
  current: "allow" | "ask" | "deny",
  published: "allow" | "ask" | "deny",
): "allow" | "ask" | "deny" {
  const rank = { allow: 0, ask: 1, deny: 2 } as const;
  return rank[current] >= rank[published] ? current : published;
}

function resolveRestrictiveNetworkMode(
  current: RepresentativeSetupSnapshot["compute"]["networkMode"],
  published: RepresentativeSetupSnapshot["compute"]["networkMode"],
): RepresentativeSetupSnapshot["compute"]["networkMode"] {
  if (current === "no_network" || published === "no_network") return "no_network";
  if (current === "allowlist" || published === "allowlist") return "allowlist";
  return "full";
}

function resolveRestrictiveNetworkAllowlist(params: {
  currentMode: RepresentativeSetupSnapshot["compute"]["networkMode"];
  currentAllowlist: string[];
  publishedMode: RepresentativeSetupSnapshot["compute"]["networkMode"];
  publishedAllowlist: string[];
  effectiveMode: RepresentativeSetupSnapshot["compute"]["networkMode"];
}): string[] {
  if (params.effectiveMode !== "allowlist") return [];

  const current = sanitizeNetworkAllowlist(params.currentAllowlist);
  const published = sanitizeNetworkAllowlist(params.publishedAllowlist);
  if (params.currentMode === "full") return published;
  if (params.publishedMode === "full") return current;

  const publishedSet = new Set(published);
  return current.filter((hostname) => publishedSet.has(hostname));
}

function resolveRestrictiveFilesystemMode(
  current: RepresentativeSetupSnapshot["compute"]["filesystemMode"],
  published: RepresentativeSetupSnapshot["compute"]["filesystemMode"],
): RepresentativeSetupSnapshot["compute"]["filesystemMode"] {
  const rank = {
    read_only_workspace: 0,
    workspace_only: 1,
    ephemeral_full: 2,
  } as const;
  return rank[current] <= rank[published] ? current : published;
}

export function resolveRepresentativeRuntimeMcpBindings(
  currentBindings: Array<{
    id: string;
    slug: string;
    displayName?: string;
    description?: string | null;
    serverUrl: string;
    transportKind: string;
    allowedToolNames: unknown;
    defaultToolName: string | null;
    enabled: boolean;
    approvalRequired: boolean;
    estimatedTokensPerCall: number;
    maxRetries: number;
    retryBackoffMs: number;
    configRevision?: number;
    consecutiveFailures?: number;
    lastHealthObservationStartedAt?: Date | null;
    lastFailureAt?: Date | null;
    lastFailureReason?: string | null;
    lastSuccessAt?: Date | null;
    toolDefinitions?: Array<{
      exactToolName: string;
      description?: string | null;
      semanticMetadata?: unknown;
      inputSchema: unknown;
      outputSchema: unknown;
      toolSchemaHash: string;
      bindingDefinitionHash: string;
      bindingRevision: number;
      canonicalizationVersion: string;
      availability?: string;
      observedAt?: Date;
      supersededAt?: Date | null;
    }>;
    representativeSkillPackLink?: {
      id: string;
      enabled: boolean;
      installedVersion: string | null;
      skillPack: {
        id: string;
        source: string;
        slug: string;
      };
      workspaceInstall: {
        status: string;
        reviewStatus: string;
        installedVersion: string | null;
        releases: Array<{
          version: string;
          status: string;
          executesCode: boolean;
          registryTrustEligible: boolean;
          signatureStatus: string;
        }>;
      } | null;
    } | null;
  }>,
  publishedValue: unknown,
): RepresentativeRuntimeMcpBindingGrant[] {
  const snapshot = asJsonRecord(publishedValue);
  if (!snapshot || !Array.isArray(snapshot.mcpBindings)) return [];

  const publishedSkillPins = new Set(
    (Array.isArray(snapshot.skills) ? snapshot.skills : [])
      .flatMap((value) => {
        const pin = parsePublishedSkillDeclarationPin(value);
        return pin ? [buildSkillReleaseIdentityKey(pin)] : [];
      }),
  );
  const currentById = new Map(currentBindings.map((binding) => [binding.id, binding]));
  return snapshot.mcpBindings.flatMap((value) => {
    const published = parsePublishedMcpBindingGrant(value);
    if (!published?.enabled) return [];

    const current = currentById.get(published.id);
    if (
      !current ||
      !current.enabled ||
      current.slug !== published.slug ||
      current.serverUrl !== published.serverUrl ||
      current.transportKind.toLowerCase() !== published.transportKind
    ) {
      return [];
    }
    if (published.skillReleasePin) {
      if (
        !publishedSkillPins.has(
          buildSkillReleaseIdentityKey(published.skillReleasePin),
        ) ||
        !current.representativeSkillPackLink ||
        !isRuntimeAvailableMcpSkillLink(
          current.representativeSkillPackLink,
          published.skillReleasePin,
        )
      ) {
        return [];
      }
    } else if (current.representativeSkillPackLink) {
      // A binding published as direct/unlinked cannot gain workspace-skill
      // authority later through a mutable link.
      return [];
    }

    const currentAllowedToolNames = parseStringArray(
      current.allowedToolNames as Prisma.JsonValue,
      [],
    );
    const allowedToolNames = intersectMcpAllowedToolNames(
      currentAllowedToolNames,
      published.allowedToolNames,
    );
    if (
      currentAllowedToolNames.length &&
      published.allowedToolNames.length &&
      !allowedToolNames.length
    ) {
      return [];
    }
    const defaultToolName = resolveEffectiveMcpDefaultToolName({
      current: current.defaultToolName,
      published: published.defaultToolName,
      allowedToolNames,
    });

    const toolDefinitions = (current.toolDefinitions ?? []).flatMap((definition) => {
      if (
        definition.bindingRevision !== (current.configRevision ?? -1)
        || !allowedToolNames.includes(definition.exactToolName)
        || !asJsonRecord(definition.inputSchema)
        || (
          definition.outputSchema !== null
          && !asJsonRecord(definition.outputSchema)
        )
      ) {
        return [];
      }
      return [{
        exactToolName: definition.exactToolName,
        ...(definition.description !== undefined
          ? { description: definition.description }
          : {}),
        ...(asJsonRecord(definition.semanticMetadata)
          ? { semanticMetadata: asJsonRecord(definition.semanticMetadata) }
          : {}),
        inputSchema: asJsonRecord(definition.inputSchema)!,
        outputSchema: asJsonRecord(definition.outputSchema)
          ? asJsonRecord(definition.outputSchema)
          : null,
        toolSchemaHash: `sha256:${definition.toolSchemaHash}`,
        bindingDefinitionHash: `sha256:${definition.bindingDefinitionHash}`,
        bindingRevision: definition.bindingRevision,
        canonicalizationVersion: definition.canonicalizationVersion,
        ...(definition.observedAt
          ? { observedAt: definition.observedAt.toISOString() }
          : {}),
      }];
    });
    const availability = (
      current.consecutiveFailures !== undefined
      || current.lastHealthObservationStartedAt !== undefined
      || current.lastFailureAt !== undefined
      || current.lastSuccessAt !== undefined
    )
      ? resolveMcpBindingAvailability(current)
      : undefined;
    return [{
      id: published.id,
      slug: published.slug,
      ...(current.displayName ? { displayName: current.displayName } : {}),
      ...(current.description !== undefined
        ? { description: current.description }
        : {}),
      serverUrl: published.serverUrl,
      transportKind: published.transportKind,
      allowedToolNames,
      defaultToolName,
      enabled: true as const,
      approvalRequired: current.approvalRequired || published.approvalRequired,
      estimatedTokensPerCall: Math.max(
        current.estimatedTokensPerCall,
        published.estimatedTokensPerCall,
      ),
      maxRetries: Math.min(current.maxRetries, published.maxRetries),
      retryBackoffMs: Math.max(current.retryBackoffMs, published.retryBackoffMs),
      ...(current.configRevision !== undefined
        ? { configRevision: current.configRevision }
        : {}),
      ...(availability ? { availability } : {}),
      ...(toolDefinitions.length ? { toolDefinitions } : {}),
    }];
  });
}

function resolveMcpBindingAvailability(binding: {
  enabled: boolean;
  consecutiveFailures?: number;
  lastHealthObservationStartedAt?: Date | null;
  lastFailureAt?: Date | null;
  lastFailureReason?: string | null;
  lastSuccessAt?: Date | null;
}) {
  const failed = (binding.consecutiveFailures ?? 0) > 0;
  const checkedAt = latestTrustedObservationDate([
    binding.lastHealthObservationStartedAt,
    failed ? binding.lastFailureAt : binding.lastSuccessAt,
  ]).toISOString();
  if (!binding.enabled) {
    return {
      healthState: "unavailable" as const,
      checkedAt,
      failureCode: "mcp_binding_disabled",
    };
  }
  if (failed) {
    return {
      healthState: "degraded" as const,
      checkedAt,
      failureCode: normalizeMcpAvailabilityFailureCode(binding.lastFailureReason),
    };
  }
  if (!binding.lastSuccessAt) {
    return {
      healthState: "degraded" as const,
      checkedAt,
      failureCode: "mcp_health_unverified",
    };
  }
  return { healthState: "ready" as const, checkedAt };
}

function latestTrustedObservationDate(values: Array<Date | null | undefined>) {
  return values.reduce<Date>((latest, value) =>
    value instanceof Date
      && Number.isFinite(value.getTime())
      && value.getTime() > latest.getTime()
      ? value
      : latest,
  new Date(0));
}

function normalizeMcpAvailabilityFailureCode(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 120);
  return normalized ? `mcp_${normalized}` : "mcp_health_degraded";
}

type PublishedSkillReleasePin = {
  linkId: string;
  skillPackId: string;
  source: string;
  slug: string;
  version: string;
};

function isRuntimeAvailableMcpSkillLink(link: {
  id: string;
  enabled: boolean;
  installedVersion: string | null;
  skillPack: {
    id: string;
    source: string;
    slug: string;
  };
  workspaceInstall: {
    status: string;
    reviewStatus: string;
    installedVersion: string | null;
    releases: Array<{
      version: string;
      status: string;
      executesCode: boolean;
      registryTrustEligible: boolean;
      signatureStatus: string;
    }>;
  } | null;
}, publishedPin: PublishedSkillReleasePin): boolean {
  const install = link.workspaceInstall;
  const release = install?.releases[0];
  return Boolean(
    link.enabled
    && install
    && release
    && link.id === publishedPin.linkId
    && link.installedVersion === publishedPin.version
    && link.skillPack.id === publishedPin.skillPackId
    && link.skillPack.source.toLowerCase() === publishedPin.source
    && link.skillPack.slug === publishedPin.slug
    && install.installedVersion === publishedPin.version
    && release.version === publishedPin.version
    && release.status === WorkspaceSkillReleaseStatus.INSTALLED
    && install.status !== WorkspaceSkillInstallStatus.ARCHIVED
    && (
      install.reviewStatus === WorkspaceSkillReviewStatus.APPROVED
      || install.status === WorkspaceSkillInstallStatus.UPDATE_AVAILABLE
    )
    && isWorkspaceSkillReleaseRuntimeTrusted({
      source: link.skillPack.source,
      executesCode: release.executesCode,
      registryTrustEligible: release.registryTrustEligible,
      signatureStatus: release.signatureStatus,
    }),
  );
}

type PublishedMcpBindingGrant = Omit<
  RepresentativeRuntimeMcpBindingGrant,
  "enabled" | "toolDefinitions"
> & {
  enabled: boolean;
  skillReleasePin: PublishedSkillReleasePin | null;
};

function parsePublishedMcpBindingGrant(
  value: unknown,
): PublishedMcpBindingGrant | null {
  const record = asJsonRecord(value);
  if (!record) return null;

  if (!Object.prototype.hasOwnProperty.call(record, "skillReleasePin")) {
    // Historical MCP grants did not record whether they were direct or linked
    // to a skill release. Treat that missing trust boundary as unavailable.
    return null;
  }
  const skillReleasePin = record.skillReleasePin === null
    ? null
    : parsePublishedSkillReleasePin(record.skillReleasePin);
  if (record.skillReleasePin !== null && !skillReleasePin) return null;

  const transportKind =
    record.transportKind === "streamable_http" || record.transportKind === "sse"
      ? record.transportKind
      : null;
  const allowedToolNames =
    Array.isArray(record.allowedToolNames) &&
    record.allowedToolNames.every(
      (toolName) => typeof toolName === "string" && Boolean(toolName.trim()),
    )
      ? [...new Set(record.allowedToolNames.map((toolName) => toolName.trim()))]
      : null;
  const legacyEstimatedCost = record.estimatedCostCentsPerCall;
  const estimatedTokensPerCall =
    typeof record.estimatedTokensPerCall === "number"
      ? record.estimatedTokensPerCall
      : typeof legacyEstimatedCost === "number"
        ? legacyEstimatedCost * 100
        : undefined;
  if (
    !transportKind ||
    !allowedToolNames ||
    typeof record.id !== "string" ||
    !record.id.trim() ||
    typeof record.slug !== "string" ||
    !record.slug.trim() ||
    typeof record.serverUrl !== "string" ||
    !record.serverUrl.trim() ||
    typeof record.enabled !== "boolean" ||
    typeof record.approvalRequired !== "boolean" ||
    typeof estimatedTokensPerCall !== "number" ||
    !Number.isInteger(estimatedTokensPerCall) ||
    estimatedTokensPerCall < 0 ||
    typeof record.maxRetries !== "number" ||
    !Number.isInteger(record.maxRetries) ||
    record.maxRetries < 0 ||
    typeof record.retryBackoffMs !== "number" ||
    !Number.isInteger(record.retryBackoffMs) ||
    record.retryBackoffMs < 0
  ) {
    return null;
  }

  return {
    id: record.id.trim(),
    slug: record.slug.trim(),
    serverUrl: record.serverUrl.trim(),
    transportKind,
    allowedToolNames,
    defaultToolName:
      typeof record.defaultToolName === "string" && record.defaultToolName.trim()
        ? record.defaultToolName.trim()
        : null,
    enabled: record.enabled,
    approvalRequired: record.approvalRequired,
    estimatedTokensPerCall,
    maxRetries: record.maxRetries,
    retryBackoffMs: record.retryBackoffMs,
    skillReleasePin,
  };
}

function parsePublishedSkillReleasePin(value: unknown): PublishedSkillReleasePin | null {
  const record = asJsonRecord(value);
  if (!record) return null;

  const linkId = readSnapshotString(record.linkId);
  const skillPackId = readSnapshotString(record.skillPackId);
  const source = readSnapshotString(record.source)?.toLowerCase();
  const slug = readSnapshotString(record.slug);
  const version = readSnapshotString(record.version);
  if (!linkId || !skillPackId || !source || !slug || !version) return null;

  return { linkId, skillPackId, source, slug, version };
}

function parsePublishedSkillDeclarationPin(
  value: unknown,
): Omit<PublishedSkillReleasePin, "linkId"> | null {
  const parsed = skillPackSchema.safeParse(value);
  const version = parsed.success ? parsed.data.version?.trim() : null;
  if (!parsed.success || !version) return null;

  return {
    skillPackId: parsed.data.id,
    source: parsed.data.source,
    slug: parsed.data.slug,
    version,
  };
}

function buildSkillReleaseIdentityKey(
  pin: Omit<PublishedSkillReleasePin, "linkId">,
): string {
  return [
    pin.skillPackId,
    pin.source.toLowerCase(),
    pin.slug,
    pin.version,
  ].join("\u0000");
}

function intersectMcpAllowedToolNames(current: string[], published: string[]): string[] {
  const normalizedCurrent = [...new Set(current.map((value) => value.trim()).filter(Boolean))];
  const normalizedPublished = [...new Set(published.map((value) => value.trim()).filter(Boolean))];
  if (!normalizedCurrent.length) return normalizedPublished;
  if (!normalizedPublished.length) return normalizedCurrent;

  const publishedSet = new Set(normalizedPublished);
  return normalizedCurrent.filter((toolName) => publishedSet.has(toolName));
}

function resolveEffectiveMcpDefaultToolName(params: {
  current: string | null;
  published: string | null;
  allowedToolNames: string[];
}): string | null {
  const candidates = [params.current, params.published]
    .map((value) => value?.trim() || null)
    .filter((value): value is string => Boolean(value));
  if (!params.allowedToolNames.length) return candidates[0] ?? null;
  return candidates.find((value) => params.allowedToolNames.includes(value))
    ?? params.allowedToolNames[0]
    ?? null;
}

function asJsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readSnapshotString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getOrCreateDemoFallbackSetupSnapshot(): RepresentativeSetupSnapshot {
  if (!demoFallbackSetupSnapshot) {
    demoFallbackSetupSnapshot = {
      id: demoRepresentative.id,
      slug: demoRepresentative.slug,
      knowledgePackRevision: 0,
      ownerName: demoRepresentative.ownerName,
      name: demoRepresentative.name,
      tagline: demoRepresentative.tagline,
      tone: demoRepresentative.tone,
      languages: [...demoRepresentative.languages],
      groupActivation: demoRepresentative.groupActivation,
      publicMode: true,
      humanInLoop: true,
      handoffAccessMode: "FREE",
      skills: [...demoRepresentative.skills],
      skillPacks: demoRepresentative.skillPacks
        .filter((pack) => pack.enabled && !pack.executesCode)
        .map((pack) => ({ ...pack, capabilityTags: [...pack.capabilityTags] })),
      knowledgePack: {
        identitySummary: demoRepresentative.knowledgePack.identitySummary,
        faq: demoRepresentative.knowledgePack.faq.map((item) => ({ ...item })),
        materials: demoRepresentative.knowledgePack.materials.map((item) => ({ ...item })),
        policies: demoRepresentative.knowledgePack.policies.map((item) => ({ ...item })),
      },
      contract: {
        freeReplyLimit: demoRepresentative.contract.freeReplyLimit,
        handoffWindowHours: demoRepresentative.contract.handoffWindowHours,
      },
      handoffPrompt: demoRepresentative.handoffPrompt,
      compute: cloneComputeSetup(defaultComputeSetup),
      delegation: { ...defaultDelegationSetup },
    };
  }

  return demoFallbackSetupSnapshot;
}

function updateDemoFallbackRepresentativeSetup(
  input: RepresentativeSetupUpdateInput,
): RepresentativeSetupSnapshot {
  const snapshot = getOrCreateDemoFallbackSetupSnapshot();
  if (snapshot.knowledgePackRevision !== input.knowledgePackRevision) {
    throw new RepresentativeSetupConflictError();
  }

  snapshot.knowledgePackRevision += 1;
  snapshot.ownerName = input.ownerName;
  snapshot.name = input.name;
  snapshot.tagline = input.tagline;
  snapshot.tone = input.tone;
  snapshot.languages = [...input.languages];
  snapshot.groupActivation = input.groupActivation;
  snapshot.publicMode = input.publicMode;
  snapshot.contract = {
    // Match the database-backed setup path: commerce-owned fields remain
    // unchanged when an unrelated legacy setup section is saved.
    freeReplyLimit: snapshot.contract.freeReplyLimit,
    handoffWindowHours: input.contract.handoffWindowHours,
  };
  snapshot.handoffPrompt = input.handoffPrompt;
  snapshot.knowledgePack = {
    identitySummary: input.knowledgePack.identitySummary,
    faq: normalizeKnowledgeDocuments(input.knowledgePack.faq, "faq"),
    materials: normalizeKnowledgeDocuments(input.knowledgePack.materials, "materials"),
    policies: normalizeKnowledgeDocuments(input.knowledgePack.policies, "policies"),
  };
  snapshot.compute = {
    ...input.compute,
    capabilityModes: { ...input.compute.capabilityModes },
  };
  snapshot.delegation = { ...input.delegation };

  return cloneRepresentativeSetupSnapshot(snapshot);
}

function cloneRepresentativeSetupSnapshot(
  snapshot: RepresentativeSetupSnapshot,
): RepresentativeSetupSnapshot {
  return {
    ...snapshot,
    languages: [...snapshot.languages],
    skills: [...snapshot.skills],
    skillPacks: snapshot.skillPacks.map((pack) => ({
      ...pack,
      capabilityTags: [...pack.capabilityTags],
    })),
    knowledgePack: {
      identitySummary: snapshot.knowledgePack.identitySummary,
      faq: snapshot.knowledgePack.faq.map((item) => ({ ...item })),
      materials: snapshot.knowledgePack.materials.map((item) => ({ ...item })),
      policies: snapshot.knowledgePack.policies.map((item) => ({ ...item })),
    },
    contract: {
      freeReplyLimit: snapshot.contract.freeReplyLimit,
      handoffWindowHours: snapshot.contract.handoffWindowHours,
    },
    compute: cloneComputeSetup(snapshot.compute),
    delegation: { ...snapshot.delegation },
  };
}

function normalizeKnowledgeDocuments(
  documents: Array<z.infer<typeof editableKnowledgeDocumentSchema>>,
  prefix: string,
): KnowledgeDocument[] {
  return documents.map((document, index) => ({
    id: document.id?.trim() || `${prefix}_${index + 1}`,
    title: document.title.trim(),
    kind: document.kind,
    summary: document.summary.trim(),
    ...(document.url ? { url: document.url } : {}),
  }));
}

function buildRepresentativeTemplate(params: {
  ownerName: string;
  representativeName: string;
  tagline?: string;
}): Omit<RepresentativeSetupSnapshot, "id" | "slug" | "knowledgePackRevision"> {
  const safeOwnerName = params.ownerName.trim();
  const safeRepresentativeName = params.representativeName.trim();
  const tagline =
    params.tagline?.trim() ||
    `替 ${safeOwnerName} 接住网页上的公开咨询，先回答常见问题，再把高价值请求整理给真人。`;

  return {
    ownerName: safeOwnerName,
    name: safeRepresentativeName,
    tagline,
    tone: demoRepresentative.tone,
    languages: [...demoRepresentative.languages],
    groupActivation: demoRepresentative.groupActivation,
    publicMode: false,
    humanInLoop: true,
    handoffAccessMode: "FREE",
    skills: [...demoRepresentative.skills],
    skillPacks: demoRepresentative.skillPacks
      .filter((pack) => pack.enabled && !pack.executesCode)
      .map((pack) => ({ ...pack, capabilityTags: [...pack.capabilityTags] })),
    knowledgePack: {
      identitySummary: `${safeOwnerName} 的公开业务代表，适合先处理 FAQ、合作意向、报价请求和预约入口。你可以继续在 dashboard 里补充更具体的公开材料。`,
      faq: [],
      materials: [],
      policies: [],
    },
    contract: {
      freeReplyLimit: demoRepresentative.contract.freeReplyLimit,
      handoffWindowHours: demoRepresentative.contract.handoffWindowHours,
    },
    handoffPrompt: `${safeOwnerName} 的真人评估入口已经开启。请简要描述你的需求；真人接手后会再确认联系人、预算和时间等必要信息。`,
    compute: cloneComputeSetup(defaultComputeSetup),
    delegation: { ...defaultDelegationSetup },
  };
}

function cloneComputeSetup(
  compute: RepresentativeSetupSnapshot["compute"],
): RepresentativeSetupSnapshot["compute"] {
  return {
    ...compute,
    networkAllowlist: [...compute.networkAllowlist],
    capabilityModes: { ...compute.capabilityModes },
  };
}

async function upsertDefaultCapabilityPolicyProfile(
  tx: Prisma.TransactionClient,
  representativeId: string,
  compute: RepresentativeSetupSnapshot["compute"],
) {
  const existingProfile = await tx.capabilityPolicyProfile.findFirst({
    where: {
      representativeId,
      isDefault: true,
    },
    select: {
      id: true,
    },
  });

  const profileId = existingProfile?.id ?? `cap_profile_${representativeId}`;
  const profile = existingProfile
    ? await tx.capabilityPolicyProfile.update({
        where: { id: profileId },
        data: {
          name: "Default Compute Guardrail",
          isDefault: true,
          enabled: true,
          isManaged: false,
          managedScope: "REPRESENTATIVE_DEFAULT",
          managedSource: null,
          precedence: 0,
          defaultDecision: mapPolicyDecisionToDb(compute.defaultPolicyMode),
          maxSessionMinutes: compute.maxSessionMinutes,
          maxParallelSessions: 1,
          maxCommandSeconds: 30,
          artifactRetentionDays: compute.artifactRetentionDays,
          networkMode: mapComputeNetworkModeToDb(compute.networkMode),
          networkAllowlist: sanitizeNetworkAllowlist(compute.networkAllowlist),
          filesystemMode: mapComputeFilesystemModeToDb(compute.filesystemMode),
        },
      })
    : await tx.capabilityPolicyProfile.create({
        data: {
          id: profileId,
          representativeId,
          name: "Default Compute Guardrail",
          isDefault: true,
          enabled: true,
          isManaged: false,
          managedScope: "REPRESENTATIVE_DEFAULT",
          precedence: 0,
          defaultDecision: mapPolicyDecisionToDb(compute.defaultPolicyMode),
          maxSessionMinutes: compute.maxSessionMinutes,
          maxParallelSessions: 1,
          maxCommandSeconds: 30,
          artifactRetentionDays: compute.artifactRetentionDays,
          networkMode: mapComputeNetworkModeToDb(compute.networkMode),
          networkAllowlist: sanitizeNetworkAllowlist(compute.networkAllowlist),
          filesystemMode: mapComputeFilesystemModeToDb(compute.filesystemMode),
        },
      });

  await tx.capabilityPolicyRule.deleteMany({
    where: {
      profileId: profile.id,
    },
  });

  await tx.capabilityPolicyRule.createMany({
    data: buildOwnerCapabilityPolicyRules(profile.id, compute.capabilityModes),
  });
}

function buildOwnerCapabilityPolicyRules(
  profileId: string,
  modes: RepresentativeSetupSnapshot["compute"]["capabilityModes"],
): Prisma.CapabilityPolicyRuleCreateManyInput[] {
  const specifications: Array<{
    key: keyof typeof modes;
    capability: Prisma.CapabilityPolicyRuleCreateManyInput["capability"];
    commandPattern?: string;
    pathPattern?: string;
    domainPattern?: string;
    resourceScopeCondition?: Prisma.CapabilityPolicyRuleCreateManyInput["resourceScopeCondition"];
  }> = [
    { key: "exec", capability: "EXEC", commandPattern: ".*" },
    { key: "read", capability: "READ", pathPattern: "^/workspace(?:/|$)", resourceScopeCondition: "WORKSPACE" },
    { key: "write", capability: "WRITE", pathPattern: "^/workspace(?:/|$)", resourceScopeCondition: "WORKSPACE" },
    { key: "process", capability: "PROCESS", resourceScopeCondition: "WORKSPACE" },
    { key: "browser", capability: "BROWSER", domainPattern: ".*", resourceScopeCondition: "BROWSER_LANE" },
    { key: "mcp", capability: "MCP", resourceScopeCondition: "REMOTE_MCP" },
  ];

  return specifications.map((specification, index) => {
    const mode = modes[specification.key];
    return {
      id: `${profileId}_${specification.key}_owner_mode`,
      profileId,
      capability: specification.capability,
      decision: mapPolicyDecisionToDb(mode),
      ...(specification.commandPattern ? { commandPattern: specification.commandPattern } : {}),
      ...(specification.pathPattern ? { pathPattern: specification.pathPattern } : {}),
      ...(specification.domainPattern ? { domainPattern: specification.domainPattern } : {}),
      ...(specification.resourceScopeCondition
        ? { resourceScopeCondition: specification.resourceScopeCondition }
        : {}),
      priority: 120 - index,
      requiresPaidPlan: false,
      requiresHumanApproval: mode === "ask",
    };
  });
}

function resolveCapabilityModesFromProfile(
  profile: RepresentativeSetupRecord["capabilityProfiles"][number] | undefined,
): RepresentativeSetupSnapshot["compute"]["capabilityModes"] {
  const modes = { ...defaultComputeSetup.capabilityModes };
  if (!profile) return modes;

  for (const capability of Object.keys(modes) as Array<keyof typeof modes>) {
    const rule = profile.rules.find((candidate) =>
      candidate.id.endsWith(`_${capability}_owner_mode`),
    );
    if (rule) modes[capability] = mapPolicyDecisionFromDb(rule.decision);
  }
  return modes;
}

async function upsertManagedCapabilityPolicyProfile(
  tx: Prisma.TransactionClient,
  representativeId: string,
) {
  const profileId = `cap_profile_managed_${representativeId}`;
  const profile = await tx.capabilityPolicyProfile.upsert({
    where: { id: profileId },
    update: {
      name: "Delegate Managed Guardrail",
      isDefault: false,
      enabled: true,
      isManaged: true,
      managedScope: "DELEGATE_MANAGED",
      managedSource: "delegate-default",
      editableByOwner: false,
      ownerId: null,
      contactTrustTierCondition: null,
      precedence: 100,
      defaultDecision: "ASK",
      maxSessionMinutes: 15,
      maxParallelSessions: 1,
      maxCommandSeconds: 30,
      artifactRetentionDays: 14,
      networkMode: ComputeNetworkMode.NO_NETWORK,
      networkAllowlist: [],
      filesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
    },
    create: {
      id: profileId,
      representativeId,
      name: "Delegate Managed Guardrail",
      isDefault: false,
      enabled: true,
      isManaged: true,
      managedScope: "DELEGATE_MANAGED",
      managedSource: "delegate-default",
      editableByOwner: false,
      precedence: 100,
      defaultDecision: "ASK",
      maxSessionMinutes: 15,
      maxParallelSessions: 1,
      maxCommandSeconds: 30,
      artifactRetentionDays: 14,
      networkMode: ComputeNetworkMode.NO_NETWORK,
      networkAllowlist: [],
      filesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
    },
  });

  await tx.capabilityPolicyRule.deleteMany({
    where: {
      profileId: profile.id,
    },
  });

  await tx.capabilityPolicyRule.createMany({
    data: [
      {
        id: `${profile.id}_browser_paid_private`,
        profileId: profile.id,
        capability: "BROWSER",
        decision: "ASK",
        domainPattern: ".*",
        resourceScopeCondition: "BROWSER_LANE",
        channelCondition: Channel.PRIVATE_CHAT,
        requiredPlanTier: CapabilityPlanTier.PASS,
        priority: 220,
        requiresPaidPlan: true,
        requiresHumanApproval: true,
      },
      {
        id: `${profile.id}_process_paid`,
        profileId: profile.id,
        capability: "PROCESS",
        decision: "ASK",
        resourceScopeCondition: "WORKSPACE",
        requiredPlanTier: CapabilityPlanTier.PASS,
        priority: 210,
        requiresPaidPlan: true,
        requiresHumanApproval: true,
      },
      {
        id: `${profile.id}_mcp_paid`,
        profileId: profile.id,
        capability: "MCP",
        decision: "ASK",
        resourceScopeCondition: "REMOTE_MCP",
        priority: 208,
        requiresPaidPlan: false,
        requiresHumanApproval: true,
      },
      {
        id: `${profile.id}_write_secret_paths`,
        profileId: profile.id,
        capability: "WRITE",
        decision: "DENY",
        pathPattern: "^/workspace(?:/.*)?/(?:\\.env(?:\\..*)?|.*\\.pem|.*\\.key)$",
        resourceScopeCondition: "WORKSPACE",
        priority: 205,
        requiresPaidPlan: false,
        requiresHumanApproval: false,
      },
    ],
  });
}

async function upsertOwnerManagedCapabilityProfiles(
  tx: Prisma.TransactionClient,
  ownerId: string,
) {
  const baselineProfileId = `cap_profile_owner_baseline_${ownerId}`;
  const trustedProfileId = `cap_profile_owner_trusted_${ownerId}`;

  const baselineProfile = await tx.capabilityPolicyProfile.upsert({
    where: { id: baselineProfileId },
    update: {
      ownerId,
      representativeId: null,
      name: "Owner Managed Baseline",
      isDefault: false,
      enabled: true,
      isManaged: true,
      managedScope: "OWNER_MANAGED",
      managedSource: "owner-managed",
      editableByOwner: true,
      contactTrustTierCondition: null,
      precedence: 80,
      defaultDecision: "ASK",
      maxSessionMinutes: 15,
      maxParallelSessions: 1,
      maxCommandSeconds: 30,
      artifactRetentionDays: 14,
      networkMode: ComputeNetworkMode.NO_NETWORK,
      networkAllowlist: [],
      filesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
    },
    create: {
      id: baselineProfileId,
      ownerId,
      representativeId: null,
      name: "Owner Managed Baseline",
      isDefault: false,
      enabled: true,
      isManaged: true,
      managedScope: "OWNER_MANAGED",
      managedSource: "owner-managed",
      editableByOwner: true,
      precedence: 80,
      defaultDecision: "ASK",
      maxSessionMinutes: 15,
      maxParallelSessions: 1,
      maxCommandSeconds: 30,
      artifactRetentionDays: 14,
      networkMode: ComputeNetworkMode.NO_NETWORK,
      networkAllowlist: [],
      filesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
    },
  });

  const trustedProfile = await tx.capabilityPolicyProfile.upsert({
    where: { id: trustedProfileId },
    update: {
      ownerId,
      representativeId: null,
      name: "Trusted Customer Overlay",
      isDefault: false,
      enabled: true,
      isManaged: true,
      managedScope: "CUSTOMER_TRUST_TIER",
      managedSource: "owner-managed",
      editableByOwner: true,
      contactTrustTierCondition: "verified",
      precedence: 90,
      defaultDecision: "ASK",
      maxSessionMinutes: 15,
      maxParallelSessions: 1,
      maxCommandSeconds: 30,
      artifactRetentionDays: 14,
      networkMode: ComputeNetworkMode.NO_NETWORK,
      networkAllowlist: [],
      filesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
    },
    create: {
      id: trustedProfileId,
      ownerId,
      representativeId: null,
      name: "Trusted Customer Overlay",
      isDefault: false,
      enabled: true,
      isManaged: true,
      managedScope: "CUSTOMER_TRUST_TIER",
      managedSource: "owner-managed",
      editableByOwner: true,
      contactTrustTierCondition: "verified",
      precedence: 90,
      defaultDecision: "ASK",
      maxSessionMinutes: 15,
      maxParallelSessions: 1,
      maxCommandSeconds: 30,
      artifactRetentionDays: 14,
      networkMode: ComputeNetworkMode.NO_NETWORK,
      networkAllowlist: [],
      filesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
    },
  });

  await tx.capabilityPolicyRule.deleteMany({
    where: {
      profileId: {
        in: [baselineProfile.id, trustedProfile.id],
      },
    },
  });

  await tx.capabilityPolicyRule.createMany({
    data: [
      {
        id: `${baselineProfile.id}_browser_baseline`,
        profileId: baselineProfile.id,
        capability: "BROWSER",
        decision: "ASK",
        resourceScopeCondition: "BROWSER_LANE",
        channelCondition: Channel.PRIVATE_CHAT,
        requiredPlanTier: CapabilityPlanTier.PASS,
        priority: 160,
        requiresPaidPlan: true,
        requiresHumanApproval: true,
      },
      {
        id: `${baselineProfile.id}_mcp_baseline`,
        profileId: baselineProfile.id,
        capability: "MCP",
        decision: "ASK",
        resourceScopeCondition: "REMOTE_MCP",
        channelCondition: Channel.PRIVATE_CHAT,
        priority: 155,
        requiresPaidPlan: false,
        requiresHumanApproval: true,
      },
      {
        id: `${trustedProfile.id}_browser_trusted`,
        profileId: trustedProfile.id,
        capability: "BROWSER",
        decision: "ASK",
        resourceScopeCondition: "BROWSER_LANE",
        channelCondition: Channel.PRIVATE_CHAT,
        requiredPlanTier: CapabilityPlanTier.PASS,
        priority: 170,
        requiresPaidPlan: true,
        requiresHumanApproval: true,
      },
      {
        id: `${trustedProfile.id}_mcp_trusted`,
        profileId: trustedProfile.id,
        capability: "MCP",
        decision: "ALLOW",
        resourceScopeCondition: "REMOTE_MCP",
        channelCondition: Channel.PRIVATE_CHAT,
        priority: 165,
        requiresPaidPlan: false,
        requiresHumanApproval: false,
      },
    ],
  });
}

function buildDemoDirectoryItem(): RepresentativeDirectoryItem {
  return {
    id: demoRepresentative.id,
    slug: demoRepresentative.slug,
    ownerName: demoRepresentative.ownerName,
    name: demoRepresentative.name,
    tagline: demoRepresentative.tagline,
    updatedAt: new Date(0).toISOString(),
    lifecycleState: "published",
    activeVersion: 1,
  };
}

async function reserveRepresentativeSlug(
  tx: Prisma.TransactionClient,
  preferredSlug: string,
): Promise<string> {
  const base = slugify(preferredSlug);

  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    const existing = await tx.representative.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });

    if (!existing) {
      return candidate;
    }
  }

  throw new Error("Could not reserve a unique representative slug.");
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "founder-representative";
}

function parseKnowledgeDocuments(
  value: Prisma.JsonValue | null | undefined,
  fallback: KnowledgeDocument[],
): KnowledgeDocument[] {
  if (!Array.isArray(value)) {
    return fallback.map((item) => ({ ...item }));
  }

  const parsed = value
    .map((entry) => knowledgeDocumentSchema.safeParse(entry))
    .filter((entry): entry is { success: true; data: KnowledgeDocument } => entry.success)
    .map((entry) => entry.data);

  return parsed;
}

async function findLocalDashboardOwnerId(): Promise<string | undefined> {
  const owner = await prisma.owner.findFirst({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return owner?.id;
}

function parseRepresentativeSkills(value: Prisma.JsonValue): Representative["skills"] {
  if (!Array.isArray(value)) {
    return [...demoRepresentative.skills];
  }

  const parsed = value
    .map((entry) => representativeSkillSchema.safeParse(entry))
    .filter((entry): entry is { success: true; data: Representative["skills"][number] } => entry.success)
    .map((entry) => entry.data);

  return parsed.length > 0 ? parsed : [...demoRepresentative.skills];
}

function parseStringArray(value: Prisma.JsonValue, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const parsed = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : [...fallback];
}

function shouldUseDemoFallback(error: unknown, representativeSlug: string): boolean {
  return representativeSlug === demoRepresentative.slug && isPrismaUnavailableError(error);
}

function shouldUseStaticFallbackMode(representativeSlug: string): boolean {
  return representativeSlug === demoRepresentative.slug && !process.env.DATABASE_URL?.trim();
}

function isPrismaUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Can't reach database server") ||
    error.message.includes("Environment variable not found: DATABASE_URL") ||
    error.message.includes("P1001")
  );
}

function mapGroupActivationToDb(value: DomainGroupActivation): GroupActivation {
  switch (value) {
    case "mention_only":
      return GroupActivation.MENTION_ONLY;
    case "always":
      return GroupActivation.ALWAYS;
    case "reply_or_mention":
    default:
      return GroupActivation.REPLY_OR_MENTION;
  }
}

function mapGroupActivationFromDb(value: GroupActivation): DomainGroupActivation {
  switch (value) {
    case GroupActivation.MENTION_ONLY:
      return "mention_only";
    case GroupActivation.ALWAYS:
      return "always";
    case GroupActivation.REPLY_OR_MENTION:
    default:
      return "reply_or_mention";
  }
}

function mapSkillPackSourceToDb(value: "builtin" | "owner_upload" | "clawhub"): SkillPackSource {
  switch (value) {
    case "clawhub":
      return SkillPackSource.CLAWHUB;
    case "owner_upload":
      return SkillPackSource.OWNER_UPLOAD;
    case "builtin":
    default:
      return SkillPackSource.BUILTIN;
  }
}

function mapPolicyDecisionToDb(value: RepresentativeSetupSnapshot["compute"]["defaultPolicyMode"]) {
  return value.toUpperCase() as PolicyDecision;
}

function mapPolicyDecisionFromDb(value: PolicyDecision) {
  return value.toLowerCase() as RepresentativeSetupSnapshot["compute"]["defaultPolicyMode"];
}

function mapComputeNetworkModeToDb(value: RepresentativeSetupSnapshot["compute"]["networkMode"]) {
  return value.toUpperCase() as ComputeNetworkMode;
}

function mapComputeNetworkModeFromDb(value: ComputeNetworkMode) {
  return value.toLowerCase() as RepresentativeSetupSnapshot["compute"]["networkMode"];
}

function sanitizeNetworkAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const candidate = entry.trim().toLowerCase();
    if (!candidate || seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    normalized.push(candidate);
  }

  return normalized.slice(0, 50);
}

function mapComputeFilesystemModeToDb(
  value: RepresentativeSetupSnapshot["compute"]["filesystemMode"],
) {
  return value.toUpperCase() as ComputeFilesystemMode;
}

function mapComputeFilesystemModeFromDb(value: ComputeFilesystemMode) {
  return value.toLowerCase() as RepresentativeSetupSnapshot["compute"]["filesystemMode"];
}

function mapDelegationKnowledgeScopeToDb(
  value: RepresentativeSetupSnapshot["delegation"]["knowledgeScope"],
) {
  return value === "public_knowledge"
    ? DelegationKnowledgeScope.PUBLIC_KNOWLEDGE
    : DelegationKnowledgeScope.USER_INPUT_ONLY;
}

function mapDelegationKnowledgeScopeFromDb(
  value: DelegationKnowledgeScope,
): RepresentativeSetupSnapshot["delegation"]["knowledgeScope"] {
  return value === DelegationKnowledgeScope.PUBLIC_KNOWLEDGE
    ? "public_knowledge"
    : "user_input_only";
}

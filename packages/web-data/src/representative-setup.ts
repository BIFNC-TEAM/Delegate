import {
  actionGateSchema,
  conversationContractSchema,
  demoRepresentative,
  groupActivationSchema,
  inquiryIntentSchema,
  knowledgeDocumentKindSchema,
  knowledgeDocumentSchema,
  pricingPlanSchema,
  representativeSkillSchema,
  type GroupActivation as DomainGroupActivation,
  type InquiryIntent,
  type KnowledgeDocument,
  type PricingPlan,
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
  CapabilityPlanTier,
  Channel,
  ComputeFilesystemMode,
  ComputeNetworkMode,
  DelegationKnowledgeScope,
  GroupActivation,
  PolicyDecision,
  PricingPlanType,
  RepresentativeLifecycleState,
  RepresentativeChannelKind,
  SkillPackSource,
  type Prisma,
} from "@prisma/client";
import { z } from "zod";

import { prisma } from "./prisma";
import { maybeSyncRepresentativeOpenVikingResources } from "./openviking";
import { getDemoCreatorTrainingKnowledgeOverlay } from "./creator-training";

const representativeSetupInclude = {
  owner: true,
  knowledgePack: true,
  pricingPlans: true,
  capabilityProfiles: {
    where: { isDefault: true, isManaged: false },
    orderBy: { createdAt: "asc" },
    take: 1,
    include: { rules: true },
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

const delegationSetupSchema = z.object({
  enabled: z.boolean(),
  naturalLanguageEnabled: z.boolean(),
  explicitComputeEnabled: z.boolean(),
  maxSteps: z.number().int().min(1).max(5),
  maxCostCents: z.number().int().min(0).max(1_000_000),
  knowledgeScope: z.enum(["user_input_only", "public_knowledge"]),
});

const editableKnowledgeDocumentSchema = z.object({
  id: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  kind: knowledgeDocumentKindSchema,
  summary: z.string().trim().min(1),
  url: z.string().url().optional(),
});

const representativeSetupUpdateSchema = z.object({
  ownerName: z.string().trim().min(1),
  name: z.string().trim().min(1),
  tagline: z.string().trim().min(1),
  tone: z.string().trim().min(1),
  languages: z.array(z.string().trim().min(1)).min(1),
  groupActivation: groupActivationSchema,
  publicMode: z.boolean(),
  humanInLoop: z.boolean(),
  actionGate: actionGateSchema.default(demoRepresentative.actionGate),
  contract: conversationContractSchema,
  handoffPrompt: z.string().trim().min(1),
  pricing: z
    .array(pricingPlanSchema)
    .length(4)
    .superRefine((pricing, ctx) => {
      const seen = new Set<string>();
      for (const plan of pricing) {
        if (seen.has(plan.tier)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate pricing tier: ${plan.tier}`,
          });
          return;
        }
        seen.add(plan.tier);
      }

      for (const tier of ["free", "pass", "deep_help", "sponsor"] as const) {
        if (!seen.has(tier)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Missing pricing tier: ${tier}`,
          });
          return;
        }
      }
    }),
  knowledgePack: z.object({
    identitySummary: z.string().trim().min(1),
    faq: z.array(editableKnowledgeDocumentSchema),
    materials: z.array(editableKnowledgeDocumentSchema),
    policies: z.array(editableKnowledgeDocumentSchema),
  }),
  compute: z.object({
    enabled: z.boolean(),
    defaultPolicyMode: policyDecisionSchema,
    baseImage: z.string().trim().min(1),
    maxSessionMinutes: z.number().int().min(5).max(240),
    autoApproveBudgetCents: z.number().int().min(0).max(100000),
    artifactRetentionDays: z.number().int().min(1).max(365),
    networkMode: computeNetworkModeSchema,
    networkAllowlist: z.array(z.string().trim().min(1)).max(50),
    filesystemMode: computeFilesystemModeSchema,
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
    maxCostCents: 0,
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
  | "knowledgePack"
  | "contract"
  | "pricing"
  | "handoffPrompt"
  | "actionGate"
> & {
  publicMode: boolean;
  humanInLoop: boolean;
  compute: {
    enabled: boolean;
    defaultPolicyMode: "allow" | "ask" | "deny";
    baseImage: string;
    maxSessionMinutes: number;
    autoApproveBudgetCents: number;
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
    maxCostCents: number;
    knowledgeScope: "user_input_only" | "public_knowledge";
  };
};

export type RepresentativeSetupUpdateInput = z.infer<typeof representativeSetupUpdateSchema>;
export type RepresentativeCreateInput = z.infer<typeof representativeCreateSchema>;
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
  | { status: "available"; setup: RepresentativeSetupSnapshot }
  | { status: "not_found" | "unpublished" | "paused" | "private" | "web_disabled" };

export function resolvePublicRepresentativeAvailability(input: {
  lifecycleState: string;
  publicMode: boolean;
  activeVersionId?: string | null;
  webChannelStatuses: string[];
}): PublicRepresentativeRuntimeResult["status"] {
  if (input.lifecycleState.toUpperCase() === "PAUSED") return "paused";
  if (input.lifecycleState.toUpperCase() !== "PUBLISHED" || !input.activeVersionId) return "unpublished";
  if (!input.publicMode) return "private";
  if (!input.webChannelStatuses.some((status) => status.toUpperCase() === "CONNECTED")) return "web_disabled";
  return "available";
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
    skillPacks: [],
    knowledgePack: {
      identitySummary: setup.knowledgePack.identitySummary,
      faq: setup.knowledgePack.faq.map((item) => ({ ...item })),
      materials: setup.knowledgePack.materials.map((item) => ({ ...item })),
      policies: setup.knowledgePack.policies.map((item) => ({ ...item })),
    },
    contract: {
      freeReplyLimit: setup.contract.freeReplyLimit,
      freeScope: [...setup.contract.freeScope],
      paywalledIntents: [...setup.contract.paywalledIntents],
      handoffWindowHours: setup.contract.handoffWindowHours,
    },
    pricing: setup.pricing.map((plan) => ({ ...plan })),
    handoffPrompt: setup.handoffPrompt,
    actionGate: { ...setup.actionGate },
  };
}

let demoFallbackSetupSnapshot: RepresentativeSetupSnapshot | null = null;

const defaultComputeSetup: RepresentativeSetupSnapshot["compute"] = {
  enabled: false,
  defaultPolicyMode: "ask",
  baseImage: "debian:bookworm-slim",
  maxSessionMinutes: 15,
  autoApproveBudgetCents: 0,
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
  maxCostCents: 0,
  knowledgeScope: "user_input_only",
};

export async function listRepresentativeDirectoryItems(ownerId?: string | null): Promise<RepresentativeDirectoryItem[]> {
  if (!process.env.DATABASE_URL?.trim()) {
    return [buildDemoDirectoryItem()];
  }

  try {
    const effectiveOwnerId = ownerId?.trim() || (await findLocalDashboardOwnerId());
    const representatives = await prisma.representative.findMany({
      ...(effectiveOwnerId ? { where: { ownerId: effectiveOwnerId } } : {}),
      include: {
        owner: true,
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
          freeReplyLimit: template.contract.freeReplyLimit,
          freeScope: template.contract.freeScope,
          paywalledIntents: template.contract.paywalledIntents,
          handoffWindowHours: template.contract.handoffWindowHours,
          freeMonthlyCredit: 100,
          handoffPrompt: template.handoffPrompt,
          allowedSkills: template.skills,
          actionGate: template.actionGate,
          openvikingEnabled: false,
          openvikingAgentId: buildOpenVikingAgentId(slug, openVikingEnv),
          openvikingAutoRecall: openVikingEnv.autoRecallDefault,
          openvikingAutoCapture: openVikingEnv.autoCaptureDefault,
          openvikingCaptureMode: openVikingEnv.captureModeDefault,
          openvikingRecallLimit: 6,
          openvikingRecallScoreThreshold: 0.01,
          openvikingTargetUri: buildRepresentativeResourceRootUri(slug),
          computeEnabled: template.compute.enabled,
          computeDefaultPolicyMode: mapPolicyDecisionToDb(template.compute.defaultPolicyMode),
          computeBaseImage: template.compute.baseImage,
          computeMaxSessionMinutes: template.compute.maxSessionMinutes,
          computeAutoApproveBudgetCents: template.compute.autoApproveBudgetCents,
          computeArtifactRetentionDays: template.compute.artifactRetentionDays,
          computeNetworkMode: mapComputeNetworkModeToDb(template.compute.networkMode),
          computeNetworkAllowlist: sanitizeNetworkAllowlist(template.compute.networkAllowlist),
          computeFilesystemMode: mapComputeFilesystemModeToDb(template.compute.filesystemMode),
          delegationEnabled: template.delegation.enabled,
          delegationNaturalLanguageEnabled: template.delegation.naturalLanguageEnabled,
          delegationExplicitComputeEnabled: template.delegation.explicitComputeEnabled,
          delegationMaxSteps: template.delegation.maxSteps,
          delegationMaxCostCents: template.delegation.maxCostCents,
          delegationKnowledgeScope: mapDelegationKnowledgeScopeToDb(template.delegation.knowledgeScope),
        },
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

      await tx.pricingPlan.createMany({
        data: template.pricing.map((plan) => ({
          id: `pricing_${representative.id}_${plan.tier}`,
          representativeId: representative.id,
          type: mapPricingPlanTypeToDb(plan.tier),
          name: plan.name,
          starsAmount: plan.stars,
          summary: plan.summary,
          includedReplies: plan.includedReplies,
          includesPriorityHandoff: plan.includesPriorityHandoff,
        })),
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

        await tx.representativeSkillPack.create({
          data: {
            representativeId: representative.id,
            skillPackId: skillPack.id,
            enabled: pack.enabled,
            installStatus: pack.installStatus,
            installedVersion: pack.version ?? null,
            installedAt: pack.installStatus === "available" ? null : now,
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

    const snapshot = serializeRepresentativeSetup(created);
    await maybeSyncRepresentativeOpenVikingResources({
      representativeSlug: snapshot.slug,
      trigger: "create",
    });
    return snapshot;
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
    return applyDemoTrainingOverlay(
      cloneRepresentativeSetupSnapshot(getOrCreateDemoFallbackSetupSnapshot()),
      representativeSlug,
    );
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
      return applyDemoTrainingOverlay(
        cloneRepresentativeSetupSnapshot(getOrCreateDemoFallbackSetupSnapshot()),
        representativeSlug,
      );
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

  const version = representativeVersionId?.trim()
    ? await prisma.representativeVersion.findFirst({
        where: {
          id: representativeVersionId.trim(),
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
    return setup ? { status: "available", setup } : { status: "not_found" };
  }

  const representative = await prisma.representative.findUnique({
    where: { slug: representativeSlug },
    select: {
      lifecycleState: true,
      publicMode: true,
      activeVersionId: true,
      channelBindings: {
        where: { kind: RepresentativeChannelKind.WEB },
        select: { status: true },
      },
    },
  });
  if (!representative) return { status: "not_found" };
  const availability = resolvePublicRepresentativeAvailability({
    lifecycleState: representative.lifecycleState,
    publicMode: representative.publicMode,
    activeVersionId: representative.activeVersionId,
    webChannelStatuses: representative.channelBindings.map((binding) => binding.status),
  });
  if (availability !== "available") return { status: availability };

  const setup = await getRepresentativeRuntimeSetupSnapshot(
    representativeSlug,
    representative.activeVersionId,
  );
  return setup ? { status: "available", setup } : { status: "unpublished" };
}

export async function updateRepresentativeSetup(params: {
  representativeSlug: string;
  input: RepresentativeSetupUpdateInput;
  syncOpenViking?: boolean;
}): Promise<RepresentativeSetupSnapshot> {
  const input = representativeSetupUpdateSchema.parse(params.input);

  if (shouldUseStaticFallbackMode(params.representativeSlug)) {
    return updateDemoFallbackRepresentativeSetup(input);
  }

  try {
    const representative = await prisma.representative.findUnique({
      where: { slug: params.representativeSlug },
      include: representativeSetupInclude,
    });

    if (!representative) {
      throw new Error(`Representative "${params.representativeSlug}" not found.`);
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.representative.update({
        where: { id: representative.id },
        data: {
          displayName: input.name,
          roleSummary: input.tagline,
          tone: input.tone,
          publicMode: input.publicMode,
          groupActivation: mapGroupActivationToDb(input.groupActivation),
          humanInLoop: input.humanInLoop,
          languages: input.languages,
          freeReplyLimit: input.contract.freeReplyLimit,
          freeScope: input.contract.freeScope,
          paywalledIntents: input.contract.paywalledIntents,
          handoffWindowHours: input.contract.handoffWindowHours,
          handoffPrompt: input.handoffPrompt,
          actionGate: input.actionGate,
          computeEnabled: input.compute.enabled,
          computeDefaultPolicyMode: mapPolicyDecisionToDb(input.compute.defaultPolicyMode),
          computeBaseImage: input.compute.baseImage,
          computeMaxSessionMinutes: input.compute.maxSessionMinutes,
          computeAutoApproveBudgetCents: input.compute.autoApproveBudgetCents,
          computeArtifactRetentionDays: input.compute.artifactRetentionDays,
          computeNetworkMode: mapComputeNetworkModeToDb(input.compute.networkMode),
          computeNetworkAllowlist: sanitizeNetworkAllowlist(input.compute.networkAllowlist),
          computeFilesystemMode: mapComputeFilesystemModeToDb(input.compute.filesystemMode),
          delegationEnabled: input.delegation.enabled,
          delegationNaturalLanguageEnabled: input.delegation.naturalLanguageEnabled,
          delegationExplicitComputeEnabled: input.delegation.explicitComputeEnabled,
          delegationMaxSteps: input.delegation.maxSteps,
          delegationMaxCostCents: input.delegation.maxCostCents,
          delegationKnowledgeScope: mapDelegationKnowledgeScopeToDb(input.delegation.knowledgeScope),
        },
      });

      await upsertDefaultCapabilityPolicyProfile(tx, representative.id, input.compute);
      await upsertManagedCapabilityPolicyProfile(tx, representative.id);
      await upsertOwnerManagedCapabilityProfiles(tx, representative.ownerId);

      await tx.knowledgePack.upsert({
        where: { representativeId: representative.id },
        create: {
          representativeId: representative.id,
          identitySummary: input.knowledgePack.identitySummary,
          faq: normalizeKnowledgeDocuments(input.knowledgePack.faq, "faq"),
          materials: normalizeKnowledgeDocuments(input.knowledgePack.materials, "materials"),
          policies: normalizeKnowledgeDocuments(input.knowledgePack.policies, "policies"),
        },
        update: {
          identitySummary: input.knowledgePack.identitySummary,
          faq: normalizeKnowledgeDocuments(input.knowledgePack.faq, "faq"),
          materials: normalizeKnowledgeDocuments(input.knowledgePack.materials, "materials"),
          policies: normalizeKnowledgeDocuments(input.knowledgePack.policies, "policies"),
        },
      });

      await tx.pricingPlan.deleteMany({
        where: { representativeId: representative.id },
      });

      await tx.pricingPlan.createMany({
        data: input.pricing.map((plan) => ({
          id: `pricing_${representative.id}_${plan.tier}`,
          representativeId: representative.id,
          type: mapPricingPlanTypeToDb(plan.tier),
          name: plan.name,
          starsAmount: plan.stars,
          summary: plan.summary,
          includedReplies: plan.includedReplies,
          includesPriorityHandoff: plan.includesPriorityHandoff,
        })),
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
        (!input.humanInLoop || Boolean(input.handoffPrompt.trim())) &&
        input.pricing.length === 4 &&
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

    const snapshot = serializeRepresentativeSetup(updated);
    if (params.syncOpenViking !== false) {
      await maybeSyncRepresentativeOpenVikingResources({
        representativeSlug: snapshot.slug,
        trigger: "setup_update",
      });
    }
    return snapshot;
  } catch (error) {
    if (shouldUseDemoFallback(error, params.representativeSlug)) {
      return updateDemoFallbackRepresentativeSetup(input);
    }

    throw error;
  }
}

function serializeRepresentativeSetup(
  representative: RepresentativeSetupRecord,
): RepresentativeSetupSnapshot {
  return {
    id: representative.id,
    slug: representative.slug,
    ownerName: representative.owner.displayName,
    name: representative.displayName,
    tagline: representative.roleSummary,
    tone: representative.tone,
    languages: parseStringArray(representative.languages, demoRepresentative.languages),
    groupActivation: mapGroupActivationFromDb(representative.groupActivation),
    publicMode: representative.publicMode,
    humanInLoop: representative.humanInLoop,
    skills: parseRepresentativeSkills(representative.allowedSkills),
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
      freeScope: parseInquiryIntents(representative.freeScope, demoRepresentative.contract.freeScope),
      paywalledIntents: parseInquiryIntents(
        representative.paywalledIntents,
        demoRepresentative.contract.paywalledIntents,
      ),
      handoffWindowHours: representative.handoffWindowHours,
    },
    pricing: mergePricingPlans(representative.pricingPlans),
    handoffPrompt: representative.handoffPrompt || demoRepresentative.handoffPrompt,
    actionGate: parseActionGate(representative.actionGate),
    compute: {
      enabled: representative.computeEnabled,
      defaultPolicyMode: mapPolicyDecisionFromDb(representative.computeDefaultPolicyMode),
      baseImage: representative.computeBaseImage,
      maxSessionMinutes: representative.computeMaxSessionMinutes,
      autoApproveBudgetCents: representative.computeAutoApproveBudgetCents,
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
      maxCostCents: representative.delegationMaxCostCents,
      knowledgeScope: mapDelegationKnowledgeScopeFromDb(representative.delegationKnowledgeScope),
    },
  };
}

export function applyRepresentativeVersionSnapshot(
  current: RepresentativeSetupSnapshot,
  value: unknown,
): RepresentativeSetupSnapshot {
  const snapshot = asJsonRecord(value);
  if (!snapshot) return current;

  const identity = asJsonRecord(snapshot.identity);
  const conversation = asJsonRecord(snapshot.conversation);
  const governance = asJsonRecord(snapshot.governance);
  const delegation = asJsonRecord(snapshot.delegation);
  const knowledge = asJsonRecord(snapshot.knowledge);
  const parsedContract = conversationContractSchema.safeParse(conversation);
  const parsedPricing = parseSnapshotPricing(snapshot.pricing);
  const parsedGroupActivation = groupActivationSchema.safeParse(snapshot.groupActivation);
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
    : [];

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
    humanInLoop:
      typeof snapshot.humanInLoop === "boolean" ? snapshot.humanInLoop : current.humanInLoop,
    skills: parsedSkills.length ? parsedSkills : current.skills,
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
    contract: parsedContract.success ? parsedContract.data : current.contract,
    pricing: parsedPricing.length === 4 ? parsedPricing : current.pricing,
    handoffPrompt:
      readSnapshotString(conversation?.handoffPrompt) ?? current.handoffPrompt,
    actionGate: governance?.actionGate
      ? parseActionGate(governance.actionGate as Prisma.JsonValue)
      : current.actionGate,
    delegation: {
      ...current.delegation,
      enabled:
        typeof delegation?.enabled === "boolean"
          ? delegation.enabled
          : current.delegation.enabled,
      naturalLanguageEnabled:
        typeof delegation?.naturalLanguageEnabled === "boolean"
          ? delegation.naturalLanguageEnabled
          : current.delegation.naturalLanguageEnabled,
      explicitComputeEnabled:
        typeof delegation?.explicitComputeEnabled === "boolean"
          ? delegation.explicitComputeEnabled
          : current.delegation.explicitComputeEnabled,
      knowledgeScope:
        delegation?.knowledgeScope === "public_knowledge" ||
        delegation?.knowledgeScope === "user_input_only"
          ? delegation.knowledgeScope
          : current.delegation.knowledgeScope,
    },
  };
}

function parseSnapshotPricing(value: unknown): PricingPlan[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((rawPlan) => {
    const canonical = pricingPlanSchema.safeParse(rawPlan);
    if (canonical.success) return [canonical.data];

    // Versions published before the canonical domain snapshot used Prisma's
    // field names. Continue to honor those immutable historical versions.
    const legacy = asJsonRecord(rawPlan);
    const rawTier = readSnapshotString(legacy?.type)?.toLowerCase();
    const tier = rawTier === "free" || rawTier === "pass" || rawTier === "deep_help" || rawTier === "sponsor"
      ? rawTier
      : undefined;
    const parsedLegacy = pricingPlanSchema.safeParse({
      tier,
      name: legacy?.name,
      stars: legacy?.starsAmount,
      summary: legacy?.summary,
      includedReplies: legacy?.includedReplies,
      includesPriorityHandoff: legacy?.includesPriorityHandoff,
    });
    return parsedLegacy.success ? [parsedLegacy.data] : [];
  });
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
      ownerName: demoRepresentative.ownerName,
      name: demoRepresentative.name,
      tagline: demoRepresentative.tagline,
      tone: demoRepresentative.tone,
      languages: [...demoRepresentative.languages],
      groupActivation: demoRepresentative.groupActivation,
      publicMode: true,
      humanInLoop: true,
      skills: [...demoRepresentative.skills],
      knowledgePack: {
        identitySummary: demoRepresentative.knowledgePack.identitySummary,
        faq: demoRepresentative.knowledgePack.faq.map((item) => ({ ...item })),
        materials: demoRepresentative.knowledgePack.materials.map((item) => ({ ...item })),
        policies: demoRepresentative.knowledgePack.policies.map((item) => ({ ...item })),
      },
      contract: {
        freeReplyLimit: demoRepresentative.contract.freeReplyLimit,
        freeScope: [...demoRepresentative.contract.freeScope],
        paywalledIntents: [...demoRepresentative.contract.paywalledIntents],
        handoffWindowHours: demoRepresentative.contract.handoffWindowHours,
      },
      pricing: demoRepresentative.pricing.map((plan) => ({ ...plan })),
      handoffPrompt: demoRepresentative.handoffPrompt,
      actionGate: { ...demoRepresentative.actionGate },
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

  snapshot.ownerName = input.ownerName;
  snapshot.name = input.name;
  snapshot.tagline = input.tagline;
  snapshot.tone = input.tone;
  snapshot.languages = [...input.languages];
  snapshot.groupActivation = input.groupActivation;
  snapshot.publicMode = input.publicMode;
  snapshot.humanInLoop = input.humanInLoop;
  snapshot.contract = {
    freeReplyLimit: input.contract.freeReplyLimit,
    freeScope: [...input.contract.freeScope],
    paywalledIntents: [...input.contract.paywalledIntents],
    handoffWindowHours: input.contract.handoffWindowHours,
  };
  snapshot.handoffPrompt = input.handoffPrompt;
  snapshot.actionGate = { ...input.actionGate };
  snapshot.pricing = input.pricing.map((plan) => ({ ...plan }));
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
    knowledgePack: {
      identitySummary: snapshot.knowledgePack.identitySummary,
      faq: snapshot.knowledgePack.faq.map((item) => ({ ...item })),
      materials: snapshot.knowledgePack.materials.map((item) => ({ ...item })),
      policies: snapshot.knowledgePack.policies.map((item) => ({ ...item })),
    },
    contract: {
      freeReplyLimit: snapshot.contract.freeReplyLimit,
      freeScope: [...snapshot.contract.freeScope],
      paywalledIntents: [...snapshot.contract.paywalledIntents],
      handoffWindowHours: snapshot.contract.handoffWindowHours,
    },
    pricing: snapshot.pricing.map((plan) => ({ ...plan })),
    actionGate: { ...snapshot.actionGate },
    compute: cloneComputeSetup(snapshot.compute),
    delegation: { ...snapshot.delegation },
  };
}

function applyDemoTrainingOverlay(
  snapshot: RepresentativeSetupSnapshot,
  representativeSlug: string,
): RepresentativeSetupSnapshot {
  const overlay = getDemoCreatorTrainingKnowledgeOverlay(representativeSlug);
  if (!overlay) {
    return snapshot;
  }

  return {
    ...snapshot,
    knowledgePack: {
      identitySummary: overlay.identitySummary || snapshot.knowledgePack.identitySummary,
      faq: normalizeOverlayKnowledgeDocuments(overlay.faq, "faq"),
      materials: normalizeOverlayKnowledgeDocuments(overlay.materials, "download"),
      policies: normalizeOverlayKnowledgeDocuments(overlay.policies, "policy"),
    },
  };
}

function normalizeOverlayKnowledgeDocuments(
  value: unknown[],
  fallbackKind: KnowledgeDocument["kind"],
): KnowledgeDocument[] {
  const documents: KnowledgeDocument[] = [];

  value.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return;
    }
    const record = item as Record<string, unknown>;
    const title =
      typeof record.title === "string" && record.title.trim()
        ? record.title.trim()
        : `Training item ${index + 1}`;
    const summary =
      typeof record.summary === "string" && record.summary.trim()
        ? normalizeUploadedKnowledgeSummary(record.summary)
        : title;
    const id =
      typeof record.id === "string" && record.id.trim()
        ? record.id.trim()
        : `training_overlay_${index + 1}`;
    const kind = normalizeKnowledgeKind(record.kind, fallbackKind);
    const url = typeof record.url === "string" && record.url.trim() ? record.url.trim() : undefined;

    documents.push({
      id,
      title,
      kind,
      summary,
      ...(url ? { url } : {}),
    });
  });

  return documents;
}

function normalizeUploadedKnowledgeSummary(value: string): string {
  const lines = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const inlineStripped = stripInlineUploadKnowledgePreamble(lines.join(" "));
  if (inlineStripped) {
    return inlineStripped;
  }
  const extractedTextIndex = lines.findIndex((line) => line.toLowerCase() === "extracted text:");
  const contentLines = extractedTextIndex >= 0 ? lines.slice(extractedTextIndex + 1) : lines;

  return (
    contentLines
      .filter((line) => !/^uploaded file:/i.test(line))
      .filter((line) => !/^mime type:/i.test(line))
      .filter((line) => !/^extraction note:/i.test(line))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim() || value.trim()
  );
}

function stripInlineUploadKnowledgePreamble(value: string): string {
  const stripped = value
    .replace(/^uploaded file:\s+\S+(?:\s+mime type:\s+\S+)?\s*/i, "")
    .replace(/\bextracted text:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped === value.trim() ? "" : stripped;
}

function normalizeKnowledgeKind(
  value: unknown,
  fallbackKind: KnowledgeDocument["kind"],
): KnowledgeDocument["kind"] {
  if (
    value === "bio" ||
    value === "faq" ||
    value === "policy" ||
    value === "pricing" ||
    value === "case_study" ||
    value === "deck" ||
    value === "calendar" ||
    value === "download"
  ) {
    return value;
  }
  return fallbackKind;
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
}): Omit<RepresentativeSetupSnapshot, "id" | "slug"> {
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
    skills: [...demoRepresentative.skills],
    knowledgePack: {
      identitySummary: `${safeOwnerName} 的公开业务代表，适合先处理 FAQ、合作意向、报价请求和预约入口。你可以继续在 dashboard 里补充更具体的公开材料。`,
      faq: [],
      materials: [],
      policies: [],
    },
    contract: {
      freeReplyLimit: demoRepresentative.contract.freeReplyLimit,
      freeScope: [...demoRepresentative.contract.freeScope],
      paywalledIntents: [...demoRepresentative.contract.paywalledIntents],
      handoffWindowHours: demoRepresentative.contract.handoffWindowHours,
    },
    pricing: demoRepresentative.pricing.map((plan) => ({ ...plan })),
    handoffPrompt: `${safeOwnerName} 的真人评估入口已经开启。请留下你的身份、需求摘要、预算区间、目标时间，以及为什么需要真人接手。`,
    actionGate: { ...demoRepresentative.actionGate },
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
        requiredPlanTier: CapabilityPlanTier.PASS,
        priority: 208,
        requiresPaidPlan: true,
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
        requiredPlanTier: CapabilityPlanTier.PASS,
        priority: 155,
        requiresPaidPlan: true,
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
        requiredPlanTier: CapabilityPlanTier.PASS,
        priority: 165,
        requiresPaidPlan: true,
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

function mergePricingPlans(plans: Array<RepresentativeSetupRecord["pricingPlans"][number]>): PricingPlan[] {
  const plansByTier = new Map<PricingPlan["tier"], PricingPlan>();

  for (const plan of plans) {
    const tier = mapPricingPlanTypeFromDb(plan.type);
    plansByTier.set(tier, {
      tier,
      name: plan.name,
      stars: plan.starsAmount,
      summary: plan.summary,
      includedReplies: plan.includedReplies,
      includesPriorityHandoff: plan.includesPriorityHandoff,
    });
  }

  return (["free", "pass", "deep_help", "sponsor"] as const).map((tier) => {
    return plansByTier.get(tier) ?? demoRepresentative.pricing.find((plan) => plan.tier === tier)!;
  });
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

function parseInquiryIntents(
  value: Prisma.JsonValue,
  fallback: InquiryIntent[],
): InquiryIntent[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const parsed = value
    .map((entry) => inquiryIntentSchema.safeParse(entry))
    .filter((entry): entry is { success: true; data: InquiryIntent } => entry.success)
    .map((entry) => entry.data);

  return parsed.length > 0 ? parsed : [...fallback];
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

function parseActionGate(value: Prisma.JsonValue): Representative["actionGate"] {
  const parsed = actionGateSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...demoRepresentative.actionGate };
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

function mapPricingPlanTypeToDb(value: PricingPlan["tier"]): PricingPlanType {
  switch (value) {
    case "pass":
      return PricingPlanType.PASS;
    case "deep_help":
      return PricingPlanType.DEEP_HELP;
    case "sponsor":
      return PricingPlanType.SPONSOR;
    case "free":
    default:
      return PricingPlanType.FREE;
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

function mapPricingPlanTypeFromDb(value: PricingPlanType): PricingPlan["tier"] {
  switch (value) {
    case PricingPlanType.PASS:
      return "pass";
    case PricingPlanType.DEEP_HELP:
      return "deep_help";
    case PricingPlanType.SPONSOR:
      return "sponsor";
    case PricingPlanType.FREE:
    default:
      return "free";
  }
}

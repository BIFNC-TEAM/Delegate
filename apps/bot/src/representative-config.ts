import {
  actionGateSchema,
  demoRepresentative,
  inquiryIntentSchema,
  knowledgeDocumentSchema,
  representativeSkillSchema,
  type InquiryIntent,
  type KnowledgeDocument,
  type Representative,
} from "@delegate/domain";
import {
  buildRepresentativeRuntimeProfile,
  getRepresentativeRuntimeSetupSnapshot,
} from "@delegate/web-data";
import {
  GroupActivation,
  PricingPlanType,
  type Prisma,
} from "@prisma/client";

import { prisma } from "./prisma";

const representativeConfigInclude = {
  owner: true,
  knowledgePack: true,
  pricingPlans: true,
} as const;

type RepresentativeConfigRecord = Prisma.RepresentativeGetPayload<{
  include: typeof representativeConfigInclude;
}>;

export async function getRepresentativeRuntimeConfig(
  representativeSlug: string,
): Promise<Representative> {
  const runtimeSetup = await getRepresentativeRuntimeSetupSnapshot(representativeSlug);
  if (runtimeSetup) {
    return buildRepresentativeRuntimeProfile(runtimeSetup);
  }
  if (process.env.DATABASE_URL?.trim()) {
    throw new Error(`Representative "${representativeSlug}" has no active published version.`);
  }

  if (shouldUseStaticFallbackMode(representativeSlug)) {
    return cloneRepresentative(demoRepresentative);
  }

  try {
    const representative = await prisma.representative.findUnique({
      where: { slug: representativeSlug },
      include: representativeConfigInclude,
    });

    if (!representative) {
      throw new Error(`Representative "${representativeSlug}" not found.`);
    }

    return serializeRepresentative(representative);
  } catch (error) {
    if (shouldUseDemoFallback(error, representativeSlug)) {
      return cloneRepresentative(demoRepresentative);
    }

    throw error;
  }
}

function serializeRepresentative(representative: RepresentativeConfigRecord): Representative {
  return {
    id: representative.id,
    slug: representative.slug,
    ownerName: representative.owner.displayName,
    name: representative.displayName,
    tagline: representative.roleSummary,
    tone: representative.tone,
    languages: parseStringArray(representative.languages, demoRepresentative.languages),
    groupActivation: mapGroupActivationFromDb(representative.groupActivation),
    skills: parseRepresentativeSkills(representative.allowedSkills),
    skillPacks: demoRepresentative.skillPacks.map((pack) => ({ ...pack })),
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
  };
}

function mergePricingPlans(plans: Array<RepresentativeConfigRecord["pricingPlans"][number]>) {
  const plansByTier = new Map<Representative["pricing"][number]["tier"], Representative["pricing"][number]>();

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

  return parsed.length > 0 ? parsed : fallback.map((item) => ({ ...item }));
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

function cloneRepresentative(representative: Representative): Representative {
  return {
    ...representative,
    languages: [...representative.languages],
    skills: [...representative.skills],
    skillPacks: representative.skillPacks.map((pack) => ({
      ...pack,
      capabilityTags: [...pack.capabilityTags],
    })),
    knowledgePack: {
      identitySummary: representative.knowledgePack.identitySummary,
      faq: representative.knowledgePack.faq.map((item) => ({ ...item })),
      materials: representative.knowledgePack.materials.map((item) => ({ ...item })),
      policies: representative.knowledgePack.policies.map((item) => ({ ...item })),
    },
    contract: {
      freeReplyLimit: representative.contract.freeReplyLimit,
      freeScope: [...representative.contract.freeScope],
      paywalledIntents: [...representative.contract.paywalledIntents],
      handoffWindowHours: representative.contract.handoffWindowHours,
    },
    pricing: representative.pricing.map((plan) => ({ ...plan })),
    actionGate: { ...representative.actionGate },
  };
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

function mapGroupActivationFromDb(value: GroupActivation): Representative["groupActivation"] {
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

function mapPricingPlanTypeFromDb(value: PricingPlanType): Representative["pricing"][number]["tier"] {
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

import {
  demoRepresentative,
  type GroupActivation as DomainGroupActivation,
  type SkillPack as DomainSkillPack,
} from "@delegate/domain";
import { fetchClawHubRepresentativeSkill } from "@delegate/registry";
import {
  GroupActivation,
  SkillPackSource,
  type Prisma,
} from "@prisma/client";

import { prisma } from "./prisma";
import {
  installClawHubSkillForWorkspace,
  setWorkspaceSkillRepresentativeBinding,
} from "./workspace-skills";

export type DashboardRepresentativeSkillPack = DomainSkillPack & {
  linkId: string;
  installedAt?: string;
};

export type RepresentativeSkillPackSnapshot = {
  representative: {
    slug: string;
    displayName: string;
    roleSummary: string;
    groupActivation: DomainGroupActivation;
    humanInLoop: boolean;
    publicMode: boolean;
  };
  skillPacks: DashboardRepresentativeSkillPack[];
};

const linkedSkillPackInclude = {
  skillPack: true,
  workspaceInstall: {
    include: {
      releases: {
        where: { status: "INSTALLED" as const },
        orderBy: { adoptedAt: "desc" as const },
        take: 1,
      },
    },
  },
} as const;
let demoFallbackSnapshot: RepresentativeSkillPackSnapshot | null = null;

type RepresentativeSkillPackWithSkillPack = Prisma.RepresentativeSkillPackGetPayload<{
  include: typeof linkedSkillPackInclude;
}>;

export async function getRepresentativeSkillPackSnapshot(
  representativeSlug: string,
): Promise<RepresentativeSkillPackSnapshot | null> {
  if (shouldUseStaticFallbackMode(representativeSlug)) {
    return cloneRepresentativeSnapshot(getOrCreateDemoFallbackSnapshot());
  }

  try {
    const representative = await prisma.representative.findUnique({
      where: { slug: representativeSlug },
      include: {
        skillPackLinks: {
          include: linkedSkillPackInclude,
          orderBy: [{ createdAt: "asc" }],
        },
      },
    });

    if (!representative) {
      return null;
    }

    return {
      representative: {
        slug: representative.slug,
        displayName: representative.displayName,
        roleSummary: representative.roleSummary,
        groupActivation: mapGroupActivationFromDb(representative.groupActivation),
        humanInLoop: representative.humanInLoop,
        publicMode: representative.publicMode,
      },
      skillPacks: representative.skillPackLinks.map((link) => serializeLinkedSkillPack(link)),
    };
  } catch (error) {
    if (shouldUseDemoFallback(error, representativeSlug)) {
      return cloneRepresentativeSnapshot(getOrCreateDemoFallbackSnapshot());
    }
    throw error;
  }
}

export async function installClawHubSkillPackForRepresentative(params: {
  representativeSlug: string;
  skillPackSlug: string;
}): Promise<DashboardRepresentativeSkillPack> {
  if (shouldUseStaticFallbackMode(params.representativeSlug)) {
    const discovered = await fetchClawHubRepresentativeSkill({ slug: params.skillPackSlug });
    if (!discovered) throw new Error(`ClawHub skill "${params.skillPackSlug}" was not found.`);
    return installClawHubSkillPackInDemoFallback(discovered);
  }

  try {
    const representative = await prisma.representative.findUnique({
      where: { slug: params.representativeSlug },
      select: {
        ownerId: true,
        skillPackLinks: {
          where: { skillPack: { source: SkillPackSource.CLAWHUB, slug: params.skillPackSlug } },
          select: { enabled: true },
          take: 1,
        },
      },
    });
    if (!representative) throw new Error(`Representative "${params.representativeSlug}" not found.`);
    const install = await installClawHubSkillForWorkspace({
      ownerId: representative.ownerId,
      activeRepresentativeSlug: params.representativeSlug,
      skillPackSlug: params.skillPackSlug,
      installedBy: representative.ownerId,
    });
    await setWorkspaceSkillRepresentativeBinding({
      ownerId: representative.ownerId,
      installId: install.installId,
      representativeSlug: params.representativeSlug,
      enabled: representative.skillPackLinks[0]?.enabled ?? false,
      changedBy: representative.ownerId,
    });
    const snapshot = await getRepresentativeSkillPackSnapshot(params.representativeSlug);
    const linked = snapshot?.skillPacks.find((pack) => pack.slug === params.skillPackSlug);
    if (!linked) throw new Error("Installed skill could not be resolved after workspace binding.");
    return linked;
  } catch (error) {
    if (shouldUseDemoFallback(error, params.representativeSlug)) {
      const discovered = await fetchClawHubRepresentativeSkill({ slug: params.skillPackSlug });
      if (!discovered) throw new Error(`ClawHub skill "${params.skillPackSlug}" was not found.`);
      return installClawHubSkillPackInDemoFallback(discovered);
    }
    throw error;
  }
}

export async function setRepresentativeSkillPackEnabled(params: {
  representativeSlug: string;
  linkId: string;
  enabled: boolean;
}): Promise<DashboardRepresentativeSkillPack> {
  if (shouldUseStaticFallbackMode(params.representativeSlug)) {
    return setDemoFallbackSkillPackEnabled(params.linkId, params.enabled);
  }

  try {
    const link = await prisma.representativeSkillPack.findFirst({
      where: {
        id: params.linkId,
        representative: {
          slug: params.representativeSlug,
        },
      },
      include: linkedSkillPackInclude,
    });

    if (!link) {
      throw new Error("Representative skill pack link not found.");
    }

    if (!link.workspaceInstallId) {
      throw new Error("Install this skill into the workspace before enabling it for a representative.");
    }
    await setWorkspaceSkillRepresentativeBinding({
      installId: link.workspaceInstallId,
      representativeSlug: params.representativeSlug,
      enabled: params.enabled,
    });
    const snapshot = await getRepresentativeSkillPackSnapshot(params.representativeSlug);
    const updated = snapshot?.skillPacks.find((pack) => pack.linkId === link.id);
    if (!updated) throw new Error("Representative skill binding could not be resolved after update.");
    return updated;
  } catch (error) {
    if (shouldUseDemoFallback(error, params.representativeSlug)) {
      return setDemoFallbackSkillPackEnabled(params.linkId, params.enabled);
    }
    throw error;
  }
}

function serializeLinkedSkillPack(
  link: RepresentativeSkillPackWithSkillPack,
): DashboardRepresentativeSkillPack {
  const release = link.workspaceInstall?.releases[0];
  return {
    linkId: link.id,
    id: link.skillPack.id,
    slug: link.skillPack.slug,
    displayName: release?.displayName ?? link.skillPack.displayName,
    source: mapSkillPackSourceFromDb(link.skillPack.source),
    summary: release?.summary ?? link.skillPack.summary,
    ...(release?.version ?? link.skillPack.version ? { version: release?.version ?? link.skillPack.version ?? undefined } : {}),
    ...(release?.sourceUrl ?? link.skillPack.sourceUrl ? { sourceUrl: release?.sourceUrl ?? link.skillPack.sourceUrl ?? undefined } : {}),
    ...(release?.ownerHandle ?? link.skillPack.ownerHandle ? { ownerHandle: release?.ownerHandle ?? link.skillPack.ownerHandle ?? undefined } : {}),
    ...(release?.verificationTier ?? link.skillPack.verificationTier
      ? { verificationTier: release?.verificationTier ?? link.skillPack.verificationTier ?? undefined }
      : {}),
    capabilityTags: parseCapabilityTags(release?.capabilityTags ?? link.skillPack.capabilityTags),
    executesCode: release?.executesCode ?? link.skillPack.executesCode,
    enabled: link.enabled,
    installStatus: normalizeInstallStatus(link.installStatus),
    ...(link.installedVersion ? { version: link.installedVersion } : {}),
    ...(link.installedAt ? { installedAt: link.installedAt.toISOString() } : {}),
  };
}

function getOrCreateDemoFallbackSnapshot(): RepresentativeSkillPackSnapshot {
  if (!demoFallbackSnapshot) {
    demoFallbackSnapshot = {
      representative: {
        slug: demoRepresentative.slug,
        displayName: demoRepresentative.name,
        roleSummary: demoRepresentative.tagline,
        groupActivation: demoRepresentative.groupActivation,
        humanInLoop: true,
        publicMode: true,
      },
      skillPacks: demoRepresentative.skillPacks.map((pack, index) => ({
        linkId: buildDemoFallbackLinkId(pack.slug, index),
        ...pack,
        ...(pack.installStatus === "available" ? {} : { installedAt: new Date().toISOString() }),
      })),
    };
  }

  return demoFallbackSnapshot;
}

function installClawHubSkillPackInDemoFallback(
  discovered: DomainSkillPack,
): DashboardRepresentativeSkillPack {
  const state = getOrCreateDemoFallbackSnapshot();
  const existing = state.skillPacks.find(
    (skillPack) =>
      skillPack.source === discovered.source && skillPack.slug === discovered.slug,
  );
  const installedAt = new Date().toISOString();

  if (existing) {
    existing.displayName = discovered.displayName;
    existing.summary = discovered.summary;
    existing.version = discovered.version;
    existing.sourceUrl = discovered.sourceUrl;
    existing.ownerHandle = discovered.ownerHandle;
    existing.verificationTier = discovered.verificationTier;
    existing.capabilityTags = [...discovered.capabilityTags];
    existing.executesCode = discovered.executesCode;
    existing.installStatus = "installed";
    existing.installedAt = existing.installedAt ?? installedAt;
    return cloneDashboardSkillPack(existing);
  }

  const installed: DashboardRepresentativeSkillPack = {
    linkId: buildDemoFallbackLinkId(discovered.slug, state.skillPacks.length),
    ...discovered,
    enabled: false,
    installStatus: "installed",
    installedAt,
  };

  state.skillPacks.push(installed);
  return cloneDashboardSkillPack(installed);
}

function setDemoFallbackSkillPackEnabled(
  linkId: string,
  enabled: boolean,
): DashboardRepresentativeSkillPack {
  const state = getOrCreateDemoFallbackSnapshot();
  const skillPack = state.skillPacks.find((entry) => entry.linkId === linkId);

  if (!skillPack) {
    throw new Error("Representative skill pack link not found.");
  }

  skillPack.enabled = enabled;
  skillPack.installStatus =
    skillPack.installStatus === "available" ? "installed" : skillPack.installStatus;
  skillPack.installedAt = skillPack.installedAt ?? new Date().toISOString();

  return cloneDashboardSkillPack(skillPack);
}

function cloneRepresentativeSnapshot(
  snapshot: RepresentativeSkillPackSnapshot,
): RepresentativeSkillPackSnapshot {
  return {
    representative: { ...snapshot.representative },
    skillPacks: snapshot.skillPacks.map((skillPack) => cloneDashboardSkillPack(skillPack)),
  };
}

function cloneDashboardSkillPack(
  skillPack: DashboardRepresentativeSkillPack,
): DashboardRepresentativeSkillPack {
  return {
    ...skillPack,
    capabilityTags: [...skillPack.capabilityTags],
  };
}

function buildDemoFallbackLinkId(skillPackSlug: string, index: number): string {
  return `demo:${skillPackSlug}:${index}`;
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

function parseCapabilityTags(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
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

function mapSkillPackSourceToDb(value: DomainSkillPack["source"]): SkillPackSource {
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

function mapSkillPackSourceFromDb(value: SkillPackSource): DomainSkillPack["source"] {
  switch (value) {
    case SkillPackSource.CLAWHUB:
      return "clawhub";
    case SkillPackSource.OWNER_UPLOAD:
      return "owner_upload";
    case SkillPackSource.BUILTIN:
    default:
      return "builtin";
  }
}

function normalizeInstallStatus(value: string): DomainSkillPack["installStatus"] {
  if (value === "installed" || value === "update_available") {
    return value;
  }
  return "available";
}

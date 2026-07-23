import { createHash, verify as verifyCryptographicSignature } from "node:crypto";

import { demoRepresentative, type RepresentativeSkill } from "@delegate/domain";
import {
  fetchClawHubRepresentativeSkill,
  fetchClawHubRepresentativeSkillVersionTrust,
  type ClawHubRegistryTrust,
  type ClawHubRuntimeRequirements,
} from "@delegate/registry";
import {
  EventType,
  SkillPackSource,
  WorkspaceSkillInstallStatus,
  WorkspaceSkillSignatureStatus,
  WorkspaceSkillUpdatePolicy,
  WorkspaceSkillReleaseStatus,
  WorkspaceSkillReviewStatus,
  Prisma,
} from "@prisma/client";

import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";

export type WorkspaceSkillRisk = "low" | "medium" | "high";

export class WorkspaceSkillOperationError extends Error {
  readonly code: string;
  readonly statusCode: 404 | 409 | 422 | 503;
  readonly publicMessage: string;

  constructor(input: {
    code: string;
    message: string;
    statusCode: 404 | 409 | 422 | 503;
    publicMessage?: string;
  }) {
    super(input.message);
    this.name = "WorkspaceSkillOperationError";
    this.code = input.code;
    this.statusCode = input.statusCode;
    this.publicMessage = input.publicMessage ?? input.message;
  }
}

function workspaceSkillNotFound(message: string): WorkspaceSkillOperationError {
  return new WorkspaceSkillOperationError({
    code: "workspace_skill_not_found",
    message,
    statusCode: 404,
  });
}

function workspaceSkillConflict(message: string): WorkspaceSkillOperationError {
  return new WorkspaceSkillOperationError({
    code: "workspace_skill_conflict",
    message,
    statusCode: 409,
  });
}

function workspaceSkillRejected(
  message: string,
  publicMessage = message,
): WorkspaceSkillOperationError {
  return new WorkspaceSkillOperationError({
    code: "workspace_skill_rejected",
    message,
    publicMessage,
    statusCode: 422,
  });
}

function workspaceSkillRegistryUnavailable(
  message: string,
): WorkspaceSkillOperationError {
  return new WorkspaceSkillOperationError({
    code: "workspace_skill_registry_unavailable",
    message,
    publicMessage:
      "The Registry trust check is temporarily unavailable. The workspace skill was not changed.",
    statusCode: 503,
  });
}

export const defaultClawHubTrustMaxAgeMs = 24 * 60 * 60 * 1000;
const clawHubTrustFutureSkewMs = 5 * 60 * 1000;

export function isWorkspaceSkillReleaseRuntimeTrusted(input: {
  source: SkillPackSource | string;
  executesCode: boolean;
  registryTrustEligible?: boolean | null | undefined;
  signatureStatus?: WorkspaceSkillSignatureStatus | string | null | undefined;
}): boolean {
  if (input.executesCode) return false;
  const source = String(input.source).trim().toUpperCase();
  if (source !== SkillPackSource.CLAWHUB) return true;
  const signatureStatus = String(input.signatureStatus ?? "").trim().toUpperCase();
  return input.registryTrustEligible === true
    || signatureStatus === WorkspaceSkillSignatureStatus.VERIFIED;
}

export function shouldDisableWorkspaceSkillBindingsAfterAdoption(input: {
  source: SkillPackSource | string;
  executesCode: boolean;
  registryTrustEligible?: boolean | null | undefined;
  signatureStatus?: WorkspaceSkillSignatureStatus | string | null | undefined;
}): boolean {
  return !isWorkspaceSkillReleaseRuntimeTrusted(input);
}

export type WorkspaceSkillSnapshot = {
  workspace: {
    ownerId: string;
    representativeCount: number;
  };
  activeRepresentative: {
    slug: string;
    displayName: string;
    declaredOutcomes: RepresentativeSkill[];
    computeEnabled: boolean;
  };
  metrics: {
    installed: number;
    enabledBindings: number;
    approvalProtected: number;
    updates: number;
    unhealthyConnections: number;
  };
  representatives: Array<{
    id: string;
    slug: string;
    displayName: string;
  }>;
  skills: Array<{
    installId: string;
    skillPackId: string;
    slug: string;
    displayName: string;
    summary: string;
    source: "builtin" | "owner_upload" | "clawhub";
    installedVersion: string | null;
    latestVersion: string | null;
    installedAt: string;
    sourceUrl: string | null;
    ownerHandle: string | null;
    verificationTier: string | null;
    capabilityTags: string[];
    requirements: Array<"exec" | "read" | "write" | "process" | "browser" | "mcp">;
    risk: WorkspaceSkillRisk;
    executesCode: boolean;
    status: "installed" | "update_available" | "archived";
    reviewStatus: "approved" | "needs_review" | "rejected";
    updatePolicy: "manual" | "review_required" | "patch_auto";
    readiness: "ready" | "needs_setup" | "blocked";
    readinessReason: string;
    recentCalls: Array<{
      id: string;
      representativeName: string;
      capability: string;
      toolName: string | null;
      status: string;
      durationMs: number | null;
      createdAt: string;
    }>;
    releases: Array<{
      id: string;
      version: string;
      status: "installed" | "candidate" | "superseded" | "rejected";
      summary: string;
      displayName: string;
      capabilityTags: string[];
      executesCode: boolean;
      provenanceDigest: string | null;
      signatureStatus: "unavailable" | "unverified" | "verified" | "invalid";
      signatureAlgorithm: string | null;
      signatureKeyId: string | null;
      sbomUrl: string | null;
      attestationUrl: string | null;
      registryTrust: {
        source: string;
        verified: boolean;
        autoUpdateEligible: boolean;
        decision: string;
        securityStatus: string;
        exactVersionMatch: boolean;
        exactPublisherMatch: boolean;
        skillManifestFetched: boolean;
        skillManifestParsed: boolean;
        skillManifestDigest: string | null;
        reasons: string[];
        checkedAt: number | null;
      } | null;
      runtimeRequirements: ClawHubRuntimeRequirements | null;
      runtimeRequirementDiff: {
        added: string[];
        removed: string[];
        changed: boolean;
      };
      permissionDiff: {
        added: Array<"exec" | "read" | "write" | "process" | "browser" | "mcp">;
        removed: Array<"exec" | "read" | "write" | "process" | "browser" | "mcp">;
      };
      autoUpdate: { eligible: boolean; reason: string };
      reviewedBy: string | null;
      reviewedAt: string | null;
      reviewNote: string | null;
      discoveredAt: string;
      adoptedAt: string | null;
    }>;
    impact: {
      enabledBindings: number;
      publishedRepresentatives: Array<{ slug: string; displayName: string; versionNumber: number }>;
    };
    bindings: Array<{
      linkId: string;
      representativeId: string;
      representativeSlug: string;
      representativeName: string;
      enabled: boolean;
      ready: boolean;
      issue: string | null;
    }>;
  }>;
  connections: Array<{
    id: string;
    representativeSlug: string;
    representativeName: string;
    displayName: string;
    transportKind: "streamable_http" | "sse";
    enabled: boolean;
    approvalRequired: boolean;
    allowedToolNames: string[];
    sourceSkillPack: string | null;
    health: "healthy" | "degraded" | "unverified" | "disabled";
    healthDetail: string;
  }>;
  policy: {
    defaultDecision: "allow" | "ask" | "deny";
    networkMode: "no_network" | "allowlist" | "full";
    filesystemMode: "workspace_only" | "read_only_workspace" | "ephemeral_full";
    capabilityModes: Record<"exec" | "read" | "write" | "process" | "browser" | "mcp", "allow" | "ask" | "deny">;
  };
  auditEvents: Array<{
    id: string;
    type: string;
    representativeSlug: string;
    representativeName: string;
    skillSlug: string | null;
    version: string | null;
    actor: string | null;
    createdAt: string;
  }>;
};

const capabilityNames = ["exec", "read", "write", "process", "browser", "mcp"] as const;
type CapabilityName = (typeof capabilityNames)[number];

type WorkspaceSkillLifecycleState = {
  status: WorkspaceSkillInstallStatus;
  reviewStatus: WorkspaceSkillReviewStatus;
};

export function resolveWorkspaceSkillInstallState(input: {
  archived: boolean;
  releaseStatuses: WorkspaceSkillReleaseStatus[];
}): WorkspaceSkillLifecycleState {
  if (input.archived) {
    return {
      status: WorkspaceSkillInstallStatus.ARCHIVED,
      reviewStatus: WorkspaceSkillReviewStatus.APPROVED,
    };
  }
  const hasCandidate = input.releaseStatuses.includes(WorkspaceSkillReleaseStatus.CANDIDATE);
  return {
    status: hasCandidate
      ? WorkspaceSkillInstallStatus.UPDATE_AVAILABLE
      : WorkspaceSkillInstallStatus.INSTALLED,
    reviewStatus: hasCandidate
      ? WorkspaceSkillReviewStatus.NEEDS_REVIEW
      : WorkspaceSkillReviewStatus.APPROVED,
  };
}

export function resolveDiscoveredWorkspaceSkillReleaseStatus(input: {
  installedVersion: string | null;
  discoveredVersion: string;
  existingStatus?: WorkspaceSkillReleaseStatus | null;
}): WorkspaceSkillReleaseStatus {
  if (!input.installedVersion || input.discoveredVersion === input.installedVersion) {
    return WorkspaceSkillReleaseStatus.INSTALLED;
  }
  if (
    input.existingStatus === WorkspaceSkillReleaseStatus.REJECTED
    || input.existingStatus === WorkspaceSkillReleaseStatus.SUPERSEDED
  ) {
    return input.existingStatus;
  }
  const comparison = compareSemanticVersions(input.discoveredVersion, input.installedVersion);
  if (comparison !== null && comparison < 0) {
    return WorkspaceSkillReleaseStatus.SUPERSEDED;
  }
  if (input.existingStatus === WorkspaceSkillReleaseStatus.CANDIDATE) {
    return WorkspaceSkillReleaseStatus.CANDIDATE;
  }
  return WorkspaceSkillReleaseStatus.CANDIDATE;
}

export function shouldCloseWorkspaceSkillCandidateAfterAdoption(
  candidateVersion: string,
  adoptedVersion: string,
) {
  const comparison = compareSemanticVersions(candidateVersion, adoptedVersion);
  return comparison !== null && comparison <= 0;
}

export function isWorkspaceSkillAutoAdoptionAlreadyApplied(input: {
  requireAutoEligibility?: boolean | undefined;
  action: "adopt" | "reject" | "rollback";
  requestedReleaseId: string;
  requestedReleaseStatus: WorkspaceSkillReleaseStatus | string;
  requestedVersion: string;
  installedReleaseId: string | null;
  installedVersion: string | null;
}) {
  return input.requireAutoEligibility === true
    && input.action === "adopt"
    && String(input.requestedReleaseStatus).toUpperCase() === WorkspaceSkillReleaseStatus.INSTALLED
    && input.installedReleaseId === input.requestedReleaseId
    && input.installedVersion === input.requestedVersion;
}

const workspaceSkillInclude = {
  skillPack: true,
  representativeBindings: {
    include: {
      representative: {
        select: {
          id: true,
          slug: true,
          displayName: true,
          activeVersion: { select: { versionNumber: true, snapshot: true } },
        },
      },
      mcpBindings: { select: { id: true, enabled: true } },
    },
    orderBy: [{ createdAt: "asc" }],
  },
  releases: { orderBy: [{ discoveredAt: "desc" }] },
} satisfies Prisma.WorkspaceSkillInstallInclude;

const skillAuditEventTypes = [
  EventType.SKILL_INSTALLED,
  EventType.SKILL_BINDING_CHANGED,
  EventType.SKILL_UPDATE_DISCOVERED,
  EventType.SKILL_VERSION_ADOPTED,
  EventType.SKILL_VERSION_REJECTED,
  EventType.SKILL_VERSION_ROLLED_BACK,
  EventType.SKILL_ARCHIVED,
  EventType.SKILL_RESTORED,
  EventType.SKILL_UPDATE_POLICY_CHANGED,
] as const;

type WorkspaceSkillRecord = Prisma.WorkspaceSkillInstallGetPayload<{
  include: typeof workspaceSkillInclude;
}>;

let demoInstalls: WorkspaceSkillSnapshot["skills"] | null = null;

export async function getWorkspaceSkillSnapshot(input: {
  ownerId?: string | null;
  activeRepresentativeSlug: string;
}): Promise<WorkspaceSkillSnapshot | null> {
  if (!process.env.DATABASE_URL?.trim()) return getDemoWorkspaceSkillSnapshot(input.activeRepresentativeSlug);

  const activeRepresentative = await prisma.representative.findFirst({
    where: {
      slug: input.activeRepresentativeSlug,
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    },
    select: { ownerId: true },
  });
  if (!activeRepresentative) return null;

  const ownerId = input.ownerId?.trim() || activeRepresentative.ownerId;
  const [representatives, installs, auditEvents, toolExecutions] = await Promise.all([
    prisma.representative.findMany({
      where: { ownerId },
      orderBy: [{ createdAt: "asc" }],
      include: {
        capabilityProfiles: {
          where: { managedScope: "REPRESENTATIVE_DEFAULT", enabled: true },
          orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
          take: 1,
          include: { rules: { orderBy: [{ priority: "desc" }] } },
        },
        mcpBindings: {
          include: {
            representativeSkillPackLink: { include: { skillPack: true } },
          },
          orderBy: [{ createdAt: "asc" }],
        },
      },
    }),
    prisma.workspaceSkillInstall.findMany({
      where: { ownerId },
      include: workspaceSkillInclude,
      orderBy: [{ updatedAt: "desc" }],
    }),
    prisma.eventAudit.findMany({
      where: {
        representative: { ownerId },
        type: { in: [...skillAuditEventTypes] },
      },
      include: { representative: { select: { slug: true, displayName: true } } },
      orderBy: [{ createdAt: "desc" }],
      take: 100,
    }),
    prisma.toolExecution.findMany({
      where: {
        mcpBinding: {
          representativeSkillPackLink: {
            workspaceInstall: { ownerId },
          },
        },
      },
      select: {
        id: true,
        capability: true,
        status: true,
        requestPayload: true,
        wallMs: true,
        createdAt: true,
        mcpBinding: {
          select: {
            representativeSkillPackLink: {
              select: {
                workspaceInstallId: true,
                representative: { select: { displayName: true } },
              },
            },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }],
      take: 100,
    }),
  ]);
  const active = representatives.find((representative) => representative.slug === input.activeRepresentativeSlug);
  if (!active) return null;

  const recentCallsByInstall = new Map<string, WorkspaceSkillSnapshot["skills"][number]["recentCalls"]>();
  for (const execution of toolExecutions) {
    const link = execution.mcpBinding?.representativeSkillPackLink;
    if (!link?.workspaceInstallId) continue;
    const calls = recentCallsByInstall.get(link.workspaceInstallId) ?? [];
    if (calls.length >= 20) continue;
    const requestPayload = asRecord(execution.requestPayload);
    calls.push({
      id: execution.id,
      representativeName: link.representative.displayName,
      capability: execution.capability.toLowerCase(),
      toolName: readString(requestPayload?.toolName),
      status: execution.status.toLowerCase(),
      durationMs: execution.wallMs,
      createdAt: execution.createdAt.toISOString(),
    });
    recentCallsByInstall.set(link.workspaceInstallId, calls);
  }
  const skills = installs.map((install) =>
    serializeWorkspaceSkill(install, recentCallsByInstall.get(install.id) ?? []),
  );
  const connections = representatives.flatMap((representative) =>
    representative.mcpBindings.map((binding) => {
      const health = resolveConnectionHealth(binding);
      return {
        id: binding.id,
        representativeSlug: representative.slug,
        representativeName: representative.displayName,
        displayName: binding.displayName,
        transportKind: binding.transportKind.toLowerCase() as "streamable_http" | "sse",
        enabled: binding.enabled,
        approvalRequired: binding.approvalRequired,
        allowedToolNames: parseStringArray(binding.allowedToolNames),
        sourceSkillPack: binding.representativeSkillPackLink?.skillPack.displayName ?? null,
        health: health.status,
        healthDetail: health.detail,
      };
    }),
  );
  const policy = serializePolicy(active);

  return {
    workspace: { ownerId, representativeCount: representatives.length },
    activeRepresentative: {
      slug: active.slug,
      displayName: active.displayName,
      declaredOutcomes: parseDeclaredOutcomes(active.allowedSkills),
      computeEnabled: active.computeEnabled,
    },
    metrics: {
      installed: skills.filter((skill) => skill.status !== "archived").length,
      enabledBindings: skills.reduce(
        (total, skill) => total + skill.bindings.filter((binding) => binding.enabled).length,
        0,
      ),
      approvalProtected: Object.values(policy.capabilityModes).filter((mode) => mode === "ask").length,
      updates: skills.filter((skill) => skill.status === "update_available").length,
      unhealthyConnections: connections.filter((connection) => connection.health === "degraded").length,
    },
    representatives: representatives.map((representative) => ({
      id: representative.id,
      slug: representative.slug,
      displayName: representative.displayName,
    })),
    skills,
    connections,
    policy,
    auditEvents: auditEvents.map((event) => {
      const payload = asRecord(event.payload);
      return {
        id: event.id,
        type: event.type.toLowerCase(),
        representativeSlug: event.representative.slug,
        representativeName: event.representative.displayName,
        skillSlug: readString(payload?.slug),
        version: readString(payload?.version) ?? readString(payload?.installedVersion),
        actor: readString(payload?.changedBy) ?? readString(payload?.reviewedBy) ?? readString(payload?.installedBy),
        createdAt: event.createdAt.toISOString(),
      };
    }),
  };
}

export async function installClawHubSkillForWorkspace(input: {
  ownerId?: string | null;
  activeRepresentativeSlug: string;
  skillPackSlug: string;
  installedBy?: string;
}): Promise<{ installId: string; status: "installed" | "update_available" }> {
  const discovered = await fetchClawHubRepresentativeSkill({ slug: input.skillPackSlug });
  if (!discovered) {
    throw workspaceSkillNotFound(
      `ClawHub skill "${input.skillPackSlug}" was not found.`,
    );
  }
  if (discovered.executesCode) {
    throw workspaceSkillRejected(
      "Executable registry packages cannot be installed into Delegate.",
    );
  }
  const discoveredVersion = discovered.version?.trim() || "unversioned";
  const provenanceDigest = buildSkillReleaseDigest({
    ...discovered,
    manifestDigest: discovered.registryTrust.skillManifestDigest,
  });
  const registryProvenance = discovered.registryProvenance;
  const registryTrustEvidence = serializeRegistryTrustEvidence(discovered.registryTrust);
  const runtimeRequirements = serializeRuntimeRequirements(discovered.runtimeRequirements);
  const signatureVerification = verifyWorkspaceSkillSignature({
    provenanceDigest,
    signature: registryProvenance?.signature,
  });
  if (signatureVerification.status === WorkspaceSkillSignatureStatus.INVALID) {
    throw workspaceSkillRejected(
      "The registry release signature is invalid. The workspace installation was not changed.",
    );
  }

  if (!process.env.DATABASE_URL?.trim()) {
    const snapshot = getDemoWorkspaceSkillSnapshot(input.activeRepresentativeSlug);
    if (!snapshot) throw workspaceSkillNotFound("Representative not found.");
    const existing = snapshot.skills.find((skill) => skill.slug === discovered.slug && skill.source === "clawhub");
    if (existing) {
      if (existing.status === "archived") {
        throw workspaceSkillConflict(
          "Restore this archived workspace skill before checking for updates.",
        );
      }
      const recordedRelease = existing.releases.find((release) => release.version === discoveredVersion);
      const installedRelease = existing.releases.find((release) => release.status === "installed");
      if (!installedRelease) {
        throw workspaceSkillConflict(
          "Workspace skill state is invalid: no installed release is recorded.",
        );
      }
      const releaseStatus = resolveDiscoveredWorkspaceSkillReleaseStatus({
        installedVersion: existing.installedVersion,
        discoveredVersion,
        existingStatus: recordedRelease
          ? mapReleaseStatus(recordedRelease.status)
          : null,
      });
      if (recordedRelease) {
        if (recordedRelease.provenanceDigest !== provenanceDigest) {
          throw workspaceSkillConflict(
            "Registry metadata or manifest requirements changed without a version bump. The recorded release was preserved; wait for a new version before reviewing the update.",
          );
        }
        recordedRelease.status = releaseStatus.toLowerCase() as WorkspaceSkillSnapshot["skills"][number]["releases"][number]["status"];
      } else {
        const installedRuntimeRequirements = installedRelease.runtimeRequirements;
        const runtimeRequirementDiff = diffWorkspaceSkillRuntimeRequirements(
          installedRuntimeRequirements,
          discovered.runtimeRequirements,
        );
        const installedRequirements = deriveWorkspaceSkillRequirements(installedRelease.capabilityTags);
        const candidateRequirements = deriveWorkspaceSkillRequirements(discovered.capabilityTags);
        const addedRequirements = candidateRequirements.filter(
          (requirement) => !installedRequirements.includes(requirement),
        );
        existing.releases.unshift({
          id: `demo-release:${discovered.slug}:${discoveredVersion}`,
          version: discoveredVersion,
          status: releaseStatus.toLowerCase() as WorkspaceSkillSnapshot["skills"][number]["releases"][number]["status"],
          displayName: discovered.displayName,
          summary: discovered.summary,
          capabilityTags: [...discovered.capabilityTags],
          executesCode: false,
          provenanceDigest,
          signatureStatus: signatureVerification.status.toLowerCase() as "unavailable" | "unverified" | "verified" | "invalid",
          signatureAlgorithm: registryProvenance?.signature?.algorithm ?? null,
          signatureKeyId: registryProvenance?.signature?.keyId ?? null,
          sbomUrl: registryProvenance?.sbomUrl ?? null,
          attestationUrl: registryProvenance?.attestationUrl ?? null,
          registryTrust: toWorkspaceRegistryTrust(
            discovered.registryTrust.source,
            discovered.registryTrust.verified,
            discovered.registryTrust.metadataOnlyAutoUpdateEligible,
            registryTrustEvidence,
          ),
          runtimeRequirements: discovered.runtimeRequirements,
          runtimeRequirementDiff,
          permissionDiff: {
            added: addedRequirements,
            removed: installedRequirements.filter(
              (requirement) => !candidateRequirements.includes(requirement),
            ),
          },
          autoUpdate: resolveSkillAutoUpdateEligibility({
            policy: existing.updatePolicy === "patch_auto"
              ? WorkspaceSkillUpdatePolicy.PATCH_AUTO
              : existing.updatePolicy === "manual"
                ? WorkspaceSkillUpdatePolicy.MANUAL
                : WorkspaceSkillUpdatePolicy.REVIEW_REQUIRED,
            installedVersion: installedRelease.version,
            candidateVersion: discoveredVersion,
            signatureStatus: signatureVerification.status,
            registryTrustEligible: discovered.registryTrust.metadataOnlyAutoUpdateEligible,
            addedRequirements,
            runtimeRequirementDiff,
            executesCode: false,
          }),
          reviewedBy: null,
          reviewedAt: null,
          reviewNote: null,
          discoveredAt: new Date().toISOString(),
          adoptedAt: null,
        });
      }
      const nextState = resolveWorkspaceSkillInstallState({
        archived: false,
        releaseStatuses: existing.releases.map((release) => mapReleaseStatus(release.status)),
      });
      existing.status = nextState.status.toLowerCase() as "installed" | "update_available";
      existing.reviewStatus = nextState.reviewStatus.toLowerCase() as "approved" | "needs_review";
      existing.latestVersion = existing.releases.find((release) => release.status === "candidate")?.version
        ?? existing.installedVersion;
      return { installId: existing.installId, status: existing.status === "update_available" ? "update_available" : "installed" };
    }
    assertClawHubInitialInstallTrust({
      requestedSkillReference: input.skillPackSlug,
      discoveredSkillReference: discovered.slug,
      discoveredVersion,
      discoveredOwnerHandle: discovered.ownerHandle,
      trust: discovered.registryTrust,
    });
    snapshot.skills.unshift(serializeDemoDiscoveredSkill(discovered));
    return { installId: snapshot.skills[0]!.installId, status: "installed" };
  }

  const representative = await prisma.representative.findFirst({
    where: {
      slug: input.activeRepresentativeSlug,
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    },
    select: { id: true, ownerId: true },
  });
  if (!representative) throw workspaceSkillNotFound("Representative not found.");

  const persisted = await runWithPrismaWriteConflictRetry(() => prisma.$transaction(async (tx) => {
    const skillPack = await tx.skillPack.upsert({
      where: { source_slug: { source: SkillPackSource.CLAWHUB, slug: discovered.slug } },
      create: {
        source: SkillPackSource.CLAWHUB,
        slug: discovered.slug,
        displayName: discovered.displayName,
        summary: discovered.summary,
        version: discoveredVersion,
        sourceUrl: discovered.sourceUrl ?? null,
        ownerHandle: discovered.ownerHandle ?? null,
        verificationTier: discovered.verificationTier ?? null,
        capabilityTags: discovered.capabilityTags,
        executesCode: false,
      },
      update: {
        displayName: discovered.displayName,
        summary: discovered.summary,
        version: discoveredVersion,
        sourceUrl: discovered.sourceUrl ?? null,
        ownerHandle: discovered.ownerHandle ?? null,
        verificationTier: discovered.verificationTier ?? null,
        capabilityTags: discovered.capabilityTags,
        executesCode: false,
      },
    });
    const current = await tx.workspaceSkillInstall.findUnique({
      where: { ownerId_skillPackId: { ownerId: representative.ownerId, skillPackId: skillPack.id } },
      include: {
        releases: {
          select: {
            id: true,
            version: true,
            status: true,
            displayName: true,
            summary: true,
            sourceUrl: true,
            ownerHandle: true,
            verificationTier: true,
            capabilityTags: true,
            executesCode: true,
            provenanceDigest: true,
            runtimeRequirements: true,
            registryTrustEvidence: true,
          },
        },
      },
    });
    if (current?.status === WorkspaceSkillInstallStatus.ARCHIVED) {
      throw workspaceSkillConflict(
        "Restore this archived workspace skill before checking for updates.",
      );
    }
    const currentRelease = current?.releases.find(
      (release) => release.status === WorkspaceSkillReleaseStatus.INSTALLED,
    );
    if (current && !currentRelease) {
      throw workspaceSkillConflict(
        "Workspace skill state is invalid: no installed release is recorded.",
      );
    }
    if (!current) {
      assertClawHubInitialInstallTrust({
        requestedSkillReference: input.skillPackSlug,
        discoveredSkillReference: discovered.slug,
        discoveredVersion,
        discoveredOwnerHandle: discovered.ownerHandle,
        trust: discovered.registryTrust,
      });
    }
    const existingDiscoveredRelease = current?.releases.find(
      (release) => release.version === discoveredVersion,
    );
    const currentVersion = currentRelease?.version ?? null;
    if (existingDiscoveredRelease) {
      const existingDigest = existingDiscoveredRelease.provenanceDigest ?? buildSkillReleaseDigest({
        slug: discovered.slug,
        displayName: existingDiscoveredRelease.displayName,
        summary: existingDiscoveredRelease.summary,
        version: existingDiscoveredRelease.version,
        ...(existingDiscoveredRelease.sourceUrl ? { sourceUrl: existingDiscoveredRelease.sourceUrl } : {}),
        ...(existingDiscoveredRelease.ownerHandle ? { ownerHandle: existingDiscoveredRelease.ownerHandle } : {}),
        ...(existingDiscoveredRelease.verificationTier
          ? { verificationTier: existingDiscoveredRelease.verificationTier }
          : {}),
        capabilityTags: parseStringArray(existingDiscoveredRelease.capabilityTags),
        executesCode: existingDiscoveredRelease.executesCode,
        runtimeRequirements: parseRuntimeRequirements(existingDiscoveredRelease.runtimeRequirements),
        manifestDigest: readString(
          asRecord(existingDiscoveredRelease.registryTrustEvidence)?.skillManifestDigest,
        ),
      });
      if (existingDigest !== provenanceDigest) {
        throw workspaceSkillConflict(
          "Registry metadata or manifest requirements changed without a version bump. The recorded release was preserved; wait for a new version before reviewing the update.",
        );
      }
    }
    const releaseStatus = resolveDiscoveredWorkspaceSkillReleaseStatus({
      installedVersion: currentVersion,
      discoveredVersion,
      existingStatus: existingDiscoveredRelease?.status ?? null,
    });
    const hasActionableUpdate = releaseStatus === WorkspaceSkillReleaseStatus.CANDIDATE;
    const isInitialInstall = !current;
    const closesStaleCandidate = existingDiscoveredRelease?.status === WorkspaceSkillReleaseStatus.CANDIDATE
      && releaseStatus === WorkspaceSkillReleaseStatus.SUPERSEDED;
    const reconciledAt = closesStaleCandidate ? new Date() : null;
    const install = await tx.workspaceSkillInstall.upsert({
      where: { ownerId_skillPackId: { ownerId: representative.ownerId, skillPackId: skillPack.id } },
      create: {
        ownerId: representative.ownerId,
        skillPackId: skillPack.id,
        installedVersion: discoveredVersion,
        installedBy: input.installedBy ?? representative.ownerId,
        status: WorkspaceSkillInstallStatus.INSTALLED,
        reviewStatus: WorkspaceSkillReviewStatus.APPROVED,
      },
      update: {
        installedVersion: currentVersion,
      },
    });
    const release = await tx.workspaceSkillRelease.upsert({
      where: { installId_version: { installId: install.id, version: discoveredVersion } },
      create: {
        installId: install.id,
        version: discoveredVersion,
        status: releaseStatus,
        displayName: discovered.displayName,
        summary: discovered.summary,
        sourceUrl: discovered.sourceUrl ?? null,
        ownerHandle: discovered.ownerHandle ?? null,
        verificationTier: discovered.verificationTier ?? null,
        capabilityTags: discovered.capabilityTags,
        executesCode: false,
        provenanceDigest,
        signatureStatus: signatureVerification.status,
        signatureAlgorithm: registryProvenance?.signature?.algorithm ?? null,
        signatureKeyId: registryProvenance?.signature?.keyId ?? null,
        signatureValue: registryProvenance?.signature?.value ?? null,
        sbomUrl: registryProvenance?.sbomUrl ?? null,
        attestationUrl: registryProvenance?.attestationUrl ?? null,
        registryTrustSource: discovered.registryTrust.source,
        registryVerified: discovered.registryTrust.verified,
        registryTrustEligible: discovered.registryTrust.metadataOnlyAutoUpdateEligible,
        registryTrustEvidence,
        runtimeRequirements,
        ...(releaseStatus === WorkspaceSkillReleaseStatus.INSTALLED ? { adoptedAt: new Date() } : {}),
      },
      update: {
        status: releaseStatus,
        displayName: discovered.displayName,
        summary: discovered.summary,
        sourceUrl: discovered.sourceUrl ?? null,
        ownerHandle: discovered.ownerHandle ?? null,
        verificationTier: discovered.verificationTier ?? null,
        capabilityTags: discovered.capabilityTags,
        executesCode: false,
        provenanceDigest,
        signatureStatus: signatureVerification.status,
        signatureAlgorithm: registryProvenance?.signature?.algorithm ?? null,
        signatureKeyId: registryProvenance?.signature?.keyId ?? null,
        signatureValue: registryProvenance?.signature?.value ?? null,
        sbomUrl: registryProvenance?.sbomUrl ?? null,
        attestationUrl: registryProvenance?.attestationUrl ?? null,
        registryTrustSource: discovered.registryTrust.source,
        registryVerified: discovered.registryTrust.verified,
        registryTrustEligible: discovered.registryTrust.metadataOnlyAutoUpdateEligible,
        registryTrustEvidence,
        runtimeRequirements,
        ...(reconciledAt
          ? {
              reviewedBy: "system:registry-reconciliation",
              reviewedAt: reconciledAt,
              reviewNote: `Closed because installed release v${currentVersion} is newer.`,
            }
          : {}),
      },
    });
    if (closesStaleCandidate) {
      await tx.approvalRequest.updateMany({
        where: {
          workspaceSkillReleaseId: release.id,
          status: "PENDING",
        },
        data: {
          status: "REJECTED",
          resolvedAt: reconciledAt,
          resolvedBy: "system:registry-reconciliation",
          decisionNote: `Closed because installed release v${currentVersion} is newer.`,
        },
      });
      await tx.eventAudit.create({
        data: {
          representativeId: representative.id,
          type: EventType.SKILL_VERSION_REJECTED,
          payload: {
            installId: install.id,
            releaseId: release.id,
            slug: skillPack.slug,
            version: release.version,
            installedVersion: currentVersion,
            reviewedBy: "system:registry-reconciliation",
            reviewNote: `Closed because installed release v${currentVersion} is newer.`,
          },
        },
      });
    }
    const releaseStates = await tx.workspaceSkillRelease.findMany({
      where: { installId: install.id },
      select: { version: true, status: true },
    });
    const installedRelease = releaseStates.find(
      (recordedRelease) => recordedRelease.status === WorkspaceSkillReleaseStatus.INSTALLED,
    );
    if (!installedRelease) {
      throw workspaceSkillConflict(
        "Workspace skill state is invalid: no installed release is recorded.",
      );
    }
    const lifecycle = resolveWorkspaceSkillInstallState({
      archived: false,
      releaseStatuses: releaseStates.map((recordedRelease) => recordedRelease.status),
    });
    const persistedInstall = await tx.workspaceSkillInstall.update({
      where: { id: install.id },
      data: {
        installedVersion: installedRelease.version,
        status: lifecycle.status,
        reviewStatus: lifecycle.reviewStatus,
      },
    });
    const installedRequirements = deriveWorkspaceSkillRequirements(
      parseStringArray(currentRelease?.capabilityTags ?? []),
    );
    const candidateRequirements = deriveWorkspaceSkillRequirements(discovered.capabilityTags);
    const addedRequirements = candidateRequirements.filter(
      (requirement) => !installedRequirements.includes(requirement),
    );
    const runtimeRequirementDiff = diffWorkspaceSkillRuntimeRequirements(
      parseRuntimeRequirements(currentRelease?.runtimeRequirements),
      discovered.runtimeRequirements,
    );
    const autoUpdate = releaseStatus === WorkspaceSkillReleaseStatus.REJECTED
      ? { eligible: false, reason: "This exact release was previously rejected by the workspace owner." }
      : releaseStatus !== WorkspaceSkillReleaseStatus.CANDIDATE
        ? { eligible: false, reason: "Only a newly discovered candidate release can be adopted automatically." }
      : resolveSkillAutoUpdateEligibility({
          policy: persistedInstall.updatePolicy,
          installedVersion: installedRelease.version,
          candidateVersion: discoveredVersion,
          signatureStatus: signatureVerification.status,
          registryTrustEligible: discovered.registryTrust.metadataOnlyAutoUpdateEligible,
          addedRequirements,
          runtimeRequirementDiff,
          executesCode: false,
        });
    if (hasActionableUpdate) {
      const riskSummary = [
        discovered.registryTrust.metadataOnlyAutoUpdateEligible
          ? "Official ClawHub verification and the exact-version manifest passed."
          : `Official ClawHub trust is incomplete: ${discovered.registryTrust.reasons.join(", ") || "verification unavailable"}.`,
        signatureVerification.reason,
        addedRequirements.length
          ? `Adds governed requirements: ${addedRequirements.join(", ")}.`
          : "Adds no governed runtime requirements.",
        runtimeRequirementDiff.changed
          ? `Changes manifest runtime requirements: ${formatRuntimeRequirementDiff(runtimeRequirementDiff)}.`
          : "Manifest runtime requirements are unchanged.",
        autoUpdate.reason,
      ].join(" ");
      await tx.approvalRequest.upsert({
        where: { workspaceSkillReleaseId: release.id },
        create: {
          representativeId: representative.id,
          workspaceSkillReleaseId: release.id,
          status: "PENDING",
          reason: "skill_version_update_review",
          requestedActionSummary: `Review ${discovered.displayName} v${discoveredVersion}`,
          riskSummary,
          requestPayloadHash: provenanceDigest,
          matchedPolicyRuleId: `workspace-skill:${install.updatePolicy.toLowerCase()}`,
        },
        update: {
          representativeId: representative.id,
          status: "PENDING",
          reason: "skill_version_update_review",
          requestedActionSummary: `Review ${discovered.displayName} v${discoveredVersion}`,
          riskSummary,
          requestPayloadHash: provenanceDigest,
          matchedPolicyRuleId: `workspace-skill:${install.updatePolicy.toLowerCase()}`,
          resolvedAt: null,
          resolvedBy: null,
          decisionNote: null,
        },
      });
    }
    const isNewCandidate = releaseStatus === WorkspaceSkillReleaseStatus.CANDIDATE
      && existingDiscoveredRelease?.status !== WorkspaceSkillReleaseStatus.CANDIDATE;
    if (isInitialInstall || isNewCandidate) {
      await tx.eventAudit.create({
        data: {
          representativeId: representative.id,
          type: isNewCandidate ? EventType.SKILL_UPDATE_DISCOVERED : EventType.SKILL_INSTALLED,
          payload: {
            installId: install.id,
            skillPackId: skillPack.id,
            slug: skillPack.slug,
            installedVersion: persistedInstall.installedVersion,
            latestVersion: releaseStatus === WorkspaceSkillReleaseStatus.CANDIDATE
              ? discoveredVersion
              : persistedInstall.installedVersion,
            version: discoveredVersion,
            provenanceDigest,
            signatureStatus: signatureVerification.status,
            registryTrustSource: discovered.registryTrust.source,
            registryVerified: discovered.registryTrust.verified,
            registryTrustEligible: discovered.registryTrust.metadataOnlyAutoUpdateEligible,
            autoUpdateEligible: autoUpdate.eligible,
            status: persistedInstall.status,
            source: "CLAWHUB",
            installedBy: input.installedBy ?? representative.ownerId,
          },
        },
      });
    }
    return {
      installId: install.id,
      releaseId: release.id,
      status: persistedInstall.status === WorkspaceSkillInstallStatus.UPDATE_AVAILABLE
        ? "update_available" as const
        : "installed" as const,
      autoUpdate,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  if (persisted.status === "update_available" && persisted.autoUpdate.eligible) {
    await reviewWorkspaceSkillRelease({
      ownerId: representative.ownerId,
      activeRepresentativeSlug: input.activeRepresentativeSlug,
      installId: persisted.installId,
      releaseId: persisted.releaseId,
      action: "adopt",
      reviewedBy: "system:auto-update",
      reviewNote: persisted.autoUpdate.reason,
      requireAutoEligibility: true,
    });
    const updatedInstall = await prisma.workspaceSkillInstall.findUnique({
      where: { id: persisted.installId },
      select: { status: true },
    });
    return {
      installId: persisted.installId,
      status: updatedInstall?.status === WorkspaceSkillInstallStatus.UPDATE_AVAILABLE
        ? "update_available" as const
        : "installed" as const,
    };
  }
  return { installId: persisted.installId, status: persisted.status };
}

export async function setWorkspaceSkillRepresentativeBinding(input: {
  ownerId?: string | null;
  installId: string;
  representativeSlug: string;
  enabled: boolean;
  changedBy?: string;
}) {
  if (!process.env.DATABASE_URL?.trim()) {
    const snapshot = getDemoWorkspaceSkillSnapshot(input.representativeSlug);
    const skill = snapshot?.skills.find((entry) => entry.installId === input.installId);
    if (!skill) {
      throw workspaceSkillNotFound("Workspace skill install not found.");
    }
    if (input.enabled && skill.executesCode) {
      throw workspaceSkillRejected(
        "Executable registry packages cannot be enabled.",
      );
    }
    if (
      input.enabled
      && !isWorkspaceSkillReleaseRuntimeTrusted({
        source: skill.source,
        executesCode: skill.executesCode,
        registryTrustEligible:
          skill.releases.find((release) => release.status === "installed")
            ?.registryTrust?.autoUpdateEligible ?? false,
        signatureStatus:
          skill.releases.find((release) => release.status === "installed")
            ?.signatureStatus ?? null,
      })
    ) {
      throw workspaceSkillRejected(
        "This skill release does not have sufficient runtime trust evidence and cannot be enabled.",
      );
    }
    const binding = skill.bindings.find((entry) => entry.representativeSlug === input.representativeSlug);
    if (binding) binding.enabled = input.enabled;
    else skill.bindings.push({
      linkId: `demo-binding:${skill.slug}`,
      representativeId: demoRepresentative.id,
      representativeSlug: demoRepresentative.slug,
      representativeName: demoRepresentative.name,
      enabled: input.enabled,
      ready: true,
      issue: null,
    });
    return { enabled: input.enabled };
  }

  return runWithPrismaWriteConflictRetry(() => prisma.$transaction(async (tx) => {
    const [install, representative] = await Promise.all([
      tx.workspaceSkillInstall.findFirst({
        where: { id: input.installId, ...(input.ownerId ? { ownerId: input.ownerId } : {}) },
        include: {
          skillPack: true,
          releases: {
            where: { status: WorkspaceSkillReleaseStatus.INSTALLED },
            select: {
              executesCode: true,
              registryTrustEligible: true,
              signatureStatus: true,
            },
            take: 1,
          },
        },
      }),
      tx.representative.findFirst({
        where: { slug: input.representativeSlug, ...(input.ownerId ? { ownerId: input.ownerId } : {}) },
        select: { id: true, ownerId: true },
      }),
    ]);
    if (!install || !representative || install.ownerId !== representative.ownerId) {
      throw workspaceSkillNotFound(
        "Workspace skill install or representative not found.",
      );
    }
    if (input.enabled && install.status === WorkspaceSkillInstallStatus.ARCHIVED) {
      throw workspaceSkillConflict("Archived skills cannot be enabled.");
    }
    if (
      input.enabled
      && install.reviewStatus !== WorkspaceSkillReviewStatus.APPROVED
      && install.status !== WorkspaceSkillInstallStatus.UPDATE_AVAILABLE
    ) {
      throw workspaceSkillConflict(
        "This skill version must be reviewed before it can be enabled.",
      );
    }
    if (input.enabled && install.skillPack.executesCode) {
      throw workspaceSkillRejected(
        "Executable registry packages cannot be enabled in Delegate.",
      );
    }
    if (
      input.enabled
      && !isWorkspaceSkillReleaseRuntimeTrusted({
        source: install.skillPack.source,
        executesCode: install.releases[0]?.executesCode ?? install.skillPack.executesCode,
        registryTrustEligible: install.releases[0]?.registryTrustEligible ?? false,
        signatureStatus: install.releases[0]?.signatureStatus ?? null,
      })
    ) {
      throw workspaceSkillRejected(
        "This skill release does not have sufficient runtime trust evidence and cannot be enabled.",
      );
    }

    const binding = await tx.representativeSkillPack.upsert({
      where: {
        representativeId_skillPackId: {
          representativeId: representative.id,
          skillPackId: install.skillPackId,
        },
      },
      create: {
        representativeId: representative.id,
        skillPackId: install.skillPackId,
        workspaceInstallId: install.id,
        enabled: input.enabled,
        installStatus: "installed",
        installedVersion: install.installedVersion,
        installedAt: install.installedAt,
      },
      update: {
        workspaceInstallId: install.id,
        enabled: input.enabled,
        installStatus: "installed",
        installedVersion: install.installedVersion,
        installedAt: install.installedAt,
      },
    });
    await tx.eventAudit.create({
      data: {
        representativeId: representative.id,
        type: EventType.SKILL_BINDING_CHANGED,
        payload: {
          installId: install.id,
          bindingId: binding.id,
          skillPackId: install.skillPackId,
          slug: install.skillPack.slug,
          enabled: input.enabled,
          changedBy: input.changedBy ?? representative.ownerId,
        },
      },
    });
    return { bindingId: binding.id, enabled: binding.enabled };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

type WorkspaceSkillReleaseTrustRefresh = {
  releaseUpdatedAt: Date;
  provenanceDigest: string;
  registryTrust: ClawHubRegistryTrust;
  registryTrustEvidence: Prisma.InputJsonObject;
  signatureStatus: WorkspaceSkillSignatureStatus;
};

async function refreshWorkspaceSkillReleaseTrustForReview(input: {
  ownerId?: string | null;
  activeRepresentativeSlug: string;
  installId: string;
  releaseId: string;
  action: "adopt" | "rollback";
  requireAutoEligibility?: boolean;
  registryTrustFetch?: typeof fetchClawHubRepresentativeSkillVersionTrust;
}): Promise<WorkspaceSkillReleaseTrustRefresh | null> {
  const representative = await prisma.representative.findFirst({
    where: {
      slug: input.activeRepresentativeSlug,
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    },
    select: { ownerId: true },
  });
  if (!representative) throw workspaceSkillNotFound("Representative not found.");

  const release = await prisma.workspaceSkillRelease.findFirst({
    where: {
      id: input.releaseId,
      installId: input.installId,
      install: { ownerId: representative.ownerId },
    },
    include: {
      approvalRequest: {
        select: { requestPayloadHash: true },
      },
      install: {
        include: {
          skillPack: true,
          releases: {
            where: { status: WorkspaceSkillReleaseStatus.INSTALLED },
            select: { id: true, version: true },
          },
        },
      },
    },
  });
  if (!release) {
    throw workspaceSkillNotFound("Workspace skill release not found.");
  }

  const installedRelease = release.install.releases[0] ?? null;
  if (isWorkspaceSkillAutoAdoptionAlreadyApplied({
    requireAutoEligibility: input.requireAutoEligibility,
    action: input.action,
    requestedReleaseId: release.id,
    requestedReleaseStatus: release.status,
    requestedVersion: release.version,
    installedReleaseId: installedRelease?.id ?? null,
    installedVersion: release.install.installedVersion,
  })) {
    return null;
  }
  const expectedStatus = input.action === "adopt"
    ? WorkspaceSkillReleaseStatus.CANDIDATE
    : WorkspaceSkillReleaseStatus.SUPERSEDED;
  if (release.status !== expectedStatus) {
    throw workspaceSkillConflict(input.action === "adopt"
      ? "Only a candidate skill release can be adopted."
      : "Only a superseded skill release can be selected for rollback.");
  }
  if (release.install.skillPack.source !== SkillPackSource.CLAWHUB) {
    return null;
  }

  const expectedManifestDigest = readString(
    asRecord(release.registryTrustEvidence)?.skillManifestDigest,
  );
  const provenanceDigest = release.provenanceDigest?.trim() || "";
  if (!expectedManifestDigest || !provenanceDigest) {
    throw workspaceSkillRejected(
      "ClawHub trust refresh failed: the recorded exact-version evidence is incomplete.",
    );
  }
  const reconstructedDigest = buildSkillReleaseDigest({
    slug: release.install.skillPack.slug,
    displayName: release.displayName,
    summary: release.summary,
    version: release.version,
    ...(release.sourceUrl ? { sourceUrl: release.sourceUrl } : {}),
    ...(release.ownerHandle ? { ownerHandle: release.ownerHandle } : {}),
    ...(release.verificationTier
      ? { verificationTier: release.verificationTier }
      : {}),
    capabilityTags: parseStringArray(release.capabilityTags),
    executesCode: release.executesCode,
    runtimeRequirements: parseRuntimeRequirements(release.runtimeRequirements),
    manifestDigest: expectedManifestDigest,
  });
  if (reconstructedDigest !== provenanceDigest) {
    throw workspaceSkillRejected(
      "ClawHub trust refresh failed: the recorded release digest no longer matches its immutable metadata.",
    );
  }
  if (
    release.approvalRequest?.requestPayloadHash
    && release.approvalRequest.requestPayloadHash !== provenanceDigest
  ) {
    throw workspaceSkillRejected(
      "ClawHub trust refresh failed: the approval evidence does not match the release digest.",
    );
  }

  const expectedReference = buildWorkspaceClawHubReference(
    release.install.skillPack.slug,
    release.ownerHandle ?? release.install.skillPack.ownerHandle,
  );
  let refreshed: Awaited<
    ReturnType<typeof fetchClawHubRepresentativeSkillVersionTrust>
  >;
  try {
    refreshed = await (
      input.registryTrustFetch
      ?? fetchClawHubRepresentativeSkillVersionTrust
    )({
      slug: expectedReference,
      version: release.version,
    });
  } catch {
    throw workspaceSkillRegistryUnavailable(
      "ClawHub trust refresh is unavailable; the release was not adopted.",
    );
  }
  if (!refreshed) {
    throw workspaceSkillConflict(
      "ClawHub trust refresh failed: the exact release is no longer available.",
    );
  }
  const freshness = evaluateFreshClawHubReleaseTrust({
    trust: refreshed.registryTrust,
    expectedVersion: release.version,
    expectedSkillReference: expectedReference,
    refreshedSkillReference: refreshed.slug,
    expectedOwnerHandle:
      release.ownerHandle ?? release.install.skillPack.ownerHandle,
    refreshedOwnerHandle: refreshed.ownerHandle,
    expectedManifestDigest,
  });
  if (!freshness.eligible) {
    throw workspaceSkillRejected(
      `ClawHub trust refresh failed: ${freshness.reason}.`,
      "The exact Registry release no longer passes the required trust checks.",
    );
  }

  const signatureStatus = reverifyRecordedWorkspaceSkillSignature({
    provenanceDigest,
    signatureAlgorithm: release.signatureAlgorithm,
    signatureKeyId: release.signatureKeyId,
    signatureValue: release.signatureValue,
  });
  if (signatureStatus === WorkspaceSkillSignatureStatus.INVALID) {
    throw workspaceSkillRejected(
      "ClawHub trust refresh failed: the recorded publisher signature is invalid.",
    );
  }

  return {
    releaseUpdatedAt: release.updatedAt,
    provenanceDigest,
    registryTrust: refreshed.registryTrust,
    registryTrustEvidence: serializeRegistryTrustEvidence(
      refreshed.registryTrust,
    ),
    signatureStatus,
  };
}

export async function reviewWorkspaceSkillRelease(input: {
  ownerId?: string | null;
  activeRepresentativeSlug: string;
  installId: string;
  releaseId: string;
  action: "adopt" | "reject" | "rollback";
  reviewedBy?: string;
  reviewNote?: string;
  requireAutoEligibility?: boolean;
  /** Internal test seam; dashboard callers never accept this value from HTTP. */
  registryTrustFetch?: typeof fetchClawHubRepresentativeSkillVersionTrust;
}) {
  if (!process.env.DATABASE_URL?.trim()) {
    const snapshot = getDemoWorkspaceSkillSnapshot(input.activeRepresentativeSlug);
    const skill = snapshot?.skills.find((entry) => entry.installId === input.installId);
    const release = skill?.releases.find((entry) => entry.id === input.releaseId);
    if (!skill || !release) {
      throw workspaceSkillNotFound("Workspace skill release not found.");
    }
    if (skill.status === "archived") {
      throw workspaceSkillConflict(
        "Archived workspace skills must be explicitly restored before reviewing releases.",
      );
    }
    const current = skill.releases.find((entry) => entry.status === "installed");
    if (isWorkspaceSkillAutoAdoptionAlreadyApplied({
      requireAutoEligibility: input.requireAutoEligibility,
      action: input.action,
      requestedReleaseId: release.id,
      requestedReleaseStatus: release.status,
      requestedVersion: release.version,
      installedReleaseId: current?.id ?? null,
      installedVersion: skill.installedVersion,
    })) {
      return { action: input.action, version: release.version };
    }
    if (input.action === "reject") {
      if (release.status !== "candidate") {
        throw workspaceSkillConflict(
          "Only a candidate skill release can be rejected.",
        );
      }
      release.status = "rejected";
      const state = resolveWorkspaceSkillInstallState({
        archived: false,
        releaseStatuses: skill.releases.map((entry) => mapReleaseStatus(entry.status)),
      });
      skill.status = state.status.toLowerCase() as "installed" | "update_available";
      skill.reviewStatus = state.reviewStatus.toLowerCase() as "approved" | "needs_review";
      skill.latestVersion = skill.releases.find((entry) => entry.status === "candidate")?.version
        ?? skill.installedVersion;
      return { action: input.action, version: release.version };
    }
    const expectedStatus = input.action === "adopt" ? "candidate" : "superseded";
    if (release.status !== expectedStatus) {
      throw workspaceSkillConflict(input.action === "adopt"
        ? "Only a candidate skill release can be adopted."
        : "Only a superseded skill release can be selected for rollback.");
    }
    if (
      input.action === "adopt"
      && current
      && shouldCloseWorkspaceSkillCandidateAfterAdoption(release.version, current.version)
    ) {
      throw workspaceSkillConflict(
        `Candidate v${release.version} is not newer than installed release v${current.version}; rediscover the skill to reconcile its release history.`,
      );
    }
    if (skill.source === "clawhub") {
      const expectedManifestDigest =
        release.registryTrust?.skillManifestDigest ?? null;
      const expectedReference = buildWorkspaceClawHubReference(
        skill.slug,
        skill.ownerHandle,
      );
      let refreshed: Awaited<
        ReturnType<typeof fetchClawHubRepresentativeSkillVersionTrust>
      >;
      try {
        refreshed = await (
          input.registryTrustFetch
          ?? fetchClawHubRepresentativeSkillVersionTrust
        )({
          slug: expectedReference,
          version: release.version,
        });
      } catch {
        throw workspaceSkillRegistryUnavailable(
          "ClawHub trust refresh is unavailable; the release was not adopted.",
        );
      }
      if (!refreshed) {
        throw workspaceSkillConflict(
          "ClawHub trust refresh failed: the exact release is no longer available.",
        );
      }
      const freshness = evaluateFreshClawHubReleaseTrust({
        trust: refreshed.registryTrust,
        expectedVersion: release.version,
        expectedSkillReference: expectedReference,
        refreshedSkillReference: refreshed.slug,
        expectedOwnerHandle: skill.ownerHandle,
        refreshedOwnerHandle: refreshed.ownerHandle,
        expectedManifestDigest,
      });
      if (!freshness.eligible) {
        throw workspaceSkillRejected(
          `ClawHub trust refresh failed: ${freshness.reason}.`,
          "The exact Registry release no longer passes the required trust checks.",
        );
      }
      release.registryTrust = toWorkspaceRegistryTrust(
        refreshed.registryTrust.source,
        refreshed.registryTrust.verified,
        refreshed.registryTrust.metadataOnlyAutoUpdateEligible,
        serializeRegistryTrustEvidence(refreshed.registryTrust),
      );
      release.signatureStatus = "unavailable";
    }
    if (current) current.status = "superseded";
    release.status = "installed";
    release.adoptedAt = new Date().toISOString();
    if (shouldDisableWorkspaceSkillBindingsAfterAdoption({
      source: mapSource(skill.source),
      executesCode: release.executesCode,
      registryTrustEligible: release.registryTrust?.autoUpdateEligible ?? false,
      signatureStatus: release.signatureStatus,
    })) {
      for (const binding of skill.bindings) binding.enabled = false;
    }
    if (input.action === "adopt") {
      for (const candidate of skill.releases) {
        if (
          candidate.id !== release.id
          && candidate.status === "candidate"
          && shouldCloseWorkspaceSkillCandidateAfterAdoption(candidate.version, release.version)
        ) {
          candidate.status = "rejected";
          candidate.reviewedBy = input.reviewedBy ?? "demo-owner";
          candidate.reviewedAt = new Date().toISOString();
          candidate.reviewNote = `Superseded by adopted release v${release.version}.`;
        }
      }
    }
    skill.installedVersion = release.version;
    const state = resolveWorkspaceSkillInstallState({
      archived: false,
      releaseStatuses: skill.releases.map((entry) => mapReleaseStatus(entry.status)),
    });
    skill.status = state.status.toLowerCase() as "installed" | "update_available";
    skill.reviewStatus = state.reviewStatus.toLowerCase() as "approved" | "needs_review";
    skill.latestVersion = skill.releases.find((entry) => entry.status === "candidate")?.version
      ?? release.version;
    return { action: input.action, version: release.version };
  }

  const trustRefresh = input.action === "reject"
    ? null
    : await refreshWorkspaceSkillReleaseTrustForReview({
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
        activeRepresentativeSlug: input.activeRepresentativeSlug,
        installId: input.installId,
        releaseId: input.releaseId,
        action: input.action,
        ...(input.requireAutoEligibility !== undefined
          ? { requireAutoEligibility: input.requireAutoEligibility }
          : {}),
        ...(input.registryTrustFetch
          ? { registryTrustFetch: input.registryTrustFetch }
          : {}),
      });

  return runWithPrismaWriteConflictRetry(() => prisma.$transaction(async (tx) => {
    const representative = await tx.representative.findFirst({
      where: {
        slug: input.activeRepresentativeSlug,
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      },
      select: { id: true, ownerId: true },
    });
    if (!representative) {
      throw workspaceSkillNotFound("Representative not found.");
    }

    const release = await tx.workspaceSkillRelease.findFirst({
      where: {
        id: input.releaseId,
        installId: input.installId,
        install: { ownerId: representative.ownerId },
      },
      include: {
        approvalRequest: {
          select: { requestPayloadHash: true },
        },
        install: {
          include: {
            skillPack: true,
            releases: {
              select: {
                id: true,
                version: true,
                status: true,
                capabilityTags: true,
                runtimeRequirements: true,
              },
            },
          },
        },
      },
    });
    if (!release) {
      throw workspaceSkillNotFound("Workspace skill release not found.");
    }
    if (release.install.status === WorkspaceSkillInstallStatus.ARCHIVED) {
      throw workspaceSkillConflict(
        "Archived workspace skills must be explicitly restored before reviewing releases.",
      );
    }
    const installedRelease = release.install.releases.find(
      (recordedRelease) => recordedRelease.status === WorkspaceSkillReleaseStatus.INSTALLED,
    );
    if (!installedRelease) {
      throw workspaceSkillConflict(
        "Workspace skill state is invalid: no installed release is recorded.",
      );
    }
    if (isWorkspaceSkillAutoAdoptionAlreadyApplied({
      requireAutoEligibility: input.requireAutoEligibility,
      action: input.action,
      requestedReleaseId: release.id,
      requestedReleaseStatus: release.status,
      requestedVersion: release.version,
      installedReleaseId: installedRelease.id,
      installedVersion: release.install.installedVersion,
    })) {
      return { action: input.action, version: release.version };
    }
    if (
      trustRefresh
      && (
        release.updatedAt.getTime() !== trustRefresh.releaseUpdatedAt.getTime()
        || release.provenanceDigest !== trustRefresh.provenanceDigest
        || (
          release.approvalRequest?.requestPayloadHash
          && release.approvalRequest.requestPayloadHash
            !== trustRefresh.provenanceDigest
        )
      )
    ) {
      throw workspaceSkillConflict(
        "This release changed while its trust was being refreshed. Refresh and try again.",
      );
    }
    const actor = input.reviewedBy ?? representative.ownerId;
    const reviewedAt = new Date();

    if (input.action === "reject") {
      if (release.status !== WorkspaceSkillReleaseStatus.CANDIDATE) {
        throw workspaceSkillConflict(
          "Only a candidate skill release can be rejected.",
        );
      }
      const rejected = await tx.workspaceSkillRelease.updateMany({
        where: { id: release.id, status: WorkspaceSkillReleaseStatus.CANDIDATE },
        data: {
          status: WorkspaceSkillReleaseStatus.REJECTED,
          reviewedBy: actor,
          reviewedAt,
          reviewNote: input.reviewNote?.trim() || null,
        },
      });
      if (rejected.count !== 1) {
        throw workspaceSkillConflict(
          "This candidate was already reviewed. Refresh and try again.",
        );
      }
      const remainingReleaseStatuses = await tx.workspaceSkillRelease.findMany({
        where: { installId: release.installId },
        select: { status: true },
      });
      const lifecycle = resolveWorkspaceSkillInstallState({
        archived: false,
        releaseStatuses: remainingReleaseStatuses.map((recordedRelease) => recordedRelease.status),
      });
      await tx.workspaceSkillInstall.update({
        where: { id: release.installId },
        data: {
          status: lifecycle.status,
          reviewStatus: lifecycle.reviewStatus,
        },
      });
      await tx.approvalRequest.updateMany({
        where: { workspaceSkillReleaseId: release.id, status: "PENDING" },
        data: {
          status: "REJECTED",
          resolvedAt: reviewedAt,
          resolvedBy: actor,
          decisionNote: input.reviewNote?.trim() || null,
        },
      });
      await tx.eventAudit.create({
        data: {
          representativeId: representative.id,
          type: EventType.SKILL_VERSION_REJECTED,
          payload: {
            installId: release.installId,
            releaseId: release.id,
            slug: release.install.skillPack.slug,
            version: release.version,
            reviewedBy: actor,
            reviewNote: input.reviewNote?.trim() || null,
          },
        },
      });
      return { action: input.action, version: release.version };
    }

    const expectedStatus = input.action === "adopt"
      ? WorkspaceSkillReleaseStatus.CANDIDATE
      : WorkspaceSkillReleaseStatus.SUPERSEDED;
    if (release.status !== expectedStatus) {
      throw workspaceSkillConflict(input.action === "adopt"
        ? "Only a candidate skill release can be adopted."
        : "Only a superseded skill release can be selected for rollback.");
    }
    if (
      input.action === "adopt"
      && shouldCloseWorkspaceSkillCandidateAfterAdoption(release.version, installedRelease.version)
    ) {
      throw workspaceSkillConflict(
        `Candidate v${release.version} is not newer than installed release v${installedRelease.version}; rediscover the skill to reconcile its release history.`,
      );
    }
    if (release.executesCode) {
      throw workspaceSkillRejected(
        "Executable third-party releases cannot be adopted.",
      );
    }
    if (input.requireAutoEligibility) {
      if (input.action !== "adopt") {
        throw workspaceSkillConflict(
          "Automatic eligibility can only be required for adoption.",
        );
      }
      const installedRequirements = deriveWorkspaceSkillRequirements(
        parseStringArray(installedRelease.capabilityTags),
      );
      const candidateRequirements = deriveWorkspaceSkillRequirements(parseStringArray(release.capabilityTags));
      const runtimeRequirementDiff = diffWorkspaceSkillRuntimeRequirements(
        parseRuntimeRequirements(installedRelease.runtimeRequirements),
        parseRuntimeRequirements(release.runtimeRequirements),
      );
      const autoUpdate = resolveSkillAutoUpdateEligibility({
        policy: release.install.updatePolicy,
        installedVersion: installedRelease.version,
        candidateVersion: release.version,
        signatureStatus:
          trustRefresh?.signatureStatus ?? release.signatureStatus,
        registryTrustEligible:
          trustRefresh?.registryTrust.metadataOnlyAutoUpdateEligible
          ?? release.registryTrustEligible,
        addedRequirements: candidateRequirements.filter(
          (requirement) => !installedRequirements.includes(requirement),
        ),
        runtimeRequirementDiff,
        executesCode: release.executesCode,
      });
      if (!autoUpdate.eligible) {
        throw workspaceSkillConflict(
          `Automatic adoption is no longer eligible: ${autoUpdate.reason}`,
        );
      }
    }

    await tx.workspaceSkillRelease.updateMany({
      where: { installId: release.installId, status: WorkspaceSkillReleaseStatus.INSTALLED },
      data: { status: WorkspaceSkillReleaseStatus.SUPERSEDED },
    });
    const adopted = await tx.workspaceSkillRelease.updateMany({
      where: {
        id: release.id,
        status: expectedStatus,
        ...(trustRefresh
          ? {
              updatedAt: trustRefresh.releaseUpdatedAt,
              provenanceDigest: trustRefresh.provenanceDigest,
            }
          : {}),
      },
      data: {
        status: WorkspaceSkillReleaseStatus.INSTALLED,
        reviewedBy: actor,
        reviewedAt,
        reviewNote: input.reviewNote?.trim() || null,
        adoptedAt: reviewedAt,
        ...(trustRefresh
          ? {
              signatureStatus: trustRefresh.signatureStatus,
              registryTrustSource: trustRefresh.registryTrust.source,
              registryVerified: trustRefresh.registryTrust.verified,
              registryTrustEligible:
                trustRefresh.registryTrust.metadataOnlyAutoUpdateEligible,
              registryTrustEvidence: trustRefresh.registryTrustEvidence,
            }
          : {}),
      },
    });
    if (adopted.count !== 1) {
      throw workspaceSkillConflict(
        "This release changed while it was being reviewed. Refresh and try again.",
      );
    }
    const shouldDisableBindings = shouldDisableWorkspaceSkillBindingsAfterAdoption({
      source: release.install.skillPack.source,
      executesCode: release.executesCode,
      registryTrustEligible:
        trustRefresh?.registryTrust.metadataOnlyAutoUpdateEligible
        ?? release.registryTrustEligible,
      signatureStatus:
        trustRefresh?.signatureStatus ?? release.signatureStatus,
    });
    const runtimeTrusted = !shouldDisableBindings;
    const bindingsToDisable = shouldDisableBindings
      ? await tx.representativeSkillPack.findMany({
          where: {
            workspaceInstallId: release.installId,
            enabled: true,
          },
          select: { id: true },
        })
      : [];
    const disabledBindingIds = bindingsToDisable.map((binding) => binding.id);
    const obsoleteCandidateIds = input.action === "adopt"
      ? release.install.releases
        .filter((recordedRelease) =>
          recordedRelease.id !== release.id
          && recordedRelease.status === WorkspaceSkillReleaseStatus.CANDIDATE
          && shouldCloseWorkspaceSkillCandidateAfterAdoption(recordedRelease.version, release.version),
        )
        .map((recordedRelease) => recordedRelease.id)
      : [];
    if (obsoleteCandidateIds.length) {
      await tx.approvalRequest.updateMany({
        where: {
          status: "PENDING",
          workspaceSkillReleaseId: { in: obsoleteCandidateIds },
        },
        data: {
          status: "REJECTED",
          resolvedAt: reviewedAt,
          resolvedBy: actor,
          decisionNote: `Superseded by adopted release v${release.version}.`,
        },
      });
      await tx.workspaceSkillRelease.updateMany({
        where: {
          id: { in: obsoleteCandidateIds },
          status: WorkspaceSkillReleaseStatus.CANDIDATE,
        },
        data: {
          status: WorkspaceSkillReleaseStatus.REJECTED,
          reviewedAt,
          reviewedBy: actor,
          reviewNote: `Superseded by adopted release v${release.version}.`,
        },
      });
    }
    const remainingReleaseStatuses = await tx.workspaceSkillRelease.findMany({
      where: { installId: release.installId },
      select: { status: true },
    });
    const lifecycle = resolveWorkspaceSkillInstallState({
      archived: false,
      releaseStatuses: remainingReleaseStatuses.map((recordedRelease) => recordedRelease.status),
    });
    await tx.workspaceSkillInstall.update({
      where: { id: release.installId },
      data: {
        installedVersion: release.version,
        installedAt: reviewedAt,
        status: lifecycle.status,
        reviewStatus: lifecycle.reviewStatus,
      },
    });
    await tx.representativeSkillPack.updateMany({
      where: { workspaceInstallId: release.installId },
      data: {
        installedVersion: release.version,
        installedAt: reviewedAt,
        ...(shouldDisableBindings ? { enabled: false } : {}),
      },
    });
    await tx.approvalRequest.updateMany({
      where: { workspaceSkillReleaseId: release.id, status: "PENDING" },
      data: {
        status: "APPROVED",
        resolvedAt: reviewedAt,
        resolvedBy: actor,
        decisionNote: input.reviewNote?.trim() || null,
      },
    });
    await tx.eventAudit.create({
      data: {
        representativeId: representative.id,
        type: input.action === "adopt"
          ? EventType.SKILL_VERSION_ADOPTED
          : EventType.SKILL_VERSION_ROLLED_BACK,
        payload: {
          installId: release.installId,
          releaseId: release.id,
          slug: release.install.skillPack.slug,
          version: release.version,
          reviewedBy: actor,
          reviewNote: input.reviewNote?.trim() || null,
          provenanceDigest: release.provenanceDigest,
          supersededCandidateReleaseIds: obsoleteCandidateIds,
          runtimeTrusted,
          disabledBindingIds,
          disabledBindingCount: disabledBindingIds.length,
        },
      },
    });
    return { action: input.action, version: release.version };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function resolveWorkspaceSkillApproval(input: {
  ownerId?: string | null;
  activeRepresentativeSlug: string;
  approvalId: string;
  resolution: "approved" | "rejected";
  resolvedBy?: string;
  decisionNote?: string;
}): Promise<{ handled: false } | { handled: true; result: { action: string; version: string } }> {
  if (!process.env.DATABASE_URL?.trim()) return { handled: false };
  const representative = await prisma.representative.findFirst({
    where: {
      slug: input.activeRepresentativeSlug,
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    },
    select: { ownerId: true },
  });
  if (!representative) throw workspaceSkillNotFound("Representative not found.");
  const approval = await prisma.approvalRequest.findFirst({
    where: {
      id: input.approvalId,
      workspaceSkillRelease: { install: { ownerId: representative.ownerId } },
    },
    select: {
      status: true,
      workspaceSkillRelease: { select: { id: true, installId: true } },
    },
  });
  if (!approval?.workspaceSkillRelease) return { handled: false };
  if (approval.status !== "PENDING") {
    throw workspaceSkillConflict(
      "This skill approval has already been resolved.",
    );
  }
  const result = await reviewWorkspaceSkillRelease({
    ownerId: representative.ownerId,
    activeRepresentativeSlug: input.activeRepresentativeSlug,
    installId: approval.workspaceSkillRelease.installId,
    releaseId: approval.workspaceSkillRelease.id,
    action: input.resolution === "approved" ? "adopt" : "reject",
    reviewedBy: input.resolvedBy ?? representative.ownerId,
    ...(input.decisionNote ? { reviewNote: input.decisionNote } : {}),
  });
  return { handled: true, result };
}

export async function setWorkspaceSkillArchived(input: {
  ownerId?: string | null;
  activeRepresentativeSlug: string;
  installId: string;
  archived: boolean;
  changedBy?: string;
}) {
  if (!process.env.DATABASE_URL?.trim()) {
    const snapshot = getDemoWorkspaceSkillSnapshot(input.activeRepresentativeSlug);
    const skill = snapshot?.skills.find((entry) => entry.installId === input.installId);
    if (!skill) {
      throw workspaceSkillNotFound("Workspace skill install not found.");
    }
    if (input.archived && (skill.bindings.some((binding) => binding.enabled) || skill.impact.publishedRepresentatives.length)) {
      throw workspaceSkillConflict(
        "Disable all representative bindings and publish a version without this skill before archiving it.",
      );
    }
    if (input.archived) {
      for (const release of skill.releases) {
        if (release.status !== "candidate") continue;
        release.status = "rejected";
        release.reviewedBy = input.changedBy ?? "demo-owner";
        release.reviewedAt = new Date().toISOString();
        release.reviewNote = "Closed because the workspace skill installation was archived.";
      }
      skill.status = "archived";
      skill.reviewStatus = "approved";
      skill.latestVersion = skill.installedVersion;
    } else {
      if (skill.status !== "archived") return { archived: false };
      const state = resolveWorkspaceSkillInstallState({
        archived: false,
        releaseStatuses: skill.releases.map((release) => mapReleaseStatus(release.status)),
      });
      skill.status = state.status.toLowerCase() as "installed" | "update_available";
      skill.reviewStatus = state.reviewStatus.toLowerCase() as "approved" | "needs_review";
    }
    return { archived: input.archived };
  }

  return runWithPrismaWriteConflictRetry(() => prisma.$transaction(async (tx) => {
    const representative = await tx.representative.findFirst({
      where: {
        slug: input.activeRepresentativeSlug,
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      },
      select: { id: true, ownerId: true },
    });
    if (!representative) {
      throw workspaceSkillNotFound("Representative not found.");
    }
    const install = await tx.workspaceSkillInstall.findFirst({
      where: { id: input.installId, ownerId: representative.ownerId },
      include: {
        skillPack: true,
        representativeBindings: {
          select: {
            id: true,
            enabled: true,
            representative: {
              select: { activeVersion: { select: { snapshot: true } } },
            },
          },
        },
        releases: { select: { id: true, status: true } },
      },
    });
    if (!install) {
      throw workspaceSkillNotFound("Workspace skill install not found.");
    }
    if (
      (input.archived && install.status === WorkspaceSkillInstallStatus.ARCHIVED)
      || (!input.archived && install.status !== WorkspaceSkillInstallStatus.ARCHIVED)
    ) {
      return { archived: input.archived };
    }
    const enabledBindings = install.representativeBindings.filter((binding) => binding.enabled).length;
    const publishedReferences = install.representativeBindings.filter((binding) =>
      binding.representative.activeVersion
      && snapshotUsesSkill(binding.representative.activeVersion.snapshot, install.skillPack.slug, null),
    ).length;
    if (input.archived && (enabledBindings || publishedReferences)) {
      throw workspaceSkillConflict(
        `Remove ${enabledBindings} enabled binding(s) and ${publishedReferences} active published reference(s) before archiving this skill.`,
      );
    }
    const actor = input.changedBy ?? representative.ownerId;
    const changedAt = new Date();
    const candidateIds = install.releases
      .filter((release) => release.status === WorkspaceSkillReleaseStatus.CANDIDATE)
      .map((release) => release.id);
    if (candidateIds.length) {
      const decisionNote = input.archived
        ? "Closed because the workspace skill installation was archived."
        : "Closed while restoring an archived workspace skill installation.";
      await tx.approvalRequest.updateMany({
        where: {
          workspaceSkillReleaseId: { in: candidateIds },
          status: "PENDING",
        },
        data: {
          status: "REJECTED",
          resolvedAt: changedAt,
          resolvedBy: actor,
          decisionNote,
        },
      });
      await tx.workspaceSkillRelease.updateMany({
        where: {
          id: { in: candidateIds },
          status: WorkspaceSkillReleaseStatus.CANDIDATE,
        },
        data: {
          status: WorkspaceSkillReleaseStatus.REJECTED,
          reviewedAt: changedAt,
          reviewedBy: actor,
          reviewNote: decisionNote,
        },
      });
    }
    const lifecycle = resolveWorkspaceSkillInstallState({
      archived: input.archived,
      releaseStatuses: install.releases.map((release) =>
        release.status === WorkspaceSkillReleaseStatus.CANDIDATE
          ? WorkspaceSkillReleaseStatus.REJECTED
          : release.status,
      ),
    });
    await tx.workspaceSkillInstall.update({
      where: { id: install.id },
      data: {
        status: lifecycle.status,
        reviewStatus: lifecycle.reviewStatus,
      },
    });
    await tx.eventAudit.create({
      data: {
        representativeId: representative.id,
        type: input.archived ? EventType.SKILL_ARCHIVED : EventType.SKILL_RESTORED,
        payload: {
          installId: install.id,
          slug: install.skillPack.slug,
          version: install.installedVersion,
          changedBy: actor,
          closedCandidateReleaseIds: candidateIds,
        },
      },
    });
    return { archived: input.archived };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

function serializeWorkspaceSkill(
  install: WorkspaceSkillRecord,
  recentCalls: WorkspaceSkillSnapshot["skills"][number]["recentCalls"],
): WorkspaceSkillSnapshot["skills"][number] {
  const installedRelease = install.releases.find((release) => release.status === WorkspaceSkillReleaseStatus.INSTALLED)
    ?? install.releases.find((release) => release.version === install.installedVersion);
  const candidateRelease = install.releases.find((release) => release.status === WorkspaceSkillReleaseStatus.CANDIDATE);
  const tags = parseStringArray(installedRelease?.capabilityTags ?? install.skillPack.capabilityTags);
  const requirements = deriveWorkspaceSkillRequirements(tags);
  const lifecycle = resolveWorkspaceSkillInstallState({
    archived: install.status === WorkspaceSkillInstallStatus.ARCHIVED,
    releaseStatuses: install.releases.map((release) => release.status),
  });
  const effectiveReviewStatus =
    !isWorkspaceSkillReleaseRuntimeTrusted({
      source: install.skillPack.source,
      executesCode: installedRelease?.executesCode ?? install.skillPack.executesCode,
      registryTrustEligible: installedRelease?.registryTrustEligible ?? false,
      signatureStatus: installedRelease?.signatureStatus ?? null,
    })
      ? WorkspaceSkillReviewStatus.NEEDS_REVIEW
      : lifecycle.reviewStatus;
  const status = lifecycle.status.toLowerCase() as "installed" | "update_available" | "archived";
  const executesCode = installedRelease?.executesCode ?? install.skillPack.executesCode;
  const installedRuntimeRequirements = parseRuntimeRequirements(installedRelease?.runtimeRequirements);
  const bindings = install.representativeBindings.map((binding) => {
    const issue = binding.enabled && requirements.includes("mcp") && !binding.mcpBindings.some((item) => item.enabled)
      ? "No enabled MCP connection is linked to this binding."
      : null;
    return {
      linkId: binding.id,
      representativeId: binding.representative.id,
      representativeSlug: binding.representative.slug,
      representativeName: binding.representative.displayName,
      enabled: binding.enabled,
      ready: !issue,
      issue,
    };
  });
  const readiness = resolveWorkspaceSkillReadiness({
    executesCode,
    reviewStatus: effectiveReviewStatus,
    status: lifecycle.status,
    source: install.skillPack.source,
    registryTrustEligible: installedRelease?.registryTrustEligible ?? false,
    signatureStatus: installedRelease?.signatureStatus ?? null,
    bindings,
  });
  return {
    installId: install.id,
    skillPackId: install.skillPackId,
    slug: install.skillPack.slug,
    displayName: installedRelease?.displayName ?? install.skillPack.displayName,
    summary: installedRelease?.summary ?? install.skillPack.summary,
    source: install.skillPack.source.toLowerCase() as "builtin" | "owner_upload" | "clawhub",
    installedVersion: installedRelease?.version ?? install.installedVersion,
    latestVersion: candidateRelease?.version ?? installedRelease?.version ?? install.installedVersion,
    installedAt: install.installedAt.toISOString(),
    sourceUrl: installedRelease?.sourceUrl ?? install.skillPack.sourceUrl,
    ownerHandle: installedRelease?.ownerHandle ?? install.skillPack.ownerHandle,
    verificationTier: installedRelease?.verificationTier ?? install.skillPack.verificationTier,
    capabilityTags: tags,
    requirements,
    risk: deriveWorkspaceSkillRisk(install.skillPack.source, executesCode, requirements),
    executesCode,
    status,
    reviewStatus: effectiveReviewStatus.toLowerCase() as "approved" | "needs_review" | "rejected",
    updatePolicy: install.updatePolicy.toLowerCase() as "manual" | "review_required" | "patch_auto",
    readiness: readiness.status,
    readinessReason: readiness.reason,
    recentCalls,
    releases: install.releases.map((release) => {
      const releaseTags = parseStringArray(release.capabilityTags);
      const releaseRequirements = deriveWorkspaceSkillRequirements(releaseTags);
      const releaseRuntimeRequirements = parseRuntimeRequirements(release.runtimeRequirements);
      const runtimeRequirementDiff = diffWorkspaceSkillRuntimeRequirements(
        installedRuntimeRequirements,
        releaseRuntimeRequirements,
      );
      return {
        id: release.id,
        version: release.version,
        status: release.status.toLowerCase() as "installed" | "candidate" | "superseded" | "rejected",
        displayName: release.displayName,
        summary: release.summary,
        capabilityTags: releaseTags,
        executesCode: release.executesCode,
        provenanceDigest: release.provenanceDigest,
        signatureStatus: release.signatureStatus.toLowerCase() as "unavailable" | "unverified" | "verified" | "invalid",
        signatureAlgorithm: release.signatureAlgorithm,
        signatureKeyId: release.signatureKeyId,
        sbomUrl: release.sbomUrl,
        attestationUrl: release.attestationUrl,
        registryTrust: toWorkspaceRegistryTrust(
          release.registryTrustSource,
          release.registryVerified,
          release.registryTrustEligible,
          release.registryTrustEvidence,
        ),
        runtimeRequirements: releaseRuntimeRequirements,
        runtimeRequirementDiff,
        permissionDiff: {
          added: releaseRequirements.filter((requirement) => !requirements.includes(requirement)),
          removed: requirements.filter((requirement) => !releaseRequirements.includes(requirement)),
        },
        autoUpdate: resolveSkillAutoUpdateEligibility({
          policy: install.updatePolicy,
          installedVersion: installedRelease?.version ?? install.installedVersion,
          candidateVersion: release.version,
          signatureStatus: release.signatureStatus,
          registryTrustEligible: release.registryTrustEligible,
          addedRequirements: releaseRequirements.filter((requirement) => !requirements.includes(requirement)),
          runtimeRequirementDiff,
          executesCode: release.executesCode,
        }),
        reviewedBy: release.reviewedBy,
        reviewedAt: release.reviewedAt?.toISOString() ?? null,
        reviewNote: release.reviewNote,
        discoveredAt: release.discoveredAt.toISOString(),
        adoptedAt: release.adoptedAt?.toISOString() ?? null,
      };
    }),
    impact: {
      enabledBindings: bindings.filter((binding) => binding.enabled).length,
      publishedRepresentatives: install.representativeBindings.flatMap((binding) => {
        const activeVersion = binding.representative.activeVersion;
        return activeVersion && snapshotUsesSkill(activeVersion.snapshot, install.skillPack.slug, null)
          ? [{
              slug: binding.representative.slug,
              displayName: binding.representative.displayName,
              versionNumber: activeVersion.versionNumber,
            }]
          : [];
      }),
    },
    bindings,
  };
}

function serializePolicy(representative: {
  computeDefaultPolicyMode: string;
  computeNetworkMode: string;
  computeFilesystemMode: string;
  capabilityProfiles: Array<{ rules: Array<{ id: string; capability: string; decision: string }> }>;
}): WorkspaceSkillSnapshot["policy"] {
  const defaultDecision = representative.computeDefaultPolicyMode.toLowerCase() as "allow" | "ask" | "deny";
  const capabilityModes = Object.fromEntries(
    capabilityNames.map((capability) => {
      const rule = representative.capabilityProfiles[0]?.rules.find(
        (candidate) => candidate.id.endsWith(`_${capability}_owner_mode`),
      );
      return [capability, (rule?.decision.toLowerCase() ?? defaultDecision) as "allow" | "ask" | "deny"];
    }),
  ) as WorkspaceSkillSnapshot["policy"]["capabilityModes"];
  return {
    defaultDecision,
    networkMode: representative.computeNetworkMode.toLowerCase() as WorkspaceSkillSnapshot["policy"]["networkMode"],
    filesystemMode: representative.computeFilesystemMode.toLowerCase() as WorkspaceSkillSnapshot["policy"]["filesystemMode"],
    capabilityModes,
  };
}

function resolveConnectionHealth(binding: {
  enabled: boolean;
  consecutiveFailures: number;
  lastFailureReason: string | null;
  lastSuccessAt: Date | null;
}) {
  if (!binding.enabled) return { status: "disabled" as const, detail: "Connection is disabled." };
  if (binding.consecutiveFailures > 0) {
    return {
      status: "degraded" as const,
      detail: binding.lastFailureReason || `${binding.consecutiveFailures} consecutive failures.`,
    };
  }
  if (!binding.lastSuccessAt) return { status: "unverified" as const, detail: "No successful call has been recorded." };
  return { status: "healthy" as const, detail: `Last successful call: ${binding.lastSuccessAt.toISOString()}` };
}

export function deriveWorkspaceSkillRequirements(tags: string[]): CapabilityName[] {
  const normalized = tags.map((tag) => tag.toLowerCase());
  return capabilityNames.filter((capability) =>
    normalized.some((tag) => tag === capability || tag.startsWith(`${capability}-`) || tag.endsWith(`-${capability}`)),
  );
}

export function deriveWorkspaceSkillRisk(source: SkillPackSource, executesCode: boolean, requirements: CapabilityName[]): WorkspaceSkillRisk {
  if (executesCode || requirements.some((item) => ["exec", "write", "process", "browser", "mcp"].includes(item))) return "high";
  if (source !== SkillPackSource.BUILTIN || requirements.includes("read")) return "medium";
  return "low";
}

export function resolveWorkspaceSkillReadiness(input: {
  executesCode: boolean;
  reviewStatus: WorkspaceSkillReviewStatus;
  status: WorkspaceSkillInstallStatus;
  source?: SkillPackSource;
  registryTrustEligible?: boolean;
  signatureStatus?: WorkspaceSkillSignatureStatus | string | null;
  bindings: WorkspaceSkillSnapshot["skills"][number]["bindings"];
}) {
  if (input.executesCode) return { status: "blocked" as const, reason: "Executable third-party packages are blocked by the public-runtime trust boundary." };
  if (!isWorkspaceSkillReleaseRuntimeTrusted({
    source: input.source ?? SkillPackSource.BUILTIN,
    executesCode: input.executesCode,
    registryTrustEligible: input.registryTrustEligible,
    signatureStatus: input.signatureStatus,
  })) {
    return { status: "blocked" as const, reason: "This ClawHub release lacks official Registry trust or a verified publisher signature." };
  }
  if (input.status === WorkspaceSkillInstallStatus.ARCHIVED) return { status: "blocked" as const, reason: "This workspace installation is archived." };
  if (
    input.reviewStatus !== WorkspaceSkillReviewStatus.APPROVED
    && input.status !== WorkspaceSkillInstallStatus.UPDATE_AVAILABLE
  ) return { status: "blocked" as const, reason: "This installed version requires owner review before it can be enabled." };
  const issue = input.bindings.find((binding) => binding.enabled && !binding.ready)?.issue;
  if (issue) return { status: "needs_setup" as const, reason: issue };
  if (!input.bindings.some((binding) => binding.enabled)) return { status: "needs_setup" as const, reason: "Installed in the workspace but not enabled for a representative." };
  if (input.status === WorkspaceSkillInstallStatus.UPDATE_AVAILABLE) return { status: "ready" as const, reason: "The installed version remains usable; a newer version requires review before adoption." };
  return { status: "ready" as const, reason: "Enabled bindings satisfy the currently declared requirements." };
}

function parseDeclaredOutcomes(value: Prisma.JsonValue): RepresentativeSkill[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<RepresentativeSkill>(demoRepresentative.skills);
  return value.filter((entry): entry is RepresentativeSkill => typeof entry === "string" && allowed.has(entry as RepresentativeSkill));
}

function parseStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];
}

const emptyRuntimeRequirements = (): ClawHubRuntimeRequirements => ({
  requiredEnv: [],
  optionalEnv: [],
  requiredBins: [],
  anyBins: [],
  configPaths: [],
  operatingSystems: [],
  installKinds: [],
  always: false,
});

function normalizeRuntimeRequirements(
  requirements: ClawHubRuntimeRequirements | null | undefined,
): ClawHubRuntimeRequirements {
  const normalized = requirements ?? emptyRuntimeRequirements();
  const normalizeValues = (values: readonly string[]) =>
    [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  const primaryEnv = normalized.primaryEnv?.trim();
  return {
    requiredEnv: normalizeValues(normalized.requiredEnv),
    optionalEnv: normalizeValues(normalized.optionalEnv),
    requiredBins: normalizeValues(normalized.requiredBins),
    anyBins: normalizeValues(normalized.anyBins),
    configPaths: normalizeValues(normalized.configPaths),
    operatingSystems: normalizeValues(normalized.operatingSystems),
    installKinds: normalizeValues(normalized.installKinds) as ClawHubRuntimeRequirements["installKinds"],
    ...(primaryEnv ? { primaryEnv } : {}),
    always: normalized.always === true,
  };
}

function flattenRuntimeRequirements(
  requirements: ClawHubRuntimeRequirements | null | undefined,
): string[] {
  const normalized = normalizeRuntimeRequirements(requirements);
  return [
    ...normalized.requiredEnv.map((value) => `required env: ${value}`),
    ...normalized.optionalEnv.map((value) => `optional env: ${value}`),
    ...normalized.requiredBins.map((value) => `required binary: ${value}`),
    ...normalized.anyBins.map((value) => `alternative binary: ${value}`),
    ...normalized.configPaths.map((value) => `config path: ${value}`),
    ...normalized.operatingSystems.map((value) => `OS: ${value}`),
    ...normalized.installKinds.map((value) => `installer: ${value}`),
    ...(normalized.primaryEnv ? [`primary env: ${normalized.primaryEnv}`] : []),
    ...(normalized.always ? ["always enabled"] : []),
  ].sort();
}

export function diffWorkspaceSkillRuntimeRequirements(
  installed: ClawHubRuntimeRequirements | null | undefined,
  candidate: ClawHubRuntimeRequirements | null | undefined,
): WorkspaceSkillSnapshot["skills"][number]["releases"][number]["runtimeRequirementDiff"] {
  const installedValues = flattenRuntimeRequirements(installed);
  const candidateValues = flattenRuntimeRequirements(candidate);
  const installedSet = new Set(installedValues);
  const candidateSet = new Set(candidateValues);
  const added = candidateValues.filter((value) => !installedSet.has(value));
  const removed = installedValues.filter((value) => !candidateSet.has(value));
  return {
    added,
    removed,
    changed: added.length > 0 || removed.length > 0,
  };
}

function formatRuntimeRequirementDiff(
  diff: WorkspaceSkillSnapshot["skills"][number]["releases"][number]["runtimeRequirementDiff"],
) {
  return [
    ...(diff.added.length ? [`added ${diff.added.join(", ")}`] : []),
    ...(diff.removed.length ? [`removed ${diff.removed.join(", ")}`] : []),
  ].join("; ") || "no changes";
}

function evaluateClawHubRegistryTrustEvidence(
  trust: ClawHubRegistryTrust,
): { eligible: boolean; reason: string } {
  if (trust.decision === "fail") {
    return { eligible: false, reason: "official Registry verification returned fail" };
  }
  if (trust.securityStatus === "malicious" || trust.securityStatus === "suspicious") {
    return { eligible: false, reason: `official Registry security status is ${trust.securityStatus}` };
  }
  if (trust.reasons.includes("moderation.blocked")) {
    return { eligible: false, reason: "Registry moderation blocked this release" };
  }
  if (
    !trust.verified
    || !trust.metadataOnlyAutoUpdateEligible
    || trust.decision !== "pass"
    || trust.securityStatus !== "clean"
    || !trust.exactVersionMatch
    || !trust.exactPublisherMatch
    || !trust.skillManifestFetched
    || !trust.skillManifestParsed
    || !trust.skillManifestDigest
    || trust.reasons.length > 0
  ) {
    return {
      eligible: false,
      reason: `official Registry trust evidence is incomplete${trust.reasons.length ? ` (${trust.reasons.join(", ")})` : ""}`,
    };
  }
  return {
    eligible: true,
    reason: "official Registry verification, identity, security, and exact-version manifest evidence are complete",
  };
}

type ExactClawHubReleaseTrustInput = {
  trust: ClawHubRegistryTrust;
  expectedVersion: string;
  expectedSkillReference: string;
  refreshedSkillReference: string;
  expectedOwnerHandle?: string | null;
  refreshedOwnerHandle?: string | null;
  expectedManifestDigest?: string | null;
  now?: Date;
  maxAgeMs?: number;
};

function evaluateExactClawHubReleaseTrust(
  input: ExactClawHubReleaseTrustInput,
  successReason: string,
): { eligible: boolean; reason: string; checkedAtMs: number | null } {
  const expectedVersion = input.expectedVersion.trim();
  if (!expectedVersion || input.trust.version !== expectedVersion) {
    return {
      eligible: false,
      reason: "the refreshed Registry result does not match the requested exact version",
      checkedAtMs: null,
    };
  }
  if (
    normalizeSkillIdentity(input.refreshedSkillReference)
    !== normalizeSkillIdentity(input.expectedSkillReference)
  ) {
    return {
      eligible: false,
      reason: "the refreshed Registry result belongs to a different skill reference",
      checkedAtMs: null,
    };
  }
  const expectedOwnerHandle = input.expectedOwnerHandle?.trim().toLowerCase() || null;
  const refreshedOwnerHandle = input.refreshedOwnerHandle?.trim().toLowerCase() || null;
  if (
    expectedOwnerHandle
    && refreshedOwnerHandle !== expectedOwnerHandle
  ) {
    return {
      eligible: false,
      reason: "the refreshed Registry result belongs to a different publisher",
      checkedAtMs: null,
    };
  }
  if (
    !input.expectedManifestDigest
    || input.trust.skillManifestDigest !== input.expectedManifestDigest
  ) {
    return {
      eligible: false,
      reason: "the exact-version manifest changed after discovery",
      checkedAtMs: null,
    };
  }

  const checkedAtMs = normalizeRegistryCheckedAtMs(input.trust.checkedAt);
  if (checkedAtMs === null) {
    return {
      eligible: false,
      reason: "the Registry verification timestamp is missing or invalid",
      checkedAtMs: null,
    };
  }
  const nowMs = (input.now ?? new Date()).getTime();
  if (checkedAtMs > nowMs + clawHubTrustFutureSkewMs) {
    return {
      eligible: false,
      reason: "the Registry verification timestamp is in the future",
      checkedAtMs,
    };
  }
  const maxAgeMs = normalizeClawHubTrustMaxAgeMs(input.maxAgeMs);
  if (nowMs - checkedAtMs > maxAgeMs) {
    return {
      eligible: false,
      reason: "the Registry verification is stale",
      checkedAtMs,
    };
  }

  const trustDecision = evaluateClawHubRegistryTrustEvidence(input.trust);
  if (!trustDecision.eligible) {
    return {
      eligible: false,
      reason: trustDecision.reason,
      checkedAtMs,
    };
  }
  return {
    eligible: true,
    reason: successReason,
    checkedAtMs,
  };
}

export function evaluateClawHubInitialInstallTrust(
  input: ExactClawHubReleaseTrustInput,
): { eligible: boolean; reason: string; checkedAtMs: number | null } {
  const expectedOwnerHandle = input.expectedOwnerHandle?.trim();
  const refreshedOwnerHandle = input.refreshedOwnerHandle?.trim();
  if (!expectedOwnerHandle || !refreshedOwnerHandle) {
    return {
      eligible: false,
      reason: "the Registry release publisher is missing",
      checkedAtMs: null,
    };
  }
  const checkedAtMs = normalizeRegistryCheckedAtMs(input.trust.checkedAt);
  if (
    checkedAtMs !== null
    && checkedAtMs > (input.now ?? new Date()).getTime()
  ) {
    return {
      eligible: false,
      reason: "the Registry verification timestamp is in the future",
      checkedAtMs,
    };
  }
  return evaluateExactClawHubReleaseTrust(
    input,
    "the initial exact-version Registry trust is complete and current",
  );
}

export function evaluateFreshClawHubReleaseTrust(
  input: ExactClawHubReleaseTrustInput,
): { eligible: boolean; reason: string; checkedAtMs: number | null } {
  return evaluateExactClawHubReleaseTrust(
    input,
    "the exact-version Registry trust was refreshed and remains current",
  );
}

function assertClawHubInitialInstallTrust(input: {
  requestedSkillReference: string;
  discoveredSkillReference: string;
  discoveredVersion: string;
  discoveredOwnerHandle?: string | null | undefined;
  trust: ClawHubRegistryTrust;
}) {
  const requestedOwnerHandle = readClawHubOwnerHandle(input.requestedSkillReference);
  const discoveredOwnerHandle = input.discoveredOwnerHandle?.trim().toLowerCase()
    || readClawHubOwnerHandle(input.discoveredSkillReference);
  const decision = evaluateClawHubInitialInstallTrust({
    trust: input.trust,
    expectedVersion: input.discoveredVersion,
    expectedSkillReference: buildWorkspaceClawHubReference(
      input.requestedSkillReference,
      discoveredOwnerHandle,
    ),
    refreshedSkillReference: buildWorkspaceClawHubReference(
      input.discoveredSkillReference,
      discoveredOwnerHandle,
    ),
    expectedOwnerHandle: requestedOwnerHandle ?? discoveredOwnerHandle,
    refreshedOwnerHandle: discoveredOwnerHandle,
    expectedManifestDigest: input.trust.skillManifestDigest,
  });
  if (!decision.eligible) {
    throw workspaceSkillRejected(
      `ClawHub release cannot be installed: ${decision.reason}.`,
      "The Registry release does not pass the required trust checks and cannot be installed.",
    );
  }
}

function readClawHubOwnerHandle(reference: string): string | null {
  const match = reference.trim().toLowerCase().match(/^@([^/]+)\//);
  return match?.[1] ?? null;
}

function normalizeRegistryCheckedAtMs(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function normalizeClawHubTrustMaxAgeMs(value?: number) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  const configured = Number(process.env.DELEGATE_CLAWHUB_TRUST_MAX_AGE_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : defaultClawHubTrustMaxAgeMs;
}

function normalizeSkillIdentity(value: string) {
  return value.trim().toLowerCase();
}

export function buildSkillReleaseDigest(skill: {
  slug: string;
  displayName: string;
  summary: string;
  version?: string | undefined;
  sourceUrl?: string | undefined;
  ownerHandle?: string | undefined;
  verificationTier?: string | undefined;
  capabilityTags: string[];
  executesCode: boolean;
  runtimeRequirements?: ClawHubRuntimeRequirements | null | undefined;
  manifestDigest?: string | null | undefined;
}) {
  const canonical = JSON.stringify({
    slug: skill.slug,
    displayName: skill.displayName,
    summary: skill.summary,
    version: skill.version?.trim() || "unversioned",
    sourceUrl: skill.sourceUrl ?? null,
    ownerHandle: skill.ownerHandle ?? null,
    verificationTier: skill.verificationTier ?? null,
    capabilityTags: [...skill.capabilityTags].sort(),
    executesCode: skill.executesCode,
    runtimeRequirements: skill.runtimeRequirements === undefined
      ? null
      : normalizeRuntimeRequirements(skill.runtimeRequirements),
    manifestDigest: skill.manifestDigest?.trim() || null,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function verifyWorkspaceSkillSignature(input: {
  provenanceDigest: string;
  signature?: { algorithm: string; keyId: string; value: string } | undefined;
  trustedKeysJson?: string | undefined;
}): { status: WorkspaceSkillSignatureStatus; reason: string } {
  if (!input.signature) {
    return { status: WorkspaceSkillSignatureStatus.UNAVAILABLE, reason: "The registry did not provide a signature." };
  }
  if (input.signature.algorithm.trim().toLowerCase() !== "ed25519") {
    return { status: WorkspaceSkillSignatureStatus.UNVERIFIED, reason: "The signature algorithm is not supported." };
  }
  const trustedKeys = parseTrustedSkillKeys(input.trustedKeysJson ?? process.env.DELEGATE_SKILL_TRUSTED_KEYS);
  const publicKey = trustedKeys[input.signature.keyId];
  if (!publicKey) {
    return { status: WorkspaceSkillSignatureStatus.UNVERIFIED, reason: "No trusted public key is configured for this publisher." };
  }
  try {
    const valid = verifyCryptographicSignature(
      null,
      Buffer.from(input.provenanceDigest, "utf8"),
      publicKey,
      Buffer.from(input.signature.value, "base64"),
    );
    return valid
      ? { status: WorkspaceSkillSignatureStatus.VERIFIED, reason: "The registry signature matches a configured trusted Ed25519 key." }
      : { status: WorkspaceSkillSignatureStatus.INVALID, reason: "The registry signature does not match the release digest." };
  } catch {
    return { status: WorkspaceSkillSignatureStatus.UNVERIFIED, reason: "The configured publisher key or signature could not be parsed." };
  }
}

function reverifyRecordedWorkspaceSkillSignature(input: {
  provenanceDigest: string;
  signatureAlgorithm: string | null;
  signatureKeyId: string | null;
  signatureValue: string | null;
}) {
  const hasRecordedSignature = Boolean(
    input.signatureAlgorithm
    || input.signatureKeyId
    || input.signatureValue,
  );
  if (!hasRecordedSignature) {
    return WorkspaceSkillSignatureStatus.UNAVAILABLE;
  }
  if (
    !input.signatureAlgorithm
    || !input.signatureKeyId
    || !input.signatureValue
  ) {
    return WorkspaceSkillSignatureStatus.UNVERIFIED;
  }
  return verifyWorkspaceSkillSignature({
    provenanceDigest: input.provenanceDigest,
    signature: {
      algorithm: input.signatureAlgorithm,
      keyId: input.signatureKeyId,
      value: input.signatureValue,
    },
  }).status;
}

function buildWorkspaceClawHubReference(
  slug: string,
  ownerHandle?: string | null,
) {
  const normalizedSlug = slug.trim().toLowerCase();
  if (normalizedSlug.startsWith("@")) return normalizedSlug;
  const normalizedOwner = ownerHandle?.trim().toLowerCase();
  return normalizedOwner
    ? `@${normalizedOwner}/${normalizedSlug}`
    : normalizedSlug;
}

export function resolveSkillAutoUpdateEligibility(input: {
  policy: WorkspaceSkillUpdatePolicy;
  installedVersion: string | null;
  candidateVersion: string;
  signatureStatus: WorkspaceSkillSignatureStatus;
  registryTrustEligible?: boolean;
  addedRequirements: CapabilityName[];
  runtimeRequirementDiff?: WorkspaceSkillSnapshot["skills"][number]["releases"][number]["runtimeRequirementDiff"];
  executesCode: boolean;
}): { eligible: boolean; reason: string } {
  if (input.policy !== WorkspaceSkillUpdatePolicy.PATCH_AUTO) {
    return { eligible: false, reason: "Owner review is required by the current update policy." };
  }
  if (input.executesCode) {
    return { eligible: false, reason: "Executable releases are never adopted automatically." };
  }
  if (
    input.signatureStatus !== WorkspaceSkillSignatureStatus.VERIFIED
    && input.registryTrustEligible !== true
  ) {
    return {
      eligible: false,
      reason: "Automatic adoption requires either a trusted publisher signature or exact-version official Registry verification.",
    };
  }
  if (input.addedRequirements.length) {
    return { eligible: false, reason: `The release adds governed requirements: ${input.addedRequirements.join(", ")}.` };
  }
  if (input.runtimeRequirementDiff?.changed) {
    return {
      eligible: false,
      reason: `The exact-version manifest changes runtime requirements: ${formatRuntimeRequirementDiff(input.runtimeRequirementDiff)}.`,
    };
  }
  if (!isPatchUpgrade(input.installedVersion, input.candidateVersion)) {
    return { eligible: false, reason: "Only a forward semantic-version patch update is eligible." };
  }
  return {
    eligible: true,
    reason: input.registryTrustEligible
      ? "Officially verified Registry patch update with no new governed requirements."
      : "Publisher-signed patch update with no new governed requirements.",
  };
}

export async function setWorkspaceSkillUpdatePolicy(input: {
  ownerId?: string | null;
  activeRepresentativeSlug: string;
  installId: string;
  updatePolicy: "manual" | "review_required" | "patch_auto";
  changedBy?: string;
}) {
  const policy = input.updatePolicy === "manual"
    ? WorkspaceSkillUpdatePolicy.MANUAL
    : input.updatePolicy === "patch_auto"
      ? WorkspaceSkillUpdatePolicy.PATCH_AUTO
      : WorkspaceSkillUpdatePolicy.REVIEW_REQUIRED;
  if (!process.env.DATABASE_URL?.trim()) {
    const snapshot = getDemoWorkspaceSkillSnapshot(input.activeRepresentativeSlug);
    const skill = snapshot?.skills.find((entry) => entry.installId === input.installId);
    if (!skill) {
      throw workspaceSkillNotFound("Workspace skill install not found.");
    }
    skill.updatePolicy = input.updatePolicy;
    return { updatePolicy: input.updatePolicy };
  }
  return runWithPrismaWriteConflictRetry(() => prisma.$transaction(async (tx) => {
    const representative = await tx.representative.findFirst({
      where: {
        slug: input.activeRepresentativeSlug,
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      },
      select: { id: true, ownerId: true },
    });
    if (!representative) {
      throw workspaceSkillNotFound("Representative not found.");
    }
    const install = await tx.workspaceSkillInstall.findFirst({
      where: { id: input.installId, ownerId: representative.ownerId },
      include: { skillPack: { select: { slug: true } } },
    });
    if (!install) {
      throw workspaceSkillNotFound("Workspace skill install not found.");
    }
    await tx.workspaceSkillInstall.update({ where: { id: install.id }, data: { updatePolicy: policy } });
    await tx.eventAudit.create({
      data: {
        representativeId: representative.id,
        type: EventType.SKILL_UPDATE_POLICY_CHANGED,
        payload: {
          installId: install.id,
          slug: install.skillPack.slug,
          previousPolicy: install.updatePolicy,
          updatePolicy: policy,
          changedBy: input.changedBy ?? representative.ownerId,
        },
      },
    });
    return { updatePolicy: policy.toLowerCase() };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

function parseTrustedSkillKeys(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim())),
    );
  } catch {
    return {};
  }
}

function isPatchUpgrade(installedVersion: string | null, candidateVersion: string) {
  if (!installedVersion) return false;
  const installed = parseSemanticVersion(installedVersion);
  const candidate = parseSemanticVersion(candidateVersion);
  return Boolean(
    installed
    && candidate
    && installed.major === candidate.major
    && installed.minor === candidate.minor
    && candidate.patch > installed.patch,
  );
}

function compareSemanticVersions(leftVersion: string, rightVersion: string): -1 | 0 | 1 | null {
  if (leftVersion === rightVersion) return 0;
  const left = parseSemanticVersion(leftVersion);
  const right = parseSemanticVersion(rightVersion);
  if (!left || !right) return null;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}

function parseSemanticVersion(value: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function mapReleaseStatus(
  status: WorkspaceSkillSnapshot["skills"][number]["releases"][number]["status"],
): WorkspaceSkillReleaseStatus {
  if (status === "installed") return WorkspaceSkillReleaseStatus.INSTALLED;
  if (status === "candidate") return WorkspaceSkillReleaseStatus.CANDIDATE;
  if (status === "superseded") return WorkspaceSkillReleaseStatus.SUPERSEDED;
  return WorkspaceSkillReleaseStatus.REJECTED;
}

function snapshotUsesSkill(snapshot: Prisma.JsonValue, slug: string, version: string | null) {
  const root = asRecord(snapshot);
  if (!Array.isArray(root?.skills)) return false;
  return root.skills.some((entry) => {
    const skill = asRecord(entry);
    return readString(skill?.slug) === slug
      && skill?.enabled !== false
      && (!version || readString(skill?.version) === version);
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 64)
    : [];
}

function serializeRegistryTrustEvidence(
  trust: ClawHubRegistryTrust,
): Prisma.InputJsonObject {
  return {
    source: trust.source,
    version: trust.version,
    verified: trust.verified,
    decision: trust.decision,
    securityStatus: trust.securityStatus,
    exactVersionMatch: trust.exactVersionMatch,
    exactPublisherMatch: trust.exactPublisherMatch,
    skillManifestFetched: trust.skillManifestFetched,
    skillManifestParsed: trust.skillManifestParsed,
    skillManifestDigest: trust.skillManifestDigest,
    metadataOnlyAutoUpdateEligible: trust.metadataOnlyAutoUpdateEligible,
    reasons: trust.reasons,
    checkedAt: trust.checkedAt ?? null,
    provenance: trust.provenance ?? null,
  };
}

function serializeRuntimeRequirements(
  requirements: ClawHubRuntimeRequirements,
): Prisma.InputJsonObject {
  const normalized = normalizeRuntimeRequirements(requirements);
  return {
    requiredEnv: normalized.requiredEnv,
    optionalEnv: normalized.optionalEnv,
    requiredBins: normalized.requiredBins,
    anyBins: normalized.anyBins,
    configPaths: normalized.configPaths,
    operatingSystems: normalized.operatingSystems,
    installKinds: normalized.installKinds,
    primaryEnv: normalized.primaryEnv ?? null,
    always: normalized.always,
  };
}

function toWorkspaceRegistryTrust(
  source: string | null | undefined,
  verified: boolean,
  autoUpdateEligible: boolean,
  evidenceValue: unknown,
): WorkspaceSkillSnapshot["skills"][number]["releases"][number]["registryTrust"] {
  const evidence = asRecord(evidenceValue);
  const normalizedSource = source ?? readString(evidence?.source);
  if (!normalizedSource && !evidence) return null;
  const checkedAt = evidence?.checkedAt;
  return {
    source: normalizedSource ?? "unknown",
    verified,
    autoUpdateEligible,
    decision: readString(evidence?.decision) ?? "unknown",
    securityStatus: readString(evidence?.securityStatus) ?? "unknown",
    exactVersionMatch: evidence?.exactVersionMatch === true,
    exactPublisherMatch: evidence?.exactPublisherMatch === true,
    skillManifestFetched: evidence?.skillManifestFetched === true,
    skillManifestParsed: evidence?.skillManifestParsed === true,
    skillManifestDigest: readString(evidence?.skillManifestDigest),
    reasons: readStringArray(evidence?.reasons),
    checkedAt: typeof checkedAt === "number" && Number.isFinite(checkedAt) ? checkedAt : null,
  };
}

export function parseWorkspaceSkillRuntimeRequirements(value: unknown): ClawHubRuntimeRequirements | null {
  const record = asRecord(value);
  if (!record) return null;
  const installKinds = readStringArray(record.installKinds)
    .filter((kind): kind is ClawHubRuntimeRequirements["installKinds"][number] =>
      kind === "brew" || kind === "node" || kind === "go" || kind === "uv",
    );
  const primaryEnv = readString(record.primaryEnv);
  return {
    requiredEnv: readStringArray(record.requiredEnv),
    optionalEnv: readStringArray(record.optionalEnv),
    requiredBins: readStringArray(record.requiredBins),
    anyBins: readStringArray(record.anyBins),
    configPaths: readStringArray(record.configPaths),
    operatingSystems: readStringArray(record.operatingSystems),
    installKinds,
    ...(primaryEnv ? { primaryEnv } : {}),
    always: record.always === true,
  };
}

const parseRuntimeRequirements = parseWorkspaceSkillRuntimeRequirements;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getDemoWorkspaceSkillSnapshot(activeRepresentativeSlug: string): WorkspaceSkillSnapshot | null {
  if (activeRepresentativeSlug !== demoRepresentative.slug) return null;
  if (!demoInstalls) {
    demoInstalls = demoRepresentative.skillPacks
      .filter((pack) => pack.installStatus !== "available")
      .map((pack) => ({
        installId: `demo-install:${pack.slug}`,
        skillPackId: pack.id,
        slug: pack.slug,
        displayName: pack.displayName,
        summary: pack.summary,
        source: pack.source,
        installedVersion: pack.version ?? null,
        latestVersion: pack.version ?? null,
        installedAt: new Date(0).toISOString(),
        sourceUrl: pack.sourceUrl ?? null,
        ownerHandle: pack.ownerHandle ?? null,
        verificationTier: pack.verificationTier ?? null,
        capabilityTags: [...pack.capabilityTags],
        requirements: deriveWorkspaceSkillRequirements(pack.capabilityTags),
        risk: deriveWorkspaceSkillRisk(mapSource(pack.source), pack.executesCode, deriveWorkspaceSkillRequirements(pack.capabilityTags)),
        executesCode: pack.executesCode,
        status: pack.installStatus === "update_available" ? "update_available" : "installed",
        reviewStatus: "approved",
        updatePolicy: "review_required",
        readiness: pack.enabled ? "ready" : "needs_setup",
        readinessReason: pack.enabled ? "Enabled for the demo representative." : "Not enabled for a representative.",
        recentCalls: [],
        releases: [{
          id: `demo-release:${pack.slug}:${pack.version ?? "unversioned"}`,
          version: pack.version ?? "unversioned",
          status: "installed" as const,
          displayName: pack.displayName,
          summary: pack.summary,
          capabilityTags: [...pack.capabilityTags],
          executesCode: pack.executesCode,
          provenanceDigest: buildSkillReleaseDigest(pack),
          signatureStatus: "unavailable" as const,
          signatureAlgorithm: null,
          signatureKeyId: null,
          sbomUrl: null,
          attestationUrl: null,
          registryTrust: null,
          runtimeRequirements: null,
          runtimeRequirementDiff: { added: [], removed: [], changed: false },
          permissionDiff: { added: [], removed: [] },
          autoUpdate: { eligible: false, reason: "Only candidate patch releases can be adopted automatically." },
          reviewedBy: "local-owner",
          reviewedAt: new Date(0).toISOString(),
          reviewNote: null,
          discoveredAt: new Date(0).toISOString(),
          adoptedAt: new Date(0).toISOString(),
        }],
        impact: {
          enabledBindings: pack.enabled ? 1 : 0,
          publishedRepresentatives: [],
        },
        bindings: pack.enabled ? [{
          linkId: `demo-binding:${pack.slug}`,
          representativeId: demoRepresentative.id,
          representativeSlug: demoRepresentative.slug,
          representativeName: demoRepresentative.name,
          enabled: true,
          ready: true,
          issue: null,
        }] : [],
      }));
  }
  const policy: WorkspaceSkillSnapshot["policy"] = {
    defaultDecision: "ask",
    networkMode: "no_network",
    filesystemMode: "workspace_only",
    capabilityModes: { exec: "ask", read: "allow", write: "ask", process: "ask", browser: "ask", mcp: "ask" },
  };
  const skills = demoInstalls ?? [];
  return {
    workspace: { ownerId: "local-owner", representativeCount: 1 },
    activeRepresentative: {
      slug: demoRepresentative.slug,
      displayName: demoRepresentative.name,
      declaredOutcomes: [...demoRepresentative.skills],
      computeEnabled: false,
    },
    metrics: {
      installed: skills.filter((skill) => skill.status !== "archived").length,
      enabledBindings: skills.reduce((sum, skill) => sum + skill.bindings.filter((binding) => binding.enabled).length, 0),
      approvalProtected: 5,
      updates: skills.filter((skill) => skill.status === "update_available").length,
      unhealthyConnections: 0,
    },
    representatives: [{ id: demoRepresentative.id, slug: demoRepresentative.slug, displayName: demoRepresentative.name }],
    skills,
    connections: [],
    policy,
    auditEvents: [],
  };
}

function serializeDemoDiscoveredSkill(discovered: NonNullable<Awaited<ReturnType<typeof fetchClawHubRepresentativeSkill>>>): WorkspaceSkillSnapshot["skills"][number] {
  const requirements = deriveWorkspaceSkillRequirements(discovered.capabilityTags);
  return {
    installId: `demo-install:${discovered.slug}`,
    skillPackId: discovered.id,
    slug: discovered.slug,
    displayName: discovered.displayName,
    summary: discovered.summary,
    source: "clawhub",
    installedVersion: discovered.version ?? null,
    latestVersion: discovered.version ?? null,
    installedAt: new Date().toISOString(),
    sourceUrl: discovered.sourceUrl ?? null,
    ownerHandle: discovered.ownerHandle ?? null,
    verificationTier: discovered.verificationTier ?? null,
    capabilityTags: [...discovered.capabilityTags],
    requirements,
    risk: deriveWorkspaceSkillRisk(SkillPackSource.CLAWHUB, false, requirements),
    executesCode: false,
    status: "installed",
    reviewStatus: "approved",
    updatePolicy: "review_required",
    readiness: "needs_setup",
    readinessReason: "Installed in the workspace but not enabled for a representative.",
    recentCalls: [],
    releases: [{
      id: `demo-release:${discovered.slug}:${discovered.version ?? "unversioned"}`,
      version: discovered.version ?? "unversioned",
      status: "installed",
      displayName: discovered.displayName,
      summary: discovered.summary,
      capabilityTags: [...discovered.capabilityTags],
      executesCode: false,
      provenanceDigest: buildSkillReleaseDigest({
        ...discovered,
        manifestDigest: discovered.registryTrust.skillManifestDigest,
      }),
      signatureStatus: "unavailable",
      signatureAlgorithm: null,
      signatureKeyId: null,
      sbomUrl: null,
      attestationUrl: null,
      registryTrust: toWorkspaceRegistryTrust(
        discovered.registryTrust.source,
        discovered.registryTrust.verified,
        discovered.registryTrust.metadataOnlyAutoUpdateEligible,
        serializeRegistryTrustEvidence(discovered.registryTrust),
      ),
      runtimeRequirements: discovered.runtimeRequirements,
      runtimeRequirementDiff: { added: [], removed: [], changed: false },
      permissionDiff: { added: [], removed: [] },
      autoUpdate: { eligible: false, reason: "Only candidate patch releases can be adopted automatically." },
      reviewedBy: "local-owner",
      reviewedAt: new Date().toISOString(),
      reviewNote: null,
      discoveredAt: new Date().toISOString(),
      adoptedAt: new Date().toISOString(),
    }],
    impact: { enabledBindings: 0, publishedRepresentatives: [] },
    bindings: [],
  };
}

function mapSource(source: "builtin" | "owner_upload" | "clawhub"): SkillPackSource {
  if (source === "clawhub") return SkillPackSource.CLAWHUB;
  if (source === "owner_upload") return SkillPackSource.OWNER_UPLOAD;
  return SkillPackSource.BUILTIN;
}

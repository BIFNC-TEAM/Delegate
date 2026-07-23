import {
  EventType,
  SkillPackSource,
  WorkspaceSkillInstallStatus,
  WorkspaceSkillReleaseStatus,
  WorkspaceSkillReviewStatus,
  WorkspaceSkillSignatureStatus,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { prisma } from "../src/prisma";
import {
  buildSkillReleaseDigest,
  reviewWorkspaceSkillRelease,
} from "../src/workspace-skills";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("workspace skill PostgreSQL trust refresh", () => {
  it("preserves state on a revoked verdict and adopts only after fresh exact trust", async () => {
    const fixture = await createTrustRefreshFixture();

    try {
      await expect(reviewWorkspaceSkillRelease({
        ownerId: fixture.ownerId,
        activeRepresentativeSlug: fixture.representativeSlug,
        installId: fixture.installId,
        releaseId: fixture.candidateReleaseId,
        action: "adopt",
        reviewedBy: fixture.ownerId,
        registryTrustFetch: async () => ({
          slug: fixture.skillReference,
          ownerHandle: fixture.ownerHandle,
          version: fixture.candidateVersion,
          runtimeRequirements: emptyRuntimeRequirements(),
          registryTrust: registryTrust({
            version: fixture.candidateVersion,
            manifestDigest: fixture.manifestDigest,
            decision: "fail",
            securityStatus: "malicious",
            verified: false,
            eligible: false,
            reasons: ["verify.not_clean"],
          }),
        }),
      })).rejects.toThrow("official Registry verification returned fail");

      await expectFixtureState(fixture, {
        installedStatus: WorkspaceSkillReleaseStatus.INSTALLED,
        candidateStatus: WorkspaceSkillReleaseStatus.CANDIDATE,
        bindingEnabled: true,
        approvalStatus: "PENDING",
      });

      await reviewWorkspaceSkillRelease({
        ownerId: fixture.ownerId,
        activeRepresentativeSlug: fixture.representativeSlug,
        installId: fixture.installId,
        releaseId: fixture.candidateReleaseId,
        action: "adopt",
        reviewedBy: fixture.ownerId,
        registryTrustFetch: async () => ({
          slug: fixture.skillReference,
          ownerHandle: fixture.ownerHandle,
          version: fixture.candidateVersion,
          runtimeRequirements: emptyRuntimeRequirements(),
          registryTrust: registryTrust({
            version: fixture.candidateVersion,
            manifestDigest: fixture.manifestDigest,
          }),
        }),
      });

      await expectFixtureState(fixture, {
        installedStatus: WorkspaceSkillReleaseStatus.SUPERSEDED,
        candidateStatus: WorkspaceSkillReleaseStatus.INSTALLED,
        bindingEnabled: true,
        approvalStatus: "APPROVED",
      });
    } finally {
      await deleteTrustRefreshFixture(fixture);
    }
  });
});

async function createTrustRefreshFixture() {
  const representative = await prisma.representative.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true, ownerId: true, slug: true },
  });
  if (!representative) {
    throw new Error("PostgreSQL skill trust E2E requires one seeded representative.");
  }

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const ownerHandle = `trust-${suffix}`.slice(0, 48);
  const skillReference = `@${ownerHandle}/postgres-trust`;
  const installedVersion = "1.0.0";
  const candidateVersion = "1.0.1";
  const manifestDigest = `sha256:${"a".repeat(64)}`;
  const releaseMetadata = {
    slug: skillReference,
    displayName: "PostgreSQL trust refresh probe",
    summary: "Verifies exact-version trust immediately before adoption.",
    sourceUrl: `https://clawhub.ai/${ownerHandle}/postgres-trust`,
    ownerHandle,
    verificationTier: "clawhub-verified",
    capabilityTags: [] as string[],
    executesCode: false,
    runtimeRequirements: emptyRuntimeRequirements(),
    manifestDigest,
  };
  const installedDigest = buildSkillReleaseDigest({
    ...releaseMetadata,
    version: installedVersion,
  });
  const candidateDigest = buildSkillReleaseDigest({
    ...releaseMetadata,
    version: candidateVersion,
  });

  const skillPack = await prisma.skillPack.create({
    data: {
      source: SkillPackSource.CLAWHUB,
      slug: skillReference,
      displayName: releaseMetadata.displayName,
      summary: releaseMetadata.summary,
      version: candidateVersion,
      sourceUrl: releaseMetadata.sourceUrl,
      ownerHandle,
      verificationTier: releaseMetadata.verificationTier,
      capabilityTags: [],
      executesCode: false,
    },
  });
  const install = await prisma.workspaceSkillInstall.create({
    data: {
      ownerId: representative.ownerId,
      skillPackId: skillPack.id,
      status: WorkspaceSkillInstallStatus.UPDATE_AVAILABLE,
      reviewStatus: WorkspaceSkillReviewStatus.NEEDS_REVIEW,
      installedVersion,
      installedBy: representative.ownerId,
    },
  });
  const installedRelease = await prisma.workspaceSkillRelease.create({
    data: {
      installId: install.id,
      version: installedVersion,
      status: WorkspaceSkillReleaseStatus.INSTALLED,
      displayName: releaseMetadata.displayName,
      summary: releaseMetadata.summary,
      sourceUrl: releaseMetadata.sourceUrl,
      ownerHandle,
      verificationTier: releaseMetadata.verificationTier,
      capabilityTags: [],
      executesCode: false,
      provenanceDigest: installedDigest,
      signatureStatus: WorkspaceSkillSignatureStatus.UNAVAILABLE,
      registryTrustSource: "clawhub-verify-v1",
      registryVerified: true,
      registryTrustEligible: true,
      registryTrustEvidence: registryTrustEvidence(
        installedVersion,
        manifestDigest,
      ),
      runtimeRequirements: emptyRuntimeRequirements(),
      adoptedAt: new Date(),
    },
  });
  const candidateRelease = await prisma.workspaceSkillRelease.create({
    data: {
      installId: install.id,
      version: candidateVersion,
      status: WorkspaceSkillReleaseStatus.CANDIDATE,
      displayName: releaseMetadata.displayName,
      summary: releaseMetadata.summary,
      sourceUrl: releaseMetadata.sourceUrl,
      ownerHandle,
      verificationTier: releaseMetadata.verificationTier,
      capabilityTags: [],
      executesCode: false,
      provenanceDigest: candidateDigest,
      signatureStatus: WorkspaceSkillSignatureStatus.UNAVAILABLE,
      registryTrustSource: "clawhub-verify-v1",
      registryVerified: true,
      registryTrustEligible: true,
      registryTrustEvidence: registryTrustEvidence(
        candidateVersion,
        manifestDigest,
      ),
      runtimeRequirements: emptyRuntimeRequirements(),
    },
  });
  const binding = await prisma.representativeSkillPack.create({
    data: {
      representativeId: representative.id,
      skillPackId: skillPack.id,
      workspaceInstallId: install.id,
      enabled: true,
      installStatus: "update_available",
      installedVersion,
      installedAt: new Date(),
    },
  });
  const approval = await prisma.approvalRequest.create({
    data: {
      representativeId: representative.id,
      workspaceSkillReleaseId: candidateRelease.id,
      reason: "skill_version_update_review",
      requestedActionSummary: `Review ${candidateVersion}`,
      riskSummary: "PostgreSQL exact-version trust refresh probe.",
      requestPayloadHash: candidateDigest,
      matchedPolicyRuleId: "workspace-skill:review_required",
    },
  });

  return {
    representativeId: representative.id,
    representativeSlug: representative.slug,
    ownerId: representative.ownerId,
    ownerHandle,
    skillReference,
    skillPackId: skillPack.id,
    installId: install.id,
    installedReleaseId: installedRelease.id,
    candidateReleaseId: candidateRelease.id,
    bindingId: binding.id,
    approvalId: approval.id,
    installedVersion,
    candidateVersion,
    manifestDigest,
  };
}

async function expectFixtureState(
  fixture: Awaited<ReturnType<typeof createTrustRefreshFixture>>,
  expected: {
    installedStatus: WorkspaceSkillReleaseStatus;
    candidateStatus: WorkspaceSkillReleaseStatus;
    bindingEnabled: boolean;
    approvalStatus: "PENDING" | "APPROVED";
  },
) {
  const [installed, candidate, binding, approval] = await Promise.all([
    prisma.workspaceSkillRelease.findUniqueOrThrow({
      where: { id: fixture.installedReleaseId },
      select: { status: true },
    }),
    prisma.workspaceSkillRelease.findUniqueOrThrow({
      where: { id: fixture.candidateReleaseId },
      select: { status: true },
    }),
    prisma.representativeSkillPack.findUniqueOrThrow({
      where: { id: fixture.bindingId },
      select: { enabled: true },
    }),
    prisma.approvalRequest.findUniqueOrThrow({
      where: { id: fixture.approvalId },
      select: { status: true },
    }),
  ]);

  expect(installed.status).toBe(expected.installedStatus);
  expect(candidate.status).toBe(expected.candidateStatus);
  expect(binding.enabled).toBe(expected.bindingEnabled);
  expect(approval.status).toBe(expected.approvalStatus);
}

async function deleteTrustRefreshFixture(
  fixture: Awaited<ReturnType<typeof createTrustRefreshFixture>>,
) {
  await prisma.eventAudit.deleteMany({
    where: {
      representativeId: fixture.representativeId,
      type: EventType.SKILL_VERSION_ADOPTED,
      payload: {
        path: ["installId"],
        equals: fixture.installId,
      },
    },
  });
  await prisma.approvalRequest.deleteMany({
    where: { id: fixture.approvalId },
  });
  await prisma.representativeSkillPack.deleteMany({
    where: { id: fixture.bindingId },
  });
  await prisma.workspaceSkillInstall.deleteMany({
    where: { id: fixture.installId },
  });
  await prisma.skillPack.deleteMany({
    where: { id: fixture.skillPackId },
  });
}

function registryTrust(input: {
  version: string;
  manifestDigest: string;
  decision?: "pass" | "fail";
  securityStatus?: "clean" | "malicious";
  verified?: boolean;
  eligible?: boolean;
  reasons?: string[];
}) {
  return {
    source: "clawhub-verify-v1" as const,
    version: input.version,
    verified: input.verified ?? true,
    decision: input.decision ?? "pass",
    securityStatus: input.securityStatus ?? "clean",
    exactVersionMatch: true,
    exactPublisherMatch: true,
    skillManifestFetched: true,
    skillManifestParsed: true,
    skillManifestDigest: input.manifestDigest,
    metadataOnlyAutoUpdateEligible: input.eligible ?? true,
    reasons: input.reasons ?? [],
    checkedAt: Date.now(),
  };
}

function registryTrustEvidence(version: string, manifestDigest: string) {
  return registryTrust({ version, manifestDigest });
}

function emptyRuntimeRequirements() {
  return {
    requiredEnv: [],
    optionalEnv: [],
    requiredBins: [],
    anyBins: [],
    configPaths: [],
    operatingSystems: [],
    installKinds: [] as Array<"brew" | "node" | "go" | "uv">,
    always: false,
  };
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for the PostgreSQL skill trust E2E.");
  }

  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
  ) {
    return;
  }

  const databaseName = url.pathname.replace(/^\/+/u, "");
  if (
    process.env.DELEGATE_POSTGRES_E2E_ALLOW_REMOTE !== "1"
    || !/(?:^|[_-])(staging|test|rehearsal)(?:$|[_-])/iu.test(databaseName)
  ) {
    throw new Error(
      "Remote PostgreSQL E2E is blocked. Use an explicitly named staging/test/rehearsal database and set DELEGATE_POSTGRES_E2E_ALLOW_REMOTE=1.",
    );
  }
}

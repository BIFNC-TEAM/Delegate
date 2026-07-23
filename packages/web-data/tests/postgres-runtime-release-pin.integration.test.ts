import {
  EventType,
  SkillPackSource,
  WorkspaceSkillInstallStatus,
  WorkspaceSkillReleaseStatus,
  WorkspaceSkillReviewStatus,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  getRepresentativeRuntimeAuthoritySnapshot,
  getRepresentativeRuntimeSetupSnapshot,
} from "../src/representative-setup";
import { prisma } from "../src/prisma";
import { reviewWorkspaceSkillRelease } from "../src/workspace-skills";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("published representative skill release pin", () => {
  it("does not substitute v2 into a v1 snapshot and restores v1 only after rollback", async () => {
    const fixture = await createReleasePinFixture();

    try {
      await expectExactV1Authority(fixture);

      await reviewWorkspaceSkillRelease({
        ownerId: fixture.ownerId,
        activeRepresentativeSlug: fixture.representativeSlug,
        installId: fixture.installId,
        releaseId: fixture.v2ReleaseId,
        action: "adopt",
        reviewedBy: fixture.ownerId,
      });

      await expectUnavailable(fixture);

      await reviewWorkspaceSkillRelease({
        ownerId: fixture.ownerId,
        activeRepresentativeSlug: fixture.representativeSlug,
        installId: fixture.installId,
        releaseId: fixture.v1ReleaseId,
        action: "rollback",
        reviewedBy: fixture.ownerId,
      });

      await expectExactV1Authority(fixture);

      await prisma.workspaceSkillRelease.update({
        where: { id: fixture.v1ReleaseId },
        data: { executesCode: true },
      });
      await expectUnavailable(fixture);

      await prisma.workspaceSkillRelease.update({
        where: { id: fixture.v1ReleaseId },
        data: {
          executesCode: false,
          status: WorkspaceSkillReleaseStatus.SUPERSEDED,
        },
      });
      await expectUnavailable(fixture);
    } finally {
      await deleteReleasePinFixture(fixture);
    }
  });
});

async function expectExactV1Authority(
  fixture: Awaited<ReturnType<typeof createReleasePinFixture>>,
) {
  const [setup, authority] = await Promise.all([
    getRepresentativeRuntimeSetupSnapshot(
      fixture.representativeSlug,
      fixture.representativeVersionId,
    ),
    getRepresentativeRuntimeAuthoritySnapshot(
      fixture.representativeSlug,
      fixture.representativeVersionId,
    ),
  ]);

  expect(setup?.skillPacks.map((skill) => skill.version)).toEqual(["1.0.0"]);
  expect(authority?.mcpBindings.map((binding) => binding.id)).toEqual([
    fixture.mcpBindingId,
  ]);
}

async function expectUnavailable(
  fixture: Awaited<ReturnType<typeof createReleasePinFixture>>,
) {
  const [setup, authority] = await Promise.all([
    getRepresentativeRuntimeSetupSnapshot(
      fixture.representativeSlug,
      fixture.representativeVersionId,
    ),
    getRepresentativeRuntimeAuthoritySnapshot(
      fixture.representativeSlug,
      fixture.representativeVersionId,
    ),
  ]);

  expect(setup?.skillPacks).toEqual([]);
  expect(authority?.mcpBindings).toEqual([]);
}

async function createReleasePinFixture() {
  const representative = await prisma.representative.findFirst({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      ownerId: true,
      slug: true,
    },
  });
  if (!representative) {
    throw new Error(
      "PostgreSQL release-pin E2E requires one seeded representative.",
    );
  }

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const skillSlug = `postgres-release-pin-${suffix}`;
  const skillPack = await prisma.skillPack.create({
    data: {
      source: SkillPackSource.BUILTIN,
      slug: skillSlug,
      displayName: "PostgreSQL release pin probe",
      summary: "Verifies immutable representative skill release authority.",
      version: "2.0.0",
      capabilityTags: ["mcp"],
      executesCode: false,
    },
  });
  const install = await prisma.workspaceSkillInstall.create({
    data: {
      ownerId: representative.ownerId,
      skillPackId: skillPack.id,
      status: WorkspaceSkillInstallStatus.UPDATE_AVAILABLE,
      reviewStatus: WorkspaceSkillReviewStatus.NEEDS_REVIEW,
      installedVersion: "1.0.0",
      installedBy: representative.ownerId,
      installedAt: new Date(),
    },
  });
  const v1Release = await prisma.workspaceSkillRelease.create({
    data: {
      installId: install.id,
      version: "1.0.0",
      status: WorkspaceSkillReleaseStatus.INSTALLED,
      displayName: "Release pin v1",
      summary: "Published v1 release.",
      capabilityTags: ["mcp"],
      executesCode: false,
      reviewedBy: representative.ownerId,
      reviewedAt: new Date(),
      adoptedAt: new Date(),
    },
  });
  const v2Release = await prisma.workspaceSkillRelease.create({
    data: {
      installId: install.id,
      version: "2.0.0",
      status: WorkspaceSkillReleaseStatus.CANDIDATE,
      displayName: "Release pin v2",
      summary: "Candidate v2 release.",
      capabilityTags: ["mcp"],
      executesCode: false,
    },
  });
  const representativeSkillLink = await prisma.representativeSkillPack.create({
    data: {
      representativeId: representative.id,
      skillPackId: skillPack.id,
      workspaceInstallId: install.id,
      enabled: true,
      installStatus: "update_available",
      installedVersion: "1.0.0",
      installedAt: new Date(),
    },
  });
  const mcpBinding = await prisma.representativeMcpBinding.create({
    data: {
      representativeId: representative.id,
      representativeSkillPackLinkId: representativeSkillLink.id,
      slug: `release-pin-${suffix}`,
      displayName: "Release pin MCP",
      serverUrl: "https://mcp.example.com/mcp",
      allowedToolNames: ["read"],
      defaultToolName: "read",
      enabled: true,
      approvalRequired: true,
      maxRetries: 1,
      retryBackoffMs: 100,
    },
  });
  const latestVersion = await prisma.representativeVersion.findFirst({
    where: { representativeId: representative.id },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });
  const representativeVersion = await prisma.representativeVersion.create({
    data: {
      representativeId: representative.id,
      versionNumber: (latestVersion?.versionNumber ?? 0) + 1,
      publishedBy: representative.ownerId,
      changeSummary: "PostgreSQL release pin probe",
      snapshot: {
        skills: [{
          id: skillPack.id,
          slug: skillPack.slug,
          displayName: v1Release.displayName,
          source: "builtin",
          summary: v1Release.summary,
          version: v1Release.version,
          capabilityTags: ["mcp"],
          executesCode: false,
          enabled: true,
          installStatus: "installed",
        }],
        mcpBindings: [{
          id: mcpBinding.id,
          slug: mcpBinding.slug,
          serverUrl: mcpBinding.serverUrl,
          transportKind: "streamable_http",
          allowedToolNames: ["read"],
          defaultToolName: "read",
          enabled: true,
          approvalRequired: true,
          estimatedCostCentsPerCall: 0,
          maxRetries: 1,
          retryBackoffMs: 100,
          skillReleasePin: {
            linkId: representativeSkillLink.id,
            skillPackId: skillPack.id,
            source: "builtin",
            slug: skillPack.slug,
            version: "1.0.0",
          },
        }],
      },
    },
  });

  return {
    representativeId: representative.id,
    representativeSlug: representative.slug,
    representativeVersionId: representativeVersion.id,
    ownerId: representative.ownerId,
    skillPackId: skillPack.id,
    installId: install.id,
    v1ReleaseId: v1Release.id,
    v2ReleaseId: v2Release.id,
    representativeSkillLinkId: representativeSkillLink.id,
    mcpBindingId: mcpBinding.id,
  };
}

async function deleteReleasePinFixture(
  fixture: Awaited<ReturnType<typeof createReleasePinFixture>>,
) {
  await prisma.eventAudit.deleteMany({
    where: {
      representativeId: fixture.representativeId,
      type: {
        in: [
          EventType.SKILL_VERSION_ADOPTED,
          EventType.SKILL_VERSION_ROLLED_BACK,
        ],
      },
      payload: {
        path: ["installId"],
        equals: fixture.installId,
      },
    },
  });
  await prisma.representativeVersion.deleteMany({
    where: { id: fixture.representativeVersionId },
  });
  await prisma.representativeMcpBinding.deleteMany({
    where: { id: fixture.mcpBindingId },
  });
  await prisma.representativeSkillPack.deleteMany({
    where: { id: fixture.representativeSkillLinkId },
  });
  await prisma.workspaceSkillInstall.deleteMany({
    where: { id: fixture.installId },
  });
  await prisma.skillPack.deleteMany({
    where: { id: fixture.skillPackId },
  });
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for the PostgreSQL release-pin E2E.");
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

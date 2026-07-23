import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";

import {
  SkillPackSource,
  WorkspaceSkillInstallStatus,
  WorkspaceSkillReleaseStatus,
  WorkspaceSkillSignatureStatus,
  WorkspaceSkillUpdatePolicy,
  WorkspaceSkillReviewStatus,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  deriveWorkspaceSkillRequirements,
  deriveWorkspaceSkillRisk,
  buildSkillReleaseDigest,
  diffWorkspaceSkillRuntimeRequirements,
  evaluateClawHubInitialInstallTrust,
  evaluateFreshClawHubReleaseTrust,
  isWorkspaceSkillAutoAdoptionAlreadyApplied,
  isWorkspaceSkillReleaseRuntimeTrusted,
  resolveDiscoveredWorkspaceSkillReleaseStatus,
  resolveSkillAutoUpdateEligibility,
  resolveWorkspaceSkillInstallState,
  resolveWorkspaceSkillReadiness,
  shouldDisableWorkspaceSkillBindingsAfterAdoption,
  shouldCloseWorkspaceSkillCandidateAfterAdoption,
  verifyWorkspaceSkillSignature,
} from "../src/workspace-skills";

describe("workspace skill governance", () => {
  it("requires Registry trust or a verified publisher signature for ClawHub runtime use", () => {
    expect(isWorkspaceSkillReleaseRuntimeTrusted({
      source: SkillPackSource.CLAWHUB,
      executesCode: false,
      registryTrustEligible: false,
      signatureStatus: WorkspaceSkillSignatureStatus.UNVERIFIED,
    })).toBe(false);
    expect(isWorkspaceSkillReleaseRuntimeTrusted({
      source: SkillPackSource.CLAWHUB,
      executesCode: false,
      registryTrustEligible: true,
      signatureStatus: WorkspaceSkillSignatureStatus.UNAVAILABLE,
    })).toBe(true);
    expect(isWorkspaceSkillReleaseRuntimeTrusted({
      source: SkillPackSource.CLAWHUB,
      executesCode: false,
      registryTrustEligible: false,
      signatureStatus: WorkspaceSkillSignatureStatus.VERIFIED,
    })).toBe(true);
    expect(isWorkspaceSkillReleaseRuntimeTrusted({
      source: SkillPackSource.BUILTIN,
      executesCode: false,
      registryTrustEligible: false,
      signatureStatus: WorkspaceSkillSignatureStatus.UNAVAILABLE,
    })).toBe(true);
    expect(isWorkspaceSkillReleaseRuntimeTrusted({
      source: SkillPackSource.BUILTIN,
      executesCode: true,
      registryTrustEligible: true,
      signatureStatus: WorkspaceSkillSignatureStatus.VERIFIED,
    })).toBe(false);
  });

  it("auto-disables bindings only when the adopted release lacks runtime trust", () => {
    expect(shouldDisableWorkspaceSkillBindingsAfterAdoption({
      source: SkillPackSource.CLAWHUB,
      executesCode: false,
      registryTrustEligible: false,
      signatureStatus: WorkspaceSkillSignatureStatus.UNVERIFIED,
    })).toBe(true);
    expect(shouldDisableWorkspaceSkillBindingsAfterAdoption({
      source: SkillPackSource.CLAWHUB,
      executesCode: false,
      registryTrustEligible: true,
      signatureStatus: WorkspaceSkillSignatureStatus.UNVERIFIED,
    })).toBe(false);
    expect(shouldDisableWorkspaceSkillBindingsAfterAdoption({
      source: SkillPackSource.CLAWHUB,
      executesCode: false,
      registryTrustEligible: false,
      signatureStatus: WorkspaceSkillSignatureStatus.VERIFIED,
    })).toBe(false);

    const source = readFileSync(new URL("../src/workspace-skills.ts", import.meta.url), "utf8");
    expect(source).toContain("disabledBindingIds");
    expect(source).toContain("disabledBindingCount: disabledBindingIds.length");
    expect(source).toContain("...(shouldDisableBindings ? { enabled: false } : {})");
  });

  it("uses deterministic provenance digests and detects metadata changes", () => {
    const release = {
      slug: "lead-qualification",
      displayName: "Lead Qualification",
      summary: "Qualifies public leads.",
      version: "1.2.0",
      sourceUrl: "https://example.com/skills/lead-qualification",
      capabilityTags: ["lead", "read"],
      executesCode: false,
      runtimeRequirements: {
        requiredEnv: ["CRM_TOKEN"],
        optionalEnv: [],
        requiredBins: ["curl"],
        anyBins: [],
        configPaths: ["~/.config/crm.json"],
        operatingSystems: ["darwin", "linux"],
        installKinds: ["brew" as const],
        primaryEnv: "CRM_TOKEN",
        always: false,
      },
      manifestDigest: "sha256:manifest-a",
    };
    expect(buildSkillReleaseDigest(release)).toBe(buildSkillReleaseDigest({
      ...release,
      capabilityTags: ["read", "lead"],
    }));
    expect(buildSkillReleaseDigest({ ...release, summary: "Changed summary." })).not.toBe(
      buildSkillReleaseDigest(release),
    );
    expect(buildSkillReleaseDigest({
      ...release,
      runtimeRequirements: {
        ...release.runtimeRequirements,
        requiredEnv: ["CRM_TOKEN", "CRM_ADMIN_TOKEN"],
      },
    })).not.toBe(buildSkillReleaseDigest(release));
    expect(buildSkillReleaseDigest({
      ...release,
      runtimeRequirements: {
        ...release.runtimeRequirements,
        requiredEnv: ["CRM_TOKEN"],
        operatingSystems: ["linux", "darwin"],
      },
    })).toBe(buildSkillReleaseDigest(release));
    expect(buildSkillReleaseDigest({
      ...release,
      manifestDigest: "sha256:manifest-b",
    })).not.toBe(buildSkillReleaseDigest(release));
  });

  it("diffs every manifest runtime requirement field and treats removals as changes", () => {
    const installed = {
      requiredEnv: ["CRM_TOKEN"],
      optionalEnv: ["CRM_REGION"],
      requiredBins: ["curl"],
      anyBins: ["jq"],
      configPaths: ["~/.config/crm.json"],
      operatingSystems: ["darwin"],
      installKinds: ["brew" as const],
      primaryEnv: "CRM_TOKEN",
      always: false,
    };
    const candidate = {
      requiredEnv: ["CRM_ADMIN_TOKEN"],
      optionalEnv: [],
      requiredBins: ["curl", "node"],
      anyBins: ["yq"],
      configPaths: ["~/.config/crm-v2.json"],
      operatingSystems: ["linux"],
      installKinds: ["node" as const],
      primaryEnv: "CRM_ADMIN_TOKEN",
      always: true,
    };
    const diff = diffWorkspaceSkillRuntimeRequirements(installed, candidate);
    expect(diff.changed).toBe(true);
    expect(diff.added).toEqual(expect.arrayContaining([
      "required env: CRM_ADMIN_TOKEN",
      "required binary: node",
      "alternative binary: yq",
      "config path: ~/.config/crm-v2.json",
      "OS: linux",
      "installer: node",
      "primary env: CRM_ADMIN_TOKEN",
      "always enabled",
    ]));
    expect(diff.removed).toEqual(expect.arrayContaining([
      "required env: CRM_TOKEN",
      "optional env: CRM_REGION",
      "alternative binary: jq",
      "config path: ~/.config/crm.json",
      "OS: darwin",
      "installer: brew",
      "primary env: CRM_TOKEN",
    ]));
  });

  it("verifies Ed25519 provenance against an explicitly trusted publisher key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const provenanceDigest = "sha256:trusted-release";
    const signature = sign(null, Buffer.from(provenanceDigest), privateKey).toString("base64");
    const result = verifyWorkspaceSkillSignature({
      provenanceDigest,
      signature: { algorithm: "ed25519", keyId: "publisher-1", value: signature },
      trustedKeysJson: JSON.stringify({
        "publisher-1": publicKey.export({ type: "spki", format: "pem" }).toString(),
      }),
    });
    expect(result.status).toBe(WorkspaceSkillSignatureStatus.VERIFIED);
    expect(verifyWorkspaceSkillSignature({
      provenanceDigest: `${provenanceDigest}-tampered`,
      signature: { algorithm: "ed25519", keyId: "publisher-1", value: signature },
      trustedKeysJson: JSON.stringify({
        "publisher-1": publicKey.export({ type: "spki", format: "pem" }).toString(),
      }),
    }).status).toBe(WorkspaceSkillSignatureStatus.INVALID);
    expect(verifyWorkspaceSkillSignature({
      provenanceDigest,
      signature: { algorithm: "ed25519", keyId: "publisher-1", value: signature },
      trustedKeysJson: "{}",
    }).status).toBe(WorkspaceSkillSignatureStatus.UNVERIFIED);
  });

  it("auto-adopts only verified patch updates without new governed requirements", () => {
    expect(resolveSkillAutoUpdateEligibility({
      policy: WorkspaceSkillUpdatePolicy.PATCH_AUTO,
      installedVersion: "1.2.3",
      candidateVersion: "1.2.4",
      signatureStatus: WorkspaceSkillSignatureStatus.VERIFIED,
      addedRequirements: [],
      executesCode: false,
    }).eligible).toBe(true);
    expect(resolveSkillAutoUpdateEligibility({
      policy: WorkspaceSkillUpdatePolicy.PATCH_AUTO,
      installedVersion: "1.2.3",
      candidateVersion: "1.3.0",
      signatureStatus: WorkspaceSkillSignatureStatus.VERIFIED,
      addedRequirements: [],
      executesCode: false,
    }).eligible).toBe(false);
    expect(resolveSkillAutoUpdateEligibility({
      policy: WorkspaceSkillUpdatePolicy.PATCH_AUTO,
      installedVersion: "1.2.3",
      candidateVersion: "1.2.4-rc.1",
      signatureStatus: WorkspaceSkillSignatureStatus.VERIFIED,
      addedRequirements: [],
      executesCode: false,
    }).eligible).toBe(false);
    expect(resolveSkillAutoUpdateEligibility({
      policy: WorkspaceSkillUpdatePolicy.PATCH_AUTO,
      installedVersion: "1.2.3",
      candidateVersion: "1.2.4",
      signatureStatus: WorkspaceSkillSignatureStatus.UNVERIFIED,
      registryTrustEligible: true,
      addedRequirements: [],
      executesCode: false,
    }).eligible).toBe(true);
    expect(resolveSkillAutoUpdateEligibility({
      policy: WorkspaceSkillUpdatePolicy.PATCH_AUTO,
      installedVersion: "1.2.3",
      candidateVersion: "1.2.4",
      signatureStatus: WorkspaceSkillSignatureStatus.UNVERIFIED,
      registryTrustEligible: true,
      addedRequirements: ["mcp"],
      executesCode: false,
    }).eligible).toBe(false);
    expect(resolveSkillAutoUpdateEligibility({
      policy: WorkspaceSkillUpdatePolicy.PATCH_AUTO,
      installedVersion: "1.2.3",
      candidateVersion: "1.2.4",
      signatureStatus: WorkspaceSkillSignatureStatus.VERIFIED,
      addedRequirements: [],
      runtimeRequirementDiff: {
        added: ["required env: NEW_SECRET"],
        removed: [],
        changed: true,
      },
      executesCode: false,
    })).toMatchObject({
      eligible: false,
      reason: expect.stringContaining("manifest changes runtime requirements"),
    });
  });

  it("fails closed for incomplete, failed, suspicious, or moderation-blocked initial Registry trust", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    const trusted = {
      source: "clawhub-verify-v1" as const,
      version: "1.2.3",
      verified: true,
      decision: "pass" as const,
      securityStatus: "clean" as const,
      exactVersionMatch: true,
      exactPublisherMatch: true,
      skillManifestFetched: true,
      skillManifestParsed: true,
      skillManifestDigest: "sha256:manifest",
      metadataOnlyAutoUpdateEligible: true,
      reasons: [],
      checkedAt: now.getTime(),
    };
    const input = {
      trust: trusted,
      expectedVersion: "1.2.3",
      expectedSkillReference: "@openclaw/todoist-cli",
      refreshedSkillReference: "@openclaw/todoist-cli",
      expectedOwnerHandle: "openclaw",
      refreshedOwnerHandle: "openclaw",
      expectedManifestDigest: "sha256:manifest",
      now,
      maxAgeMs: 60 * 60 * 1000,
    };
    expect(evaluateClawHubInitialInstallTrust(input).eligible).toBe(true);
    expect(evaluateClawHubInitialInstallTrust({
      ...input,
      trust: {
        ...trusted,
        verified: false,
        metadataOnlyAutoUpdateEligible: false,
        skillManifestFetched: false,
        reasons: ["manifest.unavailable"],
      },
    }).eligible).toBe(false);
    expect(evaluateClawHubInitialInstallTrust({
      ...input,
      trust: {
        ...trusted,
        verified: false,
        decision: "fail",
        metadataOnlyAutoUpdateEligible: false,
        reasons: ["verify.not_clean"],
      },
    }).reason).toContain("returned fail");
    expect(evaluateClawHubInitialInstallTrust({
      ...input,
      trust: {
        ...trusted,
        verified: false,
        securityStatus: "malicious",
        metadataOnlyAutoUpdateEligible: false,
        reasons: ["verify.not_clean"],
      },
    }).reason).toContain("malicious");
    expect(evaluateClawHubInitialInstallTrust({
      ...input,
      trust: {
        ...trusted,
        verified: false,
        metadataOnlyAutoUpdateEligible: false,
        reasons: ["moderation.blocked"],
      },
    }).reason).toContain("moderation blocked");
    const { checkedAt: _checkedAt, ...trustWithoutCheckedAt } = trusted;
    expect(evaluateClawHubInitialInstallTrust({
      ...input,
      trust: trustWithoutCheckedAt,
    }).reason).toContain("timestamp is missing");
    expect(evaluateClawHubInitialInstallTrust({
      ...input,
      trust: {
        ...trusted,
        checkedAt: now.getTime() - 2 * 60 * 60 * 1000,
      },
    }).reason).toContain("stale");
    expect(evaluateClawHubInitialInstallTrust({
      ...input,
      trust: {
        ...trusted,
        checkedAt: now.getTime() + 1,
      },
    }).reason).toContain("future");
    expect(evaluateClawHubInitialInstallTrust({
      ...input,
      refreshedSkillReference: "@another/todoist-cli",
    }).reason).toContain("different skill reference");
    expect(evaluateClawHubInitialInstallTrust({
      ...input,
      refreshedOwnerHandle: "another",
    }).reason).toContain("different publisher");
    expect(evaluateClawHubInitialInstallTrust({
      ...input,
      expectedOwnerHandle: null,
    }).reason).toContain("publisher is missing");
    expect(evaluateClawHubInitialInstallTrust({
      ...input,
      trust: { ...trusted, version: "1.2.4" },
    }).reason).toContain("exact version");
    expect(evaluateClawHubInitialInstallTrust({
      ...input,
      trust: { ...trusted, skillManifestDigest: "sha256:changed" },
    }).reason).toContain("manifest changed");
  });

  it("requires fresh exact-version Registry evidence before adoption", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    const trusted = {
      source: "clawhub-verify-v1" as const,
      version: "1.2.3",
      verified: true,
      decision: "pass" as const,
      securityStatus: "clean" as const,
      exactVersionMatch: true,
      exactPublisherMatch: true,
      skillManifestFetched: true,
      skillManifestParsed: true,
      skillManifestDigest: "sha256:manifest",
      metadataOnlyAutoUpdateEligible: true,
      reasons: [],
      checkedAt: now.getTime(),
    };
    const input = {
      trust: trusted,
      expectedVersion: "1.2.3",
      expectedSkillReference: "@openclaw/todoist-cli",
      refreshedSkillReference: "@openclaw/todoist-cli",
      expectedOwnerHandle: "openclaw",
      refreshedOwnerHandle: "openclaw",
      expectedManifestDigest: "sha256:manifest",
      now,
      maxAgeMs: 60 * 60 * 1000,
    };
    const { checkedAt: _checkedAt, ...trustWithoutCheckedAt } = trusted;

    expect(evaluateFreshClawHubReleaseTrust(input).eligible).toBe(true);
    expect(evaluateFreshClawHubReleaseTrust({
      ...input,
      trust: trustWithoutCheckedAt,
    }).reason).toContain("timestamp is missing");
    expect(evaluateFreshClawHubReleaseTrust({
      ...input,
      trust: {
        ...trusted,
        checkedAt: now.getTime() - 2 * 60 * 60 * 1000,
      },
    }).reason).toContain("stale");
    expect(evaluateFreshClawHubReleaseTrust({
      ...input,
      trust: {
        ...trusted,
        checkedAt: now.getTime() + 10 * 60 * 1000,
      },
    }).reason).toContain("future");
    expect(evaluateFreshClawHubReleaseTrust({
      ...input,
      refreshedOwnerHandle: "another-publisher",
    }).reason).toContain("different publisher");
    expect(evaluateFreshClawHubReleaseTrust({
      ...input,
      trust: { ...trusted, version: "1.2.4" },
    }).reason).toContain("exact version");
    expect(evaluateFreshClawHubReleaseTrust({
      ...input,
      trust: { ...trusted, skillManifestDigest: "sha256:changed" },
    }).reason).toContain("manifest changed");
    expect(evaluateFreshClawHubReleaseTrust({
      ...input,
      trust: {
        ...trusted,
        verified: false,
        decision: "fail",
        securityStatus: "malicious",
        metadataOnlyAutoUpdateEligible: false,
        reasons: ["verify.not_clean"],
      },
    }).reason).toContain("returned fail");
  });

  it("refreshes ClawHub trust outside the serializable adoption transaction", () => {
    const source = readFileSync(
      new URL("../src/workspace-skills.ts", import.meta.url),
      "utf8",
    );
    const reviewStart = source.indexOf(
      "export async function reviewWorkspaceSkillRelease",
    );
    const refreshCall = source.indexOf(
      "await refreshWorkspaceSkillReleaseTrustForReview",
      reviewStart,
    );
    const transactionStart = source.indexOf(
      "return runWithPrismaWriteConflictRetry",
      refreshCall,
    );

    expect(refreshCall).toBeGreaterThan(reviewStart);
    expect(transactionStart).toBeGreaterThan(refreshCall);
    expect(source).toContain(
      "This release changed while its trust was being refreshed",
    );
    expect(source).toContain(
      "registryTrustEvidence: trustRefresh.registryTrustEvidence",
    );
  });

  it("enforces one installed release per workspace installation in the migration", () => {
    const migration = readFileSync(
      new URL("../../../prisma/migrations/20260723143000_workspace_skill_release_governance/migration.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain('WorkspaceSkillRelease_one_installed_per_install_key');
    expect(migration).toContain('WHERE "status" = \'INSTALLED\'');
  });

  it("backfills candidate approvals and adds a representative-time audit index", () => {
    const releaseMigration = readFileSync(
      new URL("../../../prisma/migrations/20260723143000_workspace_skill_release_governance/migration.sql", import.meta.url),
      "utf8",
    );
    const migration = readFileSync(
      new URL("../../../prisma/migrations/20260723173000_workspace_skill_decision_governance/migration.sql", import.meta.url),
      "utf8",
    );
    expect(releaseMigration).toContain("'CANDIDATE'::\"WorkspaceSkillReleaseStatus\"");
    expect(releaseMigration).toContain("normalize it to");
    expect(migration).toContain('ApprovalRequest_workspaceSkillReleaseId_key');
    expect(migration).toContain("skill_version_update_review");
    expect(migration).toContain('EventAudit_representativeId_createdAt_idx');
    expect(migration).toContain("a workspace installation's mutable status is a");
  });

  it("persists official Registry trust separately from optional publisher signatures", () => {
    const migration = readFileSync(
      new URL("../../../prisma/migrations/20260723210000_workspace_skill_registry_trust/migration.sql", import.meta.url),
      "utf8",
    );
    const quarantineMigration = readFileSync(
      new URL("../../../prisma/migrations/20260723215000_quarantine_legacy_clawhub_installs/migration.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain('"registryTrustSource"');
    expect(migration).toContain('"registryTrustEligible"');
    expect(migration).toContain('"registryTrustEvidence"');
    expect(migration).toContain('"runtimeRequirements"');
    expect(quarantineMigration).toContain("'NEEDS_REVIEW'::\"WorkspaceSkillReviewStatus\"");
    expect(quarantineMigration).toContain('SET "enabled" = false');
    expect(quarantineMigration).toContain('"registryTrustEligible" = true');
  });

  it("creates workspace installations for default skills on representative creation", () => {
    const source = readFileSync(new URL("../src/representative-setup.ts", import.meta.url), "utf8");
    const creationLoop = source.match(/for \(const pack of demoRepresentative\.skillPacks\)[\s\S]*?const createdRepresentative/)?.[0] ?? "";

    expect(creationLoop).toContain("workspaceSkillInstall.upsert");
    expect(creationLoop).toContain("workspaceInstallId: workspaceInstall?.id ?? null");
  });

  it("routes legacy representative skill actions through workspace governance", () => {
    const source = readFileSync(new URL("../src/representative-skill-packs.ts", import.meta.url), "utf8");
    expect(source).toContain("installClawHubSkillForWorkspace");
    expect(source).toContain("setWorkspaceSkillRepresentativeBinding");
    expect(source).not.toContain("workspaceSkillRelease.updateMany");
  });

  it("preserves an immutable installed release when registry metadata changes without a version bump", () => {
    const source = readFileSync(new URL("../src/workspace-skills.ts", import.meta.url), "utf8");
    expect(source).toContain("Registry metadata or manifest requirements changed without a version bump");
    expect(source).toContain("existingDigest !== provenanceDigest");
    expect(source).toContain("runtimeRequirements: parseRuntimeRequirements");
  });

  it("keeps rejected releases closed and resolves obsolete candidate approvals", () => {
    const source = readFileSync(new URL("../src/workspace-skills.ts", import.meta.url), "utf8");
    expect(source).toContain("resolveDiscoveredWorkspaceSkillReleaseStatus");
    expect(source).toContain("This exact release was previously rejected by the workspace owner.");
    expect(source).toContain("Superseded by adopted release");
  });

  it("derives workspace update state exclusively from that install's release rows", () => {
    const source = readFileSync(new URL("../src/workspace-skills.ts", import.meta.url), "utf8");
    expect(source).not.toContain("hasNewerRegistryVersion");
    expect(source).not.toContain("release.install.skillPack.version");
    expect(resolveWorkspaceSkillInstallState({
      archived: false,
      releaseStatuses: [
        WorkspaceSkillReleaseStatus.INSTALLED,
        WorkspaceSkillReleaseStatus.CANDIDATE,
      ],
    })).toEqual({
      status: WorkspaceSkillInstallStatus.UPDATE_AVAILABLE,
      reviewStatus: WorkspaceSkillReviewStatus.NEEDS_REVIEW,
    });
    expect(resolveWorkspaceSkillInstallState({
      archived: false,
      releaseStatuses: [
        WorkspaceSkillReleaseStatus.INSTALLED,
        WorkspaceSkillReleaseStatus.REJECTED,
        WorkspaceSkillReleaseStatus.SUPERSEDED,
      ],
    })).toEqual({
      status: WorkspaceSkillInstallStatus.INSTALLED,
      reviewStatus: WorkspaceSkillReviewStatus.APPROVED,
    });
    expect(resolveWorkspaceSkillInstallState({
      archived: true,
      releaseStatuses: [
        WorkspaceSkillReleaseStatus.INSTALLED,
        WorkspaceSkillReleaseStatus.CANDIDATE,
      ],
    })).toEqual({
      status: WorkspaceSkillInstallStatus.ARCHIVED,
      reviewStatus: WorkspaceSkillReviewStatus.APPROVED,
    });
  });

  it("keeps current, stale, and rejected rediscoveries from reopening updates", () => {
    expect(resolveDiscoveredWorkspaceSkillReleaseStatus({
      installedVersion: "2.0.0",
      discoveredVersion: "2.0.0",
      existingStatus: WorkspaceSkillReleaseStatus.INSTALLED,
    })).toBe(WorkspaceSkillReleaseStatus.INSTALLED);
    expect(resolveDiscoveredWorkspaceSkillReleaseStatus({
      installedVersion: "2.0.0",
      discoveredVersion: "1.9.0",
    })).toBe(WorkspaceSkillReleaseStatus.SUPERSEDED);
    expect(resolveDiscoveredWorkspaceSkillReleaseStatus({
      installedVersion: "2.0.0",
      discoveredVersion: "1.9.0",
      existingStatus: WorkspaceSkillReleaseStatus.CANDIDATE,
    })).toBe(WorkspaceSkillReleaseStatus.SUPERSEDED);
    expect(resolveDiscoveredWorkspaceSkillReleaseStatus({
      installedVersion: "2.0.0",
      discoveredVersion: "2.1.0",
      existingStatus: WorkspaceSkillReleaseStatus.REJECTED,
    })).toBe(WorkspaceSkillReleaseStatus.REJECTED);
    expect(resolveDiscoveredWorkspaceSkillReleaseStatus({
      installedVersion: "2.0.0",
      discoveredVersion: "2.1.0",
    })).toBe(WorkspaceSkillReleaseStatus.CANDIDATE);
  });

  it("closes only candidates made obsolete by an adopted release", () => {
    expect(shouldCloseWorkspaceSkillCandidateAfterAdoption("1.1.0", "1.2.0")).toBe(true);
    expect(shouldCloseWorkspaceSkillCandidateAfterAdoption("1.2.0", "1.2.0")).toBe(true);
    expect(shouldCloseWorkspaceSkillCandidateAfterAdoption("1.3.0", "1.2.0")).toBe(false);
    expect(shouldCloseWorkspaceSkillCandidateAfterAdoption("nightly", "1.2.0")).toBe(false);
  });

  it("treats only a concurrently completed automatic adoption as idempotent", () => {
    const applied = {
      requireAutoEligibility: true,
      action: "adopt" as const,
      requestedReleaseId: "release-2",
      requestedReleaseStatus: WorkspaceSkillReleaseStatus.INSTALLED,
      requestedVersion: "1.0.1",
      installedReleaseId: "release-2",
      installedVersion: "1.0.1",
    };
    expect(isWorkspaceSkillAutoAdoptionAlreadyApplied(applied)).toBe(true);
    expect(isWorkspaceSkillAutoAdoptionAlreadyApplied({
      ...applied,
      requireAutoEligibility: false,
    })).toBe(false);
    expect(isWorkspaceSkillAutoAdoptionAlreadyApplied({
      ...applied,
      installedReleaseId: "release-1",
    })).toBe(false);
    expect(isWorkspaceSkillAutoAdoptionAlreadyApplied({
      ...applied,
      installedVersion: "1.0.0",
    })).toBe(false);
    expect(isWorkspaceSkillAutoAdoptionAlreadyApplied({
      ...applied,
      action: "rollback",
    })).toBe(false);
  });

  it("keeps a newer candidate pending when an earlier candidate is adopted", () => {
    const afterAdoption = [
      { version: "1.0.0", status: WorkspaceSkillReleaseStatus.SUPERSEDED },
      { version: "1.1.0", status: WorkspaceSkillReleaseStatus.INSTALLED },
      { version: "1.2.0", status: WorkspaceSkillReleaseStatus.CANDIDATE },
    ];
    expect(resolveWorkspaceSkillInstallState({
      archived: false,
      releaseStatuses: afterAdoption.map((release) => release.status),
    })).toEqual({
      status: WorkspaceSkillInstallStatus.UPDATE_AVAILABLE,
      reviewStatus: WorkspaceSkillReviewStatus.NEEDS_REVIEW,
    });
    expect(shouldCloseWorkspaceSkillCandidateAfterAdoption("1.2.0", "1.1.0")).toBe(false);
  });

  it("guards archived installations from discovery and release review paths", () => {
    const source = readFileSync(new URL("../src/workspace-skills.ts", import.meta.url), "utf8");
    expect(source).toContain("Restore this archived workspace skill before checking for updates.");
    expect(source).toContain("Archived workspace skills must be explicitly restored before reviewing releases.");
    expect(source).toContain("Closed because the workspace skill installation was archived.");
  });

  it("derives only explicit runtime capability requirements", () => {
    expect(deriveWorkspaceSkillRequirements(["research", "browser", "crm-mcp", "write-files"])).toEqual([
      "write",
      "browser",
      "mcp",
    ]);
    expect(deriveWorkspaceSkillRequirements(["calendar", "qualification"])).toEqual([]);
  });

  it("raises risk for external provenance and privileged capabilities", () => {
    expect(deriveWorkspaceSkillRisk(SkillPackSource.BUILTIN, false, [])).toBe("low");
    expect(deriveWorkspaceSkillRisk(SkillPackSource.CLAWHUB, false, [])).toBe("medium");
    expect(deriveWorkspaceSkillRisk(SkillPackSource.BUILTIN, false, ["write"])).toBe("high");
    expect(deriveWorkspaceSkillRisk(SkillPackSource.BUILTIN, true, [])).toBe("high");
  });

  it("blocks unreviewed installs and executable third-party packages", () => {
    const binding = [{
      linkId: "binding-1",
      representativeId: "rep-1",
      representativeSlug: "rep",
      representativeName: "Representative",
      enabled: true,
      ready: true,
      issue: null,
    }];
    expect(resolveWorkspaceSkillReadiness({
      executesCode: true,
      reviewStatus: WorkspaceSkillReviewStatus.APPROVED,
      status: WorkspaceSkillInstallStatus.INSTALLED,
      bindings: binding,
    }).status).toBe("blocked");
    expect(resolveWorkspaceSkillReadiness({
      executesCode: false,
      reviewStatus: WorkspaceSkillReviewStatus.NEEDS_REVIEW,
      status: WorkspaceSkillInstallStatus.INSTALLED,
      bindings: binding,
    }).status).toBe("blocked");
    expect(resolveWorkspaceSkillReadiness({
      executesCode: false,
      reviewStatus: WorkspaceSkillReviewStatus.APPROVED,
      status: WorkspaceSkillInstallStatus.INSTALLED,
      source: SkillPackSource.CLAWHUB,
      registryTrustEligible: false,
      bindings: binding,
    }).status).toBe("blocked");
    expect(resolveWorkspaceSkillReadiness({
      executesCode: false,
      reviewStatus: WorkspaceSkillReviewStatus.APPROVED,
      status: WorkspaceSkillInstallStatus.INSTALLED,
      source: SkillPackSource.CLAWHUB,
      registryTrustEligible: false,
      signatureStatus: WorkspaceSkillSignatureStatus.VERIFIED,
      bindings: binding,
    }).status).toBe("ready");
  });

  it("requires complete official Registry evidence before first install or binding", () => {
    const source = readFileSync(new URL("../src/workspace-skills.ts", import.meta.url), "utf8");
    expect(source).toContain("assertClawHubInitialInstallTrust({");
    expect(source).toContain("requestedSkillReference: input.skillPackSlug");
    expect(source).toContain("evaluateClawHubInitialInstallTrust({");
    expect(source).toMatch(
      /if \(!current\) \{\s+assertClawHubInitialInstallTrust\(\{/,
    );
    expect(source).toContain("does not have sufficient runtime trust evidence and cannot be enabled");
  });

  it("keeps the reviewed installed version usable while an update awaits review", () => {
    const readiness = resolveWorkspaceSkillReadiness({
      executesCode: false,
      reviewStatus: WorkspaceSkillReviewStatus.NEEDS_REVIEW,
      status: WorkspaceSkillInstallStatus.UPDATE_AVAILABLE,
      bindings: [{
        linkId: "binding-1",
        representativeId: "rep-1",
        representativeSlug: "rep",
        representativeName: "Representative",
        enabled: true,
        ready: true,
        issue: null,
      }],
    });
    expect(readiness.status).toBe("ready");
    expect(readiness.reason).toContain("installed version remains usable");
  });

  it("requires setup when an enabled binding has an unresolved connection", () => {
    expect(resolveWorkspaceSkillReadiness({
      executesCode: false,
      reviewStatus: WorkspaceSkillReviewStatus.APPROVED,
      status: WorkspaceSkillInstallStatus.INSTALLED,
      bindings: [{
        linkId: "binding-1",
        representativeId: "rep-1",
        representativeSlug: "rep",
        representativeName: "Representative",
        enabled: true,
        ready: false,
        issue: "No enabled MCP connection is linked to this binding.",
      }],
    }).status).toBe("needs_setup");
  });
});

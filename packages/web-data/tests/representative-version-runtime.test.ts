import { readFileSync } from "node:fs";

import { demoRepresentative } from "@delegate/domain";
import { describe, expect, it } from "vitest";

import {
  applyRepresentativeVersionSnapshot,
  buildComputePolicyAuditPayload,
  getPublicRepresentativeRuntime,
  getRepresentativeRuntimeAuthoritySnapshot,
  getRepresentativeRuntimeSetupSnapshot,
  resolveRepresentativeRuntimeMcpBindings,
  resolveGovernedContextEnabled,
  resolvePublicRepresentativeAvailability,
  type RepresentativeSetupSnapshot,
} from "../src/representative-setup";

function currentDraft(): RepresentativeSetupSnapshot {
  return {
    id: demoRepresentative.id,
    slug: demoRepresentative.slug,
    knowledgePackRevision: 0,
    ownerName: demoRepresentative.ownerName,
    name: "Unpublished draft name",
    tagline: "Unpublished draft tagline",
    tone: "draft tone",
    languages: ["zh-CN"],
    groupActivation: "always",
    publicMode: false,
    humanInLoop: false,
    skills: [...demoRepresentative.skills],
    skillPacks: demoRepresentative.skillPacks.map((pack) => ({
      ...pack,
      displayName: `Draft ${pack.displayName}`,
      capabilityTags: [...pack.capabilityTags],
    })),
    knowledgePack: {
      identitySummary: "Unpublished draft knowledge",
      faq: [],
      materials: [],
      policies: [],
    },
    contract: {
      ...demoRepresentative.contract,
      freeScope: [...demoRepresentative.contract.freeScope],
      paywalledIntents: [...demoRepresentative.contract.paywalledIntents],
    },
    pricing: demoRepresentative.pricing.map((plan) => ({ ...plan, stars: plan.stars + 999 })),
    handoffPrompt: "Unpublished draft handoff",
    actionGate: { ...demoRepresentative.actionGate },
    compute: {
      enabled: false,
      defaultPolicyMode: "ask",
      baseImage: "debian:bookworm-slim",
      maxSessionMinutes: 15,
      autoApproveBudgetCents: 0,
      artifactRetentionDays: 14,
      networkMode: "no_network",
      networkAllowlist: [] as string[],
      filesystemMode: "workspace_only",
      capabilityModes: {
        exec: "ask",
        read: "allow",
        write: "ask",
        process: "ask",
        browser: "ask",
        mcp: "ask",
      },
    },
    delegation: {
      enabled: true,
      naturalLanguageEnabled: true,
      explicitComputeEnabled: true,
      maxSteps: 5,
      maxCostCents: 0,
      knowledgeScope: "user_input_only",
    },
  };
}

function publishedSnapshot(pricing: unknown[], skillPacks: unknown[] = []) {
  return {
    identity: {
      displayName: "Published representative",
      roleSummary: "Published tagline",
      tone: "published tone",
      languages: ["en"],
    },
    publicMode: true,
    humanInLoop: true,
    conversation: {
      ...demoRepresentative.contract,
      handoffPrompt: "Published handoff",
    },
    governance: {
      allowedSkills: demoRepresentative.skills,
      actionGate: demoRepresentative.actionGate,
    },
    compute: {
      enabled: false,
      defaultPolicyMode: "ask",
      baseImage: "debian:bookworm-slim",
      maxSessionMinutes: 15,
      autoApproveBudgetCents: 0,
      artifactRetentionDays: 14,
      networkMode: "no_network",
      networkAllowlist: [] as string[],
      filesystemMode: "workspace_only",
      capabilityModes: {
        exec: "ask",
        read: "allow",
        write: "ask",
        process: "ask",
        browser: "ask",
        mcp: "ask",
      },
    },
    delegation: {
      enabled: true,
      naturalLanguageEnabled: true,
      explicitComputeEnabled: true,
      maxSteps: 5,
      maxCostCents: 0,
      knowledgeScope: "user_input_only",
    },
    knowledge: {
      identitySummary: "Published knowledge",
      faq: demoRepresentative.knowledgePack.faq,
      materials: [],
      policies: [],
    },
    pricing,
    skills: skillPacks,
  };
}

describe("representative published runtime snapshot", () => {
  it("does not replace an explicitly missing runtime version with the active version", async () => {
    await expect(
      getRepresentativeRuntimeSetupSnapshot("representative", null),
    ).resolves.toBeNull();
    await expect(
      getRepresentativeRuntimeAuthoritySnapshot("representative", null),
    ).resolves.toBeNull();
  });

  it("keeps unpublished dashboard edits out of the public runtime", () => {
    const current = currentDraft();
    const snapshot = publishedSnapshot(
      demoRepresentative.pricing.map((plan) => ({ ...plan })),
      [{
        ...demoRepresentative.skillPacks[0],
        capabilityTags: [...demoRepresentative.skillPacks[0]!.capabilityTags],
      }],
    );
    const runtime = applyRepresentativeVersionSnapshot(current, {
      ...snapshot,
      groupActivation: "reply_or_mention",
    });

    expect(runtime.name).toBe("Published representative");
    expect(runtime.tagline).toBe("Published tagline");
    expect(runtime.publicMode).toBe(true);
    expect(runtime.groupActivation).toBe("reply_or_mention");
    expect(runtime.knowledgePack.identitySummary).toBe("Published knowledge");
    expect(runtime.pricing).toEqual(demoRepresentative.pricing);
    expect(runtime.handoffPrompt).toBe("Published handoff");
    expect(runtime.skillPacks).toEqual([demoRepresentative.skillPacks[0]]);
  });

  it("uses one strict public gate for page and APIs", () => {
    const available = {
      lifecycleState: "PUBLISHED",
      publicMode: true,
      activeVersionId: "version-1",
      webChannelStatuses: ["CONNECTED"],
    };
    expect(resolvePublicRepresentativeAvailability(available)).toBe("available");
    expect(resolvePublicRepresentativeAvailability({ ...available, lifecycleState: "PAUSED" })).toBe("paused");
    expect(resolvePublicRepresentativeAvailability({ ...available, publicMode: false })).toBe("private");
    expect(resolvePublicRepresentativeAvailability({ ...available, activeVersionId: null })).toBe("unpublished");
    expect(resolvePublicRepresentativeAvailability({ ...available, webChannelStatuses: ["DISCONNECTED"] })).toBe("web_disabled");
  });

  it("exposes governed context only when controls and runtime prerequisites are enabled", () => {
    expect(
      resolveGovernedContextEnabled({
        openvikingEnabled: true,
        openvikingAutoRecall: true,
        environmentEnabled: true,
        modelCredentialsAvailable: true,
      }),
    ).toBe(true);
    expect(
      resolveGovernedContextEnabled({
        openvikingEnabled: true,
        openvikingAutoRecall: false,
        environmentEnabled: true,
        modelCredentialsAvailable: true,
      }),
    ).toBe(false);
    expect(
      resolveGovernedContextEnabled({
        openvikingEnabled: false,
        openvikingAutoRecall: true,
        environmentEnabled: true,
        modelCredentialsAvailable: true,
      }),
    ).toBe(false);
    expect(
      resolveGovernedContextEnabled({
        openvikingEnabled: true,
        openvikingAutoRecall: true,
        environmentEnabled: false,
        modelCredentialsAvailable: true,
      }),
    ).toBe(false);
    expect(
      resolveGovernedContextEnabled({
        openvikingEnabled: true,
        openvikingAutoRecall: true,
        environmentEnabled: true,
        modelCredentialsAvailable: false,
      }),
    ).toBe(false);
  });

  it("keeps the public demo runtime's governed context disabled", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    try {
      const runtime = await getPublicRepresentativeRuntime(
        demoRepresentative.slug,
      );
      expect(runtime.status).toBe("available");
      if (runtime.status === "available") {
        expect(runtime.governedContextEnabled).toBe(false);
      }
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });

  it("reads legacy pricing fields and uses a conservative group trigger for old versions", () => {
    const legacyPricing = demoRepresentative.pricing.map((plan) => ({
      type: plan.tier.toUpperCase(),
      name: plan.name,
      starsAmount: plan.stars,
      summary: plan.summary,
      includedReplies: plan.includedReplies,
      includesPriorityHandoff: plan.includesPriorityHandoff,
    }));
    const runtime = applyRepresentativeVersionSnapshot(
      currentDraft(),
      publishedSnapshot(legacyPricing),
    );

    expect(runtime.pricing).toEqual(demoRepresentative.pricing);
    expect(runtime.groupActivation).toBe("mention_only");
    expect(runtime.skillPacks).toEqual([]);
  });

  it("drops executable or malformed skill declarations from an immutable version", () => {
    const runtime = applyRepresentativeVersionSnapshot(
      currentDraft(),
      publishedSnapshot(demoRepresentative.pricing, [
        { ...demoRepresentative.skillPacks[0], executesCode: true },
        { slug: "incomplete" },
      ]),
    );

    expect(runtime.skillPacks).toEqual([]);
  });

  it("filters a historical skill when the current workspace no longer authorizes it", () => {
    const current = currentDraft();
    current.skillPacks = current.skillPacks.slice(1);
    const runtime = applyRepresentativeVersionSnapshot(
      current,
      publishedSnapshot(demoRepresentative.pricing, [{
        ...demoRepresentative.skillPacks[0],
        capabilityTags: [...demoRepresentative.skillPacks[0]!.capabilityTags],
      }]),
    );

    expect(runtime.skillPacks).toEqual([]);
  });

  it("pins published skill availability to the exact installed release across adopt and rollback", () => {
    const publishedV1 = {
      ...demoRepresentative.skillPacks[0]!,
      version: "1.0.0",
      capabilityTags: [...demoRepresentative.skillPacks[0]!.capabilityTags],
    };
    const current = currentDraft();
    current.skillPacks = [{
      ...publishedV1,
      version: "2.0.0",
      displayName: "Workspace release v2",
    }];
    const versionSnapshot = publishedSnapshot(
      demoRepresentative.pricing,
      [publishedV1],
    );

    // Adopting v2 makes v1 SUPERSEDED, so the old representative version
    // cannot silently borrow the current workspace release.
    expect(
      applyRepresentativeVersionSnapshot(current, versionSnapshot).skillPacks,
    ).toEqual([]);

    // Rolling the workspace back to the exact trusted/installed v1 restores
    // the old representative version without republishing it.
    current.skillPacks = [{ ...publishedV1 }];
    expect(
      applyRepresentativeVersionSnapshot(current, versionSnapshot).skillPacks,
    ).toEqual([publishedV1]);

    // A missing exact release remains unavailable.
    current.skillPacks = [];
    expect(
      applyRepresentativeVersionSnapshot(current, versionSnapshot).skillPacks,
    ).toEqual([]);
  });

  it("does not fill an empty published allowed-skill grant from the mutable draft", () => {
    const snapshot = publishedSnapshot(demoRepresentative.pricing);
    snapshot.governance.allowedSkills = [];

    expect(applyRepresentativeVersionSnapshot(currentDraft(), snapshot).skills).toEqual([]);
  });

  it("lets the current action gate tighten but never loosen the published gate", () => {
    const current = currentDraft();
    current.actionGate = {
      ...current.actionGate,
      answer_faq: "deny",
      run_local_command: "allow",
    };
    const snapshot = publishedSnapshot(demoRepresentative.pricing);
    snapshot.governance.actionGate = {
      ...demoRepresentative.actionGate,
      answer_faq: "allow",
      run_local_command: "deny",
    };

    const runtime = applyRepresentativeVersionSnapshot(current, snapshot);

    expect(runtime.actionGate.answer_faq).toBe("deny");
    expect(runtime.actionGate.run_local_command).toBe("deny");
  });

  it("uses the published compute grant as a ceiling and lets current state tighten it", () => {
    const current = currentDraft();
    current.compute = {
      enabled: true,
      defaultPolicyMode: "deny",
      baseImage: "pinned-image:v1",
      maxSessionMinutes: 10,
      autoApproveBudgetCents: 40,
      artifactRetentionDays: 7,
      networkMode: "allowlist",
      networkAllowlist: ["shared.example", "current-only.example"],
      filesystemMode: "read_only_workspace",
      capabilityModes: {
        exec: "deny",
        read: "allow",
        write: "ask",
        process: "ask",
        browser: "ask",
        mcp: "deny",
      },
    };
    const snapshot = publishedSnapshot(demoRepresentative.pricing);
    snapshot.compute = {
      enabled: true,
      defaultPolicyMode: "allow",
      baseImage: "pinned-image:v1",
      maxSessionMinutes: 30,
      autoApproveBudgetCents: 100,
      artifactRetentionDays: 30,
      networkMode: "allowlist",
      networkAllowlist: ["published-only.example", "shared.example"],
      filesystemMode: "ephemeral_full",
      capabilityModes: {
        exec: "allow",
        read: "allow",
        write: "allow",
        process: "allow",
        browser: "allow",
        mcp: "allow",
      },
    };

    const runtime = applyRepresentativeVersionSnapshot(current, snapshot);

    expect(runtime.compute).toEqual({
      enabled: true,
      defaultPolicyMode: "deny",
      baseImage: "pinned-image:v1",
      maxSessionMinutes: 10,
      autoApproveBudgetCents: 40,
      artifactRetentionDays: 7,
      networkMode: "allowlist",
      networkAllowlist: ["shared.example"],
      filesystemMode: "read_only_workspace",
      capabilityModes: {
        exec: "deny",
        read: "allow",
        write: "ask",
        process: "ask",
        browser: "ask",
        mcp: "deny",
      },
    });
  });

  it("fails compute closed for legacy snapshots or an unreviewed base-image change", () => {
    const current = currentDraft();
    current.compute.enabled = true;
    const legacy = publishedSnapshot(demoRepresentative.pricing);
    delete (legacy as { compute?: unknown }).compute;
    expect(applyRepresentativeVersionSnapshot(current, legacy).compute.enabled).toBe(false);

    const changedImage = publishedSnapshot(demoRepresentative.pricing);
    changedImage.compute = {
      ...changedImage.compute,
      enabled: true,
      baseImage: "published-image:v1",
    };
    current.compute.baseImage = "draft-image:v2";
    expect(applyRepresentativeVersionSnapshot(current, changedImage).compute.enabled).toBe(false);
  });

  it("intersects delegation quotas and knowledge scope instead of expanding them", () => {
    const current = currentDraft();
    current.delegation = {
      enabled: true,
      naturalLanguageEnabled: false,
      explicitComputeEnabled: true,
      maxSteps: 2,
      maxCostCents: 25,
      knowledgeScope: "user_input_only",
    };
    const snapshot = publishedSnapshot(demoRepresentative.pricing);
    snapshot.delegation = {
      enabled: true,
      naturalLanguageEnabled: true,
      explicitComputeEnabled: true,
      maxSteps: 5,
      maxCostCents: 100,
      knowledgeScope: "public_knowledge",
    };

    expect(applyRepresentativeVersionSnapshot(current, snapshot).delegation).toEqual({
      enabled: true,
      naturalLanguageEnabled: false,
      explicitComputeEnabled: true,
      maxSteps: 2,
      maxCostCents: 25,
      knowledgeScope: "user_input_only",
    });

    current.delegation.maxCostCents = 0;
    expect(
      applyRepresentativeVersionSnapshot(current, snapshot).delegation.maxCostCents,
    ).toBe(100);
    snapshot.delegation.maxCostCents = 0;
    current.delegation.maxCostCents = 25;
    expect(
      applyRepresentativeVersionSnapshot(current, snapshot).delegation.maxCostCents,
    ).toBe(25);
  });

  it("disables legacy delegation snapshots that do not pin a cost ceiling", () => {
    const snapshot = publishedSnapshot(demoRepresentative.pricing);
    delete (snapshot.delegation as { maxCostCents?: number }).maxCostCents;

    const runtime = applyRepresentativeVersionSnapshot(currentDraft(), snapshot);

    expect(runtime.delegation.enabled).toBe(false);
    expect(runtime.delegation.naturalLanguageEnabled).toBe(false);
    expect(runtime.delegation.explicitComputeEnabled).toBe(false);
  });

  it("intersects published and current MCP grants and drops changed endpoints", () => {
    const runtimeBindings = resolveRepresentativeRuntimeMcpBindings(
      [
        {
          id: "binding-1",
          slug: "crm",
          serverUrl: "https://mcp.example.test",
          transportKind: "STREAMABLE_HTTP",
          allowedToolNames: ["read_contact", "update_contact"],
          defaultToolName: "update_contact",
          enabled: true,
          approvalRequired: true,
          estimatedCostCentsPerCall: 8,
          maxRetries: 1,
          retryBackoffMs: 2000,
        },
        {
          id: "binding-2",
          slug: "changed",
          serverUrl: "https://changed.example.test",
          transportKind: "SSE",
          allowedToolNames: [],
          defaultToolName: null,
          enabled: true,
          approvalRequired: false,
          estimatedCostCentsPerCall: 0,
          maxRetries: 2,
          retryBackoffMs: 1000,
        },
        {
          id: "binding-3",
          slug: "disjoint",
          serverUrl: "https://disjoint.example.test",
          transportKind: "SSE",
          allowedToolNames: ["current_only"],
          defaultToolName: "current_only",
          enabled: true,
          approvalRequired: false,
          estimatedCostCentsPerCall: 0,
          maxRetries: 1,
          retryBackoffMs: 1000,
        },
      ],
      {
        mcpBindings: [
          {
            id: "binding-1",
            slug: "crm",
            serverUrl: "https://mcp.example.test",
            transportKind: "streamable_http",
            allowedToolNames: ["read_contact", "delete_contact"],
            defaultToolName: "read_contact",
            enabled: true,
            approvalRequired: false,
            estimatedCostCentsPerCall: 4,
            maxRetries: 3,
            retryBackoffMs: 500,
            skillReleasePin: null,
          },
          {
            id: "binding-2",
            slug: "changed",
            serverUrl: "https://published.example.test",
            transportKind: "sse",
            allowedToolNames: [],
            defaultToolName: null,
            enabled: true,
            approvalRequired: false,
            estimatedCostCentsPerCall: 0,
            maxRetries: 2,
            retryBackoffMs: 1000,
            skillReleasePin: null,
          },
          {
            id: "binding-3",
            slug: "disjoint",
            serverUrl: "https://disjoint.example.test",
            transportKind: "sse",
            allowedToolNames: ["published_only"],
            defaultToolName: "published_only",
            enabled: true,
            approvalRequired: false,
            estimatedCostCentsPerCall: 0,
            maxRetries: 1,
            retryBackoffMs: 1000,
            skillReleasePin: null,
          },
        ],
      },
    );

    expect(runtimeBindings).toEqual([
      {
        id: "binding-1",
        slug: "crm",
        serverUrl: "https://mcp.example.test",
        transportKind: "streamable_http",
        allowedToolNames: ["read_contact"],
        defaultToolName: "read_contact",
        enabled: true,
        approvalRequired: true,
        estimatedCostCentsPerCall: 8,
        maxRetries: 1,
        retryBackoffMs: 2000,
      },
    ]);
  });

  it("revokes linked MCP grants for an untrusted ClawHub release but accepts a verified signature", () => {
    const published = {
      skills: [{
        id: "skill-trust",
        slug: "crm-skill",
        displayName: "CRM Skill",
        source: "clawhub",
        summary: "CRM integration",
        version: "1.0.0",
        capabilityTags: ["mcp"],
        executesCode: false,
        enabled: true,
        installStatus: "installed",
      }],
      mcpBindings: [{
        id: "binding-trust",
        slug: "crm",
        serverUrl: "https://mcp.example.test",
        transportKind: "streamable_http",
        allowedToolNames: ["read_contact"],
        defaultToolName: "read_contact",
        enabled: true,
        approvalRequired: true,
        estimatedCostCentsPerCall: 0,
        maxRetries: 1,
        retryBackoffMs: 1000,
        skillReleasePin: {
          linkId: "link-trust",
          skillPackId: "skill-trust",
          source: "clawhub",
          slug: "crm-skill",
          version: "1.0.0",
        },
      }],
    };
    const binding = {
      id: "binding-trust",
      slug: "crm",
      serverUrl: "https://mcp.example.test",
      transportKind: "STREAMABLE_HTTP",
      allowedToolNames: ["read_contact"],
      defaultToolName: "read_contact",
      enabled: true,
      approvalRequired: true,
      estimatedCostCentsPerCall: 0,
      maxRetries: 1,
      retryBackoffMs: 1000,
      representativeSkillPackLink: {
        id: "link-trust",
        enabled: true,
        installedVersion: "1.0.0",
        skillPack: {
          id: "skill-trust",
          source: "CLAWHUB",
          slug: "crm-skill",
        },
        workspaceInstall: {
          status: "INSTALLED",
          reviewStatus: "APPROVED",
          installedVersion: "1.0.0",
          releases: [{
            version: "1.0.0",
            status: "INSTALLED",
            executesCode: false,
            registryTrustEligible: false,
            signatureStatus: "UNVERIFIED",
          }],
        },
      },
    };

    expect(resolveRepresentativeRuntimeMcpBindings([binding], published)).toEqual([]);
    expect(resolveRepresentativeRuntimeMcpBindings([{
      ...binding,
      representativeSkillPackLink: {
        ...binding.representativeSkillPackLink,
        workspaceInstall: {
          ...binding.representativeSkillPackLink.workspaceInstall,
          releases: [{
            version: "1.0.0",
            status: "INSTALLED",
            executesCode: false,
            registryTrustEligible: false,
            signatureStatus: "VERIFIED",
          }],
        },
      },
    }], published)).toHaveLength(1);
  });

  it("pins linked MCP authority to the published release through adopt, rollback, and missing-release states", () => {
    const published = {
      skills: [{
        id: "skill-versioned",
        slug: "versioned-skill",
        displayName: "Versioned skill",
        source: "builtin",
        summary: "Versioned MCP authority",
        version: "1.0.0",
        capabilityTags: ["mcp"],
        executesCode: false,
        enabled: true,
        installStatus: "installed",
      }],
      mcpBindings: [{
        id: "binding-versioned",
        slug: "versioned-mcp",
        serverUrl: "https://mcp.example.test",
        transportKind: "streamable_http",
        allowedToolNames: ["read"],
        defaultToolName: "read",
        enabled: true,
        approvalRequired: true,
        estimatedCostCentsPerCall: 0,
        maxRetries: 1,
        retryBackoffMs: 1000,
        skillReleasePin: {
          linkId: "link-versioned",
          skillPackId: "skill-versioned",
          source: "builtin",
          slug: "versioned-skill",
          version: "1.0.0",
        },
      }],
    };
    const currentBinding = {
      id: "binding-versioned",
      slug: "versioned-mcp",
      serverUrl: "https://mcp.example.test",
      transportKind: "STREAMABLE_HTTP",
      allowedToolNames: ["read"],
      defaultToolName: "read",
      enabled: true,
      approvalRequired: true,
      estimatedCostCentsPerCall: 0,
      maxRetries: 1,
      retryBackoffMs: 1000,
      representativeSkillPackLink: {
        id: "link-versioned",
        enabled: true,
        installedVersion: "2.0.0",
        skillPack: {
          id: "skill-versioned",
          source: "BUILTIN",
          slug: "versioned-skill",
        },
        workspaceInstall: {
          status: "INSTALLED",
          reviewStatus: "APPROVED",
          installedVersion: "2.0.0",
          releases: [{
            version: "2.0.0",
            status: "INSTALLED",
            executesCode: false,
            registryTrustEligible: true,
            signatureStatus: "UNAVAILABLE",
          }],
        },
      },
    };

    // Workspace v2 adoption must not lend v2 authority to representative v1.
    expect(
      resolveRepresentativeRuntimeMcpBindings([currentBinding], published),
    ).toEqual([]);

    const rolledBack = {
      ...currentBinding,
      representativeSkillPackLink: {
        ...currentBinding.representativeSkillPackLink,
        installedVersion: "1.0.0",
        workspaceInstall: {
          ...currentBinding.representativeSkillPackLink.workspaceInstall,
          installedVersion: "1.0.0",
          releases: [{
            version: "1.0.0",
            status: "INSTALLED",
            executesCode: false,
            registryTrustEligible: true,
            signatureStatus: "UNAVAILABLE",
          }],
        },
      },
    };
    expect(
      resolveRepresentativeRuntimeMcpBindings([rolledBack], published),
    ).toHaveLength(1);

    expect(
      resolveRepresentativeRuntimeMcpBindings([{
        ...rolledBack,
        representativeSkillPackLink: {
          ...rolledBack.representativeSkillPackLink,
          workspaceInstall: {
            ...rolledBack.representativeSkillPackLink.workspaceInstall,
            releases: [{
              ...rolledBack.representativeSkillPackLink.workspaceInstall.releases[0]!,
              status: "SUPERSEDED",
            }],
          },
        },
      }], published),
    ).toEqual([]);
    expect(
      resolveRepresentativeRuntimeMcpBindings([{
        ...rolledBack,
        representativeSkillPackLink: {
          ...rolledBack.representativeSkillPackLink,
          workspaceInstall: {
            ...rolledBack.representativeSkillPackLink.workspaceInstall,
            releases: [],
          },
        },
      }], published),
    ).toEqual([]);
  });

  it("fails legacy or direct MCP grants closed when mutable state adds a skill link", () => {
    const linkedBinding = {
      id: "binding-legacy",
      slug: "legacy",
      serverUrl: "https://mcp.example.test",
      transportKind: "STREAMABLE_HTTP",
      allowedToolNames: ["read"],
      defaultToolName: "read",
      enabled: true,
      approvalRequired: true,
      estimatedCostCentsPerCall: 0,
      maxRetries: 1,
      retryBackoffMs: 1000,
      representativeSkillPackLink: {
        id: "link-legacy",
        enabled: true,
        installedVersion: "1.0.0",
        skillPack: {
          id: "skill-legacy",
          source: "BUILTIN",
          slug: "legacy-skill",
        },
        workspaceInstall: {
          status: "INSTALLED",
          reviewStatus: "APPROVED",
          installedVersion: "1.0.0",
          releases: [{
            version: "1.0.0",
            status: "INSTALLED",
            executesCode: false,
            registryTrustEligible: true,
            signatureStatus: "UNAVAILABLE",
          }],
        },
      },
    };
    const grant = {
      id: "binding-legacy",
      slug: "legacy",
      serverUrl: "https://mcp.example.test",
      transportKind: "streamable_http",
      allowedToolNames: ["read"],
      defaultToolName: "read",
      enabled: true,
      approvalRequired: true,
      estimatedCostCentsPerCall: 0,
      maxRetries: 1,
      retryBackoffMs: 1000,
    };

    expect(resolveRepresentativeRuntimeMcpBindings(
      [linkedBinding],
      { mcpBindings: [grant] },
    )).toEqual([]);
    expect(resolveRepresentativeRuntimeMcpBindings(
      [linkedBinding],
      { mcpBindings: [{ ...grant, skillReleasePin: null }] },
    )).toEqual([]);
  });

  it("audits compute policy changes without persisting images, allowlists, or credentials", () => {
    const current = currentDraft();
    const nextCompute = {
      ...current.compute,
      baseImage: "registry.example/private/image:secret",
      networkAllowlist: ["sensitive.internal.example"],
      networkMode: "allowlist" as const,
      capabilityModes: {
        ...current.compute.capabilityModes,
        mcp: "deny" as const,
      },
    };
    const payload = buildComputePolicyAuditPayload({
      currentCompute: current.compute,
      currentDelegation: current.delegation,
      nextCompute,
      nextDelegation: {
        ...current.delegation,
        maxCostCents: 50,
      },
      changedBy: "owner-1",
    });

    expect(payload?.changedFields).toEqual([
      "compute.baseImage",
      "compute.networkMode",
      "compute.networkAllowlist",
      "compute.capabilityModes.mcp",
      "delegation.maxCostCents",
    ]);
    expect(payload?.values.networkAllowlistCount).toBe(1);
    expect(JSON.stringify(payload)).not.toContain("registry.example");
    expect(JSON.stringify(payload)).not.toContain("sensitive.internal.example");
    expect(JSON.stringify(payload)).not.toContain("secret");
    expect(
      buildComputePolicyAuditPayload({
        currentCompute: current.compute,
        currentDelegation: current.delegation,
        nextCompute: current.compute,
        nextDelegation: current.delegation,
        changedBy: "owner-1",
      }),
    ).toBeNull();
  });

  it("keeps the installed release publishable while a candidate update awaits review", () => {
    const publishingSource = readFileSync(new URL("../src/conversation-platform.ts", import.meta.url), "utf8");
    const setupSource = readFileSync(new URL("../src/representative-setup.ts", import.meta.url), "utf8");

    expect(publishingSource).toContain("install.status !== WorkspaceSkillInstallStatus.UPDATE_AVAILABLE");
    expect(setupSource).toContain("install.status !== WorkspaceSkillInstallStatus.UPDATE_AVAILABLE");
    expect(publishingSource).toContain("mcpBindings: representative.mcpBindings.flatMap");
    expect(publishingSource).toContain("maxCostCents: representative.delegationMaxCostCents");
    expect(setupSource).toContain("type: EventType.COMPUTE_POLICY_CHANGED");
    expect(setupSource).toContain("if (computePolicyAuditPayload)");
  });
});

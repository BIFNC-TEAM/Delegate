import { readFileSync } from "node:fs";

import {
  demoRepresentative,
  normalizeRepresentativeHandoffPrompt,
} from "@delegate/domain";
import { describe, expect, it } from "vitest";

import {
  applyRepresentativeVersionSnapshot,
  buildComputePolicyAuditPayload,
  getPublicRepresentativeRuntime,
  getRepresentativeRuntimeAuthoritySnapshot,
  getRepresentativeRuntimeSetupSnapshot,
  resolveRepresentativeRuntimeMcpBindings,
  resolveGovernedContextEnabled,
  resolvePublicGovernedMemoryDisclosure,
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
    handoffAccessMode: "FREE",
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
    },
    handoffPrompt: "Unpublished draft handoff",
    compute: {
      enabled: false,
      defaultPolicyMode: "ask",
      baseImage: "debian:bookworm-slim",
      maxSessionMinutes: 15,
      autoApproveTokenLimit: 0,
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
      maxEstimatedTokens: 0,
      knowledgeScope: "user_input_only",
    },
  };
}

function publishedSnapshot(skillPacks: unknown[] = []) {
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
    },
    compute: {
      enabled: false,
      defaultPolicyMode: "ask",
      baseImage: "debian:bookworm-slim",
      maxSessionMinutes: 15,
      autoApproveTokenLimit: 0,
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
      maxEstimatedTokens: 0,
      knowledgeScope: "user_input_only",
    },
    knowledge: {
      identitySummary: "Published knowledge",
      faq: demoRepresentative.knowledgePack.faq,
      materials: [],
      policies: [],
    },
    skills: skillPacks,
  };
}

describe("representative published runtime snapshot", () => {
  it("upgrades the retired multi-field handoff prompt without changing custom copy", () => {
    expect(normalizeRepresentativeHandoffPrompt(
      "阿江 的真人评估入口已经开启。请留下你的身份、需求摘要、预算区间、目标时间，以及为什么需要真人接手。",
    )).toBe(
      "阿江 的真人评估入口已经开启。请简要描述你的需求；真人接手后会再确认联系人、预算和时间等必要信息。",
    );
    expect(normalizeRepresentativeHandoffPrompt("请说明需要人工处理的问题。")).toBe(
      "请说明需要人工处理的问题。",
    );
  });

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
    expect(runtime.handoffPrompt).toBe("Published handoff");
    expect(runtime.skillPacks).toEqual([demoRepresentative.skillPacks[0]]);
  });

  it("applies live commerce controls without exposing other unpublished setup", () => {
    const current = currentDraft();
    current.humanInLoop = false;
    current.contract.freeReplyLimit = 0;
    const snapshot = publishedSnapshot();

    const runtime = applyRepresentativeVersionSnapshot(current, snapshot);

    expect(runtime.humanInLoop).toBe(false);
    expect(runtime.contract.freeReplyLimit).toBe(0);
    expect(runtime.name).toBe("Published representative");
    expect(runtime.name).not.toBe(current.name);
    expect(runtime.knowledgePack.identitySummary).toBe("Published knowledge");
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
    const policy = {
      longTermMemoryEnabled: true,
      shortTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      contactMemoryCrossChannelEnabled: false,
      representativeExperienceEnabled: true,
      autoExtract: false,
      webRecallEnabled: true,
      webExtractEnabled: false,
      retentionDays: 45,
      expiryAction: "ARCHIVE" as const,
      provider: "openviking",
      revision: 7,
    };
    expect(
      resolveGovernedContextEnabled({
        policy,
        environmentEnabled: true,
        modelCredentialsAvailable: true,
      }),
    ).toBe(true);
    expect(
      resolveGovernedContextEnabled({
        policy: { ...policy, webRecallEnabled: false },
        environmentEnabled: true,
        modelCredentialsAvailable: true,
      }),
    ).toBe(false);
    expect(
      resolveGovernedContextEnabled({
        policy: {
          ...policy,
          contactMemoryEnabled: false,
          representativeExperienceEnabled: false,
        },
        environmentEnabled: true,
        modelCredentialsAvailable: true,
      }),
    ).toBe(false);
    expect(
      resolveGovernedContextEnabled({
        policy,
        environmentEnabled: false,
        modelCredentialsAvailable: true,
      }),
    ).toBe(false);
    expect(
      resolveGovernedContextEnabled({
        policy,
        environmentEnabled: true,
        modelCredentialsAvailable: false,
      }),
    ).toBe(false);
    expect(
      resolveGovernedContextEnabled({
        policy: { ...policy, provider: "unsupported" },
        environmentEnabled: true,
        modelCredentialsAvailable: true,
      }),
    ).toBe(false);

    const enabledDisclosure = resolvePublicGovernedMemoryDisclosure({
      policy,
      environmentEnabled: true,
      modelCredentialsAvailable: true,
    });
    expect(enabledDisclosure).toEqual({
      enabled: true,
      shortTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      contactMemoryCrossChannelEnabled: false,
      representativeExperienceEnabled: true,
      automaticExtractionEnabled: false,
      retentionDays: 45,
      expiryAction: "ARCHIVE",
      policyRevision: 7,
      fingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    const disabledDisclosure = resolvePublicGovernedMemoryDisclosure({
      policy: null,
      environmentEnabled: true,
      modelCredentialsAvailable: true,
    });
    expect(disabledDisclosure).toEqual(expect.objectContaining({
      enabled: false,
      retentionDays: null,
      expiryAction: null,
      policyRevision: null,
      fingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    }));
    const extractionOnlyDisclosure = resolvePublicGovernedMemoryDisclosure({
      policy: {
        ...policy,
        autoExtract: true,
        webRecallEnabled: false,
        webExtractEnabled: true,
        expiryAction: "DELETE",
      },
      environmentEnabled: false,
      modelCredentialsAvailable: false,
    });
    expect(extractionOnlyDisclosure).toEqual({
      enabled: false,
      shortTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      contactMemoryCrossChannelEnabled: false,
      representativeExperienceEnabled: true,
      automaticExtractionEnabled: true,
      retentionDays: 45,
      expiryAction: "DELETE",
      policyRevision: 7,
      fingerprint: "gB8MZEg2WKlBNv0btWJyh0VvdW39bsiAHHVzMFhq-Qs",
    });

    const representativeOnlyExtractionDisclosure = resolvePublicGovernedMemoryDisclosure({
      policy: {
        ...policy,
        contactMemoryEnabled: false,
        representativeExperienceEnabled: true,
        autoExtract: true,
        webRecallEnabled: false,
        webExtractEnabled: true,
        expiryAction: "DELETE",
      },
      environmentEnabled: false,
      modelCredentialsAvailable: false,
    });
    expect(representativeOnlyExtractionDisclosure).toEqual({
      enabled: false,
      shortTermMemoryEnabled: true,
      contactMemoryEnabled: false,
      contactMemoryCrossChannelEnabled: false,
      representativeExperienceEnabled: true,
      automaticExtractionEnabled: true,
      retentionDays: 45,
      expiryAction: "DELETE",
      policyRevision: 7,
      fingerprint: "u2F1QrJr4iVGr_YUI0FwTvO6KrEf62Q7cSQ08CtdIio",
    });
    expect(representativeOnlyExtractionDisclosure.fingerprint).not.toBe(
      extractionOnlyDisclosure.fingerprint,
    );
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
        expect(runtime.governedMemoryDisclosure).toEqual(expect.objectContaining({
          enabled: false,
          retentionDays: null,
        }));
      }
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });

  it("ignores legacy pricing fields and uses a conservative group trigger for old versions", () => {
    const runtime = applyRepresentativeVersionSnapshot(
      currentDraft(),
      {
        ...publishedSnapshot(),
        pricing: [{ type: "PASS", name: "Legacy Pass", starsAmount: 180 }],
      },
    );

    expect(runtime).not.toHaveProperty("pricing");
    expect(runtime.groupActivation).toBe("mention_only");
    expect(runtime.skillPacks).toEqual([]);
  });

  it("drops executable or malformed skill declarations from an immutable version", () => {
    const runtime = applyRepresentativeVersionSnapshot(
      currentDraft(),
      publishedSnapshot([
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
      publishedSnapshot([{
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
    const versionSnapshot = publishedSnapshot([publishedV1]);

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
    const snapshot = publishedSnapshot();
    snapshot.governance.allowedSkills = [];

    expect(applyRepresentativeVersionSnapshot(currentDraft(), snapshot).skills).toEqual([]);
  });

  it("uses the published compute grant as a ceiling and lets current state tighten it", () => {
    const current = currentDraft();
    current.compute = {
      enabled: true,
      defaultPolicyMode: "deny",
      baseImage: "pinned-image:v1",
      maxSessionMinutes: 10,
      autoApproveTokenLimit: 40,
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
    const snapshot = publishedSnapshot();
    snapshot.compute = {
      enabled: true,
      defaultPolicyMode: "allow",
      baseImage: "pinned-image:v1",
      maxSessionMinutes: 30,
      autoApproveTokenLimit: 100,
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
      autoApproveTokenLimit: 40,
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
    const legacy = publishedSnapshot();
    delete (legacy as { compute?: unknown }).compute;
    expect(applyRepresentativeVersionSnapshot(current, legacy).compute.enabled).toBe(false);

    const changedImage = publishedSnapshot();
    changedImage.compute = {
      ...changedImage.compute,
      enabled: true,
      baseImage: "published-image:v1",
    };
    current.compute.baseImage = "draft-image:v2";
    expect(applyRepresentativeVersionSnapshot(current, changedImage).compute.enabled).toBe(false);
  });

  it("converts legacy published approval budgets into token limits", () => {
    const current = currentDraft();
    current.compute.autoApproveTokenLimit = 500;
    current.delegation.maxEstimatedTokens = 0;
    const snapshot = publishedSnapshot();
    const legacyCompute = snapshot.compute as Record<string, unknown>;
    delete legacyCompute.autoApproveTokenLimit;
    legacyCompute.autoApproveBudgetCents = 2;
    const legacyDelegation = snapshot.delegation as Record<string, unknown>;
    delete legacyDelegation.maxEstimatedTokens;
    legacyDelegation.maxCostCents = 3;

    const runtime = applyRepresentativeVersionSnapshot(current, snapshot);

    expect(runtime.compute.autoApproveTokenLimit).toBe(200);
    expect(runtime.delegation.maxEstimatedTokens).toBe(300);
  });

  it("intersects delegation quotas and knowledge scope instead of expanding them", () => {
    const current = currentDraft();
    current.delegation = {
      enabled: true,
      naturalLanguageEnabled: false,
      explicitComputeEnabled: true,
      maxSteps: 2,
      maxEstimatedTokens: 25,
      knowledgeScope: "user_input_only",
    };
    const snapshot = publishedSnapshot();
    snapshot.delegation = {
      enabled: true,
      naturalLanguageEnabled: true,
      explicitComputeEnabled: true,
      maxSteps: 5,
      maxEstimatedTokens: 100,
      knowledgeScope: "public_knowledge",
    };

    expect(applyRepresentativeVersionSnapshot(current, snapshot).delegation).toEqual({
      enabled: true,
      naturalLanguageEnabled: false,
      explicitComputeEnabled: true,
      maxSteps: 2,
      maxEstimatedTokens: 25,
      knowledgeScope: "user_input_only",
    });

    current.delegation.maxEstimatedTokens = 0;
    expect(
      applyRepresentativeVersionSnapshot(current, snapshot).delegation.maxEstimatedTokens,
    ).toBe(100);
    snapshot.delegation.maxEstimatedTokens = 0;
    current.delegation.maxEstimatedTokens = 25;
    expect(
      applyRepresentativeVersionSnapshot(current, snapshot).delegation.maxEstimatedTokens,
    ).toBe(25);
  });

  it("disables legacy delegation snapshots that do not pin a token ceiling", () => {
    const snapshot = publishedSnapshot();
    delete (snapshot.delegation as { maxEstimatedTokens?: number }).maxEstimatedTokens;

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
          estimatedTokensPerCall: 8,
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
          estimatedTokensPerCall: 0,
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
          estimatedTokensPerCall: 0,
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
            estimatedTokensPerCall: 4,
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
            estimatedTokensPerCall: 0,
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
            estimatedTokensPerCall: 0,
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
        estimatedTokensPerCall: 8,
        maxRetries: 1,
        retryBackoffMs: 2000,
      },
    ]);
  });

  it("converts a legacy MCP call estimate into tokens", () => {
    const runtimeBindings = resolveRepresentativeRuntimeMcpBindings(
      [{
        id: "binding-legacy",
        slug: "legacy",
        serverUrl: "https://legacy.example.test",
        transportKind: "STREAMABLE_HTTP",
        allowedToolNames: ["lookup"],
        defaultToolName: "lookup",
        enabled: true,
        approvalRequired: true,
        estimatedTokensPerCall: 50,
        maxRetries: 1,
        retryBackoffMs: 1000,
      }],
      {
        mcpBindings: [{
          id: "binding-legacy",
          slug: "legacy",
          serverUrl: "https://legacy.example.test",
          transportKind: "streamable_http",
          allowedToolNames: ["lookup"],
          defaultToolName: "lookup",
          enabled: true,
          approvalRequired: true,
          estimatedCostCentsPerCall: 1,
          maxRetries: 1,
          retryBackoffMs: 1000,
          skillReleasePin: null,
        }],
      },
    );

    expect(runtimeBindings[0]?.estimatedTokensPerCall).toBe(100);
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
        estimatedTokensPerCall: 0,
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
      estimatedTokensPerCall: 0,
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
        estimatedTokensPerCall: 0,
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
      estimatedTokensPerCall: 0,
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
      estimatedTokensPerCall: 0,
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
      estimatedTokensPerCall: 0,
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
        maxEstimatedTokens: 50,
      },
      changedBy: "owner-1",
    });

    expect(payload?.changedFields).toEqual([
      "compute.baseImage",
      "compute.networkMode",
      "compute.networkAllowlist",
      "compute.capabilityModes.mcp",
      "delegation.maxEstimatedTokens",
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
    expect(publishingSource).toContain("maxEstimatedTokens: representative.delegationMaxEstimatedTokens");
    expect(setupSource).toContain("type: EventType.COMPUTE_POLICY_CHANGED");
    expect(setupSource).toContain("if (computePolicyAuditPayload)");
  });
});

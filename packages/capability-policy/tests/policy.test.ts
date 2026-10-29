import { describe, expect, it } from "vitest";
import { evaluateCapabilityPolicy, evaluateCapabilityPolicyStack } from "../src/index";
import { ownerManagedPolicyOverlaysSchema } from "@delegate/compute-protocol";

describe("evaluateCapabilityPolicy", () => {
  it("drops retired plan-tier inputs from overlay configuration without changing approval settings", () => {
    const config = { enabled: true, browserDecision: "allow", browserRequiresApproval: false,
      mcpDecision: "ask", mcpRequiresApproval: true, requiredPlanTier: "deep_help" };
    const parsed = ownerManagedPolicyOverlaysSchema.parse({ baseline: config, trustedCustomer: config });
    expect(parsed.baseline).not.toHaveProperty("requiredPlanTier");
    expect(parsed.trustedCustomer).not.toHaveProperty("requiredPlanTier");
    expect(parsed.baseline).toMatchObject({ browserDecision: "allow", browserRequiresApproval: false, mcpRequiresApproval: true });
  });
  const profile = {
    id: "profile_1",
    representativeId: "rep_1",
    ownerId: null,
    organizationId: null,
    customerAccountId: null,
    name: "Default",
    isDefault: true,
    enabled: true,
    isManaged: false,
    managedScope: "representative_default" as const,
    editableByOwner: false,
    precedence: 0,
    defaultDecision: "ask" as const,
    maxSessionMinutes: 15,
    maxParallelSessions: 1,
    maxCommandSeconds: 30,
    artifactRetentionDays: 14,
    networkMode: "no_network" as const,
    networkAllowlist: [],
    filesystemMode: "workspace_only" as const,
    rules: [
      {
        id: "rule_allow_ls",
        capability: "exec" as const,
        decision: "allow" as const,
        commandPattern: "^(ls|cat|rg)(\\s|$)",
        resourceScopeCondition: "workspace" as const,
        priority: 100,
        requiresHumanApproval: false,
        requiresPaidPlan: false,
      },
      {
        id: "rule_ask_write",
        capability: "write" as const,
        decision: "ask" as const,
        pathPattern: "^/workspace",
        resourceScopeCondition: "workspace" as const,
        priority: 50,
        requiresHumanApproval: true,
        requiresPaidPlan: false,
      },
    ],
  };

  it("allows commands that match an allow rule", () => {
    const result = evaluateCapabilityPolicy(profile, {
      capability: "exec",
      command: "rg founder README.md",
      resourceScope: "workspace",
    });

    expect(result.decision).toBe("allow");
    expect(result.matchedRuleId).toBe("rule_allow_ls");
  });

  it.each(["allow", "ask", "deny"] as const)("ignores retired plan fields while preserving the configured %s decision", (decision) => {
    // Legacy database rows must not reintroduce PASS/DEEP_HELP after the
    // broker has already authorized the generation's consumption quota.
    const legacyProfile = { ...profile, rules: [{
      id: "legacy-browser", capability: "browser" as const, decision,
      requiredPlanTier: "deep_help" as const, requiresPaidPlan: true,
      requiresHumanApproval: decision === "ask", priority: 100,
    }] };
    const result = evaluateCapabilityPolicy(legacyProfile, { capability: "browser" });
    expect(result.decision).toBe(decision);
    expect(result.reason).not.toContain("plan");
  });

  it("asks when a matching rule requires approval", () => {
    const result = evaluateCapabilityPolicy(profile, {
      capability: "write",
      path: "/workspace/output.txt",
      resourceScope: "workspace",
    });

    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("human_approval_required");
  });

  it.each(["allow", "ask", "deny"] as const)("ignores only the retired generated browser ASK and honors configured %s", (decision) => {
    const managedId = "cap_profile_managed_rep_1";
    const retired = { ...profile, id: managedId, isDefault: false, isManaged: true,
      managedScope: "delegate_managed" as const, managedSource: "delegate-default", precedence: 100,
      rules: [{ id: `${managedId}_browser_paid_private`, capability: "browser" as const, decision: "ask" as const,
        domainPattern: ".*", resourceScopeCondition: "browser_lane" as const, channelCondition: "private_chat" as const,
        priority: 220, requiresHumanApproval: true }] };
    const base = { ...profile, rules: [{ id: "owner-browser", capability: "browser" as const, decision, priority: 1000, requiresHumanApproval: decision === "ask" }] };
    const result = evaluateCapabilityPolicyStack([retired, base], { capability: "browser", resourceScope: "browser_lane", channel: "private_chat", domain: "example.com" });
    expect(result.decision).toBe(decision); expect(result.matchedRuleId).toBe("owner-browser");
  });

  it.each([
    { decision: "deny" as const, requiresHumanApproval: false },
    { domainPattern: "example.com" },
    { priority: 221 },
    { maxEstimatedTokens: 100 },
  ])("preserves customized management rules even with the legacy id: %j", change => {
    const id = "cap_profile_managed_rep_1";
    const managed = { ...profile, id, isDefault: false, isManaged: true, managedScope: "delegate_managed" as const, managedSource: "delegate-default", precedence: 100,
      rules: [{ id: `${id}_browser_paid_private`, capability: "browser" as const, decision: "ask" as const,
        domainPattern: ".*", resourceScopeCondition: "browser_lane" as const, channelCondition: "private_chat" as const,
        priority: 220, requiresHumanApproval: true, ...change }] };
    const result = evaluateCapabilityPolicyStack([managed, { ...profile, defaultDecision: "allow" as const }], { capability: "browser", domain: "example.com", resourceScope: "browser_lane", channel: "private_chat", estimatedTokens: 10 });
    expect(result.decision).not.toBe("allow"); expect(result.matchedRuleId).toBe(`${id}_browser_paid_private`);
  });

  it("falls back to the profile default when no rule matches", () => {
    const result = evaluateCapabilityPolicy(profile, {
      capability: "process",
    });

    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("default_profile_decision");
  });

  it("lets managed overlays override the base profile when channel conditions match", () => {
    const managedProfile = {
      ...profile,
      id: "managed_1",
      name: "Managed",
      isDefault: false,
      isManaged: true,
      managedScope: "delegate_managed" as const,
      precedence: 100,
      rules: [
        {
          id: "managed_browser_paid",
          capability: "browser" as const,
          decision: "ask" as const,
          resourceScopeCondition: "browser_lane" as const,
          channelCondition: "private_chat" as const,
          requiredPlanTier: "pass" as const,
          priority: 200,
          requiresHumanApproval: true,
          requiresPaidPlan: true,
        },
      ],
    };

    const result = evaluateCapabilityPolicyStack([managedProfile, profile], {
      capability: "browser",
      resourceScope: "browser_lane",
      channel: "private_chat",
    });

    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("managed_human_approval_required");
    expect(result.matchedRuleId).toBe("managed_browser_paid");
  });

  it("only applies customer-tier overlays when the trust tier matches", () => {
    const customerOverlay = {
      ...profile,
      id: "managed_customer_verified",
      representativeId: null,
      ownerId: "owner_1",
      organizationId: null,
      customerAccountId: null,
      name: "Verified Customer Overlay",
      isDefault: false,
      isManaged: true,
      managedScope: "customer_trust_tier" as const,
      editableByOwner: true,
      contactTrustTierCondition: "verified" as const,
      precedence: 90,
      rules: [
        {
          id: "verified_mcp",
          capability: "mcp" as const,
          decision: "allow" as const,
          resourceScopeCondition: "remote_mcp" as const,
          requiredPlanTier: "pass" as const,
          priority: 150,
          requiresHumanApproval: false,
          requiresPaidPlan: true,
        },
      ],
    };

    const deniedForStandard = evaluateCapabilityPolicyStack([customerOverlay, profile], {
      capability: "mcp",
      resourceScope: "remote_mcp",
      contactTrustTier: "standard",
    });

    expect(deniedForStandard.reason).toBe("default_profile_decision");

    const allowedForVerified = evaluateCapabilityPolicyStack([customerOverlay, profile], {
      capability: "mcp",
      resourceScope: "remote_mcp",
      contactTrustTier: "verified",
    });

    expect(allowedForVerified.decision).toBe("allow");
    expect(allowedForVerified.matchedRuleId).toBe("verified_mcp");
  });

  it("skips rules when the resource scope does not match", () => {
    const result = evaluateCapabilityPolicy(profile, {
      capability: "exec",
      command: "rg founder README.md",
      resourceScope: "remote_mcp",
    });

    expect(result.reason).toBe("default_profile_decision");
  });

  it("does not let owner overlays bypass a higher-precedence managed deny", () => {
    const delegateDeny = {
      ...profile,
      id: "delegate_deny_mcp",
      representativeId: "rep_1",
      ownerId: null,
      organizationId: null,
      customerAccountId: null,
      name: "Delegate Deny",
      isDefault: false,
      isManaged: true,
      managedScope: "delegate_managed" as const,
      precedence: 300,
      rules: [
        {
          id: "deny_remote_mcp",
          capability: "mcp" as const,
          decision: "deny" as const,
          resourceScopeCondition: "remote_mcp" as const,
          priority: 300,
          requiresHumanApproval: false,
          requiresPaidPlan: false,
        },
      ],
    };
    const ownerAllow = {
      ...profile,
      id: "owner_allow_mcp",
      representativeId: null,
      ownerId: "owner_1",
      organizationId: null,
      customerAccountId: null,
      name: "Owner Allow",
      isDefault: false,
      isManaged: true,
      managedScope: "owner_managed" as const,
      editableByOwner: true,
      precedence: 80,
      rules: [
        {
          id: "allow_remote_mcp",
          capability: "mcp" as const,
          decision: "allow" as const,
          resourceScopeCondition: "remote_mcp" as const,
          priority: 100,
          requiresHumanApproval: false,
          requiresPaidPlan: false,
        },
      ],
    };

    const result = evaluateCapabilityPolicyStack([delegateDeny, ownerAllow, profile], {
      capability: "mcp",
      resourceScope: "remote_mcp",
      contactTrustTier: "verified",
    });

    expect(result.decision).toBe("deny");
    expect(result.matchedRuleId).toBe("deny_remote_mcp");
  });

  it("only applies customer-account overlays to contacts assigned to that account", () => {
    const customerAccountOverlay = {
      ...profile,
      id: "customer_account_overlay",
      representativeId: "rep_1",
      ownerId: null,
      organizationId: "org_1",
      customerAccountId: "customer_acme",
      name: "Acme Overlay",
      isDefault: false,
      isManaged: true,
      managedScope: "customer_account" as const,
      precedence: 120,
      rules: [
        {
          id: "acme_browser_allow",
          capability: "browser" as const,
          decision: "allow" as const,
          resourceScopeCondition: "browser_lane" as const,
          requiredPlanTier: "pass" as const,
          priority: 210,
          requiresHumanApproval: false,
          requiresPaidPlan: true,
        },
      ],
    };

    const fallbackForOtherAccount = evaluateCapabilityPolicyStack([customerAccountOverlay, profile], {
      capability: "browser",
      resourceScope: "browser_lane",
      customerAccountId: "customer_other",
    });

    expect(fallbackForOtherAccount.reason).toBe("default_profile_decision");

    const allowedForAssignedAccount = evaluateCapabilityPolicyStack([customerAccountOverlay, profile], {
      capability: "browser",
      resourceScope: "browser_lane",
      customerAccountId: "customer_acme",
    });

    expect(allowedForAssignedAccount.decision).toBe("allow");
    expect(allowedForAssignedAccount.matchedRuleId).toBe("acme_browser_allow");
  });
});

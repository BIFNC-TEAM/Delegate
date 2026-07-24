import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockLoadComputeRuntimeAuthority,
  mockPrisma,
  mockRequireAudienceGenerationRunAuthorization,
} = vi.hoisted(() => ({
  mockLoadComputeRuntimeAuthority: vi.fn(),
  mockRequireAudienceGenerationRunAuthorization: vi.fn(),
  mockPrisma: {
    computeSession: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("../src/runtime-authority", () => ({
  loadComputeRuntimeAuthority: mockLoadComputeRuntimeAuthority,
}));

vi.mock("../src/entitlements", () => ({
  deriveConversationComputeEntitlements: vi.fn(),
  requireAudienceGenerationRunAuthorization:
    mockRequireAudienceGenerationRunAuthorization,
}));

function capabilityProfile() {
  return {
    id: "profile-1",
    representativeId: "rep-1",
    ownerId: null,
    organizationId: null,
    customerAccountId: null,
    name: "Default",
    isDefault: true,
    enabled: true,
    isManaged: false,
    managedScope: "REPRESENTATIVE_DEFAULT",
    managedSource: null,
    editableByOwner: true,
    contactTrustTierCondition: null,
    precedence: 0,
    defaultDecision: "ASK",
    maxSessionMinutes: 15,
    maxParallelSessions: 1,
    maxCommandSeconds: 60,
    artifactRetentionDays: 7,
    networkMode: "NO_NETWORK",
    networkAllowlist: [],
    filesystemMode: "WORKSPACE_ONLY",
    rules: [],
  };
}

function audienceSession() {
  const createdAt = new Date();
  return {
    id: "session-1",
    representativeId: "rep-1",
    representativeVersionId: "version-1",
    contactId: "contact-1",
    conversationId: "conversation-1",
    generationRunId: "run-1",
    requestedBy: "AUDIENCE",
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 15 * 60 * 1000),
    endedAt: null,
    representative: {
      id: "rep-1",
      slug: "rep-one",
      owner: {
        wallet: null,
        organization: null,
        capabilityProfiles: [],
      },
      capabilityProfiles: [],
    },
    contact: {
      customerAccountId: null,
      computeTrustTier: null,
      customerAccount: null,
    },
    conversation: {
      channel: "PRIVATE_CHAT",
      computeBudgetRemainingCredits: null,
    },
    policyProfile: capabilityProfile(),
  };
}

describe("execution-time audience authorization revalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.computeSession.findUnique.mockResolvedValue(audienceSession());
    mockPrisma.computeSession.updateMany.mockResolvedValue({ count: 0 });
    mockLoadComputeRuntimeAuthority.mockResolvedValue({
      representativeVersionId: "version-1",
      compute: {
        enabled: true,
        defaultPolicyMode: "ask",
        baseImage: "runtime:1",
        maxSessionMinutes: 15,
        autoApproveBudgetCents: 0,
        artifactRetentionDays: 7,
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
      },
      delegation: {
        enabled: true,
        naturalLanguageEnabled: true,
        explicitComputeEnabled: true,
        maxSteps: 5,
        maxCostCents: 0,
        knowledgeScope: "user_input_only",
      },
      mcpBindings: [],
    });
    mockRequireAudienceGenerationRunAuthorization.mockResolvedValue({
      kind: "free",
      audienceIdentityId: "audience-1",
      generationRunId: "run-1",
      representativeId: "rep-1",
      productCode: null,
      activePlanTier: undefined,
      hasPaidEntitlement: false,
    });
  });

  it("rechecks the active generation-run authorization on every policy load", async () => {
    const { loadSessionPolicyContext } = await import("../src/policy");

    await loadSessionPolicyContext("session-1");
    await loadSessionPolicyContext("session-1");

    expect(
      mockRequireAudienceGenerationRunAuthorization,
    ).toHaveBeenCalledTimes(2);
    expect(
      mockRequireAudienceGenerationRunAuthorization,
    ).toHaveBeenNthCalledWith(1, {
      requestedBy: "AUDIENCE",
      representativeId: "rep-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      generationRunId: "run-1",
    });
  });

  it("fails closed when the reservation becomes terminal after session creation", async () => {
    const { loadSessionPolicyContext } = await import("../src/policy");
    mockRequireAudienceGenerationRunAuthorization.mockRejectedValueOnce(
      new Error("audience_generation_run_authorization_denied"),
    );

    await expect(
      loadSessionPolicyContext("session-1"),
    ).rejects.toThrow("audience_generation_run_authorization_denied");
  });
});

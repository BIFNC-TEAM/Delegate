import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockContextAuthorization,
  mockLoadComputeRuntimeAuthority,
  mockLoadMcpBinding,
  mockPrisma,
  mockRequireAudienceGenerationRunAuthorization,
} = vi.hoisted(() => ({
  mockContextAuthorization: vi.fn(),
  mockLoadComputeRuntimeAuthority: vi.fn(),
  mockLoadMcpBinding: vi.fn(),
  mockRequireAudienceGenerationRunAuthorization: vi.fn(),
  mockPrisma: {
    computeSession: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@delegate/web-data", async original => ({ ...await original<typeof import("@delegate/web-data")>(), assertAgentContextForExecution: mockContextAuthorization }));

vi.mock("../src/mcp-bindings", () => ({
  loadRepresentativeMcpBinding: mockLoadMcpBinding,
  resolveMcpToolName: ({ requestedToolName }: { requestedToolName: string }) => ({ toolName: requestedToolName }),
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

// Collect the module outside the per-test deadline; authority dependencies are mocked above.
import "../src/policy";

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
    },
    policyProfile: capabilityProfile(),
  };
}

describe("execution-time audience authorization revalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContextAuthorization.mockResolvedValue(undefined);
    mockPrisma.computeSession.findUnique.mockResolvedValue(audienceSession());
    mockPrisma.computeSession.updateMany.mockResolvedValue({ count: 0 });
    mockLoadComputeRuntimeAuthority.mockResolvedValue({
      representativeVersionId: "version-1",
      compute: {
        enabled: true,
        defaultPolicyMode: "ask",
        baseImage: "runtime:1",
        maxSessionMinutes: 15,
        autoApproveTokenLimit: 0,
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
        maxEstimatedTokens: 0,
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

  it.each((["allow", "ask", "deny"] as const).flatMap((mode) => [
    { mode, classified: true }, { mode, classified: false },
  ]))("honors published $mode with classified=$classified in the execution path", async ({ mode, classified }) => {
    const { evaluateExecutionRequest } = await import("../src/policy");
    const session = audienceSession();
    session.policyProfile.defaultDecision = "ALLOW";
    mockPrisma.computeSession.findUnique.mockResolvedValue(session);
    const binding = { id: "deepwiki", slug: "deepwiki", serverUrl: classified ? "https://mcp.deepwiki.com/mcp" : "https://unknown.invalid/mcp", transportKind: "STREAMABLE_HTTP", configRevision: 1, approvalRequired: false, estimatedTokensPerCall: 0 };
    const authority = await mockLoadComputeRuntimeAuthority();
    authority.compute.defaultPolicyMode = "allow";
    authority.compute.capabilityModes.mcp = mode;
    authority.mcpBindings = [{ ...binding, allowedToolNames: ["ask_question"], toolDefinitions: [{ exactToolName: "ask_question", bindingRevision: 1, toolSchemaHash: "5f937ca02cb792c59d6f31b22d1e09db2a6412ee27b8e180a04c0bb38a24cd24", inputSchema: { type: "object" } }] }];
    mockLoadComputeRuntimeAuthority.mockResolvedValue(authority);
    mockLoadMcpBinding.mockResolvedValue(binding);
    const result = await evaluateExecutionRequest("session-1", { capability: "mcp", bindingId: "deepwiki", toolName: "ask_question", toolArguments: {}, subagentId: "compute-agent" });
    expect(result.serverVerifiedReadOnlyMcp).toBe(classified);
    expect(result.decision.decision).toBe(classified ? mode : "deny");
    if (!classified) expect(result.decision.reason).toBe("mcp_tool_behavior_unclassified");
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

  it("loads published duration, network, and filesystem limits as execution ceilings", async () => {
    const { loadSessionPolicyContext } = await import("../src/policy");
    const session = audienceSession();
    session.policyProfile.networkMode = "FULL";
    session.policyProfile.filesystemMode = "EPHEMERAL_FULL";
    mockPrisma.computeSession.findUnique.mockResolvedValue(session);
    mockLoadComputeRuntimeAuthority.mockResolvedValueOnce({
      representativeVersionId: "version-1",
      compute: {
        enabled: true,
        defaultPolicyMode: "ask",
        baseImage: "runtime:1",
        maxSessionMinutes: 2,
        autoApproveTokenLimit: 0,
        artifactRetentionDays: 7,
        networkMode: "no_network",
        networkAllowlist: [],
        filesystemMode: "read_only_workspace",
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
      mcpBindings: [],
    });

    const context = await loadSessionPolicyContext("session-1");

    expect(context.profile.networkMode).toBe("no_network");
    expect(context.profile.filesystemMode).toBe("read_only_workspace");
    expect(context.session.expiresAt).toEqual(
      new Date(session.createdAt.getTime() + 2 * 60 * 1_000),
    );
    expect(mockPrisma.computeSession.updateMany).toHaveBeenCalledWith({
      where: {
        id: "session-1",
        expiresAt: {
          gt: new Date(session.createdAt.getTime() + 2 * 60 * 1_000),
        },
      },
      data: {
        expiresAt: new Date(session.createdAt.getTime() + 2 * 60 * 1_000),
      },
    });
  });
});

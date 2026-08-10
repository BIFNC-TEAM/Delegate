import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acceptInboundConversationMessage: vi.fn(),
  buildRepresentativeRuntimeProfile: vi.fn(),
  buildWebAudienceExternalUserId: vi.fn(),
  cookies: vi.fn(),
  createConversationPlan: vi.fn(),
  generateRepresentativeReply: vi.fn(),
  getPublicRepresentativeRuntime: vi.fn(),
  getUserAgentWalletBalance: vi.fn(),
  renderReplyPreview: vi.fn(),
  resolveConversationSubagent: vi.fn(),
  resolvePublicAudienceRequestPrincipal: vi.fn(),
  resolvePublicAudienceWalletExternalUserId: vi.fn(),
  resolveWebAudienceContact: vi.fn(),
  resolveWebAudienceConversation: vi.fn(),
  setPublicAudienceSessionCookie: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@delegate/model-runtime", () => ({
  generateRepresentativeReply: mocks.generateRepresentativeReply,
}));

vi.mock("@delegate/runtime", () => ({
  createConversationPlan: mocks.createConversationPlan,
  renderReplyPreview: mocks.renderReplyPreview,
  resolveConversationSubagent: mocks.resolveConversationSubagent,
}));

vi.mock("@delegate/web-data", () => ({
  acceptInboundConversationMessage: mocks.acceptInboundConversationMessage,
  AgentWalletReconciliationError: class AgentWalletReconciliationError extends Error {},
  buildRepresentativeRuntimeProfile: mocks.buildRepresentativeRuntimeProfile,
  buildWebAudienceExternalUserId: mocks.buildWebAudienceExternalUserId,
  getPublicConversationHistory: vi.fn(),
  getPublicRepresentativeRuntime: mocks.getPublicRepresentativeRuntime,
  getUserAgentWalletBalance: mocks.getUserAgentWalletBalance,
  resolvePublicAudienceWalletExternalUserId:
    mocks.resolvePublicAudienceWalletExternalUserId,
  resolveWebAudienceContact: mocks.resolveWebAudienceContact,
  resolveWebAudienceConversation: mocks.resolveWebAudienceConversation,
  ServiceCreditRequiredError: class ServiceCreditRequiredError extends Error {},
}));

vi.mock("../app/reps/[slug]/public-principal", () => ({
  assertPublicAudienceResourceOwner: vi.fn(),
  publicAudiencePrincipalErrorStatus: vi.fn(() => null),
  resolvePublicAudienceRequestPrincipal:
    mocks.resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie: mocks.setPublicAudienceSessionCookie,
}));

import { POST as postPublicChat } from "../app/reps/[slug]/chat/route";

const currentDisclosure = {
  enabled: true,
  shortTermMemoryEnabled: true,
  contactMemoryEnabled: true,
  contactMemoryCrossChannelEnabled: false,
  representativeExperienceEnabled: true,
  automaticExtractionEnabled: true,
  retentionDays: 45,
  expiryAction: "ARCHIVE" as const,
  policyRevision: 2,
  fingerprint: "a".repeat(43),
};

describe("public chat memory disclosure boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DATABASE_URL", "");
    mocks.cookies.mockResolvedValue({ get: vi.fn() });
    mocks.getPublicRepresentativeRuntime.mockResolvedValue({
      status: "available",
      setup: {
        id: "rep-1",
        contract: { freeReplyLimit: 5 },
      },
      governedContextEnabled: true,
      governedMemoryDisclosure: currentDisclosure,
    });
    mocks.resolvePublicAudienceRequestPrincipal.mockResolvedValue({
      principal: {
        mode: "anonymous",
        audienceId: "audience-1",
        audienceIdentityId: "identity-1",
      },
      sessionState: {
        audienceId: "audience-1",
        sessionToken: "session-token-long-enough-for-test",
        expiresAt: "2026-08-10T00:00:00.000Z",
      },
    });
    mocks.resolveWebAudienceContact.mockResolvedValue({
      id: "contact-1",
      audienceIdentityId: "identity-1",
      displayName: "Visitor",
      username: null,
    });
    mocks.resolveWebAudienceConversation.mockResolvedValue({
      id: "conversation-1",
      audienceIdentityId: "identity-1",
      freeRepliesUsed: 0,
    });
    mocks.buildWebAudienceExternalUserId.mockReturnValue("wallet-user-1");
    mocks.acceptInboundConversationMessage.mockResolvedValue({
      heldForOperator: false,
      run: { id: "run-1" },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a stale revision and fingerprint before any identity, write, or processing side effect", async () => {
    const response = await postPublicChat(
      publicChatRequest({
        policyRevision: 1,
        fingerprint: "b".repeat(43),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Memory policy changed. Review the updated disclosure before sending.",
      code: "memory_disclosure_stale",
      governedMemoryDisclosure: currentDisclosure,
    });
    expectNoPostDisclosureSideEffects();
  });

  it("fails closed when the client omits or malforms its disclosure proof", async () => {
    const missingResponse = await postPublicChat(
      publicChatRequest(undefined),
      { params: Promise.resolve({ slug: "delegate" }) },
    );
    expect(missingResponse.status).toBe(409);
    expectNoPostDisclosureSideEffects();

    const malformedResponse = await postPublicChat(
      publicChatRequest({
        policyRevision: 2,
        fingerprint: "not-a-sha256-fingerprint",
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );
    expect(malformedResponse.status).toBe(409);
    expectNoPostDisclosureSideEffects();
  });

  it("rejects the prior extraction disclosure after contact memory is disabled", async () => {
    const disabledDisclosure = {
      enabled: false,
      shortTermMemoryEnabled: false,
      contactMemoryEnabled: false,
      contactMemoryCrossChannelEnabled: false,
      representativeExperienceEnabled: false,
      automaticExtractionEnabled: false,
      retentionDays: null,
      expiryAction: null,
      policyRevision: 3,
      fingerprint: "c".repeat(43),
    };
    mocks.getPublicRepresentativeRuntime.mockResolvedValue({
      status: "available",
      setup: {
        id: "rep-1",
        contract: { freeReplyLimit: 5 },
      },
      governedContextEnabled: false,
      governedMemoryDisclosure: disabledDisclosure,
    });

    const response = await postPublicChat(
      publicChatRequest({
        policyRevision: currentDisclosure.policyRevision,
        fingerprint: currentDisclosure.fingerprint,
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({
      code: "memory_disclosure_stale",
      governedMemoryDisclosure: expect.objectContaining({
        contactMemoryEnabled: false,
        automaticExtractionEnabled: false,
      }),
    }));
    expectNoPostDisclosureSideEffects();
  });

  it("accepts an exact current proof and only then enters the message pipeline", async () => {
    const response = await postPublicChat(
      publicChatRequest({
        policyRevision: currentDisclosure.policyRevision,
        fingerprint: currentDisclosure.fingerprint,
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(202);
    expect(mocks.resolvePublicAudienceRequestPrincipal).toHaveBeenCalledTimes(1);
    expect(mocks.resolveWebAudienceContact).toHaveBeenCalledTimes(1);
    expect(mocks.resolveWebAudienceConversation).toHaveBeenCalledTimes(1);
    expect(mocks.acceptInboundConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        representativeSlug: "delegate",
        conversationId: "conversation-1",
        text: "hello",
      }),
    );
  });
});

function publicChatRequest(
  memoryDisclosure:
    | { policyRevision: number | null; fingerprint: string }
    | undefined,
) {
  return new Request("http://localhost/reps/delegate/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "hello",
      clientMessageId: "message-1",
      ...(memoryDisclosure ? { memoryDisclosure } : {}),
    }),
  });
}

function expectNoPostDisclosureSideEffects() {
  expect(mocks.cookies).not.toHaveBeenCalled();
  expect(mocks.resolvePublicAudienceRequestPrincipal).not.toHaveBeenCalled();
  expect(mocks.resolveWebAudienceContact).not.toHaveBeenCalled();
  expect(mocks.resolveWebAudienceConversation).not.toHaveBeenCalled();
  expect(mocks.resolvePublicAudienceWalletExternalUserId).not.toHaveBeenCalled();
  expect(mocks.getUserAgentWalletBalance).not.toHaveBeenCalled();
  expect(mocks.acceptInboundConversationMessage).not.toHaveBeenCalled();
  expect(mocks.buildRepresentativeRuntimeProfile).not.toHaveBeenCalled();
  expect(mocks.createConversationPlan).not.toHaveBeenCalled();
  expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
}

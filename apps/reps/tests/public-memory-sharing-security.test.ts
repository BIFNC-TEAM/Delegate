import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createContactMemorySharingChallenge: vi.fn(),
  getContactMemorySharingState: vi.fn(),
  grantContactMemorySharingConsent: vi.fn(),
  publicAudiencePrincipalErrorStatus: vi.fn(),
  revalidate: vi.fn(),
  resolvePublicAudienceRequestPrincipal: vi.fn(),
  revokeContactMemorySharingConsent: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  contactMemorySharingConsentContractVersion:
    "cross-channel-contact-memory-v1",
  createContactMemorySharingChallenge:
    mocks.createContactMemorySharingChallenge,
  getContactMemorySharingState: mocks.getContactMemorySharingState,
  grantContactMemorySharingConsent: mocks.grantContactMemorySharingConsent,
  revokeContactMemorySharingConsent: mocks.revokeContactMemorySharingConsent,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: vi.fn() }),
}));

vi.mock("../app/reps/[slug]/public-principal", () => ({
  publicAudiencePrincipalErrorStatus:
    mocks.publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal:
    mocks.resolvePublicAudienceRequestPrincipal,
}));

import {
  DELETE as revokeMemorySharing,
  GET as getMemorySharing,
  POST as grantMemorySharing,
} from "../app/reps/[slug]/memory-sharing/route";

describe("public cross-channel memory consent security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(null);
    mocks.resolvePublicAudienceRequestPrincipal.mockResolvedValue({
      principal: {
        mode: "authenticated",
        audienceId: "signed-browser-audience",
        audienceIdentityId: "canonical-identity",
        businessKey: "audience:canonical-identity",
        sourceIdentityLinkId: "logto-link-1",
        sourceIdentityEvidence: {
          providerSubject: "logto-subject-1",
          issuer: "https://issuer.example",
          connectionId: "logto-connection-1",
        },
      },
      sessionState: {
        audienceId: "signed-browser-audience",
        sessionToken: "session-token",
        expiresAt: "2026-08-08T00:00:00.000Z",
      },
      revalidate: mocks.revalidate,
    });
    mocks.getContactMemorySharingState.mockResolvedValue({
      supported: true,
      policyEnabled: true,
      active: false,
      contractVersion: "cross-channel-contact-memory-v1",
      grantedAt: null,
      sourceChannel: null,
      blockedReason: "consent_missing",
    });
    mocks.createContactMemorySharingChallenge.mockResolvedValue({
      challengeToken: "A".repeat(43),
      challengeExpiresAt: "2026-08-07T10:10:00.000Z",
      contractVersion: "cross-channel-contact-memory-v1",
    });
    mocks.grantContactMemorySharingConsent.mockResolvedValue({ changed: true });
    mocks.revokeContactMemorySharingConsent.mockResolvedValue({
      changed: true,
      matchedMemoryCount: 3,
      queuedDeletionCount: 2,
    });
  });

  it("requires an authenticated canonical identity before reading state", async () => {
    mocks.resolvePublicAudienceRequestPrincipal.mockResolvedValueOnce({
      principal: {
        mode: "anonymous",
        audienceId: "anonymous-browser",
        audienceIdentityId: "anonymous-identity",
        businessKey: "audience:anonymous-identity",
        sourceIdentityLinkId: null,
        sourceIdentityEvidence: null,
      },
      sessionState: {
        audienceId: "anonymous-browser",
        sessionToken: "anonymous-token",
        expiresAt: "2026-08-08T00:00:00.000Z",
      },
      revalidate: mocks.revalidate,
    });

    const response = await getMemorySharing(
      new Request("http://localhost/reps/delegate/memory-sharing"),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(401);
    expect(mocks.getContactMemorySharingState).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("uses only the principal resolver's canonical identity", async () => {
    const response = await getMemorySharing(
      new Request(
        "http://localhost/reps/delegate/memory-sharing?audienceIdentityId=attacker",
      ),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.resolvePublicAudienceRequestPrincipal).toHaveBeenCalledWith({
      representativeSlug: "delegate",
      cookieStore: expect.objectContaining({ get: expect.any(Function) }),
    });
    expect(mocks.getContactMemorySharingState).toHaveBeenCalledWith({
      representativeSlug: "delegate",
      audienceIdentityId: "canonical-identity",
    });
    expect(mocks.createContactMemorySharingChallenge).toHaveBeenCalledWith({
      representativeSlug: "delegate",
      audienceIdentityId: "canonical-identity",
      disclosureContractVersion: "cross-channel-contact-memory-v1",
      sourceEventKey: expect.stringMatching(/^web-disclosure:/u),
      sourceChannel: "WEB",
      sourceIdentityLinkId: "logto-link-1",
      providerSubject: "logto-subject-1",
      issuer: "https://issuer.example",
      connectionId: "logto-connection-1",
    });
  });

  it("whitelists public state and never returns internal identity or retrieval diagnostics", async () => {
    mocks.getContactMemorySharingState.mockResolvedValueOnce({
      supported: true,
      policyEnabled: true,
      active: true,
      contractVersion: "cross-channel-contact-memory-v1",
      grantedAt: new Date("2026-08-07T10:30:00.000Z"),
      sourceChannel: "WEB",
      blockedReason: null,
      audienceIdentityId: "canonical-identity",
      consentVersion: 4,
      policyRevision: 12,
      uri: "viking://user/private",
      score: 0.98,
    });

    const response = await getMemorySharing(
      new Request("http://localhost/reps/delegate/memory-sharing"),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      supported: true,
      policyEnabled: true,
      active: true,
      contractVersion: "cross-channel-contact-memory-v1",
      grantedAt: "2026-08-07T10:30:00.000Z",
      sourceChannel: "WEB",
      blockedReason: null,
      challengeToken: null,
      challengeExpiresAt: null,
    });
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  it("consumes only the server-issued challenge and ignores client identity evidence", async () => {
    mocks.getContactMemorySharingState.mockResolvedValueOnce({
      supported: true,
      policyEnabled: true,
      active: true,
      contractVersion: "cross-channel-contact-memory-v1",
      grantedAt: "2026-08-07T10:30:00.000Z",
      sourceChannel: "WEB",
      blockedReason: null,
    });
    const response = await grantMemorySharing(
      new Request("http://localhost/reps/delegate/memory-sharing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeToken: "A".repeat(43),
          audienceIdentityId: "attacker-controlled",
          sourceChannel: "TELEGRAM",
          sourceIdentityLinkId: "attacker-link",
          targetUri: "viking://attacker",
        }),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect(mocks.grantContactMemorySharingConsent).toHaveBeenCalledWith({
      representativeSlug: "delegate",
      audienceIdentityId: "canonical-identity",
      sourceChannel: "WEB",
      challengeToken: "A".repeat(43),
      sourceEventKey: expect.stringMatching(/^web-confirmation:/u),
      sourceIdentityLinkId: "logto-link-1",
      providerSubject: "logto-subject-1",
      issuer: "https://issuer.example",
      connectionId: "logto-connection-1",
    });
    expect(
      JSON.stringify(mocks.grantContactMemorySharingConsent.mock.calls),
    ).not.toContain("attacker-controlled");
  });

  it("rejects a missing one-time challenge before granting", async () => {
    const response = await grantMemorySharing(
      new Request("http://localhost/reps/delegate/memory-sharing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(mocks.grantContactMemorySharingConsent).not.toHaveBeenCalled();
  });

  it("authenticates before parsing a malformed consent body", async () => {
    mocks.resolvePublicAudienceRequestPrincipal.mockRejectedValueOnce(
      new Error("revoked-current-subject"),
    );
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValueOnce(401);

    const response = await grantMemorySharing(
      new Request("http://localhost/reps/delegate/memory-sharing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{invalid",
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(401);
    expect(mocks.grantContactMemorySharingConsent).not.toHaveBeenCalled();
  });

  it("revalidates before withdrawal and returns only safe cleanup counts", async () => {
    const response = await revokeMemorySharing(
      new Request("http://localhost/reps/delegate/memory-sharing", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect(mocks.revokeContactMemorySharingConsent).toHaveBeenCalledWith({
      representativeSlug: "delegate",
      audienceIdentityId: "canonical-identity",
      sourceChannel: "WEB",
    });
    await expect(response.json()).resolves.toEqual({
      supported: true,
      policyEnabled: true,
      active: false,
      contractVersion: "cross-channel-contact-memory-v1",
      grantedAt: null,
      sourceChannel: null,
      blockedReason: "consent_missing",
      challengeToken: null,
      challengeExpiresAt: null,
      changed: true,
      matchedMemoryCount: 3,
      queuedDeletionCount: 2,
    });
  });

  it("does not expose unexpected server block reasons", async () => {
    mocks.getContactMemorySharingState.mockResolvedValueOnce({
      supported: true,
      policyEnabled: true,
      active: false,
      contractVersion: "cross-channel-contact-memory-v1",
      grantedAt: null,
      sourceChannel: null,
      blockedReason: "internal_database_primary_key_conflict",
    });

    const response = await getMemorySharing(
      new Request("http://localhost/reps/delegate/memory-sharing"),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    await expect(response.json()).resolves.toMatchObject({
      blockedReason: "unavailable",
    });
  });
});

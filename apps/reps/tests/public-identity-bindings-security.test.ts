import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createIdentityBindingChallenge: vi.fn(),
  isVerifiedPrivateChannelIdentityBinding: vi.fn(),
  listActivePrivateChannelIdentityBindings: vi.fn(),
  publicAudiencePrincipalErrorStatus: vi.fn(),
  revokePrivateChannelIdentityBinding: vi.fn(),
  resolveMatrixApplicationServiceConnectionId: vi.fn(),
  resolveRepresentativeTelegramBotEndpoint: vi.fn(),
  resolvePublicAudienceRequestPrincipal: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  createIdentityBindingChallenge: mocks.createIdentityBindingChallenge,
  isVerifiedPrivateChannelIdentityBinding:
    mocks.isVerifiedPrivateChannelIdentityBinding,
  listActivePrivateChannelIdentityBindings:
    mocks.listActivePrivateChannelIdentityBindings,
  privateChannelIdentityProviders: {
    matrix: "MATRIX",
    telegram: "TELEGRAM",
  },
  revokePrivateChannelIdentityBinding:
    mocks.revokePrivateChannelIdentityBinding,
  resolveMatrixApplicationServiceConnectionId:
    mocks.resolveMatrixApplicationServiceConnectionId,
  resolveRepresentativeTelegramBotEndpoint:
    mocks.resolveRepresentativeTelegramBotEndpoint,
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
  DELETE as revokeIdentityBinding,
  GET as listIdentityBindings,
  POST as createIdentityBinding,
} from "../app/reps/[slug]/identity-bindings/route";

const originalTelegramBotId = process.env.TELEGRAM_BOT_ID;
const originalTelegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const originalMatrixHomeserverUrl = process.env.MATRIX_HOMESERVER_URL;
const originalMatrixServerName = process.env.MATRIX_SERVER_NAME;
const originalMatrixConnectionId = process.env.MATRIX_AS_CONNECTION_ID;

describe("public identity binding principal enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TELEGRAM_BOT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.MATRIX_HOMESERVER_URL = "https://matrix.example";
    process.env.MATRIX_SERVER_NAME = "matrix.example";
    process.env.MATRIX_AS_CONNECTION_ID = "matrix-appservice";
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(null);
    mocks.resolveMatrixApplicationServiceConnectionId.mockReturnValue(
      "matrix-appservice",
    );
    mocks.resolveRepresentativeTelegramBotEndpoint.mockResolvedValue({
      botId: "8718299151",
      username: "delegate_test_bot",
    });
    mocks.isVerifiedPrivateChannelIdentityBinding.mockImplementation(
      (binding: { provider?: string }) => binding.provider === "TELEGRAM",
    );
    mocks.resolvePublicAudienceRequestPrincipal.mockResolvedValue({
      principal: {
        mode: "authenticated",
        audienceId: "signed-device-audience",
        audienceIdentityId: "canonical-identity",
        businessKey: "audience:canonical-identity",
      },
      sessionState: {
        audienceId: "signed-device-audience",
        sessionToken: "public-session-token",
        expiresAt: "2026-08-01T00:00:00.000Z",
      },
      revalidate: vi.fn(),
    });
    mocks.listActivePrivateChannelIdentityBindings.mockResolvedValue([
      { id: "binding-1", provider: "MATRIX" },
    ]);
    mocks.createIdentityBindingChallenge.mockResolvedValue({
      token: "bind-token",
      expiresAt: new Date("2026-08-01T00:05:00.000Z"),
    });
    mocks.revokePrivateChannelIdentityBinding.mockResolvedValue({
      binding: {
        provider: "TELEGRAM",
        providerSubject: "123456",
        issuer: "delegate-managed-bot",
        connectionId: "8718299151",
      },
      changed: true,
    });
  });

  afterEach(() => {
    restoreEnv("TELEGRAM_BOT_ID", originalTelegramBotId);
    restoreEnv("TELEGRAM_BOT_TOKEN", originalTelegramBotToken);
    restoreEnv("MATRIX_HOMESERVER_URL", originalMatrixHomeserverUrl);
    restoreEnv("MATRIX_SERVER_NAME", originalMatrixServerName);
    restoreEnv("MATRIX_AS_CONNECTION_ID", originalMatrixConnectionId);
  });

  it("returns 401 from GET before listing when the current subject is invalid", async () => {
    mocks.resolvePublicAudienceRequestPrincipal.mockRejectedValue(
      new Error("revoked_current_subject"),
    );
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(401);

    const response = await listIdentityBindings(
      new Request("http://localhost/reps/delegate/identity-bindings"),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(401);
    expect(mocks.listActivePrivateChannelIdentityBindings).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Sign in before binding a channel.",
    });
  });

  it("returns 401 from POST before creating when the current subject is invalid", async () => {
    mocks.resolvePublicAudienceRequestPrincipal.mockRejectedValue(
      new Error("revoked_current_subject"),
    );
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(401);

    const response = await createIdentityBinding(
      matrixBindingRequest(),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(401);
    expect(mocks.createIdentityBindingChallenge).not.toHaveBeenCalled();
  });

  it("returns 401 from DELETE before parsing an invalid request body", async () => {
    mocks.resolvePublicAudienceRequestPrincipal.mockRejectedValue(
      new Error("revoked_current_subject"),
    );
    mocks.publicAudiencePrincipalErrorStatus.mockReturnValue(401);

    const response = await revokeIdentityBinding(
      new Request("http://localhost/reps/delegate/identity-bindings", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{invalid",
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(401);
    expect(mocks.revokePrivateChannelIdentityBinding).not.toHaveBeenCalled();
  });

  it("uses only the resolver's canonical identity for GET and POST business calls", async () => {
    const listResponse = await listIdentityBindings(
      new Request("http://localhost/reps/delegate/identity-bindings"),
      { params: Promise.resolve({ slug: "delegate" }) },
    );
    const createResponse = await createIdentityBinding(
      matrixBindingRequest(),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(listResponse.status).toBe(200);
    expect(createResponse.status).toBe(201);
    expect(mocks.resolvePublicAudienceRequestPrincipal).toHaveBeenCalledWith({
      representativeSlug: "delegate",
      cookieStore: expect.objectContaining({ get: expect.any(Function) }),
    });
    expect(mocks.listActivePrivateChannelIdentityBindings).toHaveBeenCalledWith(
      "canonical-identity",
    );
    expect(mocks.createIdentityBindingChallenge).toHaveBeenCalledWith({
      audienceIdentityId: "canonical-identity",
      provider: "MATRIX",
      issuer: "matrix.example",
      connectionId: "matrix-appservice",
      expectedProviderSubject: "@neo:matrix.example",
      metadata: {
        representativeSlug: "delegate",
        requestedFrom: "representative_web",
      },
    });
    expect(
      JSON.stringify(mocks.createIdentityBindingChallenge.mock.calls),
    ).not.toContain("signed-device-audience");
  });

  it("reports Telegram readiness only for the exact active Bot connection", async () => {
    const oldBinding = {
      provider: "TELEGRAM",
      providerSubject: "123456",
      issuer: "delegate-managed-bot",
      connectionId: "old-bot",
      verifiedAt: "2026-07-27T00:00:00.000Z",
      assuranceLevel: "PLATFORM_VERIFIED",
    };
    mocks.listActivePrivateChannelIdentityBindings.mockResolvedValue([
      oldBinding,
    ]);
    mocks.isVerifiedPrivateChannelIdentityBinding.mockReturnValue(false);

    const response = await listIdentityBindings(
      new Request("http://localhost/reps/delegate/identity-bindings"),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      bindings: [oldBinding],
      readiness: { telegram: false, matrix: false },
      capabilities: { telegram: true, matrix: true },
      telegramBot: {
        botId: "8718299151",
        username: "delegate_test_bot",
      },
    });
    expect(mocks.isVerifiedPrivateChannelIdentityBinding).toHaveBeenCalledWith(
      oldBinding,
      {
        provider: "TELEGRAM",
        issuer: "delegate-managed-bot",
        connectionId: "8718299151",
      },
    );
  });

  it("uses the Bot-validated persisted connection for a Telegram challenge", async () => {
    const response = await createIdentityBinding(
      new Request("http://localhost/reps/delegate/identity-bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "telegram" }),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(201);
    expect(
      mocks.resolveRepresentativeTelegramBotEndpoint,
    ).toHaveBeenCalledWith("delegate");
    expect(mocks.createIdentityBindingChallenge).toHaveBeenCalledWith({
      audienceIdentityId: "canonical-identity",
      provider: "TELEGRAM",
      issuer: "delegate-managed-bot",
      connectionId: "8718299151",
      metadata: {
        representativeSlug: "delegate",
        requestedFrom: "representative_web",
      },
    });
    await expect(response.json()).resolves.toEqual({
      provider: "telegram",
      expiresAt: new Date("2026-08-01T00:05:00.000Z").toISOString(),
      command: "/bind bind-token",
      scope: {
        issuer: "delegate-managed-bot",
        connectionId: "8718299151",
      },
      telegramBot: {
        botId: "8718299151",
        username: "delegate_test_bot",
      },
    });
  });

  it("returns 503 instead of creating an unscoped Telegram challenge", async () => {
    mocks.resolveRepresentativeTelegramBotEndpoint.mockResolvedValue(null);

    const response = await createIdentityBinding(
      new Request("http://localhost/reps/delegate/identity-bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "telegram" }),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(503);
    expect(mocks.createIdentityBindingChallenge).not.toHaveBeenCalled();
  });

  it("returns 503 instead of minting a Matrix challenge when the adapter is unavailable", async () => {
    delete process.env.MATRIX_HOMESERVER_URL;
    delete process.env.MATRIX_SERVER_NAME;

    const response = await createIdentityBinding(
      matrixBindingRequest(),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(503);
    expect(mocks.createIdentityBindingChallenge).not.toHaveBeenCalled();
  });

  it("revokes only the authenticated identity's exact Telegram Bot proof", async () => {
    const response = await revokeIdentityBinding(
      telegramRevocationRequest(),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(mocks.revokePrivateChannelIdentityBinding).toHaveBeenCalledWith({
      audienceIdentityId: "canonical-identity",
      provider: "TELEGRAM",
      providerSubject: "123456",
      issuer: "delegate-managed-bot",
      connectionId: "8718299151",
    });
    await expect(response.json()).resolves.toEqual({
      binding: {
        provider: "TELEGRAM",
        providerSubject: "123456",
        issuer: "delegate-managed-bot",
        connectionId: "8718299151",
      },
      changed: true,
    });
  });

  it("rejects an invalid Telegram Bot scope without touching persistence", async () => {
    const response = await revokeIdentityBinding(
      new Request("http://localhost/reps/delegate/identity-bindings", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "telegram",
          providerSubject: "123456",
          issuer: "delegate-managed-bot",
          connectionId: "not-a-bot-id",
        }),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.revokePrivateChannelIdentityBinding).not.toHaveBeenCalled();
  });

  it("maps an exhausted serializable conflict to a retryable 409", async () => {
    mocks.revokePrivateChannelIdentityBinding.mockRejectedValue(
      Object.assign(new Error("serialization failure"), { code: "P2034" }),
    );

    const response = await revokeIdentityBinding(
      telegramRevocationRequest(),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      error: "The binding changed concurrently. Please retry.",
    });
  });
});

function matrixBindingRequest() {
  return new Request("http://localhost/reps/delegate/identity-bindings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "matrix",
      providerSubject: "@neo:matrix.example",
    }),
  });
}

function telegramRevocationRequest() {
  return new Request("http://localhost/reps/delegate/identity-bindings", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "telegram",
      providerSubject: "123456",
      issuer: "delegate-managed-bot",
      connectionId: "8718299151",
    }),
  });
}

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === "undefined") {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

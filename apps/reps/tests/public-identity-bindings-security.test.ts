import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createIdentityBindingChallenge: vi.fn(),
  isVerifiedPrivateChannelIdentityBinding: vi.fn(),
  listActivePrivateChannelIdentityBindings: vi.fn(),
  publicAudiencePrincipalErrorStatus: vi.fn(),
  revokePrivateChannelIdentityBinding: vi.fn(),
  resolveRepresentativeMatrixEndpoint: vi.fn(),
  resolveRepresentativeTelegramBotEndpoint: vi.fn(),
  resolvePublicAudienceRequestPrincipal: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  createIdentityBindingChallenge: mocks.createIdentityBindingChallenge,
  isVerifiedPrivateChannelIdentityBinding:
    mocks.isVerifiedPrivateChannelIdentityBinding,
  listActivePrivateChannelIdentityBindings:
    mocks.listActivePrivateChannelIdentityBindings,
  matrixServerNameFromUserId: (value: string) => {
    const normalized = normalizeTestMatrixUserId(value);
    return normalized.slice(normalized.indexOf(":") + 1);
  },
  normalizeMatrixUserId: normalizeTestMatrixUserId,
  privateChannelIdentityProviders: {
    matrix: "MATRIX",
    telegram: "TELEGRAM",
  },
  revokePrivateChannelIdentityBinding:
    mocks.revokePrivateChannelIdentityBinding,
  resolveRepresentativeMatrixEndpoint:
    mocks.resolveRepresentativeMatrixEndpoint,
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
    mocks.resolveRepresentativeMatrixEndpoint.mockResolvedValue({
      matrixUserId: "@_delegate_rep_delegate:matrix.example",
      connectionId: "matrix-appservice",
    });
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
      matrixEndpoint: {
        matrixUserId: "@_delegate_rep_delegate:matrix.example",
        connectionId: "matrix-appservice",
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

  it("hides Matrix capability when this representative has no routable Matrix endpoint", async () => {
    mocks.resolveRepresentativeMatrixEndpoint.mockResolvedValue(null);

    const response = await listIdentityBindings(
      new Request("http://localhost/reps/delegate/identity-bindings"),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      readiness: { telegram: false, matrix: false },
      capabilities: { telegram: true, matrix: false },
      matrixEndpoint: null,
    });
  });

  it("does not report Matrix ready for a binding from a different homeserver issuer", async () => {
    const wrongHomeserverBinding = {
      provider: "MATRIX",
      providerSubject: "@neo:MATRIX.EXAMPLE",
      issuer: "MATRIX.EXAMPLE",
      connectionId: "matrix-appservice",
      verifiedAt: "2026-07-27T00:00:00.000Z",
      assuranceLevel: "PLATFORM_VERIFIED",
    };
    mocks.listActivePrivateChannelIdentityBindings.mockResolvedValue([
      wrongHomeserverBinding,
    ]);
    mocks.isVerifiedPrivateChannelIdentityBinding.mockImplementation(
      (
        binding: typeof wrongHomeserverBinding,
        expected: {
          provider: string;
          issuer: string;
          connectionId: string;
        },
      ) =>
        binding.provider === expected.provider
        && binding.issuer === expected.issuer
        && binding.connectionId === expected.connectionId,
    );

    const response = await listIdentityBindings(
      new Request("http://localhost/reps/delegate/identity-bindings"),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      readiness: { matrix: false },
    });
    expect(mocks.isVerifiedPrivateChannelIdentityBinding).toHaveBeenCalledWith(
      wrongHomeserverBinding,
      {
        provider: "MATRIX",
        issuer: "matrix.example",
        connectionId: "matrix-appservice",
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

  it("returns 503 instead of minting a Matrix challenge when the representative endpoint is unavailable", async () => {
    mocks.resolveRepresentativeMatrixEndpoint.mockResolvedValue(null);

    const response = await createIdentityBinding(
      matrixBindingRequest(),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(503);
    expect(mocks.createIdentityBindingChallenge).not.toHaveBeenCalled();
  });

  it("returns the exact Matrix destination and account-bound subject with the command", async () => {
    const response = await createIdentityBinding(
      new Request("http://localhost/reps/delegate/identity-bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "matrix",
          providerSubject: "@Neo:MATRIX.EXAMPLE",
        }),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(201);
    expect(mocks.resolveRepresentativeMatrixEndpoint).toHaveBeenCalledWith(
      "delegate",
    );
    expect(mocks.createIdentityBindingChallenge).toHaveBeenCalledWith({
      audienceIdentityId: "canonical-identity",
      provider: "MATRIX",
      issuer: "MATRIX.EXAMPLE",
      connectionId: "matrix-appservice",
      expectedProviderSubject: "@Neo:MATRIX.EXAMPLE",
      metadata: {
        representativeSlug: "delegate",
        requestedFrom: "representative_web",
      },
    });
    await expect(response.json()).resolves.toEqual({
      provider: "matrix",
      expiresAt: new Date("2026-08-01T00:05:00.000Z").toISOString(),
      command: "!bind bind-token",
      scope: {
        issuer: "MATRIX.EXAMPLE",
        connectionId: "matrix-appservice",
      },
      expectedProviderSubject: "@Neo:MATRIX.EXAMPLE",
      matrixEndpoint: {
        matrixUserId: "@_delegate_rep_delegate:matrix.example",
        connectionId: "matrix-appservice",
      },
    });
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

  it("preserves the exact Matrix MXID issuer while normalizing only the internal connection id", async () => {
    mocks.revokePrivateChannelIdentityBinding.mockResolvedValue({
      binding: {
        provider: "MATRIX",
        providerSubject: "@neo:MATRIX.EXAMPLE",
        issuer: "MATRIX.EXAMPLE",
        connectionId: "matrix-appservice",
      },
      changed: true,
    });

    const response = await revokeIdentityBinding(
      new Request("http://localhost/reps/delegate/identity-bindings", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "matrix",
          providerSubject: "@neo:MATRIX.EXAMPLE",
          issuer: "MATRIX.EXAMPLE",
          connectionId: "Matrix-AppService",
        }),
      }),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.revokePrivateChannelIdentityBinding).toHaveBeenCalledWith({
      audienceIdentityId: "canonical-identity",
      provider: "MATRIX",
      providerSubject: "@neo:MATRIX.EXAMPLE",
      issuer: "MATRIX.EXAMPLE",
      connectionId: "matrix-appservice",
    });
  });

  it("rejects a Matrix issuer that differs from the MXID server only by case", async () => {
    const response = await revokeIdentityBinding(
      new Request("http://localhost/reps/delegate/identity-bindings", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "matrix",
          providerSubject: "@neo:MATRIX.EXAMPLE",
          issuer: "matrix.example",
          connectionId: "matrix-appservice",
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

  it("returns 500 for an unexpected persistence failure", async () => {
    mocks.listActivePrivateChannelIdentityBindings.mockRejectedValue(
      new Error("database connection failed"),
    );

    const response = await listIdentityBindings(
      new Request("http://localhost/reps/delegate/identity-bindings"),
      { params: Promise.resolve({ slug: "delegate" }) },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      error: "Unable to manage identity bindings.",
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

function normalizeTestMatrixUserId(value: string) {
  const matrixUserId = value.trim();
  const separator = matrixUserId.indexOf(":", 1);
  if (
    matrixUserId[0] !== "@"
    || separator <= 1
    || separator === matrixUserId.length - 1
  ) {
    throw new Error("Matrix user id must be a full MXID.");
  }
  return matrixUserId;
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

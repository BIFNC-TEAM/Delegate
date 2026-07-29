import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  createIdentityBindingChallenge,
  getIdentityBindingChallengeStatus,
  isVerifiedPrivateChannelIdentityBinding,
  listActivePrivateChannelIdentityBindings,
  matrixServerNameFromUserId,
  normalizeMatrixUserId,
  privateChannelIdentityProviders,
  revokePrivateChannelIdentityBinding,
  resolveRepresentativeMatrixEndpoint,
  resolveRepresentativeTelegramBotEndpoint,
} from "@delegate/web-data";

import {
  publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal,
} from "../public-principal";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const principal = await requireAudiencePrincipal(slug);
    const challengeId = readChallengeId(request);
    if (challengeId) {
      const challenge = await getIdentityBindingChallengeStatus({
        audienceIdentityId: principal.audienceIdentityId,
        challengeId,
      });
      if (!challenge) {
        throw new IdentityBindingHttpError(
          404,
          "Identity binding challenge was not found.",
        );
      }
      return noStoreJson({
        challengeId: challenge.challengeId,
        status: challenge.status,
        expiresAt: challenge.expiresAt,
        ...(challenge.providerSubject
          ? { providerSubject: challenge.providerSubject }
          : {}),
      });
    }

    const bindings = await listActivePrivateChannelIdentityBindings(
      principal.audienceIdentityId,
    );
    const telegramBot =
      await resolveRepresentativeTelegramBotEndpoint(slug);
    const matrixEndpoint =
      await resolveRepresentativeMatrixEndpoint(slug);
    const currentTelegramBindings = telegramBot
      ? bindings.filter((binding) =>
          isVerifiedPrivateChannelIdentityBinding(binding, {
            provider: privateChannelIdentityProviders.telegram,
            issuer: "delegate-managed-bot",
            connectionId: telegramBot.botId,
          }),
        )
      : [];
    const currentMatrixBindings = matrixEndpoint
      ? bindings.filter((binding) =>
          isCurrentMatrixBinding(binding, matrixEndpoint.connectionId),
        )
      : [];
    return noStoreJson({
      bindings,
      currentBindings: {
        telegram: currentTelegramBindings,
        matrix: currentMatrixBindings,
      },
      readiness: {
        telegram: currentTelegramBindings.length > 0,
        matrix: currentMatrixBindings.length > 0,
      },
      capabilities: {
        telegram: telegramBot !== null,
        matrix: matrixEndpoint !== null,
      },
      telegramBot,
      matrixEndpoint,
    });
  } catch (error) {
    return bindingError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const principal = await requireAudiencePrincipal(slug);
    const body = await readBindingRequest(request);
    const provider = privateChannelIdentityProviders[body.provider];
    const expectedProviderSubject =
      body.provider === "matrix"
        ? normalizeMatrixUserIdForRequest(body.providerSubject)
        : undefined;
    const issuer =
      body.provider === "matrix" && expectedProviderSubject
        ? matrixHomeserverForRequest(expectedProviderSubject)
        : "delegate-managed-bot";
    const telegramBot =
      body.provider === "telegram"
        ? await requireTelegramBotEndpoint(slug)
        : null;
    const matrixEndpoint =
      body.provider === "matrix"
        ? await requireMatrixEndpoint(slug)
        : null;
    const connectionId = body.provider === "matrix"
      ? matrixEndpoint!.connectionId
      : telegramBot!.botId;
    const grant = await createIdentityBindingChallenge({
      audienceIdentityId: principal.audienceIdentityId,
      provider,
      issuer,
      connectionId,
      ...(expectedProviderSubject ? { expectedProviderSubject } : {}),
      metadata: {
        representativeSlug: slug,
        requestedFrom: "representative_web",
      },
    });

    return noStoreJson(
      {
        challengeId: grant.challengeId,
        provider: body.provider,
        expiresAt: grant.expiresAt,
        command:
          body.provider === "telegram"
            ? `/bind ${grant.token}`
            : `!bind ${grant.token}`,
        scope: {
          issuer,
          connectionId,
        },
        ...(expectedProviderSubject ? { expectedProviderSubject } : {}),
        ...(telegramBot ? { telegramBot } : {}),
        ...(matrixEndpoint ? { matrixEndpoint } : {}),
      },
      201,
    );
  } catch (error) {
    return bindingError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const principal = await requireAudiencePrincipal(slug);
    const body = await readRevocationRequest(request);
    const result = await revokePrivateChannelIdentityBinding({
      audienceIdentityId: principal.audienceIdentityId,
      provider: privateChannelIdentityProviders[body.provider],
      providerSubject: body.providerSubject,
      issuer: body.issuer,
      connectionId: body.connectionId,
    });
    return noStoreJson(result);
  } catch (error) {
    return bindingError(error);
  }
}

async function requireAudiencePrincipal(representativeSlug: string) {
  const { principal } = await resolvePublicAudienceRequestPrincipal({
    representativeSlug,
    cookieStore: await cookies(),
  });
  if (principal.mode !== "authenticated") {
    throw new IdentityBindingHttpError(401, "Sign in before binding a channel.");
  }
  return principal;
}

function readChallengeId(request: Request): string | null {
  const url = new URL(request.url);
  if (!url.searchParams.has("challengeId")) return null;
  const challengeId = url.searchParams.get("challengeId")?.trim() ?? "";
  if (!challengeId || challengeId.length > 255) {
    throw new IdentityBindingHttpError(
      400,
      "A valid identity binding challenge id is required.",
    );
  }
  return challengeId;
}

function isCurrentMatrixBinding(
  binding: Awaited<
    ReturnType<typeof listActivePrivateChannelIdentityBindings>
  >[number],
  connectionId: string,
) {
  try {
    const issuer = matrixServerNameFromUserId(binding.providerSubject);
    return isVerifiedPrivateChannelIdentityBinding(binding, {
      provider: privateChannelIdentityProviders.matrix,
      issuer,
      connectionId,
    });
  } catch {
    return false;
  }
}

async function readBindingRequest(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new IdentityBindingHttpError(400, "A JSON request body is required.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new IdentityBindingHttpError(400, "Invalid identity binding request.");
  }
  const value = body as Record<string, unknown>;
  const provider = typeof value.provider === "string"
    ? value.provider.trim().toLowerCase()
    : "";
  if (provider !== "telegram" && provider !== "matrix") {
    throw new IdentityBindingHttpError(400, "Provider must be telegram or matrix.");
  }
  const providerSubject = typeof value.providerSubject === "string"
    ? value.providerSubject.trim()
    : "";
  if (provider === "matrix" && !providerSubject) {
    throw new IdentityBindingHttpError(
      400,
      "A full Matrix user id is required so the challenge is account-bound.",
    );
  }
  return {
    provider,
    providerSubject:
      provider === "matrix"
        ? normalizeMatrixUserIdForRequest(providerSubject)
        : providerSubject,
  } as const;
}

async function readRevocationRequest(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new IdentityBindingHttpError(400, "A JSON request body is required.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new IdentityBindingHttpError(400, "Invalid identity binding request.");
  }
  const value = body as Record<string, unknown>;
  const provider = typeof value.provider === "string"
    ? value.provider.trim().toLowerCase()
    : "";
  const providerSubject = typeof value.providerSubject === "string"
    ? value.providerSubject.trim()
    : "";
  const issuer = typeof value.issuer === "string"
    ? value.issuer.trim()
    : "";
  const connectionId = typeof value.connectionId === "string"
    ? value.connectionId.trim()
    : "";
  if (provider !== "telegram" && provider !== "matrix") {
    throw new IdentityBindingHttpError(400, "Provider must be telegram or matrix.");
  }
  if (!providerSubject || !issuer || !connectionId) {
    throw new IdentityBindingHttpError(
      400,
      "providerSubject, issuer, and connectionId are required.",
    );
  }
  if (issuer.length > 255 || connectionId.length > 255) {
    throw new IdentityBindingHttpError(
      400,
      "Issuer and connectionId must be at most 255 characters.",
    );
  }
  if (provider === "telegram") {
    if (!/^[1-9]\d{0,19}$/.test(providerSubject)) {
      throw new IdentityBindingHttpError(
        400,
        "Telegram provider subject must be a numeric user id.",
      );
    }
    if (issuer.toLowerCase() !== "delegate-managed-bot") {
      throw new IdentityBindingHttpError(
        400,
        "Telegram binding issuer is invalid.",
      );
    }
    if (!/^[1-9]\d{0,19}$/.test(connectionId)) {
      throw new IdentityBindingHttpError(
        400,
        "Telegram connectionId must be a numeric Bot id.",
      );
    }
  } else {
    const normalizedProviderSubject =
      normalizeMatrixUserIdForRequest(providerSubject);
    if (matrixHomeserverForRequest(normalizedProviderSubject) !== issuer) {
      throw new IdentityBindingHttpError(
        400,
        "Matrix binding issuer must match the MXID homeserver.",
      );
    }
    return {
      provider,
      providerSubject: normalizedProviderSubject,
      issuer,
      connectionId: connectionId.toLowerCase(),
    } as const;
  }
  return {
    provider,
    providerSubject,
    issuer: issuer.toLowerCase(),
    connectionId: connectionId.toLowerCase(),
  } as const;
}

function normalizeMatrixUserIdForRequest(matrixUserId: string) {
  try {
    return normalizeMatrixUserId(matrixUserId);
  } catch {
    throw new IdentityBindingHttpError(400, "Matrix user id must be a full MXID.");
  }
}

function matrixHomeserverForRequest(matrixUserId: string) {
  try {
    return matrixServerNameFromUserId(matrixUserId);
  } catch {
    throw new IdentityBindingHttpError(400, "Matrix user id must be a full MXID.");
  }
}

async function requireTelegramBotEndpoint(representativeSlug: string) {
  const endpoint =
    await resolveRepresentativeTelegramBotEndpoint(representativeSlug);
  if (!endpoint) {
    throw new IdentityBindingHttpError(
      503,
      "Telegram binding requires a configured numeric bot id.",
    );
  }
  return endpoint;
}

async function requireMatrixEndpoint(representativeSlug: string) {
  const endpoint =
    await resolveRepresentativeMatrixEndpoint(representativeSlug);
  if (!endpoint) {
    throw new IdentityBindingHttpError(
      503,
      "Matrix binding requires an active representative Matrix user and Application Service connection.",
    );
  }
  return endpoint;
}

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, private",
      Pragma: "no-cache",
    },
  });
}

function bindingError(error: unknown) {
  const status =
    publicAudiencePrincipalErrorStatus(error)
    ?? (isPrismaWriteConflict(error) ? 409 : null)
    ?? (error instanceof IdentityBindingHttpError ? error.status : 500);
  return noStoreJson(
    {
      error:
        status === 401
          ? "Sign in before binding a channel."
          : status === 409
            ? "The binding changed concurrently. Please retry."
          : error instanceof IdentityBindingHttpError
            ? error.message
          : "Unable to manage identity bindings.",
    },
    status,
  );
}

function isPrismaWriteConflict(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "P2034",
  );
}

class IdentityBindingHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "IdentityBindingHttpError";
  }
}

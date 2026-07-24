import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  createIdentityBindingChallenge,
  listActivePrivateChannelIdentityBindings,
  privateChannelIdentityProviders,
  readDelegateAuthSessionSecret,
  resolveMatrixApplicationServiceConnectionId,
  verifyDelegateAuthSession,
} from "@delegate/web-data";

export async function GET() {
  try {
    const session = await requireAudienceSession();
    const bindings = await listActivePrivateChannelIdentityBindings(
      session.audienceIdentityId,
    );
    return noStoreJson({ bindings });
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
    const session = await requireAudienceSession();
    const body = await readBindingRequest(request);
    const provider = privateChannelIdentityProviders[body.provider];
    const expectedProviderSubject = body.providerSubject || undefined;
    const issuer =
      body.provider === "matrix" && expectedProviderSubject
        ? matrixHomeserver(expectedProviderSubject)
        : "delegate-managed-bot";
    const connectionId =
      body.provider === "matrix"
        ? resolveMatrixApplicationServiceConnectionId()
        : telegramBotConnectionId();
    const grant = await createIdentityBindingChallenge({
      audienceIdentityId: session.audienceIdentityId,
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
        provider: body.provider,
        expiresAt: grant.expiresAt,
        command:
          body.provider === "telegram"
            ? `/bind ${grant.token}`
            : `!bind ${grant.token}`,
      },
      201,
    );
  } catch (error) {
    return bindingError(error);
  }
}

async function requireAudienceSession() {
  const cookieStore = await cookies();
  const session = verifyDelegateAuthSession(
    cookieStore.get(DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE)?.value
      ?? cookieStore.get(LEGACY_DELEGATE_AUTH_SESSION_COOKIE)?.value,
    readDelegateAuthSessionSecret(),
  );
  if (
    session?.actor !== "audience"
    || !session.audienceIdentityId?.trim()
  ) {
    throw new IdentityBindingHttpError(401, "Sign in before binding a channel.");
  }
  return {
    ...session,
    audienceIdentityId: session.audienceIdentityId.trim(),
  };
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
  return { provider, providerSubject } as const;
}

function matrixHomeserver(matrixUserId: string) {
  const separator = matrixUserId.lastIndexOf(":");
  if (
    !matrixUserId.startsWith("@")
    || separator <= 1
    || separator === matrixUserId.length - 1
  ) {
    throw new IdentityBindingHttpError(400, "Matrix user id must be a full MXID.");
  }
  return matrixUserId.slice(separator + 1).toLowerCase();
}

function telegramBotConnectionId() {
  const configuredId = process.env.TELEGRAM_BOT_ID?.trim();
  const tokenId = process.env.TELEGRAM_BOT_TOKEN?.trim().match(/^([1-9]\d*):/)?.[1];
  const connectionId = configuredId || tokenId;
  if (!connectionId || !/^[1-9]\d*$/.test(connectionId)) {
    throw new IdentityBindingHttpError(
      503,
      "Telegram binding requires a configured numeric bot id.",
    );
  }
  return connectionId;
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
  const status = error instanceof IdentityBindingHttpError ? error.status : 400;
  return noStoreJson(
    {
      error:
        error instanceof Error
          ? error.message
          : "Unable to manage identity bindings.",
    },
    status,
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

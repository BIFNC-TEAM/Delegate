import type { NextResponse } from "next/server";

import {
  DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  PublicAudiencePrincipalError,
  readDelegateAuthSessionSecret,
  resolvePublicAudiencePrincipal,
  verifyDelegateAuthSession,
  type PublicAudiencePrincipal,
} from "@delegate/web-data";

import {
  createPublicChatSessionState,
  getPublicChatCookieName,
  PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
  readPublicChatSessionState,
  shouldUseSecurePublicChatCookie,
  writePublicChatSessionState,
  type PublicChatSessionState,
} from "./public-chat";

type PublicAudienceCookieReader = {
  get(name: string): { value: string } | undefined;
};

export type PublicAudienceRequestPrincipal = {
  principal: PublicAudiencePrincipal;
  sessionState: PublicChatSessionState;
  /**
   * Revalidates the captured, server-verified auth session against current
   * identity-link state. Long-lived responses must call this periodically
   * instead of treating the request-start authorization as permanent.
   */
  revalidate(): Promise<void>;
};

/**
 * Verifies both signed browser cookies and delegates current identity-link
 * validation to web-data. A present but stale/revoked audience auth session is
 * never downgraded to anonymous access.
 */
export async function resolvePublicAudienceRequestPrincipal(input: {
  representativeSlug: string;
  cookieStore: PublicAudienceCookieReader;
}): Promise<PublicAudienceRequestPrincipal> {
  const publicCookieValue = input.cookieStore.get(
    getPublicChatCookieName(input.representativeSlug),
  )?.value;
  let sessionState = readPublicChatSessionState({
    representativeSlug: input.representativeSlug,
    cookieValue: publicCookieValue,
  });
  const audienceAuthCookieValue = input.cookieStore.get(
    DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
  )?.value;
  const authCookieValue =
    audienceAuthCookieValue
    ?? input.cookieStore.get(LEGACY_DELEGATE_AUTH_SESSION_COOKIE)?.value;
  const verifiedSession = verifyDelegateAuthSession(
    authCookieValue,
    readDelegateAuthSessionSecret(),
  );
  if (
    authCookieValue
    && (
      !verifiedSession
      || (audienceAuthCookieValue && verifiedSession.actor !== "audience")
    )
  ) {
    throw new PublicAudiencePrincipalError(
      "AUTHENTICATED_PRINCIPAL_INVALID",
      "The authenticated audience session is no longer valid.",
    );
  }
  const audienceAuthSession =
    verifiedSession?.actor === "audience" ? verifiedSession : null;

  if (audienceAuthSession) {
    if (!audienceAuthSession.audienceId?.trim()) {
      throw new PublicAudiencePrincipalError(
        "AUTHENTICATED_PRINCIPAL_INVALID",
        "The authenticated audience session is no longer valid.",
      );
    }
    sessionState = {
      ...sessionState,
      // The auth cookie is server-signed and records the anonymous browser
      // identity that was proof-bound during login. Restore it if the shorter
      // lived public-chat cookie expired or was replaced.
      audienceId: audienceAuthSession.audienceId,
    };
    const principal = await resolvePublicAudiencePrincipal({
      audienceId: sessionState.audienceId,
      verifiedAuthSession: audienceAuthSession,
    });
    return createRequestPrincipal({
      principal,
      sessionState,
      verifiedAuthSession: audienceAuthSession,
    });
  }

  try {
    const principal = await resolvePublicAudiencePrincipal({
      audienceId: sessionState.audienceId,
    });
    return createRequestPrincipal({
      principal,
      sessionState,
      verifiedAuthSession: null,
    });
  } catch (error) {
    if (
      !(error instanceof PublicAudiencePrincipalError)
      || error.code !== "ANONYMOUS_SESSION_ROTATION_REQUIRED"
    ) {
      throw error;
    }
    sessionState = createPublicChatSessionState();
    const principal = await resolvePublicAudiencePrincipal({
      audienceId: sessionState.audienceId,
    });
    return createRequestPrincipal({
      principal,
      sessionState,
      verifiedAuthSession: null,
    });
  }
}

function createRequestPrincipal(input: {
  principal: PublicAudiencePrincipal;
  sessionState: PublicChatSessionState;
  verifiedAuthSession: ReturnType<typeof verifyDelegateAuthSession>;
}): PublicAudienceRequestPrincipal {
  const expectedPrincipal = input.principal;
  const audienceId = input.sessionState.audienceId;
  const verifiedAuthSession = input.verifiedAuthSession;

  return {
    principal: expectedPrincipal,
    sessionState: input.sessionState,
    async revalidate() {
      if (
        verifiedAuthSession
        && verifiedAuthSession.expiresAt <= Math.floor(Date.now() / 1_000)
      ) {
        throw new PublicAudiencePrincipalError(
          "AUTHENTICATED_PRINCIPAL_INVALID",
          "The authenticated audience session is no longer valid.",
        );
      }

      const currentPrincipal = await resolvePublicAudiencePrincipal({
        audienceId,
        ...(verifiedAuthSession
          ? { verifiedAuthSession }
          : {}),
      });
      if (
        currentPrincipal.mode !== expectedPrincipal.mode
        || currentPrincipal.audienceId !== expectedPrincipal.audienceId
        || currentPrincipal.audienceIdentityId
          !== expectedPrincipal.audienceIdentityId
      ) {
        throw new PublicAudiencePrincipalError(
          "AUTHENTICATED_PRINCIPAL_INVALID",
          "The authenticated audience session is no longer valid.",
        );
      }
    },
  };
}

export function assertPublicAudienceResourceOwner(
  principal: PublicAudiencePrincipal,
  audienceIdentityId: string | null | undefined,
) {
  if (
    !audienceIdentityId
    || audienceIdentityId !== principal.audienceIdentityId
  ) {
    throw new PublicAudiencePrincipalError(
      "AUTHENTICATED_PRINCIPAL_INVALID",
      "The requested audience resource does not belong to the active principal.",
    );
  }
}

export function setPublicAudienceSessionCookie(
  response: NextResponse,
  request: Request,
  representativeSlug: string,
  sessionState: PublicChatSessionState,
) {
  response.cookies.set(
    getPublicChatCookieName(representativeSlug),
    writePublicChatSessionState({
      representativeSlug,
      state: sessionState,
    }),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecurePublicChatCookie(request),
      maxAge: PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
      path: `/reps/${representativeSlug}`,
    },
  );
}

export function publicAudiencePrincipalErrorStatus(error: unknown) {
  if (!(error instanceof PublicAudiencePrincipalError)) return null;
  if (error.code === "AUTHENTICATED_PRINCIPAL_INVALID") return 401;
  if (error.code === "WALLET_IDENTITY_CONFLICT") return 409;
  return 400;
}

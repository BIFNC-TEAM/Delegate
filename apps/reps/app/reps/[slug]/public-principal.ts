import type { NextResponse } from "next/server";

import {
  DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
  DELEGATE_REPRESENTATIVES_APP_SESSION_COOKIE,
  LEGACY_DELEGATE_AUTH_SESSION_COOKIE,
  PublicAudiencePrincipalError,
  readAccountSessionMode,
  readDelegateAuthSessionSecret,
  observeAccountSessionParity,
  resolveAccountSessionAuthority,
  resolvePublicAudiencePrincipal,
  verifyDelegateAuthSession,
  usesLegacyAccountSessionAuthority,
  type PublicAudiencePrincipal,
  type PublicAudienceAccountSessionPrincipal,
  type DelegateAuthSession,
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

export type PublicAudienceVerifiedAuthContext = {
  session: DelegateAuthSession | null;
  accountSessionToken: string | null;
};

export async function resolvePublicAudienceVerifiedAuthContext(input: {
  cookieStore: PublicAudienceCookieReader;
}): Promise<PublicAudienceVerifiedAuthContext> {
  const accountSessionMode = readAccountSessionMode();
  const audienceCookieValue = input.cookieStore.get(
    DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE,
  )?.value;
  const legacyCookieValue =
    audienceCookieValue
    ?? input.cookieStore.get(LEGACY_DELEGATE_AUTH_SESSION_COOKIE)?.value;

  if (usesLegacyAccountSessionAuthority(accountSessionMode)) {
    const session = verifyDelegateAuthSession(
      legacyCookieValue,
      readDelegateAuthSessionSecret(),
    );
    if (
      legacyCookieValue
      && (!session || (audienceCookieValue && session.actor !== "audience"))
    ) {
      throw invalidPublicAudienceSession();
    }
    const audienceSession = session?.actor === "audience" ? session : null;
    if (
      accountSessionMode === "shadow"
      && audienceSession?.audienceIdentityId
      && audienceSession.audienceId
    ) {
      const v2Token = input.cookieStore.get(
        DELEGATE_REPRESENTATIVES_APP_SESSION_COOKIE,
      )?.value ?? null;
      const v2Principal = v2Token
        ? await resolveAccountSessionAuthority({
            token: v2Token,
            application: "PUBLIC_REPRESENTATIVES",
          }).catch(() => null)
        : null;
      observeAccountSessionParity({
        application: "PUBLIC_REPRESENTATIVES",
        legacy: {
          actor: "audience",
          issuer: audienceSession.issuer,
          subject: audienceSession.subject,
          personaId: audienceSession.audienceIdentityId,
          audienceId: audienceSession.audienceId,
        },
        v2:
          v2Principal?.actor === "audience"
            ? {
                actor: "audience",
                issuer: v2Principal.issuer,
                subject: v2Principal.subject,
                personaId: v2Principal.audienceIdentityId,
                audienceId: v2Principal.audienceId,
              }
            : null,
        v2Token,
      });
    }
    return {
      session: audienceSession,
      accountSessionToken: null,
    };
  }

  const accountSessionToken = input.cookieStore.get(
    DELEGATE_REPRESENTATIVES_APP_SESSION_COOKIE,
  )?.value;
  if (!accountSessionToken) {
    if (legacyCookieValue) {
      throw new PublicAudiencePrincipalError(
        "AUTHENTICATED_PRINCIPAL_INVALID",
        "Legacy audience sessions are disabled in the current account-session mode.",
      );
    }
    return { session: null, accountSessionToken: null };
  }
  const principal = await resolveAccountSessionAuthority({
    token: accountSessionToken,
    application: "PUBLIC_REPRESENTATIVES",
  });
  if (principal?.actor !== "audience") {
    throw invalidPublicAudienceSession();
  }
  return {
    session: accountPrincipalToVerifiedAudienceSession(principal),
    accountSessionToken,
  };
}

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
  const verifiedAuth = await resolvePublicAudienceVerifiedAuthContext({
    cookieStore: input.cookieStore,
  });
  const audienceAuthSession = verifiedAuth.session;

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
      accountSessionToken: verifiedAuth.accountSessionToken,
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
      accountSessionToken: null,
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
      accountSessionToken: null,
    });
  }
}

function createRequestPrincipal(input: {
  principal: PublicAudiencePrincipal;
  sessionState: PublicChatSessionState;
  verifiedAuthSession: ReturnType<typeof verifyDelegateAuthSession>;
  accountSessionToken: string | null;
}): PublicAudienceRequestPrincipal {
  const expectedPrincipal = input.principal;
  const audienceId = input.sessionState.audienceId;
  const verifiedAuthSession = input.verifiedAuthSession;
  const accountSessionToken = input.accountSessionToken;

  return {
    principal: expectedPrincipal,
    sessionState: input.sessionState,
    async revalidate() {
      let currentAuthSession = verifiedAuthSession;
      if (accountSessionToken) {
        const accountPrincipal = await resolveAccountSessionAuthority({
          token: accountSessionToken,
          application: "PUBLIC_REPRESENTATIVES",
        });
        if (accountPrincipal?.actor !== "audience") {
          throw invalidPublicAudienceSession();
        }
        currentAuthSession =
          accountPrincipalToVerifiedAudienceSession(accountPrincipal);
      }
      if (
        currentAuthSession
        && !accountSessionToken
        && !usesLegacyAccountSessionAuthority(readAccountSessionMode())
      ) {
        throw new PublicAudiencePrincipalError(
          "AUTHENTICATED_PRINCIPAL_INVALID",
          "Legacy audience sessions are disabled in the current account-session mode.",
        );
      }
      if (
        currentAuthSession
        && currentAuthSession.expiresAt <= Math.floor(Date.now() / 1_000)
      ) {
        throw new PublicAudiencePrincipalError(
          "AUTHENTICATED_PRINCIPAL_INVALID",
          "The authenticated audience session is no longer valid.",
        );
      }

      const currentPrincipal = await resolvePublicAudiencePrincipal({
        audienceId,
        ...(currentAuthSession
          ? { verifiedAuthSession: currentAuthSession }
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

function accountPrincipalToVerifiedAudienceSession(
  principal: PublicAudienceAccountSessionPrincipal,
): DelegateAuthSession {
  return {
    version: 1,
    actor: "audience",
    provider: "logto",
    issuer: principal.issuer,
    subject: principal.subject,
    audienceIdentityId: principal.audienceIdentityId,
    audienceId: principal.audienceId,
    email: principal.email,
    issuedAt: principal.issuedAt,
    expiresAt: principal.expiresAt,
  };
}

function invalidPublicAudienceSession() {
  return new PublicAudiencePrincipalError(
    "AUTHENTICATED_PRINCIPAL_INVALID",
    "The authenticated audience session is no longer valid.",
  );
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

export function assertAuthenticatedPublicAudiencePrincipal(
  principal: PublicAudiencePrincipal,
): asserts principal is PublicAudiencePrincipal & { mode: "authenticated" } {
  if (principal.mode !== "authenticated") {
    throw new PublicAudiencePrincipalError(
      "AUTHENTICATED_PRINCIPAL_INVALID",
      "Sign in before using account-bound commerce.",
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

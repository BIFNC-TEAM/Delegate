import type { BrowserTransportKind } from "@delegate/compute-protocol";

import { prisma } from "./prisma";
import { mapBrowserTransportKindToDb } from "./serializers";

type BrowserSessionRecordLike = {
  currentUrl: string | null;
  currentTitle: string | null;
  failureReason: string | null;
  status: "ACTIVE" | "FAILED" | "CLOSED";
};

type BrowserNavigationPersistenceInput = {
  requestedUrl: string;
  finalUrl?: string | null | undefined;
  pageTitle?: string | null | undefined;
  errorMessage?: string | null | undefined;
  status: "succeeded" | "failed";
};

export async function recordBrowserNavigation(params: {
  representativeId: string;
  representativeSlug: string;
  contactId?: string | null | undefined;
  conversationId?: string | null | undefined;
  computeSessionId: string;
  sandboxIdentityId?: string | null | undefined;
  sandboxLeaseId?: string | null | undefined;
  toolExecutionId: string;
  transportKind: BrowserTransportKind;
  requestedUrl: string;
  finalUrl?: string | null | undefined;
  pageTitle?: string | null | undefined;
  textSnippet?: string | null | undefined;
  screenshotArtifactId?: string | null | undefined;
  jsonArtifactId?: string | null | undefined;
  errorMessage?: string | null | undefined;
  profilePath?: string | null | undefined;
  status: "succeeded" | "failed";
}) {
  const existingBrowserSession = params.sandboxIdentityId
    ? await prisma.browserSession.findFirst({
        where: {
          sandboxIdentityId: params.sandboxIdentityId,
        },
        orderBy: [{ updatedAt: "desc" }],
        select: {
          currentUrl: true,
          currentTitle: true,
          failureReason: true,
          status: true,
        },
      })
    : await prisma.browserSession.findUnique({
        where: {
          computeSessionId: params.computeSessionId,
        },
        select: {
          currentUrl: true,
          currentTitle: true,
          failureReason: true,
          status: true,
        },
      });
  const nextBrowserSessionState = deriveBrowserSessionPersistence({
    existing: existingBrowserSession,
    navigation: {
      requestedUrl: params.requestedUrl,
      finalUrl: params.finalUrl,
      pageTitle: params.pageTitle,
      errorMessage: params.errorMessage,
      status: params.status,
    },
  });
  const browserSession = await prisma.browserSession.upsert({
    where: {
      computeSessionId: params.computeSessionId,
    },
    create: {
      representativeId: params.representativeId,
      contactId: params.contactId ?? null,
      conversationId: params.conversationId ?? null,
      computeSessionId: params.computeSessionId,
      sandboxIdentityId: params.sandboxIdentityId ?? null,
      sandboxLeaseId: params.sandboxLeaseId ?? null,
      status: nextBrowserSessionState.status,
      transportKind: mapBrowserTransportKindToDb(params.transportKind),
      profilePath: params.profilePath ?? null,
      currentUrl: nextBrowserSessionState.currentUrl,
      currentTitle: nextBrowserSessionState.currentTitle,
      lastToolExecutionId: params.toolExecutionId,
      lastNavigationAt: new Date(),
      failureReason: nextBrowserSessionState.failureReason,
    },
    update: {
      status: nextBrowserSessionState.status,
      transportKind: mapBrowserTransportKindToDb(params.transportKind),
      sandboxIdentityId: params.sandboxIdentityId ?? null,
      sandboxLeaseId: params.sandboxLeaseId ?? null,
      ...(params.profilePath ? { profilePath: params.profilePath } : {}),
      currentUrl: nextBrowserSessionState.currentUrl,
      currentTitle: nextBrowserSessionState.currentTitle,
      lastToolExecutionId: params.toolExecutionId,
      lastNavigationAt: new Date(),
      closedAt: null,
      failureReason: nextBrowserSessionState.failureReason,
    },
  });

  const navigation = await prisma.browserNavigation.upsert({
    where: {
      toolExecutionId: params.toolExecutionId,
    },
    create: {
      browserSessionId: browserSession.id,
      representativeId: params.representativeId,
      contactId: params.contactId ?? null,
      conversationId: params.conversationId ?? null,
      toolExecutionId: params.toolExecutionId,
      status: params.status.toUpperCase() as "SUCCEEDED" | "FAILED",
      transportKind: mapBrowserTransportKindToDb(params.transportKind),
      requestedUrl: params.requestedUrl,
      finalUrl: params.finalUrl ?? null,
      pageTitle: params.pageTitle ?? null,
      textSnippet: params.textSnippet ?? null,
      screenshotArtifactId: params.screenshotArtifactId ?? null,
      jsonArtifactId: params.jsonArtifactId ?? null,
      errorMessage: truncateBrowserError(params.errorMessage),
    },
    update: {
      status: params.status.toUpperCase() as "SUCCEEDED" | "FAILED",
      transportKind: mapBrowserTransportKindToDb(params.transportKind),
      requestedUrl: params.requestedUrl,
      finalUrl: params.finalUrl ?? null,
      pageTitle: params.pageTitle ?? null,
      textSnippet: params.textSnippet ?? null,
      screenshotArtifactId: params.screenshotArtifactId ?? null,
      jsonArtifactId: params.jsonArtifactId ?? null,
      errorMessage: truncateBrowserError(params.errorMessage),
    },
  });

  await prisma.eventAudit.create({
    data: {
      representativeId: params.representativeId,
      contactId: params.contactId ?? null,
      conversationId: params.conversationId ?? null,
      type: "BROWSER_NAVIGATION_RECORDED",
      payload: {
        computeSessionId: params.computeSessionId,
        sandboxIdentityId: params.sandboxIdentityId ?? null,
        sandboxLeaseId: params.sandboxLeaseId ?? null,
        browserSessionId: browserSession.id,
        navigationId: navigation.id,
        toolExecutionId: params.toolExecutionId,
        status: params.status,
        transportKind: params.transportKind,
        requestedUrl: params.requestedUrl,
        finalUrl: params.finalUrl ?? null,
        screenshotArtifactId: params.screenshotArtifactId ?? null,
      },
    },
  });

  return {
    browserSession,
    navigation,
  };
}

export async function closeBrowserSessionForComputeSession(params: {
  computeSessionId: string;
  reason?: string | null | undefined;
}) {
  const browserSession = await prisma.browserSession.findUnique({
    where: {
      computeSessionId: params.computeSessionId,
    },
  });

  if (!browserSession) {
    return null;
  }

  const closedAt = new Date();
  const nextClosedState = deriveBrowserSessionCloseState({
    existing: browserSession,
  });
  const updated = await prisma.browserSession.update({
    where: {
      id: browserSession.id,
    },
    data: {
      status: nextClosedState.status,
      closedAt,
      failureReason: nextClosedState.failureReason,
    },
  });

  await prisma.eventAudit.create({
    data: {
      representativeId: updated.representativeId,
      contactId: updated.contactId ?? null,
      conversationId: updated.conversationId ?? null,
      type: "BROWSER_SESSION_CLOSED",
      payload: {
        computeSessionId: updated.computeSessionId,
        browserSessionId: updated.id,
        reason: params.reason ?? "compute_session_terminated",
      },
    },
  });

  return updated;
}

function truncateBrowserError(value?: string | null | undefined) {
  if (!value) {
    return null;
  }

  return value.slice(0, 240);
}

export function deriveBrowserSessionPersistence(params: {
  existing?: BrowserSessionRecordLike | null | undefined;
  navigation: BrowserNavigationPersistenceInput;
}) {
  const existing = params.existing ?? null;
  const navigation = params.navigation;

  if (navigation.status === "succeeded") {
    return {
      status: "ACTIVE" as const,
      currentUrl: navigation.finalUrl ?? navigation.requestedUrl,
      currentTitle: navigation.pageTitle ?? null,
      failureReason: null,
    };
  }

  if (navigation.finalUrl) {
    return {
      status: "FAILED" as const,
      currentUrl: navigation.finalUrl,
      currentTitle: navigation.pageTitle ?? existing?.currentTitle ?? null,
      failureReason: truncateBrowserError(navigation.errorMessage),
    };
  }

  return {
    status: "FAILED" as const,
    currentUrl: existing?.currentUrl ?? null,
    currentTitle: existing?.currentTitle ?? null,
    failureReason: truncateBrowserError(navigation.errorMessage),
  };
}

export function deriveBrowserSessionCloseState(params: {
  existing: Pick<BrowserSessionRecordLike, "status" | "failureReason">;
}) {
  if (params.existing.status === "FAILED") {
    return {
      status: "FAILED" as const,
      failureReason: params.existing.failureReason ?? null,
    };
  }

  return {
    status: "CLOSED" as const,
    failureReason: null,
  };
}

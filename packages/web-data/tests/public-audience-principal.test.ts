import {
  IdentityAssuranceLevel,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import type { DelegateAuthSession } from "../src/auth-session";
import {
  resolvePublicAudiencePrincipal,
  resolvePublicAudienceWalletExternalUserId,
  type PublicAudiencePrincipalClient,
  type PublicAudienceWalletClient,
} from "../src/public-audience-principal";

const LOGTO_ISSUER = "https://auth.example.com/oidc";

describe("public audience principal", () => {
  it("revalidates the Logto link while preserving the signed device Web thread", async () => {
    const client = new FakePublicAudiencePrincipalClient({
      identities: [
        {
          id: "identity-device",
          audienceKey: "web:device-session",
          status: "MERGED",
          mergedIntoId: "identity-account",
        },
        {
          id: "identity-account",
          audienceKey: "web:account-stable",
          status: "REGISTERED",
          mergedIntoId: null,
        },
      ],
      link: {
        issuer: LOGTO_ISSUER,
        providerSubject: "logto-user-1",
        audienceIdentityId: "identity-account",
        verifiedAt: new Date("2026-07-24T00:00:00.000Z"),
        assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
        revokedAt: null,
      },
    });

    await expect(
      resolvePublicAudiencePrincipal(
        {
          audienceId: "device-session",
          verifiedAuthSession: audienceSession({
            audienceId: "device-session",
            audienceIdentityId: "identity-account",
          }),
        },
        client,
      ),
    ).resolves.toEqual({
      mode: "authenticated",
      audienceId: "device-session",
      audienceIdentityId: "identity-account",
      businessKey: "audience:identity-account",
      sourceIdentityLinkId: "identity-link-test",
      sourceIdentityEvidence: {
        providerSubject: "logto-user-1",
        issuer: LOGTO_ISSUER,
        connectionId: "logto-identity-link:identity-link-test",
      },
    });
  });

  it.each([
    {
      label: "revoked link",
      link: {
        issuer: LOGTO_ISSUER,
        providerSubject: "logto-user-1",
        audienceIdentityId: "identity-account",
        verifiedAt: new Date("2026-07-24T00:00:00.000Z"),
        assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
        revokedAt: new Date("2026-07-24T01:00:00.000Z"),
      },
      sessionIdentityId: "identity-account",
    },
    {
      label: "link target mismatch",
      link: {
        issuer: LOGTO_ISSUER,
        providerSubject: "logto-user-1",
        audienceIdentityId: "identity-other",
        verifiedAt: new Date("2026-07-24T00:00:00.000Z"),
        assuranceLevel: IdentityAssuranceLevel.STEP_UP_VERIFIED,
        revokedAt: null,
      },
      sessionIdentityId: "identity-account",
    },
  ])("fails closed for an authenticated session with $label", async ({
    link,
    sessionIdentityId,
  }) => {
    const client = new FakePublicAudiencePrincipalClient({
      identities: [
        {
          id: "identity-device",
          audienceKey: "web:device-session",
          status: "MERGED",
          mergedIntoId: "identity-account",
        },
        {
          id: "identity-account",
          audienceKey: "web:account-stable",
          status: "REGISTERED",
          mergedIntoId: null,
        },
        {
          id: "identity-other",
          audienceKey: "web:other-stable",
          status: "REGISTERED",
          mergedIntoId: null,
        },
      ],
      link,
    });

    await expect(
      resolvePublicAudiencePrincipal(
        {
          audienceId: "device-session",
          verifiedAuthSession: audienceSession({
            audienceId: "device-session",
            audienceIdentityId: sessionIdentityId,
          }),
        },
        client,
      ),
    ).rejects.toMatchObject({
      code: "AUTHENTICATED_PRINCIPAL_INVALID",
    });
  });

  it("requires anonymous cookie rotation after its identity has been merged", async () => {
    const client = new FakePublicAudiencePrincipalClient({
      identities: [
        {
          id: "identity-device",
          audienceKey: "web:device-session",
          status: "MERGED",
          mergedIntoId: "identity-account",
        },
        {
          id: "identity-account",
          audienceKey: "web:account-stable",
          status: "REGISTERED",
          mergedIntoId: null,
        },
      ],
      link: null,
    });

    await expect(
      resolvePublicAudiencePrincipal(
        { audienceId: "device-session" },
        client,
      ),
    ).rejects.toMatchObject({
      code: "ANONYMOUS_SESSION_ROTATION_REQUIRED",
    });
  });

  it("rejects the same subject from a different issuer", async () => {
    const client = authenticatedPrincipalClient();

    await expect(
      resolvePublicAudiencePrincipal(
        {
          audienceId: "device-session",
          verifiedAuthSession: audienceSession({
            audienceId: "device-session",
            audienceIdentityId: "identity-account",
            issuer: "https://other-auth.example.com/oidc",
          }),
        },
        client,
      ),
    ).rejects.toMatchObject({
      code: "AUTHENTICATED_PRINCIPAL_INVALID",
    });
  });

  it("keeps issuer-less legacy sessions only in the finite shadow window", async () => {
    const client = authenticatedPrincipalClient();
    const legacySession = audienceSession({
      audienceId: "device-session",
      audienceIdentityId: "identity-account",
      issuer: null,
    });

    await expect(
      resolvePublicAudiencePrincipal(
        {
          audienceId: "device-session",
          verifiedAuthSession: legacySession,
          identityIssuerMode: "shadow",
        },
        client,
      ),
    ).resolves.toMatchObject({
      mode: "authenticated",
      audienceIdentityId: "identity-account",
    });
    await expect(
      resolvePublicAudiencePrincipal(
        {
          audienceId: "device-session",
          verifiedAuthSession: legacySession,
          identityIssuerMode: "enforce",
        },
        client,
      ),
    ).rejects.toMatchObject({
      code: "AUTHENTICATED_PRINCIPAL_INVALID",
    });
  });

  it("revalidates exact sessions against matching legacy issuer evidence only in shadow", async () => {
    const client = authenticatedPrincipalClient({
      issuer: "delegate",
      metadataIssuer: LOGTO_ISSUER,
    });
    const session = audienceSession({
      audienceId: "device-session",
      audienceIdentityId: "identity-account",
    });

    await expect(
      resolvePublicAudiencePrincipal(
        {
          audienceId: "device-session",
          verifiedAuthSession: session,
          identityIssuerMode: "shadow",
        },
        client,
      ),
    ).resolves.toMatchObject({
      mode: "authenticated",
      audienceIdentityId: "identity-account",
    });
    await expect(
      resolvePublicAudiencePrincipal(
        {
          audienceId: "device-session",
          verifiedAuthSession: session,
          identityIssuerMode: "enforce",
        },
        client,
      ),
    ).rejects.toMatchObject({
      code: "AUTHENTICATED_PRINCIPAL_INVALID",
    });
  });
});

describe("public audience wallet selector", () => {
  it("uses the persisted external id for the one canonical wallet", async () => {
    const client: PublicAudienceWalletClient = {
      userWallet: {
        findMany: async () => [{ externalUserId: "wallet-existing" }],
      },
    };

    await expect(
      resolvePublicAudienceWalletExternalUserId(
        {
          audienceIdentityId: "identity-account",
          representativeSlug: "ada",
          audienceId: "account-stable",
          currency: "cny",
        },
        client,
      ),
    ).resolves.toBe("wallet-existing");
  });

  it("falls back to the current server-derived Web external id when no wallet exists", async () => {
    const client: PublicAudienceWalletClient = {
      userWallet: {
        findMany: async () => [],
      },
    };

    await expect(
      resolvePublicAudienceWalletExternalUserId(
        {
          audienceIdentityId: "identity-account",
          representativeSlug: "ada",
          audienceId: "account-stable",
        },
        client,
      ),
    ).resolves.toBe("web:ada:account-stable");
  });

  it("fails closed when one canonical identity has multiple wallets in a currency", async () => {
    const client: PublicAudienceWalletClient = {
      userWallet: {
        findMany: async () => [
          { externalUserId: "wallet-1" },
          { externalUserId: "wallet-2" },
        ],
      },
    };

    await expect(
      resolvePublicAudienceWalletExternalUserId(
        {
          audienceIdentityId: "identity-account",
          representativeSlug: "ada",
          audienceId: "account-stable",
        },
        client,
      ),
    ).rejects.toMatchObject({
      code: "WALLET_IDENTITY_CONFLICT",
    });
  });
});

type IdentityRow = {
  id: string;
  audienceKey: string;
  status: "ANONYMOUS" | "REGISTERED" | "MERGED" | "DISABLED";
  mergedIntoId: string | null;
};

type LinkRow = {
  id: string;
  issuer: string;
  metadataIssuer?: string;
  providerSubject: string;
  audienceIdentityId: string;
  connectionId: string | null;
  verifiedAt: Date | null;
  assuranceLevel: IdentityAssuranceLevel;
  revokedAt: Date | null;
};

class FakePublicAudiencePrincipalClient
implements PublicAudiencePrincipalClient {
  private readonly identitiesById: Map<string, IdentityRow>;
  private nextIdentity = 1;
  private readonly link: LinkRow | null;

  constructor(input: {
    identities: IdentityRow[];
    link: (
      Omit<LinkRow, "id" | "connectionId">
      & Partial<Pick<LinkRow, "id" | "connectionId">>
    ) | null;
  }) {
    this.identitiesById = new Map(
      input.identities.map((identity) => [identity.id, identity]),
    );
    this.link = input.link
      ? {
          id: input.link.id ?? "identity-link-test",
          connectionId: input.link.connectionId ?? null,
          ...input.link,
        }
      : null;
  }

  audienceIdentity = {
    upsert: async (args: unknown) => {
      const input = args as {
        where: { audienceKey: string };
        create: { audienceKey: string };
      };
      const existing = [...this.identitiesById.values()].find(
        (identity) => identity.audienceKey === input.where.audienceKey,
      );
      if (existing) return existing;
      const identity: IdentityRow = {
        id: `identity-anonymous-${this.nextIdentity++}`,
        audienceKey: input.create.audienceKey,
        status: "ANONYMOUS",
        mergedIntoId: null,
      };
      this.identitiesById.set(identity.id, identity);
      return identity;
    },
    findUnique: async (args: unknown) => {
      const input = args as { where: { id: string } };
      return this.identitiesById.get(input.where.id) ?? null;
    },
  };

  identityLink = {
    findUnique: async (args: unknown) => {
      if (!this.link) return null;
      const input = args as {
        where:
          | {
              provider_issuer_providerSubject: {
                issuer: string;
                providerSubject: string;
              };
            }
          | {
              provider_providerSubject: {
                providerSubject: string;
              };
            };
      };
      if ("provider_issuer_providerSubject" in input.where) {
        const key = input.where.provider_issuer_providerSubject;
        return key.issuer === this.link.issuer
          && key.providerSubject === this.link.providerSubject
          ? this.link
          : null;
      }
      return input.where.provider_providerSubject.providerSubject
        === this.link.providerSubject
        ? this.link
        : null;
    },
    findFirst: async (args: unknown) => {
      if (!this.link) return null;
      const input = args as {
        where: {
          issuer: string;
          providerSubject: string;
          metadata: { equals: string };
        };
      };
      return input.where.issuer === this.link.issuer
        && input.where.providerSubject === this.link.providerSubject
        && input.where.metadata.equals === this.link.metadataIssuer
        ? this.link
        : null;
    },
  };
}

function audienceSession(
  input: {
    audienceId: string;
    audienceIdentityId: string;
    issuer?: string | null;
  },
): DelegateAuthSession {
  return {
    version: 1,
    actor: "audience",
    provider: "logto",
    ...(input.issuer === null
      ? {}
      : { issuer: input.issuer ?? LOGTO_ISSUER }),
    subject: "logto-user-1",
    audienceId: input.audienceId,
    audienceIdentityId: input.audienceIdentityId,
    issuedAt: 1,
    expiresAt: 4_102_444_800,
  };
}

function authenticatedPrincipalClient(
  linkOverrides: Partial<LinkRow> = {},
) {
  return new FakePublicAudiencePrincipalClient({
    identities: [
      {
        id: "identity-device",
        audienceKey: "web:device-session",
        status: "MERGED",
        mergedIntoId: "identity-account",
      },
      {
        id: "identity-account",
        audienceKey: "web:account-stable",
        status: "REGISTERED",
        mergedIntoId: null,
      },
    ],
    link: {
      issuer: LOGTO_ISSUER,
      providerSubject: "logto-user-1",
      audienceIdentityId: "identity-account",
      verifiedAt: new Date("2026-07-24T00:00:00.000Z"),
      assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
      revokedAt: null,
      ...linkOverrides,
    },
  });
}

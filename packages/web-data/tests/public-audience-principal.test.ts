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
    });
  });

  it.each([
    {
      label: "revoked link",
      link: {
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
  audienceIdentityId: string;
  verifiedAt: Date | null;
  assuranceLevel: IdentityAssuranceLevel;
  revokedAt: Date | null;
};

class FakePublicAudiencePrincipalClient
implements PublicAudiencePrincipalClient {
  private readonly identitiesById: Map<string, IdentityRow>;
  private nextIdentity = 1;
  private readonly link: LinkRow | null;

  constructor(input: { identities: IdentityRow[]; link: LinkRow | null }) {
    this.identitiesById = new Map(
      input.identities.map((identity) => [identity.id, identity]),
    );
    this.link = input.link;
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
    findUnique: async () => this.link,
  };
}

function audienceSession(
  input: { audienceId: string; audienceIdentityId: string },
): DelegateAuthSession {
  return {
    version: 1,
    actor: "audience",
    provider: "logto",
    subject: "logto-user-1",
    audienceId: input.audienceId,
    audienceIdentityId: input.audienceIdentityId,
    issuedAt: 1,
    expiresAt: 4_102_444_800,
  };
}

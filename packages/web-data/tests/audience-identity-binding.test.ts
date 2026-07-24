import {
  IdentityAssuranceLevel,
  IdentityLinkProvider,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  consumeIdentityBindingChallenge,
  createIdentityBindingChallenge,
  hashBindingToken,
} from "../src/audience-identity-binding";

type FakeIdentity = {
  id: string;
  status: "ANONYMOUS" | "REGISTERED" | "MERGED" | "DISABLED";
  mergedIntoId: string | null;
  lastSeenAt: Date;
};

type FakeChallenge = {
  id: string;
  audienceIdentityId: string;
  provider: IdentityLinkProvider;
  issuer: string;
  connectionId: string;
  expectedProviderSubject: string | null;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
};

type FakeLink = {
  id: string;
  audienceIdentityId: string;
  provider: IdentityLinkProvider;
  providerSubject: string;
  issuer: string;
  connectionId: string | null;
  revokedAt: Date | null;
  verifiedAt: Date | null;
  assuranceLevel: IdentityAssuranceLevel;
  proofMetadata: unknown;
};

function createFakeBindingClient(
  identities: FakeIdentity[],
  seedLinks: FakeLink[] = [],
) {
  const identityMap = new Map(identities.map((identity) => [identity.id, identity]));
  const challenges = new Map<string, FakeChallenge>();
  const links = new Map(
    [
      ...identities
        .filter((identity) => identity.status === "REGISTERED")
        .map((identity): FakeLink => ({
          id: `web-link-${identity.id}`,
          audienceIdentityId: identity.id,
          provider: IdentityLinkProvider.LOGTO,
          providerSubject: `logto-${identity.id}`,
          issuer: "logto",
          connectionId: "delegate-web",
          revokedAt: null,
          verifiedAt: new Date(),
          assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
          proofMetadata: { method: "authenticated_web_session" },
        })),
      ...seedLinks,
    ].map((link) => [`${link.provider}:${link.providerSubject}`, link]),
  );
  let sequence = 0;

  const client: any = {
    $transaction: async <T>(fn: (tx: any) => Promise<T>) => fn(client),
    audienceIdentity: {
      findUnique: async (input: unknown) => {
        const args = input as { where: { id: string } };
        return identityMap.get(args.where.id) ?? null;
      },
      updateMany: async (input: unknown) => {
        const args = input as {
          where: {
            id: string;
            status?: FakeIdentity["status"];
            mergedIntoId?: null;
          };
          data: Partial<FakeIdentity>;
        };
        const identity = identityMap.get(args.where.id);
        if (
          !identity ||
          (args.where.status && identity.status !== args.where.status) ||
          (args.where.mergedIntoId === null && identity.mergedIntoId !== null)
        ) {
          return { count: 0 };
        }
        Object.assign(identity, args.data);
        return { count: 1 };
      },
    },
    identityBindingChallenge: {
      create: async (input: unknown) => {
        const args = input as { data: Omit<FakeChallenge, "id" | "consumedAt" | "revokedAt"> };
        const challenge: FakeChallenge = {
          id: `challenge-${++sequence}`,
          consumedAt: null,
          revokedAt: null,
          ...args.data,
          expectedProviderSubject: args.data.expectedProviderSubject ?? null,
        };
        challenges.set(challenge.tokenHash, challenge);
        return challenge;
      },
      findUnique: async (input: unknown) => {
        const args = input as { where: { tokenHash: string } };
        return challenges.get(args.where.tokenHash) ?? null;
      },
      updateMany: async (input: unknown) => {
        const args = input as {
          where: {
            id: string;
            consumedAt: null;
            revokedAt: null;
            expiresAt: { gt: Date };
          };
          data: { consumedAt: Date };
        };
        const challenge = [...challenges.values()].find(
          (candidate) => candidate.id === args.where.id,
        );
        if (
          !challenge ||
          challenge.consumedAt ||
          challenge.revokedAt ||
          challenge.expiresAt <= args.where.expiresAt.gt
        ) {
          return { count: 0 };
        }
        challenge.consumedAt = args.data.consumedAt;
        return { count: 1 };
      },
    },
    identityLink: {
      findFirst: async (input: unknown) => {
        const args = input as {
          where: {
            audienceIdentityId: string;
            provider: IdentityLinkProvider;
            revokedAt: null;
          };
        };
        return (
          [...links.values()].find(
            (link) =>
              link.audienceIdentityId === args.where.audienceIdentityId &&
              link.provider === args.where.provider &&
              link.revokedAt === null &&
              link.verifiedAt !== null &&
              link.assuranceLevel !== IdentityAssuranceLevel.UNVERIFIED,
          ) ?? null
        );
      },
      findUnique: async (input: unknown) => {
        const args = input as {
          where: {
            provider_providerSubject: {
              provider: IdentityLinkProvider;
              providerSubject: string;
            };
          };
        };
        const key = args.where.provider_providerSubject;
        return links.get(`${key.provider}:${key.providerSubject}`) ?? null;
      },
      create: async (input: unknown) => {
        const args = input as {
          data: {
            audienceIdentityId: string;
            provider: IdentityLinkProvider;
            providerSubject: string;
            issuer: string;
            connectionId: string;
            verifiedAt: Date;
            assuranceLevel: IdentityAssuranceLevel;
            proofMetadata: unknown;
          };
        };
        const key = `${args.data.provider}:${args.data.providerSubject}`;
        if (links.has(key)) throw new Error("unique constraint");
        const link: FakeLink = {
          id: `link-${++sequence}`,
          audienceIdentityId: args.data.audienceIdentityId,
          provider: args.data.provider,
          providerSubject: args.data.providerSubject,
          issuer: args.data.issuer,
          connectionId: args.data.connectionId,
          revokedAt: null,
          verifiedAt: args.data.verifiedAt,
          assuranceLevel: args.data.assuranceLevel,
          proofMetadata: args.data.proofMetadata,
        };
        links.set(key, link);
        return link;
      },
      update: async (input: unknown) => {
        const args = input as {
          where: { id: string };
          data: Partial<FakeLink>;
        };
        const link = [...links.values()].find((candidate) => candidate.id === args.where.id);
        if (!link) throw new Error("link not found");
        Object.assign(link, args.data);
        return link;
      },
    },
  };

  return { client, identities: identityMap, challenges, links };
}

describe("audience identity private-channel binding", () => {
  it("stores only a token hash and binds a verified Telegram subject once", async () => {
    const fake = createFakeBindingClient([
      {
        id: "audience-1",
        status: "REGISTERED",
        mergedIntoId: null,
        lastSeenAt: new Date(0),
      },
    ]);
    const grant = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.TELEGRAM,
        connectionId: "bot-1",
        expectedProviderSubject: "123456",
      },
      fake.client as never,
    );

    expect(fake.challenges.has(hashBindingToken(grant.token))).toBe(true);
    expect([...fake.challenges.keys()]).not.toContain(grant.token);

    const result = await consumeIdentityBindingChallenge(
      {
        token: grant.token,
        provider: IdentityLinkProvider.TELEGRAM,
        providerSubject: "123456",
        connectionId: "bot-1",
        proofMetadata: {
          method: "attacker_override",
          challengeId: "attacker_override",
          issuer: "attacker_override",
          connectionId: "attacker_override",
        },
      },
      fake.client as never,
    );

    expect(result.audienceIdentityId).toBe("audience-1");
    expect(fake.identities.get("audience-1")?.status).toBe("REGISTERED");
    expect(fake.links.get("TELEGRAM:123456")?.audienceIdentityId).toBe("audience-1");
    expect(fake.links.get("TELEGRAM:123456")?.proofMetadata).toMatchObject({
      method: "private_channel_challenge",
      challengeId: [...fake.challenges.values()][0]?.id,
      issuer: "delegate",
      connectionId: "bot-1",
    });
    await expect(
      consumeIdentityBindingChallenge(
        {
          token: grant.token,
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123456",
          connectionId: "bot-1",
        },
        fake.client as never,
      ),
    ).rejects.toThrow("already been used");
  });

  it("does not move an existing provider link to another identity", async () => {
    const fake = createFakeBindingClient(
      [
        {
          id: "audience-1",
          status: "REGISTERED",
          mergedIntoId: null,
          lastSeenAt: new Date(),
        },
        {
          id: "audience-2",
          status: "REGISTERED",
          mergedIntoId: null,
          lastSeenAt: new Date(),
        },
      ],
      [
        {
          id: "link-existing",
          audienceIdentityId: "audience-2",
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "999",
          issuer: "delegate",
          connectionId: "bot-1",
          revokedAt: null,
          verifiedAt: new Date(),
          assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
          proofMetadata: {},
        },
      ],
    );
    const grant = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.TELEGRAM,
        connectionId: "bot-1",
      },
      fake.client as never,
    );

    await expect(
      consumeIdentityBindingChallenge(
        {
          token: grant.token,
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "999",
          connectionId: "bot-1",
        },
        fake.client as never,
      ),
    ).rejects.toThrow("already bound to another");
    expect(fake.links.get("TELEGRAM:999")?.audienceIdentityId).toBe("audience-2");
  });

  it("rejects a challenge used by the wrong private-channel account", async () => {
    const fake = createFakeBindingClient([
      {
        id: "audience-1",
        status: "REGISTERED",
        mergedIntoId: null,
        lastSeenAt: new Date(),
      },
    ]);
    const grant = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.TELEGRAM,
        connectionId: "bot-1",
        expectedProviderSubject: "123",
      },
      fake.client as never,
    );

    await expect(
      consumeIdentityBindingChallenge(
        {
          token: grant.token,
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "456",
          connectionId: "bot-1",
        },
        fake.client as never,
      ),
    ).rejects.toThrow("different provider account");
  });

  it("does not silently move an existing provider subject to another connection", async () => {
    const fake = createFakeBindingClient(
      [
        {
          id: "audience-1",
          status: "REGISTERED",
          mergedIntoId: null,
          lastSeenAt: new Date(),
        },
      ],
      [
        {
          id: "link-existing",
          audienceIdentityId: "audience-1",
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123",
          issuer: "delegate",
          connectionId: "bot-old",
          revokedAt: null,
          verifiedAt: new Date(),
          assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
          proofMetadata: {},
        },
      ],
    );
    const grant = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.TELEGRAM,
        connectionId: "bot-new",
      },
      fake.client as never,
    );

    await expect(
      consumeIdentityBindingChallenge(
        {
          token: grant.token,
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123",
          connectionId: "bot-new",
        },
        fake.client as never,
      ),
    ).rejects.toThrow("different provider connection");
    expect(fake.links.get("TELEGRAM:123")?.connectionId).toBe("bot-old");
  });

  it("requires a verified registered Web identity to mint a challenge", async () => {
    const anonymous = createFakeBindingClient([
      {
        id: "anonymous-1",
        status: "ANONYMOUS",
        mergedIntoId: null,
        lastSeenAt: new Date(),
      },
    ]);
    await expect(
      createIdentityBindingChallenge(
        {
          audienceIdentityId: "anonymous-1",
          provider: IdentityLinkProvider.TELEGRAM,
          connectionId: "bot-1",
        },
        anonymous.client as never,
      ),
    ).rejects.toThrow("registered Web identity");

    const unverified = createFakeBindingClient([
      {
        id: "registered-1",
        status: "REGISTERED",
        mergedIntoId: null,
        lastSeenAt: new Date(),
      },
    ]);
    unverified.links.delete("LOGTO:logto-registered-1");
    await expect(
      createIdentityBindingChallenge(
        {
          audienceIdentityId: "registered-1",
          provider: IdentityLinkProvider.TELEGRAM,
          connectionId: "bot-1",
        },
        unverified.client as never,
      ),
    ).rejects.toThrow("verified Web login");
  });

  it("cannot consume a challenge through a different adapter connection", async () => {
    const fake = createFakeBindingClient([
      {
        id: "audience-1",
        status: "REGISTERED",
        mergedIntoId: null,
        lastSeenAt: new Date(),
      },
    ]);
    const grant = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.TELEGRAM,
        connectionId: "bot-1",
      },
      fake.client as never,
    );

    await expect(
      consumeIdentityBindingChallenge(
        {
          token: grant.token,
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123",
          connectionId: "bot-2",
        },
        fake.client as never,
      ),
    ).rejects.toThrow("does not match this provider");
    await expect(
      consumeIdentityBindingChallenge(
        {
          token: grant.token,
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123",
          connectionId: "bot-1",
        },
        fake.client as never,
      ),
    ).resolves.toMatchObject({ audienceIdentityId: "audience-1" });
  });

  it("normalizes a Matrix MXID but rejects relay-style identities", async () => {
    const fake = createFakeBindingClient([
      {
        id: "audience-1",
        status: "REGISTERED",
        mergedIntoId: null,
        lastSeenAt: new Date(),
      },
    ]);
    const grant = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.MATRIX,
        connectionId: "matrix-as",
      },
      fake.client as never,
    );
    const result = await consumeIdentityBindingChallenge(
      {
        token: grant.token,
        provider: IdentityLinkProvider.MATRIX,
        providerSubject: "@Alice:Example.COM",
        connectionId: "matrix-as",
      },
      fake.client as never,
    );
    expect(result.providerSubject).toBe("@Alice:example.com");

    const next = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.MATRIX,
        connectionId: "matrix-as",
      },
      fake.client as never,
    );
    await expect(
      consumeIdentityBindingChallenge(
        {
          token: next.token,
          provider: IdentityLinkProvider.MATRIX,
          providerSubject: "Alice via relay",
          connectionId: "matrix-as",
        },
        fake.client as never,
      ),
    ).rejects.toThrow("full MXID");
  });
});

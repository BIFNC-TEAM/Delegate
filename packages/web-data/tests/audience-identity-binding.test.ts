import {
  IdentityAssuranceLevel,
  IdentityLinkProvider,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  consumeIdentityBindingChallenge,
  createIdentityBindingChallenge,
  getIdentityBindingChallengeStatus,
  hashBindingToken,
  isVerifiedPrivateChannelIdentityBinding,
  listActivePrivateChannelIdentityBindings,
  revokePrivateChannelIdentityBinding,
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
  metadata: unknown;
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

type FakeConnectionProof = {
  identityLinkId: string;
  issuer: string;
  connectionId: string;
  verifiedAt: Date;
  assuranceLevel: IdentityAssuranceLevel;
  revokedAt: Date | null;
  proofMetadata: unknown;
};

function createFakeBindingClient(
  identities: FakeIdentity[],
  seedLinks: FakeLink[] = [],
  options: { withConnectionProofs?: boolean } = {},
) {
  const identityMap = new Map(identities.map((identity) => [identity.id, identity]));
  const challenges = new Map<string, FakeChallenge>();
  const connectionProofs = new Map<string, FakeConnectionProof>();
  const advisoryLocks: string[] = [];
  const rowLocks: string[] = [];
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
    $executeRaw: async (...args: unknown[]) => {
      advisoryLocks.push(String(args[1] ?? ""));
      return 0;
    },
    $queryRaw: async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join(" ") ?? "";
      rowLocks.push(
        sql.includes('"IdentityLinkConnectionProof"') ? "proof" : "link",
      );
      return [{ id: "locked-row" }];
    },
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
        const args = input as {
          where: { id?: string; tokenHash?: string };
        };
        if (args.where.id) {
          return [...challenges.values()].find(
            (challenge) => challenge.id === args.where.id,
          ) ?? null;
        }
        return args.where.tokenHash
          ? challenges.get(args.where.tokenHash) ?? null
          : null;
      },
      updateMany: async (input: unknown) => {
        const args = input as {
          where: {
            id?: string;
            audienceIdentityId?: string;
            provider?: IdentityLinkProvider;
            issuer?: string;
            connectionId?: string;
            consumedAt?: null;
            revokedAt?: null;
            expiresAt?: { gt: Date };
          };
          data: {
            consumedAt?: Date;
            revokedAt?: Date;
            metadata?: unknown;
          };
        };
        let count = 0;
        for (const challenge of challenges.values()) {
          if (
            (args.where.id !== undefined && challenge.id !== args.where.id)
            || (
              args.where.audienceIdentityId !== undefined
              && challenge.audienceIdentityId !== args.where.audienceIdentityId
            )
            || (
              args.where.provider !== undefined
              && challenge.provider !== args.where.provider
            )
            || (
              args.where.issuer !== undefined
              && challenge.issuer !== args.where.issuer
            )
            || (
              args.where.connectionId !== undefined
              && challenge.connectionId !== args.where.connectionId
            )
            || (args.where.consumedAt === null && challenge.consumedAt !== null)
            || (args.where.revokedAt === null && challenge.revokedAt !== null)
            || (
              args.where.expiresAt !== undefined
              && challenge.expiresAt <= args.where.expiresAt.gt
            )
          ) {
            continue;
          }
          if (args.data.consumedAt) challenge.consumedAt = args.data.consumedAt;
          if (args.data.revokedAt) challenge.revokedAt = args.data.revokedAt;
          if (args.data.metadata !== undefined) {
            challenge.metadata = args.data.metadata;
          }
          count += 1;
        }
        return { count };
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
      findMany: async () =>
        [...links.values()]
          .filter(
            (link) =>
              link.revokedAt === null
              && link.verifiedAt !== null
              && link.assuranceLevel !== IdentityAssuranceLevel.UNVERIFIED
              && (
                link.provider === IdentityLinkProvider.TELEGRAM
                || link.provider === IdentityLinkProvider.MATRIX
              ),
          )
          .map((link) => ({
            ...link,
            connectionProofs: options.withConnectionProofs
              ? [...connectionProofs.values()].filter(
                  (proof) => proof.identityLinkId === link.id,
                )
              : undefined,
          })),
    },
    ...(options.withConnectionProofs
      ? {
          identityLinkConnectionProof: {
            findUnique: async (input: unknown) => {
              const args = input as {
                where: {
                  identityLinkId_issuer_connectionId: {
                    identityLinkId: string;
                    issuer: string;
                    connectionId: string;
                  };
                };
              };
              const compound = args.where.identityLinkId_issuer_connectionId;
              return connectionProofs.get(
                [
                  compound.identityLinkId,
                  compound.issuer,
                  compound.connectionId,
                ].join(":"),
              ) ?? null;
            },
            updateMany: async (input: unknown) => {
              const args = input as {
                where: {
                  identityLinkId: string;
                  issuer: string;
                  connectionId: string;
                  revokedAt: null;
                };
                data: { revokedAt: Date };
              };
              let count = 0;
              for (const proof of connectionProofs.values()) {
                if (
                  proof.identityLinkId === args.where.identityLinkId
                  && proof.issuer === args.where.issuer
                  && proof.connectionId === args.where.connectionId
                  && proof.revokedAt === null
                ) {
                  proof.revokedAt = args.data.revokedAt;
                  count += 1;
                }
              }
              return { count };
            },
            count: async (input: unknown) => {
              const args = input as {
                where: {
                  identityLinkId: string;
                  revokedAt: null;
                  verifiedAt?: { not: null };
                  assuranceLevel?: { in: IdentityAssuranceLevel[] };
                };
              };
              return [...connectionProofs.values()].filter(
                (proof) =>
                  proof.identityLinkId === args.where.identityLinkId
                  && proof.revokedAt === null
                  && (
                    args.where.verifiedAt === undefined
                    || proof.verifiedAt !== null
                  )
                  && (
                    args.where.assuranceLevel === undefined
                    || args.where.assuranceLevel.in.includes(proof.assuranceLevel)
                  ),
              ).length;
            },
            upsert: async (input: unknown) => {
              const args = input as {
                where: {
                  identityLinkId_issuer_connectionId: {
                    identityLinkId: string;
                    issuer: string;
                    connectionId: string;
                  };
                };
                create: FakeConnectionProof;
                update: Pick<
                  FakeConnectionProof,
                  "verifiedAt" | "assuranceLevel" | "revokedAt" | "proofMetadata"
                >;
              };
              const compound = args.where.identityLinkId_issuer_connectionId;
              const key = [
                compound.identityLinkId,
                compound.issuer,
                compound.connectionId,
              ].join(":");
              const existing = connectionProofs.get(key);
              if (existing) {
                Object.assign(existing, args.update);
                return existing;
              }
              const proof = { ...args.create };
              connectionProofs.set(key, proof);
              return proof;
            },
          },
        }
      : {}),
  };

  return {
    client,
    identities: identityMap,
    challenges,
    links,
    connectionProofs,
    advisoryLocks,
    rowLocks,
  };
}

describe("audience identity private-channel binding", () => {
  it("matches only a verified private-channel link for the exact Bot connection", () => {
    const binding = {
      provider: IdentityLinkProvider.TELEGRAM,
      providerSubject: "123456",
      issuer: "delegate-managed-bot",
      connectionId: "8718299151",
      verifiedAt: "2026-07-27T00:00:00.000Z",
      assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
    };
    const expected = {
      provider: IdentityLinkProvider.TELEGRAM,
      issuer: "delegate-managed-bot",
      connectionId: "8718299151",
    };

    expect(
      isVerifiedPrivateChannelIdentityBinding(binding, expected),
    ).toBe(true);
    expect(
      isVerifiedPrivateChannelIdentityBinding(
        {
          ...binding,
          assuranceLevel: IdentityAssuranceLevel.STEP_UP_VERIFIED,
        },
        expected,
      ),
    ).toBe(true);
    for (const candidate of [
      { ...binding, verifiedAt: null },
      {
        ...binding,
        assuranceLevel: IdentityAssuranceLevel.UNVERIFIED,
      },
      { ...binding, issuer: "other-bot" },
      { ...binding, connectionId: "999" },
      { ...binding, provider: IdentityLinkProvider.MATRIX },
    ]) {
      expect(
        isVerifiedPrivateChannelIdentityBinding(candidate, expected),
      ).toBe(false);
    }
  });

  it("idempotently replays a consumed Telegram challenge only for its verified subject and Bot", async () => {
    const fake = createFakeBindingClient(
      [
        {
          id: "audience-1",
          status: "REGISTERED",
          mergedIntoId: null,
          lastSeenAt: new Date(0),
        },
      ],
      [],
      { withConnectionProofs: true },
    );
    const grant = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.TELEGRAM,
        issuer: "delegate-managed-bot",
        connectionId: "bot-1",
        metadata: { representativeSlug: "sktone" },
      },
      fake.client as never,
    );

    expect(fake.challenges.has(hashBindingToken(grant.token))).toBe(true);
    expect([...fake.challenges.keys()]).not.toContain(grant.token);
    expect(grant.challengeId).toBe(
      fake.challenges.get(hashBindingToken(grant.token))?.id,
    );

    const result = await consumeIdentityBindingChallenge(
      {
        token: grant.token,
        provider: IdentityLinkProvider.TELEGRAM,
        providerSubject: "123456",
        issuer: "delegate-managed-bot",
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
      issuer: "delegate-managed-bot",
      connectionId: "bot-1",
    });
    await expect(
      getIdentityBindingChallengeStatus(
        {
          audienceIdentityId: "audience-1",
          challengeId: grant.challengeId,
        },
        fake.client as never,
      ),
    ).resolves.toMatchObject({
      status: "CONSUMED",
      providerSubject: "123456",
    });
    await expect(
      consumeIdentityBindingChallenge(
        {
          token: grant.token,
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123456",
          issuer: "delegate-managed-bot",
          connectionId: "bot-1",
        },
        fake.client as never,
      ),
    ).resolves.toMatchObject({
      audienceIdentityId: "audience-1",
      provider: IdentityLinkProvider.TELEGRAM,
      providerSubject: "123456",
      issuer: "delegate-managed-bot",
      metadata: { representativeSlug: "sktone" },
    });
    for (const replay of [
      {
        provider: IdentityLinkProvider.TELEGRAM,
        providerSubject: "999999",
        issuer: "delegate-managed-bot",
        connectionId: "bot-1",
      },
      {
        provider: IdentityLinkProvider.TELEGRAM,
        providerSubject: "123456",
        issuer: "other-issuer",
        connectionId: "bot-1",
      },
      {
        provider: IdentityLinkProvider.TELEGRAM,
        providerSubject: "123456",
        issuer: "delegate-managed-bot",
        connectionId: "other-bot",
      },
    ]) {
      await expect(
        consumeIdentityBindingChallenge(
          {
            token: grant.token,
            ...replay,
          },
          fake.client as never,
        ),
      ).rejects.toThrow();
    }

    await revokePrivateChannelIdentityBinding(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.TELEGRAM,
        providerSubject: "123456",
        issuer: "delegate-managed-bot",
        connectionId: "bot-1",
      },
      fake.client as never,
    );
    await expect(
      consumeIdentityBindingChallenge(
        {
          token: grant.token,
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123456",
          issuer: "delegate-managed-bot",
          connectionId: "bot-1",
        },
        fake.client as never,
      ),
    ).rejects.toThrow("already been used");
  });

  it("reports challenge state only to its owning audience identity", async () => {
    const fake = createFakeBindingClient([
      {
        id: "audience-1",
        status: "REGISTERED",
        mergedIntoId: null,
        lastSeenAt: new Date(0),
      },
      {
        id: "audience-2",
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
      },
      fake.client as never,
    );

    await expect(
      getIdentityBindingChallengeStatus(
        {
          audienceIdentityId: "audience-1",
          challengeId: grant.challengeId,
          now: new Date("2026-01-01T00:00:00.000Z"),
        },
        fake.client as never,
      ),
    ).resolves.toEqual({
      challengeId: grant.challengeId,
      status: "PENDING",
      expiresAt: grant.expiresAt,
    });
    await expect(
      getIdentityBindingChallengeStatus(
        {
          audienceIdentityId: "audience-2",
          challengeId: grant.challengeId,
        },
        fake.client as never,
      ),
    ).resolves.toBeNull();
    await expect(
      getIdentityBindingChallengeStatus(
        {
          audienceIdentityId: "audience-1",
          challengeId: "missing-challenge",
        },
        fake.client as never,
      ),
    ).resolves.toBeNull();

    const challenge = fake.challenges.get(hashBindingToken(grant.token))!;
    challenge.expiresAt = new Date("2025-12-31T23:59:59.000Z");
    await expect(
      getIdentityBindingChallengeStatus(
        {
          audienceIdentityId: "audience-1",
          challengeId: grant.challengeId,
          now: new Date("2026-01-01T00:00:00.000Z"),
        },
        fake.client as never,
      ),
    ).resolves.toMatchObject({ status: "EXPIRED" });

    challenge.revokedAt = new Date("2025-12-31T23:58:00.000Z");
    await expect(
      getIdentityBindingChallengeStatus(
        {
          audienceIdentityId: "audience-1",
          challengeId: grant.challengeId,
          now: new Date("2026-01-01T00:00:00.000Z"),
        },
        fake.client as never,
      ),
    ).resolves.toMatchObject({ status: "REVOKED" });

    challenge.consumedAt = new Date("2025-12-31T23:57:00.000Z");
    await expect(
      getIdentityBindingChallengeStatus(
        {
          audienceIdentityId: "audience-1",
          challengeId: grant.challengeId,
          now: new Date("2026-01-01T00:00:00.000Z"),
        },
        fake.client as never,
      ),
    ).resolves.toMatchObject({ status: "CONSUMED" });
  });

  it("consumes an internally persisted token hash without reconstructing the secret", async () => {
    const fake = createFakeBindingClient([
      {
        id: "audience-hash",
        status: "REGISTERED",
        mergedIntoId: null,
        lastSeenAt: new Date(0),
      },
    ]);
    const grant = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-hash",
        provider: IdentityLinkProvider.MATRIX,
        issuer: "example.org",
        connectionId: "delegate-matrix-as",
        expectedProviderSubject: "@alice:example.org",
      },
      fake.client as never,
    );

    await expect(
      consumeIdentityBindingChallenge(
        {
          tokenHash: hashBindingToken(grant.token),
          provider: IdentityLinkProvider.MATRIX,
          providerSubject: "@alice:example.org",
          issuer: "example.org",
          connectionId: "delegate-matrix-as",
        },
        fake.client as never,
      ),
    ).resolves.toMatchObject({
      audienceIdentityId: "audience-hash",
      provider: IdentityLinkProvider.MATRIX,
      providerSubject: "@alice:example.org",
    });
  });

  it("revokes an older live challenge when a newer command is minted for the same scope", async () => {
    const fake = createFakeBindingClient([
      {
        id: "audience-1",
        status: "REGISTERED",
        mergedIntoId: null,
        lastSeenAt: new Date(),
      },
    ]);
    const first = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.TELEGRAM,
        connectionId: "bot-1",
      },
      fake.client as never,
    );
    const second = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.TELEGRAM,
        connectionId: "bot-1",
      },
      fake.client as never,
    );

    expect(
      fake.challenges.get(hashBindingToken(first.token))?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(
      fake.challenges.get(hashBindingToken(second.token))?.revokedAt,
    ).toBeNull();
    await expect(
      consumeIdentityBindingChallenge(
        {
          token: first.token,
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123456",
          connectionId: "bot-1",
        },
        fake.client as never,
      ),
    ).rejects.toThrow("revoked");
    await expect(
      consumeIdentityBindingChallenge(
        {
          token: second.token,
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123456",
          connectionId: "bot-1",
        },
        fake.client as never,
      ),
    ).resolves.toMatchObject({ audienceIdentityId: "audience-1" });
  });

  it("replaces a pending Matrix command for the same connection across homeservers", async () => {
    const fake = createFakeBindingClient([
      {
        id: "audience-1",
        status: "REGISTERED",
        mergedIntoId: null,
        lastSeenAt: new Date(),
      },
    ]);
    const first = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.MATRIX,
        issuer: "old.example",
        connectionId: "matrix-as",
        expectedProviderSubject: "@alice:old.example",
      },
      fake.client as never,
    );
    const second = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.MATRIX,
        issuer: "new.example",
        connectionId: "matrix-as",
        expectedProviderSubject: "@alice:new.example",
      },
      fake.client as never,
    );

    expect(
      fake.challenges.get(hashBindingToken(first.token))?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(
      fake.challenges.get(hashBindingToken(second.token))?.revokedAt,
    ).toBeNull();
    await expect(
      consumeIdentityBindingChallenge(
        {
          token: first.token,
          provider: IdentityLinkProvider.MATRIX,
          issuer: "old.example",
          connectionId: "matrix-as",
          providerSubject: "@alice:old.example",
        },
        fake.client as never,
      ),
    ).rejects.toThrow("revoked");
    expect(fake.advisoryLocks).toEqual([
      "matrix-audience-connection:audience-1:matrix-as",
    ]);
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

  it("allows one Telegram subject on multiple Bots for the same Web identity and upserts proofs idempotently", async () => {
    const fake = createFakeBindingClient(
      [
        {
          id: "audience-1",
          status: "REGISTERED",
          mergedIntoId: null,
          lastSeenAt: new Date(),
        },
      ],
      [],
      { withConnectionProofs: true },
    );

    for (const connectionId of ["bot-a", "bot-b", "bot-b"]) {
      const grant = await createIdentityBindingChallenge(
        {
          audienceIdentityId: "audience-1",
          provider: IdentityLinkProvider.TELEGRAM,
          connectionId,
          expectedProviderSubject: "123456",
        },
        fake.client as never,
      );
      await expect(
        consumeIdentityBindingChallenge(
          {
            token: grant.token,
            provider: IdentityLinkProvider.TELEGRAM,
            providerSubject: "123456",
            connectionId,
          },
          fake.client as never,
        ),
      ).resolves.toMatchObject({
        audienceIdentityId: "audience-1",
        providerSubject: "123456",
      });
    }

    const identityLink = fake.links.get("TELEGRAM:123456");
    expect(identityLink).toMatchObject({
      audienceIdentityId: "audience-1",
      connectionId: "bot-a",
    });
    expect(
      [...fake.connectionProofs.values()].map((proof) => ({
        identityLinkId: proof.identityLinkId,
        issuer: proof.issuer,
        connectionId: proof.connectionId,
        assuranceLevel: proof.assuranceLevel,
        revokedAt: proof.revokedAt,
      })),
    ).toEqual([
      {
        identityLinkId: identityLink?.id,
        issuer: "delegate",
        connectionId: "bot-a",
        assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
        revokedAt: null,
      },
      {
        identityLinkId: identityLink?.id,
        issuer: "delegate",
        connectionId: "bot-b",
        assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
        revokedAt: null,
      },
    ]);
  });

  it("does not let a second Bot reassign a Telegram subject to another Web identity", async () => {
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
      [],
      { withConnectionProofs: true },
    );
    const firstGrant = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.TELEGRAM,
        connectionId: "bot-a",
      },
      fake.client as never,
    );
    await consumeIdentityBindingChallenge(
      {
        token: firstGrant.token,
        provider: IdentityLinkProvider.TELEGRAM,
        providerSubject: "123456",
        connectionId: "bot-a",
      },
      fake.client as never,
    );

    const takeoverGrant = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-2",
        provider: IdentityLinkProvider.TELEGRAM,
        connectionId: "bot-b",
      },
      fake.client as never,
    );
    await expect(
      consumeIdentityBindingChallenge(
        {
          token: takeoverGrant.token,
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123456",
          connectionId: "bot-b",
        },
        fake.client as never,
      ),
    ).rejects.toThrow("already bound to another");

    expect(fake.links.get("TELEGRAM:123456")?.audienceIdentityId).toBe(
      "audience-1",
    );
    expect(
      [...fake.connectionProofs.values()].map((proof) => proof.connectionId),
    ).toEqual(["bot-a"]);
  });

  it("revokes only one Bot proof, invalidates every pending retry, and permits explicit rebind", async () => {
    const fake = createFakeBindingClient(
      [
        {
          id: "audience-1",
          status: "REGISTERED",
          mergedIntoId: null,
          lastSeenAt: new Date(),
        },
      ],
      [],
      { withConnectionProofs: true },
    );

    for (const connectionId of ["bot-a", "bot-b"]) {
      const grant = await createIdentityBindingChallenge(
        {
          audienceIdentityId: "audience-1",
          provider: IdentityLinkProvider.TELEGRAM,
          connectionId,
          expectedProviderSubject: "123456",
        },
        fake.client as never,
      );
      await consumeIdentityBindingChallenge(
        {
          token: grant.token,
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123456",
          connectionId,
        },
        fake.client as never,
      );
    }

    const staleGrant = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.TELEGRAM,
        connectionId: "bot-a",
      },
      fake.client as never,
    );
    fake.rowLocks.length = 0;
    await expect(
      revokePrivateChannelIdentityBinding(
        {
          audienceIdentityId: "audience-1",
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123456",
          issuer: "delegate",
          connectionId: "bot-a",
        },
        fake.client as never,
      ),
    ).resolves.toMatchObject({ changed: true });
    expect(fake.rowLocks).toEqual(["link", "proof"]);

    const link = fake.links.get("TELEGRAM:123456");
    expect(link?.revokedAt).toBeNull();
    expect(
      [...fake.connectionProofs.values()].map((proof) => ({
        connectionId: proof.connectionId,
        revoked: proof.revokedAt !== null,
      })),
    ).toEqual([
      { connectionId: "bot-a", revoked: true },
      { connectionId: "bot-b", revoked: false },
    ]);
    expect(
      await listActivePrivateChannelIdentityBindings(
        "audience-1",
        fake.client as never,
      ),
    ).toEqual([
      expect.objectContaining({
        providerSubject: "123456",
        connectionId: "bot-b",
      }),
    ]);
    await expect(
      consumeIdentityBindingChallenge(
        {
          token: staleGrant.token,
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123456",
          connectionId: "bot-a",
        },
        fake.client as never,
      ),
    ).rejects.toThrow("revoked");

    const retryGrant = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.TELEGRAM,
        connectionId: "bot-a",
      },
      fake.client as never,
    );
    await expect(
      revokePrivateChannelIdentityBinding(
        {
          audienceIdentityId: "audience-1",
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123456",
          issuer: "delegate",
          connectionId: "bot-a",
        },
        fake.client as never,
      ),
    ).resolves.toMatchObject({ changed: false });
    await expect(
      consumeIdentityBindingChallenge(
        {
          token: retryGrant.token,
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123456",
          connectionId: "bot-a",
        },
        fake.client as never,
      ),
    ).rejects.toThrow("revoked");

    const rebindGrant = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.TELEGRAM,
        connectionId: "bot-a",
      },
      fake.client as never,
    );
    await expect(
      consumeIdentityBindingChallenge(
        {
          token: rebindGrant.token,
          provider: IdentityLinkProvider.TELEGRAM,
          providerSubject: "123456",
          connectionId: "bot-a",
        },
        fake.client as never,
      ),
    ).resolves.toMatchObject({ audienceIdentityId: "audience-1" });
    expect(
      [...fake.connectionProofs.values()].find(
        (proof) => proof.connectionId === "bot-a",
      )?.revokedAt,
    ).toBeNull();
  });

  it("revokes a pending Matrix replacement across homeservers when unlinking the current connection", async () => {
    const fake = createFakeBindingClient(
      [
        {
          id: "audience-1",
          status: "REGISTERED",
          mergedIntoId: null,
          lastSeenAt: new Date(),
        },
      ],
      [],
      { withConnectionProofs: true },
    );
    const original = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.MATRIX,
        issuer: "old.example",
        connectionId: "matrix-as",
        expectedProviderSubject: "@alice:old.example",
      },
      fake.client as never,
    );
    await consumeIdentityBindingChallenge(
      {
        token: original.token,
        provider: IdentityLinkProvider.MATRIX,
        providerSubject: "@alice:old.example",
        issuer: "old.example",
        connectionId: "matrix-as",
      },
      fake.client as never,
    );

    const replacement = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.MATRIX,
        issuer: "new.example",
        connectionId: "matrix-as",
        expectedProviderSubject: "@bob:new.example",
      },
      fake.client as never,
    );
    const otherConnection = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.MATRIX,
        issuer: "other.example",
        connectionId: "matrix-other",
        expectedProviderSubject: "@carol:other.example",
      },
      fake.client as never,
    );

    await expect(
      revokePrivateChannelIdentityBinding(
        {
          audienceIdentityId: "audience-1",
          provider: IdentityLinkProvider.MATRIX,
          providerSubject: "@alice:old.example",
          issuer: "old.example",
          connectionId: "matrix-as",
        },
        fake.client as never,
      ),
    ).resolves.toMatchObject({ changed: true });

    expect(
      fake.challenges.get(hashBindingToken(replacement.token))?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(
      fake.challenges.get(hashBindingToken(otherConnection.token))?.revokedAt,
    ).toBeNull();
    await expect(
      consumeIdentityBindingChallenge(
        {
          token: replacement.token,
          provider: IdentityLinkProvider.MATRIX,
          providerSubject: "@bob:new.example",
          issuer: "new.example",
          connectionId: "matrix-as",
        },
        fake.client as never,
      ),
    ).rejects.toThrow("revoked");
    expect(fake.advisoryLocks).toEqual([
      "matrix-audience-connection:audience-1:matrix-as",
      "matrix-audience-connection:audience-1:matrix-as",
      "matrix-audience-connection:audience-1:matrix-as",
    ]);
  });

  it("replaces only the previous Matrix subject on the same representative connection", async () => {
    const fake = createFakeBindingClient(
      [
        {
          id: "audience-1",
          status: "REGISTERED",
          mergedIntoId: null,
          lastSeenAt: new Date(),
        },
      ],
      [],
      { withConnectionProofs: true },
    );

    for (const connectionId of ["matrix-as", "matrix-other"]) {
      const grant = await createIdentityBindingChallenge(
        {
          audienceIdentityId: "audience-1",
          provider: IdentityLinkProvider.MATRIX,
          issuer: "old.example",
          connectionId,
          expectedProviderSubject: "@alice:old.example",
        },
        fake.client as never,
      );
      await consumeIdentityBindingChallenge(
        {
          token: grant.token,
          provider: IdentityLinkProvider.MATRIX,
          providerSubject: "@alice:old.example",
          issuer: "old.example",
          connectionId,
        },
        fake.client as never,
      );
    }

    const replacement = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.MATRIX,
        issuer: "new.example",
        connectionId: "matrix-as",
        expectedProviderSubject: "@bob:new.example",
      },
      fake.client as never,
    );
    fake.rowLocks.length = 0;
    await consumeIdentityBindingChallenge(
      {
        token: replacement.token,
        provider: IdentityLinkProvider.MATRIX,
        providerSubject: "@bob:new.example",
        issuer: "new.example",
        connectionId: "matrix-as",
      },
      fake.client as never,
    );
    expect(fake.rowLocks).toEqual(["link", "proof"]);

    const aliceLink = fake.links.get("MATRIX:@alice:old.example");
    const bobLink = fake.links.get("MATRIX:@bob:new.example");
    expect(aliceLink?.revokedAt).toBeNull();
    expect(bobLink?.revokedAt).toBeNull();
    expect(
      [...fake.connectionProofs.values()]
        .filter((proof) => proof.identityLinkId === aliceLink?.id)
        .map((proof) => ({
          connectionId: proof.connectionId,
          revoked: proof.revokedAt !== null,
        })),
    ).toEqual([
      { connectionId: "matrix-as", revoked: true },
      { connectionId: "matrix-other", revoked: false },
    ]);
    expect(
      [...fake.connectionProofs.values()].find(
        (proof) =>
          proof.identityLinkId === bobLink?.id
          && proof.connectionId === "matrix-as",
      )?.revokedAt,
    ).toBeNull();
    await expect(
      listActivePrivateChannelIdentityBindings(
        "audience-1",
        fake.client as never,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        providerSubject: "@alice:old.example",
        connectionId: "matrix-other",
      }),
      expect.objectContaining({
        providerSubject: "@bob:new.example",
        connectionId: "matrix-as",
      }),
    ]);
    expect(fake.advisoryLocks).toEqual([
      "matrix-audience-connection:audience-1:matrix-as",
      "matrix-audience-connection:audience-1:matrix-other",
      "matrix-audience-connection:audience-1:matrix-as",
    ]);
  });

  it("keeps the previous Matrix proof active when the replacement cannot be verified", async () => {
    const fake = createFakeBindingClient(
      [
        {
          id: "audience-1",
          status: "REGISTERED",
          mergedIntoId: null,
          lastSeenAt: new Date(),
        },
      ],
      [],
      { withConnectionProofs: true },
    );
    const original = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.MATRIX,
        issuer: "old.example",
        connectionId: "matrix-as",
        expectedProviderSubject: "@alice:old.example",
      },
      fake.client as never,
    );
    await consumeIdentityBindingChallenge(
      {
        token: original.token,
        provider: IdentityLinkProvider.MATRIX,
        providerSubject: "@alice:old.example",
        issuer: "old.example",
        connectionId: "matrix-as",
      },
      fake.client as never,
    );

    const replacement = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.MATRIX,
        issuer: "new.example",
        connectionId: "matrix-as",
        expectedProviderSubject: "@bob:new.example",
      },
      fake.client as never,
    );
    await expect(
      consumeIdentityBindingChallenge(
        {
          token: replacement.token,
          provider: IdentityLinkProvider.MATRIX,
          providerSubject: "@mallory:new.example",
          issuer: "new.example",
          connectionId: "matrix-as",
        },
        fake.client as never,
      ),
    ).rejects.toThrow("different provider account");

    const aliceLink = fake.links.get("MATRIX:@alice:old.example");
    expect(aliceLink?.revokedAt).toBeNull();
    expect(
      [...fake.connectionProofs.values()].find(
        (proof) =>
          proof.identityLinkId === aliceLink?.id
          && proof.connectionId === "matrix-as",
      )?.revokedAt,
    ).toBeNull();
  });

  it("revokes the parent link when the last verified proof is removed", async () => {
    const fake = createFakeBindingClient(
      [
        {
          id: "audience-1",
          status: "REGISTERED",
          mergedIntoId: null,
          lastSeenAt: new Date(),
        },
      ],
      [],
      { withConnectionProofs: true },
    );
    const grant = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.MATRIX,
        connectionId: "matrix-as",
        expectedProviderSubject: "@alice:example.org",
      },
      fake.client as never,
    );
    await consumeIdentityBindingChallenge(
      {
        token: grant.token,
        provider: IdentityLinkProvider.MATRIX,
        providerSubject: "@alice:example.org",
        connectionId: "matrix-as",
      },
      fake.client as never,
    );

    await expect(
      revokePrivateChannelIdentityBinding(
        {
          audienceIdentityId: "audience-1",
          provider: IdentityLinkProvider.MATRIX,
          providerSubject: "@alice:example.org",
          issuer: "delegate",
          connectionId: "matrix-as",
        },
        fake.client as never,
      ),
    ).resolves.toMatchObject({ changed: true });
    expect(fake.links.get("MATRIX:@alice:example.org")?.revokedAt).toBeInstanceOf(
      Date,
    );
    await expect(
      listActivePrivateChannelIdentityBindings(
        "audience-1",
        fake.client as never,
      ),
    ).resolves.toEqual([]);

    // Even if a legacy repair leaves the parent row active, the presence of a
    // revoked proof must prevent the listing code from falling back to it.
    fake.links.get("MATRIX:@alice:example.org")!.revokedAt = null;
    await expect(
      listActivePrivateChannelIdentityBindings(
        "audience-1",
        fake.client as never,
      ),
    ).resolves.toEqual([]);
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
        issuer: "Example.COM",
        connectionId: "matrix-as",
      },
      fake.client as never,
    );
    const result = await consumeIdentityBindingChallenge(
      {
        token: grant.token,
        provider: IdentityLinkProvider.MATRIX,
        providerSubject: "@Alice:Example.COM",
        issuer: "Example.COM",
        connectionId: "matrix-as",
      },
      fake.client as never,
    );
    expect(result).toMatchObject({
      providerSubject: "@Alice:Example.COM",
      issuer: "Example.COM",
    });

    const caseDistinct = await createIdentityBindingChallenge(
      {
        audienceIdentityId: "audience-1",
        provider: IdentityLinkProvider.MATRIX,
        issuer: "example.com",
        connectionId: "matrix-as",
      },
      fake.client as never,
    );
    await expect(
      consumeIdentityBindingChallenge(
        {
          token: caseDistinct.token,
          provider: IdentityLinkProvider.MATRIX,
          providerSubject: "@Alice:example.com",
          issuer: "example.com",
          connectionId: "matrix-as",
        },
        fake.client as never,
      ),
    ).resolves.toMatchObject({
      providerSubject: "@Alice:example.com",
      issuer: "example.com",
    });
    expect(fake.links.has("MATRIX:@Alice:Example.COM")).toBe(true);
    expect(fake.links.has("MATRIX:@Alice:example.com")).toBe(true);

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

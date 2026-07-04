import { describe, expect, it } from "vitest";

import {
  linkAudienceIdentityToAuth,
  normalizeAuthSubject,
  resolveOwnerForAuth,
} from "../src/auth-identities";

describe("auth identity mapping", () => {
  it("creates one owner per Logto subject", async () => {
    const client = new FakeAuthIdentityClient();

    const first = await resolveOwnerForAuth(
      {
        provider: "logto",
        subject: " logto-user-1 ",
        email: "Ada@Example.COM ",
        name: " Ada Lovelace ",
        emailVerified: true,
        metadata: { issuer: "https://auth.example.com" },
      },
      client,
    );
    const second = await resolveOwnerForAuth(
      {
        provider: "logto",
        subject: "logto-user-1",
        email: "ada@example.com",
      },
      client,
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.owner.id).toBe(second.owner.id);
    expect(client.owners).toHaveLength(1);
    expect(client.ownerIdentityLinks).toEqual([
      expect.objectContaining({
        ownerId: first.owner.id,
        provider: "LOGTO",
        providerSubject: "logto-user-1",
        email: "ada@example.com",
      }),
    ]);
  });

  it("links a registered login to an existing audience identity", async () => {
    const client = new FakeAuthIdentityClient();
    client.audienceIdentities.push({
      id: "audience-identity-1",
      status: "ANONYMOUS",
      lastSeenAt: new Date("2026-07-04T12:00:00.000Z"),
    });

    const identity = await linkAudienceIdentityToAuth(
      {
        audienceIdentityId: "audience-identity-1",
        profile: {
          provider: "logto",
          subject: "logto-user-1",
          email: "User@Example.com",
          emailVerified: true,
        },
        now: new Date("2026-07-04T13:00:00.000Z"),
      },
      client,
    );

    expect(identity).toMatchObject({
      id: "audience-identity-1",
      status: "REGISTERED",
      lastSeenAt: new Date("2026-07-04T13:00:00.000Z"),
    });
    expect(client.identityLinks).toEqual([
      expect.objectContaining({
        audienceIdentityId: "audience-identity-1",
        provider: "LOGTO",
        providerSubject: "logto-user-1",
        verifiedAt: new Date("2026-07-04T13:00:00.000Z"),
      }),
    ]);
  });

  it("rejects empty auth subjects", () => {
    expect(() => normalizeAuthSubject("logto", "  ")).toThrow("logto subject is required");
  });
});

type OwnerRow = {
  id: string;
  displayName: string;
  handle: string | null;
};

type OwnerIdentityLinkRow = {
  id: string;
  ownerId: string;
  provider: "LOGTO";
  providerSubject: string;
  email: string | null;
  phone: string | null;
  verifiedAt: Date | null;
  metadata: unknown;
};

type AudienceIdentityRow = {
  id: string;
  status: string;
  lastSeenAt: Date;
};

type IdentityLinkRow = {
  id: string;
  audienceIdentityId: string;
  provider: "LOGTO";
  providerSubject: string;
  verifiedAt: Date | null;
  metadata: unknown;
};

class FakeAuthIdentityClient {
  owners: OwnerRow[] = [];
  ownerIdentityLinks: OwnerIdentityLinkRow[] = [];
  audienceIdentities: AudienceIdentityRow[] = [];
  identityLinks: IdentityLinkRow[] = [];

  ownerIdentityLink = {
    findUnique: async (args: any) => {
      const key = args.where.provider_providerSubject;
      const link = this.ownerIdentityLinks.find(
        (item) => item.provider === key.provider && item.providerSubject === key.providerSubject,
      );
      if (!link) {
        return null;
      }
      const owner = this.owners.find((item) => item.id === link.ownerId);
      if (!owner) {
        return null;
      }
      return {
        ...link,
        owner,
      };
    },
  };

  owner = {
    create: async (args: any) => {
      const owner: OwnerRow = {
        id: `owner-${this.owners.length + 1}`,
        displayName: args.data.displayName,
        handle: null,
      };
      const identityLink: OwnerIdentityLinkRow = {
        id: `owner-identity-link-${this.ownerIdentityLinks.length + 1}`,
        ownerId: owner.id,
        provider: args.data.identityLinks.create.provider,
        providerSubject: args.data.identityLinks.create.providerSubject,
        email: args.data.identityLinks.create.email,
        phone: args.data.identityLinks.create.phone,
        verifiedAt: args.data.identityLinks.create.verifiedAt,
        metadata: args.data.identityLinks.create.metadata,
      };
      this.owners.push(owner);
      this.ownerIdentityLinks.push(identityLink);
      return {
        ...owner,
        identityLinks: [identityLink],
      };
    },
  };

  audienceIdentity = {
    update: async (args: any) => {
      const identity = this.audienceIdentities.find((item) => item.id === args.where.id);
      if (!identity) {
        throw new Error("audience identity not found");
      }
      Object.assign(identity, args.data);
      return identity;
    },
  };

  identityLink = {
    upsert: async (args: any) => {
      const key = args.where.provider_providerSubject;
      const existing = this.identityLinks.find(
        (link) => link.provider === key.provider && link.providerSubject === key.providerSubject,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const link: IdentityLinkRow = {
        id: `identity-link-${this.identityLinks.length + 1}`,
        audienceIdentityId: args.create.audienceIdentityId,
        provider: args.create.provider,
        providerSubject: args.create.providerSubject,
        verifiedAt: args.create.verifiedAt,
        metadata: args.create.metadata,
      };
      this.identityLinks.push(link);
      return link;
    },
  };
}

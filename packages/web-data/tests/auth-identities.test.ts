import { describe, expect, it } from "vitest";

import {
  CreatorAdmissionRequiredError,
  CreatorRegistrationRequiredError,
  linkAudienceIdentityToAuth,
  normalizeAuthSubject,
  readCreatorAdmissionMode,
  readCreatorAdmissionPrincipals,
  resolveOwnerForAuth,
  resolveOwnerForRegistration,
} from "../src/auth-identities";

const LOGTO_ISSUER = "https://auth.example.com/oidc";

describe("auth identity mapping", () => {
  it("creates one owner per Logto subject", async () => {
    const client = new FakeAuthIdentityClient();

    const first = await resolveOwnerForAuth(
      {
        provider: "logto",
        issuer: LOGTO_ISSUER,
        subject: " logto-user-1 ",
        email: "Ada@Example.COM ",
        name: " Ada Lovelace ",
        emailVerified: true,
        metadata: { source: "unit-test" },
      },
      client,
      creatorAdmissionEnv("logto-user-1"),
    );
    const second = await resolveOwnerForAuth(
      {
        provider: "logto",
        issuer: LOGTO_ISSUER,
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
        issuer: LOGTO_ISSUER,
        providerSubject: "logto-user-1",
        email: "ada@example.com",
        emailVerifiedAt: null,
        phoneVerifiedAt: null,
        verifiedAt: null,
      }),
    ]);
  });

  it("writes independent email and phone verification timestamps when creating an owner", async () => {
    const client = new FakeAuthIdentityClient();

    const result = await resolveOwnerForAuth(
      {
        provider: "logto",
        issuer: LOGTO_ISSUER,
        subject: "logto-verified-email",
        email: "verified@example.com",
        phone: "+8613800000000",
        emailVerified: true,
        phoneVerified: false,
      },
      client,
      creatorAdmissionEnv("logto-verified-email"),
    );

    expect(result.created).toBe(true);
    expect(result.identityLink.emailVerifiedAt).toEqual(expect.any(Date));
    expect(result.identityLink.phoneVerifiedAt).toBeNull();
    expect(result.identityLink.verifiedAt).toEqual(
      result.identityLink.emailVerifiedAt,
    );
  });

  it("refreshes identity claims without overwriting the owner's display name", async () => {
    const client = new FakeAuthIdentityClient();
    const first = await resolveOwnerForAuth(
      {
        provider: "logto",
        issuer: LOGTO_ISSUER,
        subject: "logto-refresh",
        email: "old@example.com",
        name: "Owner-chosen source name",
        emailVerified: true,
        metadata: { revision: 1 },
      },
      client,
      creatorAdmissionEnv("logto-refresh"),
    );
    expect(first.identityLink.emailVerifiedAt).toEqual(expect.any(Date));

    const refreshed = await resolveOwnerForAuth(
      {
        provider: "logto",
        issuer: LOGTO_ISSUER,
        subject: "logto-refresh",
        email: "new@example.com",
        phone: "+8613900000000",
        name: "Identity provider renamed this user",
        emailVerified: false,
        phoneVerified: true,
        metadata: { revision: 2 },
      },
      client,
    );

    expect(refreshed.created).toBe(false);
    expect(refreshed.owner.displayName).toBe("Owner-chosen source name");
    expect(client.owners[0]?.displayName).toBe("Owner-chosen source name");
    expect(refreshed.identityLink).toMatchObject({
      email: "new@example.com",
      phone: "+8613900000000",
      emailVerifiedAt: null,
      phoneVerifiedAt: expect.any(Date),
      metadata: { revision: 2, issuer: LOGTO_ISSUER },
    });
    expect(refreshed.identityLink.verifiedAt).toEqual(
      refreshed.identityLink.phoneVerifiedAt,
    );
  });

  it("clears stale verification timestamps when Logto reports false", async () => {
    const client = new FakeAuthIdentityClient();
    await resolveOwnerForAuth(
      {
        provider: "logto",
        issuer: LOGTO_ISSUER,
        subject: "logto-revoked-verification",
        email: "owner@example.com",
        phone: "+8613700000000",
        emailVerified: true,
        phoneVerified: true,
      },
      client,
      creatorAdmissionEnv("logto-revoked-verification"),
    );

    const refreshed = await resolveOwnerForAuth(
      {
        provider: "logto",
        issuer: LOGTO_ISSUER,
        subject: "logto-revoked-verification",
        email: "owner@example.com",
        phone: "+8613700000000",
        emailVerified: false,
        phoneVerified: false,
      },
      client,
    );

    expect(refreshed.identityLink).toMatchObject({
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      verifiedAt: null,
    });
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
          issuer: LOGTO_ISSUER,
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
        issuer: LOGTO_ISSUER,
        providerSubject: "logto-user-1",
        verifiedAt: new Date("2026-07-04T13:00:00.000Z"),
      }),
    ]);
  });

  it("rejects empty auth subjects", () => {
    expect(() => normalizeAuthSubject("logto", "  ")).toThrow("logto subject is required");
  });

  it("denies new creator identities unless their exact subject is admitted", async () => {
    const client = new FakeAuthIdentityClient();

    await expect(
      resolveOwnerForAuth(
        {
          provider: "logto",
          issuer: LOGTO_ISSUER,
          subject: "logto-uninvited",
          email: "uninvited@example.com",
        },
        client,
        {
          NODE_ENV: "production",
          DELEGATE_CREATOR_ADMISSION_PRINCIPALS:
            `${LOGTO_ISSUER}|logto-invited,${LOGTO_ISSUER}|logto-other-invited`,
        },
      ),
    ).rejects.toBeInstanceOf(CreatorAdmissionRequiredError);
    expect(client.owners).toHaveLength(0);
    expect(client.ownerIdentityLinks).toHaveLength(0);
  });

  it("allows an existing creator identity after its admission entry is removed", async () => {
    const client = new FakeAuthIdentityClient();
    const admitted = await resolveOwnerForAuth(
      {
        provider: "logto",
        issuer: LOGTO_ISSUER,
        subject: "logto-existing-owner",
        email: "owner@example.com",
      },
      client,
      creatorAdmissionEnv("logto-existing-owner"),
    );

    const existing = await resolveOwnerForAuth(
      {
        provider: "logto",
        issuer: LOGTO_ISSUER,
        subject: "logto-existing-owner",
        email: "owner+refreshed@example.com",
      },
      client,
      { NODE_ENV: "production" },
    );

    expect(existing.created).toBe(false);
    expect(existing.owner.id).toBe(admitted.owner.id);
    expect(existing.identityLink.email).toBe("owner+refreshed@example.com");
    expect(client.owners).toHaveLength(1);
  });

  it("requires an explicit registration flow in self-service mode", async () => {
    const client = new FakeAuthIdentityClient();
    const env = {
      NODE_ENV: "production",
      DELEGATE_CREATOR_ADMISSION_MODE: "self_service",
    };

    await expect(
      resolveOwnerForAuth(
        {
          provider: "logto",
          issuer: LOGTO_ISSUER,
          subject: "self-service-creator",
          name: "Self Service Creator",
        },
        client,
        env,
      ),
    ).rejects.toBeInstanceOf(CreatorRegistrationRequiredError);

    const registered = await resolveOwnerForRegistration(
      {
        provider: "logto",
        issuer: LOGTO_ISSUER,
        subject: "self-service-creator",
        name: "Self Service Creator",
      },
      client,
      env,
    );

    expect(registered).toMatchObject({
      created: true,
      owner: { displayName: "Self Service Creator" },
      identityLink: {
        issuer: LOGTO_ISSUER,
        providerSubject: "self-service-creator",
      },
    });
    expect(client.owners).toHaveLength(1);
  });

  it("keeps admission mode explicit and closed by default", () => {
    expect(readCreatorAdmissionMode({})).toBe("invite_only");
    expect(
      readCreatorAdmissionMode({
        DELEGATE_CREATOR_ADMISSION_MODE: "self_service",
      }),
    ).toBe("self_service");
    expect(() =>
      readCreatorAdmissionMode({
        DELEGATE_CREATOR_ADMISSION_MODE: "open",
      }),
    ).toThrow(
      "DELEGATE_CREATOR_ADMISSION_MODE must be invite_only or self_service.",
    );
  });

  it("does not resolve the same subject from a different issuer as an existing creator", async () => {
    const client = new FakeAuthIdentityClient();
    const first = await resolveOwnerForAuth(
      {
        provider: "logto",
        issuer: LOGTO_ISSUER,
        subject: "shared-subject",
      },
      client,
      creatorAdmissionEnv("shared-subject"),
    );

    await expect(
      resolveOwnerForAuth(
        {
          provider: "logto",
          issuer: "https://other-auth.example.com/oidc",
          subject: "shared-subject",
        },
        client,
        { NODE_ENV: "production" },
      ),
    ).rejects.toBeInstanceOf(CreatorAdmissionRequiredError);
    expect(client.owners).toHaveLength(1);
    expect(client.ownerIdentityLinks[0]).toMatchObject({
      ownerId: first.owner.id,
      issuer: LOGTO_ISSUER,
      providerSubject: "shared-subject",
    });
  });

  it("returns the exact concurrent winner after an owner-create uniqueness race", async () => {
    const client = new FakeAuthIdentityClient();
    client.simulateConcurrentOwnerCreate = true;

    const resolved = await resolveOwnerForAuth(
      {
        provider: "logto",
        issuer: LOGTO_ISSUER,
        subject: "concurrent-subject",
        email: "winner@example.com",
      },
      client,
      creatorAdmissionEnv("concurrent-subject"),
    );

    expect(resolved.created).toBe(false);
    expect(resolved.identityLink).toMatchObject({
      issuer: LOGTO_ISSUER,
      providerSubject: "concurrent-subject",
    });
    expect(client.owners).toHaveLength(1);
    expect(client.ownerIdentityLinks).toHaveLength(1);
  });

  it("fails closed for a null-issuer legacy creator even in shadow mode", async () => {
    const client = new FakeAuthIdentityClient();
    client.owners.push({
      id: "owner-legacy",
      displayName: "Legacy owner",
      handle: null,
    });
    client.ownerIdentityLinks.push(buildOwnerIdentityLink({
      id: "owner-link-legacy",
      ownerId: "owner-legacy",
      issuer: null,
      providerSubject: "legacy-subject",
    }));

    await expect(
      resolveOwnerForAuth(
        {
          provider: "logto",
          issuer: LOGTO_ISSUER,
          subject: "legacy-subject",
        },
        client,
        creatorAdmissionEnv("legacy-subject"),
      ),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(client.ownerIdentityLinks[0]?.issuer).toBeNull();
    expect(client.owners).toHaveLength(1);
  });

  it("shadow-reads a null-issuer creator only when stored issuer evidence matches", async () => {
    const client = new FakeAuthIdentityClient();
    client.owners.push({
      id: "owner-evidenced",
      displayName: "Evidenced legacy owner",
      handle: null,
    });
    client.ownerIdentityLinks.push({
      ...buildOwnerIdentityLink({
        id: "owner-link-evidenced",
        ownerId: "owner-evidenced",
        issuer: null,
        providerSubject: "evidenced-subject",
      }),
      metadata: { issuer: LOGTO_ISSUER, source: "verified-id-token" },
    });

    const resolved = await resolveOwnerForAuth(
      {
        provider: "logto",
        issuer: LOGTO_ISSUER,
        subject: "evidenced-subject",
        email: "evidenced@example.com",
      },
      client,
      { DELEGATE_AUTH_IDENTITY_ISSUER_MODE: "shadow" },
    );

    expect(resolved).toMatchObject({
      created: false,
      owner: { id: "owner-evidenced" },
      identityLink: {
        issuer: null,
        providerSubject: "evidenced-subject",
        metadata: { issuer: LOGTO_ISSUER },
      },
    });
  });

  it("does not reinterpret the legacy subject uniqueness conflict as an exact issuer match", async () => {
    const client = new FakeAuthIdentityClient();
    await resolveOwnerForAuth(
      {
        provider: "logto",
        issuer: LOGTO_ISSUER,
        subject: "cross-issuer-subject",
      },
      client,
      creatorAdmissionEnv("cross-issuer-subject"),
    );
    const otherIssuer = "https://other-auth.example.com/oidc";

    await expect(
      resolveOwnerForAuth(
        {
          provider: "logto",
          issuer: otherIssuer,
          subject: "cross-issuer-subject",
        },
        client,
        {
          DELEGATE_CREATOR_ADMISSION_PRINCIPALS:
            `${otherIssuer}|cross-issuer-subject`,
        },
      ),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(client.owners).toHaveLength(1);
  });

  it("parses comma and newline separated exact admission principals", () => {
    expect(
      [...readCreatorAdmissionPrincipals({
        DELEGATE_CREATOR_ADMISSION_PRINCIPALS:
          ` ${LOGTO_ISSUER}|logto-one,${LOGTO_ISSUER}|logto-two\n${LOGTO_ISSUER}|logto-one `,
      })],
    ).toEqual([
      `${LOGTO_ISSUER}|logto-one`,
      `${LOGTO_ISSUER}|logto-two`,
    ]);
    expect(() =>
      readCreatorAdmissionPrincipals({
        DELEGATE_CREATOR_ADMISSION_PRINCIPALS: `${LOGTO_ISSUER}|*`,
      }),
    ).toThrow(
      "DELEGATE_CREATOR_ADMISSION_PRINCIPALS does not support wildcards.",
    );
    expect(() =>
      readCreatorAdmissionPrincipals({
        DELEGATE_CREATOR_ADMISSION_SUBJECTS: "legacy-subject",
      }),
    ).toThrow("DELEGATE_CREATOR_ADMISSION_SUBJECTS is unsafe across issuers");
  });
});

function creatorAdmissionEnv(subject: string) {
  return {
    NODE_ENV: "test",
    DELEGATE_CREATOR_ADMISSION_PRINCIPALS:
      `${LOGTO_ISSUER}|${subject}`,
  };
}

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
  issuer: string | null;
  email: string | null;
  phone: string | null;
  verifiedAt: Date | null;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
  metadata: unknown;
};

type AudienceIdentityRow = {
  id: string;
  status: string;
  mergedIntoId?: string | null;
  lastSeenAt: Date;
};

type IdentityLinkRow = {
  id: string;
  audienceIdentityId: string;
  provider: "LOGTO";
  providerSubject: string;
  issuer: string;
  verifiedAt: Date | null;
  metadata: unknown;
};

class FakeAuthIdentityClient {
  simulateConcurrentOwnerCreate = false;
  owners: OwnerRow[] = [];
  ownerIdentityLinks: OwnerIdentityLinkRow[] = [];
  audienceIdentities: AudienceIdentityRow[] = [];
  identityLinks: IdentityLinkRow[] = [];

  ownerIdentityLink = {
    findFirst: async (args: any) => {
      const link = this.ownerIdentityLinks.find(
        (item) =>
          item.provider === args.where.provider
          && item.issuer === args.where.issuer
          && item.providerSubject === args.where.providerSubject
          && (
            !args.where.metadata
            || (
              typeof item.metadata === "object"
              && item.metadata !== null
              && !Array.isArray(item.metadata)
              && (item.metadata as Record<string, unknown>).issuer
                === args.where.metadata.equals
            )
          ),
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
    update: async (args: any) => {
      const link = this.ownerIdentityLinks.find(
        (item) => item.id === args.where.id,
      );
      if (!link) {
        throw new Error("owner identity link not found");
      }
      Object.assign(link, args.data);
      return link;
    },
  };

  owner = {
    create: async (args: any) => {
      const legacyConflict = this.ownerIdentityLinks.some(
        (link) =>
          link.provider === args.data.identityLinks.create.provider
          && link.providerSubject
            === args.data.identityLinks.create.providerSubject,
      );
      if (legacyConflict) {
        throw Object.assign(new Error("Unique constraint failed on owner identity link"), {
          code: "P2002",
        });
      }
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
        issuer: args.data.identityLinks.create.issuer,
        email: args.data.identityLinks.create.email,
        phone: args.data.identityLinks.create.phone,
        verifiedAt: args.data.identityLinks.create.verifiedAt,
        emailVerifiedAt: args.data.identityLinks.create.emailVerifiedAt,
        phoneVerifiedAt: args.data.identityLinks.create.phoneVerifiedAt,
        metadata: args.data.identityLinks.create.metadata,
      };
      this.owners.push(owner);
      this.ownerIdentityLinks.push(identityLink);
      if (this.simulateConcurrentOwnerCreate) {
        this.simulateConcurrentOwnerCreate = false;
        throw Object.assign(new Error("Unique constraint failed on owner identity link"), {
          code: "P2002",
        });
      }
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
    findUnique: async (args: any) =>
      this.audienceIdentities.find((identity) => identity.id === args.where.id) ?? null,
  };

  identityLink = {
    findFirst: async (args: any) => {
      const link = this.identityLinks.find(
        (item) =>
          item.provider === args.where.provider
          && item.issuer === args.where.issuer
          && item.providerSubject === args.where.providerSubject
          && (
            typeof item.metadata === "object"
            && item.metadata !== null
            && !Array.isArray(item.metadata)
            && (item.metadata as Record<string, unknown>).issuer
              === args.where.metadata.equals
          ),
      );
      return link
        ? {
            id: link.id,
            audienceIdentityId: link.audienceIdentityId,
            issuer: link.issuer,
          }
        : null;
    },
    findUnique: async (args: any) => {
      const key = args.where.provider_issuer_providerSubject;
      const link = this.identityLinks.find(
        (item) =>
          item.provider === key.provider
          && item.issuer === key.issuer
          && item.providerSubject === key.providerSubject,
      );
      return link ? { audienceIdentityId: link.audienceIdentityId } : null;
    },
    create: async (args: any) => {
      const existing = this.identityLinks.find(
        (link) =>
          link.provider === args.data.provider &&
          link.issuer === args.data.issuer &&
          link.providerSubject === args.data.providerSubject,
      );
      if (existing) {
        throw Object.assign(new Error("Unique constraint failed on identity link"), {
          code: "P2002",
        });
      }
      const link: IdentityLinkRow = {
        id: `identity-link-${this.identityLinks.length + 1}`,
        audienceIdentityId: args.data.audienceIdentityId,
        provider: args.data.provider,
        providerSubject: args.data.providerSubject,
        issuer: args.data.issuer,
        verifiedAt: args.data.verifiedAt ?? null,
        metadata: args.data.metadata ?? null,
      };
      this.identityLinks.push(link);
      return link;
    },
    upsert: async (args: any) => {
      const key =
        args.where.provider_issuer_providerSubject
        ?? args.where.provider_providerSubject;
      const existing = this.identityLinks.find(
        (link) =>
          link.provider === key.provider
          && (key.issuer === undefined || link.issuer === key.issuer)
          && link.providerSubject === key.providerSubject,
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
        issuer: args.create.issuer,
        verifiedAt: args.create.verifiedAt,
        metadata: args.create.metadata,
      };
      this.identityLinks.push(link);
      return link;
    },
    updateMany: async (args: any) => {
      let count = 0;
      for (const link of this.identityLinks) {
        if (
          (args.where.audienceIdentityId === undefined ||
            link.audienceIdentityId === args.where.audienceIdentityId) &&
          (args.where.provider === undefined || link.provider === args.where.provider) &&
          (args.where.providerSubject === undefined ||
            link.providerSubject === args.where.providerSubject)
        ) {
          Object.assign(link, args.data);
          count += 1;
        }
      }
      return { count };
    },
  };
}

function buildOwnerIdentityLink(
  input: Pick<
    OwnerIdentityLinkRow,
    "id" | "ownerId" | "issuer" | "providerSubject"
  >,
): OwnerIdentityLinkRow {
  return {
    ...input,
    provider: "LOGTO",
    email: null,
    phone: null,
    verifiedAt: null,
    emailVerifiedAt: null,
    phoneVerifiedAt: null,
    metadata: null,
  };
}

import { OwnerIdentityLinkProvider } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { bootstrapLocalOwnerAuth } from "../../../scripts/local-auth-bootstrap";

function createBootstrapClient(options?: {
  representative?: { id: string; ownerId: string } | null;
  existingOwnerId?: string | null;
  legacyOwnerId?: string | null;
  existingIssuer?: string | null;
  legacyMetadata?: unknown;
}) {
  const representativeFindUnique = vi.fn().mockResolvedValue(
    options && "representative" in options
      ? options.representative
      : {
          id: "rep_lin_founder",
          ownerId: "owner_lin_demo",
        },
  );
  const ownerIdentityLinkFindFirst = vi.fn().mockResolvedValue(
    options?.existingOwnerId
      ? {
          id: "owner-link-exact",
          ownerId: options.existingOwnerId,
          issuer:
            options.existingIssuer
            ?? "https://local-auth.delegate.invalid/oidc",
        }
      : null,
  );
  const ownerIdentityLinkFindUnique = vi.fn().mockResolvedValue(
    options?.legacyOwnerId
      ? {
          id: "owner-link-legacy",
          ownerId: options.legacyOwnerId,
          issuer: options.existingIssuer ?? null,
          metadata:
            options.legacyMetadata
            ?? {
              mode: "development",
              actor: "owner",
              fixture: "local-compose-bootstrap",
            },
        }
      : null,
  );
  const ownerIdentityLinkCreate = vi.fn().mockResolvedValue({});
  const ownerIdentityLinkUpdate = vi.fn().mockResolvedValue({});

  return {
    client: {
      representative: {
        findUnique: representativeFindUnique,
      },
      ownerIdentityLink: {
        findFirst: ownerIdentityLinkFindFirst,
        findUnique: ownerIdentityLinkFindUnique,
        create: ownerIdentityLinkCreate,
        update: ownerIdentityLinkUpdate,
      },
    } as unknown as Parameters<typeof bootstrapLocalOwnerAuth>[0],
    ownerIdentityLinkCreate,
    ownerIdentityLinkFindFirst,
    ownerIdentityLinkFindUnique,
    ownerIdentityLinkUpdate,
    representativeFindUnique,
  };
}

const enabledDevelopmentEnv = {
  NODE_ENV: "development",
  DELEGATE_LOCAL_AUTH_BOOTSTRAP: "true",
  DELEGATE_AUTH_DEV_LOGIN: "true",
};

describe("local owner auth bootstrap", () => {
  it.each(["production", "test", undefined])(
    "fails closed outside an explicit development environment (%s)",
    async (nodeEnv) => {
      const fixture = createBootstrapClient();

      await expect(
        bootstrapLocalOwnerAuth(fixture.client, {
          ...enabledDevelopmentEnv,
          NODE_ENV: nodeEnv,
        }),
      ).rejects.toThrow(
        "Local auth bootstrap is only allowed when NODE_ENV=development.",
      );
      expect(fixture.representativeFindUnique).not.toHaveBeenCalled();
      expect(fixture.ownerIdentityLinkCreate).not.toHaveBeenCalled();
      expect(fixture.ownerIdentityLinkUpdate).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "bootstrap opt-in is disabled",
      env: {
        ...enabledDevelopmentEnv,
        DELEGATE_LOCAL_AUTH_BOOTSTRAP: "false",
      },
      message:
        "DELEGATE_LOCAL_AUTH_BOOTSTRAP must be enabled for local auth bootstrap.",
    },
    {
      name: "development login is disabled",
      env: {
        ...enabledDevelopmentEnv,
        DELEGATE_AUTH_DEV_LOGIN: "false",
      },
      message:
        "DELEGATE_AUTH_DEV_LOGIN must be enabled for local auth bootstrap.",
    },
  ])("does not touch the database when $name", async ({ env, message }) => {
    const fixture = createBootstrapClient();

    await expect(
      bootstrapLocalOwnerAuth(fixture.client, env),
    ).rejects.toThrow(message);
    expect(fixture.representativeFindUnique).not.toHaveBeenCalled();
    expect(fixture.ownerIdentityLinkCreate).not.toHaveBeenCalled();
    expect(fixture.ownerIdentityLinkUpdate).not.toHaveBeenCalled();
  });

  it("rejects a missing or unexpected demo representative fixture", async () => {
    const fixture = createBootstrapClient({
      representative: {
        id: "rep_unexpected",
        ownerId: "owner_lin_demo",
      },
    });

    await expect(
      bootstrapLocalOwnerAuth(fixture.client, enabledDevelopmentEnv),
    ).rejects.toThrow(
      'Local auth bootstrap requires the "lin-founder-rep" demo fixture.',
    );
    expect(fixture.ownerIdentityLinkFindUnique).not.toHaveBeenCalled();
    expect(fixture.ownerIdentityLinkCreate).not.toHaveBeenCalled();
    expect(fixture.ownerIdentityLinkUpdate).not.toHaveBeenCalled();
  });

  it("rejects an auth subject that is already bound to another owner", async () => {
    const fixture = createBootstrapClient({
      existingOwnerId: "owner_someone_else",
    });

    await expect(
      bootstrapLocalOwnerAuth(fixture.client, enabledDevelopmentEnv),
    ).rejects.toThrow(
      'Development auth subject "delegate-dev-owner" already belongs to another owner.',
    );
    expect(fixture.ownerIdentityLinkCreate).not.toHaveBeenCalled();
    expect(fixture.ownerIdentityLinkUpdate).not.toHaveBeenCalled();
  });

  it("creates the local-only issuer-scoped identity link for the demo owner", async () => {
    const fixture = createBootstrapClient();

    await expect(
      bootstrapLocalOwnerAuth(fixture.client, {
        ...enabledDevelopmentEnv,
        DELEGATE_AUTH_DEV_OWNER_EMAIL: " local@example.test ",
        DELEGATE_AUTH_DEV_OWNER_SUBJECT: " local-owner ",
      }),
    ).resolves.toEqual({
      ownerId: "owner_lin_demo",
      issuer: "https://local-auth.delegate.invalid/oidc",
      providerSubject: "local-owner",
    });
    expect(fixture.ownerIdentityLinkCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: "owner_lin_demo",
        provider: OwnerIdentityLinkProvider.LOGTO,
        providerSubject: "local-owner",
        issuer: "https://local-auth.delegate.invalid/oidc",
        email: "local@example.test",
        verifiedAt: expect.any(Date),
        metadata: {
          issuer: "https://local-auth.delegate.invalid/oidc",
          mode: "development",
          actor: "owner",
          fixture: "local-compose-bootstrap",
        },
      }),
    });
  });

  it("adopts the confirmed demo owner's legacy null-issuer link in place", async () => {
    const fixture = createBootstrapClient({
      legacyOwnerId: "owner_lin_demo",
      existingIssuer: null,
    });

    await expect(
      bootstrapLocalOwnerAuth(fixture.client, enabledDevelopmentEnv),
    ).resolves.toMatchObject({
      ownerId: "owner_lin_demo",
      issuer: "https://local-auth.delegate.invalid/oidc",
    });
    expect(fixture.ownerIdentityLinkCreate).not.toHaveBeenCalled();
    expect(fixture.ownerIdentityLinkUpdate).toHaveBeenCalledWith({
      where: { id: "owner-link-legacy" },
      data: expect.objectContaining({
        issuer: "https://local-auth.delegate.invalid/oidc",
        metadata: expect.objectContaining({
          issuer: "https://local-auth.delegate.invalid/oidc",
        }),
      }),
    });
  });

  it("rejects a subject-only legacy fixture without trusted local metadata", async () => {
    const fixture = createBootstrapClient({
      legacyOwnerId: "owner_lin_demo",
      existingIssuer: null,
      legacyMetadata: { fixture: "unknown" },
    });

    await expect(
      bootstrapLocalOwnerAuth(fixture.client, enabledDevelopmentEnv),
    ).rejects.toThrow(
      'Development auth subject "delegate-dev-owner" lacks approved local fixture issuer evidence.',
    );
    expect(fixture.ownerIdentityLinkCreate).not.toHaveBeenCalled();
    expect(fixture.ownerIdentityLinkUpdate).not.toHaveBeenCalled();
  });
});

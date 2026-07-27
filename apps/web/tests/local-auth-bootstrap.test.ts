import { OwnerIdentityLinkProvider } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { bootstrapLocalOwnerAuth } from "../../../scripts/local-auth-bootstrap";

function createBootstrapClient(options?: {
  representative?: { id: string; ownerId: string } | null;
  existingOwnerId?: string | null;
}) {
  const representativeFindUnique = vi.fn().mockResolvedValue(
    options && "representative" in options
      ? options.representative
      : {
          id: "rep_lin_founder",
          ownerId: "owner_lin_demo",
        },
  );
  const ownerIdentityLinkFindUnique = vi.fn().mockResolvedValue(
    options?.existingOwnerId
      ? {
          ownerId: options.existingOwnerId,
        }
      : null,
  );
  const ownerIdentityLinkUpsert = vi.fn().mockResolvedValue({});

  return {
    client: {
      representative: {
        findUnique: representativeFindUnique,
      },
      ownerIdentityLink: {
        findUnique: ownerIdentityLinkFindUnique,
        upsert: ownerIdentityLinkUpsert,
      },
    } as unknown as Parameters<typeof bootstrapLocalOwnerAuth>[0],
    ownerIdentityLinkFindUnique,
    ownerIdentityLinkUpsert,
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
      expect(fixture.ownerIdentityLinkUpsert).not.toHaveBeenCalled();
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
    expect(fixture.ownerIdentityLinkUpsert).not.toHaveBeenCalled();
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
    expect(fixture.ownerIdentityLinkUpsert).not.toHaveBeenCalled();
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
    expect(fixture.ownerIdentityLinkUpsert).not.toHaveBeenCalled();
  });

  it("upserts the local-only identity link for the demo owner", async () => {
    const fixture = createBootstrapClient();

    await expect(
      bootstrapLocalOwnerAuth(fixture.client, {
        ...enabledDevelopmentEnv,
        DELEGATE_AUTH_DEV_OWNER_EMAIL: " local@example.test ",
        DELEGATE_AUTH_DEV_OWNER_SUBJECT: " local-owner ",
      }),
    ).resolves.toEqual({
      ownerId: "owner_lin_demo",
      providerSubject: "local-owner",
    });
    expect(fixture.ownerIdentityLinkUpsert).toHaveBeenCalledWith({
      where: {
        provider_providerSubject: {
          provider: OwnerIdentityLinkProvider.LOGTO,
          providerSubject: "local-owner",
        },
      },
      create: expect.objectContaining({
        ownerId: "owner_lin_demo",
        provider: OwnerIdentityLinkProvider.LOGTO,
        providerSubject: "local-owner",
        email: "local@example.test",
        verifiedAt: expect.any(Date),
        metadata: {
          mode: "development",
          actor: "owner",
          fixture: "local-compose-bootstrap",
        },
      }),
      update: expect.objectContaining({
        email: "local@example.test",
        verifiedAt: expect.any(Date),
        metadata: {
          mode: "development",
          actor: "owner",
          fixture: "local-compose-bootstrap",
        },
      }),
    });
  });
});
